// Исполнение моделей Neural Amp Modeler (.nam): нейросетевые «снимки» усилителей и педалей.
// Собственная реализация по формату и поведению эталонной библиотеки NeuralAmpModelerCore
// (Steven Atkinson, MIT): архитектуры WaveNet (A1) и LSTM. Каналы сети дополняются нулями до
// ширины SIMD-регистра, чтобы все матричные операции шли целыми векторами.
using System.Numerics;
using System.Runtime.CompilerServices;
using System.Text.Json;

namespace Lad;

internal sealed class NamException(string message) : Exception(message);

internal sealed class NamInfo
{
    public string Path = "", Name = "", Architecture = "", Version = "";
    /// <summary>Разновидность для показа: «WaveNet A1», «A2», «LSTM»…</summary>
    public string Flavor = "";
    /// <summary>Кто считает модель: библиотека NAM или встроенный расчёт.</summary>
    public string Engine = "";
    /// <summary>В файле несколько размеров модели (A2: Full и Lite).</summary>
    public bool Slimmable;
    public string? Gear, Tone, Author;
    public double SampleRate = 48000;
    public double? Loudness;
    public int Parameters;
}

internal enum NamActivation { Tanh, HardTanh, Relu, LeakyRelu, Sigmoid }

internal static class NamMath
{
    public static readonly int V = Vector<float>.Count;
    public static int Pad(int n) => (n + V - 1) / V * V;

    /// <summary>Быстрый tanh из эталонной реализации (её плагин использует именно его).</summary>
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static Vector<float> FastTanh(Vector<float> x)
    {
        Vector<float> ax = Vector.Abs(x), x2 = x * x;
        Vector<float> num = x * (new Vector<float>(2.45550750702956f) + 2.45550750702956f * ax
            + (new Vector<float>(0.893229853513558f) + 0.821226666969744f * ax) * x2);
        Vector<float> den = new Vector<float>(2.44506634652299f)
            + (new Vector<float>(2.44506634652299f) + x2) * Vector.Abs(x + 0.814642734961073f * x * ax);
        return num / den;
    }

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static Vector<float> FastSigmoid(Vector<float> x) => (FastTanh(x * 0.5f) + Vector<float>.One) * 0.5f;

    public static float FastTanh(float x)
    {
        float ax = MathF.Abs(x), x2 = x * x;
        return x * (2.45550750702956f + 2.45550750702956f * ax + (0.893229853513558f + 0.821226666969744f * ax) * x2)
            / (2.44506634652299f + (2.44506634652299f + x2) * MathF.Abs(x + 0.814642734961073f * x * ax));
    }

