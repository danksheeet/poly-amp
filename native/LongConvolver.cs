// Свёртка с длинным импульсом (ревербераторы, комнаты, залы) — до нескольких секунд.
// Считать такое «в лоб» нельзя, поэтому импульс режется на куски по 512 сэмплов и сворачивается
// в частотной области (равномерно разбитая свёртка, overlap-save). Работа распределена по времени:
// на каждый входной сэмпл досчитывается своя доля кусков, поэтому всплесков нагрузки нет.
// Задержка «мокрого» сигнала — около 20 мс, для ревербератора это незаметный предилэй.
using System.Numerics;
using System.Runtime.CompilerServices;

namespace Lad;

internal sealed class LongConvolver
{
    private const int B = 512, N = B * 2, Bins = B + 1;
    private const float TargetGain = 0.5f;
    private const double MaxSeconds = 6.0;

    public string Path { get; private init; } = "";
    public string Name { get; private init; } = "";
    public double Milliseconds { get; private init; }
    public bool IsStereo => channels == 2;

    private readonly int channels, parts;
    private readonly float[][] hRe, hIm;      // [канал][кусок * Bins + бин] — спектры кусков импульса
    private readonly float[] xRe, xIm;        // спектры последних входных блоков (кольцо по кускам)
    private readonly float[][] accRe, accIm;  // накопление выходного спектра
    private readonly float[][] outBlock;      // готовый выходной блок, который сейчас проигрывается
    private readonly float[] prev = new float[B], cur = new float[B];
    private readonly float[] re = new float[N], im = new float[N];
    private readonly Fft fft = new(N);
    private int fill, newest, done;

    private LongConvolver(float[][] ir)
    {
        channels = ir.Length;
        int len = ir.Max(c => c.Length);
        parts = Math.Max(1, (len + B - 1) / B);
        hRe = new float[channels][]; hIm = new float[channels][];
        accRe = new float[channels][]; accIm = new float[channels][];
        outBlock = new float[channels][];
        for (int c = 0; c < channels; c++)
        {
            hRe[c] = new float[parts * Bins]; hIm[c] = new float[parts * Bins];
            accRe[c] = new float[Bins + Vector<float>.Count]; accIm[c] = new float[Bins + Vector<float>.Count];
            outBlock[c] = new float[B];
            for (int p = 0; p < parts; p++)
            {
                Array.Clear(re); Array.Clear(im);
                int from = p * B, n = Math.Min(B, ir[c].Length - from);
                if (n > 0) Array.Copy(ir[c], from, re, 0, n);
                fft.Transform(re, im);
                Array.Copy(re, 0, hRe[c], p * Bins, Bins);
                Array.Copy(im, 0, hIm[c], p * Bins, Bins);
            }
        }
        // запас в конце, чтобы векторные операции не выходили за массив
        xRe = new float[parts * Bins + Vector<float>.Count];
        xIm = new float[parts * Bins + Vector<float>.Count];
        for (int c = 0; c < channels; c++)
        {
            Array.Resize(ref hRe[c], parts * Bins + Vector<float>.Count);
            Array.Resize(ref hIm[c], parts * Bins + Vector<float>.Count);
        }
    }

    public static LongConvolver Load(string path, float engineRate)
    {
        (float[][] data, int rate) = IrConvolver.ReadWavChannels(path);
        if (data.Length == 0 || data[0].Length == 0) throw new IrException("The file has no audio data.");
        if (data.Length > 2) data = [data[0], data[1]];

        float peak = 0;
        foreach (float[] c in data) foreach (float s in c) peak = MathF.Max(peak, MathF.Abs(s));
        if (peak < 1e-9f) throw new IrException("The IR is empty: the file is silent.");


        // тишину в начале срезаем одинаково у всех каналов, длинный хвост обрезаем с плавным спадом
        float thr = peak * 1e-4f;
        int first = data[0].Length;
        foreach (float[] c in data)
            for (int i = 0; i < c.Length && i < first; i++)
                if (MathF.Abs(c[i]) >= thr) { first = i; break; }
        if (first >= data[0].Length) first = 0;

        var ir = new float[data.Length][];
        for (int ch = 0; ch < data.Length; ch++)
        {
            float[] c = data[ch].AsSpan(first).ToArray();
            if (Math.Abs(rate - engineRate) > 1) c = IrConvolver.Resample(c, rate, engineRate);
            int max = (int)(MaxSeconds * engineRate);
            if (c.Length > max)
            {
                Array.Resize(ref c, max);
                int fade = (int)(0.2 * engineRate);
                for (int i = 0; i < fade; i++) c[max - 1 - i] *= (float)i / fade;
            }
            ir[ch] = c;
        }

        // громкость: приводим энергию к опорной (общий множитель для обоих каналов, чтобы не сломать стерео)
        double energy = 0;
        foreach (float s in ir[0]) energy += s * (double)s;
        if (ir.Length > 1) { double e2 = 0; foreach (float s in ir[1]) e2 += s * (double)s; energy = Math.Max(energy, e2); }
        float gain = TargetGain * MathF.Sqrt(48000f / engineRate) / (float)Math.Sqrt(energy);
        foreach (float[] c in ir) for (int i = 0; i < c.Length; i++) c[i] *= gain;

        var conv = new LongConvolver(ir)
        {
            Path = path,
            Name = System.IO.Path.GetFileNameWithoutExtension(path),
            Milliseconds = ir[0].Length * 1000.0 / engineRate,
        };
        // прогон тишиной: JIT компилирует свёртку заранее, а не в аудиопотоке
        Span<float> z = stackalloc float[64], a = stackalloc float[64], b = stackalloc float[64];
        for (int i = 0; i < (N * 2) / 64 + 1; i++) { z.Clear(); conv.Process(z, a, b); }
        return conv;
    }

