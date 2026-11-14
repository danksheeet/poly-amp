// Анализ входа в отдельном потоке: высота ноты (YIN), спектр для аккордов, уровни.
// Аудиопоток только складывает сэмплы в кольцевой буфер и будит анализатор.
using System.Globalization;
using System.Text;

namespace Lad;

/// <summary>Определение высоты одиночной ноты (YIN). Порт public/js/pitch.js.</summary>
internal sealed class Yin
{
    private readonly float sr, threshold;
    private readonly int w, tauMin, tauMax;
    private readonly float[] d;
    public int Need { get; }

    public Yin(float sampleRate, int window = 2048, float fMin = 62, float fMax = 1400, float threshold = 0.13f)
    {
        sr = sampleRate;
        w = window;
        this.threshold = threshold;
        tauMin = Math.Max(2, (int)MathF.Floor(sampleRate / fMax));
        tauMax = (int)MathF.Ceiling(sampleRate / fMin);
        Need = w + tauMax + 1;
        d = new float[tauMax + 2];
    }

    public bool Detect(ReadOnlySpan<float> x, out float freq, out float clarity)
    {
        freq = 0; clarity = 0;
        int off = x.Length - Need;
        if (off < 0) return false;
        ReadOnlySpan<float> a = x.Slice(off, w);

        double run = 0;
        int tau = -1;
        d[0] = 1;
        for (int t = 1; t <= tauMax; t++)
        {
            ReadOnlySpan<float> b = x.Slice(off + t, w);
            float s = 0;
            for (int j = 0; j < a.Length; j++)
            {
                float v = a[j] - b[j];
                s += v * v;
            }
            run += s;
            d[t] = run > 0 ? (float)(s * t / run) : 1f;
            if (t > tauMin && d[t - 1] < threshold && d[t] >= d[t - 1]) { tau = t - 1; break; }
        }

        if (tau < 0)
        {
            int best = tauMin;
            for (int t = tauMin + 1; t < tauMax; t++) if (d[t] < d[best]) best = t;
            if (d[best] > 0.28f) return false;
            tau = best;
        }

        float p0 = d[tau - 1], p1 = d[tau], p2 = d[tau + 1];
        float denom = p0 - 2 * p1 + p2;
        float shift = denom > 1e-9f ? Math.Clamp(0.5f * (p0 - p2) / denom, -0.5f, 0.5f) : 0f;
        freq = sr / (tau + shift);
        clarity = 1 - p1;
        return true;
    }
}

/// <summary>Комплексное БПФ по основанию 2, на месте.</summary>
internal sealed class Fft
{
    private readonly int n, bits;
    private readonly float[] cos, sin;
    private readonly int[] rev;

    public Fft(int size)
    {
        n = size;
        bits = (int)Math.Log2(size);
        cos = new float[n / 2];
        sin = new float[n / 2];
        for (int i = 0; i < n / 2; i++)
        {
            cos[i] = (float)Math.Cos(2 * Math.PI * i / n);
            sin[i] = (float)Math.Sin(2 * Math.PI * i / n);
        }
        rev = new int[n];
        for (int i = 0; i < n; i++)
        {
            int r = 0;
            for (int b = 0; b < bits; b++) if ((i & (1 << b)) != 0) r |= 1 << (bits - 1 - b);
            rev[i] = r;
        }
    }

    public void Transform(float[] re, float[] im)
    {
        for (int i = 0; i < n; i++)
        {
            int r = rev[i];
            if (r > i) { (re[i], re[r]) = (re[r], re[i]); (im[i], im[r]) = (im[r], im[i]); }
        }
        for (int len = 2; len <= n; len <<= 1)
        {
            int half = len >> 1, step = n / len;
            for (int i = 0; i < n; i += len)
            {
                for (int k = 0, t = 0; k < half; k++, t += step)
                {
                    int a = i + k, b = a + half;
                    float wr = cos[t], wi = -sin[t];
                    float xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
                    re[b] = re[a] - xr; im[b] = im[a] - xi;
                    re[a] += xr; im[a] += xi;
                }
            }
        }
    }
}

