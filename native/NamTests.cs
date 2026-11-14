// Самопроверка NAM и IR: быстрый векторный код сверяется с наивной реализацией,
// написанной «в лоб» по описанию формата, на синтетических моделях со случайными весами.
using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Text.Json;

namespace Lad;

internal static class NamTests
{
    private static readonly CultureInfo Inv = CultureInfo.InvariantCulture;

    private sealed record ArrCfg(int In, int Head, int C, int K, int[] Dil, bool HeadBias, string Act = "Tanh");

    private static readonly int[] Dilations = { 1, 2, 4, 8, 16, 32, 64, 128, 256, 512 };

    public static bool Run(StringBuilder log)
    {
        bool ok = true;
        var rng = new Random(12345);
        float[] x = TestSignal(4800, rng);

        var nets = new (string name, ArrCfg[] cfg)[]
        {
            ("standard 16/8", new[] { new ArrCfg(1, 8, 16, 3, Dilations, false), new ArrCfg(16, 1, 8, 3, Dilations, true) }),
            ("lite 12/6", new[] { new ArrCfg(1, 6, 12, 3, new[] { 1, 2, 4, 8, 16, 32, 64 }, false), new ArrCfg(12, 1, 6, 3, new[] { 128, 256, 512, 1, 2, 4, 8, 16, 32, 64, 128, 256, 512 }, true) }),
            ("nano 4/2 relu", new[] { new ArrCfg(1, 2, 4, 3, new[] { 1, 2, 4, 8, 16, 32, 64 }, false, "ReLU"), new ArrCfg(4, 1, 2, 3, new[] { 128, 256, 512, 1, 2, 4, 8 }, true, "Hardtanh") }),
            ("odd 19/5/3 k5", new[] { new ArrCfg(1, 5, 19, 5, new[] { 1, 3, 9 }, true), new ArrCfg(19, 3, 5, 2, new[] { 1, 2 }, false, "LeakyReLU"), new ArrCfg(5, 1, 3, 1, new[] { 1 }, true) }),
        };
        foreach (var (name, cfg) in nets)
        {
            int count = cfg.Sum(a => a.C * a.In + a.Dil.Length * (a.C * a.C * a.K + a.C + a.C + a.C * a.C + a.C) + a.Head * a.C + (a.HeadBias ? a.Head : 0)) + 1;
            float[] w = RandomWeights(count, rng, 0.16f);
            w[^1] = 0.02f;
            using JsonDocument doc = JsonDocument.Parse(WaveNetConfig(cfg));
            var fast = NamWaveNet.Create(doc.RootElement, w);
            var got = new float[x.Length];
            for (int o = 0; o < x.Length; o += 37) // нарочно некратный блок
                fast.Process(x.AsSpan(o, Math.Min(37, x.Length - o)), got.AsSpan(o, Math.Min(37, x.Length - o)));
            float[] want = NaiveWaveNet(cfg, w, x);
            ok &= Compare(log, $"wavenet {name} ({count} weights)", got, want);
        }

        // стандартная модель должна иметь ровно столько параметров, сколько у настоящих файлов NAM
        {
            ArrCfg[] cfg = nets[0].cfg;
            int count = cfg.Sum(a => a.C * a.In + a.Dil.Length * (a.C * a.C * a.K + a.C + a.C + a.C * a.C + a.C) + a.Head * a.C + (a.HeadBias ? a.Head : 0)) + 1;
            bool pass = count == 13802;
            ok &= pass;
            log.AppendLine($"wavenet standard parameter count {count} (reference 13802) {(pass ? "OK" : "FAIL")}");
        }

        foreach (var (layers, hidden) in new[] { (1, 16), (2, 24), (3, 11) })
        {
            int count = 0;
            for (int l = 0; l < layers; l++) { int I = l == 0 ? 1 : hidden; count += 4 * hidden * (I + hidden) + 4 * hidden + 2 * hidden; }
            count += hidden + 1;
            float[] w = RandomWeights(count, rng, 0.3f);
            using JsonDocument doc = JsonDocument.Parse($"{{\"input_size\":1,\"hidden_size\":{hidden},\"num_layers\":{layers}}}");
            var fast = NamLstm.Create(doc.RootElement, w, 48000);
            var got = new float[x.Length];
            fast.Process(x, got);
            ok &= Compare(log, $"lstm {layers}x{hidden} ({count} weights)", got, NaiveLstm(layers, hidden, w, x));
        }

        // отказ на неподдерживаемых файлах должен быть внятным, а не падением
        ok &= Refuses(log, "gated wavenet", () =>
        {
            using JsonDocument d = JsonDocument.Parse(WaveNetConfig(nets[0].cfg).Replace("\"gated\":false", "\"gated\":true"));
            NamWaveNet.Create(d.RootElement, new float[13802]);
        });
        ok &= Refuses(log, "unknown layer key", () =>
        {
            using JsonDocument d = JsonDocument.Parse(WaveNetConfig(nets[0].cfg).Replace("\"gated\":false", "\"gated\":false,\"groups\":2"));
            NamWaveNet.Create(d.RootElement, new float[13802]);
        });
        ok &= Refuses(log, "wrong weight count", () =>
        {
            using JsonDocument d = JsonDocument.Parse(WaveNetConfig(nets[0].cfg));
            NamWaveNet.Create(d.RootElement, new float[13000]);
        });

        ok &= FileRoundTrip(log, nets[0].cfg, rng);
        ok &= IrTest(log, rng);
        ok &= LongIrTest(log, rng);
        ok &= Performance(log, nets[0].cfg, rng);
        ok &= Official(log);
        return ok;
    }

