// Цепочка звука из произвольных блоков. Блок — педаль, усилитель, кабинет или эффект;
// порядок и набор блоков задаёт интерфейс. Аудиопоток читает готовый массив блоков один раз на буфер,
// поток интерфейса собирает новый массив и подменяет ссылку — без блокировок.
using System.Numerics;

namespace Lad;

internal abstract class Block
{
    public string Id = "";
    public volatile bool On = true;
    public abstract string Type { get; }
    /// <summary>Блок выдаёт стерео (пространственные эффекты). Остальные — моно.</summary>
    public virtual bool Stereo => false;

    protected abstract string[] Names { get; }
    protected abstract float[] Defaults { get; }
    protected float[] p;
    private readonly float[] pending;
    private int version = 1, seen;
    protected float fs = 48000;

    // файл блока (модель NAM или импульс) и то, что о нём известно
    public string? FilePath;
    /// <summary>Файл, который просил интерфейс (даже если загрузить его не удалось).</summary>
    public string? RequestedFile;
    public string? Error;

    protected Block()
    {
        p = (float[])Defaults.Clone();
        pending = (float[])Defaults.Clone();
    }

    /// <summary>Поток интерфейса: задать параметр по имени.</summary>
    public bool SetParam(string name, float value)
    {
        int i = Array.IndexOf(Names, name);
        if (i < 0 || !float.IsFinite(value)) return false;
        pending[i] = value;
        Interlocked.Increment(ref version);
        return true;
    }

    public void Prepare(float sampleRate, int maxBlock)
    {
        fs = sampleRate;
        OnPrepare(maxBlock);
        seen = 0;
        Sync();
    }

    /// <summary>Аудиопоток: подхватить изменённые параметры.</summary>
    public void Sync()
    {
        int v = Volatile.Read(ref version);
        if (v == seen) return;
        seen = v;
        Array.Copy(pending, p, p.Length);
        Configure();
    }

    protected virtual void OnPrepare(int maxBlock) { }
    protected abstract void Configure();
    public virtual void ProcessMono(Span<float> x) { }
    public virtual void ProcessStereo(Span<float> l, Span<float> r) { }
    public virtual void Snap() { }

    /// <summary>Нужен ли блоку файл и какой: "nam", "ir" или null.</summary>
    public virtual string? FileKind => null;
    public virtual void LoadFile(string path) => throw new NotSupportedException();
    public virtual void Unload() { }
    public virtual void SetSize(double value) { }
    /// <summary>Сведения для интерфейса о загруженном файле.</summary>
    public virtual Dictionary<string, object?> Info() => new();

    public static Block? Create(string type) => type switch
    {
        "gate" => new GateBlock(),
        "comp" => new CompBlock(),
        "drive" => new DriveBlock(),
        "pedal" => new NamBlock(false),
        "amp" => new NamBlock(true),
        "polyamp" => new PolyAmpBlock(),
        "cab" => new CabBlock(),
        "polycab" => new PolyCabBlock(),
        "chorus" => new ChorusBlock(),
        "phaser" => new PhaserBlock(),
        "tremolo" => new TremoloBlock(),
        "delay" => new DelayBlock(),
        "reverb" => new ReverbBlock(),
        "space" => new SpaceBlock(),
        "vst3" => new Vst3Block(), // в AllTypes его нет: прогревать без плагина нечего
        _ => null,
    };

    public static readonly string[] AllTypes =
        { "gate", "comp", "drive", "pedal", "amp", "polyamp", "cab", "polycab", "chorus", "phaser", "tremolo", "delay", "reverb", "space" };
}

// ---------- динамика ----------

internal sealed class GateBlock : Block
{
    private static readonly string[] N = { "thresh" };
    private static readonly float[] D = { -62 };
    private readonly NoiseGate gate = new();
    public override string Type => "gate";
    protected override string[] Names => N;
    protected override float[] Defaults => D;
    protected override void OnPrepare(int maxBlock) => gate.Prepare(fs);
    protected override void Configure() => gate.SetThreshold(p[0]);
    public override void ProcessMono(Span<float> x) { for (int i = 0; i < x.Length; i++) x[i] = gate.Process(x[i]); }
    public override void Snap() => gate.Snap();
}

