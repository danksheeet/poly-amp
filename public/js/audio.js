// Аудиодвижок: вход с гитары, анализ, синтезатор для примеров, мониторинг, щелчки метронома.
import { PitchDetector } from './pitch.js';
import { chromaFromSpectrum } from './chroma.js';
import { midiToFreq } from './music.js';
import { NoteTracker } from './tracker.js';
import { WebMetronome } from './metronome.js';

const TICK_MS = 25;

class Engine {
  constructor() {
    this.listeners = {
      frame: new Set(), note: new Set(), onset: new Set(), state: new Set(),
      block: new Set(), picked: new Set(), t3k: new Set(), library: new Set(), // в браузере не срабатывают
      tabsLib: new Set(), vst3: new Set(), vst3Error: new Set(),
    };
    this.blockInfo = new Map();
    this.library = [];
    this.vst3 = { available: false, scanned: false, scanning: false, progress: null, failed: [], folder: '', plugins: [] };
    this.ctx = null;
    this.stream = null;
    this.micSource = null;
    this.deviceId = null;
    this.deviceLabel = '';
    this.inputChannels = 1;
    this.channelMode = '1'; // '1' | '2' | 'mix'
    this.monitor = { on: false, tone: 'clean', volume: 0.8 };
    this.masterDb = 0; // общая громкость (в браузере — мониторинг, синтезатор и клик)
    this.masterMute = false;
    this.frame = { rms: 0, level: 0, freq: null, midi: null, clarity: 0, note: null };
    this.voices = [];
    this.buffers = new Map();
    this.tracker = new NoteTracker((type, data) => this.emit(type, data));
    this.isNative = false;
  }

  on(type, fn) {
    this.listeners[type].add(fn);
    return () => this.listeners[type].delete(fn);
  }

  emit(type, data) {
    for (const fn of this.listeners[type]) fn(data);
  }

  get connected() {
    return !!this.micSource;
  }

