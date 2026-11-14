// Импульсная характеристика кабинета (IR): чтение WAV, приведение к частоте движка и свёртка.
using System.Numerics;
using System.Runtime.CompilerServices;

namespace Lad;

internal sealed class IrException(string message) : Exception(message);

internal sealed class IrConvolver
{
    private const float TargetGain = 0.45f; // подобрано, чтобы громкость совпадала со встроенными кабинетами

    public string Path { get; private init; } = "";
    public string Name { get; private init; } = "";
    public int Taps { get; private init; }
    public int SourceRate { get; private init; }
    public float EngineRate { get; private init; }

    private readonly float[] h;    // характеристика задом наперёд, дополнена нулями
    private readonly float[] hist; // история входа, записана дважды подряд — окно всегда непрерывно
    private readonly int n;
    private int pos;

    private IrConvolver(float[] reversed)
    {
        h = reversed;
        n = reversed.Length;
        hist = new float[n * 2];
    }

    /// <summary>Прочитать WAV и подготовить свёртку для заданной частоты движка.</summary>
    public static IrConvolver Load(string path, float engineRate)
    {
        (float[] samples, int rate) = ReadWav(path);
        if (samples.Length == 0) throw new IrException("The file has no audio data.");

        float peak = 0;
        foreach (float s in samples) peak = MathF.Max(peak, MathF.Abs(s));
        if (peak < 1e-9f) throw new IrException("The IR is empty: the file is silent.");

        // тишину по краям отбрасываем: в начале она только добавляет задержку, в конце — лишнюю работу
        float thr = peak * 1e-4f;
        int first = 0, last = samples.Length - 1;
        while (MathF.Abs(samples[first]) < thr) first++;
        while (MathF.Abs(samples[last]) < thr) last--;
        float[] ir = samples.AsSpan(first, last - first + 1).ToArray();

        if (Math.Abs(rate - engineRate) > 1) ir = Resample(ir, rate, engineRate);

        int max = Math.Min(16384, (int)(8192 * engineRate / 48000f));
        if (ir.Length > max)
        {
            Array.Resize(ref ir, max);
            int fade = Math.Min(256, max / 8); // обрезанный хвост сводим в ноль без щелчка
            for (int i = 0; i < fade; i++) ir[max - 1 - i] *= (float)i / fade;
        }

        // громкость: приводим энергию к опорной (с поправкой на частоту дискретизации)
        double energy = 0;
        foreach (float s in ir) energy += s * (double)s;
        float gain = TargetGain * MathF.Sqrt(48000f / engineRate) / (float)Math.Sqrt(energy);

        int block = Vector<float>.Count * 4;
        int padded = (ir.Length + block - 1) / block * block;
        var rev = new float[padded];
        for (int i = 0; i < ir.Length; i++) rev[padded - 1 - i] = ir[i] * gain;

        var conv = new IrConvolver(rev)
        {
            Path = path,
            Name = System.IO.Path.GetFileNameWithoutExtension(path),
            Taps = ir.Length,
            SourceRate = rate,
            EngineRate = engineRate,
        };
        for (int i = 0; i < 64; i++) conv.Process(0f); // чтобы JIT скомпилировал свёртку заранее
        return conv;
    }

    public float Process(float x)
    {
        hist[pos] = x;
        hist[pos + n] = x;
        if (++pos == n) pos = 0;
        // окно hist[pos .. pos+n) идёт от самого старого сэмпла к самому новому
        ref float a = ref hist[pos];
        ref float b = ref h[0];
        nuint vs = (nuint)Vector<float>.Count, len = (nuint)n;
        Vector<float> s0 = Vector<float>.Zero, s1 = s0, s2 = s0, s3 = s0;
        for (nuint i = 0; i < len; i += vs * 4)
        {
            s0 = Vector.MultiplyAddEstimate(Vector.LoadUnsafe(ref a, i), Vector.LoadUnsafe(ref b, i), s0);
            s1 = Vector.MultiplyAddEstimate(Vector.LoadUnsafe(ref a, i + vs), Vector.LoadUnsafe(ref b, i + vs), s1);
            s2 = Vector.MultiplyAddEstimate(Vector.LoadUnsafe(ref a, i + vs * 2), Vector.LoadUnsafe(ref b, i + vs * 2), s2);
            s3 = Vector.MultiplyAddEstimate(Vector.LoadUnsafe(ref a, i + vs * 3), Vector.LoadUnsafe(ref b, i + vs * 3), s3);
        }
        return Vector.Sum(s0 + s1 + (s2 + s3));
    }

