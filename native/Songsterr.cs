// Окно Songsterr внутри приложения. Пользователь сам открывает песню и нажимает у них
// «Download → Guitar Pro»; приложение только выбирает, куда сохранить файл, — прямо в папку
// библиотеки табов (подпапка «Songsterr»), как браузер с заранее выбранной папкой загрузок.
// Ничего с сайта не забирается в обход их кнопки.
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace Lad;

internal sealed class SongsterrWindow : Form
{
    private static readonly string[] TabExts = [".gp", ".gpx", ".gp5", ".gp4", ".gp3"];

    /// <summary>Входы через Google, Apple, Facebook, Microsoft открываются своими окнами, чтобы вход завершился в этом же окне Songsterr.</summary>
    private static readonly string[] AuthHosts = ["accounts.google.com", "appleid.apple.com", "www.facebook.com", "facebook.com", "login.microsoftonline.com", "login.live.com"];

    private const string IdleHint = "Open the song, press the download button and choose  Guitar Pro  — the file goes straight into your library (folder “Songsterr”).";
    private const string SignInHint = "Sign in to Songsterr — downloads need an account. After that your song opens by itself.";

    private readonly WebView2 web = new() { Dock = DockStyle.Fill };
    private readonly Label hint = new() { Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleLeft, AutoEllipsis = true };
    private readonly CoreWebView2Environment env;
    private readonly string startUrl;
    private readonly string saveDir;
    private bool done;
    private bool signInChecked;
    private string? afterSignIn; // песня, на которую вернуться после входа

    /// <summary>Полный путь сохранённого файла или null, если окно закрыли без скачивания.</summary>
    public string? SavedPath { get; private set; }

    /// <summary>Для самопроверки: журнал событий; снимок окна через заданное время после загрузки страницы и закрытие.</summary>
    internal List<string>? TestLog;
    internal string? TestShotPath;
    internal int TestShotAfterMs = 6000;

    public SongsterrWindow(CoreWebView2Environment env, string startUrl, string saveDir)
    {
        this.env = env;
        this.startUrl = startUrl;
        this.saveDir = saveDir;
        Text = "Songsterr — download Guitar Pro into your library";
        Icon = AppIcon.Get();
        ClientSize = new Size(1240, 860);
        MinimumSize = new Size(760, 560);
        StartPosition = FormStartPosition.CenterParent;
        ShowInTaskbar = false;
        BackColor = Color.FromArgb(17, 18, 24);

        var bar = new Panel { Dock = DockStyle.Top, Height = 46, Padding = new Padding(18, 0, 18, 0), BackColor = Color.FromArgb(32, 33, 42) };
        hint.ForeColor = Color.FromArgb(236, 238, 245);
        hint.Font = new Font("Segoe UI", 10.5f);
        hint.Text = IdleHint;
        bar.Controls.Add(hint);
        // порядок важен: сначала то, что заполняет остаток, потом полоса сверху
        Controls.Add(web);
        Controls.Add(bar);
    }

