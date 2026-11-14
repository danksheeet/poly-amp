// Метроном. В браузере щелчки планируются по часам AudioContext,
// в приложении их с точностью до сэмпла ставит нативный движок.

class MetronomeBase {
  constructor() {
    this.bpm = 90;
    this.beats = 4;
    this.running = false;
    this.onBeat = null;
    this.taps = [];
  }

  /** Применить изменённые bpm/beats на ходу. */
  apply() {}

  /** Темп по нажатиям. Возвращает новый BPM или null, пока нажатий мало. */
  tap() {
    const now = performance.now();
    if (this.taps.length && now - this.taps[this.taps.length - 1] > 2000) this.taps = [];
    this.taps.push(now);
    if (this.taps.length > 5) this.taps.shift();
    if (this.taps.length < 2) return null;
    const span = this.taps[this.taps.length - 1] - this.taps[0];
    return Math.round(60000 / (span / (this.taps.length - 1)));
  }
}

export class WebMetronome extends MetronomeBase {
  constructor(engine) {
    super();
    this.engine = engine;
    this.timer = null;
  }

  start() {
    if (this.running) return;
    const ctx = this.engine.ensure();
    this.running = true;
    this.beat = 0;
    this.next = ctx.currentTime + 0.08;
    this.timer = setInterval(() => this.schedule(), 25);
    this.schedule();
  }

  stop() {
    this.running = false;
    clearInterval(this.timer);
  }

  schedule() {
    const ctx = this.engine.ctx;
    while (this.next < ctx.currentTime + 0.12) {
      const b = this.beat;
      this.engine.click(this.next, b === 0);
      const wait = Math.max(0, (this.next - ctx.currentTime) * 1000);
      setTimeout(() => this.running && this.onBeat && this.onBeat(b), wait);
      this.next += 60 / this.bpm;
      this.beat = (b + 1) % this.beats;
    }
  }
}

export class NativeMetronome extends MetronomeBase {
  /** @param {(msg: object) => void} post */
  constructor(post) {
    super();
    this.post = post;
  }

  start() {
    this.running = true;
    this.apply();
  }

  stop() {
    this.running = false;
    this.apply();
  }

  apply() {
    this.post({ t: 'metro', on: this.running ? 1 : 0, bpm: this.bpm, beats: this.beats });
  }

  /** Вызывается движком, когда приходит доля. */
  beat(b) {
    if (this.running && this.onBeat) this.onBeat(b);
  }
}