    public static float FastSigmoid(float x) => 0.5f * (FastTanh(0.5f * x) + 1f);

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static Vector<float> Activate(Vector<float> x, NamActivation a)
    {
        switch (a)
        {
            case NamActivation.Tanh: return FastTanh(x);
            case NamActivation.HardTanh: return Vector.Min(Vector.Max(x, new Vector<float>(-1f)), Vector<float>.One);
            case NamActivation.Relu: return Vector.Max(x, Vector<float>.Zero);
            case NamActivation.LeakyRelu: return Vector.Max(x, x * 0.01f);
            default: return ExactSigmoid(x);
        }
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static Vector<float> ExactSigmoid(Vector<float> x)
    {
        Span<float> t = stackalloc float[Vector<float>.Count];
        x.CopyTo(t);
        for (int i = 0; i < t.Length; i++) t[i] = 1f / (1f + MathF.Exp(-t[i]));
        return new Vector<float>(t);
    }

    public static float Activate(float x, NamActivation a) => a switch
    {
        NamActivation.Tanh => FastTanh(x),
        NamActivation.HardTanh => Math.Clamp(x, -1f, 1f),
        NamActivation.Relu => MathF.Max(x, 0f),
        NamActivation.LeakyRelu => x > 0 ? x : 0.01f * x,
        _ => 1f / (1f + MathF.Exp(-x)),
    };

    public static NamActivation ParseActivation(JsonElement e)
    {
        string? name = e.ValueKind == JsonValueKind.String ? e.GetString() : null;
        return name switch
        {
            "Tanh" or "Fasttanh" => NamActivation.Tanh,
            "Hardtanh" => NamActivation.HardTanh,
            "ReLU" => NamActivation.Relu,
            "LeakyReLU" => NamActivation.LeakyRelu,
            "Sigmoid" => NamActivation.Sigmoid,
            _ => throw new NamException($"Activation function “{name ?? e.GetRawText()}” isn't supported."),
        };
    }

    /// <summary>
    /// Σ W[j]·x[j] по j = 0..n-1, где W — n векторов подряд (по одному на входной канал).
    /// Две независимые цепочки сложения, чтобы процессор считал их параллельно.
    /// </summary>
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static Vector<float> MatCol(ref float w, ref float x, int n)
    {
        Vector<float> a = Vector<float>.Zero, b = Vector<float>.Zero;
        nuint step = (nuint)Vector<float>.Count, wi = 0;
        int j = 0;
        for (; j + 1 < n; j += 2)
        {
            a = Vector.MultiplyAddEstimate(Vector.LoadUnsafe(ref w, wi), new Vector<float>(Unsafe.Add(ref x, j)), a);
            b = Vector.MultiplyAddEstimate(Vector.LoadUnsafe(ref w, wi + step), new Vector<float>(Unsafe.Add(ref x, j + 1)), b);
            wi += step * 2;
        }
        if (j < n) a = Vector.MultiplyAddEstimate(Vector.LoadUnsafe(ref w, wi), new Vector<float>(Unsafe.Add(ref x, j)), a);
        return a + b;
    }
}

/// <summary>Последовательное чтение плоского массива весов с проверкой границ.</summary>
internal sealed class WeightReader(float[] weights)
{
    private int pos;
    public int Position => pos;
    public int Length => weights.Length;

    public float Next()
    {
        if (pos >= weights.Length) throw new NamException("The file has fewer weights than the network description requires.");
        return weights[pos++];
    }

    public void ExpectEnd()
    {
        if (pos != weights.Length)
            throw new NamException($"The weight count doesn't match the network description (read {pos} of {weights.Length}).");
    }
}

internal abstract class NamModel
{
    public NamInfo Info { get; } = new();
    protected abstract int PrewarmSamples { get; }

    /// <summary>Обработать блок. Вход и выход могут быть одним и тем же буфером.</summary>
    public abstract void Process(ReadOnlySpan<float> input, Span<float> output);

    /// <summary>Прогнать тишину, чтобы внутреннее состояние сети установилось (и JIT скомпилировал код).</summary>
    public void Prewarm()
    {
        Span<float> buf = stackalloc float[64];
        for (int left = PrewarmSamples; left > 0; left -= 64)
        {
            buf.Clear();
            Process(buf, buf);
        }
    }

    /// <summary>
    /// Загрузить модель. Если рядом лежит официальная библиотека NAM (namcore.dll), считает она —
    /// это все архитектуры, включая A2. Иначе — собственная реализация (WaveNet A1 и LSTM).
    /// </summary>
    public static NamModel Load(string path)
    {
        NamInfo meta = ReadInfo(path);
        NamModel model = NativeNam.Available ? NativeNam.Create(path) : LoadManaged(path);
        NamInfo info = model.Info;
        info.Path = path;
        info.Name = meta.Name;
        info.Architecture = meta.Architecture;
        info.Flavor = meta.Flavor;
        info.Version = meta.Version;
        info.Parameters = meta.Parameters;
        info.Gear = meta.Gear;
        info.Tone = meta.Tone;
        info.Author = meta.Author;
        info.Loudness ??= meta.Loudness;
        if (info.SampleRate <= 0) info.SampleRate = meta.SampleRate;
        return model;
    }