    private static float[] TestSignal(int n, Random rng)
    {
        var x = new float[n];
        for (int i = 0; i < n; i++)
            x[i] = 0.4f * MathF.Sin(2 * MathF.PI * 110 * i / 48000f) * MathF.Exp(-i / 9000f)
                 + 0.15f * MathF.Sin(2 * MathF.PI * 587 * i / 48000f) + 0.02f * (float)(rng.NextDouble() * 2 - 1);
        return x;
    }

    private static float[] RandomWeights(int n, Random rng, float scale)
    {
        var w = new float[n];
        for (int i = 0; i < n; i++) w[i] = (float)(rng.NextDouble() * 2 - 1) * scale;
        return w;
    }

    private static string WaveNetConfig(ArrCfg[] cfg)
    {
        var sb = new StringBuilder("{\"layers\":[");
        for (int i = 0; i < cfg.Length; i++)
        {
            ArrCfg a = cfg[i];
            if (i > 0) sb.Append(',');
            sb.Append($"{{\"input_size\":{a.In},\"condition_size\":1,\"head_size\":{a.Head},\"channels\":{a.C},\"kernel_size\":{a.K},");
            sb.Append($"\"dilations\":[{string.Join(",", a.Dil)}],\"activation\":\"{a.Act}\",\"gated\":false,\"head_bias\":{(a.HeadBias ? "true" : "false")}}}");
        }
        return sb.Append("],\"head\":null,\"head_scale\":0.02}").ToString();
    }

    private static bool Compare(StringBuilder log, string name, float[] got, float[] want)
    {
        float maxDiff = 0, maxAbs = 0;
        bool finite = true;
        for (int i = 0; i < got.Length; i++)
        {
            finite &= float.IsFinite(got[i]);
            maxDiff = MathF.Max(maxDiff, MathF.Abs(got[i] - want[i]));
            maxAbs = MathF.Max(maxAbs, MathF.Abs(want[i]));
        }
        bool pass = finite && maxAbs > 1e-6f && maxDiff < maxAbs * 2e-3f;
        log.AppendLine(string.Create(Inv, $"{name}: max |diff| {maxDiff:0.0e0} of peak {maxAbs:0.000} {(pass ? "OK" : "FAIL")}"));
        return pass;
    }

    private static bool Refuses(StringBuilder log, string name, Action act)
    {
        try { act(); }
        catch (NamException) { log.AppendLine($"refuses {name}: OK"); return true; }
        catch (Exception ex) { log.AppendLine($"refuses {name}: FAIL ({ex.GetType().Name})"); return false; }
        log.AppendLine($"refuses {name}: FAIL (accepted)");
        return false;
    }

