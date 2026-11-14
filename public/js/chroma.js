// Распознавание аккордов: хрома-вектор из спектра и сравнение с шаблонами.
import { freqToMidi, midiToFreq, chordMidis } from './music.js';

const F_LO = 72;
const F_HI = 1400;
// ожидаемая (сжатая) громкость гармоник струны
const HARMONICS = [1, 0.8, 0.6, 0.45, 0.3, 0.25];
const bandWeight = (f) => (f > 700 ? 0.5 : 1);

/**
 * Хрома из спектра AnalyserNode (значения в дБ).
 * @returns {{chroma: Float32Array, peakDb: number}}
 */
export function chromaFromSpectrum(db, binHz) {
  const chroma = new Float32Array(12);
  const lo = Math.max(2, Math.floor(F_LO / binHz));
  const hi = Math.min(db.length - 2, Math.ceil(F_HI / binHz));
  let peakDb = -Infinity;
  for (let i = lo; i <= hi; i++) if (db[i] > peakDb) peakDb = db[i];
  if (!isFinite(peakDb)) return { chroma, peakDb: -200 };

  const floor = peakDb - 34;
  for (let i = lo; i <= hi; i++) {
    const v = db[i];
    if (v < floor || v <= db[i - 1] || v < db[i + 1]) continue;
    const a = db[i - 1];
    const c = db[i + 1];
    const denom = a - 2 * v + c;
    const p = denom < -1e-6 ? (0.5 * (a - c)) / denom : 0;
    const f = (i + p) * binHz;
    const m = freqToMidi(f);
    const r = Math.round(m);
    if (Math.abs(m - r) > 0.4) continue; // между нотами — скорее шум
    const amp = Math.pow(10, (v - peakDb) / 20);
    chroma[((r % 12) + 12) % 12] += Math.sqrt(amp) * bandWeight(f);
  }
  normalize(chroma);
  return { chroma, peakDb };
}

/** Шаблон аккорда: какие классы нот и насколько сильно должны звучать. */
export function chordTemplate(chord) {
  return templateFromMidis(chordMidis(chord));
}

/** Тот же шаблон для любого набора нот (например, аккорда из таба). */
export function templateFromMidis(midis) {
  const t = new Float32Array(12);
  for (const midi of midis) {
    const f0 = midiToFreq(midi);
    for (let h = 1; h <= HARMONICS.length; h++) {
      const f = f0 * h;
      if (f > F_HI) break;
      const pc = ((Math.round(freqToMidi(f)) % 12) + 12) % 12;
      t[pc] += HARMONICS[h - 1] * bandWeight(f);
    }
  }
  normalize(t);
  return t;
}

/** Сортирует аккорды по похожести на услышанное. */
export function rankChords(chroma, templates) {
  const out = [];
  for (const { chord, template } of templates) {
    let dot = 0;
    for (let i = 0; i < 12; i++) dot += chroma[i] * template[i];
    out.push({ chord, score: dot });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

function normalize(v) {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n);
  if (n > 0) for (let i = 0; i < v.length; i++) v[i] /= n;
}
