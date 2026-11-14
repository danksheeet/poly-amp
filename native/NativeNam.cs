// Мост к официальной библиотеке NeuralAmpModelerCore (namcore.dll, см. namcore/namcore.cpp).
// Библиотека исполняет все архитектуры формата — WaveNet A1 и A2, LSTM, контейнеры из нескольких размеров.
using System.Runtime.InteropServices;

namespace Lad;

internal sealed unsafe class NativeNam : NamModel
{
    private const string Dll = "namcore";
    // Внутренние буферы библиотеки держим маленькими: при 4096 модель A2 считается втрое медленнее,
    // чем при 64 (данные перестают помещаться в кэш). Более длинные блоки обёртка режет на куски сама.
    private const int MaxBlock = 64;

    [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
    private static extern int namcore_version();

    [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
    private static extern IntPtr namcore_create([MarshalAs(UnmanagedType.LPWStr)] string path, int maxBlock, byte* err, int errLen);

    [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
    private static extern void namcore_destroy(IntPtr handle);

    [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
    private static extern void namcore_info(IntPtr handle, double* sampleRate, int* hasLoudness, double* loudness, int* slimmable);

    [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
    private static extern int namcore_set_size(IntPtr handle, double value);

    [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
    private static extern void namcore_process(IntPtr handle, float* input, float* output, int frames);

    // Библиотека собрана в двух вариантах: быстрый с AVX2 (почти все процессоры с 2013–2015 годов)
    // и запасной без него — на старых процессорах вариант с AVX2 упал бы на первой же модели.
    // POLYAMP_NAM=sse2 принудительно включает запасной вариант (для проверки на любом компьютере).
    private static readonly bool useAvx2 =
        System.Runtime.Intrinsics.X86.Avx2.IsSupported && System.Runtime.Intrinsics.X86.Fma.IsSupported
        && !string.Equals(Environment.GetEnvironmentVariable("POLYAMP_NAM"), "sse2", StringComparison.OrdinalIgnoreCase);
    private static readonly string file = useAvx2 ? "namcore.dll" : "namcore-sse2.dll";
    private static readonly bool resolverSet = SetResolver(); // до первого вызова библиотеки
    private static readonly int version = Probe();

    /// <summary>Лежит ли библиотека рядом с приложением (подходящий процессору вариант).</summary>
    public static bool Available => version > 0;
    public static string VersionText => $"{version / 10000}.{version / 100 % 100}.{version % 100}{(useAvx2 ? "" : " (SSE2)")}";

    private static bool SetResolver()
    {
        NativeLibrary.SetDllImportResolver(typeof(NativeNam).Assembly, (name, _, _) =>
            name == Dll && NativeLibrary.TryLoad(Path.Combine(AppContext.BaseDirectory, file), out IntPtr h) ? h : IntPtr.Zero);
        return true;
    }

    private static int Probe()
    {
        // без своего варианта библиотеки не пробуем грузить чужой: вариант с AVX2 на старом процессоре упадёт
        if (!File.Exists(Path.Combine(AppContext.BaseDirectory, file))) return 0;
        try { return namcore_version(); }
        catch (Exception ex) when (ex is DllNotFoundException or EntryPointNotFoundException or BadImageFormatException) { return 0; }
    }

    private IntPtr handle;

    protected override int PrewarmSamples => 0; // библиотека прогревает модель сама при загрузке

    private NativeNam(IntPtr handle) => this.handle = handle;

    public static NativeNam Create(string path, int maxBlock = MaxBlock)
    {
        byte* err = stackalloc byte[512];
        err[0] = 0;
        IntPtr h = namcore_create(path, maxBlock, err, 512);
        if (h == IntPtr.Zero)
        {
            string reason = Marshal.PtrToStringUTF8((IntPtr)err) ?? "";
            throw new NamException("The NAM library couldn't read the model" + (reason.Length > 0 ? ": " + reason : "."));
        }
        var model = new NativeNam(h);
        double rate, loudness;
        int hasLoudness, slimmable;
        namcore_info(h, &rate, &hasLoudness, &loudness, &slimmable);
        model.Info.SampleRate = rate > 0 ? rate : 48000;
        if (hasLoudness != 0) model.Info.Loudness = loudness;
        model.Info.Slimmable = slimmable != 0;
        model.Info.Engine = "NAM library " + VersionText;


        // первый вызов из этого потока: чтобы аудиопоток не тратил время на подготовку вызова
        Span<float> warm = stackalloc float[64];
        warm.Clear();
        model.Process(warm, warm);
        return model;
    }

    /// <summary>Для моделей с несколькими размерами: 1 — самый точный, 0 — самый лёгкий. Не из аудиопотока.</summary>
    public bool SetSize(double value)
    {
        bool ok = namcore_set_size(handle, value) != 0;
        GC.KeepAlive(this);
        return ok;
    }

    public override void Process(ReadOnlySpan<float> input, Span<float> output)
    {
        fixed (float* i = input, o = output) namcore_process(handle, i, o, input.Length);
        GC.KeepAlive(this); // объект (и модель в библиотеке) должен жить до конца вызова
    }

    ~NativeNam()
    {
        IntPtr h = Interlocked.Exchange(ref handle, IntPtr.Zero);
        if (h != IntPtr.Zero) namcore_destroy(h);
    }
}