    // ---------- наивные реализации ----------

    private static float[] NaiveWaveNet(ArrCfg[] cfg, float[] w, float[] x)
    {
        int p = 0;
        int A = cfg.Length;
        var rech = new float[A][,];
        var conv = new float[A][][,,];
        var cb = new float[A][][]; var mix = new float[A][][]; var w1 = new float[A][][,]; var b1 = new float[A][][];
        var headW = new float[A][,]; var headB = new float[A][];
        for (int a = 0; a < A; a++)
        {
            ArrCfg c = cfg[a];
            int L = c.Dil.Length;
            rech[a] = new float[c.C, c.In];
            for (int i = 0; i < c.C; i++) for (int j = 0; j < c.In; j++) rech[a][i, j] = w[p++];
            conv[a] = new float[L][,,]; cb[a] = new float[L][]; mix[a] = new float[L][]; w1[a] = new float[L][,]; b1[a] = new float[L][];
            for (int l = 0; l < L; l++)
            {
                conv[a][l] = new float[c.K, c.C, c.C];
                for (int i = 0; i < c.C; i++) for (int j = 0; j < c.C; j++) for (int k = 0; k < c.K; k++) conv[a][l][k, i, j] = w[p++];
                cb[a][l] = new float[c.C]; for (int i = 0; i < c.C; i++) cb[a][l][i] = w[p++];
                mix[a][l] = new float[c.C]; for (int i = 0; i < c.C; i++) mix[a][l][i] = w[p++];
                w1[a][l] = new float[c.C, c.C];
                for (int i = 0; i < c.C; i++) for (int j = 0; j < c.C; j++) w1[a][l][i, j] = w[p++];
                b1[a][l] = new float[c.C]; for (int i = 0; i < c.C; i++) b1[a][l][i] = w[p++];
            }
            headW[a] = new float[c.Head, c.C];
            for (int i = 0; i < c.Head; i++) for (int j = 0; j < c.C; j++) headW[a][i, j] = w[p++];
            headB[a] = new float[c.Head];
            if (c.HeadBias) for (int i = 0; i < c.Head; i++) headB[a][i] = w[p++];
        }
        float headScale = w[p++];
        if (p != w.Length) throw new InvalidOperationException("naive: weight count");

        // история входа каждого слоя за всё время
        var hist = new List<float[]>[A][];
        for (int a = 0; a < A; a++) hist[a] = cfg[a].Dil.Select(_ => new List<float[]>()).ToArray();

        var y = new float[x.Length];
        for (int t = 0; t < x.Length; t++)
        {
            float cond = x[t];
            float[] layerIn = { cond };
            float[] headAcc = new float[cfg[0].C];
            for (int a = 0; a < A; a++)
            {
                ArrCfg c = cfg[a];
                NamActivation act = c.Act switch { "ReLU" => NamActivation.Relu, "Hardtanh" => NamActivation.HardTanh, "LeakyReLU" => NamActivation.LeakyRelu, _ => NamActivation.Tanh };
                var cur = new float[c.C];
                for (int i = 0; i < c.C; i++) for (int j = 0; j < c.In; j++) cur[i] += rech[a][i, j] * layerIn[j];
                for (int l = 0; l < c.Dil.Length; l++)
                {
                    hist[a][l].Add(cur);
                    var z = new float[c.C];
                    for (int i = 0; i < c.C; i++)
                    {
                        float acc = cb[a][l][i] + mix[a][l][i] * cond;
                        for (int k = 0; k < c.K; k++)
                        {
                            int at = t - c.Dil[l] * (c.K - 1 - k);
                            if (at < 0) continue;
                            float[] src = hist[a][l][at];
                            for (int j = 0; j < c.C; j++) acc += conv[a][l][k, i, j] * src[j];
                        }
                        z[i] = NamMath.Activate(acc, act);
                    }
                    for (int i = 0; i < c.C; i++) headAcc[i] += z[i];
                    var next = new float[c.C];
                    for (int i = 0; i < c.C; i++)
                    {
                        float acc = cur[i] + b1[a][l][i];
                        for (int j = 0; j < c.C; j++) acc += w1[a][l][i, j] * z[j];
                        next[i] = acc;
                    }
                    cur = next;
                }
                var headOut = new float[c.Head];
                for (int i = 0; i < c.Head; i++)
                {
                    float acc = headB[a][i];
                    for (int j = 0; j < c.C; j++) acc += headW[a][i, j] * headAcc[j];
                    headOut[i] = acc;
                }
                headAcc = headOut;
                layerIn = cur;
            }
            y[t] = headScale * headAcc[0];
        }
        return y;
    }

