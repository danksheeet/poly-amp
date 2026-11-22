// ASIO-хост: открывает драйвер, в его колбэке гоняет сигнал гитары через цепочку эффектов.
using System.Diagnostics;
using System.Globalization;
using System.Text;
using NAudio.Wave.Asio;

namespace Lad;

internal sealed record AudioInfo(
    string Driver, int SampleRate, int BufferSize, int InputLatency, int OutputLatency,
    string[] Inputs, string[] Outputs, int[] Rates, int InputChannel, int OutputChannel, string SampleType);

internal sealed class AudioEngine : IDisposable
{
    private static readonly int[] KnownRates = { 44100, 48000, 88200, 96000, 176400, 192000 };

    private AsioDriverExt? driver;
    private AsioSampleType inType, outType;
    private int bufferSize, outChannels;
    private float sampleRate = 48000;

    private readonly Chain chain = new();
    private readonly Synth synth = new();
    private Analyzer? analyzer;

    private float[] mono = Array.Empty<float>(), ana = Array.Empty<float>();
    private float[] outL = Array.Empty<float>(), outR = Array.Empty<float>(), aux = Array.Empty<float>();

    private readonly Dictionary<string, Block> blocksById = new();
    private volatile float synthLevel = 0.8f; // громкость нот-подсказок и метронома
    private volatile float masterDb; // общая громкость всего, что звучит на выходе: гитары, метронома, нот
    private volatile bool masterMute;
    private float masterGain = 1f, masterSmooth = 0.003f;

    private float inPeak, outPeak, cpu;
    private int lastBeatSeq;
    private bool chromaEnabled;
    private volatile bool faulted;
    private long acceptResetsAt = long.MaxValue;

    public long Callbacks;
    public double MaxCallbackMs;
    public string? Fault { get; private set; }

    /// <summary>JSON-сообщения для интерфейса (кадры анализа, доли метронома). Приходят из фонового потока.</summary>
    public event Action<string>? Message;
    /// <summary>Драйвер попросил переоткрыть его (сменили буфер или частоту в панели). Фоновый поток.</summary>
    public event Action? ResetRequested;

    public AudioInfo? Info { get; private set; }
    public Synth Synth => synth;
    public bool Bypass { get => chain.Bypass; set => chain.Bypass = value; }
    public Analyzer? Analyzer => analyzer;
    public bool IsOpen => driver != null;

    public static string[] Drivers()
    {
        try { return AsioDriver.GetAsioDriverNames(); }
        catch { return Array.Empty<string>(); }
    }

