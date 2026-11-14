// Проверка тонов без гитары: «сухая» гитара (DI) по кругу вместо сигнала с входа.
// Риффы синтезируются: струна — модель Карплуса — Стронга (линия задержки длиной в период ноты,
// фильтр потерь в петле), возбуждение медиатором в точке у подставки, съём сигнала звукоснимателем.
// Можно подставить и свою запись DI в WAV.
namespace Lad;

/// <summary>Проигрыватель сэмпла: подменяет вход цепочки. Данные задаёт поток окна, читает аудиопоток.</summary>
internal sealed class SamplePlayer
{
    /// <param name="Raw">своя запись с входа: играет с той же громкостью входа, что и живая гитара</param>
    private sealed record Clip(float[] Data, bool Raw);

    private Clip? clip;
    private Clip? playing;
    private int pos;
    public volatile bool On;

    public void Set(float[] data, bool raw) => Volatile.Write(ref clip, new Clip(data, raw));

    /// <summary>Заполнить вход сэмплом. false — сэмпл не играет, вход остаётся как есть.</summary>
    /// <param name="standard">множитель для обычных сэмплов: снимает громкость входа, чтобы уровень был как у DI</param>
    public bool Fill(Span<float> x, float standard)
    {
        Clip? c = Volatile.Read(ref clip);
        if (!On || c == null || c.Data.Length == 0)
        {
            playing = null; // в следующий раз — с начала
            return false;
        }
        if (!ReferenceEquals(c, playing)) { playing = c; pos = 0; }
        float[] d = c.Data;
        float gain = c.Raw ? 1f : standard;
        int p = pos;
        for (int i = 0; i < x.Length; i++)
        {
            x[i] = d[p] * gain;
            if (++p >= d.Length) p = 0;
        }
        pos = p;
        return true;
    }

    /// <summary>Где сейчас проигрывание (0…1) или −1, если сэмпл не играет.</summary>
    public float Progress => playing is { } c && On ? (float)pos / c.Data.Length : -1f;
}

/// <summary>Запись сигнала с входа (сырого, до всей обработки) — своя DI-дорожка для проверки пресетов.</summary>
internal sealed class Recorder
{
    private float[]? buf;
    private int len;
    private volatile bool on;

    public bool Active => Volatile.Read(ref buf) != null;
    public bool Full => !on && Active;
    public int Length => Volatile.Read(ref len);

    /// <summary>Начать запись; буфер выделяется здесь, в потоке окна.</summary>
    public void Start(int capacity)
    {
        Volatile.Write(ref len, 0);
        Volatile.Write(ref buf, new float[capacity]);
        on = true;
    }

    /// <summary>Аудиопоток: дописать блок. Когда место кончилось, запись встаёт сама.</summary>
    public void Write(ReadOnlySpan<float> x)
    {
        if (!on) return;
        float[]? b = Volatile.Read(ref buf);
        if (b == null) return;
        int l = len;
        int k = Math.Min(x.Length, b.Length - l);
        x[..k].CopyTo(b.AsSpan(l));
        Volatile.Write(ref len, l + k);
        if (l + k >= b.Length) on = false;
    }

    public void Halt() => on = false;

    /// <summary>Забрать записанное (после Halt и завершения текущего колбэка).</summary>
    public float[] Take()
    {
        float[]? b = Volatile.Read(ref buf);
        int l = Volatile.Read(ref len);
        Volatile.Write(ref buf, null);
        return b == null ? [] : b.AsSpan(0, l).ToArray();
    }

    /// <summary>Сохранить как WAV 32 бита float: без потерь, открывается в любой программе.</summary>
    public static void SaveWav(string path, float[] x, int rate)
    {
        using var w = new BinaryWriter(File.Create(path));
        w.Write("RIFF"u8); w.Write(36 + x.Length * 4); w.Write("WAVE"u8);
        w.Write("fmt "u8); w.Write(16); w.Write((short)3); w.Write((short)1); w.Write(rate); w.Write(rate * 4); w.Write((short)4); w.Write((short)32);
        w.Write("data"u8); w.Write(x.Length * 4);
        foreach (float v in x) w.Write(v);
    }
}

internal static class DiSynth
{
    public sealed record Riff(string Id, string Name, string Note);

