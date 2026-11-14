// Клиент TONE3000 (https://www.tone3000.com/api): выбор тона через их окно «Select»
// (OAuth 2.0 + PKCE), список моделей тона и скачивание файла в папку с тонами.
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace Lad;

internal sealed class T3kException(string message, int status = 0) : Exception(message)
{
    /// <summary>Код ответа сервера, если ошибка пришла от него (401 — токен больше не годится).</summary>
    public int Status => status;
}

internal sealed record T3kTone(long Id, string Title, string Description, string Gear, string Format, string? Image,
    string Creator, string? Avatar, string Url, string License);

internal sealed record T3kModel(long Id, string Name, string Size, string Architecture, string Url);

internal sealed class Tone3000Client
{
    private const string ApiBase = "https://www.tone3000.com";
    /// <summary>Адрес возврата: на нём ничего не слушает, окно выбора перехватывает переход сюда.</summary>
    public const string RedirectUri = "http://127.0.0.1:53127/callback";
    private const long MaxFileBytes = 64 * 1024 * 1024;

    private static readonly HttpClient http = CreateHttp();

    private static HttpClient CreateHttp()
    {
        var c = new HttpClient { Timeout = TimeSpan.FromSeconds(60) };
        c.DefaultRequestHeaders.UserAgent.ParseAdd("PolyAmp/0.1");
        return c;
    }

    // ---------- ключ приложения (publishable key из настроек аккаунта TONE3000) ----------

    private static string KeyPath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Lad", "tone3000-key.txt");

    public static string? LoadKey()
    {
        try
        {
            string key = File.ReadAllText(KeyPath).Trim();
            return key.Length > 0 ? key : null;
        }
        catch (IOException) { return null; }
    }