    /// <summary>Открыть драйвер. Вызывать из STA-потока (потока окна).</summary>
    public AudioInfo Open(string name, int inChannel, int outChannel, int wantedRate)
    {
        Close();
        AsioDriverExt? ext = null;
        try
        {
            ext = new AsioDriverExt(AsioDriver.GetAsioDriverByName(name));
            var caps = ext.Capabilities;
            if (caps.NbInputChannels < 1) throw new InvalidOperationException("The driver has no inputs.");
            if (caps.NbOutputChannels < 1) throw new InvalidOperationException("The driver has no outputs.");

            int[] rates = KnownRates.Where(r => SafeSupports(ext, r)).ToArray();
            // 0 — частоту не выбирали: берём 48 кГц, на неё рассчитаны модели NAM (у встроенных карт и
            // ASIO4ALL по умолчанию часто 44,1). −1 — оставить как есть (переоткрытие после сброса драйвера).
            if (wantedRate == 0 && rates.Contains(48000)) wantedRate = 48000;
            if (wantedRate > 0 && rates.Contains(wantedRate) && (int)Math.Round(caps.SampleRate) != wantedRate)
                ext.SetSampleRate(wantedRate);
            int sr = (int)Math.Round(ext.Driver.GetSampleRate());

            inChannel = Math.Clamp(inChannel, 0, caps.NbInputChannels - 1);
            outChannels = Math.Min(2, caps.NbOutputChannels);
            outChannel = Math.Clamp(outChannel, 0, caps.NbOutputChannels - outChannels);
            inType = caps.InputChannelInfos[inChannel].type;
            outType = caps.OutputChannelInfos[outChannel].type;
            if (!Supported(inType) || !Supported(outType))
                throw new NotSupportedException($"The driver's sample format isn't supported ({inType}/{outType}).");

            ext.FillBufferCallback = OnBuffer;
            // NAudio дёргает этот колбэк и тогда, когда драйвер при запуске всего лишь спрашивает,
            // поддерживает ли хост сброс. Настоящие запросы (сменили буфер в панели) приходят позже,
            // поэтому первые секунды после открытия их игнорируем — иначе бесконечное переоткрытие.
            acceptResetsAt = long.MaxValue;
            ext.ResetRequestCallback = () =>
            {
                if (Stopwatch.GetTimestamp() >= Volatile.Read(ref acceptResetsAt)) ResetRequested?.Invoke();
            };
            bufferSize = ext.CreateBuffers(outChannels, 1, false);
            ext.SetChannelOffset(outChannel, inChannel);
            ext.Driver.GetLatencies(out int inLat, out int outLat);

            sampleRate = sr;
            masterSmooth = 1f - MathF.Exp(-1f / (0.015f * sr)); // мастер меняется плавно, без щелчков
            mono = new float[bufferSize]; ana = new float[bufferSize];
            outL = new float[bufferSize]; outR = new float[bufferSize]; aux = new float[bufferSize];
            chain.Prepare(sampleRate, bufferSize);
            synth.Prepare(sampleRate);
            ReloadImpulses(); // импульсы пересчитываются под частоту драйвера
            analyzer = new Analyzer(sampleRate) { ChromaEnabled = chromaEnabled, Post = OnFrame, Extra = AppendMeters };
            faulted = false; Fault = null;
            Warmup();

            Info = new AudioInfo(name, sr, bufferSize, inLat, outLat,
                caps.InputChannelInfos.Select(c => c.name).ToArray(),
                caps.OutputChannelInfos.Select(c => c.name).ToArray(),
                rates, inChannel, outChannel, inType.ToString());

            driver = ext;
            ext.Start();
            Volatile.Write(ref acceptResetsAt, Stopwatch.GetTimestamp() + 2 * Stopwatch.Frequency);
            return Info;
        }
        catch
        {
            driver = null;
            analyzer?.Dispose(); analyzer = null;
            try { ext?.ReleaseDriver(); } catch { }
            Info = null;
            throw;
        }
    }

    /// <summary>
    /// Прогоняет колбэк вхолостую по всем веткам обработки, чтобы JIT скомпилировал их заранее,
    /// а не в первом настоящем колбэке (иначе на старте и при первом включении эффекта — щелчок).
    /// </summary>
    private unsafe void Warmup()
    {
        int bytes = bufferSize * 8; // с запасом под самый широкий формат (Float64)
        IntPtr inBuf = System.Runtime.InteropServices.Marshal.AllocHGlobal(bytes);
        IntPtr o1 = System.Runtime.InteropServices.Marshal.AllocHGlobal(bytes);
        IntPtr o2 = System.Runtime.InteropServices.Marshal.AllocHGlobal(bytes);
        try
        {
            new Span<byte>((void*)inBuf, bytes).Clear();
            IntPtr[] ins = { inBuf };
            IntPtr[] outs = outChannels > 1 ? new[] { o1, o2 } : new[] { o1 };
            Chain.WarmTypes(sampleRate);
            bool metro = synth.MetroOn;
            synth.MetroOn = true;
            synth.Play(60, 0.2f, 0, true);
            for (int i = 0; i < 80; i++) OnBuffer(ins, outs);
            synth.MetroOn = metro;
            chain.Prepare(sampleRate, bufferSize);
            synth.Prepare(sampleRate);
            inPeak = outPeak = cpu = 0;
            Callbacks = 0; MaxCallbackMs = 0;
        }
        finally
        {
            System.Runtime.InteropServices.Marshal.FreeHGlobal(inBuf);
            System.Runtime.InteropServices.Marshal.FreeHGlobal(o1);
            System.Runtime.InteropServices.Marshal.FreeHGlobal(o2);
        }
    }

    private static bool SafeSupports(AsioDriverExt ext, int rate)
    {
        try { return ext.IsSampleRateSupported(rate); } catch { return false; }
    }

