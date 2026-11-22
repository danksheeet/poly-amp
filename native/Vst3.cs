// Плагины VST3 в цепочке. Сам хост — vst3host.dll (C++, официальный VST3 SDK, см. vst3host/vst3host.cpp).
// Здесь: мост к нему, блок цепочки, сохранение состояния плагинов, поиск установленных плагинов
// (по moduleinfo.json, а у кого его нет — в отдельном процессе, чтобы сбой плагина не уронил приложение)
// и окно плагина.
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

namespace Lad;

/// <summary>Где лежат наши нативные библиотеки (папка lib рядом с exe). Резолвер у сборки один на все.</summary>
internal static class NativeLibs
{
    private static string? namPath;
    private static int done;

    public static void Init(string? nam = null)
    {
        if (nam != null) namPath = nam;
        if (Interlocked.Exchange(ref done, 1) == 1) return;
        NativeLibrary.SetDllImportResolver(typeof(NativeLibs).Assembly, (name, _, _) => name switch
        {
            "namcore" => namPath != null && NativeLibrary.TryLoad(namPath, out IntPtr a) ? a : IntPtr.Zero,
            "vst3host" => NativeLibrary.TryLoad(Vst3Native.LibPath, out IntPtr b) ? b : IntPtr.Zero,
            _ => IntPtr.Zero,
        });
    }
}

internal static unsafe class Vst3Native
{
    private const string Dll = "vst3host";
    public static readonly string LibPath = Path.Combine(AppContext.BaseDirectory, "lib", "vst3host.dll");
    public static bool Available => File.Exists(LibPath);

    static Vst3Native() => NativeLibs.Init();