    public static readonly Riff[] Riffs =
    {
        new("power", "Power chords", "pop punk: palm-muted eighths and an open chorus"),
        new("chug", "Heavy riff", "low-string gallop — for high gain"),
        new("chords", "Open chords", "strummed with a pick: G – D – Em – C"),
        new("arp", "Arpeggios and tapping", "ringing notes in a math-rock vein"),
        new("lead", "Lead", "pentatonic with bends and vibrato"),
        new("neo", "Neo-soul", "fingerstyle seventh chords, double stops with hammer-ons"),
        new("ring", "Chord and pauses", "hear the reverb and delay tails"),
    };

    private static readonly Dictionary<(string, int), float[]> cache = new();

    /// <summary>Рифф по кругу на частоте движка. Результат кэшируется.</summary>
    public static float[] Render(string id, float fs)
    {
        lock (cache)
        {
            var key = (id, (int)fs);
            if (cache.TryGetValue(key, out float[]? done)) return done;
            Score s = Compose(id) ?? throw new ArgumentException("No such sample: " + id);
            float[] r = s.Render(fs, id.Aggregate(17, (h, c) => h * 31 + c));
            cache[key] = r;
            return r;
        }
    }

    /// <summary>Своя запись DI: в моно, на частоту движка, не длиннее двух минут.</summary>
    /// <param name="normalize">чужие записи приводим к обычному уровню; свои записи с входа не трогаем</param>
    public static float[] LoadWav(string path, float fs, bool normalize = true)
    {
        (float[][] ch, int rate) = IrConvolver.ReadWavChannels(path);
        int len = ch[0].Length;
        if (len == 0) throw new IrException("The file has no audio.");

        var mono = new float[len];
        foreach (float[] c in ch)
            for (int i = 0; i < len && i < c.Length; i++) mono[i] += c[i] / ch.Length;
        if (Math.Abs(rate - fs) > 1) mono = IrConvolver.Resample(mono, rate, fs);
        int max = (int)(120 * fs);
        if (mono.Length > max) Array.Resize(ref mono, max);
        // очень тихую или перегруженную запись приводим к обычному уровню DI, остальное не трогаем
        if (!normalize) return mono;
        float peak = 0;
        foreach (float v in mono) peak = MathF.Max(peak, MathF.Abs(v));
        float k = peak < 0.05f ? 0.4f / MathF.Max(peak, 1e-6f) : peak > 0.98f ? 0.9f / peak : 1f;
        if (k != 1f) for (int i = 0; i < mono.Length; i++) mono[i] *= k;
        return mono;
    }

    /// <summary>Для самопроверки: одна нота (или глушёная нота) на заданной струне и ладу.</summary>
    internal static float[] RenderNote(int str, int fret, bool mute, float fs, double seconds)
    {
        var s = new Score(60, seconds, 0.4f);
        s.Note(0, str, fret, seconds, 0.8f, mute ? Kind.Mute : Kind.Pick);
        return s.Render(fs, 7, fold: false);
    }

    // ---------- ноты ----------

    private enum Kind { Pick, Mute, Legato }

    /// <param name="Offset">сдвиг струны внутри боя, секунды</param>
    private readonly record struct Ev(double Beat, int Str, int Fret, double Dur, float Vel, Kind Kind, double Bend, bool Vib, double Offset);

    /// <summary>Аппликатура от 6-й (басовой) струны к 1-й: «3 2 0 0 0 3», x — струна не звучит.</summary>
    private static int?[] C(string s) =>
        s.Split(' ', StringSplitOptions.RemoveEmptyEntries).Select(t => t == "x" ? (int?)null : int.Parse(t)).ToArray();

    /// <summary>Только n верхних звучащих струн аккорда (для боя вверх).</summary>
    private static int?[] Top(int?[] ch, int n)
    {
        var r = (int?[])ch.Clone();
        int kept = 0;
        for (int i = 5; i >= 0; i--)
            if (r[i] != null && ++kept > n) r[i] = null;
        return r;
    }

    private sealed class Score(double bpm, double beats, float peak)
    {
        public static readonly int[] Open = { 40, 45, 50, 55, 59, 64 }; // E A D G B E
        private readonly List<Ev> events = new();

        public void Note(double beat, int str, int fret, double dur, float vel = 0.8f, Kind kind = Kind.Pick, double bend = 0, bool vib = false) =>
            events.Add(new Ev(beat, str, fret, dur, vel, kind, bend, vib, 0));

        public void Strum(double beat, int?[] frets, double dur, bool down = true, float vel = 0.8f, bool mute = false, double spread = 0.012)
        {
            var order = Enumerable.Range(0, 6).Where(i => frets[i] != null).ToList();
            if (!down) order.Reverse();
            for (int k = 0; k < order.Count; k++)
                events.Add(new Ev(beat, order[k], frets[order[k]]!.Value, dur, vel * (1f - 0.035f * k),
                    mute ? Kind.Mute : Kind.Pick, 0, false, k * spread));
        }