    /// <summary>Только «мокрый» сигнал: моно на входе, стерео на выходе (у моно-импульса каналы одинаковы).</summary>
    public void Process(ReadOnlySpan<float> x, Span<float> wetL, Span<float> wetR)
    {
        float[] oL = outBlock[0], oR = outBlock[channels - 1];
        for (int i = 0; i < x.Length; i++)
        {
            cur[fill] = x[i];
            wetL[i] = oL[fill];
            wetR[i] = oR[fill];
            fill++;
            // к этому моменту должна быть досчитана такая доля кусков, чтобы к границе блока успеть все
            int target = (int)((long)parts * fill / B);
            if (target > done) Accumulate(target);
            if (fill == B)
            {
                Boundary();
                oL = outBlock[0];
                oR = outBlock[channels - 1];
            }
        }
    }

    /// <summary>Выходной спектр = сумма по кускам: спектр входа p блоков назад × спектр p-го куска импульса.</summary>
    private void Accumulate(int target)
    {
        int vs = Vector<float>.Count;
        for (; done < target; done++)
        {
            int slot = newest - done;
            if (slot < 0) slot += parts;
            ref float xr = ref xRe[slot * Bins];
            ref float xi = ref xIm[slot * Bins];
            for (int c = 0; c < channels; c++)
            {
                ref float hr = ref hRe[c][done * Bins];
                ref float hi = ref hIm[c][done * Bins];
                ref float ar = ref accRe[c][0];
                ref float ai = ref accIm[c][0];
                for (int j = 0; j < Bins; j += vs)
                {
                    nuint o = (nuint)j;
                    Vector<float> a = Vector.LoadUnsafe(ref xr, o), b = Vector.LoadUnsafe(ref xi, o);
                    Vector<float> cRe = Vector.LoadUnsafe(ref hr, o), cIm = Vector.LoadUnsafe(ref hi, o);
                    (Vector.LoadUnsafe(ref ar, o) + a * cRe - b * cIm).StoreUnsafe(ref ar, o);
                    (Vector.LoadUnsafe(ref ai, o) + a * cIm + b * cRe).StoreUnsafe(ref ai, o);
                }
            }
        }
    }

    private void Boundary()
    {
        Accumulate(parts);

        // обратное преобразование накопленного спектра → выходной блок (вторая половина окна)
        for (int c = 0; c < channels; c++)
        {
            float[] ar = accRe[c], ai = accIm[c];
            re[0] = ar[0]; im[0] = 0;
            re[B] = ar[B]; im[B] = 0;
            for (int j = 1; j < B; j++)
            {
                // обратное БПФ через прямое: сопрягаем вход, а симметрия спектра даёт вторую половину
                re[j] = ar[j]; im[j] = -ai[j];
                re[N - j] = ar[j]; im[N - j] = ai[j];
            }
            fft.Transform(re, im);
            float[] o = outBlock[c];
            for (int i = 0; i < B; i++) o[i] = re[B + i] * (1f / N);
            Array.Clear(ar);
            Array.Clear(ai);
        }

        // новый входной блок: окно из прошлого и текущего блоков → спектр → в кольцо
        Array.Copy(prev, 0, re, 0, B);
        Array.Copy(cur, 0, re, B, B);
        Array.Clear(im);
        fft.Transform(re, im);
        if (++newest == parts) newest = 0;
        Array.Copy(re, 0, xRe, newest * Bins, Bins);
        Array.Copy(im, 0, xIm, newest * Bins, Bins);
        Array.Copy(cur, prev, B);
        fill = 0;
        done = 0;
    }
}
