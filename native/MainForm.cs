// Окно приложения: интерфейс живёт в WebView2, звук — в AudioEngine. Между ними — JSON-сообщения.
using System.Runtime.InteropServices;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace Lad;

internal sealed class MainForm : Form
{
    private const string Host = "lad.example";
    private readonly WebView2 web = new() { Dock = DockStyle.Fill };
    private readonly AudioEngine engine = new();
    private readonly string? shotPath, shotJs;
    private readonly int shotWait = 1200;
    private (string driver, int inCh, int outCh, int rate)? last;
    private bool closing;
    private CoreWebView2Environment? webEnv;
    private readonly string? t3kTestPath;
    private readonly bool t3kAuthTest; // самопроверка входа для тонов пресета вместо каталога
    private readonly string? ssTestPath; // самопроверка окна Songsterr: сохранение скачанного файла в библиотеку
    private readonly string? ssShotUrl; // вместе с --sstest: открыть эту страницу Songsterr и снять окно

    public MainForm(string[] args)
    {
        Text = "Poly Amp";
        Icon = AppIcon.Get();
        BackColor = Color.FromArgb(17, 18, 24); // фон тёмной темы — без белой вспышки при запуске

        ClientSize = new Size(1320, 880);
        MinimumSize = new Size(980, 680);
        StartPosition = FormStartPosition.CenterScreen;
        web.DefaultBackgroundColor = BackColor;
        Controls.Add(web);

        for (int i = 0; i < args.Length - 1; i++)
        {
            if (args[i] == "--screenshot") shotPath = args[i + 1];
            if (args[i] == "--t3ktest") t3kTestPath = args[i + 1];
            if (args[i] == "--t3kauth") t3kAuthTest = true;
            if (args[i] == "--sstest") ssTestPath = args[i + 1];
            if (args[i] == "--ssshot") ssShotUrl = args[i + 1];
            if (args[i] == "--js") shotJs = args[i + 1].StartsWith('@') ? File.ReadAllText(args[i + 1][1..]) : args[i + 1];
            if (args[i] == "--wait" && int.TryParse(args[i + 1], out int w)) shotWait = w;
            if (args[i] == "--size" && args[i + 1].Split('x') is [var sw, var sh] && int.TryParse(sw, out int cw) && int.TryParse(sh, out int ch))
                ClientSize = new Size(cw, ch);
        }

        engine.Message += Post;
        engine.ResetRequested += () => SafeInvoke(Reopen);
    }

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        // заголовок окна — в цвет фона интерфейса, чтобы окно выглядело цельным (Windows 11)
        int caption = 0x00181211, text = 0x00F5EEEC; // COLORREF: 0x00BBGGRR — #111218 и #ECEEF5
        DwmSetWindowAttribute(Handle, 35, ref caption, sizeof(int));
        DwmSetWindowAttribute(Handle, 36, ref text, sizeof(int));
    }

    protected override async void OnLoad(EventArgs e)
    {
        base.OnLoad(e);
        try
        {
            string data = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Lad", "WebView2");
            webEnv = await CoreWebView2Environment.CreateAsync(null, data);
            await web.EnsureCoreWebView2Async(webEnv);
            var core = web.CoreWebView2;
            core.SetVirtualHostNameToFolderMapping(
                Host, Path.Combine(AppContext.BaseDirectory, "ui"), CoreWebView2HostResourceAccessKind.Allow);
            core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.IsZoomControlEnabled = false;
            core.Settings.AreBrowserAcceleratorKeysEnabled = false;
            core.WebMessageReceived += OnWebMessage;
            if (shotPath != null) core.NavigationCompleted += async (_, _) => await Screenshot();
            if (t3kTestPath != null) core.NavigationCompleted += async (_, _) => await T3kSelfTest();
            if (ssTestPath != null) core.NavigationCompleted += (_, _) => BeginInvoke(SongsterrSelfTest);
            core.Navigate($"https://{Host}/index.html");
        }
        catch (Exception ex)
        {
            // без WebView2 Runtime окно интерфейса не открыть; на Windows 11 он есть всегда, на Windows 10 — почти всегда
            if (MessageBox.Show(this,
                "Couldn't start the interface: Poly Amp needs the Microsoft Edge WebView2 Runtime.\n\n" + ex.Message +
                "\n\nOpen the download page now?",
                "Poly Amp", MessageBoxButtons.YesNo, MessageBoxIcon.Error) == DialogResult.Yes)
                System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo("https://developer.microsoft.com/microsoft-edge/webview2/") { UseShellExecute = true });
            Close();
        }
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        closing = true;
        vst3Timer?.Stop();
        foreach (PluginWindow w in pluginWindows.Values.ToList()) w.Close();
        engine.Dispose();
        engine.ReleaseAllPlugins();
        base.OnFormClosing(e);
    }

    // ---------- интерфейс → движок ----------

    private void OnWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        // Сообщение обрабатываем уже после выхода из обработчика события WebView2. Внутри него нельзя
        // открывать окна и диалоги: пока обработчик не вернулся, WebView2 не доставляет другие события,
        // и второе окно с браузером (TONE3000) остаётся пустым и зависает.
        string json = e.WebMessageAsJson;
        SafeInvoke(() => HandleMessage(json));
    }

    private void HandleMessage(string json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            JsonElement m = doc.RootElement;
            switch (m.GetProperty("t").GetString())
            {
                case "ready":
                    SendDrivers();
                    SendAudio(null);
                    SendBlocks();
                    SendT3kStatus();
                    SendLibrary();
                    SendVst3();
                    // искали плагины раньше — подхватим новые; впервые поиск запускает сам пользователь
                    if (Vst3Scanner.HasCache) _ = Vst3ScanAsync(false);
                    if (vst3Timer == null)
                    {
                        vst3Timer = new System.Windows.Forms.Timer { Interval = 1500 };
                        vst3Timer.Tick += (_, _) => Vst3Tick();
                        vst3Timer.Start();
                    }
                    break;
                case "vst3Scan":
                    _ = Vst3ScanAsync(Int(m, "force") != 0);
                    break;
                case "vst3Editor":
                    OpenPluginWindow(Str(m, "id"));
                    break;
                case "open":
                    Open(m.GetProperty("driver").GetString() ?? "", Int(m, "inCh"), Int(m, "outCh"), Int(m, "rate"));
                    break;
                case "close":
                    last = null;
                    engine.Close();
                    SendAudio(null);
                    break;
                case "panel":
                    engine.ShowControlPanel();
                    break;
                case "global":
                    foreach (JsonProperty p in m.GetProperty("p").EnumerateObject())
                        if (p.Value.ValueKind == JsonValueKind.Number) engine.SetGlobal(p.Name, p.Value.GetSingle());
                    break;
                case "chain":
                    ApplyChain(m);
                    break;
                case "bp":
                    if (engine.GetBlock(Str(m, "id")) is { } paramBlock)
                        foreach (JsonProperty p in m.GetProperty("p").EnumerateObject())
                            if (p.Value.ValueKind == JsonValueKind.Number) paramBlock.SetParam(p.Name, p.Value.GetSingle());
                    break;
                case "bon":
                    if (engine.GetBlock(Str(m, "id")) is { } switchBlock) switchBlock.On = Int(m, "on", 1) != 0;
                    break;
                case "bsize":
                    if (engine.GetBlock(Str(m, "id")) is { } sizeBlock)
                    {
                        sizeBlock.SetSize(Num(m, "v", 1));
                        SendBlock(sizeBlock);
                    }
                    break;
                case "pickFile":
                    {
                        string? file = Str(m, "kind") == "nam"
                            ? PickFile("NAM models (*.nam)|*.nam|All files|*.*", "Choose a NAM model")
                            : PickFile("Impulse responses (*.wav)|*.wav|All files|*.*", "Choose an impulse response");
                        if (file != null) Post(JsonSerializer.Serialize(new { t = "picked", id = Str(m, "id"), path = file }));
                    }
                    break;
                case "note":
                    engine.Synth.Play(Int(m, "midi"), Num(m, "gain", 0.55f), Num(m, "delay", 0), Int(m, "mono", 1) != 0);
                    break;
                case "strum":
                    engine.Synth.StopAll();
                    int k = 0;
                    foreach (JsonElement midi in m.GetProperty("midis").EnumerateArray())
                        engine.Synth.Play(midi.GetInt32(), 0.3f, k++ * 0.028f, false);
                    break;
                case "stop":
                    engine.Synth.StopAll();
                    break;
                case "metro":
                    engine.Synth.Bpm = Num(m, "bpm", 90);
                    engine.Synth.Beats = Int(m, "beats", 4);
                    engine.Synth.MetroOn = Int(m, "on") != 0;
                    break;
                case "t3kStatus":
                    SendT3kStatus();
                    break;
                case "t3kSetKey":
                    Tone3000Client.SaveKey(m.GetProperty("key").GetString() ?? "");
                    SendT3kStatus();
                    break;
                case "t3kSelect":
                    _ = T3kSelectAsync(Str(m, "kind"), Str(m, "arch") is { Length: > 0 } arch ? arch : "2",
                        Str(m, "blockId") is { Length: > 0 } blockId ? blockId : null, t3kTestLog);
                    break;
                case "t3kLoadTone":
                    _ = T3kLoadToneAsync(Int(m, "reqId"), m.GetProperty("toneId").GetInt64(), Str(m, "kind"),
                        Str(m, "match") is { Length: > 0 } match ? match : null, t3kTestLog);
                    break;
                case "library":
                    SendLibrary();
                    break;
                case "t3kDownload":
                    _ = T3kDownloadAsync(m.GetProperty("id").GetInt64());
                    break;
                case "openUrl":
                    // в обычном браузере открываем только страницы TONE3000 и поиск Songsterr
                    if (m.GetProperty("url").GetString() is { } link && (Tone3000Client.IsToneUrl(link) || IsSongsterrUrl(link) || IsHelpUrl(link)))
                        System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(link) { UseShellExecute = true });
                    break;
                case "bypass":
                    engine.Bypass = Int(m, "on") != 0;
                    break;
                case "tabsLib":
                    _ = SendTabsLibrary();
                    break;
                case "tabsLibPick":
                    PickTabsFolder();
                    break;
                case "tabsRead":
                    ReadTab(Int(m, "reqId"), Str(m, "rel"));
                    break;
                case "tabsOpen":
                    OpenTabExternally(Str(m, "rel"));
                    break;
                case "songsterr":
                    _ = OpenSongsterrAsync(Str(m, "url"), Str(m, "q"));
                    break;
                case "chroma":
                    engine.SetChromaEnabled(Int(m, "on") != 0);
                    break;
            }
        }
        catch (Exception ex)
        {
            Post(JsonSerializer.Serialize(new { t = "error", error = ex.Message }));
        }
    }

    /// <summary>Страницы, на которые ведут подсказки приложения: бесплатные драйверы ASIO.</summary>
    private static bool IsHelpUrl(string url) => url is "https://asio4all.org/" or "https://github.com/dechamps/FlexASIO"
        or "https://github.com/danksheeet/poly-amp" or "https://github.com/danksheeet/poly-amp/issues";

    private static bool IsSongsterrUrl(string url) =>
        Uri.TryCreate(url, UriKind.Absolute, out Uri? u) && u.Scheme == Uri.UriSchemeHttps
        && (u.Host == "www.songsterr.com" || u.Host == "songsterr.com");

    private static int Int(JsonElement m, string name, int fallback = 0) =>
        m.TryGetProperty(name, out JsonElement v) && v.ValueKind == JsonValueKind.Number ? (int)Math.Round(v.GetDouble())
        : m.TryGetProperty(name, out v) && v.ValueKind == JsonValueKind.True ? 1 : fallback;

    private static string Str(JsonElement m, string name) =>
        m.TryGetProperty(name, out JsonElement v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";

    private static float Num(JsonElement m, string name, float fallback) =>
        m.TryGetProperty(name, out JsonElement v) && v.ValueKind == JsonValueKind.Number ? v.GetSingle() : fallback;

    private void Open(string driver, int inCh, int outCh, int rate)
    {
        last = (driver, inCh, outCh, rate);
        try
        {
            engine.Open(driver, inCh, outCh, rate);
            SendAudio(null);
            SendBlocks(); // частота могла смениться: обновляем предупреждения и пересчитанные импульсы
        }
        catch (Exception ex)
        {
            // NAudio сообщает о неподключённом устройстве сухим текстом — объясняем, что делать
            string msg = ex.Message.Contains("No device is connected", StringComparison.OrdinalIgnoreCase)
                ? $"{driver}: the device isn't connected. Plug in the interface (and turn it on), or pick another driver."
                : ex is InvalidOperationException or NotSupportedException or ArgumentException
                ? ex.Message
                : "The driver didn't open. Check that the interface is connected and not in use by another program (a DAW).";
            SendAudio($"{msg}");
        }
    }

    /// <summary>Драйвер сообщил, что его настройки изменились (буфер, частота) — открываем заново.</summary>
    private async void Reopen()
    {
        if (reopening || last is not { } s) return;
        reopening = true;
        try
        {
            engine.Close();
            await Task.Delay(500);
            if (!closing) Open(s.driver, s.inCh, s.outCh, -1); // частоту оставляем ту, что выставили в панели драйвера
        }
        finally { reopening = false; }
    }

    private bool reopening;

    // ---------- модели NAM и импульсы ----------

    private string? PickFile(string filter, string title)
    {
        using var dlg = new OpenFileDialog { Filter = filter, Title = title, CheckFileExists = true };
        return dlg.ShowDialog(this) == DialogResult.OK ? dlg.FileName : null;
    }

    // ---------- библиотека табов: папка с файлами Guitar Pro ----------

    private static readonly string[] TabFormats = [".gp", ".gpx", ".gp5", ".gp4", ".gp3", ".musicxml", ".mxl"];
    private static string TabsSettingPath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Lad", "tabs-library.txt");

    private static string? TabsRoot()
    {
        try
        {
            string dir = File.ReadAllText(TabsSettingPath).Trim();
            return dir.Length > 0 && Directory.Exists(dir) ? Path.GetFullPath(dir) : null;
        }
        catch (IOException) { return null; }
    }

    /// <summary>Список табов и PDF в папке библиотеки (со всеми подпапками). Читается в фоне.</summary>
    private async Task SendTabsLibrary()
    {
        string? root = TabsRoot();
        if (root == null)
        {
            Post(JsonSerializer.Serialize(new { t = "tabsLib", dir = (string?)null, items = Array.Empty<object>() }));
            return;
        }
        try
        {
            var items = await Task.Run(() =>
            {
                var list = new List<object>();
                var opts = new EnumerationOptions { RecurseSubdirectories = true, IgnoreInaccessible = true, AttributesToSkip = FileAttributes.Hidden | FileAttributes.System };
                foreach (string f in Directory.EnumerateFiles(root, "*", opts))
                {
                    string name = Path.GetFileName(f);
                    string ext = Path.GetExtension(f).ToLowerInvariant();
                    if (name.StartsWith("._", StringComparison.Ordinal) || !(TabFormats.Contains(ext) || ext == ".pdf")) continue;
                    string rel = Path.GetRelativePath(root, f);
                    if (rel.Split(Path.DirectorySeparatorChar).Any(s => s.StartsWith('.'))) continue; // .git и прочие служебные папки
                    var info = new FileInfo(f);
                    list.Add(new { rel, ext = ext[1..], size = info.Length, mtime = new DateTimeOffset(info.LastWriteTimeUtc).ToUnixTimeMilliseconds() });
                    if (list.Count >= 20000) break;
                }
                return list;
            });
            Post(JsonSerializer.Serialize(new { t = "tabsLib", dir = root, items }));
        }
        catch (Exception ex)
        {
            Post(JsonSerializer.Serialize(new { t = "tabsLib", dir = root, items = Array.Empty<object>(), error = "Couldn't read the folder: " + ex.Message }));
        }
    }

    private void PickTabsFolder()
    {
        using var dlg = new FolderBrowserDialog
        {
            Description = "Folder with Guitar Pro tabs",
            UseDescriptionForTitle = true,
            SelectedPath = TabsRoot() ?? Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments),
        };
        if (dlg.ShowDialog(this) != DialogResult.OK) return;
        Directory.CreateDirectory(Path.GetDirectoryName(TabsSettingPath)!);
        File.WriteAllText(TabsSettingPath, dlg.SelectedPath);
        _ = SendTabsLibrary();
    }

    /// <summary>Путь внутри папки библиотеки или null, если он ведёт наружу.</summary>
    private static string? InsideTabsRoot(string rel)
    {
        string? root = TabsRoot();
        if (root == null || rel.Length == 0) return null;
        string full = Path.GetFullPath(Path.Combine(root, rel));
        return full.StartsWith(root.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) ? full : null;
    }

    /// <summary>Прочитать таб из библиотеки: только форматы табов и только внутри выбранной папки.</summary>
    private void ReadTab(int reqId, string rel)
    {
        void Reply(object payload) => Post(JsonSerializer.Serialize(payload));
        try
        {
            string? full = InsideTabsRoot(rel);
            if (full == null || !TabFormats.Contains(Path.GetExtension(full).ToLowerInvariant()))
            {
                Reply(new { t = "tabsFile", reqId, ok = false, error = "This file can't be opened as a tab." });
                return;
            }
            var info = new FileInfo(full);
            if (!info.Exists) { Reply(new { t = "tabsFile", reqId, ok = false, error = "File not found — it was moved or deleted." }); return; }
            if (info.Length > 32 * 1024 * 1024) { Reply(new { t = "tabsFile", reqId, ok = false, error = "The file is too large." }); return; }
            Reply(new { t = "tabsFile", reqId, ok = true, rel, name = info.Name, data = Convert.ToBase64String(File.ReadAllBytes(full)) });
        }
        catch (Exception ex)
        {
            Reply(new { t = "tabsFile", reqId, ok = false, error = "Couldn't read the file: " + ex.Message });
        }
    }

    /// <summary>PDF-книгу табов открываем в обычном просмотрщике.</summary>
    private void OpenTabExternally(string rel)
    {
        string? full = InsideTabsRoot(rel);
        if (full == null || !File.Exists(full) || Path.GetExtension(full).ToLowerInvariant() != ".pdf") return;
        System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(full) { UseShellExecute = true });
    }

    // ---------- Songsterr: файл Guitar Pro их кнопкой — прямо в библиотеку ----------

    private bool songsterrOpen;

    /// <summary>
    /// Открывает окно Songsterr на песне (по ссылке) или на поиске. Скачанный там файл Guitar Pro
    /// ложится в подпапку «Songsterr» библиотеки; потом библиотека перечитывается и интерфейс открывает песню.
    /// </summary>
    private async Task OpenSongsterrAsync(string url, string query)
    {
        if (webEnv == null || songsterrOpen) return;
        string? root = TabsRoot();
        if (root == null)
        {
            PickTabsFolder(); // без папки библиотеки сохранять некуда — сначала выбираем её
            root = TabsRoot();
            if (root == null) return;
        }
        string start = IsSongsterrUrl(url) ? url
            : query.Trim().Length > 0 ? "https://www.songsterr.com/?pattern=" + Uri.EscapeDataString(query.Trim())
            : "https://www.songsterr.com/";
        string? saved;
        songsterrOpen = true;
        try
        {
            using var win = new SongsterrWindow(webEnv, start, Path.Combine(root, "Songsterr"));
            win.ShowDialog(this);
            saved = win.SavedPath;
        }
        finally { songsterrOpen = false; }
        if (saved == null) return;
        await SendTabsLibrary();
        Post(JsonSerializer.Serialize(new { t = "songsterrSaved", rel = Path.GetRelativePath(root, saved), name = Path.GetFileNameWithoutExtension(saved) }));
    }

    /// <summary>
    /// Самопроверка без сайта Songsterr: тестовая страница сама «скачивает» файл .gp, окно должно сохранить его
    /// в указанную папку и закрыться. Три раза: новый файл, тот же файл (копии быть не должно), другой файл («(2)»).
    /// </summary>
    private void SongsterrSelfTest()
    {
        if (webEnv == null || ssTestPath == null) return;
        var log = new List<string>();
        if (ssShotUrl != null)
        {
            using var shotWin = new SongsterrWindow(webEnv, ssShotUrl, Path.Combine(Path.GetTempPath(), "PolyAmp-sstest")) { TestLog = log, TestShotPath = ssTestPath + ".png" };
            shotWin.ShowDialog(this);
            File.WriteAllLines(ssTestPath, log);
            Close();
            return;
        }

        string dir = Path.Combine(Path.GetDirectoryName(Path.GetFullPath(ssTestPath))!, "sstest-library", "Songsterr");
        if (Directory.Exists(dir)) Directory.Delete(dir, true);
        bool ok = true;
        foreach (var (content, expect) in new[] { ("first", "Test Song.gp"), ("first", "Test Song.gp"), ("second", "Test Song (2).gp") })
        {
            string html = "<!doctype html><body style='background:#111218;color:#eee;font:16px sans-serif'>test download<script>" +
                $"const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([{JsonSerializer.Serialize(content)}]));" +
                "a.download='Test Song.gp';document.body.append(a);setTimeout(()=>a.click(),300);</script>";
            using var win = new SongsterrWindow(webEnv, "data:text/html," + Uri.EscapeDataString(html), dir) { TestLog = log };
            var guard = new System.Windows.Forms.Timer { Interval = 12000 };
            guard.Tick += (_, _) => { guard.Stop(); log.Add("timeout"); win.Close(); };
            guard.Start();
            win.ShowDialog(this);
            guard.Stop();
            guard.Dispose();
            string got = win.SavedPath == null ? "(none)" : Path.GetFileName(win.SavedPath);
            string[] files = Directory.Exists(dir) ? Directory.GetFiles(dir).Select(f => Path.GetFileName(f)).OrderBy(f => f).ToArray() : [];

            bool pass = got == expect;
            ok &= pass;
            log.Add($"run '{content}': saved {got}, expected {expect} → {(pass ? "OK" : "FAIL")}; folder: {string.Join(", ", files)}");
        }
        foreach (var (input, want) in new[] { ("Band: Song?.gp", "Band Song.gp"), ("  ..gp5", "Songsterr tab.gp5"), ("a/b\\c.GPX", "c.gpx") })
        {
            string cleaned = SongsterrWindow.CleanName(Path.GetFileName(input));
            bool pass = cleaned == want;
            ok &= pass;
            log.Add($"name '{input}' → '{cleaned}' → {(pass ? "OK" : "FAIL")}");
        }
        string[] final = Directory.Exists(dir) ? Directory.GetFiles(dir).Select(f => Path.GetFileName(f)).OrderBy(f => f).ToArray() : [];

        bool filesOk = final.SequenceEqual(new[] { "Test Song (2).gp", "Test Song.gp" });
        ok &= filesOk;
        log.Add($"final folder: {string.Join(", ", final)} → {(filesOk ? "OK" : "FAIL")}");
        log.Add("RESULT: " + (ok ? "OK" : "FAIL"));
        File.WriteAllLines(ssTestPath, log);
        Close();
    }

    // ---------- цепочка блоков ----------

    /// <summary>Интерфейс прислал цепочку целиком: какие блоки, в каком порядке, с какими файлами и ручками.</summary>
    private void ApplyChain(JsonElement m)
    {
        var specs = new List<AudioEngine.BlockSpec>();
        foreach (JsonElement b in m.GetProperty("blocks").EnumerateArray())
        {
            var ps = new Dictionary<string, float>();
            if (b.TryGetProperty("params", out JsonElement pe) && pe.ValueKind == JsonValueKind.Object)
                foreach (JsonProperty p in pe.EnumerateObject())
                    if (p.Value.ValueKind == JsonValueKind.Number) ps[p.Name] = p.Value.GetSingle();
            string file = Str(b, "file"), cid = Str(b, "cid");
            specs.Add(new AudioEngine.BlockSpec(Str(b, "id"), Str(b, "type"), Int(b, "on", 1) != 0,
                file.Length > 0 ? file : null, ps, Num(b, "size", 1),
                cid.Length > 0 ? cid : null, Str(b, "name"), Str(b, "vendor")));
        }
        var removed = new List<Block>();
        engine.ApplyChain(specs, removed);
        // окна ушедших плагинов закрываем до выгрузки самих плагинов
        foreach (Block r in removed)
            if (pluginWindows.TryGetValue(r.Id, out PluginWindow? w) && w.Block == r) w.Close();
        engine.ReleaseRemoved(removed);
        SendBlocks();
    }

    // ---------- плагины VST3 ----------

    private readonly Dictionary<string, PluginWindow> pluginWindows = new();
    private List<Vst3Plugin> vst3Plugins = [];
    private List<string> vst3Failed = [];
    private bool vst3Scanning;
    private string? vst3Progress;
    private System.Windows.Forms.Timer? vst3Timer;

    private void SendVst3() => Post(JsonSerializer.Serialize(new
    {
        t = "vst3",
        available = Vst3Native.Available,
        scanned = Vst3Scanner.HasCache,
        scanning = vst3Scanning,
        progress = vst3Progress,
        failed = vst3Failed,
        folder = Vst3Scanner.Folders().First(),
        plugins = vst3Plugins.Select(p => new { path = p.Path, cid = p.Cid, name = p.Name, vendor = p.Vendor, sub = p.Sub }),
    }));

    /// <summary>Найти установленные эффекты VST3 (force — заново все, иначе только новые и изменившиеся).</summary>
    private async Task Vst3ScanAsync(bool force)
    {
        if (vst3Scanning || !Vst3Native.Available) { SendVst3(); return; }
        vst3Scanning = true;
        vst3Progress = null;
        SendVst3();
        try
        {
            var (plugins, failed) = await Vst3Scanner.ScanAsync(force, (done, total, name) => BeginInvoke(() =>
            {
                vst3Progress = $"{Math.Min(done + 1, total)} of {total}: {name}";
                SendVst3();
            }));
            vst3Plugins = plugins;
            vst3Failed = failed;
        }
        catch (Exception ex) { vst3Failed = [ex.Message]; }
        finally
        {
            vst3Scanning = false;
            vst3Progress = null;
            SendVst3();
        }
    }

    private void OpenPluginWindow(string id)
    {
        if (pluginWindows.TryGetValue(id, out PluginWindow? open))
        {
            if (open.WindowState == FormWindowState.Minimized) open.WindowState = FormWindowState.Normal;
            open.Activate();
            return;
        }
        if (engine.GetBlock(id) is not Vst3Block b || b.Handle == IntPtr.Zero) return;
        var win = new PluginWindow(b);
        _ = win.Handle; // окно создано, но ещё не показано: плагин встраивается и задаёт размер
        string? err = win.Attach();
        if (err != null)
        {
            win.Dispose();
            Post(JsonSerializer.Serialize(new { t = "vst3Error", id, error = err }));
            return;
        }
        win.Closed2 += w => pluginWindows.Remove(w.BlockId);
        pluginWindows[id] = win;
        Rectangle area = Screen.FromControl(this).WorkingArea;
        win.StartPosition = FormStartPosition.Manual;
        win.Location = new Point(
            Math.Clamp(Left + (Width - win.Width) / 2, area.Left, Math.Max(area.Left, area.Right - win.Width)),
            Math.Clamp(Top + (Height - win.Height) / 2, area.Top, Math.Max(area.Top, area.Bottom - win.Height)));
        win.Show(this);
    }

    /// <summary>Раз в полторы секунды: сохранить изменившиеся состояния плагинов и сообщить об упавших.</summary>
    private void Vst3Tick()
    {
        foreach (Vst3Block v in engine.Blocks.OfType<Vst3Block>().ToList())
        {
            if (v.Crashed && !v.CrashReported)
            {
                v.CrashReported = true;
                v.Error = "The plugin crashed and was switched off. Remove it from the chain or restart the app.";
                if (pluginWindows.TryGetValue(v.Id, out PluginWindow? w)) w.Close();
                SendBlock(v);
            }
            else if (!v.Crashed && v.TakeDirty()) v.SaveState();
        }
    }

    /// <summary>Что известно о файлах блоков: загрузился ли, что это за модель или импульс, откуда он.</summary>
    private void SendBlocks()
    {
        foreach (Block b in engine.Blocks)
            if (b.FileKind != null) SendBlock(b);
    }

    private void SendBlock(Block b)
    {
        Dictionary<string, object?> d = b.Info();
        d["t"] = "block";
        d["id"] = b.Id;
        d["type"] = b.Type;
        d["path"] = b.FilePath;
        d["requested"] = b.RequestedFile; // какой файл просили: по нему интерфейс понимает, к чему относится ошибка
        d["loaded"] = b.FilePath != null;
        d["error"] = b.Error;
        d["source"] = Tone3000Client.ReadSource(b.FilePath);
        Post(JsonSerializer.Serialize(d));
    }

    // ---------- TONE3000 ----------

    private (string token, T3kTone tone, List<T3kModel> models, string kind, string? blockId)? t3kPending;
    /// <summary>Токен доступа последнего входа. Живёт только в памяти, до закрытия приложения.</summary>
    private string? t3kToken;
    private bool t3kBusy;

    private void SendLibrary() => SendT3k(new { t = "library", items = Tone3000Client.ListLibrary() });

    private void SendT3k(object payload) => Post(JsonSerializer.Serialize(payload));

    private void SendT3kStatus() => SendT3k(new { t = "t3k", stage = "status", hasKey = Tone3000Client.LoadKey() != null });

    private static string Kind(string kind) => kind is "pedal" or "amp" or "cab" or "space" ? kind : "amp";

    /// <summary>
    /// Открывает окно TONE3000 и ждёт, пока пользователь выберет или подтвердит тон.
    /// Возвращает токен доступа и номер тона, либо null, если окно закрыли.
    /// </summary>
    private async Task<(string token, long toneId)?> T3kAuthorizeAsync(string key, Tone3000Client.AuthRequest auth, List<string>? testLog)
    {
        if (webEnv == null) return null;
        Uri? result;
        using (var win = new Tone3000Window(webEnv, auth.Url)
        {
            TestLog = testLog,
            TestShotPath = testLog == null || t3kTestPath == null ? null : t3kTestPath + ".png",
            TestNavigateAfterLoad = testLog == null ? null
                : $"{Tone3000Client.RedirectUri}?code=selftest&state={auth.State}&tone_id=106343",
        })
        {
            win.ShowDialog(this);
            result = win.Result;
        }
        if (result == null) return null;

        var q = System.Web.HttpUtility.ParseQueryString(result.Query);
        if (q["error"] is { Length: > 0 } err) throw new T3kException("TONE3000 reported an error: " + err);
        if (q["code"] is not { Length: > 0 } code) return null;
        if (q["state"] != auth.State) throw new T3kException("The TONE3000 response failed verification (state). Please try again.");
        long.TryParse(q["tone_id"], out long toneId); // при простом входе номера тона нет
        string token = await Tone3000Client.ExchangeAsync(key, code, auth.Verifier);
        t3kToken = token;
        return (token, toneId);
    }

    /// <summary>Каталог TONE3000 для блока: выбрать тон и получить список его моделей.</summary>
    private async Task T3kSelectAsync(string kind, string arch, string? blockId, List<string>? testLog = null)
    {
        if (t3kBusy) return;
        string? key = Tone3000Client.LoadKey();
        if (key == null) { SendT3k(new { t = "t3k", stage = "needKey" }); return; }
        kind = Kind(kind);
        t3kBusy = true;
        try
        {
            var auth = await T3kAuthorizeAsync(key, Tone3000Client.BeginSelect(key, kind, arch), testLog);
            if (auth is not { toneId: > 0 } a) { SendT3k(new { t = "t3k", stage = "canceled" }); return; }
            SendT3k(new { t = "t3k", stage = "loading" });
            T3kTone tone = await Tone3000Client.GetToneAsync(a.token, a.toneId);
            List<T3kModel> models = await Tone3000Client.ListModelsAsync(a.token, a.toneId, Tone3000Client.FormatOf(kind));
            t3kPending = (a.token, tone, models, kind, blockId);
            SendT3k(new
            {
                t = "t3k", stage = "tone", kind, blockId,
                tone = new { tone.Id, tone.Title, tone.Description, tone.Gear, tone.Format, tone.Image, tone.Creator, tone.Avatar, tone.Url, tone.License },
                models = models.Select(m => new { m.Id, m.Name, m.Size, m.Architecture }),
            });
        }
        catch (Exception ex)
        {
            testLog?.Add("error: " + ex.Message);
            SendT3k(new { t = "t3k", stage = "error", error = ex is T3kException ? ex.Message : "Couldn't reach TONE3000: " + ex.Message });
        }
        finally
        {
            t3kBusy = false;
            t3kTestDone?.TrySetResult();
        }
    }

    /// <summary>Скачать выбранную модель тона; интерфейс сам поставит файл в нужный блок.</summary>
    private async Task T3kDownloadAsync(long modelId)
    {
        if (t3kBusy || t3kPending is not { } p) return;
        T3kModel? model = p.models.FirstOrDefault(m => m.Id == modelId);
        if (model == null) return;
        t3kBusy = true;
        try
        {
            SendT3k(new { t = "t3k", stage = "downloading" });
            string path = await Tone3000Client.DownloadAsync(p.token, p.tone, model, p.kind);
            SendLibrary();
            SendT3k(new { t = "t3k", stage = "done", p.kind, p.blockId, path, gear = p.tone.Gear, title = p.tone.Title });
        }
        catch (Exception ex)
        {
            SendT3k(new { t = "t3k", stage = "error", error = ex is T3kException ? ex.Message : "Couldn't download the file: " + ex.Message });
        }
        finally { t3kBusy = false; }
    }

    /// <summary>
    /// Для готовых пресетов: скачать заранее известный тон по номеру. Первый раз открывается окно TONE3000
    /// для входа в аккаунт; дальше, пока приложение открыто, тоны скачиваются без окна.
    /// </summary>
    private async Task T3kLoadToneAsync(int reqId, long toneId, string kind, string? match, List<string>? testLog = null)
    {
        void Reply(bool ok, string? path, string? error, bool canceled = false) =>
            SendT3k(new { t = "t3kTone", reqId, ok, toneId, path, error, canceled });

        if (t3kBusy) { Reply(false, null, "TONE3000 is busy with another download."); return; }
        string? key = Tone3000Client.LoadKey();
        if (key == null) { Reply(false, null, "A TONE3000 app key is required.", canceled: true); SendT3k(new { t = "t3k", stage = "needKey" }); return; }
        kind = Kind(kind);
        t3kBusy = true;
        try
        {
            for (int attempt = 0; ; attempt++)
            {
                if (t3kToken == null)
                {
                    var auth = await T3kAuthorizeAsync(key, Tone3000Client.BeginAuth(key), testLog);
                    if (auth == null) { Reply(false, null, null, canceled: true); return; }
                }
                try
                {
                    string path = await FetchToneAsync(t3kToken!, toneId, kind, match);
                    SendLibrary();
                    Reply(true, path, null);
                    return;
                }
                catch (T3kException ex) when (ex.Status == 401 && attempt == 0)
                {
                    t3kToken = null; // токен устарел — входим заново и пробуем ещё раз
                }
            }
        }
        catch (Exception ex)
        {
            testLog?.Add("error: " + ex.Message);
            Reply(false, null, ex is T3kException ? ex.Message : "Couldn't load the tone: " + ex.Message);
        }
        finally
        {
            t3kBusy = false;
            t3kTestDone?.TrySetResult();
        }
    }

    /// <summary>Скачать подходящую модель тона: по подсказке match, иначе A2, иначе первую.</summary>
    private static async Task<string> FetchToneAsync(string token, long toneId, string kind, string? match)
    {
        T3kTone tone = await Tone3000Client.GetToneAsync(token, toneId);
        List<T3kModel> models = await Tone3000Client.ListModelsAsync(token, toneId, Tone3000Client.FormatOf(kind));
        if (models.Count == 0) throw new T3kException($"The tone “{tone.Title}” has no files in a supported format.");

        T3kModel? model = null;
        if (match != null)
        {
            try
            {
                var re = new System.Text.RegularExpressions.Regex(match, System.Text.RegularExpressions.RegexOptions.IgnoreCase);
                model = models.FirstOrDefault(x => re.IsMatch(x.Name));
            }
            catch (ArgumentException) { }
        }
        model ??= models.FirstOrDefault(x => x.Architecture == "2") ?? models[0];
        return await Tone3000Client.DownloadAsync(token, tone, model, kind);
    }

    // ---------- движок → интерфейс ----------

    private void SendDrivers() => Post(JsonSerializer.Serialize(new { t = "drivers", drivers = AudioEngine.Drivers() }));

    private void SendAudio(string? error)
    {
        AudioInfo? i = engine.Info;
        Post(JsonSerializer.Serialize(new
        {
            t = "audio",
            open = i != null,
            error,
            driver = i?.Driver ?? last?.driver,
            sampleRate = i?.SampleRate ?? 0,
            bufferSize = i?.BufferSize ?? 0,
            inputLatency = i?.InputLatency ?? 0,
            outputLatency = i?.OutputLatency ?? 0,
            inputs = i?.Inputs ?? Array.Empty<string>(),
            outputs = i?.Outputs ?? Array.Empty<string>(),
            rates = i?.Rates ?? Array.Empty<int>(),
            inCh = i?.InputChannel ?? 0,
            outCh = i?.OutputChannel ?? 0,
        }));
    }

    private void Post(string json) => SafeInvoke(() => web.CoreWebView2?.PostWebMessageAsJson(json));

    private void SafeInvoke(Action action)
    {
        if (closing || IsDisposed || !IsHandleCreated) return;
        try
        {
            BeginInvoke(() =>
            {
                if (closing || IsDisposed) return;
                try { action(); } catch { /* окно закрывается */ }
            });
        }
        catch { /* окно закрывается */ }
    }

    /// <summary>Самопроверка: открывает окно TONE3000, подсовывает ему адрес возврата и пишет, что произошло.</summary>
    private bool t3kTestStarted;

    private List<string>? t3kTestLog;
    private TaskCompletionSource? t3kTestDone;

    private async Task T3kSelfTest()
    {
        if (t3kTestStarted || t3kTestPath == null) return;
        t3kTestStarted = true;
        var log = new List<string> { "key present: " + (Tone3000Client.LoadKey() != null) };
        t3kTestLog = log;
        t3kTestDone = new TaskCompletionSource();
        // если окно зависнет, сторожевой таймер всё равно запишет, до чего дошло
        using var watchdog = new System.Threading.Timer(_ =>
        {
            try { File.WriteAllLines(t3kTestPath, log.ToArray().Append("WATCHDOG: flow did not finish in 20 s")); } catch { }
        }, null, 20000, Timeout.Infinite);
        try
        {
            await Task.Delay(1500);
            // тем же путём, что и кнопка в интерфейсе
            _ = web.CoreWebView2.ExecuteScriptAsync(t3kAuthTest
                ? "lad.engine.t3kLoadTone(37818, 'pedal', null)"
                : "lad.engine.t3kSelect('amp', '2', null)");
            await Task.WhenAny(t3kTestDone.Task, Task.Delay(30000));
            if (!t3kTestDone.Task.IsCompleted) log.Add("TIMEOUT: flow did not finish");
        }
        catch (Exception ex) { log.Add("EXCEPTION: " + ex); }
        File.WriteAllLines(t3kTestPath, log);
        Close();
    }

    // ---------- режим скриншота (для проверки сборки) ----------

    private bool shotStarted;

    private async Task Screenshot()
    {
        if (shotStarted || shotPath == null) return;
        shotStarted = true;
        try
        {
            await Task.Delay(2200);
            if (shotJs != null)
            {
                string result = await web.CoreWebView2.ExecuteScriptAsync(shotJs);
                await Task.Delay(shotWait);
                string after = await web.CoreWebView2.ExecuteScriptAsync("window.__shot ? JSON.stringify(window.__shot()) : null");
                File.WriteAllText(shotPath + ".txt", result + "\n" + after);
            }
            using (var fs = File.Create(shotPath))
                await web.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, fs);
        }
        catch (Exception ex)
        {
            File.WriteAllText(shotPath + ".txt", "ERROR: " + ex);
        }
        Close();
    }
}