    /// <summary>Собственная реализация: WaveNet A1 и LSTM (запасной путь и сверка с библиотекой).</summary>
    public static NamModel LoadManaged(string path)
    {
        using JsonDocument doc = Parse(path);
        JsonElement root = doc.RootElement;
        string version = root.TryGetProperty("version", out JsonElement ver) && ver.ValueKind == JsonValueKind.String ? ver.GetString()! : "";
        string[] parts = version.Split('.');
        if (parts.Length != 3 || !int.TryParse(parts[0], out int major) || !int.TryParse(parts[1], out int minor)
            || major != 0 || minor < 5 || minor > 7)
            throw new NamException($"File version “{version}” isn't supported (0.5–0.7 required).");

        JsonElement weightsEl = root.GetProperty("weights");
        var weights = new float[weightsEl.GetArrayLength()];
        int wi = 0;
        foreach (JsonElement w in weightsEl.EnumerateArray()) weights[wi++] = (float)w.GetDouble();

        JsonElement config = root.GetProperty("config");
        string arch = root.GetProperty("architecture").GetString() ?? "";
        NamModel model = arch switch
        {
            "WaveNet" => NamWaveNet.Create(config, weights),
            "LSTM" => NamLstm.Create(config, weights, SampleRate(root)),
            _ => throw new NamException(
                $"Architecture “{arch}” isn't supported without the NAM library. First-version WaveNet (A1) and LSTM models will work."),
        };
        model.Info.SampleRate = SampleRate(root);
        model.Info.Engine = "built-in engine";
        model.Prewarm();
        return model;
    }

    private static JsonDocument Parse(string path)
    {
        JsonDocument doc;
        try { doc = JsonDocument.Parse(File.ReadAllBytes(path)); }
        catch (JsonException) { throw new NamException("The file is damaged or isn't a NAM model."); }
        JsonElement root = doc.RootElement;
        if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("architecture", out JsonElement arch)
            || arch.ValueKind != JsonValueKind.String || !root.TryGetProperty("config", out _) || !root.TryGetProperty("weights", out JsonElement w)
            || w.ValueKind != JsonValueKind.Array)
        {
            doc.Dispose();
            throw new NamException("This isn't a NAM model: the architecture, config and weights fields are missing.");
        }
        return doc;
    }

    /// <summary>Паспорт модели из файла: название, тип аппарата, громкость, разновидность архитектуры.</summary>
    private static NamInfo ReadInfo(string path)
    {
        using JsonDocument doc = Parse(path);
        JsonElement root = doc.RootElement;
        var info = new NamInfo
        {
            Path = path,
            Name = System.IO.Path.GetFileNameWithoutExtension(path),
            Architecture = root.GetProperty("architecture").GetString() ?? "",
            Version = root.TryGetProperty("version", out JsonElement ver) && ver.ValueKind == JsonValueKind.String ? ver.GetString()! : "",
            SampleRate = SampleRate(root),
        };
        JsonElement config = root.GetProperty("config");
        info.Parameters = CountWeights(root);
        info.Flavor = info.Architecture switch
        {
            "SlimmableContainer" => "A2",
            "WaveNet" => IsPlainWaveNet(config) ? "WaveNet A1" : "WaveNet A2",
            _ => info.Architecture,
        };
        if (root.TryGetProperty("metadata", out JsonElement meta) && meta.ValueKind == JsonValueKind.Object)
        {
            info.Gear = Str(meta, "gear_type");
            info.Tone = Str(meta, "tone_type");
            info.Author = Str(meta, "modeled_by");
            if (meta.TryGetProperty("loudness", out JsonElement loud) && loud.ValueKind == JsonValueKind.Number)
                info.Loudness = loud.GetDouble();
        }
        return info;
    }

    /// <summary>Число весов, включая вложенные модели контейнера.</summary>
    private static int CountWeights(JsonElement model)
    {
        int n = model.TryGetProperty("weights", out JsonElement w) && w.ValueKind == JsonValueKind.Array ? w.GetArrayLength() : 0;
        if (model.TryGetProperty("config", out JsonElement cfg) && cfg.ValueKind == JsonValueKind.Object
            && cfg.TryGetProperty("submodels", out JsonElement subs) && subs.ValueKind == JsonValueKind.Array)
        {
            foreach (JsonElement s in subs.EnumerateArray())
                if (s.ValueKind == JsonValueKind.Object && s.TryGetProperty("model", out JsonElement m) && m.ValueKind == JsonValueKind.Object)
                    n = Math.Max(n, CountWeights(m)); // играет одна из вложенных — показываем самую большую
        }
        return n;
    }