    protected override async void OnLoad(EventArgs e)
    {
        base.OnLoad(e);
        try
        {
            await web.EnsureCoreWebView2Async(env);
            CoreWebView2 core = web.CoreWebView2;
            core.Settings.IsStatusBarEnabled = false;
            core.NewWindowRequested += OnNewWindow;
            core.DownloadStarting += OnDownloadStarting;
            core.NavigationCompleted += OnNavigationCompleted;
            if (TestLog != null) core.NavigationCompleted += (_, a) => TestLog.Add($"loaded {(a.IsSuccess ? "ok" : "fail " + a.WebErrorStatus)}: {core.Source}");
            if (TestShotPath != null)
            {
                bool shot = false;
                core.NavigationCompleted += async (_, _) =>
                {
                    if (shot) return;
                    shot = true;
                    await Task.Delay(TestShotAfterMs);
                    try
                    {
                        // снимок экрана в границах окна: и полоса подсказки, и страница
                        Rectangle r = RectangleToScreen(ClientRectangle);
                        using var bmp = new Bitmap(r.Width, r.Height);
                        using (var g = Graphics.FromImage(bmp)) g.CopyFromScreen(r.Location, Point.Empty, r.Size);
                        bmp.Save(TestShotPath, System.Drawing.Imaging.ImageFormat.Png);
                        TestLog?.Add("title: " + core.DocumentTitle);
                    }
                    catch (Exception ex) { TestLog?.Add("shot failed: " + ex.Message); }
                    Close();
                };
            }

            core.Navigate(startUrl);
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, "Couldn't open the Songsterr window.\n\n" + ex.Message, "Poly Amp", MessageBoxButtons.OK, MessageBoxIcon.Error);
            Close();
        }
    }

    /// <summary>
    /// Без входа Songsterr вместо скачивания предлагает Plus. Поэтому при первой загрузке смотрим, вошёл ли пользователь
    /// (у тех, кто не вошёл, в меню есть ссылка «Войти» — #menu-signin, она приходит сразу в разметке страницы),
    /// и если нет — открываем их страницу входа, а после входа возвращаемся на песню.
    /// </summary>
    private async void OnNavigationCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs a)
    {
        try
        {
            CoreWebView2 core = web.CoreWebView2;
            if (!a.IsSuccess || done || !Uri.TryCreate(core.Source, UriKind.Absolute, out Uri? u) || !IsSongsterr(u)) return;
            if (u.AbsolutePath.StartsWith("/signin", StringComparison.OrdinalIgnoreCase) || u.AbsolutePath.StartsWith("/signup", StringComparison.OrdinalIgnoreCase))
            {
                hint.Text = SignInHint;
                return;
            }
            bool signedOut = await core.ExecuteScriptAsync("!!document.getElementById('menu-signin')") == "true";
            if (!signInChecked)
            {
                signInChecked = true;
                if (signedOut)
                {
                    afterSignIn = core.Source;
                    hint.Text = SignInHint;
                    TestLog?.Add("not signed in → sign-in page");
                    core.Navigate("https://www.songsterr.com/signin");
                    return;
                }
            }
            if (afterSignIn != null && !signedOut)
            {
                string song = afterSignIn;
                afterSignIn = null;
                hint.Text = IdleHint;
                TestLog?.Add("signed in → back to the song");
                if (!string.Equals(core.Source, song, StringComparison.OrdinalIgnoreCase)) core.Navigate(song);
            }
        }
        catch (Exception ex) { TestLog?.Add("sign-in check failed: " + ex.Message); }
    }

    private static bool IsSongsterr(Uri u) => u.Host == "songsterr.com" || u.Host.EndsWith(".songsterr.com", StringComparison.OrdinalIgnoreCase);

    private void OnNewWindow(object? sender, CoreWebView2NewWindowRequestedEventArgs a)
    {
        if (!Uri.TryCreate(a.Uri, UriKind.Absolute, out Uri? u)) return;
        if (IsSongsterr(u) || u.Scheme == "blob")
        {
            a.Handled = true; // страницы Songsterr (и файл, если они открывают его в новой вкладке) — в этом же окне
            web.CoreWebView2.Navigate(a.Uri);
            return;
        }
        if (AuthHosts.Contains(u.Host, StringComparer.OrdinalIgnoreCase)) return; // окно входа — пусть откроется, вход вернётся сюда
        a.Handled = true;
        if (u.Scheme == Uri.UriSchemeHttps || u.Scheme == Uri.UriSchemeHttp)
            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(u.AbsoluteUri) { UseShellExecute = true });
    }

    private void OnDownloadStarting(object? sender, CoreWebView2DownloadStartingEventArgs a)
    {
        string suggested = Path.GetFileName(a.ResultFilePath);
        if (!TabExts.Contains(Path.GetExtension(suggested).ToLowerInvariant())) return; // остальные загрузки — как в обычном браузере
        try
        {
            Directory.CreateDirectory(saveDir);
            string wanted = Path.Combine(saveDir, CleanName(suggested));
            string target = FreePath(wanted);
            a.ResultFilePath = target;
            a.Handled = true; // без панели загрузок браузера
            hint.Text = "Downloading into your library…";
            TestLog?.Add("download → " + Path.GetFileName(target));
            CoreWebView2DownloadOperation op = a.DownloadOperation;
            op.StateChanged += (_, _) =>
            {
                if (op.State == CoreWebView2DownloadState.Completed) Saved(wanted, target);
                else if (op.State == CoreWebView2DownloadState.Interrupted)
                {
                    hint.Text = $"The download was interrupted ({op.InterruptReason}). Press the download button → Guitar Pro again.";

                    TestLog?.Add("interrupted: " + op.InterruptReason);
                }
            };
        }
        catch (Exception ex)
        {
            a.Cancel = true;
            hint.Text = "Couldn't save the file: " + ex.Message;
        }
    }

    private void Saved(string wanted, string target)
    {
        if (done) return;
        // та же песня уже лежит в библиотеке — вторую копию «Название (2)» не держим
        if (target != wanted && File.Exists(wanted) && SameBytes(wanted, target))
        {
            try { File.Delete(target); target = wanted; } catch (IOException) { }
        }
        done = true;
        SavedPath = target;
        hint.Text = "Saved to your library: Songsterr\\" + Path.GetFileName(target);
        TestLog?.Add("saved: " + Path.GetFileName(target));
        var t = new System.Windows.Forms.Timer { Interval = 900 };
        t.Tick += (_, _) => { t.Stop(); t.Dispose(); Close(); };
        t.Start();
    }

    /// <summary>Имя файла без запрещённых символов и путей; пустое — «Songsterr tab».</summary>
    internal static string CleanName(string name)
    {
        string ext = Path.GetExtension(name).ToLowerInvariant();
        string stem = Path.GetFileNameWithoutExtension(name);
        var bad = Path.GetInvalidFileNameChars();
        stem = new string(stem.Select(c => bad.Contains(c) ? ' ' : c).ToArray());
        stem = string.Join(' ', stem.Split(' ', StringSplitOptions.RemoveEmptyEntries)).Trim('.', ' ');
        if (stem.Length > 120) stem = stem[..120].TrimEnd('.', ' ');
        if (stem.Length == 0) stem = "Songsterr tab";
        return stem + ext;
    }

    /// <summary>Свободное имя: «Название.gp», «Название (2).gp»…</summary>
    internal static string FreePath(string path)
    {
        if (!File.Exists(path)) return path;
        string dir = Path.GetDirectoryName(path)!, stem = Path.GetFileNameWithoutExtension(path), ext = Path.GetExtension(path);
        for (int i = 2; ; i++)
        {
            string p = Path.Combine(dir, $"{stem} ({i}){ext}");
            if (!File.Exists(p)) return p;
        }
    }

    private static bool SameBytes(string a, string b)
    {
        var fa = new FileInfo(a);
        var fb = new FileInfo(b);
        return fa.Length == fb.Length && File.ReadAllBytes(a).AsSpan().SequenceEqual(File.ReadAllBytes(b));
    }
}
