// Встроенные блоки: овердрайв, трёхканальный усилитель и фильтровые кабинеты.
// Играют в гнёздах цепочки, пока туда не загружен тон с TONE3000; из них собраны заводские пресеты.
namespace Lad;

/// <summary>4-кратная передискретизация: без неё перегруз даёт «песок» на верхах.</summary>
internal sealed class Oversampler4
{
    private const int Taps = 48, Phase = Taps / 4;
    private static readonly float[] H = Design();
    private readonly float[] upHist = new float[Phase];
    private readonly float[] downHist = new float[Taps];
    private int upPos, downPos;

    private static float[] Design()
    {
        var h = new double[Taps];
        const double fc = 0.108; // срез в долях повышенной частоты (чуть ниже 1/8)
        double sum = 0;
        for (int n = 0; n < Taps; n++)
        {
            double t = n - (Taps - 1) / 2.0;
            double sinc = Math.Abs(t) < 1e-9 ? 2 * fc : Math.Sin(2 * Math.PI * fc * t) / (Math.PI * t);
            double x = 2 * Math.PI * n / (Taps - 1);
            double win = 0.35875 - 0.48829 * Math.Cos(x) + 0.14128 * Math.Cos(2 * x) - 0.01168 * Math.Cos(3 * x);
            h[n] = sinc * win;
            sum += h[n];
        }
        return h.Select(v => (float)(v / sum)).ToArray();
    }

    /// <summary>Один входной сэмпл → четыре на повышенной частоте.</summary>
    public void Up(float x, Span<float> o)
    {
        upHist[upPos] = x;
        for (int p = 0; p < 4; p++)
        {
            float acc = 0;
            int idx = upPos;
            for (int k = 0; k < Phase; k++)
            {
                acc += H[4 * k + p] * upHist[idx];
                if (--idx < 0) idx = Phase - 1;
            }
            o[p] = acc * 4f;
        }
        if (++upPos == Phase) upPos = 0;
    }

    /// <summary>Четыре сэмпла на повышенной частоте → один выходной.</summary>
    public float Down(ReadOnlySpan<float> i)
    {
        for (int p = 0; p < 4; p++)
        {
            downHist[downPos] = i[p];
            if (++downPos == Taps) downPos = 0;
        }
        float acc = 0;
        int idx = downPos - 1;
        for (int k = 0; k < Taps; k++)
        {
            if (idx < 0) idx = Taps - 1;
            acc += H[k] * downHist[idx--];
        }
        return acc;
    }
}

/// <summary>Педаль овердрайва в духе «зелёной»: искажается только середина, низ остаётся чистым.</summary>
internal sealed class Overdrive
{
    private readonly Oversampler4 os = new();
    private Biquad hp, tone;
    private float drive, level;

    public void Set(float fs, float driveK, float toneK, float levelK)
    {
        hp.Highpass(fs, 720, 0.707);
        tone.Lowpass(fs, 900 * Math.Pow(5.5, toneK), 0.707);
        drive = 3f + 90f * driveK * driveK;
        level = DspMath.Db(-14f + 28f * levelK);
    }

    public float Process(float x)
    {
        Span<float> buf = stackalloc float[4];
        os.Up(hp.Process(x), buf);
        for (int i = 0; i < 4; i++) buf[i] = MathF.Tanh(buf[i] * drive);
        float y = x * 0.7f + os.Down(buf) * 0.6f;
        return tone.Process(y) * level;
    }

    public void Snap() { hp.Snap(); tone.Snap(); }
}

/// <summary>Усилитель: предусилитель с каскадами насыщения, темброблок, оконечник.</summary>
internal sealed class Amp
{
    private readonly Oversampler4 os = new();
    private Biquad tight, preShape, couple1, couple2, interLp, bass, mid, treble, presence, postHp;
    private float g1, g2, g3, post, master, powerDrive;
    private int channel;