    private static bool IsPlainWaveNet(JsonElement config)
    {
        if (config.ValueKind != JsonValueKind.Object) return false;
        foreach (JsonProperty p in config.EnumerateObject())
            if (p.Name is not ("layers" or "head" or "head_scale")) return false;
        if (!config.TryGetProperty("layers", out JsonElement layers) || layers.ValueKind != JsonValueKind.Array) return false;
        foreach (JsonElement l in layers.EnumerateArray())
            foreach (JsonProperty p in l.EnumerateObject())
                if (p.Name is not ("input_size" or "condition_size" or "head_size" or "channels" or "kernel_size"
                    or "dilations" or "activation" or "gated" or "head_bias")) return false;
        return true;
    }

    private static double SampleRate(JsonElement root) =>
        root.TryGetProperty("sample_rate", out JsonElement sr) && sr.ValueKind == JsonValueKind.Number && sr.GetDouble() > 0
            ? sr.GetDouble() : 48000;

    private static string? Str(JsonElement o, string name) =>
        o.TryGetProperty(name, out JsonElement v) && v.ValueKind == JsonValueKind.String && v.GetString() is { Length: > 0 } s ? s : null;

    protected static int Int(JsonElement o, string name) =>
        o.TryGetProperty(name, out JsonElement v) && v.ValueKind == JsonValueKind.Number ? v.GetInt32()
        : throw new NamException($"The network description has no “{name}” field.");
}

/// <summary>WaveNet (A1): стопки расширенных свёрток с остаточными связями.</summary>
internal sealed class NamWaveNet : NamModel
{
    private const int MaxBlock = 64;
    private static readonly HashSet<string> LayerKeys = new()
    {
        "input_size", "condition_size", "head_size", "channels", "kernel_size", "dilations", "activation", "gated", "head_bias",
    };

    private sealed class Arr
    {
        public int C, Cp, Nv, K, L, InSize, HeadSize, HeadCp;
        public bool HeadBias, Last;
        public NamActivation Act;
        public int[] Dil = [];
        public float[] Rechannel = [];              // [v][j][lane]
        public float[][] ConvW = [], ConvB = [];    // слой: [v][k][j][lane] и смещения
        public float[][] Mix = [];                  // слой: подмешивание входа (condition)
        public float[][] W1 = [], B1 = [];          // слой: свёртка 1×1 остаточной связи
        public float[] HeadW = [], HeadB = [];      // выход стопки
        public float[][] Buf = [];                  // слой: кольцевая история входа, [время][канал]
        public uint[] Mask = [];
        public float[] Head = [], Out = [];         // на блок: сумма для «головы» и выход стопки
    }

    private readonly Arr[] arrays;
    private readonly float headScale;
    private readonly float[] z;
    private readonly int prewarm;
    private uint time;

    protected override int PrewarmSamples => prewarm;

    private NamWaveNet(Arr[] arrays, float headScale)
    {
        this.arrays = arrays;
        this.headScale = headScale;
        z = new float[arrays.Max(a => a.Cp)];
        prewarm = 1 + arrays.Sum(a => a.Dil.Sum(d => d * (a.K - 1)));
    }