    /// <summary>Форматы сэмплов драйверов ASIO под Windows (все варианты с младшим байтом вперёд).</summary>
    internal static readonly AsioSampleType[] SupportedTypes =
    [
        AsioSampleType.Int16LSB, AsioSampleType.Int24LSB, AsioSampleType.Int32LSB, AsioSampleType.Float32LSB, AsioSampleType.Float64LSB,
        AsioSampleType.Int32LSB16, AsioSampleType.Int32LSB18, AsioSampleType.Int32LSB20, AsioSampleType.Int32LSB24,
    ];

    private static bool Supported(AsioSampleType t) => SupportedTypes.Contains(t);

    public void Close()
    {
        var d = driver;
        driver = null;
        if (d != null)
        {
            try { d.Stop(); } catch { }
            try { d.ReleaseDriver(); } catch { }
        }
        analyzer?.Dispose();
        analyzer = null;
        Info = null;
    }

    public void ShowControlPanel()
    {
        try { driver?.ShowControlPanel(); } catch { }
    }

    // ---------- цепочка блоков ----------

    /// <summary>Описание блока, как его присылает интерфейс.</summary>
    public sealed record BlockSpec(string Id, string Type, bool On, string? File, Dictionary<string, float> Params, double Size);

    /// <summary>Частота, на которой сейчас идёт обработка (48 кГц, пока драйвер не открыт).</summary>
    public float SampleRate => sampleRate;

    /// <summary>Общие уровни, которые не входят в пресет.</summary>
    public void SetGlobal(string name, float value)
    {
        switch (name)
        {
            case "in.gain": chain.InGainDb = value; break;
            case "out.level": chain.OutLevelDb = value; break;
            case "out.mute": chain.Mute = value > 0.5f; break;
            case "synth.level": synthLevel = Math.Clamp(value, 0f, 1f); break;
            case "master.level": masterDb = Math.Clamp(value, -60f, 6f); break;
            case "master.mute": masterMute = value > 0.5f; break;
        }
    }

    /// <summary>
    /// Применить цепочку из интерфейса. Блоки с прежним id сохраняют состояние (хвосты ревера, модель),
    /// новые создаются и готовятся здесь же, в потоке интерфейса; аудиопоток получает готовый массив.
    /// </summary>
    public List<Block> ApplyChain(IReadOnlyList<BlockSpec> specs)
    {
        var next = new List<Block>();
        foreach (BlockSpec spec in specs)
        {
            if (!blocksById.TryGetValue(spec.Id, out Block? b) || b.Type != spec.Type)
            {
                b = Block.Create(spec.Type);
                if (b == null) continue;
                b.Id = spec.Id;
                b.Prepare(sampleRate, chain.MaxBlock);
                blocksById[spec.Id] = b;
            }
            foreach (var kv in spec.Params) b.SetParam(kv.Key, kv.Value);
            b.On = spec.On;
            if (b.FileKind != null)
            {
                b.SetSize(spec.Size);
                if (spec.File != b.RequestedFile) LoadBlockFile(b, spec.File);
            }
            next.Add(b);
        }
        foreach (string id in blocksById.Keys.Except(next.Select(b => b.Id)).ToList()) blocksById.Remove(id);
        chain.SetBlocks(next.ToArray());
        return next;
    }

    public Block? GetBlock(string id) => blocksById.GetValueOrDefault(id);
    public IReadOnlyCollection<Block> Blocks => blocksById.Values;

    private static void LoadBlockFile(Block b, string? path)
    {
        b.RequestedFile = path;
        b.Error = null;
        if (path == null) { b.Unload(); return; }
        try
        {
            if (!File.Exists(path)) throw new IrException("File not found.");
            b.LoadFile(path);
        }
        catch (Exception ex)
        {
            b.Unload();
            b.Error = ex is NamException or IrException ? ex.Message : "Couldn't read the file: " + ex.Message;

        }
    }

    /// <summary>После смены частоты драйвера импульсы нужно пересчитать под неё.</summary>
    private void ReloadImpulses()
    {
        foreach (Block b in blocksById.Values)
            if (b.FileKind == "ir" && b.RequestedFile != null) LoadBlockFile(b, b.RequestedFile);
    }

    public void SetChromaEnabled(bool on)
    {
        chromaEnabled = on;
        if (analyzer != null) analyzer.ChromaEnabled = on;
    }