    private static float[] NaiveLstm(int layers, int H, float[] w, float[] x)
    {
        int p = 0;
        var W = new float[layers][,]; var b = new float[layers][]; var h = new float[layers][]; var c = new float[layers][];
        for (int l = 0; l < layers; l++)
        {
            int I = l == 0 ? 1 : H;
            W[l] = new float[4 * H, I + H];
            for (int r = 0; r < 4 * H; r++) for (int col = 0; col < I + H; col++) W[l][r, col] = w[p++];
            b[l] = new float[4 * H]; for (int r = 0; r < 4 * H; r++) b[l][r] = w[p++];
            h[l] = new float[H]; for (int i = 0; i < H; i++) h[l][i] = w[p++];
            c[l] = new float[H]; for (int i = 0; i < H; i++) c[l][i] = w[p++];
        }
        var headW = new float[H]; for (int i = 0; i < H; i++) headW[i] = w[p++];
        float headB = w[p++];
        if (p != w.Length) throw new InvalidOperationException("naive: weight count");

        var y = new float[x.Length];
        for (int t = 0; t < x.Length; t++)
        {
            float[] input = { x[t] };
            for (int l = 0; l < layers; l++)
            {
                int I = input.Length;
                var pre = new float[4 * H];
                for (int r = 0; r < 4 * H; r++)
                {
                    float acc = b[l][r];
                    for (int col = 0; col < I; col++) acc += W[l][r, col] * input[col];
                    for (int col = 0; col < H; col++) acc += W[l][r, I + col] * h[l][col];
                    pre[r] = acc;
                }
                var hn = new float[H];
                for (int i = 0; i < H; i++)
                {
                    c[l][i] = NamMath.FastSigmoid(pre[H + i]) * c[l][i] + NamMath.FastSigmoid(pre[i]) * NamMath.FastTanh(pre[2 * H + i]);
                    hn[i] = NamMath.FastSigmoid(pre[3 * H + i]) * NamMath.FastTanh(c[l][i]);
                }
                h[l] = hn;
                input = hn;
            }
            float o = headB;
            for (int i = 0; i < H; i++) o += headW[i] * h[^1][i];
            y[t] = o;
        }
        return y;
    }

    // ---------- файл целиком, IR, скорость ----------

    private static string TempFile(string ext) => Path.Combine(Path.GetTempPath(), "lad-test-" + Guid.NewGuid().ToString("N") + ext);

    private static string WriteNam(ArrCfg[] cfg, float[] w)
    {
        string path = TempFile(".nam");
        var sb = new StringBuilder("{\"version\":\"0.5.4\",\"metadata\":{\"name\":\"test\",\"gear_type\":\"amp\",\"loudness\":-20.5},\"architecture\":\"WaveNet\",\"config\":");
        sb.Append(WaveNetConfig(cfg)).Append(",\"weights\":[");
        for (int i = 0; i < w.Length; i++) { if (i > 0) sb.Append(','); sb.Append(w[i].ToString("R", Inv)); }
        sb.Append("],\"sample_rate\":48000}");
        File.WriteAllText(path, sb.ToString());
        return path;
    }

    /// <summary>Пишет в папку синтетическую модель и импульс — для проверки загрузки в самом приложении.</summary>
    public static void WriteSamples(string dir)
    {
        var rng = new Random(7);
        var cfg = new[] { new ArrCfg(1, 8, 16, 3, Dilations, false), new ArrCfg(16, 1, 8, 3, Dilations, true) };
        float[] w = RandomWeights(13802, rng, 0.16f);
        w[^1] = 0.02f;
        string nam = WriteNam(cfg, w);
        File.Move(nam, Path.Combine(dir, "test.nam"), true);
        var ir = new float[4000];
        float lp = 0;
        for (int i = 0; i < ir.Length; i++)
        {
            lp += ((float)(rng.NextDouble() * 2 - 1) - lp) * 0.25f;
            ir[i] = lp * MathF.Exp(-i / 500f);
        }
        WriteWav16(Path.Combine(dir, "test-ir.wav"), ir, 44100);
    }