    [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
    private static extern int vh_scan([MarshalAs(UnmanagedType.LPWStr)] string path, byte* json, int cap);
    [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
    public static extern IntPtr vh_load([MarshalAs(UnmanagedType.LPWStr)] string path, [MarshalAs(UnmanagedType.LPUTF8Str)] string cid, byte* err, int errCap);
    [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
    public static extern int vh_setup(IntPtr h, double sampleRate, int maxBlock);
    [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
    public static extern int vh_process(IntPtr h, float* l, float* r, int n);
    [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
    public static extern int vh_take_dirty(IntPtr h);
    [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
    public static extern int vh_get_state(IntPtr h, byte* buf, int cap);
    [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
    public static extern int vh_set_state(IntPtr h, byte* buf, int len);
    [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
    public static extern int vh_open_editor(IntPtr h, IntPtr parent, int* width, int* height, int* canResize);
    [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
    public static extern int vh_editor_resized(IntPtr h, int* width, int* height);
    [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
    public static extern void vh_close_editor(IntPtr h);
    [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
    public static extern void vh_unload(IntPtr h);
    [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
    public static extern int vh_latency(IntPtr h);

    /// <summary>Классы эффектов модуля (JSON). Загружает плагин — только в процессе-сканере.</summary>
    public static string Scan(string path)
    {
        var buf = new byte[1 << 20];
        fixed (byte* p = buf)
        {
            int n = vh_scan(path, p, buf.Length);
            return Encoding.UTF8.GetString(buf, 0, Math.Clamp(n, 0, buf.Length - 1));
        }
    }

    public static string? Load(string path, string cid, out IntPtr handle)
    {
        byte* err = stackalloc byte[1024];
        err[0] = 0;
        handle = vh_load(path, cid, err, 1024);
        if (handle != IntPtr.Zero) return null;
        string e = Marshal.PtrToStringUTF8((IntPtr)err) ?? "";
        // текст ошибки Windows из SDK приходит в кодировке системы — показываем свой
        if (e.StartsWith("LoadLibrary", StringComparison.Ordinal))
            return "Windows couldn't load the plugin file — it may be 32-bit, damaged or need a missing runtime.";
        return e.Length > 0 ? e : "Couldn't load the plugin.";
    }
}

/// <summary>Блок цепочки с плагином VST3. Плагин всегда стерео: моно-гитара идёт на оба его входа.</summary>
internal sealed unsafe class Vst3Block : Block
{
    private static readonly string[] N = [];
    private static readonly float[] D = [];
    public override string Type => "vst3";
    public override bool Stereo => true;
    protected override string[] Names => N;
    protected override float[] Defaults => D;
    public override string? FileKind => "vst3";

    private IntPtr handle;
    private int maxBlock = 512;
    private volatile bool crashed;
    public string? Cid;
    public string? PluginName, Vendor;
    public bool CrashReported;

    public IntPtr Handle => handle;
    public bool Crashed => crashed;

    protected override void OnPrepare(int maxBlock)
    {
        this.maxBlock = maxBlock;
        if (handle != IntPtr.Zero && Vst3Native.vh_setup(handle, fs, maxBlock) != 0)
            Error = "The plugin refused the new audio settings.";
    }

    protected override void Configure() { }

    /// <summary>Поток интерфейса: загрузить плагин и вернуть ему сохранённое состояние.</summary>
    public void Load(string? path, string? cid)
    {
        RequestedFile = path;
        Cid = cid;
        Error = null;
        if (path == null || string.IsNullOrEmpty(cid)) { Error = "No plugin chosen."; return; }
        if (!Vst3Native.Available) { Error = "The VST3 host library (lib\\vst3host.dll) is missing next to the app."; return; }
        if (!File.Exists(path) && !Directory.Exists(path)) { Error = "Plugin not found — it may have been uninstalled."; return; }
        string? err = Vst3Native.Load(path, cid, out IntPtr h);
        if (err != null) { Error = err; return; }
        if (Vst3Native.vh_setup(h, fs, maxBlock) != 0)
        {
            Vst3Native.vh_unload(h);
            Error = "The plugin refused the audio settings.";
            return;
        }
        if (Vst3State.Load(Id) is { Length: > 0 } state)
            fixed (byte* s = state) Vst3Native.vh_set_state(h, s, state.Length);
        Vst3Native.vh_take_dirty(h);
        handle = h;
        FilePath = path;
    }

    public override void ProcessStereo(Span<float> l, Span<float> r)
    {
        IntPtr h = handle;
        if (h == IntPtr.Zero || crashed) return;
        fixed (float* pl = l, pr = r)
            if (Vst3Native.vh_process(h, pl, pr, l.Length) < 0) crashed = true;
    }

    public bool TakeDirty() => handle != IntPtr.Zero && Vst3Native.vh_take_dirty(handle) != 0;

    public void SaveState()
    {
        if (handle == IntPtr.Zero) return;
        int n = Vst3Native.vh_get_state(handle, null, 0);
        if (n <= 0) return;
        var b = new byte[n];
        fixed (byte* p = b)
            if (Vst3Native.vh_get_state(handle, p, n) != n) return;
        Vst3State.Save(Id, b);
    }

    /// <summary>Выгрузить плагин. Только когда аудиопоток его уже не вызывает.</summary>
    public void Release()
    {
        IntPtr h = handle;
        if (h == IntPtr.Zero) return;
        handle = IntPtr.Zero;
        FilePath = null;
        Vst3Native.vh_unload(h);
    }

    public override Dictionary<string, object?> Info() => new()
    {
        ["name"] = PluginName,
        ["vendor"] = Vendor,
        ["latency"] = handle != IntPtr.Zero ? Vst3Native.vh_latency(handle) : 0,
        ["crashed"] = crashed,
    };
}

/// <summary>Состояние плагинов (их ручки и пресеты) — файлом на блок в %LOCALAPPDATA%\Lad\vst3.</summary>
internal static class Vst3State
{
    private static string Dir => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Lad", "vst3");

    private static string FileFor(string id)
    {
        var sb = new StringBuilder();
        foreach (char c in id) if (char.IsAsciiLetterOrDigit(c) || c is '-' or '_') sb.Append(c);
        return Path.Combine(Dir, (sb.Length > 0 ? sb.ToString() : "block") + ".state");
    }

    public static void Save(string id, byte[] data)
    {
        try
        {
            Directory.CreateDirectory(Dir);
            string file = FileFor(id), tmp = file + ".tmp";
            File.WriteAllBytes(tmp, data);
            File.Move(tmp, file, true);
        }
        catch { } // не удалось сохранить — плагин просто начнёт с прежнего состояния
    }

    public static byte[]? Load(string id)
    {
        try { string f = FileFor(id); return File.Exists(f) ? File.ReadAllBytes(f) : null; }
        catch { return null; }
    }
}

/// <summary>Установленный эффект VST3: модуль, класс и подписи для браузера.</summary>
internal sealed record Vst3Plugin(string Path, string Cid, string Name, string Vendor, string Sub);

/// <summary>
/// Поиск установленных эффектов VST3. Сведения берём из moduleinfo.json, если он есть; иначе модуль
/// загружается в отдельном процессе (PolyAmp.exe --vst3scan). Итоги — в кэше по дате файла.
/// </summary>
internal static class Vst3Scanner
{
    private sealed class Entry
    {
        public long Stamp { get; set; }
        public List<Vst3Plugin> Classes { get; set; } = [];
        public string? Error { get; set; }
    }

    private static string CacheFile => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Lad", "vst3-cache.json");
    private static readonly JsonSerializerOptions Json = new() { WriteIndented = false };

    /// <summary>Искали ли уже плагины (тогда новые подхватываются сами при запуске).</summary>
    public static bool HasCache => File.Exists(CacheFile);

    public static IEnumerable<string> Folders()
    {
        yield return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonProgramFiles), "VST3");
        yield return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Common", "VST3");
    }

    /// <summary>Модули .vst3 (папки-бандлы и одиночные файлы) во всех стандартных папках.</summary>
    public static List<string> FindModules()
    {
        var found = new List<string>();
        void Walk(string dir, int depth)
        {
            if (depth > 6) return;
            var opts = new EnumerationOptions { IgnoreInaccessible = true, RecurseSubdirectories = false, AttributesToSkip = FileAttributes.System };
            try
            {
                foreach (string d in Directory.EnumerateDirectories(dir, "*", opts))
                {
                    if (d.EndsWith(".vst3", StringComparison.OrdinalIgnoreCase)) found.Add(d);
                    else Walk(d, depth + 1);
                }
                foreach (string f in Directory.EnumerateFiles(dir, "*.vst3", opts))
                    if (f.EndsWith(".vst3", StringComparison.OrdinalIgnoreCase)) found.Add(f);
            }
            catch { }
        }
        foreach (string root in Folders()) if (Directory.Exists(root)) Walk(root, 0);
        return found.Distinct(StringComparer.OrdinalIgnoreCase).OrderBy(p => p, StringComparer.OrdinalIgnoreCase).ToList();
    }

    private static long StampOf(string path)
    {
        try
        {
            if (File.Exists(path)) { var fi = new FileInfo(path); return fi.LastWriteTimeUtc.Ticks ^ fi.Length; }
            string bin = Path.Combine(path, "Contents", "x86_64-win", Path.GetFileName(path));
            if (File.Exists(bin)) { var fi = new FileInfo(bin); return fi.LastWriteTimeUtc.Ticks ^ fi.Length; }
            return Directory.GetLastWriteTimeUtc(path).Ticks;
        }
        catch { return 0; }
    }

    /// <summary>Эффект, а не инструмент: в подкатегориях есть Fx, или хотя бы нет Instrument.</summary>
    public static bool IsEffect(string sub) =>
        sub.Split('|').Any(s => s.Trim().Equals("Fx", StringComparison.OrdinalIgnoreCase))
        || !sub.Contains("Instrument", StringComparison.OrdinalIgnoreCase);

    /// <summary>Классы из moduleinfo.json бандла (без загрузки плагина) или null.</summary>
    public static List<Vst3Plugin>? ReadModuleInfo(string path)
    {
        try
        {
            if (!Directory.Exists(path)) return null;
            string file = Path.Combine(path, "Contents", "Resources", "moduleinfo.json");
            if (!File.Exists(file)) return null;
            using JsonDocument doc = JsonDocument.Parse(File.ReadAllText(file),
                new JsonDocumentOptions { AllowTrailingCommas = true, CommentHandling = JsonCommentHandling.Skip });
            JsonElement root = doc.RootElement;
            string factoryVendor = root.TryGetProperty("Factory Info", out JsonElement fi) && fi.TryGetProperty("Vendor", out JsonElement fv) ? fv.GetString() ?? "" : "";
            var list = new List<Vst3Plugin>();
            if (!root.TryGetProperty("Classes", out JsonElement classes)) return list;
            foreach (JsonElement c in classes.EnumerateArray())
            {
                if (Str(c, "Category") != "Audio Module Class") continue;
                string sub = c.TryGetProperty("Sub Categories", out JsonElement sc) && sc.ValueKind == JsonValueKind.Array
                    ? string.Join("|", sc.EnumerateArray().Select(x => x.GetString() ?? ""))
                    : Str(c, "Sub Categories");
                string vendor = Str(c, "Vendor");
                list.Add(new Vst3Plugin(path, Str(c, "CID"), Str(c, "Name"), vendor.Length > 0 ? vendor : factoryVendor, sub));
            }
            return list;
        }
        catch { return null; }
    }

    private static string Str(JsonElement e, string name) =>
        e.TryGetProperty(name, out JsonElement v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";

    /// <summary>Процесс-сканер: загрузить модуль, записать его классы в JSON и выйти.</summary>
    public static int ScanChild(string path, string outFile)
    {
        string json;
        try { json = Vst3Native.Scan(path); }
        catch (Exception ex) { json = JsonSerializer.Serialize(new { classes = Array.Empty<object>(), error = ex.Message }); }
        File.WriteAllText(outFile, json);
        return 0;
    }

    private static async Task<(List<Vst3Plugin> classes, string? error)> ScanInChildAsync(string path)
    {
        string exe = Environment.ProcessPath ?? Path.Combine(AppContext.BaseDirectory, "PolyAmp.exe");
        string outFile = Path.Combine(Path.GetTempPath(), "polyamp-vst3scan-" + Guid.NewGuid().ToString("N") + ".json");
        try
        {
            var psi = new ProcessStartInfo(exe) { UseShellExecute = false, CreateNoWindow = true };
            psi.ArgumentList.Add("--vst3scan");
            psi.ArgumentList.Add(path);
            psi.ArgumentList.Add(outFile);
            using Process? proc = Process.Start(psi);
            if (proc == null) return ([], "Couldn't start the plugin scanner.");
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(30));
            try { await proc.WaitForExitAsync(cts.Token); }
            catch (OperationCanceledException)
            {
                try { proc.Kill(true); } catch { }
                return ([], "The plugin took too long to load.");
            }
            if (!File.Exists(outFile)) return ([], "The plugin crashed while loading.");
            using JsonDocument doc = JsonDocument.Parse(await File.ReadAllTextAsync(outFile));
            JsonElement root = doc.RootElement;
            string? error = root.TryGetProperty("error", out JsonElement e) && e.ValueKind == JsonValueKind.String ? e.GetString() : null;
            var list = new List<Vst3Plugin>();
            if (root.TryGetProperty("classes", out JsonElement cl))
                foreach (JsonElement c in cl.EnumerateArray())
                    list.Add(new Vst3Plugin(path, Str(c, "cid"), Str(c, "name"), Str(c, "vendor"), Str(c, "sub")));
            return (list, error);
        }
        catch (Exception ex) { return ([], ex.Message); }
        finally { try { File.Delete(outFile); } catch { } }
    }

    private static Dictionary<string, Entry> ReadCache()
    {
        try
        {
            return File.Exists(CacheFile)
                ? JsonSerializer.Deserialize<Dictionary<string, Entry>>(File.ReadAllText(CacheFile)) ?? new()
                : new();
        }
        catch { return new(); }
    }

    private static void WriteCache(Dictionary<string, Entry> cache)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(CacheFile)!);
            File.WriteAllText(CacheFile, JsonSerializer.Serialize(cache, Json));
        }
        catch { }
    }

    /// <summary>
    /// Найти эффекты. force — пересканировать всё, иначе загружаются только новые и изменившиеся модули.
    /// progress получает (сделано, всего, имя модуля).
    /// </summary>
    public static async Task<(List<Vst3Plugin> plugins, List<string> failed)> ScanAsync(bool force, Action<int, int, string>? progress)
    {
        List<string> modules = await Task.Run(FindModules);
        Dictionary<string, Entry> cache = force ? new() : ReadCache();
        var next = new Dictionary<string, Entry>(StringComparer.OrdinalIgnoreCase);
        var todo = new List<(string path, long stamp)>();
        foreach (string m in modules)
        {
            long stamp = StampOf(m);
            if (cache.TryGetValue(m, out Entry? e) && e.Stamp == stamp) next[m] = e;
            else if (ReadModuleInfo(m) is { } info) next[m] = new Entry { Stamp = stamp, Classes = info };
            else todo.Add((m, stamp));
        }
        int done = 0;
        using var gate = new SemaphoreSlim(3); // три плагина за раз: быстрее, но без лавины процессов
        var lockObj = new object();
        await Task.WhenAll(todo.Select(async t =>
        {
            await gate.WaitAsync();
            try
            {
                progress?.Invoke(done, todo.Count, Path.GetFileNameWithoutExtension(t.path));
                var (classes, error) = await ScanInChildAsync(t.path);
                lock (lockObj) next[t.path] = new Entry { Stamp = t.stamp, Classes = classes, Error = classes.Count == 0 ? error : null };
            }
            finally
            {
                Interlocked.Increment(ref done);
                gate.Release();
            }
        }));
        WriteCache(next);
        var plugins = next.Values.SelectMany(e => e.Classes)
            .Where(p => p.Cid.Length > 0 && IsEffect(p.Sub))
            .OrderBy(p => p.Name, StringComparer.OrdinalIgnoreCase).ToList();
        var failed = next.Where(kv => kv.Value.Error != null).Select(kv => Path.GetFileNameWithoutExtension(kv.Key)).ToList();
        return (plugins, failed);
    }
}

/// <summary>Окно плагина: отдельное окно приложения, внутри — интерфейс самого плагина.</summary>
internal sealed unsafe class PluginWindow : Form
{
    private readonly Vst3Block block;
    private bool opened;

    public string BlockId => block.Id;
    public Vst3Block Block => block;
    public event Action<PluginWindow>? Closed2;

    public PluginWindow(Vst3Block block)
    {
        this.block = block;
        Text = $"{(string.IsNullOrEmpty(block.PluginName) ? "Plugin" : block.PluginName)} — Poly Amp";
        Icon = AppIcon.Get();
        FormBorderStyle = FormBorderStyle.FixedSingle;
        MaximizeBox = false;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.CenterParent;
        BackColor = Color.FromArgb(17, 18, 24);
        AutoScaleMode = AutoScaleMode.None;
        ClientSize = new Size(640, 400);
    }

    /// <summary>Открыть интерфейс плагина в окне. null — получилось, иначе причина.</summary>
    public string? Attach()
    {
        int w = 0, h = 0, canResize = 0;
        int rc = Vst3Native.vh_open_editor(block.Handle, Handle, &w, &h, &canResize);
        if (rc != 0) return rc == -2 || rc == -3 ? "This plugin has no window of its own." : "The plugin window couldn't be opened.";
        opened = true;
        if (canResize != 0)
        {
            FormBorderStyle = FormBorderStyle.Sizable;
            MaximizeBox = true;
        }
        if (w > 0 && h > 0) ClientSize = new Size(w, h); // хост уже подогнал окно; это — на случай, если не вышло
        return null;
    }

    protected override void OnResizeEnd(EventArgs e)
    {
        base.OnResizeEnd(e);
        if (!opened || FormBorderStyle != FormBorderStyle.Sizable) return;
        int w = ClientSize.Width, h = ClientSize.Height;
        if (Vst3Native.vh_editor_resized(block.Handle, &w, &h) == 0 && (w != ClientSize.Width || h != ClientSize.Height) && w > 0 && h > 0)
            ClientSize = new Size(w, h);
    }

    protected override void OnFormClosed(FormClosedEventArgs e)
    {
        if (opened)
        {
            Vst3Native.vh_close_editor(block.Handle);
            opened = false;
        }
        block.SaveState();
        Closed2?.Invoke(this);
        base.OnFormClosed(e);
    }
}