    public void Set(float fs, int ch, float gain, float bassK, float midK, float trebleK, float presK, float masterK)
    {
        channel = Math.Clamp(ch, 0, 2);
        double fo = fs * 4;
        switch (channel)
        {
            case 0: // Clean
                tight.Highpass(fs, 60, 0.707);
                preShape.Peak(fs, 2500, 0.7, 2.5);
                g1 = DspMath.Db(-4f + 22f * gain); g2 = 1f; g3 = 1f;
                post = 2.4f - 1.4f * gain; // на чистом канале каскад почти не добавляет громкости
                break;
            case 1: // Crunch
                tight.Highpass(fs, 90, 0.707);
                preShape.Peak(fs, 900, 0.6, 4);
                g1 = DspMath.Db(8f + 30f * gain); g2 = 3.2f; g3 = 1f;
                post = 0.55f;
                break;
            default: // Lead
                tight.Highpass(fs, 130, 0.707);
                preShape.Peak(fs, 1000, 0.7, 6);
                g1 = DspMath.Db(14f + 32f * gain); g2 = 6f; g3 = 4f;
                post = 0.5f;
                break;
        }
        couple1.Highpass(fo, 35, 0.707);
        couple2.Highpass(fo, 60, 0.707);
        interLp.Lowpass(fo, channel == 0 ? 9000 : 6500, 0.707);

        bass.LowShelf(fs, 120, (bassK - 0.5f) * 26);
        mid.Peak(fs, 680, 0.75, (midK - 0.5f) * 22);
        treble.HighShelf(fs, 2600, (trebleK - 0.5f) * 26);
        presence.Peak(fs, 4200, 0.9, presK * 10 - 2);
        postHp.Highpass(fs, 45, 0.707);

        master = DspMath.Db(-36f + 42f * MathF.Sqrt(masterK)); // до +6 дБ в оконечник
        powerDrive = 1.4f;
    }

    public float Process(float x)
    {
        x = preShape.Process(tight.Process(x));
        Span<float> buf = stackalloc float[4];
        os.Up(x, buf);
        for (int i = 0; i < 4; i++)
        {
            float s = DspMath.Tube(buf[i] * g1);
            s = interLp.Process(couple1.Process(s));
            if (channel >= 1)
            {
                s = DspMath.Tube(-s * g2); // каскад инвертирует фазу — асимметрия чередуется
                s = couple2.Process(s);
                if (channel == 2) s = DspMath.Tube(-s * g3);
            }
            buf[i] = s;
        }
        float y = os.Down(buf) * post;
        y = treble.Process(mid.Process(bass.Process(y)));
        y = postHp.Process(y) * master;
        y = MathF.Tanh(y * powerDrive) / powerDrive; // оконечник мягко сжимает на большой громкости
        return presence.Process(y);
    }

    public void Snap()
    {
        tight.Snap(); preShape.Snap(); couple1.Snap(); couple2.Snap(); interLp.Snap();
        bass.Snap(); mid.Snap(); treble.Snap(); presence.Snap(); postHp.Snap();
    }
}

/// <summary>Кабинет: фильтровая модель АЧХ гитарного динамика.</summary>
internal sealed class Cab
{
    private readonly Biquad[] f = new Biquad[7];

    public void Set(float fs, int type)
    {
        switch (Math.Clamp(type, 0, 2))
        {
            case 0: // 4x12 British
                f[0].Highpass(fs, 85, 1.0); f[1].Peak(fs, 125, 1.2, 3); f[2].Peak(fs, 420, 1.0, -3.5);
                f[3].Peak(fs, 2600, 1.4, 5); f[4].Peak(fs, 3800, 2.0, 2);
                f[5].Lowpass(fs, 4900, 0.6); f[6].Lowpass(fs, 4900, 1.1);
                break;
            case 1: // 2x12 Open
                f[0].Highpass(fs, 100, 0.8); f[1].Peak(fs, 160, 1.0, 2); f[2].Peak(fs, 500, 0.9, -2);
                f[3].Peak(fs, 2200, 1.0, 3.5); f[4].Peak(fs, 4200, 1.6, 1.5);
                f[5].Lowpass(fs, 5600, 0.6); f[6].Lowpass(fs, 5600, 1.0);
                break;
            default: // 1x12 Vintage
                f[0].Highpass(fs, 110, 0.7); f[1].Peak(fs, 200, 1.0, 2.5); f[2].Peak(fs, 800, 0.8, 1.5);
                f[3].Peak(fs, 3000, 1.5, 4); f[4].Peak(fs, 1500, 1.0, -1.5);
                f[5].Lowpass(fs, 4200, 0.6); f[6].Lowpass(fs, 4200, 1.0);
                break;
        }
    }

    public float Process(float x)
    {
        for (int i = 0; i < f.Length; i++) x = f[i].Process(x);
        return x;
    }

    public void Snap() { for (int i = 0; i < f.Length; i++) f[i].Snap(); }
}