    public static void SaveKey(string key)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(KeyPath)!);
        File.WriteAllText(KeyPath, key.Trim());
    }

    /// <summary>Папка, куда складываются скачанные тоны.</summary>
    public static string LibraryDir => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), "Poly Amp", "Tones");

    // ---------- авторизация ----------

    public sealed record AuthRequest(string Url, string Verifier, string State);

    private static string Base64Url(byte[] b) => Convert.ToBase64String(b).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    /// <summary>Формат файлов блока: импульсы для кабинета и пространства, модели NAM для педали и усилителя.</summary>
    public static string FormatOf(string kind) => kind is "cab" or "space" ? "ir" : "nam";

    private static AuthRequest Begin(string clientId, IEnumerable<(string, string)> extra)
    {
        string verifier = Base64Url(RandomNumberGenerator.GetBytes(32));
        string challenge = Base64Url(SHA256.HashData(Encoding.ASCII.GetBytes(verifier)));
        string state = Base64Url(RandomNumberGenerator.GetBytes(16));
        var q = new List<(string, string)>
        {
            ("client_id", clientId), ("redirect_uri", RedirectUri), ("response_type", "code"),
            ("code_challenge", challenge), ("code_challenge_method", "S256"), ("state", state),
        };
        q.AddRange(extra);
        string query = string.Join("&", q.Select(p => p.Item1 + "=" + Uri.EscapeDataString(p.Item2)));
        return new AuthRequest($"{ApiBase}/api/v1/oauth/authorize?{query}", verifier, state);
    }

    /// <summary>Каталог TONE3000 для блока нужного вида.</summary>
    /// <param name="kind">pedal, amp, cab или space — от него зависит раздел каталога</param>
    /// <param name="arch">для моделей NAM: «2» — каталог A2, «1» — прежние A1</param>
    public static AuthRequest BeginSelect(string clientId, string kind, string arch)
    {
        string format = FormatOf(kind);
        // ревербераторы и дилэи встречаются как импульсы не только в «пространстве», но и среди педалей и студийных приборов
        string gears = kind switch { "pedal" => "pedal", "cab" => "cab", "space" => "space_pedal_outboard", _ => "amp_amp-cab" };
        var q = new List<(string, string)>
        {
            ("prompt", "select_tone"), ("format", format), ("gears", gears), ("menubar", "true"), ("preview", "true"),
        };
        // без параметра сервер показывает только прежние A1; A2 — нынешний стандарт TONE3000
        if (format == "nam" && arch != "1") q.Add(("architecture", "2"));
        return Begin(clientId, q);
    }

    /// <summary>Просто вход в аккаунт, без выбора тона: нужен, чтобы скачать тоны готового пресета по их номерам.</summary>
    public static AuthRequest BeginAuth(string clientId) => Begin(clientId, []);

    public static async Task<string> ExchangeAsync(string clientId, string code, string verifier)
    {
        using var body = new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["grant_type"] = "authorization_code", ["code"] = code, ["code_verifier"] = verifier,
            ["redirect_uri"] = RedirectUri, ["client_id"] = clientId,
        });
        using HttpResponseMessage res = await http.PostAsync($"{ApiBase}/api/v1/oauth/token", body);
        string text = await res.Content.ReadAsStringAsync();
        if (!res.IsSuccessStatusCode) throw new T3kException("TONE3000 didn't grant access: " + ErrorText(text, (int)res.StatusCode));
        using JsonDocument doc = JsonDocument.Parse(text);
        return doc.RootElement.GetProperty("access_token").GetString()
            ?? throw new T3kException("TONE3000 returned an empty access token.");
    }

    private static string ErrorText(string body, int status)
    {
        try
        {
            using JsonDocument doc = JsonDocument.Parse(body);
            JsonElement r = doc.RootElement;
            string? d = r.TryGetProperty("error_description", out JsonElement ed) && ed.ValueKind == JsonValueKind.String ? ed.GetString() : null;
            string? e = r.TryGetProperty("error", out JsonElement er) && er.ValueKind == JsonValueKind.String ? er.GetString() : null;
            if (d != null || e != null) return $"{d ?? e} (code {status})";
        }
        catch (JsonException) { }
        return $"error {status}";
    }

    // ---------- данные ----------

    private static async Task<JsonDocument> GetJsonAsync(string token, string pathAndQuery)
    {
        using var req = new HttpRequestMessage(HttpMethod.Get, ApiBase + pathAndQuery);
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        using HttpResponseMessage res = await http.SendAsync(req);
        string text = await res.Content.ReadAsStringAsync();
        if (!res.IsSuccessStatusCode)
            throw new T3kException("TONE3000 returned an error: " + ErrorText(text, (int)res.StatusCode), (int)res.StatusCode);
        return JsonDocument.Parse(text);
    }

    private static string S(JsonElement o, string name) =>
        o.ValueKind == JsonValueKind.Object && o.TryGetProperty(name, out JsonElement v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";

    public static async Task<T3kTone> GetToneAsync(string token, long id)
    {
        using JsonDocument doc = await GetJsonAsync(token, $"/api/v1/tones/{id}");
        JsonElement t = doc.RootElement;
        JsonElement user = t.TryGetProperty("user", out JsonElement u) ? u : default;
        string? image = t.TryGetProperty("images", out JsonElement imgs) && imgs.ValueKind == JsonValueKind.Array && imgs.GetArrayLength() > 0
            ? imgs[0].GetString() : null;
        string creator = S(user, "display_name") is { Length: > 0 } dn ? dn : S(user, "username");
        string avatar = S(user, "avatar_url");
        return new T3kTone(id, S(t, "title"), S(t, "description"), S(t, "gear"), S(t, "format"), image,
            creator, avatar.Length > 0 ? avatar : null, S(t, "url"), S(t, "license"));
    }

    /// <summary>Модели тона. Для NAM спрашиваем и A2, и прежние A1: без параметра сервер отдаёт только A1.</summary>
    public static async Task<List<T3kModel>> ListModelsAsync(string token, long toneId, string format)
    {
        var list = new List<T3kModel>();
        string[] queries = format == "nam" ? ["&architecture=2", ""] : [""];
        foreach (string extra in queries)
        {
            using JsonDocument doc = await GetJsonAsync(token, $"/api/v1/models?tone_id={toneId}&page_size=100{extra}");
            if (!doc.RootElement.TryGetProperty("data", out JsonElement data) || data.ValueKind != JsonValueKind.Array) continue;
            foreach (JsonElement m in data.EnumerateArray())
            {
                long id = m.GetProperty("id").GetInt64();
                if (list.Any(x => x.Id == id)) continue;
                string arch = m.TryGetProperty("architecture_version", out JsonElement av)
                    ? av.ValueKind == JsonValueKind.Number ? av.GetRawText() : av.ValueKind == JsonValueKind.String ? av.GetString() ?? "" : ""
                    : "";
                list.Add(new T3kModel(id, S(m, "name"), S(m, "size"), arch, S(m, "model_url")));
            }
        }
        return list;
    }

    /// <summary>Скачать файл модели в папку тонов. Возвращает путь к файлу.</summary>
    public static async Task<string> DownloadAsync(string token, T3kTone tone, T3kModel model, string slot)
    {
        if (!Uri.TryCreate(model.Url, UriKind.Absolute, out Uri? src))
            throw new T3kException("The model has no download link.");
        // токен доступа отправляем только на сам TONE3000, какой бы адрес ни стоял в ссылке
        using var req = new HttpRequestMessage(HttpMethod.Get, ApiBase + src.PathAndQuery);
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        using HttpResponseMessage res = await http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead);
        if (!res.IsSuccessStatusCode)
            throw new T3kException("Couldn't download the model: " + ErrorText(await res.Content.ReadAsStringAsync(), (int)res.StatusCode),
                (int)res.StatusCode);
        if (res.Content.Headers.ContentLength > MaxFileBytes) throw new T3kException("The model file is too large.");

        string ext = Path.GetExtension(src.AbsolutePath).ToLowerInvariant();
        if (ext is not (".nam" or ".wav")) ext = tone.Format == "ir" ? ".wav" : ".nam";
        string dir = Path.Combine(LibraryDir, SafeName(tone.Title, "tone-" + tone.Id));
        Directory.CreateDirectory(dir);
        string path = Path.Combine(dir, SafeName(model.Name, "model-" + model.Id) + ext);

        byte[] bytes = await res.Content.ReadAsByteArrayAsync();
        if (bytes.LongLength > MaxFileBytes) throw new T3kException("The model file is too large.");
        await File.WriteAllBytesAsync(path, bytes);

        // паспорт: откуда файл и чей он — приложение показывает это рядом с названием
        string sidecar = JsonSerializer.Serialize(new
        {
            toneId = tone.Id, title = tone.Title, creator = tone.Creator, url = tone.Url, license = tone.License,
            model = model.Name, size = model.Size, arch = model.Architecture,
            gear = tone.Gear, format = tone.Format, image = tone.Image, slot,
        });
        await File.WriteAllTextAsync(path + ".t3k.json", sidecar);
        return path;
    }

    private static string SafeName(string name, string fallback)
    {
        var sb = new StringBuilder();
        foreach (char c in name.Trim())
            sb.Append(Array.IndexOf(Path.GetInvalidFileNameChars(), c) >= 0 || c < 32 ? ' ' : c);
        string s = string.Join(' ', sb.ToString().Split(' ', StringSplitOptions.RemoveEmptyEntries)).TrimEnd('.', ' ');
        if (s.Length > 80) s = s[..80].TrimEnd('.', ' ');
        return s.Length > 0 ? s : fallback;
    }

    /// <summary>Сведения о происхождении файла, если он скачан с TONE3000.</summary>
    public static object? ReadSource(string? path)
    {
        if (path == null) return null;
        try
        {
            string file = path + ".t3k.json";
            if (!File.Exists(file)) return null;
            using JsonDocument doc = JsonDocument.Parse(File.ReadAllText(file));
            JsonElement r = doc.RootElement;
            string url = S(r, "url");
            return new
            {
                title = S(r, "title"), creator = S(r, "creator"), url = IsToneUrl(url) ? url : null,
                model = S(r, "model"), gear = S(r, "gear"), image = HttpsOrNull(S(r, "image")),
            };
        }
        catch (Exception ex) when (ex is IOException or JsonException) { return null; }
    }

    private static string? HttpsOrNull(string url) => url.StartsWith("https://", StringComparison.Ordinal) ? url : null;

    /// <summary>«Мои тоны»: всё, что уже скачано с TONE3000 и лежит в папке тонов.</summary>
    public static List<object> ListLibrary()
    {
        var items = new List<(string title, string model, object item)>();
        if (!Directory.Exists(LibraryDir)) return [];
        foreach (string side in Directory.EnumerateFiles(LibraryDir, "*.t3k.json", SearchOption.AllDirectories))
        {
            string file = side[..^".t3k.json".Length];
            if (!File.Exists(file)) continue;
            try
            {
                using JsonDocument doc = JsonDocument.Parse(File.ReadAllText(side));
                JsonElement r = doc.RootElement;
                string gear = S(r, "gear"), slot = S(r, "slot");
                // у файлов, скачанных до появления гнёзд, гнездо определяем по типу файла и аппарата
                if (slot is not ("pedal" or "amp" or "cab" or "space"))
                    slot = !Path.GetExtension(file).Equals(".wav", StringComparison.OrdinalIgnoreCase) ? (gear == "pedal" ? "pedal" : "amp")
                        : gear == "cab" ? "cab" : gear.Length > 0 ? "space" : "cab";
                long toneId = r.TryGetProperty("toneId", out JsonElement tid) && tid.ValueKind == JsonValueKind.Number ? tid.GetInt64() : 0;
                string title = S(r, "title"), model = S(r, "model");
                items.Add((title, model, new
                {
                    path = file, slot, toneId, title, model, creator = S(r, "creator"), gear,
                    size = S(r, "size"), arch = S(r, "arch"), image = HttpsOrNull(S(r, "image")),
                }));
            }
            catch (Exception ex) when (ex is IOException or JsonException) { }
        }
        return items.OrderBy(i => i.title, StringComparer.CurrentCultureIgnoreCase)
            .ThenBy(i => i.model, StringComparer.CurrentCultureIgnoreCase).Select(i => i.item).ToList();
    }

    public static bool IsToneUrl(string url) =>
        Uri.TryCreate(url, UriKind.Absolute, out Uri? u) && u.Scheme == Uri.UriSchemeHttps
        && (u.Host == "www.tone3000.com" || u.Host == "tone3000.com");
}

