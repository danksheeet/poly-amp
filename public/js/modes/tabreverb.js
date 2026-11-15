// Реверберация для звука табов. Синтезатор alphaTab не умеет своих эффектов и звучит сухо, поэтому его выход
// идёт через нашу цепочку: сухой сигнал + «комната» (свёртка с синтетическим импульсом) + мягкий ограничитель.
// alphaTab подключает свой выход к узлу, который вернёт window.alphaTabOutputNode(ctx) — см. «Poly Amp patch»
// в vendor/alphatab/alphaTab.js и PATCHES.md.

const graphs = new Map(); // AudioContext → { input, dry, wet }
let amount = 0.4;

// Импульс «комнаты»: стерео-шум с затуханием RT60 ≈ 1.8 с; высокие гаснут быстрее низких, как в настоящем зале.
function impulse(ctx, seconds = 2.2, rt60 = 1.8) {
  const sr = ctx.sampleRate;
  const n = Math.floor(sr * seconds);
  const buf = ctx.createBuffer(2, n, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const k = 0.85 - 0.7 * (i / n); // фильтр закрывается к хвосту
      lp += k * (Math.random() * 2 - 1 - lp);
      d[i] = lp * Math.pow(10, (-3 * t) / rt60) * Math.min(1, t / 0.004);
    }
  }
  return buf;
}

function build(ctx) {
  const input = ctx.createGain();
  const dry = ctx.createGain();
  const pre = ctx.createDelay(0.1);
  pre.delayTime.value = 0.018; // первые отражения чуть позже прямого звука — так атака остаётся чёткой
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 180; // без гула баса и бочки в хвосте
  const conv = ctx.createConvolver();
  conv.buffer = impulse(ctx);
  const wet = ctx.createGain();
  // реверб добавляет громкости — ограничитель не даёт звуку клиппировать
  const limit = ctx.createDynamicsCompressor();
  limit.threshold.value = -1;
  limit.knee.value = 0;
  limit.ratio.value = 20;
  limit.attack.value = 0.002;
  limit.release.value = 0.12;
  input.connect(dry).connect(limit);
  input.connect(pre).connect(hp).connect(conv).connect(wet).connect(limit);
  limit.connect(ctx.destination);
  const g = { ctx, input, dry, wet };
  apply(g, true);
  return g;
}

function apply(g, now = false) {
  // 40 % (по умолчанию) — хвост примерно на 17 дБ тише звука: слышно, но не тонет; 100 % — «большой зал»
  const wet = amount * 1.8;
  const dry = 1 - amount * 0.3;
  if (now) {
    g.wet.gain.value = wet;
    g.dry.gain.value = dry;
  } else {
    const t = g.ctx.currentTime;
    g.wet.gain.setTargetAtTime(wet, t, 0.05);
    g.dry.gain.setTargetAtTime(dry, t, 0.05);
  }
}

/** Сколько реверберации, 0…1. */
export function setTabReverb(v) {
  amount = Math.max(0, Math.min(1, v));
  for (const g of graphs.values()) apply(g);
}

window.alphaTabOutputNode = (ctx) => {
  let g = graphs.get(ctx);
  if (!g) graphs.set(ctx, (g = build(ctx)));
  return g.input;
};
