using System.Runtime;

namespace Lad;

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        // аудиоколбэк не должен ждать сборщика мусора
        GCSettings.LatencyMode = GCLatencyMode.SustainedLowLatency;

        if (args.Length >= 2 && args[0] == "--dsptest") return Tests.Dsp(args[1]);
        if (args.Length >= 2 && args[0] == "--maketest") { NamTests.WriteSamples(args[1]); return 0; }
        if (args.Length >= 2 && args[0] == "--asiotest") return Tests.Asio(args[1], args.ElementAtOrDefault(2));
        // процесс-сканер плагинов VST3: загружает один модуль и выходит (звук и окно не открываются)
        if (args.Length >= 3 && args[0] == "--vst3scan") return Vst3Scanner.ScanChild(args[1], args[2]);

        ApplicationConfiguration.Initialize();
        Application.Run(new MainForm(args));
        return 0;
    }
}

/// <summary>Иконка приложения для окон (шестиугольник с волной — как логотип в шапке).</summary>
internal static class AppIcon
{
    private static Icon? icon;

    public static Icon Get()
    {
        if (icon != null) return icon;
        using Stream? s = typeof(AppIcon).Assembly.GetManifestResourceStream("PolyAmp.app.ico");
        return icon = s != null ? new Icon(s) : SystemIcons.Application;
    }
}