    public static NamWaveNet Create(JsonElement config, float[] weights)
    {
        foreach (JsonProperty p in config.EnumerateObject())
            if (p.Name is not ("layers" or "head" or "head_scale"))
                throw Newer(p.Name);
        if (config.TryGetProperty("head", out JsonElement head) && head.ValueKind != JsonValueKind.Null)
            throw new NamException("WaveNet models with a separate head aren't supported.");
        if (!config.TryGetProperty("layers", out JsonElement layers) || layers.ValueKind != JsonValueKind.Array || layers.GetArrayLength() == 0)
            throw new NamException("The network description has no layers.");

        int V = NamMath.V;
        var arrays = new List<Arr>();
        foreach (JsonElement le in layers.EnumerateArray())
        {
            foreach (JsonProperty p in le.EnumerateObject())
                if (!LayerKeys.Contains(p.Name)) throw Newer(p.Name);
            var a = new Arr
            {
                InSize = Int(le, "input_size"),
                HeadSize = Int(le, "head_size"),
                C = Int(le, "channels"),
                K = Int(le, "kernel_size"),
                Dil = le.GetProperty("dilations").EnumerateArray().Select(d => d.GetInt32()).ToArray(),
                Act = NamMath.ParseActivation(le.GetProperty("activation")),
                HeadBias = le.TryGetProperty("head_bias", out JsonElement hb) && hb.ValueKind == JsonValueKind.True,
            };
            if (Int(le, "condition_size") != 1) throw new NamException("Only models with a single input channel are supported.");
            if (le.TryGetProperty("gated", out JsonElement g) && g.ValueKind == JsonValueKind.True)
                throw new NamException("Gated WaveNet models aren't supported.");
            if (a.C < 1 || a.C > 256 || a.K < 1 || a.K > 64 || a.Dil.Length == 0 || a.Dil.Any(d => d < 1 || d > 65536))
                throw new NamException("Invalid network sizes in the model description.");
            a.L = a.Dil.Length;
            a.Cp = NamMath.Pad(a.C);
            a.Nv = a.Cp / V;
            arrays.Add(a);
        }
        for (int i = 0; i < arrays.Count; i++)
        {
            Arr a = arrays[i];
            a.Last = i == arrays.Count - 1;
            int expectedIn = i == 0 ? 1 : arrays[i - 1].C;
            int expectedHead = a.Last ? 1 : arrays[i + 1].C;
            if (a.InSize != expectedIn || a.HeadSize != expectedHead)
                throw new NamException("The layer stack sizes in the model don't match each other.");
            a.HeadCp = a.Last ? V : arrays[i + 1].Cp;
        }

        var r = new WeightReader(weights);
        foreach (Arr a in arrays) ReadArray(a, r, V);
        float headScale = r.Next(); // последний вес — масштаб выхода; он главнее значения из config
        r.ExpectEnd();
        return new NamWaveNet(arrays.ToArray(), headScale);
    }

    private static NamException Newer(string key) => new(
        $"The model uses features of a newer format version (the “{key}” field) that aren't supported yet. Choose the A1 version of the model.");

    private static void ReadArray(Arr a, WeightReader r, int V)
    {
        int C = a.C, Cp = a.Cp, K = a.K;
        // порядок чтения везде: выходной канал → входной канал → отсчёт ядра; затем смещения
        a.Rechannel = new float[a.Nv * a.InSize * V];
        for (int i = 0; i < C; i++)
            for (int j = 0; j < a.InSize; j++)
                a.Rechannel[((i / V) * a.InSize + j) * V + i % V] = r.Next();

        a.ConvW = new float[a.L][]; a.ConvB = new float[a.L][]; a.Mix = new float[a.L][];
        a.W1 = new float[a.L][]; a.B1 = new float[a.L][];
        a.Buf = new float[a.L][]; a.Mask = new uint[a.L];
        for (int l = 0; l < a.L; l++)
        {
            float[] cw = a.ConvW[l] = new float[a.Nv * K * C * V];
            for (int i = 0; i < C; i++)
                for (int j = 0; j < C; j++)
                    for (int k = 0; k < K; k++)
                        cw[(((i / V) * K + k) * C + j) * V + i % V] = r.Next();
            float[] cb = a.ConvB[l] = new float[Cp];
            for (int i = 0; i < C; i++) cb[i] = r.Next();
            float[] mix = a.Mix[l] = new float[Cp];
            for (int i = 0; i < C; i++) mix[i] = r.Next();
            float[] w1 = a.W1[l] = new float[a.Nv * C * V];
            for (int i = 0; i < C; i++)
                for (int j = 0; j < C; j++)
                    w1[((i / V) * C + j) * V + i % V] = r.Next();
            float[] b1 = a.B1[l] = new float[Cp];
            for (int i = 0; i < C; i++) b1[i] = r.Next();

            int size = 1;
            while (size < (K - 1) * a.Dil[l] + MaxBlock) size <<= 1;
            a.Buf[l] = new float[size * Cp];
            a.Mask[l] = (uint)(size - 1);
        }

        if (a.Last)
        {
            a.HeadW = new float[Cp];
            for (int j = 0; j < C; j++) a.HeadW[j] = r.Next();
            a.HeadB = new float[1];
            if (a.HeadBias) a.HeadB[0] = r.Next();
        }
        else
        {
            a.HeadW = new float[a.HeadCp / V * C * V];
            for (int i = 0; i < a.HeadSize; i++)
                for (int j = 0; j < C; j++)
                    a.HeadW[((i / V) * C + j) * V + i % V] = r.Next();
            a.HeadB = new float[a.HeadCp];
            if (a.HeadBias) for (int i = 0; i < a.HeadSize; i++) a.HeadB[i] = r.Next();
        }
        a.Head = new float[MaxBlock * Cp];
        a.Out = new float[MaxBlock * Cp];
    }