/// <summary>Компрессор: выравнивает громкость, добавляет сустейн чистому звуку.</summary>
internal sealed class CompBlock : Block
{
    private static readonly string[] N = { "thresh", "ratio", "makeup" };
    private static readonly float[] D = { -24, 4, 4 };
    private float env, gainDb, attack, release, makeup = 1, slope;
    public override string Type => "comp";
    protected override string[] Names => N;
    protected override float[] Defaults => D;

    protected override void Configure()
    {
        attack = 1f - MathF.Exp(-1f / (0.006f * fs));
        release = 1f - MathF.Exp(-1f / (0.14f * fs));
        slope = 1f - 1f / Math.Clamp(p[1], 1f, 20f);
        makeup = DspMath.Db(p[2]);
    }

    public override void ProcessMono(Span<float> x)
    {
        float thr = p[0];
        const float knee = 6f;
        for (int i = 0; i < x.Length; i++)
        {
            float a = MathF.Abs(x[i]);
            env += (a - env) * (a > env ? attack : release);
            float level = 20f * MathF.Log10(env + 1e-9f);
            float over = level - thr;
            // мягкое колено: сжатие нарастает плавно вокруг порога
            float reduce = over <= -knee / 2 ? 0f
                : over >= knee / 2 ? over * slope
                : slope * (over + knee / 2) * (over + knee / 2) / (2 * knee);
            gainDb += (-reduce - gainDb) * 0.2f;
            x[i] *= DspMath.Db(gainDb) * makeup;
        }
    }

    public override void Snap() { env = DspMath.Snap(env); }
}

// ---------- встроенные педаль, усилитель, кабинет ----------

internal sealed class DriveBlock : Block
{
    private static readonly string[] N = { "drive", "tone", "level" };
    private static readonly float[] D = { 0.4f, 0.5f, 0.5f };
    private readonly Overdrive od = new();
    public override string Type => "drive";
    protected override string[] Names => N;
    protected override float[] Defaults => D;
    protected override void Configure() => od.Set(fs, p[0], p[1], p[2]);
    public override void ProcessMono(Span<float> x) { for (int i = 0; i < x.Length; i++) x[i] = od.Process(x[i]); }
    public override void Snap() => od.Snap();
}

internal sealed class PolyAmpBlock : Block
{
    private static readonly string[] N = { "channel", "gain", "bass", "mid", "treble", "presence", "master" };
    private static readonly float[] D = { 1, 0.5f, 0.5f, 0.5f, 0.5f, 0.5f, 0.5f };
    private readonly Amp amp = new();
    public override string Type => "polyamp";
    protected override string[] Names => N;
    protected override float[] Defaults => D;
    protected override void Configure() => amp.Set(fs, (int)MathF.Round(p[0]), p[1], p[2], p[3], p[4], p[5], p[6]);
    public override void ProcessMono(Span<float> x) { for (int i = 0; i < x.Length; i++) x[i] = amp.Process(x[i]); }
    public override void Snap() => amp.Snap();
}

internal sealed class PolyCabBlock : Block
{
    private static readonly string[] N = { "type", "level" };
    private static readonly float[] D = { 0, 0 };
    private readonly Cab cab = new();
    private float gain = 1, target = 1;
    public override string Type => "polycab";
    protected override string[] Names => N;
    protected override float[] Defaults => D;
    protected override void Configure() { cab.Set(fs, (int)MathF.Round(p[0])); target = DspMath.Db(p[1]); }
    public override void ProcessMono(Span<float> x)
    {
        for (int i = 0; i < x.Length; i++)
        {
            gain += (target - gain) * 0.002f;
            x[i] = cab.Process(x[i]) * gain;
        }
    }
    public override void Snap() => cab.Snap();
}

// ---------- тоны с TONE3000: нейромодели и импульсы ----------

/// <summary>Нейромодель NAM: педаль или усилитель (у усилителя после модели — эквалайзер).</summary>
internal sealed class NamBlock(bool isAmp) : Block
{
    private static readonly string[] AmpNames = { "input", "output", "bass", "mid", "treble" };
    private static readonly float[] AmpDefaults = { 0, 0, 0.5f, 0.5f, 0.5f };

    private NamModel? model;
    private Biquad bass, mid, treble;
    private float inGain = 1, inTarget = 1, outGain = 1, outTarget = 1, smooth = 0.002f;
    private double size = 1.0;

    public override string Type => isAmp ? "amp" : "pedal";
    public override string? FileKind => "nam";
    // эти свойства вызываются из конструктора базового класса, когда поле isAmp ещё не заполнено,
    // поэтому сам массив параметров всегда «усилительный», а педаль просто не трогает эквалайзер
    protected override string[] Names => AmpNames;
    protected override float[] Defaults => AmpDefaults;