    // ---------- аудиопоток ----------

    private unsafe void OnBuffer(IntPtr[] inputs, IntPtr[] outputs)
    {
        long t0 = Stopwatch.GetTimestamp();
        int n = bufferSize;
        try
        {
            FlushDenormals();
            if (faulted) { Silence(outputs, n); return; }

            ReadInput(inputs[0], mono, n);
            chain.Process(mono.AsSpan(0, n), outL.AsSpan(0, n), outR.AsSpan(0, n));

            // синтезатор слышен и на выходе, и приложению (чтобы тренажёры работали без гитары)
            Span<float> s = aux.AsSpan(0, n);
            s.Clear();
            synth.Mix(s);
            float ip = 0;
            for (int i = 0; i < n; i++)
            {
                float a = MathF.Abs(mono[i]);
                if (a > ip) ip = a;
                ana[i] = mono[i] + s[i];
            }
            analyzer?.Write(ana.AsSpan(0, n));
            synth.MixClicks(s);

            float op = 0;
            float sg = synthLevel;
            // мастер — после сложения гитары и метронома, но до ограничителя: громче +0 дБ не хрипит, а мягко упирается
            float mt = masterMute ? 0f : DspMath.Db(masterDb);
            float mg = masterGain, mk = masterSmooth;
            for (int i = 0; i < n; i++)
            {
                mg += (mt - mg) * mk;
                float l = DspMath.SoftLimit((outL[i] + s[i] * sg) * mg);
                float r = DspMath.SoftLimit((outR[i] + s[i] * sg) * mg);
                outL[i] = l; outR[i] = r;
                float a = MathF.Max(MathF.Abs(l), MathF.Abs(r));
                if (a > op) op = a;
            }
            masterGain = mg;
            if (ip > inPeak) inPeak = ip;
            if (op > outPeak) outPeak = op;

            WriteOutput(outputs[0], outL, n);
            if (outChannels > 1) WriteOutput(outputs[1], outR, n);
        }
        catch (Exception ex)
        {
            faulted = true;
            Fault = ex.ToString();
            try { Silence(outputs, n); } catch { }
        }

        double ms = Stopwatch.GetElapsedTime(t0).TotalMilliseconds;
        if (ms > MaxCallbackMs) MaxCallbackMs = ms;
        float load = (float)(ms / (n * 1000.0 / sampleRate));
        cpu = load > cpu ? load : cpu * 0.98f + load * 0.02f;
        Callbacks++;
    }

    // Сверхмалые числа (денормалы) в хвостах фильтров и нейросети считаются в десятки раз медленнее.
    // Велим процессору в этом потоке округлять их до нуля — так делают все аудиохосты.
    [System.Runtime.InteropServices.DllImport("ucrtbase.dll", CallingConvention = System.Runtime.InteropServices.CallingConvention.Cdecl)]
    [System.Runtime.InteropServices.SuppressGCTransition]
    private static extern unsafe int _controlfp_s(uint* current, uint newControl, uint mask);

    private static unsafe void FlushDenormals()
    {
        uint current;
        _controlfp_s(&current, 0x01000000 /* _DN_FLUSH */, 0x03000000 /* _MCW_DN */);
    }

    private void ReadInput(IntPtr src, float[] dst, int n) => ReadSamples(inType, src, dst, n);
    private void WriteOutput(IntPtr dst, float[] src, int n) => WriteSamples(outType, dst, src, n);

    /// <summary>Сколько байт занимает один сэмпл в буфере драйвера.</summary>
    internal static int BytesPerSample(AsioSampleType t) => t switch
    {
        AsioSampleType.Int16LSB => 2,
        AsioSampleType.Int24LSB => 3,
        AsioSampleType.Float64LSB => 8,
        _ => 4,
    };

    /// <summary>Множитель для целых форматов: Int32LSB16…24 — значащие биты в младших разрядах 32-битного слова.</summary>
    private static double IntScale(AsioSampleType t) => t switch
    {
        AsioSampleType.Int16LSB or AsioSampleType.Int32LSB16 => 32768.0,
        AsioSampleType.Int32LSB18 => 131072.0,
        AsioSampleType.Int32LSB20 => 524288.0,
        AsioSampleType.Int24LSB or AsioSampleType.Int32LSB24 => 8388608.0,
        _ => 2147483648.0,
    };

