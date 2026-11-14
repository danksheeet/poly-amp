// Синтезатор эталонных нот и метроном. Ноты готовятся в потоке интерфейса,
// аудиопоток только подмешивает готовые буферы.
namespace Lad;

internal sealed class Synth
{
    private const int MaxVoices = 24;

    private sealed class Voice
    {
        public float[] Buf = Array.Empty<float>();
        public int Pos, Delay;
        public float Gain, Rel;
        public int State; // 0 свободен, 1 звучит, 2 затухает
    }

    private readonly Voice[] voices = Enumerable.Range(0, MaxVoices).Select(_ => new Voice()).ToArray();
    private readonly Dictionary<int, float[]> cache = new();
    private float fs = 48000, relCoef = 0.999f;

    // метроном
    public volatile bool MetroOn;
    public volatile float Bpm = 90;
    public volatile int Beats = 4;
    /// <summary>Счётчик долей: (номер удара &lt;&lt; 4) | индекс доли в такте. Читает поток анализа.</summary>
    public int BeatSeq;
    private double countdown;
    private int beatIndex, beatCount;
    private float clickEnv, clickPhase, clickInc, clickAmp, clickDecay;

    public void Prepare(float sampleRate)
    {
        fs = sampleRate;
        relCoef = MathF.Exp(-1f / (0.012f * fs));
        clickDecay = MathF.Exp(-1f / (0.006f * fs));
        lock (cache) cache.Clear();
        foreach (var v in voices) Volatile.Write(ref v.State, 0);
    }

    /// <summary>Готовый буфер ноты (для самотестов).</summary>
    public float[] Render(int midi) => NoteBuffer(midi);

    private float[] NoteBuffer(int midi)
    {
        lock (cache)
        {
            if (cache.TryGetValue(midi, out var cached)) return cached;
            int n = (int)(fs * 2.4f);
            var buf = new float[n];
            double f = 440.0 * Math.Pow(2, (midi - 69) / 12.0);
            int harmonics = Math.Clamp((int)(6500 / f), 1, 12);
            for (int k = 1; k <= harmonics; k++)
            {
                double amp = Math.Sin(Math.PI * k * 0.18) / k; // щипок на ~1/5 длины струны
                double decay = 1.1 + 0.55 * (k - 1);
                double w = 2 * Math.PI * k * f / fs;
                for (int i = 0; i < n; i++) buf[i] += (float)(amp * Math.Sin(w * i) * Math.Exp(-decay * i / fs));
            }
            float peak = 0;
            for (int i = 0; i < n; i++) peak = MathF.Max(peak, MathF.Abs(buf[i]));
            int attack = (int)(fs * 0.003f), release = (int)(fs * 0.06f);
            for (int i = 0; i < n; i++)
            {
                float g = 0.9f / peak;
                if (i < attack) g *= (float)i / attack;
                if (i > n - release) g *= (float)(n - i) / release;
                buf[i] *= g;
            }
            cache[midi] = buf;
            return buf;
        }
    }

    /// <summary>Поток интерфейса: сыграть ноту.</summary>
    public void Play(int midi, float gain, float delaySec, bool mono)
    {
        if (midi < 20 || midi > 110) return;
        if (mono) StopAll();
        float[] buf = NoteBuffer(midi);
        foreach (var v in voices)
        {
            if (Volatile.Read(ref v.State) != 0) continue;
            v.Buf = buf; v.Pos = 0; v.Delay = (int)(delaySec * fs); v.Gain = gain; v.Rel = 1;
            Volatile.Write(ref v.State, 1);
            return;
        }
    }

    public void StopAll()
    {
        foreach (var v in voices) Interlocked.CompareExchange(ref v.State, 2, 1);
    }

    /// <summary>Аудиопоток: подмешать звучащие ноты.</summary>
    public void Mix(Span<float> o)
    {
        foreach (var v in voices)
        {
            int state = Volatile.Read(ref v.State);
            if (state == 0) continue;
            float[] buf = v.Buf;
            int pos = v.Pos, delay = v.Delay;
            float rel = v.Rel;
            bool done = false;
            for (int i = 0; i < o.Length; i++)
            {
                if (delay > 0) { delay--; continue; }
                if (pos >= buf.Length) { done = true; break; }
                if (state == 2)
                {
                    rel *= relCoef;
                    if (rel < 0.001f) { done = true; break; }
                }
                o[i] += buf[pos++] * v.Gain * rel;
            }
            v.Pos = pos; v.Delay = delay; v.Rel = rel;
            if (done) Volatile.Write(ref v.State, 0);
        }
    }

    /// <summary>Аудиопоток: щелчки метронома (частоты выше диапазона распознавания нот).</summary>
    public void MixClicks(Span<float> o)
    {
        if (!MetroOn)
        {
            countdown = 0; beatIndex = 0; clickEnv = 0;
            return;
        }
        double period = fs * 60.0 / Math.Clamp(Bpm, 30f, 300f);
        int beats = Math.Max(1, Beats);
        for (int i = 0; i < o.Length; i++)
        {
            if (countdown <= 0)
            {
                if (beatIndex >= beats) beatIndex = 0;
                bool accent = beatIndex == 0;
                clickPhase = 0;
                clickEnv = 1;
                clickInc = 2f * MathF.PI * (accent ? 2400f : 1700f) / fs;
                clickAmp = accent ? 0.5f : 0.3f;
                Volatile.Write(ref BeatSeq, (++beatCount << 4) | beatIndex);
                beatIndex++;
                countdown += period;
            }
            countdown -= 1;
            if (clickEnv > 0.0005f)
            {
                o[i] += MathF.Sin(clickPhase) * clickEnv * clickAmp;
                clickPhase += clickInc;
                clickEnv *= clickDecay;
            }
        }
    }
}
