// Самопроверки без окна: PolyAmp.exe --dsptest out.txt | --asiotest out.txt [драйвер]
using System.Diagnostics;
using System.Globalization;
using System.Text;

namespace Lad;

internal static class Tests
{
    private static readonly CultureInfo Inv = CultureInfo.InvariantCulture;

    /// <summary>Офлайн-прогон цепочки и анализа на синтезированной гитаре.</summary>
    public static int Dsp(string outPath)
    {
        var log = new StringBuilder();
        bool ok = true;
        const float fs = 48000;
        var synth = new Synth();
        synth.Prepare(fs);

        // --- цепочка эффектов ---
        float[] riff = new float[(int)(fs * 3)];
        int[] notes = { 40, 47, 52, 55, 59, 64 };
        for (int k = 0; k < notes.Length; k++)
        {
            float[] nb = synth.Render(notes[k]);
            int start = (int)(k * 0.45f * fs);
            for (int i = 0; i < nb.Length && start + i < riff.Length; i++) riff[start + i] += nb[i] * 0.25f;
        }

        var presets = new (string name, Func<Block[]> build)[]
        {
            ("clean", () => [Make("gate"), Make("polyamp", ("channel", 0), ("gain", 0.4f)), Make("polycab"), Make("reverb")]),
            ("crunch", () => [Make("gate"), Make("polyamp", ("channel", 1), ("gain", 0.6f)), Make("polycab"), Make("reverb")]),
            ("lead+od+delay", () => [Make("gate"), Make("drive"), Make("polyamp", ("channel", 2), ("gain", 0.8f)), Make("polycab"), Make("delay"), Make("reverb")]),
            ("lead max", () => [Make("gate"), Make("drive", ("drive", 1), ("level", 1)),
                Make("polyamp", ("channel", 2), ("gain", 1), ("master", 1), ("bass", 1), ("treble", 1), ("presence", 1)),
                Make("polycab"), Make("delay", ("feedback", 0.9f)), Make("reverb", ("mix", 1))]),
            ("every effect", () => [Make("gate"), Make("comp"), Make("drive"), Make("phaser"), Make("polyamp"), Make("polycab"),
                Make("chorus"), Make("tremolo", ("shape", 2)), Make("delay"), Make("reverb")]),
            ("two amps", () => [Make("drive"), Make("polyamp", ("channel", 1)), Make("polycab"), Make("reverb"), Make("polyamp", ("channel", 0)), Make("polycab", ("type", 2))]),
            ("empty", () => []),
        };

        const int block = 64;
        var input = new float[block];
        var l = new float[block];
        var r = new float[block];
        foreach (var (name, build) in presets)
        {
            var chain = new Chain { OutLevelDb = name == "lead max" ? 6 : name == "empty" ? 0 : -6 };
            chain.SetBlocks(build());
            chain.Prepare(fs, block);

            double sum = 0; float peak = 0; int bad = 0;
            var sw = Stopwatch.StartNew();
            for (int pos = 0; pos + block <= riff.Length; pos += block)
            {
                Array.Copy(riff, pos, input, 0, block);
                chain.Process(input, l, r);
                for (int i = 0; i < block; i++)
                {
                    if (!float.IsFinite(l[i]) || !float.IsFinite(r[i])) bad++;
                    peak = MathF.Max(peak, MathF.Max(MathF.Abs(l[i]), MathF.Abs(r[i])));
                    sum += l[i] * l[i];
                }
            }
            double playMs = sw.Elapsed.TotalMilliseconds;

            // тишина после игры: хвосты должны затухнуть, а не уйти в денормалы и не загрузить процессор
            sw.Restart();
            double tail = 0;
            int tailBlocks = (int)(fs * 4 / block);
            for (int b = 0; b < tailBlocks; b++)
            {
                Array.Clear(input);
                chain.Process(input, l, r);
                if (b >= tailBlocks - 50) for (int i = 0; i < block; i++) tail += l[i] * l[i];
                for (int i = 0; i < block; i++) if (!float.IsFinite(l[i])) bad++;
            }
            double silentMs = sw.Elapsed.TotalMilliseconds;
            double rmsDb = 10 * Math.Log10(sum / riff.Length + 1e-20);
            double tailDb = 10 * Math.Log10(tail / (50 * block) + 1e-20);
            double load = playMs / 3000 * 100, loadSilent = silentMs / 4000 * 100;
            bool pass = bad == 0 && load < 25 && loadSilent < 25 && (name == "lead max" || tailDb < -70);
            ok &= pass;
            log.AppendLine(string.Create(Inv,
                $"chain {name,-14} peak {peak:0.000} rms {rmsDb:0.0} dB tail {tailDb:0} dB cpu {load:0.00}% silent {loadSilent:0.00}% nan {bad} {(pass ? "OK" : "FAIL")}"));
        }

        // --- форматы сэмплов драйверов ASIO: записать и прочитать обратно ---
        {
            float[] sig = new float[64];
            for (int i = 0; i < sig.Length; i++) sig[i] = 0.9f * MathF.Sin(i * 0.37f) - (i == 7 ? 0.9f : 0) + (i == 9 ? 2f : 0) - (i == 11 ? 2f : 0);
            byte[] raw = new byte[sig.Length * 8];
            float[] back = new float[sig.Length];
            foreach (var t in AudioEngine.SupportedTypes)
            {
                unsafe
                {
                    fixed (byte* p = raw)
                    {
                        AudioEngine.WriteSamples(t, (IntPtr)p, sig, sig.Length);
                        AudioEngine.ReadSamples(t, (IntPtr)p, back, back.Length);
                    }
                }
                double bits = t switch
                {
                    NAudio.Wave.Asio.AsioSampleType.Int16LSB or NAudio.Wave.Asio.AsioSampleType.Int32LSB16 => 16,
                    NAudio.Wave.Asio.AsioSampleType.Int32LSB18 => 18,
                    NAudio.Wave.Asio.AsioSampleType.Int32LSB20 => 20,
                    NAudio.Wave.Asio.AsioSampleType.Int24LSB or NAudio.Wave.Asio.AsioSampleType.Int32LSB24 => 24,
                    _ => 24, // float и Int32: точности float хватает с запасом
                };
                double worst = 0;
                for (int i = 0; i < sig.Length; i++) worst = Math.Max(worst, Math.Abs(Math.Clamp(sig[i], -1f, 1f) - back[i]));
                bool pass = worst <= 2.0 / Math.Pow(2, bits - 1);
                ok &= pass;
                log.AppendLine(string.Create(Inv, $"asio format {t,-11} bytes {AudioEngine.BytesPerSample(t)} worst error {worst:0.0e0} {(pass ? "OK" : "FAIL")}"));
            }
        }

        // --- цепочка при разных размерах буфера: ASIO4ALL и встроенные карты дают 256–2048, бывают и нечётные ---
        foreach (int size in new[] { 32, 441, 1024, 2048 })
        {
            var chain = new Chain { OutLevelDb = -6 };
            chain.SetBlocks([Make("gate"), Make("comp"), Make("drive"), Make("phaser"), Make("polyamp"), Make("polycab"),
                Make("chorus"), Make("tremolo"), Make("delay"), Make("reverb")]);
            chain.Prepare(fs, size);
            var bin = new float[size];
            var bl = new float[size];
            var br = new float[size];
            int bad = 0; double sum = 0;
            for (int pos = 0; pos + size <= riff.Length; pos += size)
            {
                Array.Copy(riff, pos, bin, 0, size);
                chain.Process(bin, bl, br);
                for (int i = 0; i < size; i++) { if (!float.IsFinite(bl[i]) || !float.IsFinite(br[i])) bad++; sum += bl[i] * bl[i]; }
            }
            bool pass = bad == 0 && sum > 1e-6;
            ok &= pass;
            log.AppendLine(string.Create(Inv, $"buffer {size,5}: every effect, nan {bad}, rms {10 * Math.Log10(sum / riff.Length + 1e-20):0.0} dB {(pass ? "OK" : "FAIL")}"));
        }

        // --- высота ноты ---
        using (var an = new Analyzer(fs, background: false))
        {
            int miss = 0; double worst = 0;
            for (int m = 40; m <= 84; m++)
            {
                float[] nb = synth.Render(m);
                an.Write(nb.AsSpan(0, (int)(fs * 0.5f)));
                var f = an.AnalyzeNow();
                double cents = f.HasPitch ? Math.Abs(1200 * Math.Log2(f.Freq / (440 * Math.Pow(2, (m - 69) / 12.0)))) : 999;
                if (cents > 8) { miss++; log.AppendLine(string.Create(Inv, $"  pitch MISS midi {m}: {f.Freq:0.0} Hz")); }
                else worst = Math.Max(worst, cents);
            }
            ok &= miss == 0;
            log.AppendLine(string.Create(Inv, $"pitch: misses {miss}/45, worst error {worst:0.00} cents {(miss == 0 ? "OK" : "FAIL")}"));

            // --- хрома: Em и C ---
            an.ChromaEnabled = true;
            var chords = new (string name, int[] midis, int[] pcs)[]
            {
                ("Em", new[] { 40, 47, 52, 55, 59, 64 }, new[] { 4, 7, 11 }),
                ("C", new[] { 48, 52, 55, 60, 64 }, new[] { 0, 4, 7 }),
            };
            foreach (var (name, midis, pcs) in chords)
            {
                var mix = new float[(int)(fs * 0.8f)];
                foreach (int m in midis) { float[] nb = synth.Render(m); for (int i = 0; i < mix.Length; i++) mix[i] += nb[i] * 0.3f; }
                AnalysisFrame f = default;
                for (int pos = 0; pos + 1200 <= mix.Length; pos += 1200) { an.Write(mix.AsSpan(pos, 1200)); f = an.AnalyzeNow(); }
                float inChord = 0, outChord = 0;
                for (int i = 0; i < 12; i++) { if (pcs.Contains(i)) inChord += an.Chroma[i] * an.Chroma[i]; else outChord += an.Chroma[i] * an.Chroma[i]; }
                bool pass = f.HasChroma && inChord > 0.9f;
                ok &= pass;
                log.AppendLine(string.Create(Inv, $"chroma {name}: energy in chord tones {inChord:0.000}, outside {outChord:0.000} {(pass ? "OK" : "FAIL")}"));
                log.AppendLine("  C..B: " + string.Join(" ", an.Chroma.Select(v => v.ToString("0.00", Inv))) + string.Create(Inv, $"  peak {an.ChromaPeakDb:0.0} dB"));
            }
        }

        // --- тремоло ---
        try { ok &= TremoloTests(log); }
        catch (Exception ex) { ok = false; log.AppendLine("TREMOLO TEST ERROR: " + ex); }

        // --- нейромодели NAM и импульсы кабинета ---
        try { ok &= NamTests.Run(log); }
        catch (Exception ex) { ok = false; log.AppendLine("NAM TEST ERROR: " + ex); }

        log.AppendLine(ok ? "RESULT: OK" : "RESULT: FAIL");
        File.WriteAllText(outPath, log.ToString());
        return ok ? 0 : 1;
    }