    protected override void OnPrepare(int maxBlock) => smooth = 1f - MathF.Exp(-1f / (0.015f * fs));

    protected override void Configure()
    {
        inTarget = DspMath.Db(p[0]);
        // громкость моделей выравниваем по их паспортной громкости, как это делает плагин NAM (цель −18 дБ)
        double? loud = Volatile.Read(ref model)?.Info.Loudness;
        float norm = loud is { } l ? (float)Math.Clamp(-18.0 - l, -30.0, 30.0) : 0f;
        outTarget = DspMath.Db(p[1] + norm);
        if (!isAmp) return;
        bass.LowShelf(fs, 120, (p[2] - 0.5f) * 24);
        mid.Peak(fs, 680, 0.75, (p[3] - 0.5f) * 20);
        treble.HighShelf(fs, 2600, (p[4] - 0.5f) * 24);
    }

    public override void LoadFile(string path)
    {
        NamModel m = NamModel.Load(path);
        if (m is NativeNam native && m.Info.Slimmable) native.SetSize(size);
        Volatile.Write(ref model, m);
        FilePath = path;
        Configure(); // нормализация громкости зависит от модели
    }

    public override void Unload()
    {
        Volatile.Write(ref model, null);
        FilePath = null;
    }

    public override void SetSize(double value)
    {
        size = value;
        if (Volatile.Read(ref model) is NativeNam native && native.Info.Slimmable) native.SetSize(value);
    }

    public override Dictionary<string, object?> Info()
    {
        NamInfo? i = Volatile.Read(ref model)?.Info;
        return new()
        {
            ["name"] = i?.Name, ["flavor"] = i?.Flavor, ["gear"] = i?.Gear, ["author"] = i?.Author,
            ["slimmable"] = i?.Slimmable ?? false, ["modelSize"] = size, ["sampleRate"] = i?.SampleRate ?? 0,
            ["mismatch"] = i != null && Math.Abs(fs - i.SampleRate) > 1,
        };
    }

    public override void ProcessMono(Span<float> x)
    {
        NamModel? m = Volatile.Read(ref model);
        if (m == null) return; // без файла блок сигнал не трогает
        for (int i = 0; i < x.Length; i++)
        {
            inGain += (inTarget - inGain) * smooth;
            x[i] *= inGain;
        }
        m.Process(x, x);
        if (isAmp)
        {
            for (int i = 0; i < x.Length; i++)
            {
                outGain += (outTarget - outGain) * smooth;
                x[i] = treble.Process(mid.Process(bass.Process(x[i] * outGain)));
            }
        }
        else
        {
            for (int i = 0; i < x.Length; i++)
            {
                outGain += (outTarget - outGain) * smooth;
                x[i] *= outGain;
            }
        }
    }

    public override void Snap() { bass.Snap(); mid.Snap(); treble.Snap(); }
}

/// <summary>Кабинет: короткий импульс из файла.</summary>
internal sealed class CabBlock : Block
{
    private static readonly string[] N = { "level" };
    private static readonly float[] D = { 0 };
    private IrConvolver? conv;
    private float gain = 1, target = 1;
    public override string Type => "cab";
    public override string? FileKind => "ir";
    protected override string[] Names => N;
    protected override float[] Defaults => D;
    protected override void Configure() => target = DspMath.Db(p[0]);

    public override void LoadFile(string path)
    {
        Volatile.Write(ref conv, IrConvolver.Load(path, fs));
        FilePath = path;
    }

    public override void Unload() { Volatile.Write(ref conv, null); FilePath = null; }

    public override Dictionary<string, object?> Info()
    {
        IrConvolver? c = Volatile.Read(ref conv);
        return new() { ["name"] = c?.Name, ["ms"] = c != null ? c.Taps * 1000.0 / c.EngineRate : 0 };
    }

    public override void ProcessMono(Span<float> x)
    {
        IrConvolver? c = Volatile.Read(ref conv);
        if (c == null) return;
        for (int i = 0; i < x.Length; i++)
        {
            gain += (target - gain) * 0.002f;
            x[i] = c.Process(x[i]) * gain;
        }
    }
}