  /** Создаёт AudioContext при первом действии пользователя. */
  ensure() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return this.ctx;
    }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = (this.ctx = new Ctx({ latencyHint: 'interactive' }));
    const sr = ctx.sampleRate;

    // интерфейсы часто работают на 96/192 кГц — для анализа прореживаем до ~48 кГц
    this.dec = Math.min(8, Math.max(1, Math.floor(sr / 40000)));
    this.detector = new PitchDetector(sr / this.dec);
    this.hop = Math.ceil((sr / this.dec) * 0.03);

    this.inputBus = ctx.createGain();
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 55;

    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 4096 * this.dec;
    this.chromaAnalyser = ctx.createAnalyser();
    this.chromaAnalyser.fftSize = Math.min(32768, 16384 * this.dec);
    this.chromaAnalyser.smoothingTimeConstant = 0.55;

    const sink = ctx.createGain(); // тихий выход, чтобы граф анализа гарантированно обрабатывался
    sink.gain.value = 0;
    this.inputBus.connect(hp);
    hp.connect(this.analyser);
    hp.connect(this.chromaAnalyser);
    this.analyser.connect(sink);
    this.chromaAnalyser.connect(sink);
    sink.connect(ctx.destination);

    // мастер: всё, что слышно в колонках, идёт через него
    this.master = ctx.createGain();
    this.master.gain.value = this.masterGain();
    this.master.connect(ctx.destination);

    // синтезатор: слышен в колонках и одновременно «слышен» приложению
    this.synthBus = ctx.createGain();
    this.synthBus.gain.value = 0.85;
    this.synthBus.connect(this.master);
    this.synthBus.connect(this.inputBus);

    // вход: выбор канала интерфейса → моно
    this.splitter = ctx.createChannelSplitter(2);
    this.chGain = [ctx.createGain(), ctx.createGain()];
    this.micBus = ctx.createGain();
    this.micBus.channelCount = 1;
    this.micBus.channelCountMode = 'explicit';
    this.splitter.connect(this.chGain[0], 0);
    this.splitter.connect(this.chGain[1], 1);
    this.chGain[0].connect(this.micBus);
    this.chGain[1].connect(this.micBus);
    this.micBus.connect(this.inputBus);
    this.applyChannelMode();

    // мониторинг: чистый звук или простой перегруз с «кабинетом»
    this.monOut = ctx.createGain();
    this.monOut.gain.value = 0;
    this.monOut.connect(this.master);
    this.cleanGain = ctx.createGain();
    this.micBus.connect(this.cleanGain);
    this.cleanGain.connect(this.monOut);

    const pre = ctx.createGain();
    pre.gain.value = 14;
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(2048);
    for (let i = 0; i < curve.length; i++) curve[i] = Math.tanh(2.2 * ((i / (curve.length - 1)) * 2 - 1));
    shaper.curve = curve;
    shaper.oversample = '4x';
    const cabLp = ctx.createBiquadFilter();
    cabLp.type = 'lowpass';
    cabLp.frequency.value = 3600;
    cabLp.Q.value = 0.8;
    const cabHp = ctx.createBiquadFilter();
    cabHp.type = 'highpass';
    cabHp.frequency.value = 95;
    this.driveGain = ctx.createGain();
    this.micBus.connect(pre);
    pre.connect(shaper);
    shaper.connect(cabLp);
    cabLp.connect(cabHp);
    cabHp.connect(this.driveGain);
    this.driveGain.connect(this.monOut);
    this.applyMonitor();

    this.clickBus = ctx.createGain();
    this.clickBus.gain.value = 0.5;
    this.clickBus.connect(this.master);

    this.timeBuf = new Float32Array(this.analyser.fftSize);
    this.x = new Float32Array(4096);
    this.freqBuf = new Float32Array(this.chromaAnalyser.frequencyBinCount);
    this.timer = setInterval(() => this.tick(), TICK_MS);
    return ctx;
  }

  // ---------- вход ----------

  async connectInput(deviceId) {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw Object.assign(new Error('unsupported'), { name: 'NotSupportedError' });
    }
    const ctx = this.ensure();
    const base = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: { ideal: 2 },
    };
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: deviceId ? { ...base, deviceId: { exact: deviceId } } : base,
      });
    } catch (err) {
      // сохранённое устройство могли отключить — пробуем вход по умолчанию
      if (deviceId && (err.name === 'OverconstrainedError' || err.name === 'NotFoundError')) {
        stream = await navigator.mediaDevices.getUserMedia({ audio: base });
      } else {
        throw err;
      }
    }
    this.disconnectInput(true);
    this.stream = stream;
    this.micSource = ctx.createMediaStreamSource(stream);
    this.micSource.connect(this.splitter);
    const track = stream.getAudioTracks()[0];
    const settings = track.getSettings ? track.getSettings() : {};
    this.deviceLabel = track.label || 'Audio input';
    this.deviceId = settings.deviceId || deviceId || null;
    this.inputChannels = settings.channelCount || this.micSource.channelCount || 1;
    if (this.inputChannels < 2) this.channelMode = '1';
    this.applyChannelMode();
    track.addEventListener('ended', () => {
      if (this.stream === stream) this.disconnectInput();
    });
    this.emit('state');
  }

  disconnectInput(silent = false) {
    if (this.micSource) {
      try {
        this.micSource.disconnect();
      } catch {}
      this.micSource = null;
    }
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop();
      this.stream = null;
    }
    if (!silent) this.emit('state');
  }

  async listInputs() {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'communications');
  }

  setChannelMode(mode) {
    this.channelMode = mode;
    this.applyChannelMode();
  }

  applyChannelMode() {
    if (!this.chGain) return;
    const m = this.channelMode;
    this.chGain[0].gain.value = m === '2' ? 0 : 1;
    this.chGain[1].gain.value = m === '1' ? 0 : 1;
  }

  setMonitor(patch) {
    Object.assign(this.monitor, patch);
    this.applyMonitor();
  }

  applyMonitor() {
    if (!this.monOut) return;
    const { on, tone, volume } = this.monitor;
    const t = this.ctx.currentTime;
    this.monOut.gain.setTargetAtTime(on ? volume : 0, t, 0.02);
    this.cleanGain.gain.setTargetAtTime(tone === 'clean' ? 1 : 0, t, 0.02);
    this.driveGain.gain.setTargetAtTime(tone === 'drive' ? 0.3 : 0, t, 0.02);
  }

  // ---------- анализ ----------

  tick() {
    const { analyser, timeBuf, dec } = this;
    analyser.getFloatTimeDomainData(timeBuf);
    let x = timeBuf;
    if (dec > 1) {
      x = this.x;
      for (let i = 0; i < x.length; i++) {
        let s = 0;
        const base = i * dec;
        for (let k = 0; k < dec; k++) s += timeBuf[base + k];
        x[i] = s / dec;
      }
    }

    let e = 0;
    for (let i = x.length - 1024; i < x.length; i++) e += x[i] * x[i];
    const rms = Math.sqrt(e / 1024);

    // «яркость» последних ~30 мс — по ней трекер замечает повторный щипок той же ноты
    let h = 0;
    const hop = this.hop;
    for (let i = x.length - hop; i < x.length; i++) {
      const dv = x[i] - x[i - 1];
      h += dv * dv;
    }
    const hf = Math.sqrt(h / hop);

    this.frame = this.tracker.feed(rms, hf, () => this.detector.detect(x));
    this.emit('frame', this.frame);
  }

  /** В вебе спектр считает AnalyserNode сам — включать нечего. */
  setChromaEnabled() {}

  // Цепочка блоков звучит только в приложении; в браузере её можно собрать и покрутить ручки вхолостую.
  setChain() {}
  blockParam() {}
  blockOn() {}
  blockSize() {}
  /** Из общих уровней в браузере работает только мастер. */
  setGlobals(p) {
    if ('master.level' in p) this.masterDb = p['master.level'];
    if ('master.mute' in p) this.masterMute = p['master.mute'] > 0.5;
    if (this.master) this.master.gain.setTargetAtTime(this.masterGain(), this.ctx.currentTime, 0.015);
  }
  masterGain() {
    return this.masterMute ? 0 : Math.pow(10, this.masterDb / 20);
  }
  pickFile() {}
  t3kSelect() {}
  vst3Scan() {}
  vst3Editor() {}
  setBypass() {}
  // папка с табами доступна только приложению
  tabsLib() {}
  tabsLibPick() {}
  tabsRead() {
    return Promise.resolve({ ok: false, error: 'The library works in the Poly Amp app.' });

  }
  tabsOpen() {}
  tabsDelete() {
    return Promise.resolve({ ok: false, error: 'The library works in the Poly Amp app.' });
  }
  t3kLoadTone() {
    return Promise.resolve({ ok: false, canceled: true });
  }
  openUrl() {}

  /** Хрома-вектор текущего звука (для аккордов). */
  chroma() {
    if (!this.ctx) return null;
    this.chromaAnalyser.getFloatFrequencyData(this.freqBuf);
    return chromaFromSpectrum(this.freqBuf, this.ctx.sampleRate / this.chromaAnalyser.fftSize);
  }

  // ---------- синтезатор ----------

  noteBuffer(midi) {
    let buf = this.buffers.get(midi);
    if (buf) return buf;
    const sr = this.ctx.sampleRate;
    const dur = 2.4;
    const n = Math.floor(sr * dur);
    buf = this.ctx.createBuffer(1, n, sr);
    const out = buf.getChannelData(0);
    const f = midiToFreq(midi);
    const K = Math.max(1, Math.min(12, Math.floor(6500 / f)));
    for (let k = 1; k <= K; k++) {
      const amp = Math.sin(Math.PI * k * 0.18) / k; // щипок на ~1/5 длины струны
      const decay = 1.1 + 0.55 * (k - 1);
      const w = (2 * Math.PI * k * f) / sr;
      for (let i = 0; i < n; i++) out[i] += amp * Math.sin(w * i) * Math.exp((-decay * i) / sr);
    }
    let peak = 0;
    for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]));
    const attack = Math.floor(sr * 0.003);
    const release = Math.floor(sr * 0.06);
    for (let i = 0; i < n; i++) {
      let g = 0.9 / peak;
      if (i < attack) g *= i / attack;
      if (i > n - release) g *= (n - i) / release;
      out[i] *= g;
    }
    this.buffers.set(midi, buf);
    return buf;
  }

  /** Сыграть ноту синтезатором. mono=true глушит предыдущие ноты. */
  playNote(midi, { gain = 0.55, delay = 0, mono = true } = {}) {
    const ctx = this.ensure();
    const t = ctx.currentTime + delay;
    if (mono) this.stopVoices(t);
    const src = ctx.createBufferSource();
    src.buffer = this.noteBuffer(midi);
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(g);
    g.connect(this.synthBus);
    src.start(t);
    const voice = { src, g };
    this.voices.push(voice);
    src.onended = () => {
      const i = this.voices.indexOf(voice);
      if (i >= 0) this.voices.splice(i, 1);
      g.disconnect();
    };
  }

  strum(midis) {
    const ctx = this.ensure();
    this.stopVoices(ctx.currentTime);
    midis.forEach((m, i) => this.playNote(m, { gain: 0.3, delay: i * 0.028, mono: false }));
  }

  stopVoices(t) {
    for (const v of this.voices) {
      v.g.gain.cancelScheduledValues(t);
      v.g.gain.setTargetAtTime(0, t, 0.012);
      try {
        v.src.stop(t + 0.08);
      } catch {}
    }
  }

  /** Щелчок метронома. Частоты выше диапазона распознавания нот. */
  click(time, accent) {
    const ctx = this.ensure();
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.frequency.value = accent ? 2400 : 1700;
    g.gain.setValueAtTime(0, time);
    g.gain.linearRampToValueAtTime(accent ? 1 : 0.6, time + 0.001);
    g.gain.exponentialRampToValueAtTime(0.001, time + 0.035);
    osc.connect(g);
    g.connect(this.clickBus);
    osc.start(time);
    osc.stop(time + 0.05);
  }
}

export const webEngine = new Engine();
webEngine.metro = new WebMetronome(webEngine);
