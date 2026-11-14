// Определение высоты одиночной ноты алгоритмом YIN
// (de Cheveigné & Kawahara, 2002). Чистая функция от массива сэмплов.

export class PitchDetector {
  constructor(sampleRate, { window = 2048, fMin = 62, fMax = 1400, threshold = 0.13 } = {}) {
    this.sr = sampleRate;
    this.W = window;
    this.tauMin = Math.max(2, Math.floor(sampleRate / fMax));
    this.tauMax = Math.ceil(sampleRate / fMin);
    this.need = this.W + this.tauMax + 1; // сколько сэмплов нужно на входе
    this.d = new Float32Array(this.tauMax + 2);
    this.threshold = threshold;
  }

  /**
   * @param {Float32Array} x — берутся последние `need` сэмплов
   * @returns {{freq:number, clarity:number}|null}
   */
  detect(x) {
    const { W, tauMin, tauMax, d, threshold } = this;
    const off = x.length - this.need;
    if (off < 0) return null;
    const end = off + W;

    let run = 0;
    let tau = -1;
    d[0] = 1;
    for (let t = 1; t <= tauMax; t++) {
      let s = 0;
      for (let j = off; j < end; j++) {
        const v = x[j] - x[j + t];
        s += v * v;
      }
      run += s;
      d[t] = run > 0 ? (s * t) / run : 1;
      // первый провал ниже порога, доведённый до локального минимума
      if (t > tauMin && d[t - 1] < threshold && d[t] >= d[t - 1]) {
        tau = t - 1;
        break;
      }
    }

    if (tau < 0) {
      // порог не пробит — берём глобальный минимум, если он достаточно глубокий
      let best = tauMin;
      for (let t = tauMin + 1; t < tauMax; t++) if (d[t] < d[best]) best = t;
      if (d[best] > 0.28) return null;
      tau = best;
    }

    // параболическая интерполяция вокруг минимума
    const a = d[tau - 1];
    const b = d[tau];
    const c = d[tau + 1];
    const denom = a - 2 * b + c;
    const shift = denom > 1e-9 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / denom)) : 0;
    return { freq: this.sr / (tau + shift), clarity: 1 - b };
  }
}