/// <summary>Хрома-вектор из спектра. Порт public/js/chroma.js (вместе с поведением AnalyserNode).</summary>
internal sealed class ChromaAnalyzer
{
    public const int Size = 16384;
    private const float FLo = 72, FHi = 1400, Smoothing = 0.55f;
    private readonly Fft fft = new(Size);
    private readonly float[] window = new float[Size], re = new float[Size], im = new float[Size];
    private readonly float[] mag = new float[Size / 2], db = new float[Size / 2];
    private readonly float binHz;
    public readonly float[] Chroma = new float[12];
    public float PeakDb { get; private set; }

    public ChromaAnalyzer(float sampleRate)
    {
        binHz = sampleRate / Size;
        for (int i = 0; i < Size; i++)
        {
            double x = 2 * Math.PI * i / Size;
            window[i] = (float)(0.42 - 0.5 * Math.Cos(x) + 0.08 * Math.Cos(2 * x));
        }
    }

    public void Reset() => Array.Clear(mag);

    public void Analyze(ReadOnlySpan<float> x)
    {
        ReadOnlySpan<float> src = x.Slice(x.Length - Size);
        for (int i = 0; i < Size; i++) { re[i] = src[i] * window[i]; im[i] = 0; }
        fft.Transform(re, im);

        int lo = Math.Max(2, (int)(FLo / binHz));
        int hi = Math.Min(Size / 2 - 2, (int)MathF.Ceiling(FHi / binHz));
        float peak = float.NegativeInfinity;
        for (int i = lo - 1; i <= hi + 1; i++)
        {
            float m = MathF.Sqrt(re[i] * re[i] + im[i] * im[i]) / Size;
            mag[i] = mag[i] * Smoothing + m * (1 - Smoothing);
            db[i] = 20f * MathF.Log10(mag[i] + 1e-12f);
            if (i >= lo && i <= hi && db[i] > peak) peak = db[i];
        }
        PeakDb = peak;
        Array.Clear(Chroma);

        float floor = peak - 34f;
        for (int i = lo; i <= hi; i++)
        {
            float v = db[i];
            if (v < floor || v <= db[i - 1] || v < db[i + 1]) continue;
            float a = db[i - 1], c = db[i + 1];
            float denom = a - 2 * v + c;
            float p = denom < -1e-6f ? 0.5f * (a - c) / denom : 0f;
            float f = (i + p) * binHz;
            float m = 69f + 12f * MathF.Log2(f / 440f);
            int r = (int)MathF.Round(m);
            if (MathF.Abs(m - r) > 0.4f) continue;
            float amp = MathF.Pow(10f, (v - peak) / 20f);
            Chroma[((r % 12) + 12) % 12] += MathF.Sqrt(amp) * (f > 700 ? 0.5f : 1f);
        }
        float norm = 0;
        for (int i = 0; i < 12; i++) norm += Chroma[i] * Chroma[i];
        norm = MathF.Sqrt(norm);
        if (norm > 0) for (int i = 0; i < 12; i++) Chroma[i] /= norm;
    }
}

/// <summary>Результат одного кадра анализа.</summary>
internal struct AnalysisFrame
{
    public float Rms, Hf, Freq, Clarity;
    public bool HasPitch, HasChroma;
}

/// <summary>Кольцевой буфер входа + поток анализа, который ~40 раз в секунду шлёт кадр в интерфейс.</summary>
internal sealed class Analyzer : IDisposable
{
    private const int RingSize = 1 << 16, Mask = RingSize - 1, Work = ChromaAnalyzer.Size;
    private readonly float[] ring = new float[RingSize];
    private readonly float[] work = new float[Work];
    private readonly AutoResetEvent wake = new(false);
    private readonly Thread thread;
    private readonly int dec, hop, hfLen;
    private readonly Yin yin;
    private readonly ChromaAnalyzer chroma;
    private long written;
    private float acc;
    private int accCount, sinceHop;
    private volatile bool running = true;

    public volatile bool ChromaEnabled;
    /// <summary>Вызывается из потока анализа с готовым JSON кадра.</summary>
    public Action<string>? Post;
    /// <summary>Дополнительные поля кадра (уровни, загрузка) — их дописывает движок.</summary>
    public Action<StringBuilder>? Extra;