    private static bool FileRoundTrip(StringBuilder log, ArrCfg[] cfg, Random rng)
    {
        float[] w = RandomWeights(13802, rng, 0.16f);
        string path = WriteNam(cfg, w);
        try
        {
            NamModel m = NamModel.Load(path);
            var buf = new float[256];
            for (int i = 0; i < buf.Length; i++) buf[i] = 0.3f * MathF.Sin(i * 0.05f);
            m.Process(buf, buf);
            bool pass = m.Info is { Architecture: "WaveNet", Parameters: 13802, Gear: "amp" } && m.Info.Loudness == -20.5
                && m.Info.SampleRate == 48000 && buf.All(float.IsFinite) && buf.Any(v => MathF.Abs(v) > 1e-6f);
            log.AppendLine($"nam file load: {m.Info.Architecture}, {m.Info.Parameters} weights, loudness {m.Info.Loudness?.ToString(Inv)} {(pass ? "OK" : "FAIL")}");
            return pass;
        }
        finally { File.Delete(path); }
    }

    private static void WriteWav16(string path, float[] x, int rate, int channels = 1)
    {
        using var bw = new BinaryWriter(File.Create(path));
        int dataLen = x.Length * 2 * channels;
        bw.Write(Encoding.ASCII.GetBytes("RIFF")); bw.Write(36 + dataLen); bw.Write(Encoding.ASCII.GetBytes("WAVEfmt "));
        bw.Write(16); bw.Write((short)1); bw.Write((short)channels); bw.Write(rate); bw.Write(rate * 2 * channels);
        bw.Write((short)(2 * channels)); bw.Write((short)16);
        bw.Write(Encoding.ASCII.GetBytes("data")); bw.Write(dataLen);
        foreach (float v in x)
            for (int c = 0; c < channels; c++) bw.Write((short)Math.Clamp((int)MathF.Round((c == 0 ? v : 0.1f) * 32767f), -32768, 32767));
    }

    private static bool IrTest(StringBuilder log, Random rng)
    {
        bool ok = true;
        // «кабинет»: затухающий шум с полосовой окраской
        var ir = new float[2000];
        float lp = 0;
        for (int i = 0; i < ir.Length; i++)
        {
            lp += ((float)(rng.NextDouble() * 2 - 1) - lp) * 0.25f;
            ir[i] = lp * MathF.Exp(-i / 300f);
        }
        ir[0] = 0.9f;
        string path = TempFile(".wav");
        WriteWav16(path, ir, 48000, channels: 2);
        try
        {
            IrConvolver conv = IrConvolver.Load(path, 48000);
            (float[] read, int rate) = IrConvolver.ReadWav(path);

            // свёртка против наивной на случайном сигнале
            var x = new float[6000];
            for (int i = 0; i < x.Length; i++) x[i] = (float)(rng.NextDouble() * 2 - 1);
            var got = new float[x.Length];
            for (int i = 0; i < x.Length; i++) got[i] = conv.Process(x[i]);
            double energy = 0;
            foreach (float s in read.AsSpan(0, conv.Taps)) energy += s * (double)s;
            float gain = 0.45f / (float)Math.Sqrt(energy);
            var want = new float[x.Length];
            for (int i = 0; i < x.Length; i++)
            {
                double acc = 0;
                for (int k = 0; k < conv.Taps && k <= i; k++) acc += read[k] * gain * x[i - k];
                want[i] = (float)acc;
            }
            ok &= rate == 48000 && Compare(log, $"ir convolution ({conv.Taps} taps, stereo wav)", got, want);

            // тот же импульс на 96 кГц должен давать ту же АЧХ: меряем отклик на синус 1 кГц
            float a48 = ToneGain(IrConvolver.Load(path, 48000), 1000, 48000);
            float a96 = ToneGain(IrConvolver.Load(path, 96000), 1000, 96000);
            float a44 = ToneGain(IrConvolver.Load(path, 44100), 1000, 44100);
            double d96 = 20 * Math.Log10(a96 / a48), d44 = 20 * Math.Log10(a44 / a48);
            bool pass = Math.Abs(d96) < 0.5 && Math.Abs(d44) < 0.5;
            ok &= pass;
            log.AppendLine(string.Create(Inv, $"ir resampling: 1 kHz gain vs 48k: 96k {d96:+0.00;-0.00} dB, 44.1k {d44:+0.00;-0.00} dB {(pass ? "OK" : "FAIL")}"));
        }
        finally { File.Delete(path); }
        return ok;
    }