/// <summary>Пространство: длинный импульс (ревербератор, комната, зал) из файла, подмешивается к сигналу.</summary>
internal sealed class SpaceBlock : Block
{
    private static readonly string[] N = { "mix" };
    private static readonly float[] D = { 0.3f };
    private LongConvolver? conv;
    private float[] mono = [], wl = [], wr = [];
    private float mix, target;
    public override string Type => "space";
    public override bool Stereo => true;
    public override string? FileKind => "ir";
    protected override string[] Names => N;
    protected override float[] Defaults => D;
    protected override void OnPrepare(int maxBlock) { mono = new float[maxBlock]; wl = new float[maxBlock]; wr = new float[maxBlock]; }
    protected override void Configure() => target = Math.Clamp(p[0], 0f, 1.5f);

    public override void LoadFile(string path)
    {
        Volatile.Write(ref conv, LongConvolver.Load(path, fs));
        FilePath = path;
    }

    public override void Unload() { Volatile.Write(ref conv, null); FilePath = null; }

    public override Dictionary<string, object?> Info()
    {
        LongConvolver? c = Volatile.Read(ref conv);
        return new() { ["name"] = c?.Name, ["ms"] = c?.Milliseconds ?? 0, ["stereo"] = c?.IsStereo ?? false };
    }

    public override void ProcessStereo(Span<float> l, Span<float> r)
    {
        LongConvolver? c = Volatile.Read(ref conv);
        if (c == null) return;
        int n = l.Length;
        Span<float> m = mono.AsSpan(0, n), a = wl.AsSpan(0, n), b = wr.AsSpan(0, n);
        for (int i = 0; i < n; i++) m[i] = (l[i] + r[i]) * 0.5f;
        c.Process(m, a, b);
        for (int i = 0; i < n; i++)
        {
            mix += (target - mix) * 0.002f;
            l[i] += a[i] * mix;
            r[i] += b[i] * mix;
        }
    }
}

// ---------- модуляция и время ----------

internal sealed class ChorusBlock : Block
{
    private static readonly string[] N = { "rate", "depth", "mix" };
    private static readonly float[] D = { 0.8f, 0.5f, 0.5f };
    private float[] bufL = [], bufR = [];
    private int w;
    private float phase;
    public override string Type => "chorus";
    public override bool Stereo => true;
    protected override string[] Names => N;
    protected override float[] Defaults => D;
    protected override void OnPrepare(int maxBlock) { int n = (int)(fs * 0.05f) + 8; bufL = new float[n]; bufR = new float[n]; w = 0; }
    protected override void Configure() { }

    private static float Tap(float[] buf, int w, float delay)
    {
        float rp = w - delay;
        if (rp < 0) rp += buf.Length;
        int i0 = (int)rp;
        if (i0 >= buf.Length) i0 -= buf.Length;
        int i1 = i0 + 1 == buf.Length ? 0 : i0 + 1;
        return buf[i0] + (buf[i1] - buf[i0]) * (rp - (int)rp);
    }

    public override void ProcessStereo(Span<float> l, Span<float> r)
    {
        float inc = 2f * MathF.PI * Math.Clamp(p[0], 0.05f, 8f) / fs;
        float baseDelay = 0.012f * fs, sweep = 0.006f * fs * Math.Clamp(p[1], 0f, 1f), mix = Math.Clamp(p[2], 0f, 1f);
        for (int i = 0; i < l.Length; i++)
        {
            bufL[w] = l[i];
            bufR[w] = r[i];
            // левый и правый канал качаются со сдвигом на четверть периода — отсюда ширина
            float dl = Tap(bufL, w, baseDelay + sweep * MathF.Sin(phase));
            float dr = Tap(bufR, w, baseDelay + sweep * MathF.Cos(phase));
            l[i] += (dl - l[i]) * mix * 0.5f + dl * mix * 0.25f;
            r[i] += (dr - r[i]) * mix * 0.5f + dr * mix * 0.25f;
            if (++w == bufL.Length) w = 0;
            phase += inc;
            if (phase > 2f * MathF.PI) phase -= 2f * MathF.PI;
        }
    }
}

internal sealed class PhaserBlock : Block
{
    private static readonly string[] N = { "rate", "depth", "feedback", "mix" };
    private static readonly float[] D = { 0.5f, 0.7f, 0.3f, 0.5f };
    private readonly float[] z = new float[4];
    private float phase, last;
    public override string Type => "phaser";
    protected override string[] Names => N;
    protected override float[] Defaults => D;
    protected override void Configure() { }

