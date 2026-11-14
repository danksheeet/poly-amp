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

        ApplicationConfiguration.Initialize();
        Application.Run(new MainForm(args));
        return 0;
    }
}