    /// <summary>Передискретизация оконным sinc: значения отсчётов сохраняются, лишние верха срезаются.</summary>
    internal static float[] Resample(float[] x, double srcRate, double dstRate)
    {
        const int half = 24;
        double ratio = srcRate / dstRate;
        double cut = Math.Min(1.0, dstRate / srcRate);
        int outLen = Math.Max(1, (int)Math.Ceiling(x.Length / ratio));
        var y = new float[outLen];
        for (int i = 0; i < outLen; i++)
        {
            double center = i * ratio;
            int c0 = (int)Math.Floor(center);
            double span = half / cut;
            double acc = 0;
            for (int m = (int)Math.Ceiling(c0 - span); m <= (int)Math.Floor(c0 + span + 1); m++)
            {
                if (m < 0 || m >= x.Length) continue;
                double d = center - m;
                double u = d / span; // −1..1 по ширине окна
                if (Math.Abs(u) >= 1) continue;
                double t = d * cut;
                double sinc = Math.Abs(t) < 1e-9 ? 1.0 : Math.Sin(Math.PI * t) / (Math.PI * t);
                double win = 0.42 + 0.5 * Math.Cos(Math.PI * u) + 0.08 * Math.Cos(2 * Math.PI * u);
                acc += x[m] * sinc * win * cut;
            }
            y[i] = (float)acc;
        }
        return y;
    }

    /// <summary>Первый канал WAV-файла в виде float.</summary>
    internal static (float[] samples, int rate) ReadWav(string path)
    {
        (float[][] channels, int rate) = ReadWavChannels(path);
        return (channels[0], rate);
    }

    /// <summary>Все каналы WAV-файла в виде float. PCM 8/16/24/32 бита и float 32/64.</summary>
    internal static (float[][] channels, int rate) ReadWavChannels(string path)
    {
        byte[] d = File.ReadAllBytes(path);
        if (d.Length < 44 || d[0] != 'R' || d[1] != 'I' || d[2] != 'F' || d[3] != 'F' || d[8] != 'W' || d[9] != 'A' || d[10] != 'V' || d[11] != 'E')
            throw new IrException("This isn't a WAV file.");

        int tag = 0, channels = 0, rate = 0, bits = 0, align = 0;
        int dataAt = -1, dataLen = 0;
        int p = 12;
        while (p + 8 <= d.Length)
        {
            string id = System.Text.Encoding.ASCII.GetString(d, p, 4);
            long size = BitConverter.ToUInt32(d, p + 4);
            int body = p + 8;
            if (id == "fmt " && size >= 16 && body + 16 <= d.Length)
            {
                tag = BitConverter.ToUInt16(d, body);
                channels = BitConverter.ToUInt16(d, body + 2);
                rate = BitConverter.ToInt32(d, body + 4);
                align = BitConverter.ToUInt16(d, body + 12);
                bits = BitConverter.ToUInt16(d, body + 14);
                if (tag == 0xFFFE && size >= 40 && body + 26 <= d.Length) tag = BitConverter.ToUInt16(d, body + 24); // extensible
            }
            else if (id == "data")
            {
                dataAt = body;
                dataLen = (int)Math.Min(size, d.Length - body);
                break;
            }
            p = body + (int)Math.Min(size + (size & 1), int.MaxValue / 2);
        }
        if (dataAt < 0 || channels < 1 || rate < 8000 || rate > 384000 || align < 1)
            throw new IrException("Couldn't parse the WAV file.");
        if (!((tag == 1 && bits is 8 or 16 or 24 or 32) || (tag == 3 && bits is 32 or 64)))
            throw new IrException($"Unsupported WAV format (code {tag}, {bits}-bit).");


        int frames = dataLen / align;
        int bytes = bits / 8;
        int used = Math.Min(channels, Math.Max(1, align / bytes));
        var x = new float[used][];
        for (int ch = 0; ch < used; ch++)
        {
            float[] dst = x[ch] = new float[frames];
            for (int i = 0; i < frames; i++)
            {
                int o = dataAt + i * align + ch * bytes;
                dst[i] = (tag, bits) switch
                {
                    (3, 32) => BitConverter.ToSingle(d, o),
                    (3, 64) => (float)BitConverter.ToDouble(d, o),
                    (1, 8) => (d[o] - 128) / 128f,
                    (1, 16) => BitConverter.ToInt16(d, o) / 32768f,
                    (1, 24) => (d[o] | (d[o + 1] << 8) | ((sbyte)d[o + 2] << 16)) / 8388608f,
                    _ => BitConverter.ToInt32(d, o) / 2147483648f,
                };
            }
        }
        return (x, rate);
    }
}
