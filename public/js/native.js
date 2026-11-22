// Движок для нативного приложения: звук обрабатывает PolyAmp.exe через ASIO,
// сюда приходят готовые измерения. Интерфейс тот же, что у веб-движка (audio.js).
import { NoteTracker } from './tracker.js';
import { NativeMetronome } from './metronome.js';

const bridge = window.chrome?.webview;

class NativeEngine {
  constructor() {
    this.isNative = true;
    this.listeners = {
      frame: new Set(),
      note: new Set(),
      onset: new Set(),
      state: new Set(),
      drivers: new Set(),
      block: new Set(),
      picked: new Set(),
      tabsLib: new Set(),
      songsterrSaved: new Set(),
      t3k: new Set(),
      library: new Set(),
      vst3: new Set(),
      vst3Error: new Set(),
    };
    this.tracker = new NoteTracker((type, data) => this.emit(type, data));
    this.frame = { rms: 0, level: 0, freq: null, midi: null, clarity: 0, note: null, active: false };
    this.drivers = [];
    this.audio = { open: false, error: null, driver: null, inputs: [], outputs: [], rates: [] };
    this.meters = { inPk: 0, outPk: 0, cpu: 0 };
    // что движок знает о файлах блоков: id блока → { loaded, path, name, error, source, … }
    this.blockInfo = new Map();
    this.tabsLibrary = null; // { dir, items: [{ rel, ext, size, mtime }] }
    this.fileRequests = new Map();
    this.fileSeq = 0;
    this.toneRequests = new Map(); // ожидающие загрузки тонов для пресетов: reqId → resolve
    this.toneSeq = 0;
    this.library = []; // «Мои тоны»: скачанное с TONE3000
    // установленные эффекты VST3: { available, scanned, scanning, progress, failed, folder, plugins: [{ path, cid, name, vendor, sub }] }
    this.vst3 = { available: false, scanned: false, scanning: false, progress: null, failed: [], folder: '', plugins: [] };
    this.t3k = { hasKey: false };
    this.lastChroma = null;
    this.ctx = null;
    this.metro = new NativeMetronome((m) => this.post(m));

    bridge.addEventListener('message', (e) => this.onMessage(e.data));
  }

  /** Интерфейс готов принимать сообщения — просим список драйверов и состояние звука. */
  start() {
    this.post({ t: 'ready' });
  }

  post(msg) {
    bridge.postMessage(msg);
  }

  on(type, fn) {
    this.listeners[type].add(fn);
    return () => this.listeners[type].delete(fn);
  }

  emit(type, data) {
    for (const fn of this.listeners[type]) fn(data);
  }

  get connected() {
    return this.audio.open;
  }

  ensure() {
    return null;
  }

  onMessage(m) {
    switch (m.t) {
      case 'frame': {
        this.meters = { inPk: m.inPk || 0, outPk: m.outPk || 0, cpu: m.cpu || 0, callbacks: m.cb || 0 };
        if (m.fault && !this.audio.error) {
          // обработка звука упала — показываем причину, а не молчим
          this.audio = { ...this.audio, error: 'Audio processing failed: ' + m.fault.split('\n')[0] };

          console.error('native fault:', m.fault);
          this.emit('state');
        }
        this.lastChroma = m.chroma ? { chroma: m.chroma, peakDb: m.peakDb } : null;
        this.frame = this.tracker.feed(m.rms, m.hf, () =>
          m.freq ? { freq: m.freq, clarity: m.clarity } : null
        );
        this.emit('frame', this.frame);
        break;
      }
      case 'beat':
        this.metro.beat(m.b);
        break;
      case 'drivers':
        this.drivers = m.drivers || [];
        this.emit('drivers', this.drivers);
        break;
      case 'audio':
        this.audio = m;
        if (m.open && this.metro.running) this.metro.apply();
        this.emit('state');
        break;
      case 'block':
        this.blockInfo.set(m.id, m);
        this.emit('block', m);
        break;
      case 'picked':
        this.emit('picked', m);
        break;
      case 'tabsLib':
        this.tabsLibrary = m;
        this.emit('tabsLib', m);
        break;
      case 'songsterrSaved':
        this.emit('songsterrSaved', m);
        break;
      case 'tabsFile':
      case 'tabsDeleted': {
        const done = this.fileRequests.get(m.reqId);
        this.fileRequests.delete(m.reqId);
        if (done) done(m);
        break;
      }
      case 't3kTone': {
        const done = this.toneRequests.get(m.reqId);
        this.toneRequests.delete(m.reqId);
        if (done) done(m);
        break;
      }
      case 'library':
        this.library = m.items || [];
        this.emit('library', this.library);
        break;
      case 'vst3':
        this.vst3 = { available: !!m.available, scanned: !!m.scanned, scanning: !!m.scanning, progress: m.progress || null, failed: m.failed || [], folder: m.folder || '', plugins: m.plugins || [] };
        this.emit('vst3', this.vst3);
        break;
      case 'vst3Error':
        this.emit('vst3Error', m);
        break;
      case 't3k':
        if (m.stage === 'status') this.t3k = { hasKey: !!m.hasKey };
        this.emit('t3k', m);
        break;
      case 'error':
        console.error('native:', m.error);
        break;
    }
  }

  // ---------- звук ----------

  open(driver, inCh = 0, outCh = 0, rate = 0) {
    this.post({ t: 'open', driver, inCh, outCh, rate });
  }

  close() {
    this.post({ t: 'close' });
  }

  showDriverPanel() {
    this.post({ t: 'panel' });
  }