    public override void ProcessMono(Span<float> x)
    {
        float inc = 2f * MathF.PI * Math.Clamp(p[0], 0.02f, 8f) / fs;
        float depth = Math.Clamp(p[1], 0f, 1f), fb = Math.Clamp(p[2], 0f, 0.9f), mix = Math.Clamp(p[3], 0f, 1f);
        for (int i = 0; i < x.Length; i++)
        {
            // центральная частота всепропускающих звеньев качается между ~300 Гц и ~3 кГц
            float f = 300f * MathF.Pow(10f, depth * (0.5f + 0.5f * MathF.Sin(phase)));
            float t = MathF.Tan(MathF.PI * MathF.Min(f, fs * 0.45f) / fs);
            float a = (t - 1f) / (t + 1f);
            float s = x[i] + last * fb;
            for (int k = 0; k < 4; k++)
            {
                float y = a * s + z[k];
                z[k] = s - a * y;
                s = y;
            }
            last = s;
            x[i] += (s - x[i]) * mix * 0.5f + s * mix * 0.5f;
            phase += inc;
            if (phase > 2f * MathF.PI) phase -= 2f * MathF.PI;
        }
    }

    public override void Snap() { for (int k = 0; k < 4; k++) z[k] = DspMath.Snap(z[k]); last = DspMath.Snap(last); }
}

/// <summary>
/// Тремоло: громкость качается. Форма: синус, мягкий квадрат или гармоническое — низ и верх
/// (раздел около 750 Гц) качаются в противофазе, как в коричневых Fender начала 60-х.
/// </summary>
internal sealed class TremoloBlock : Block
{
    private static readonly string[] N = { "rate", "depth", "shape" };
    private static readonly float[] D = { 4.5f, 0.6f, 0 };
    private Biquad split;
    private float phase, depth;
    public override string Type => "tremolo";
    protected override string[] Names => N;
    protected override float[] Defaults => D;
    protected override void OnPrepare(int maxBlock) => split.Lowpass(fs, 750, 0.707);
    protected override void Configure() { }

    public override void ProcessMono(Span<float> x)
    {
        float inc = 2f * MathF.PI * Math.Clamp(p[0], 0.1f, 20f) / fs;
        float target = Math.Clamp(p[1], 0f, 1f);
        int shape = (int)MathF.Round(p[2]);
        for (int i = 0; i < x.Length; i++)
        {
            depth += (target - depth) * 0.001f;
            float s = MathF.Sin(phase);
            float u = 0.5f + 0.5f * (shape == 1 ? MathF.Tanh(s * 4f) : s); // 0…1
            if (shape == 2)
            {
                float lo = split.Process(x[i]);
                float hi = x[i] - lo; // без модуляции низ и верх в сумме дают исходный сигнал
                x[i] = lo * (1f - depth * u) + hi * (1f - depth * (1f - u));
            }
            else
            {
                x[i] *= 1f - depth * u;
            }
            phase += inc;
            if (phase > 2f * MathF.PI) phase -= 2f * MathF.PI;
        }
    }

    public override void Snap() => split.Snap();
}

internal sealed class DelayBlock : Block
{
    private static readonly string[] N = { "time", "feedback", "mix" };
    private static readonly float[] D = { 380, 0.35f, 0.25f };
    private readonly Delay left = new(), right = new();
    public override string Type => "delay";
    public override bool Stereo => true;
    protected override string[] Names => N;
    protected override float[] Defaults => D;
    protected override void OnPrepare(int maxBlock) { left.Prepare(fs); right.Prepare(fs); }
    protected override void Configure() { left.Set(fs, p[0], p[1], p[2]); right.Set(fs, p[0], p[1], p[2]); }
    public override void ProcessStereo(Span<float> l, Span<float> r)
    {
        for (int i = 0; i < l.Length; i++) { l[i] = left.Process(l[i]); r[i] = right.Process(r[i]); }
    }
    public override void Snap() { left.Snap(); right.Snap(); }
}