    public float AnalysisRate { get; }

    /// <summary>Громкость входа из последнего кадра (для самотеста).</summary>
    public volatile float LastRms;

    /// <param name="background">false — без потока, анализ вызывается вручную через AnalyzeNow (самотест)</param>
    public Analyzer(float sampleRate, bool background = true)
    {
        dec = Math.Clamp((int)(sampleRate / 40000f), 1, 8);
        AnalysisRate = sampleRate / dec;
        hop = (int)(AnalysisRate * 0.025f);
        hfLen = (int)MathF.Ceiling(AnalysisRate * 0.03f);
        yin = new Yin(AnalysisRate);
        chroma = new ChromaAnalyzer(AnalysisRate);
        thread = new Thread(Loop) { IsBackground = true, Name = "Lad analysis", Priority = ThreadPriority.AboveNormal };
        if (background) thread.Start();
        else running = false;
    }

    /// <summary>Аудиопоток: добавить блок сэмплов.</summary>
    public void Write(ReadOnlySpan<float> x)
    {
        long w = written;
        bool signal = false;
        for (int i = 0; i < x.Length; i++)
        {
            acc += x[i];
            if (++accCount < dec) continue;
            ring[(int)(w & Mask)] = acc / dec;
            w++;
            acc = 0; accCount = 0;
            if (++sinceHop >= hop) { sinceHop = 0; signal = true; }
        }
        Volatile.Write(ref written, w);
        if (signal) wake.Set();
    }

    /// <summary>Синхронный анализ последних сэмплов (используется потоком и самотестом).</summary>
    public AnalysisFrame AnalyzeNow()
    {
        long w = Volatile.Read(ref written);
        for (int i = 0; i < Work; i++) work[i] = ring[(int)((w - Work + i) & Mask)];
        ReadOnlySpan<float> x = work;

        var f = new AnalysisFrame();
        double e = 0;
        for (int i = Work - 1024; i < Work; i++) e += x[i] * x[i];
        f.Rms = (float)Math.Sqrt(e / 1024);
        double h = 0;
        for (int i = Work - hfLen; i < Work; i++) { float dv = x[i] - x[i - 1]; h += dv * dv; }
        f.Hf = (float)Math.Sqrt(h / hfLen);

        if (f.Rms > 0.0015f && yin.Detect(x.Slice(Work - 4096), out float freq, out float clarity))
        {
            f.HasPitch = true; f.Freq = freq; f.Clarity = clarity;
        }
        if (ChromaEnabled) { chroma.Analyze(x); f.HasChroma = true; }
        return f;
    }

    public float[] Chroma => chroma.Chroma;
    public float ChromaPeakDb => chroma.PeakDb;

    private void Loop()
    {
        var sb = new StringBuilder(512);
        var inv = CultureInfo.InvariantCulture;
        while (running)
        {
            wake.WaitOne(120);
            if (!running) break;
            AnalysisFrame f = AnalyzeNow();
            LastRms = f.Rms;
            sb.Clear();
            sb.Append("{\"t\":\"frame\",\"rms\":").Append(f.Rms.ToString("0.#####", inv));
            sb.Append(",\"hf\":").Append(f.Hf.ToString("0.######", inv));
            if (f.HasPitch)
            {
                sb.Append(",\"freq\":").Append(f.Freq.ToString("0.###", inv));
                sb.Append(",\"clarity\":").Append(f.Clarity.ToString("0.###", inv));
            }
            if (f.HasChroma)
            {
                sb.Append(",\"peakDb\":").Append(Math.Max(-200f, chroma.PeakDb).ToString("0.#", inv));
                sb.Append(",\"chroma\":[");
                for (int i = 0; i < 12; i++)
                {
                    if (i > 0) sb.Append(',');
                    sb.Append(chroma.Chroma[i].ToString("0.####", inv));
                }
                sb.Append(']');
            }
            Extra?.Invoke(sb);
            sb.Append('}');
            Post?.Invoke(sb.ToString());
        }
    }

    public void Dispose()
    {
        running = false;
        wake.Set();
        if (thread.IsAlive && thread != Thread.CurrentThread) thread.Join(500);
        wake.Dispose();
    }
}