    private static float ToneGain(IrConvolver conv, float freq, float rate)
    {
        int n = (int)rate;
        float peak = 0;
        for (int i = 0; i < n; i++)
        {
            float y = conv.Process(MathF.Sin(2 * MathF.PI * freq * i / rate));
            if (i > n / 2) peak = MathF.Max(peak, MathF.Abs(y));
        }
        return peak;
    }

    private static bool Performance(StringBuilder log, ArrCfg[] cfg, Random rng)
    {
        float[] w = RandomWeights(13802, rng, 0.16f);
        string nam = WriteNam(cfg, w);
        string wav = TempFile(".wav");
        var ir = new float[8192];
        for (int i = 0; i < ir.Length; i++) ir[i] = (float)(rng.NextDouble() * 2 - 1) * MathF.Exp(-i / 1500f);
        WriteWav16(wav, ir, 48000);
        try
        {
            NamModel model = NamModel.Load(nam);
            const int seconds = 3, block = 64;
            var buf = new float[block];
            float[] x = TestSignal(48000 * seconds, rng);
            var sw = Stopwatch.StartNew();
            double worst = 0;
            for (int o = 0; o + block <= x.Length; o += block)
            {
                long t0 = Stopwatch.GetTimestamp();
                x.AsSpan(o, block).CopyTo(buf);
                model.Process(buf, buf);
                worst = Math.Max(worst, Stopwatch.GetElapsedTime(t0).TotalMilliseconds);
            }
            double namLoad = sw.Elapsed.TotalMilliseconds / (seconds * 1000) * 100;
            log.AppendLine(string.Create(Inv, $"speed wavenet standard: {namLoad:0.0}% of one core, worst 64-sample block {worst:0.000} ms (budget 1.333)"));

            // вся цепочка с моделью и самым длинным импульсом
            // педаль-модель → усилитель-модель → кабинет-импульс → дилэй → реверб
            Block pedal = Tests.Make("pedal"), amp = Tests.Make("amp"), cab = Tests.Make("cab");
            var chain = new Chain();
            chain.SetBlocks([Tests.Make("gate"), pedal, amp, cab, Tests.Make("delay"), Tests.Make("reverb")]);
            chain.Prepare(48000, block);
            pedal.LoadFile(nam);
            amp.LoadFile(nam);
            cab.LoadFile(wav);
            var l = new float[block]; var r = new float[block];
            int bad = 0; float peak = 0;
            worst = 0;
            sw.Restart();
            for (int o = 0; o + block <= x.Length; o += block)
            {
                long t0 = Stopwatch.GetTimestamp();
                x.AsSpan(o, block).CopyTo(buf);
                chain.Process(buf, l, r);
                worst = Math.Max(worst, Stopwatch.GetElapsedTime(t0).TotalMilliseconds);
                for (int i = 0; i < block; i++) { if (!float.IsFinite(l[i])) bad++; peak = MathF.Max(peak, MathF.Abs(l[i])); }
            }
            double load = sw.Elapsed.TotalMilliseconds / (seconds * 1000) * 100;
            bool pass = bad == 0 && peak > 1e-4f && load < 40 && namLoad < 30;
            log.AppendLine(string.Create(Inv, $"speed full chain (pedal model + amp model + 8192-tap ir + delay + reverb): {load:0.0}% of one core, worst block {worst:0.000} ms, peak {peak:0.000}, nan {bad} {(pass ? "OK" : "FAIL")}"));
            return pass;
        }
        finally { File.Delete(nam); File.Delete(wav); }
    }