        public float[] Render(float fs, int seed, bool fold = true)
        {
            var rng = new Random(seed);
            double spb = 60.0 / bpm;
            int loop = (int)Math.Round(beats * spb * fs);
            int tail = (int)(3.0 * fs);
            var y = new float[loop + tail];
            var strings = new GString[6];
            for (int i = 0; i < 6; i++) strings[i] = new GString(fs, rng);

            // время и сила чуть «гуляют», как у живого гитариста
            var starts = new List<(int at, Ev ev, int id)>();
            var stops = new List<(int at, int str, int id)>();
            for (int id = 0; id < events.Count; id++)
            {
                Ev e = events[id];
                int at = Math.Max(0, (int)((e.Beat * spb + e.Offset + (rng.NextDouble() - 0.5) * 0.006) * fs));
                int end = (int)((e.Beat + e.Dur) * spb * fs);
                starts.Add((at, e with { Vel = e.Vel * (float)(0.92 + rng.NextDouble() * 0.12) }, id));
                stops.Add((Math.Max(end, at + 1), e.Str, id));
            }
            starts.Sort((a, b) => a.at.CompareTo(b.at));
            stops.Sort((a, b) => a.at.CompareTo(b.at));

            int si = 0, oi = 0;
            for (int n = 0; n < y.Length; n++)
            {
                while (si < starts.Count && starts[si].at <= n) { var s = starts[si++]; strings[s.ev.Str].Start(s.ev, s.id); }
                while (oi < stops.Count && stops[oi].at <= n) { var s = stops[oi++]; strings[s.str].Stop(s.id); }
                float v = 0;
                for (int k = 0; k < 6; k++) v += strings[k].Tick();
                y[n] = v;
            }
            // хвост последних нот — в начало: по кругу звук не обрывается
            if (fold) for (int i = 0; i < tail && i < loop; i++) y[i] += y[loop + i];
            Array.Resize(ref y, loop);

            // звукосниматель: резонанс около 4,5 кГц и спад выше; низ ниже 40 Гц убираем
            Biquad hp = default, lp = default;
            hp.Highpass(fs, 40, 0.707);
            lp.Lowpass(fs, 4500, 1.5);
            // первый проход только «разогревает» фильтры концом круга — так шов при повторе чистый
            for (int i = 0; i < y.Length; i++) lp.Process(hp.Process(y[i]));
            for (int i = 0; i < y.Length; i++) y[i] = lp.Process(hp.Process(y[i]));
            float pk = 0;
            foreach (float v in y) pk = MathF.Max(pk, MathF.Abs(v));
            float g = pk > 0 ? peak / pk : 1;
            for (int i = 0; i < y.Length; i++) y[i] *= g;
            return y;
        }
    }

    /// <summary>Одна струна: линия задержки с фильтром потерь, медиатор, звукосниматель.</summary>
    private sealed class GString(float fs, Random rng)
    {
        private const int Size = 8192, Mask = Size - 1;
        private readonly float[] buf = new float[Size];
        private int w, age, current = -1, bendDelay;
        private double basePeriod = 200, bendNow = 1, bendTarget = 1, bendCoef, vibPhase;
        private float loopGain, b = 0.7f, lp, dcX, dcY;
        private bool vib;