/// <summary>Окно TONE3000 внутри приложения: вход в аккаунт и выбор тона на их сайте.</summary>
internal sealed class Tone3000Window : Form
{
    private readonly WebView2 web = new() { Dock = DockStyle.Fill };
    private readonly CoreWebView2Environment env;
    private readonly string startUrl;
    private bool finished;

    /// <summary>Адрес, на который TONE3000 вернул пользователя (с кодом и номером тона), или null при отмене.</summary>
    public Uri? Result { get; private set; }

    /// <summary>Для самопроверки: адреса загруженных страниц и автозакрытие через заданное время.</summary>
    internal List<string>? TestLog;
    internal string? TestNavigateAfterLoad;
    internal string? TestShotPath;

    private static string Trim(string s, int max) => s.Length > max ? s[..max] + "…" : s;

    public Tone3000Window(CoreWebView2Environment env, string startUrl)
    {
        this.env = env;
        this.startUrl = startUrl;
        Text = "TONE3000 — choose a tone";
        ClientSize = new Size(1180, 820);
        MinimumSize = new Size(720, 560);
        StartPosition = FormStartPosition.CenterParent;
        ShowInTaskbar = false;
        BackColor = Color.White;
        Controls.Add(web);
    }

    protected override async void OnLoad(EventArgs e)
    {
        base.OnLoad(e);
        try
        {
            await web.EnsureCoreWebView2Async(env);
            CoreWebView2 core = web.CoreWebView2;
            core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.IsStatusBarEnabled = false;
            core.NavigationStarting += (_, a) =>
            {
                if (!IsRedirect(a.Uri)) return;
                a.Cancel = true; // по этому адресу никто не слушает — забираем код из него сами
                Finish(new Uri(a.Uri));
            };
            // ссылки «в новом окне» (условия, помощь) открываем в обычном браузере
            core.NewWindowRequested += (_, a) =>
            {
                a.Handled = true;
                if (Uri.TryCreate(a.Uri, UriKind.Absolute, out Uri? u) && (u.Scheme == Uri.UriSchemeHttps || u.Scheme == Uri.UriSchemeHttp))
                    System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(u.AbsoluteUri) { UseShellExecute = true });
            };
            if (TestLog != null)
            {
                // что страница пишет в консоль и какие у неё ошибки
                await core.CallDevToolsProtocolMethodAsync("Runtime.enable", "{}");
                await core.CallDevToolsProtocolMethodAsync("Log.enable", "{}");
                core.GetDevToolsProtocolEventReceiver("Runtime.exceptionThrown").DevToolsProtocolEventReceived += (_, a) =>
                    TestLog.Add("js exception: " + Trim(a.ParameterObjectAsJson, 500));
                core.GetDevToolsProtocolEventReceiver("Log.entryAdded").DevToolsProtocolEventReceived += (_, a) =>
                    TestLog.Add("log: " + Trim(a.ParameterObjectAsJson, 400));
                core.GetDevToolsProtocolEventReceiver("Runtime.consoleAPICalled").DevToolsProtocolEventReceived += (_, a) =>
                {
                    if (a.ParameterObjectAsJson.Contains("\"type\":\"error\"") || a.ParameterObjectAsJson.Contains("\"type\":\"warning\""))
                        TestLog.Add("console: " + Trim(a.ParameterObjectAsJson, 400));
                };

                bool injected = false;
                core.NavigationCompleted += async (_, a) =>
                {
                    TestLog.Add($"loaded {(a.IsSuccess ? "ok" : "fail " + a.WebErrorStatus)}: {new Uri(core.Source).GetLeftPart(UriPartial.Path)} | {core.DocumentTitle}");
                    if (injected) return;
                    injected = true;
                    await Task.Delay(3500);
                    try
                    {
                        string probe = await core.ExecuteScriptAsync(
                            "JSON.stringify({ text: document.body ? document.body.innerText.slice(0, 300) : null, " +
                            "elements: document.querySelectorAll('body *').length, html: document.documentElement.outerHTML.length, " +
                            "bg: getComputedStyle(document.body).backgroundColor, scheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light', " +
                            "size: innerWidth + 'x' + innerHeight, visible: document.visibilityState })");
                        TestLog.Add("page: " + probe);
                        if (TestShotPath != null)
                        {
                            using var fs = File.Create(TestShotPath);
                            await core.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, fs);
                        }
                        TestLog.Add($"control: {web.Width}x{web.Height} visible={web.Visible} form={ClientSize.Width}x{ClientSize.Height}");
                    }
                    catch (Exception ex) { TestLog.Add("probe failed: " + ex.Message); }
                    if (TestNavigateAfterLoad != null && !finished) core.Navigate(TestNavigateAfterLoad);
                    await Task.Delay(1500);
                    if (!finished) { TestLog.Add("no redirect intercepted"); Close(); }
                };
            }
            core.Navigate(startUrl);
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, "Couldn't open the TONE3000 window.\n\n" + ex.Message,
 "Poly Amp", MessageBoxButtons.OK, MessageBoxIcon.Error);
            Close();
        }
    }

    private static bool IsRedirect(string url) =>
        Uri.TryCreate(url, UriKind.Absolute, out Uri? a) && Uri.TryCreate(Tone3000Client.RedirectUri, UriKind.Absolute, out Uri? b)
        && a.Scheme == b.Scheme && a.Host == b.Host && a.Port == b.Port && a.AbsolutePath == b.AbsolutePath;

    private void Finish(Uri result)
    {
        if (finished) return;
        finished = true;
        Result = result;
        TestLog?.Add("redirect intercepted");
        BeginInvoke(Close); // закрывать прямо из события навигации нельзя
    }
}