    public override void Process(ReadOnlySpan<float> input, Span<float> output)
    {
        for (int o = 0; o < input.Length; o += MaxBlock)
        {
            int n = Math.Min(MaxBlock, input.Length - o);
            Chunk(input.Slice(o, n), output.Slice(o, n));
        }
    }

    private void Chunk(ReadOnlySpan<float> x, Span<float> y)
    {
        int n = x.Length, V = NamMath.V;
        nuint vs = (nuint)V;
        ref float zr = ref z[0];
        Array.Clear(arrays[0].Head, 0, n * arrays[0].Cp);

        for (int ai = 0; ai < arrays.Length; ai++)
        {
            Arr a = arrays[ai];
            int C = a.C, Cp = a.Cp, Nv = a.Nv, K = a.K;
            ref float head = ref a.Head[0];

            // вход стопки → каналы первого слоя
            {
                ref float buf = ref a.Buf[0][0];
                uint mask = a.Mask[0];
                ref float re = ref a.Rechannel[0];
                if (ai == 0)
                {
                    for (int s = 0; s < n; s++)
                    {
                        nuint at = (nuint)((time + (uint)s) & mask) * (nuint)Cp;
                        var c = new Vector<float>(x[s]);
                        for (int v = 0; v < Nv; v++)
                            (Vector.LoadUnsafe(ref re, (nuint)v * vs) * c).StoreUnsafe(ref buf, at + (nuint)v * vs);
                    }
                }
                else
                {
                    Arr prev = arrays[ai - 1];
                    ref float po = ref prev.Out[0];
                    for (int s = 0; s < n; s++)
                    {
                        nuint at = (nuint)((time + (uint)s) & mask) * (nuint)Cp;
                        ref float src = ref Unsafe.Add(ref po, s * prev.Cp);
                        for (int v = 0; v < Nv; v++)
                            NamMath.MatCol(ref Unsafe.Add(ref re, v * a.InSize * V), ref src, a.InSize)
                                .StoreUnsafe(ref buf, at + (nuint)v * vs);
                    }
                }
            }

            for (int l = 0; l < a.L; l++)
            {
                ref float buf = ref a.Buf[l][0];
                uint mask = a.Mask[l];
                int dil = a.Dil[l];
                ref float cw = ref a.ConvW[l][0];
                ref float cb = ref a.ConvB[l][0];
                ref float mix = ref a.Mix[l][0];
                ref float w1 = ref a.W1[l][0];
                ref float b1 = ref a.B1[l][0];
                bool lastLayer = l == a.L - 1;
                bool needOut = !(a.Last && lastLayer); // выход самого последнего слоя никто не читает
                ref float next = ref (lastLayer ? ref a.Out[0] : ref a.Buf[l + 1][0]);
                uint nextMask = lastLayer ? 0 : a.Mask[l + 1];
                NamActivation act = a.Act;

                for (int s = 0; s < n; s++)
                {
                    uint t = time + (uint)s;
                    var c = new Vector<float>(x[s]);
                    for (int v = 0; v < Nv; v++)
                    {
                        nuint vo = (nuint)v * vs;
                        Vector<float> acc = Vector.LoadUnsafe(ref cb, vo) + Vector.LoadUnsafe(ref mix, vo) * c;
                        for (int k = 0; k < K; k++)
                        {
                            // отсчёт ядра k смотрит на вход с задержкой dil·(K−1−k): последний — текущий сэмпл
                            nuint at = (nuint)((t - (uint)(dil * (K - 1 - k))) & mask) * (nuint)Cp;
                            acc += NamMath.MatCol(ref Unsafe.Add(ref cw, (v * K + k) * C * V), ref Unsafe.Add(ref buf, at), C);
                        }
                        Vector<float> zv = NamMath.Activate(acc, act);
                        zv.StoreUnsafe(ref zr, vo);
                        nuint ho = (nuint)(s * Cp) + vo;
                        (Vector.LoadUnsafe(ref head, ho) + zv).StoreUnsafe(ref head, ho);
                    }
                    if (!needOut) continue;
                    nuint cur = (nuint)(t & mask) * (nuint)Cp;
                    nuint dst = lastLayer ? (nuint)(s * Cp) : (nuint)(t & nextMask) * (nuint)Cp;
                    for (int v = 0; v < Nv; v++)
                    {
                        nuint vo = (nuint)v * vs;
                        Vector<float> o = Vector.LoadUnsafe(ref buf, cur + vo) + Vector.LoadUnsafe(ref b1, vo)
                            + NamMath.MatCol(ref Unsafe.Add(ref w1, v * C * V), ref zr, C);
                        o.StoreUnsafe(ref next, dst + vo);
                    }
                }
            }

            // выход стопки: сумма активаций всех слоёв → следующая стопка или итоговый сэмпл
            ref float hw = ref a.HeadW[0];
            if (a.Last)
            {
                float bias = a.HeadB[0];
                for (int s = 0; s < n; s++)
                {
                    Vector<float> acc = Vector<float>.Zero;
                    for (int v = 0; v < Nv; v++)
                        acc += Vector.LoadUnsafe(ref hw, (nuint)v * vs) * Vector.LoadUnsafe(ref head, (nuint)(s * Cp) + (nuint)v * vs);
                    y[s] = headScale * (Vector.Sum(acc) + bias);
                }
            }
            else
            {
                Arr nextArr = arrays[ai + 1];
                ref float nh = ref nextArr.Head[0];
                ref float hb = ref a.HeadB[0];
                int nvNext = a.HeadCp / V;
                for (int s = 0; s < n; s++)
                {
                    ref float src = ref Unsafe.Add(ref head, s * Cp);
                    for (int v = 0; v < nvNext; v++)
                    {
                        nuint vo = (nuint)v * vs;
                        (Vector.LoadUnsafe(ref hb, vo) + NamMath.MatCol(ref Unsafe.Add(ref hw, v * C * V), ref src, C))
                            .StoreUnsafe(ref nh, (nuint)(s * a.HeadCp) + vo);
                    }
                }
            }
        }
        time += (uint)n;
    }
}

