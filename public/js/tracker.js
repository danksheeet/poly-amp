// Трекер нот: из потока «громкость + яркость + высота» делает события «атака» и «нота».
// Общий для веб-движка и нативного: им отличается только то, кто считает сами измерения.
import { freqToMidi } from './music.js';

const STABLE_FRAMES = 3;

export class NoteTracker {
  /** @param {(type: 'onset'|'note', data?: object) => void} emit */
  constructor(emit) {
    this.emit = emit;
    this.floor = 0.01;
    this.rmsPrev = 0;
    this.hfPrev = 0;
    this.hfPrev2 = 0;
    this.lastOnset = 0;
    this.pendingOnset = false;
    this.cand = null;
    this.stable = 0;
    this.silent = 0;
    this.note = null;
    this.lastEmitted = null;
  }

  /**
   * @param {number} rms громкость последних ~20 мс
   * @param {number} hf «яркость» последних ~30 мс (энергия разности соседних сэмплов)
   * @param {() => ({freq:number, clarity:number}|null)} detect высота ноты; вызывается, только если сигнал выше шума
   */
  feed(rms, hf, detect) {
    // шумовой порог подстраивается под тишину конкретного входа
    this.floor = Math.min(rms, this.floor * 1.002 + 1e-6);
    const gate = Math.max(0.0025, Math.min(this.floor * 4, 0.05));

    // щипок даёт всплеск высоких частот, даже если та же нота ещё звучит и громкость почти не выросла;
    // сравниваем с минимумом двух прошлых кадров: атака часто делится между соседними кадрами
    const hfBase = Math.min(this.hfPrev, this.hfPrev2);
    const attack = rms > this.rmsPrev * 1.8 + 0.002 || hf > hfBase * 1.7 + 0.0003;
    this.hfRatio = hf / (hfBase + 1e-9);
    this.hfPrev2 = this.hfPrev;
    this.hfPrev = hf;

    const now = performance.now();
    if (rms > gate && attack && now - this.lastOnset > 90) {
      this.lastOnset = now;
      this.pendingOnset = true;
      this.cand = null;
      this.stable = 0;
      this.emit('onset');
    }
    this.rmsPrev = this.rmsPrev * 0.5 + rms * 0.5;

    let freq = null;
    let midi = null;
    let clarity = 0;
    if (rms > gate) {
      const res = detect();
      if (res && res.freq > 60 && res.freq < 1500 && res.clarity >= 0.72) {
        freq = res.freq;
        midi = freqToMidi(freq);
        clarity = res.clarity;
      }
    }

    if (midi != null) {
      this.silent = 0;
      const r = Math.round(midi);
      if (r === this.cand) this.stable++;
      else {
        this.cand = r;
        this.stable = 1;
      }
      if (this.stable >= STABLE_FRAMES) {
        this.note = r;
        if (r !== this.lastEmitted || this.pendingOnset) {
          this.lastEmitted = r;
          this.pendingOnset = false;
          this.emit('note', { midi: r, freq, cents: (midi - r) * 100 });
        }
      }
    } else if (++this.silent > 8) {
      this.note = null;
      this.lastEmitted = null;
      this.cand = null;
      this.stable = 0;
    }

    const db = rms > 0 ? 20 * Math.log10(rms) : -100;
    return {
      rms,
      gate,
      active: rms > gate,
      level: Math.max(0, Math.min(1, (db + 60) / 54)),
      freq,
      midi,
      clarity,
      note: this.note,
    };
  }
}