    // ---------- официальная библиотека NAM: настоящие модели A1 и A2, сверка со встроенным расчётом ----------

    private static string? ExamplesDir()
    {
        // образцы моделей — в исходниках библиотеки: рядом с native/bin при отладке и в native/third_party,
        // если приложение запущено из dist в корне репозитория
        for (DirectoryInfo? d = new(AppContext.BaseDirectory); d != null; d = d.Parent)
        {
            foreach (string root in new[] { "third_party", Path.Combine("native", "third_party") })
            {
                string p = Path.Combine(d.FullName, root, "NeuralAmpModelerCore", "example_models");
                if (Directory.Exists(p)) return p;
            }
        }
        return null;
    }

    private static float[] RunBlocks(NamModel m, float[] x, out double loadPercent, out double worstMs)
    {
        var y = new float[x.Length];
        var buf = new float[64];
        worstMs = 0;
        var sw = Stopwatch.StartNew();
        for (int o = 0; o + 64 <= x.Length; o += 64)
        {
            long t0 = Stopwatch.GetTimestamp();
            x.AsSpan(o, 64).CopyTo(buf);
            m.Process(buf, buf);
            buf.CopyTo(y.AsSpan(o, 64));
            worstMs = Math.Max(worstMs, Stopwatch.GetElapsedTime(t0).TotalMilliseconds);
        }
        loadPercent = sw.Elapsed.TotalSeconds / (x.Length / 48000.0) * 100;
        return y;
    }

    public static bool Official(StringBuilder log)
    {
        if (!NativeNam.Available)
        {
            log.AppendLine("official NAM library: namcore.dll not found - skipped (only A1 and LSTM will load)");
            return true;
        }
        log.AppendLine("official NAM library: version " + NativeNam.VersionText);
        string? dir = ExamplesDir();
        if (dir == null) { log.AppendLine("  example models not found - skipped"); return true; }

        bool ok = true;
        var rng = new Random(99);
        float[] x = TestSignal(48000 * 2, rng);

        foreach (string path in Directory.GetFiles(dir, "*.nam").OrderBy(p => p))
        {
            string name = Path.GetFileName(path);
            try
            {
                NamModel m = NamModel.Load(path);
                float[] y = RunBlocks(m, x, out double load, out double worst);
                float peak = y.Max(MathF.Abs);
                bool pass = y.All(float.IsFinite) && peak > 1e-7f;
                ok &= pass;
                log.AppendLine(string.Create(Inv,
                    $"  {name,-30} {m.Info.Flavor,-11} {(m.Info.Slimmable ? "sizes " : "      ")}{m.Info.Parameters,6} w  cpu {load,5:0.0}%  worst {worst:0.000} ms  peak {peak:0.000} {(pass ? "OK" : "FAIL")}"));
            }
            catch (NamException ex)
            {
                ok = false;
                log.AppendLine($"  {name,-30} REFUSED: {ex.Message}");
            }
        }

        // Самое важное: мой расчёт A1 и LSTM против эталонного на настоящих файлах.
        foreach (string name in new[] { "wavenet_a1_standard.nam", "my_model.nam", "wavenet.nam", "lstm.nam" })
        {
            string path = Path.Combine(dir, name);
            if (!File.Exists(path)) continue;
            float[] official = RunBlocks(NativeNam.Create(path), x, out _, out _);
            float[] mine = RunBlocks(NamModel.LoadManaged(path), x, out _, out _);
            ok &= Compare(log, $"  built-in engine vs library, {name}", mine, official);
        }

        // влияет ли размер внутренних буферов библиотеки на скорость при блоке в 64 сэмпла
        foreach (string name in new[] { "A2.nam", "wavenet_a1_standard.nam" })
        {
            string path = Path.Combine(dir, name);
            if (!File.Exists(path)) continue;
            var parts = new List<string>();
            foreach (int mb in new[] { 64, 256, 1024, 4096 })
            {
                var m = NativeNam.Create(path, mb);
                RunBlocks(m, x, out _, out _); // разогрев
                RunBlocks(m, x, out double l, out double wst);
                parts.Add(string.Create(Inv, $"{mb}: {l:0.0}% / {wst:0.000} ms"));
            }
            log.AppendLine($"  buffer size effect, {name}: " + string.Join("; ", parts));
        }

        // выбор размера у A2: Lite должен считаться заметно легче Full и давать другой, но близкий сигнал
        string a2 = Path.Combine(dir, "A2.nam");
        if (File.Exists(a2))
        {
            NativeNam full = NativeNam.Create(a2), lite = NativeNam.Create(a2);
            bool switched = lite.SetSize(0.0);
            float[] yf = RunBlocks(full, x, out double lf, out _);
            float[] yl = RunBlocks(lite, x, out double ll, out _);
            bool pass = switched && ll < lf && yl.All(float.IsFinite);
            ok &= pass;
            log.AppendLine(string.Create(Inv, $"  A2 sizes: full {lf:0.0}% cpu, lite {ll:0.0}% cpu {(pass ? "OK" : "FAIL")}"));
        }
        return ok;
    }