/// <summary>LSTM: рекуррентная сеть, считается по одному сэмплу.</summary>
internal sealed class NamLstm : NamModel
{
    private sealed class Cell
    {
        public int I, H, Hp, Cols;
        public float[] W = [];   // [строка-вектор][столбец][lane]; строки: i, f, g, o — каждый блок дополнен до Hp
        public float[] B = [];   // 4·Hp
        public float[] Xh = [];  // вход + скрытое состояние (дополнено)
        public float[] Cst = []; // состояние ячейки, Hp
        public float[] Pre = []; // 4·Hp
    }

    private readonly Cell[] cells;
    private readonly float[] headW;
    private readonly float headB;
    private readonly int prewarm;

    protected override int PrewarmSamples => prewarm;

    private NamLstm(Cell[] cells, float[] headW, float headB, double sampleRate)
    {
        this.cells = cells;
        this.headW = headW;
        this.headB = headB;
        prewarm = Math.Max(1, (int)(0.5 * sampleRate));
    }

    public static NamLstm Create(JsonElement config, float[] weights, double sampleRate)
    {
        foreach (JsonProperty p in config.EnumerateObject())
            if (p.Name is not ("input_size" or "hidden_size" or "num_layers"))
                throw new NamException($"The LSTM model uses an unsupported field “{p.Name}”.");

        int inputSize = Int(config, "input_size"), H = Int(config, "hidden_size"), layers = Int(config, "num_layers");
        if (inputSize != 1) throw new NamException("Only models with a single input channel are supported.");
        if (H < 1 || H > 512 || layers < 1 || layers > 16) throw new NamException("Invalid network sizes in the model description.");

        int V = NamMath.V, Hp = NamMath.Pad(H);
        var r = new WeightReader(weights);
        var cells = new Cell[layers];
        for (int l = 0; l < layers; l++)
        {
            int I = l == 0 ? 1 : H;
            var c = cells[l] = new Cell { I = I, H = H, Hp = Hp, Cols = I + H };
            c.W = new float[4 * Hp * c.Cols];
            c.B = new float[4 * Hp];
            c.Xh = new float[I + Hp];
            c.Cst = new float[Hp];
            c.Pre = new float[4 * Hp];
            // матрица 4H × (I+H) построчно; блоки строк: i, f, g, o
            for (int gate = 0; gate < 4; gate++)
                for (int i = 0; i < H; i++)
                {
                    int row = gate * Hp + i;
                    for (int col = 0; col < c.Cols; col++)
                        c.W[((row / V) * c.Cols + col) * V + row % V] = r.Next();
                }
            for (int gate = 0; gate < 4; gate++)
                for (int i = 0; i < H; i++) c.B[gate * Hp + i] = r.Next();
            for (int i = 0; i < H; i++) c.Xh[I + i] = r.Next();  // начальное скрытое состояние
            for (int i = 0; i < H; i++) c.Cst[i] = r.Next();     // начальное состояние ячейки
        }
        var headW = new float[Hp];
        for (int i = 0; i < H; i++) headW[i] = r.Next();
        float headB = r.Next();
        r.ExpectEnd();
        return new NamLstm(cells, headW, headB, sampleRate);
    }