    /// <summary>Тремоло: без глубины сигнал не меняется, на полной глубине громкость качается почти до нуля.</summary>
    private static bool TremoloTests(StringBuilder log)
    {
        bool ok = true;
        const float fs = 48000;
        {
            // тремоло: при нулевой глубине сигнал не меняется (и гармоническое — низ плюс верх дают исходник),
            // при полной глубине громкость качается почти до нуля с заданной частотой
            float[] Run(Block b, int len)
            {
                b.Prepare(fs, 64);
                var y = new float[len];
                for (int i = 0; i < len; i++) y[i] = 0.5f * MathF.Sin(i * 2 * MathF.PI * 440 / fs);
                for (int o = 0; o < len; o += 64) { b.Sync(); b.ProcessMono(y.AsSpan(o, Math.Min(64, len - o))); }
                return y;
            }
            int len = (int)fs;
            float[] flat = Run(Make("tremolo", ("shape", 2), ("depth", 0)), len);
            double diff = 0;
            for (int i = 0; i < len; i++) diff = Math.Max(diff, Math.Abs(flat[i] - 0.5f * MathF.Sin(i * 2 * MathF.PI * 440 / fs)));
            float[] deep = Run(Make("tremolo", ("shape", 1), ("depth", 1), ("rate", 5)), len);
            // огибающая по кускам в 5 мс во второй половине (глубина успела дойти до цели)
            float lo = 1, hi = 0;
            for (int o = len / 2; o + 240 <= len; o += 240)
            {
                float pk = 0;
                for (int i = o; i < o + 240; i++) pk = MathF.Max(pk, MathF.Abs(deep[i]));
                lo = MathF.Min(lo, pk); hi = MathF.Max(hi, pk);
            }
            bool pass = diff < 1e-4 && lo < 0.05f && hi > 0.45f;
            ok &= pass;
            log.AppendLine(string.Create(Inv, $"tremolo: depth 0 diff {diff:0.000000}, full depth envelope {lo:0.000}…{hi:0.000} {(pass ? "OK" : "FAIL")}"));
        }
        return ok;
    }

