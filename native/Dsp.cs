// Кирпичики обработки сигнала: математика, фильтр, гейт, дилэй, реверб.
// Из них и из блоков в BuiltinRig.cs собраны блоки цепочки (Blocks.cs).
// Всё выделяется заранее; в обработке нет ни одной аллокации.
namespace Lad;

internal static class DspMath
{
    public static float Db(float db) => MathF.Pow(10f, db / 20f);

    /// <summary>Несимметричное «ламповое» насыщение: наклон 1 в нуле, разные потолки полуволн.</summary>
    public static float Tube(float x) => x >= 0 ? MathF.Tanh(x) : 0.85f * MathF.Tanh(x * 1.176f);

    /// <summary>Прозрачно до 0.7, дальше мягко прижимает к 1.</summary>
    public static float SoftLimit(float y)
    {
        float a = MathF.Abs(y);
        if (a <= 0.7f) return y;
        float l = 0.7f + 0.3f * MathF.Tanh((a - 0.7f) / 0.3f);
        return y < 0 ? -l : l;
    }

    public static float Snap(float v) => MathF.Abs(v) < 1e-15f ? 0f : v;
}

/// <summary>Биквад (формулы RBJ), транспонированная прямая форма II.</summary>
internal struct Biquad
{
    private float b0, b1, b2, a1, a2, z1, z2;

    public float Process(float x)
    {
        float y = b0 * x + z1;
        z1 = b1 * x - a1 * y + z2;
        z2 = b2 * x - a2 * y;
        return y;
    }

    public void Snap() { z1 = DspMath.Snap(z1); z2 = DspMath.Snap(z2); }
    public void Reset() { z1 = z2 = 0; }

    private void Set(double B0, double B1, double B2, double A0, double A1, double A2)
    {
        b0 = (float)(B0 / A0); b1 = (float)(B1 / A0); b2 = (float)(B2 / A0);
        a1 = (float)(A1 / A0); a2 = (float)(A2 / A0);
    }

    private static double W(double fs, double f) => 2 * Math.PI * Math.Min(f, fs * 0.45) / fs;

    public void Lowpass(double fs, double f, double q)
    {
        double w = W(fs, f), c = Math.Cos(w), al = Math.Sin(w) / (2 * q);
        Set((1 - c) / 2, 1 - c, (1 - c) / 2, 1 + al, -2 * c, 1 - al);
    }

    public void Highpass(double fs, double f, double q)
    {
        double w = W(fs, f), c = Math.Cos(w), al = Math.Sin(w) / (2 * q);
        Set((1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + al, -2 * c, 1 - al);
    }

    public void Peak(double fs, double f, double q, double db)
    {
        double A = Math.Pow(10, db / 40), w = W(fs, f), c = Math.Cos(w), al = Math.Sin(w) / (2 * q);
        Set(1 + al * A, -2 * c, 1 - al * A, 1 + al / A, -2 * c, 1 - al / A);
    }

    public void LowShelf(double fs, double f, double db)
    {
        double A = Math.Pow(10, db / 40), w = W(fs, f), c = Math.Cos(w);
        double al = Math.Sin(w) / 2 * Math.Sqrt(2), s = 2 * Math.Sqrt(A) * al;
        Set(A * ((A + 1) - (A - 1) * c + s), 2 * A * ((A - 1) - (A + 1) * c), A * ((A + 1) - (A - 1) * c - s),
            (A + 1) + (A - 1) * c + s, -2 * ((A - 1) + (A + 1) * c), (A + 1) + (A - 1) * c - s);
    }

    public void HighShelf(double fs, double f, double db)
    {
        double A = Math.Pow(10, db / 40), w = W(fs, f), c = Math.Cos(w);
        double al = Math.Sin(w) / 2 * Math.Sqrt(2), s = 2 * Math.Sqrt(A) * al;
        Set(A * ((A + 1) + (A - 1) * c + s), -2 * A * ((A - 1) + (A + 1) * c), A * ((A + 1) + (A - 1) * c - s),
            (A + 1) - (A - 1) * c + s, 2 * ((A - 1) - (A + 1) * c), (A + 1) - (A - 1) * c - s);
    }
}

internal sealed class NoiseGate
{
    private float env, gain, openThr, closeThr, attack, release, envRel;
    private int hold, holdLeft;
    private bool open;

    public void Prepare(float fs)
    {
        attack = 1f - MathF.Exp(-1f / (0.002f * fs));
        release = 1f - MathF.Exp(-1f / (0.09f * fs));
        envRel = MathF.Exp(-1f / (0.02f * fs));
        hold = (int)(0.08f * fs);
    }