    public override void Process(ReadOnlySpan<float> input, Span<float> output)
    {
        int V = NamMath.V;
        nuint vs = (nuint)V;
        for (int s = 0; s < input.Length; s++)
        {
            float x = input[s];
            for (int l = 0; l < cells.Length; l++)
            {
                Cell c = cells[l];
                if (l == 0) c.Xh[0] = x;
                else Array.Copy(cells[l - 1].Xh, cells[l - 1].I, c.Xh, 0, c.H);

                ref float w = ref c.W[0];
                ref float b = ref c.B[0];
                ref float xh = ref c.Xh[0];
                ref float pre = ref c.Pre[0];
                int rows = 4 * c.Hp / V;
                for (int v = 0; v < rows; v++)
                    (Vector.LoadUnsafe(ref b, (nuint)v * vs) + NamMath.MatCol(ref Unsafe.Add(ref w, v * c.Cols * V), ref xh, c.Cols))
                        .StoreUnsafe(ref pre, (nuint)v * vs);

                ref float cs = ref c.Cst[0];
                ref float h = ref Unsafe.Add(ref xh, c.I);
                nuint hp = (nuint)c.Hp;
                for (nuint o = 0; o < hp; o += vs)
                {
                    Vector<float> ig = NamMath.FastSigmoid(Vector.LoadUnsafe(ref pre, o));
                    Vector<float> fg = NamMath.FastSigmoid(Vector.LoadUnsafe(ref pre, hp + o));
                    Vector<float> gg = NamMath.FastTanh(Vector.LoadUnsafe(ref pre, 2 * hp + o));
                    Vector<float> og = NamMath.FastSigmoid(Vector.LoadUnsafe(ref pre, 3 * hp + o));
                    Vector<float> cn = fg * Vector.LoadUnsafe(ref cs, o) + ig * gg;
                    cn.StoreUnsafe(ref cs, o);
                    (og * NamMath.FastTanh(cn)).StoreUnsafe(ref h, o);
                }
            }
            Cell top = cells[^1];
            float acc = headB;
            for (int i = 0; i < top.H; i++) acc += headW[i] * top.Xh[top.I + i];
            output[s] = acc;
        }
    }
}