    /// <summary>Открывает настоящий ASIO-драйвер на пару секунд (выход заглушён) и меряет, как идёт колбэк.</summary>
    public static int Asio(string outPath, string? wanted)
    {
        var log = new StringBuilder();
        int code = 1;
        try
        {
            string[] drivers = AudioEngine.Drivers();
            log.AppendLine("drivers: " + string.Join(" | ", drivers));
            // без указанного драйвера берём первый, который открывается: в списке бывают драйверы неподключённых устройств
            string[] candidates = wanted != null ? [wanted] : drivers;
            if (candidates.Length == 0) { log.AppendLine("no suitable driver"); return 2; }

            using var engine = new AudioEngine();
            engine.SetGlobal("out.mute", 1); // на выход не идёт ничего
            int frames = 0;
            engine.Message += _ => Interlocked.Increment(ref frames);
            var clock = Stopwatch.StartNew();
            var resets = new List<long>();
            engine.ResetRequested += () => { lock (resets) resets.Add(clock.ElapsedMilliseconds); };
            AudioInfo? opened = null;
            foreach (string d in candidates)
            {
                try { opened = engine.Open(d, 0, 0, 0); break; }
                catch (Exception ex) when (wanted == null) { log.AppendLine($"skipped: {d} ({ex.Message})"); }
            }
            if (opened is not { } info) { log.AppendLine("no driver opened"); return 2; }
            log.AppendLine(string.Create(Inv, $"opened: {info.Driver}, {info.SampleRate} Hz, buffer {info.BufferSize}, type {info.SampleType}"));
            log.AppendLine(string.Create(Inv, $"latency: in {info.InputLatency} + out {info.OutputLatency} samples = {(info.InputLatency + info.OutputLatency) * 1000.0 / info.SampleRate:0.0} ms"));
            log.AppendLine("inputs: " + string.Join(" | ", info.Inputs));
            log.AppendLine("outputs: " + string.Join(" | ", info.Outputs));
            log.AppendLine("rates: " + string.Join(", ", info.Rates));

            var sw = Stopwatch.StartNew();
            float maxRms = 0;
            while (sw.ElapsedMilliseconds < 2500)
            {
                Application.DoEvents();
                Thread.Sleep(10);
                if (sw.ElapsedMilliseconds > 500 && engine.Analyzer != null) maxRms = MathF.Max(maxRms, engine.Analyzer.LastRms);
            }
            double expected = sw.Elapsed.TotalSeconds * info.SampleRate / info.BufferSize;
            log.AppendLine(string.Create(Inv, $"callbacks: {engine.Callbacks} (expected ~{expected:0}), max callback {engine.MaxCallbackMs:0.000} ms of {info.BufferSize * 1000.0 / info.SampleRate:0.000} ms budget"));
            log.AppendLine(string.Create(Inv, $"analysis frames: {frames}, input rms max {maxRms:0.00000}"));
            long firstRun = engine.Callbacks;

            // то же с самой тяжёлой цепочкой и нотами синтезатора
            AudioEngine.BlockSpec Spec(string id, string type, params (string, float)[] ps) =>
                new(id, type, true, null, ps.ToDictionary(x => x.Item1, x => x.Item2), 1);
            engine.ApplyChain([Spec("1", "gate"), Spec("2", "comp"), Spec("3", "drive"), Spec("4", "polyamp", ("channel", 2)),
                Spec("5", "polycab"), Spec("6", "chorus"), Spec("7", "delay"), Spec("8", "reverb")]);
            engine.MaxCallbackMs = 0;
            sw.Restart();
            int note = 40;
            while (sw.ElapsedMilliseconds < 2500)
            {
                Application.DoEvents();
                Thread.Sleep(10);
                if (sw.ElapsedMilliseconds / 300 > note - 40) engine.Synth.Play(note++, 0f, 0, true); // беззвучно: только нагрузка
            }
            log.AppendLine(string.Create(Inv, $"heavy chain: max callback {engine.MaxCallbackMs:0.000} ms"));

            // переоткрытие, как после запроса драйвера на сброс
            engine.Close();
            Thread.Sleep(400);
            long tReopen = clock.ElapsedMilliseconds;
            engine.Open(info.Driver, 0, 0, 0);
            sw.Restart();
            while (sw.ElapsedMilliseconds < 1500) { Application.DoEvents(); Thread.Sleep(10); }
            log.AppendLine(string.Create(Inv, $"after reopen at {tReopen} ms: callbacks {engine.Callbacks} in 1.5 s"));
            lock (resets) log.AppendLine("reset requests at ms: " + (resets.Count == 0 ? "none" : string.Join(", ", resets)));
            if (engine.Fault != null) log.AppendLine("FAULT: " + engine.Fault);
            bool ok = engine.Fault == null && firstRun > expected * 0.8 && engine.Callbacks > 800;
            log.AppendLine(ok ? "RESULT: OK" : "RESULT: FAIL");
            code = ok ? 0 : 1;
        }
        catch (Exception ex)
        {
            log.AppendLine("ERROR: " + ex);
        }
        finally
        {
            File.WriteAllText(outPath, log.ToString());
        }
        return code;
    }

    /// <summary>Блок цепочки с заданными параметрами (остальные — по умолчанию).</summary>
    internal static Block Make(string type, params (string name, float value)[] ps)
    {
        Block b = Block.Create(type) ?? throw new ArgumentException("unknown block type " + type);
        foreach (var (name, value) in ps)
            if (!b.SetParam(name, value)) throw new ArgumentException($"block {type} has no parameter {name}");
        return b;
    }
}