    internal static unsafe void ReadSamples(AsioSampleType type, IntPtr src, float[] dst, int n)
    {
        switch (type)
        {
            case AsioSampleType.Float32LSB:
                { float* p = (float*)src; for (int i = 0; i < n; i++) dst[i] = p[i]; break; }
            case AsioSampleType.Float64LSB:
                { double* p = (double*)src; for (int i = 0; i < n; i++) dst[i] = (float)p[i]; break; }
            case AsioSampleType.Int16LSB:
                { short* p = (short*)src; for (int i = 0; i < n; i++) dst[i] = p[i] * (1f / 32768f); break; }
            case AsioSampleType.Int24LSB:
                {
                    byte* p = (byte*)src;
                    for (int i = 0; i < n; i++, p += 3)
                        dst[i] = ((p[0] | (p[1] << 8) | ((sbyte)p[2] << 16)) * (1f / 8388608f));
                    break;
                }
            default: // Int32LSB и Int32LSB16/18/20/24
                {
                    float k = (float)(1.0 / IntScale(type));
                    int* p = (int*)src;
                    for (int i = 0; i < n; i++) dst[i] = p[i] * k;
                    break;
                }
        }
    }

    internal static unsafe void WriteSamples(AsioSampleType type, IntPtr dst, float[] src, int n)
    {
        switch (type)
        {
            case AsioSampleType.Float32LSB:
                { float* p = (float*)dst; for (int i = 0; i < n; i++) p[i] = Math.Clamp(src[i], -1f, 1f); break; }
            case AsioSampleType.Float64LSB:
                { double* p = (double*)dst; for (int i = 0; i < n; i++) p[i] = Math.Clamp(src[i], -1f, 1f); break; }
            case AsioSampleType.Int16LSB:
                {
                    short* p = (short*)dst;
                    for (int i = 0; i < n; i++) p[i] = (short)(Math.Clamp(src[i], -1f, 0.99997f) * 32768f);
                    break;
                }
            case AsioSampleType.Int24LSB:
                {
                    byte* p = (byte*)dst;
                    for (int i = 0; i < n; i++, p += 3)
                    {
                        int v = (int)(Math.Clamp(src[i], -1f, 0.9999999f) * 8388608f);
                        p[0] = (byte)v; p[1] = (byte)(v >> 8); p[2] = (byte)(v >> 16);
                    }
                    break;
                }
            default: // Int32LSB и Int32LSB16/18/20/24
                {
                    double scale = IntScale(type);
                    double max = (scale - 1) / scale;
                    int* p = (int*)dst;
                    for (int i = 0; i < n; i++) p[i] = (int)(Math.Clamp(src[i], -1.0, max) * scale);
                    break;
                }
        }
    }

    private unsafe void Silence(IntPtr[] outputs, int n)
    {
        int bytes = BytesPerSample(outType) * n;
        for (int c = 0; c < outputs.Length; c++) new Span<byte>((void*)outputs[c], bytes).Clear();
    }

    // ---------- поток анализа ----------

    private void AppendMeters(StringBuilder sb)
    {
        var inv = CultureInfo.InvariantCulture;
        float ip = Interlocked.Exchange(ref inPeak, 0f);
        float op = Interlocked.Exchange(ref outPeak, 0f);
        sb.Append(",\"inPk\":").Append(ip.ToString("0.####", inv));
        sb.Append(",\"outPk\":").Append(op.ToString("0.####", inv));
        sb.Append(",\"cpu\":").Append(cpu.ToString("0.###", inv));
        sb.Append(",\"cb\":").Append(Callbacks);
        if (Fault != null) sb.Append(",\"fault\":").Append(System.Text.Json.JsonSerializer.Serialize(Fault));
    }

    private void OnFrame(string json)
    {
        int seq = Volatile.Read(ref synth.BeatSeq);
        if (seq != lastBeatSeq)
        {
            lastBeatSeq = seq;
            Message?.Invoke($"{{\"t\":\"beat\",\"b\":{seq & 15}}}");
        }
        Message?.Invoke(json);
    }

    public void Dispose() => Close();
}