  // ---------- цепочка блоков ----------

  /** Цепочка целиком: [{ id, type, on, file, size, params }]. Движок сам загрузит недостающие файлы. */
  setChain(blocks) {
    const ids = new Set(blocks.map((b) => b.id));
    for (const id of [...this.blockInfo.keys()]) if (!ids.has(id)) this.blockInfo.delete(id);
    this.post({ t: 'chain', blocks });
  }

  blockParam(id, p) {
    this.post({ t: 'bp', id, p });
  }

  blockOn(id, on) {
    this.post({ t: 'bon', id, on: on ? 1 : 0 });
  }

  /** Размер модели A2: 1 — Full, 0 — Lite. */
  blockSize(id, v) {
    this.post({ t: 'bsize', id, v });
  }

  /** Общие уровни: in.gain, out.level, out.mute, synth.level. */
  setGlobals(p) {
    this.post({ t: 'global', p });
  }

  // ---------- обход цепочки ----------

  /** Обход всей цепочки — послушать сухой сигнал. */
  setBypass(on) {
    this.post({ t: 'bypass', on: on ? 1 : 0 });
  }

  // ---------- библиотека табов ----------

  /** Попросить список табов из папки библиотеки; ответ — событие «tabsLib». */
  tabsLib() {
    this.post({ t: 'tabsLib' });
  }

  /** Выбрать папку библиотеки (диалог Windows). */
  tabsLibPick() {
    this.post({ t: 'tabsLibPick' });
  }

  /**
   * Прочитать таб из библиотеки по относительному пути.
   * @returns {Promise<{ok:boolean, name?:string, data?:Uint8Array, error?:string}>}
   */
  tabsRead(rel) {
    return new Promise((resolve) => {
      const reqId = ++this.fileSeq;
      this.fileRequests.set(reqId, (m) => {
        if (!m.ok) return resolve(m);
        const bin = atob(m.data);
        const data = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
        resolve({ ok: true, name: m.name, rel: m.rel, data });
      });
      this.post({ t: 'tabsRead', reqId, rel });
    });
  }

  /**
   * Удалить песню из библиотеки: файлы уходят в Корзину. После этого приходит свежий список «tabsLib».
   * @returns {Promise<{ok:boolean, canceled?:boolean, error?:string}>}
   */
  tabsDelete(rels) {
    return new Promise((resolve) => {
      const reqId = ++this.fileSeq;
      this.fileRequests.set(reqId, resolve);
      this.post({ t: 'tabsDelete', reqId, rels });
    });
  }

  /** Открыть PDF из библиотеки в обычном просмотрщике. */
  tabsOpen(rel) {
    this.post({ t: 'tabsOpen', rel });
  }

  /** Открыть диалог выбора своего файла; ответ придёт событием «picked» { id, path }. */
  pickFile(id, kind) {
    this.post({ t: 'pickFile', id, kind });
  }

  setChromaEnabled(on) {
    this.post({ t: 'chroma', on: on ? 1 : 0 });
  }

  chroma() {
    return this.lastChroma;
  }

  // ---------- TONE3000 ----------

  /**
   * Открыть каталог TONE3000 для блока.
   * @param {'pedal'|'amp'|'cab'|'space'} kind раздел каталога
   * @param {'1'|'2'} arch для моделей NAM: каталог A2 или прежних A1
   * @param {string|null} blockId в какой блок поставить выбранный тон
   */
  t3kSelect(kind, arch = '2', blockId = null) {
    this.post({ t: 't3kSelect', kind, arch, blockId });
  }

  /**
   * Скачать заранее известный тон (для готовых пресетов).
   * @returns {Promise<{ok:boolean, path?:string, error?:string, canceled?:boolean}>}
   */
  t3kLoadTone(toneId, kind, match = null) {
    return new Promise((resolve) => {
      const reqId = ++this.toneSeq;
      this.toneRequests.set(reqId, resolve);
      this.post({ t: 't3kLoadTone', reqId, toneId, kind, match });
    });
  }

  t3kDownload(id) {
    this.post({ t: 't3kDownload', id });
  }

  t3kSetKey(key) {
    this.post({ t: 't3kSetKey', key });
  }

  /** Открыть страницу TONE3000 в обычном браузере. */
  // ---------- VST3 ----------

  /** Найти установленные эффекты VST3 (force — заново все); ответ — событие «vst3». */
  vst3Scan(force = false) {
    this.post({ t: 'vst3Scan', force: force ? 1 : 0 });
  }

  /** Открыть окно плагина блока (отдельное окно приложения). */
  vst3Editor(id) {
    this.post({ t: 'vst3Editor', id });
  }

  openUrl(url) {
    this.post({ t: 'openUrl', url });
  }

  /**
   * Окно Songsterr: песня по ссылке или поиск по названию. Файл Guitar Pro, скачанный там их кнопкой,
   * сохраняется прямо в библиотеку (подпапка «Songsterr»); ответ — событие «songsterrSaved» { rel, name }.
   */
  songsterr(url = '', q = '') {
    this.post({ t: 'songsterr', url, q });
  }


  // ---------- синтезатор ----------

  playNote(midi, { gain = 0.55, delay = 0, mono = true } = {}) {
    this.post({ t: 'note', midi, gain, delay, mono: mono ? 1 : 0 });
  }

  strum(midis) {
    this.post({ t: 'strum', midis });
  }

  stopVoices() {
    this.post({ t: 'stop' });
  }
}

export const isNative = !!bridge;
export const nativeEngine = isNative ? new NativeEngine() : null;