        public void Start(Ev e, int id)
        {
            double f = 440 * Math.Pow(2, (Score.Open[e.Str] + e.Fret - 69) / 12.0) * (1 + (rng.NextDouble() - 0.5) * 0.0012);
            basePeriod = fs / f;
            current = id;
            age = 0;
            vib = e.Vib;
            vibPhase = rng.NextDouble() * Math.PI;
            bendNow = 1;
            bendTarget = Math.Pow(2, -e.Bend / 12.0); // бенд укорачивает период
            bendCoef = 1 - Math.Exp(-1 / (0.07 * fs));
            bendDelay = (int)(0.07 * fs);
            // басовые струны звенят дольше; глушение ладонью — коротко и глухо
            double t60 = e.Kind == Kind.Mute ? 0.17 : Math.Clamp(6.5 * Math.Sqrt(82.4 / f), 1.4, 7);
            loopGain = (float)Math.Pow(10, -3.0 / (t60 * f));
            b = e.Kind == Kind.Mute ? 0.3f : Math.Clamp(0.5f + 0.4f * e.Vel, 0.5f, 0.9f);
            if (e.Kind == Kind.Legato)
            {
                Excite(e.Vel * 0.3f, 0.3f, 0.3f); // хаммер, пулл или тэппинг: струна продолжает звучать на новой ноте
                return;
            }
            // медиатор касается струны и гасит прежние колебания — не скачком (это щелчок), а за полторы миллисекунды
            int len = Math.Max(4, (int)basePeriod), ramp = Math.Max(1, Math.Min(len, (int)(0.0015 * fs)));
            for (int k = 0; k < len; k++) buf[(w - len + k) & Mask] *= MathF.Max(0.15f, 1f - 0.85f * k / ramp);
            bool mute = e.Kind == Kind.Mute;
            // глушёная нота тише открытой примерно вдвое, а не вчетверо: возбуждаем сильнее, петля всё равно её быстро гасит
            Excite(mute ? e.Vel * 2f : e.Vel, mute ? 0.09f : 0.3f + 0.45f * e.Vel, mute ? 0.12f : 0.45f);
        }

        public void Stop(int id)
        {
            if (id != current) return; // на струне уже другая нота
            current = -1;
            vib = false;
            double f = fs / basePeriod;
            loopGain = (float)Math.Pow(10, -3.0 / (0.06 * f)); // палец снимает струну с лада
            b = 0.4f;
        }

        /// <summary>Медиатор: треугольный изгиб струны с вершиной у подставки плюс шум касания.</summary>
        private void Excite(float vel, float hardness, float noise)
        {
            int len = Math.Max(4, (int)basePeriod);
            var e = new float[len];
            int at = Math.Max(1, (int)(len * (0.1 + 0.06 * rng.NextDouble())));
            for (int k = 0; k < len; k++)
                e[k] = (k < at ? k / (float)at : (len - k) / (float)(len - at)) + (float)(rng.NextDouble() * 2 - 1) * noise;
            for (int pass = 0; pass < 2; pass++)
            {
                float s = e[0];
                for (int k = 0; k < len; k++) { s += hardness * (e[k] - s); e[k] = s; }
            }
            float mean = 0, peak = 0;
            foreach (float v in e) mean += v / len;
            for (int k = 0; k < len; k++) { e[k] -= mean; peak = MathF.Max(peak, MathF.Abs(e[k])); }
            float g = peak > 0 ? vel * 0.5f / peak : 0;
            for (int k = 0; k < len; k++) buf[(w - len + k) & Mask] += e[k] * g;
        }

        public float Tick()
        {
            age++;
            if (age > bendDelay) bendNow += (bendTarget - bendNow) * bendCoef;
            double p = basePeriod * bendNow;
            if (vib && age > (int)(0.22 * fs))
            {
                p *= 1 + 0.011 * Math.Sin(vibPhase);
                vibPhase += 2 * Math.PI * 5.5 / fs;
            }
            double rp = w - (p - (1 - b) / b); // фильтр в петле задерживает сигнал — вычитаем, чтобы нота не «уплывала»
            int i0 = (int)Math.Floor(rp);
            float fr = (float)(rp - i0);
            float s = buf[i0 & Mask] * (1 - fr) + buf[(i0 + 1) & Mask] * fr;
            lp += b * (s - lp);
            float y = lp * loopGain;
            buf[w & Mask] = y;
            // звукосниматель у подставки: разность колебаний в двух близких точках струны
            float o = y - buf[(w - (int)(p * 0.11)) & Mask];
            w++;
            float dc = o - dcX + 0.995f * dcY;
            dcX = o;
            dcY = dc;
            return dc;
        }
    }

    // ---------- риффы ----------