    public void SetThreshold(float db)
    {
        openThr = DspMath.Db(db);
        closeThr = openThr * 0.6f;
    }

    public float Process(float x)
    {
        float a = MathF.Abs(x);
        env = a > env ? a : env * envRel;
        if (env > openThr) { open = true; holdLeft = hold; }
        else if (env < closeThr && open && --holdLeft <= 0) open = false;
        gain += ((open ? 1f : 0f) - gain) * (open ? attack : release);
        return x * gain;
    }

    public void Snap() { env = DspMath.Snap(env); gain = DspMath.Snap(gain); }
}

internal sealed class Delay
{
    private float[] buf = Array.Empty<float>();
    private int w;
    private float time, timeTarget, feedback, mix, lp, lpCoef, glide;

    public void Prepare(float fs)
    {
        buf = new float[(int)(fs * 1.2f) + 8];
        lpCoef = 1f - MathF.Exp(-2f * MathF.PI * 4000f / fs);
        glide = 1f - MathF.Exp(-1f / (0.12f * fs));
        w = 0;
    }

    public void Set(float fs, float ms, float fb, float mixK)
    {
        timeTarget = Math.Clamp(ms, 20, 1000) * 0.001f * fs;
        if (time == 0) time = timeTarget;
        feedback = Math.Clamp(fb, 0, 0.92f);
        mix = mixK;
    }

    public float Process(float x)
    {
        time += (timeTarget - time) * glide;
        float rp = w - time;
        if (rp < 0) rp += buf.Length;
        int i0 = (int)rp;
        float fr = rp - i0;
        if (i0 >= buf.Length) i0 -= buf.Length; // округление float на стыке буфера
        int i1 = i0 + 1 == buf.Length ? 0 : i0 + 1;
        float d = buf[i0] + (buf[i1] - buf[i0]) * fr;
        lp += (d - lp) * lpCoef;
        buf[w] = x + lp * feedback;
        if (++w == buf.Length) w = 0;
        return x + d * mix;
    }

    public void Snap() { lp = DspMath.Snap(lp); }
}

/// <summary>Реверберация по схеме Freeverb, моно на входе — стерео на выходе.</summary>
internal sealed class Reverb
{
    private static readonly int[] CombLen = { 1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617 };
    private static readonly int[] ApLen = { 556, 441, 341, 225 };
    private const int Spread = 23;

    private readonly float[][] comb = new float[16][];
    private readonly float[] combLp = new float[16];
    private readonly int[] combPos = new int[16];
    private readonly float[][] ap = new float[8][];
    private readonly int[] apPos = new int[8];
    private float fb, damp, mix;

    public void Prepare(float fs)
    {
        float k = fs / 44100f;
        for (int i = 0; i < 8; i++)
        {
            comb[i] = new float[(int)(CombLen[i] * k)];
            comb[i + 8] = new float[(int)((CombLen[i] + Spread) * k)];
        }
        for (int i = 0; i < 4; i++)
        {
            ap[i] = new float[(int)(ApLen[i] * k)];
            ap[i + 4] = new float[(int)((ApLen[i] + Spread) * k)];
        }
    }

    public void Set(float size, float dampK, float mixK)
    {
        fb = 0.72f + 0.26f * size;
        damp = 0.05f + 0.55f * dampK;
        mix = mixK;
    }

    public void Process(float x, out float l, out float r)
    {
        Wet(x, out float wl, out float wr);
        l = x + wl;
        r = x + wr;
    }

    /// <summary>Только «мокрый» сигнал ревербератора (уже с учётом ручки Mix).</summary>
    public void Wet(float x, out float l, out float r)
    {
        float inp = x * 0.03f;
        float sl = 0, sr = 0;
        for (int i = 0; i < 16; i++)
        {
            float[] b = comb[i];
            int p = combPos[i];
            float y = b[p];
            combLp[i] = y * (1 - damp) + combLp[i] * damp;
            b[p] = inp + combLp[i] * fb;
            combPos[i] = p + 1 == b.Length ? 0 : p + 1;
            if (i < 8) sl += y; else sr += y;
        }
        for (int i = 0; i < 8; i++)
        {
            float[] b = ap[i];
            int p = apPos[i];
            float bo = b[p];
            if (i < 4) { b[p] = sl + bo * 0.5f; sl = bo - sl; }
            else { b[p] = sr + bo * 0.5f; sr = bo - sr; }
            apPos[i] = p + 1 == b.Length ? 0 : p + 1;
        }
        l = sl * mix * 1.6f;
        r = sr * mix * 1.6f;
    }

    public void Snap()
    {
        for (int i = 0; i < 16; i++) combLp[i] = DspMath.Snap(combLp[i]);
    }
}