internal sealed class ReverbBlock : Block
{
    private static readonly string[] N = { "size", "damp", "mix" };
    private static readonly float[] D = { 0.45f, 0.5f, 0.15f };
    private readonly Reverb reverb = new();
    public override string Type => "reverb";
    public override bool Stereo => true;
    protected override string[] Names => N;
    protected override float[] Defaults => D;
    protected override void OnPrepare(int maxBlock) => reverb.Prepare(fs);
    protected override void Configure() => reverb.Set(p[0], p[1], p[2]);
    public override void ProcessStereo(Span<float> l, Span<float> r)
    {
        for (int i = 0; i < l.Length; i++)
        {
            reverb.Wet((l[i] + r[i]) * 0.5f, out float wl, out float wr);
            l[i] += wl;
            r[i] += wr;
        }
    }
    public override void Snap() => reverb.Snap();
}

/// <summary>Вся цепочка: моно с гитары → блоки по порядку → стерео на выход.</summary>
internal sealed class Chain
{
    private Block[] blocks = [];
    private float[] bufL = new float[4096], bufR = new float[4096];
    private float fs = 48000, inGain = 1, outGain, smooth = 0.002f;
    private int maxBlock = 4096;

    // общие уровни (не часть пресета): задаёт поток интерфейса
    public volatile float InGainDb;
    public volatile float OutLevelDb = -6;
    public volatile bool Mute;
    /// <summary>Обход всей цепочки: слышно сухой сигнал (сравнить с обработанным).</summary>
    public volatile bool Bypass;

    public float SampleRate => fs;
    public int MaxBlock => maxBlock;
    public Block[] Blocks => Volatile.Read(ref blocks);

    public void Prepare(float sampleRate, int maxBlockSize)
    {
        fs = sampleRate;
        maxBlock = maxBlockSize;
        if (bufL.Length < maxBlock) { bufL = new float[maxBlock]; bufR = new float[maxBlock]; }
        smooth = 1f - MathF.Exp(-1f / (0.015f * fs));
        inGain = DspMath.Db(InGainDb);
        outGain = 0; // плавное включение без щелчка
        foreach (Block b in Blocks) b.Prepare(fs, maxBlock);
    }

    public void SetBlocks(Block[] next) => Volatile.Write(ref blocks, next);

    /// <param name="input">моно-вход; на выходе в нём остаётся сигнал после входной громкости (для анализа)</param>
    public void Process(Span<float> input, Span<float> outL, Span<float> outR)
    {
        int n = input.Length;
        Span<float> l = bufL.AsSpan(0, n), r = bufR.AsSpan(0, n);
        float inTarget = DspMath.Db(InGainDb);
        for (int i = 0; i < n; i++)
        {
            inGain += (inTarget - inGain) * smooth;
            float v = input[i] * inGain;
            input[i] = v;
            l[i] = v;
        }

        Block[] chain = Volatile.Read(ref blocks);
        bool stereo = false, bypass = Bypass;
        for (int k = 0; k < chain.Length; k++)
        {
            Block b = chain[k];
            b.Sync();
            if (!b.On || bypass) continue;
            if (b.Stereo)
            {
                if (!stereo) l.CopyTo(r);
                b.ProcessStereo(l, r);
                stereo = true;
            }
            else
            {
                // моно-блок после стерео-эффекта сводит сигнал в моно — как настоящий усилитель после ревера
                if (stereo)
                {
                    for (int i = 0; i < n; i++) l[i] = (l[i] + r[i]) * 0.5f;
                    stereo = false;
                }
                b.ProcessMono(l);
            }
        }

        float outTarget = Mute ? 0f : DspMath.Db(OutLevelDb);
        for (int i = 0; i < n; i++)
        {
            outGain += (outTarget - outGain) * smooth;
            outL[i] = l[i] * outGain;
            outR[i] = (stereo ? r[i] : l[i]) * outGain;
        }
        for (int k = 0; k < chain.Length; k++) chain[k].Snap();
    }

    /// <summary>
    /// Прогоняет по одному экземпляру каждого встроенного блока, чтобы JIT скомпилировал их заранее,
    /// а не в аудиопотоке при первом добавлении блока в цепочку.
    /// </summary>
    public static void WarmTypes(float sampleRate)
    {
        Span<float> l = stackalloc float[128], r = stackalloc float[128];
        foreach (string type in Block.AllTypes)
        {
            Block b = Block.Create(type)!;
            b.Prepare(sampleRate, 128);
            for (int pass = 0; pass < 3; pass++)
            {
                for (int i = 0; i < l.Length; i++) l[i] = r[i] = 0.1f * MathF.Sin(i * 0.2f);
                b.Sync();
                if (b.Stereo) b.ProcessStereo(l, r); else b.ProcessMono(l);
                b.Snap();
            }
        }
    }
}