    private static Score? Compose(string id)
    {
        switch (id)
        {
            case "power":
            {
                // E5 – C5 – G5 – D5: первый круг глушёными восьмыми, второй — открыто, как припев
                var s = new Score(172, 32, 0.42f);
                int?[][] chords = { C("0 2 2 x x x"), C("8 10 10 x x x"), C("3 5 5 x x x"), C("x 5 7 7 x x") };
                for (int bar = 0; bar < 8; bar++)
                {
                    int?[] ch = chords[bar % 4];
                    bool verse = bar < 4;
                    for (int e = 0; e < 8; e++)
                    {
                        bool open = !verse || e == 0 || e == 7;
                        float vel = e == 0 || (!verse && e == 4) ? 0.95f : open ? 0.82f : 0.72f;
                        s.Strum(bar * 4 + e * 0.5, ch, 0.5, true, vel, !open, 0.006);
                    }
                }
                return s;
            }
            case "chug":
            {
                var s = new Score(140, 16, 0.4f);
                int?[] e5 = C("0 2 x x x x"), f5 = C("1 3 3 x x x"), g5 = C("3 5 5 x x x"), bb5 = C("6 8 8 x x x");
                for (int bar = 0; bar < 4; bar++)
                {
                    double b0 = bar * 4;
                    int gallops = bar == 3 ? 2 : 3;
                    for (int beat = 0; beat < gallops; beat++)
                    {
                        double t = b0 + beat;
                        s.Strum(t, e5, 0.5, true, 0.92f, true, 0.004);
                        s.Strum(t + 0.5, e5, 0.25, true, 0.72f, true, 0.004);
                        s.Strum(t + 0.75, e5, 0.25, true, 0.76f, true, 0.004);
                    }
                    if (bar == 3)
                    {
                        s.Strum(b0 + 2, bb5, 2, true, 0.95f, false, 0.006);
                    }
                    else
                    {
                        (int?[] a, int?[] c) = bar == 1 ? (g5, f5) : (f5, g5);
                        s.Strum(b0 + 3, a, 0.5, true, 0.92f, false, 0.006);
                        s.Strum(b0 + 3.5, c, 0.5, true, 0.9f, false, 0.006);
                    }
                }
                return s;
            }
            case "chords":
            {
                var s = new Score(92, 16, 0.45f);
                int?[][] chords = { C("3 2 0 0 0 3"), C("x x 0 2 3 2"), C("0 2 2 0 0 0"), C("x 3 2 0 1 0") };
                (double t, bool down, float vel)[] pat = { (0, true, 0.85f), (1, true, 0.7f), (1.5, false, 0.5f), (2.5, false, 0.55f), (3, true, 0.7f), (3.5, false, 0.5f) };
                for (int bar = 0; bar < 4; bar++)
                    for (int i = 0; i < pat.Length; i++)
                    {
                        double next = i + 1 < pat.Length ? pat[i + 1].t : 4;
                        int?[] frets = pat[i].down ? chords[bar] : Top(chords[bar], 4);
                        s.Strum(bar * 4 + pat[i].t, frets, next - pat[i].t, pat[i].down, pat[i].vel, false, pat[i].down ? 0.016 : 0.011);
                    }
                return s;
            }
            case "arp":
            {
                // шестнадцатые по звенящим открытым струнам, хаммеры, в конце — тэппинг
                var s = new Score(104, 16, 0.3f);
                (int str, int fret, Kind k)[][] bars =
                {
                    new[] { (1, 3, Kind.Pick), (2, 2, Kind.Pick), (3, 0, Kind.Pick), (4, 0, Kind.Pick), (5, 0, Kind.Pick), (4, 0, Kind.Pick), (3, 0, Kind.Pick), (2, 2, Kind.Pick) },
                    new[] { (2, 3, Kind.Pick), (3, 2, Kind.Pick), (4, 1, Kind.Pick), (5, 0, Kind.Pick), (4, 1, Kind.Pick), (3, 0, Kind.Pick), (3, 2, Kind.Legato), (4, 1, Kind.Pick) },
                    new[] { (1, 0, Kind.Pick), (2, 2, Kind.Pick), (3, 0, Kind.Pick), (4, 1, Kind.Pick), (5, 0, Kind.Pick), (5, 3, Kind.Legato), (4, 1, Kind.Pick), (3, 0, Kind.Pick) },
                };
                for (int bar = 0; bar < 3; bar++)
                    for (int i = 0; i < 16; i++)
                    {
                        var (str, fret, k) = bars[bar][i % 8];
                        s.Note(bar * 4 + i * 0.25, str, fret, 1.5, i % 4 == 0 ? 0.72f : 0.58f, k);
                    }
                // тэппинг на си-струне тройками поверх шестнадцатых: 12 — 5 — 8
                s.Note(12, 4, 5, 0.3, 0.6f);
                int[] tap = { 12, 5, 8 };
                for (int i = 1; i < 12; i++) s.Note(12 + i * 0.25, 4, tap[i % 3 == 1 ? 0 : i % 3 == 2 ? 1 : 2], 0.3, i % 3 == 1 ? 0.75f : 0.5f, Kind.Legato);
                int[] g = { 14, 7, 9, 7 };
                for (int i = 0; i < 4; i++) s.Note(15 + i * 0.25, 3, g[i], i == 3 ? 1 : 0.3, i == 0 ? 0.8f : 0.5f, i == 0 ? Kind.Pick : Kind.Legato);
                return s;
            }
            case "lead":
            {
                // ля-минорная пентатоника в пятой позиции
                var s = new Score(96, 16, 0.32f);
                s.Note(0, 4, 8, 0.5); s.Note(0.5, 5, 5, 0.5); s.Note(1, 5, 8, 1, vib: true); s.Note(2, 5, 5, 0.5); s.Note(2.5, 4, 8, 0.5); s.Note(3, 4, 5, 1, vib: true);
                s.Note(4, 3, 7, 1.5, 0.85f, bend: 2, vib: true); s.Note(5.5, 3, 7, 0.5); s.Note(6, 3, 5, 0.5); s.Note(6.5, 2, 7, 1.5, vib: true);
                s.Note(8, 2, 5, 0.25); s.Note(8.25, 2, 7, 0.25, 0.6f, Kind.Legato); s.Note(8.5, 3, 5, 0.5); s.Note(9, 3, 7, 0.5); s.Note(9.5, 4, 5, 0.5);
                s.Note(10, 4, 8, 1, 0.85f, bend: 2, vib: true); s.Note(11, 5, 5, 1, vib: true);
                s.Note(12, 5, 8, 1.5, 0.9f, bend: 2, vib: true); s.Note(13.5, 5, 5, 0.5); s.Note(14, 4, 8, 0.5); s.Note(14.5, 4, 5, 0.5); s.Note(15, 2, 7, 1, vib: true);
                return s;
            }
            case "neo":
            {
                // Gmaj7 – F#m7 – Em9 – A13: аккорд пальцами, двойная нота на соль и си с хаммером на ноты аккорда,
                // короткое заполнение на первой струне; в конце — фраза вниз к началу круга
                var s = new Score(80, 16, 0.32f);
                (int?[] chord, int g0, int g1, int b0, int b1, int e0, int e1)[] bars =
                {
                    (C("3 x 4 4 3 x"), 2, 4, 1, 3, 2, 3), // A→B и C→D; F#→G
                    (C("2 x 2 2 2 x"), 0, 2, 0, 2, 0, 2), // G→A и B→C#; E→F#
                    (C("x 7 5 7 7 x"), 5, 7, 5, 7, 5, 7), // C→D и E→F#; A→B
                    (C("5 x 5 6 7 x"), 4, 6, 5, 7, 0, 0), // B→C# и E→F#
                };
                for (int bar = 0; bar < 4; bar++)
                {
                    var (chord, g0, g1, bf, bt, e0, e1) = bars[bar];
                    double t0 = bar * 4;
                    s.Strum(t0, chord, 1.4, true, 0.6f, false, 0.024); // пальцы перебирают струны чуть врозь
                    s.Note(t0 + 1.5, 3, g0, 0.25, 0.5f);
                    s.Note(t0 + 1.5, 4, bf, 0.25, 0.5f);
                    s.Note(t0 + 1.75, 3, g1, 1.0, 0.55f, Kind.Legato);
                    s.Note(t0 + 1.75, 4, bt, 1.0, 0.55f, Kind.Legato);
                    if (bar < 3)
                    {
                        s.Note(t0 + 2.75, 5, e0, 0.25, 0.5f);
                        s.Note(t0 + 3.0, 5, e1, 0.5, 0.52f, Kind.Legato);
                        s.Note(t0 + 3.5, 4, bt, 0.5, 0.45f);
                    }
                    else
                    {
                        s.Note(t0 + 2.5, 5, 5, 0.5, 0.5f);           // A
                        s.Note(t0 + 3.0, 4, 7, 0.5, 0.48f);          // F#
                        s.Note(t0 + 3.5, 3, 6, 0.25, 0.46f);         // C#
                        s.Note(t0 + 3.75, 3, 4, 0.25, 0.44f, Kind.Legato); // пулл на B
                    }
                }
                return s;
            }
            case "ring":
            {
                // аккорд звенит, глушится — и слышно, как тянется хвост ревера и дилэя
                var s = new Score(70, 8, 0.45f);
                int?[] em = C("0 2 2 0 0 0");
                s.Strum(0, em, 3, true, 0.9f, false, 0.02);
                s.Strum(4, em, 0.3, true, 0.85f, false, 0.012);
                s.Note(6, 5, 12, 1.5, 0.8f, vib: true);
                return s;
            }
        }
        return null;
    }
}