    /// <summary>Длинный импульс (ревербератор): частотная свёртка против прямой, задержка и нагрузка.</summary>
    private static bool LongIrTest(StringBuilder log, Random rng)
    {
        const int latency = 1024; // два куска по 512: один копится, второй считается
        var ir = new float[(int)(48000 * 1.3)];
        for (int i = 0; i < ir.Length; i++) ir[i] = (float)(rng.NextDouble() * 2 - 1) * MathF.Exp(-i / 14000f) * 0.5f;
        ir[0] = 0.9f;
        string path = TempFile(".wav");
        WriteWav16(path, ir, 48000);
        try
        {
            LongConvolver conv = LongConvolver.Load(path, 48000);
            (float[] read, _) = IrConvolver.ReadWav(path);

            var x = new float[3000];
            for (int i = 0; i < 1500; i++) x[i] = (float)(rng.NextDouble() * 2 - 1);
            var got = new float[x.Length];
            var right = new float[x.Length];
            for (int o = 0; o < x.Length; o += 48) // блок, некратный куску свёртки
            {
                int len = Math.Min(48, x.Length - o);
                conv.Process(x.AsSpan(o, len), got.AsSpan(o, len), right.AsSpan(o, len));
            }
            // прямой расчёт; общий множитель громкости находим подгонкой
            var want = new float[x.Length];
            for (int i = latency; i < x.Length; i++)
            {
                double acc = 0;
                int t = i - latency;
                for (int k = 0; k <= t && k < read.Length; k++) acc += read[k] * x[t - k];
                want[i] = (float)acc;
            }
            double num = 0, den = 0;
            for (int i = 0; i < x.Length; i++) { num += got[i] * want[i]; den += want[i] * (double)want[i]; }
            float scale = (float)(num / den);
            for (int i = 0; i < want.Length; i++) want[i] *= scale;
            bool same = Compare(log, $"long ir convolution ({conv.Milliseconds:0} ms, scale {scale:0.000})", got, want);
            bool mono = got.AsSpan().SequenceEqual(right);

            // нагрузка: 3 секунды звука блоками по 64
            var buf = new float[64]; var a = new float[64]; var b = new float[64];
            double worst = 0;
            var sw = Stopwatch.StartNew();
            for (int o = 0; o < 48000 * 3; o += 64)
            {
                long t0 = Stopwatch.GetTimestamp();
                for (int i = 0; i < 64; i++) buf[i] = 0.1f * MathF.Sin((o + i) * 0.05f);
                conv.Process(buf, a, b);
                worst = Math.Max(worst, Stopwatch.GetElapsedTime(t0).TotalMilliseconds);
            }
            double load = sw.Elapsed.TotalMilliseconds / 3000 * 100;
            bool pass = same && mono && load < 15;
            log.AppendLine(string.Create(Inv, $"long ir speed: {load:0.0}% of one core, worst 64-sample block {worst:0.000} ms {(pass ? "OK" : "FAIL")}"));
            return pass;
        }
        finally { File.Delete(path); }
    }
}
