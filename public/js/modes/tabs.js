// Табы: файлы Guitar Pro (GP3–GP8, GPX) и MusicXML читает, рисует и проигрывает alphaTab.
// Режимы: «Слушать» — просто проигрывание; «Играть вместе» — таб играет, приложение слышит гитару
// и отмечает попадания; «Жди меня» — курсор стоит на ноте, пока её не сыграешь.
// У каждой дорожки — своя громкость, «заглушить» и «соло»; внизу можно открыть гриф с текущими нотами.
import { noteName, noteOctave } from '../music.js';
import { templateFromMidis } from '../chroma.js';
import { icon } from '../icons.js';
import { Fretboard } from '../fretboard.js';
import { createTabLibrary } from './tablib.js';
import { setTabReverb } from './tabreverb.js';

const VENDOR = 'vendor/alphatab/';
const ACCEPT = '.gp,.gp3,.gp4,.gp5,.gpx,.musicxml,.mxl,.xml';
const CHORD_SCORE = 0.72; // похожесть хромы на аккорд, при которой он считается сыгранным
const EARLY_MS = 160; // нота, сыгранная чуть раньше курсора, засчитывается
const LATE_MS = 160; // и чуть позже начала следующей доли
const MAX_RECENT = 12;
const SPEEDS = [25, 50, 60, 75, 90, 100, 110, 125];
const ZOOMS = [0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.4, 1.6];
const FRETS = 21;

// Пример-упражнение (своё, в формате alphaTex): пентатоника, аккорды, арпеджио — гитара и бас
const DEMO = `\\title "Poly Amp warm-up"
\\subtitle "pentatonic · chords · arpeggios"
\\tempo 84
.
\\track "Guitar"
\\instrument 27
\\staff {tabs}
\\tuning e4 b3 g3 d3 a2 e2
:8 5.6 8.6 5.5 7.5 5.4 7.4 5.3 7.3 | 5.2 8.2 5.1 8.1 5.1 8.2 5.2 7.3 |
:4 (0.5 2.4 2.3 1.2 0.1) (0.5 2.4 2.3 1.2 0.1) (3.5 2.4 0.3 1.2 0.1) (3.5 2.4 0.3 1.2 0.1) |
(3.6 2.5 0.4 0.3 0.2 3.1) (3.6 2.5 0.4 0.3 0.2 3.1) (0.6 2.5 2.4 0.3 0.2 0.1) (0.6 2.5 2.4 0.3 0.2 0.1) |
:8 0.5 2.4 2.3 1.2 0.1 1.2 2.3 2.4 | 3.5 2.4 0.3 1.2 0.1 1.2 0.3 2.4 |
:8 7.3 5.3 7.4 5.4 :4 7.5 5.5 | :2 (0.5 2.4 2.3 1.2 0.1) :2 r |
\\track "Bass"
\\instrument 33
\\staff {tabs}
\\tuning g2 d2 a1 e1
:4 5.4 5.4 5.4 5.4 | 5.4 5.4 3.4 3.4 |
5.4 5.4 3.3 3.3 | 3.4 3.4 0.4 0.4 |
5.4 5.4 5.4 5.4 | 3.3 3.3 3.3 3.3 |
5.4 5.4 3.4 3.4 | :2 5.4 :2 r |`;

let loading = null;
/** alphaTab грузим только при первом открытии вкладки — это 1,2 МБ скрипта. */
function loadAlphaTab() {
  if (window.alphaTab) return Promise.resolve(window.alphaTab);
  loading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = VENDOR + 'alphaTab.js';
    s.onload = () => (window.alphaTab ? resolve(window.alphaTab) : reject(new Error('alphaTab failed to load')));
    s.onerror = () => reject(new Error('alphaTab file not found'));
    document.head.append(s);
  });
  return loading;
}

// ---------- недавние файлы: хранятся в IndexedDB, чтобы открывать без поиска на диске ----------
function openDb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('polyamp-tabs', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('files', { keyPath: 'name' });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function dbAll() {
  try {
    const db = await openDb();
    return await new Promise((resolve) => {
      const req = db.transaction('files').objectStore('files').getAll();
      req.onsuccess = () => resolve(req.result.sort((a, b) => b.opened - a.opened));
      req.onerror = () => resolve([]);
    });
  } catch {
    return [];
  }
}
async function dbPut(name, data) {
  try {
    const db = await openDb();
    const all = await dbAll();
    const tx = db.transaction('files', 'readwrite');
    const st = tx.objectStore('files');
    st.put({ name, data, opened: Date.now() });
    for (const old of all.filter((x) => x.name !== name).slice(MAX_RECENT - 1)) st.delete(old.name);
    await new Promise((r) => (tx.oncomplete = tx.onerror = r));
  } catch {}
}
async function dbGet(name) {
  return (await dbAll()).find((x) => x.name === name) || null;
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

const midiName = (m) => noteName(m) + noteOctave(m);
const clock = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
};

/** Что за инструмент у дорожки: значок и подпись по номеру программы General MIDI. */
function instrument(t) {
  if (t.isPercussion) return { icon: 'drums', label: 'drums' };
  const p = t.playbackInfo?.program ?? 25;
  const guitars = ['acoustic, nylon', 'acoustic', 'electric, jazz', 'electric, clean', 'electric, muted', 'electric, overdrive', 'electric, distortion', 'harmonics'];
  if (p >= 24 && p <= 31) return { icon: 'guitar', label: 'guitar · ' + guitars[p - 24] };
  if (p >= 32 && p <= 39) return { icon: 'bass', label: 'bass' };
  if (p <= 23 || (p >= 80 && p <= 103)) return { icon: 'keys', label: p >= 80 ? 'synth' : 'keys' };
  if (p >= 52 && p <= 54) return { icon: 'voice', label: 'voice' };
  if (p >= 40 && p <= 55) return { icon: 'strings', label: 'strings' };
  return { icon: 'note', label: 'winds and other' };
}

/** Ссылка на страницу Songsterr в тексте (в том числе вставленном из буфера). */
const SS_LINK = /https?:\/\/(?:www\.)?songsterr\.com\/[^\s"'<>]+/i;

export function createTabs(root, { engine, store, chain }) {

  root.innerHTML = `
    <div class="tb-shell">
    <aside class="tb-lib" data-ref="lib" aria-label="Tab library"></aside>
    <div class="tb">
      <div class="tb-top">
        <button class="ib" data-ref="libBtn" aria-pressed="false" title="Library: tabs from your folder" aria-label="Library">${icon('library')}</button>
        <button class="btn btn-primary tb-open" data-ref="open" title="Open a Guitar Pro or MusicXML file (Ctrl+O)">${icon('folder')}<span>Open</span></button>
        <input type="file" accept="${ACCEPT}" data-ref="input" hidden>
        <button class="ib" data-ref="recentBtn" title="Recent tabs" aria-label="Recent tabs" aria-haspopup="true">${icon('recent')}</button>
        <div class="tb-song"><b data-ref="title"></b><span data-ref="artist"></span></div>
        <button class="tb-trackbtn" data-ref="trackBtn" aria-haspopup="true" title="Tracks: which one to show and play, volume of the others" hidden></button>
        <div class="seg tb-modes" data-ref="mode" hidden>
          <button data-v="listen" title="Just listen to the tab (1)">${icon('listen')}<span>Listen</span></button>
          <button data-v="along" title="The tab plays while the app listens to your guitar and marks hits (2)">${icon('guitar')}<span>Play along</span></button>
          <button data-v="wait" title="The cursor waits until you play the right note (3)">${icon('wait')}<span>Wait for me</span></button>
        </div>
        <button class="ib" data-ref="songsterr" hidden title="${engine.isNative ? 'Songsterr: find a song and download its Guitar Pro file straight into your library. Tip: copy a song link and press Ctrl+V here' : 'Find this song on Songsterr (opens in your browser)'}" aria-label="Songsterr">${icon(engine.isNative ? 'download' : 'external')}</button>
      </div>

      <div class="tb-transport" data-ref="transport" hidden>
        <button class="ib" data-ref="rewind" title="Back to start (Home)" aria-label="Back to start">${icon('rewind')}</button>
        <button class="ib ib-play" data-ref="start" aria-label="Play" title="Play (Space)">${icon('play')}</button>
        <button class="ib ib-play" data-ref="hear" hidden title="Hear what to play (Space)" aria-label="Hear the note">${icon('note')}</button>
        <button class="ib" data-ref="skip" hidden title="Skip the note (S)" aria-label="Skip the note">${icon('skip')}</button>
        <div class="tb-time">
          <span data-ref="time">0:00</span>
          <div class="tb-progress" data-ref="progress" title="Seek. ← / → — a bar back or forward"><i data-ref="bar"></i></div>
          <span data-ref="total">0:00</span>
        </div>
        <button class="tb-chip" data-ref="speedBtn" title="Speed (− / +)" aria-haspopup="true">${icon('speed')}<span data-ref="speedOut"></span></button>
        <button class="ib" data-ref="loop" aria-pressed="false" title="Loop: repeat over and over. Select bars with the mouse to loop only them (L)">${icon('loop')}</button>
        <button class="ib" data-ref="metro" aria-pressed="false" title="Metronome click (M)">${icon('metronome')}</button>
        <button class="ib" data-ref="countIn" aria-pressed="false" title="Count-in bar before playback (C)">${icon('countIn')}</button>
        <span class="tb-sep"></span>
        <button class="ib" data-ref="volBtn" title="Tab volume and reverb" aria-haspopup="true"></button>
        <button class="ib" data-ref="profile" aria-pressed="false" title="Show notation above the tab (N)" aria-label="Notation above the tab">${icon('staff')}</button>
        <button class="ib" data-ref="zoomOut" title="Smaller (Ctrl+−)" aria-label="Smaller">${icon('zoomOut')}</button>
        <button class="ib" data-ref="zoomIn" title="Larger (Ctrl++)" aria-label="Larger">${icon('zoomIn')}</button>
        <button class="ib" data-ref="fretBtn" aria-pressed="false" title="Fretboard with the notes that sound (or that you need to play) (F)" aria-label="Fretboard">${icon('fretboard')}</button>
      </div>

      <div class="tb-status" data-ref="status" hidden>
        <div class="tb-expect" data-ref="expect"></div>
        <div class="tb-heard">Hearing: <b data-ref="heard">—</b></div>
        <div class="tb-acc"><div class="tb-accbar"><i data-ref="accBar"></i></div><span data-ref="stats"></span></div>
      </div>

      <div class="notice notice-error" data-ref="error" hidden></div>

      <div class="tb-score" data-ref="scroll">
        <div class="tb-empty" data-ref="empty">
          <div class="tb-drop">
            <h3>Open a Guitar Pro tab</h3>
            <p>Files <b>.gp</b>, <b>.gp5</b>, <b>.gp4</b>, <b>.gp3</b>, <b>.gpx</b> and MusicXML — use the button or drop a file here.
              The tab plays along with the other instruments, and each track has its own volume. You can slow it down, loop a section
              and play along — the app will hear your guitar.</p>
            <div class="tb-drop-actions">
              <button class="btn btn-primary btn-lg" data-ref="open2">${icon('folder')} Open file…</button>
              <button class="btn btn-lg" data-ref="demo">Example exercise</button>
            </div>
          </div>
          <form class="tb-ss" data-ref="ssForm">
            ${engine.isNative
              ? `<div><b>Get it from Songsterr.</b> Copy a song link there and press <kbd>Ctrl</kbd>+<kbd>V</kbd> here — or type a band or song below.
                 The window asks you to sign in to Songsterr once, then shows the song: press the download button and choose <b>Guitar Pro</b> — the file goes straight into your library and opens here.</div>

                 <div class="tb-ss-row"><input class="text-input" data-ref="ssQuery" placeholder="Songsterr link, band or song" spellcheck="false"><button class="btn btn-primary">${icon('download')} Open Songsterr</button></div>`
              : `<div><b>No file?</b> Find the song on Songsterr — you can view and hear tabs there in your browser.</div>
                 <div class="tb-ss-row"><input class="text-input" data-ref="ssQuery" placeholder="Band or song" spellcheck="false"><button class="btn">${icon('external')} Find on Songsterr</button></div>`}
          </form>
        </div>
        <div class="tb-paper" data-ref="paper" hidden>
          <div class="tb-at" data-ref="at"></div>
          <div class="tb-marks" data-ref="marks"></div>
        </div>
        <div class="tb-loading" data-ref="loading" hidden>Loading…</div>
      </div>

      <div class="tb-fret" data-ref="fret" hidden></div>
      <div class="tb-pop" data-ref="pop" hidden></div>
      <div class="tb-toast" data-ref="toast" role="status" hidden></div>
    </div>
    </div>`;
  const ref = {};
  for (const n of root.querySelectorAll('[data-ref]')) ref[n.dataset.ref] = n;
  const tb = root.querySelector('.tb');
  const shell = root.querySelector('.tb-shell');

  const opts = Object.assign(
    { volume: 70, speed: 100, loop: false, metro: false, countIn: false, mode: 'listen', profile: 'tab', zoom: 1, fret: false, lib: engine.isNative, reverb: 40 },
    store.get('tabs.opts', {})
  );
  const saveOpts = () => store.set('tabs.opts', opts);
  setTabReverb(opts.reverb / 100);

  let AT = null;
  let api = null;
  let score = null;
  let track = null;
  let fileName = null;
  let fileKey = null;
  let fileTitle = null; // название для заголовка, если в самом файле его нет // ключ настроек песни (дорожка, микшер): путь в библиотеке или имя файла
  let ready = false; // звук загружен, можно играть
  let playing = false;
  let active = false;
  let endTime = 0;
  let mix = { vol: {}, mute: {}, solo: {} }; // по номеру дорожки
  const marks = new Map(); // доля → 'hit' | 'miss'
  const stats = { hit: 0, total: 0, streak: 0, best: 0 };
  const songKey = () => fileKey || fileName || 'demo';

  // ---------- сообщения ----------
  function showError(text) {
    ref.error.hidden = !text;
    ref.error.textContent = text || '';
  }
  function setLoading(on, text = 'Loading…') {
    ref.loading.hidden = !on;
    ref.loading.textContent = text;
  }

  // ---------- всплывающие панели (недавние, дорожки, скорость, громкость) ----------
  let popFor = null;
  function openPop(anchor, build) {
    if (popFor === anchor) return closePop();
    popFor = anchor;
    ref.pop.replaceChildren();
    // окно одно на все кнопки: убираем ширину и место прошлого окна (раньше после «громкости» микшер сжимался до 280 px)
    ref.pop.className = 'tb-pop';
    ref.pop.style.left = '0px';
    build(ref.pop);
    ref.pop.hidden = false;
    const tr = tb.getBoundingClientRect();
    const ar = anchor.getBoundingClientRect();
    const w = ref.pop.offsetWidth;
    ref.pop.style.left = Math.max(0, Math.min(tr.width - w, ar.left - tr.left + ar.width / 2 - w / 2)) + 'px';
    ref.pop.style.top = ar.bottom - tr.top + 8 + 'px';
    anchor.setAttribute('aria-expanded', 'true');
  }
  function closePop() {
    popFor?.setAttribute('aria-expanded', 'false');
    popFor = null;
    ref.pop.hidden = true;
  }
  document.addEventListener('pointerdown', (e) => {
    if (popFor && !ref.pop.contains(e.target) && !popFor.contains(e.target)) closePop();
  });
  document.addEventListener('keydown', (e) => e.key === 'Escape' && popFor && closePop());

  // ---------- alphaTab ----------
  let apiPromise = null;
  function ensureApi() {
    // одна загрузка на всех: вызовы во время загрузки ждут ту же самую
    apiPromise ??= createApi().catch((e) => {
      apiPromise = null;
      throw e;
    });
    return apiPromise;
  }
  async function createApi() {
    if (api) return api;
    setLoading(true, 'Loading the tab module…');
    try {
      AT = await loadAlphaTab();
    } catch (e) {
      setLoading(false);
      showError('Couldn’t load the tab module: ' + e.message);
      throw e;
    }
    const base = new URL(VENDOR, location.href).href;
    api = new AT.AlphaTabApi(ref.at, {
      // includeNoteBounds: границы каждой ноты — по ним подсвечиваются попадания и промахи
      core: { fontDirectory: base + 'font/', scriptFile: base + 'alphaTab.js', includeNoteBounds: true },
      display: {
        staveProfile: profileValue(),
        scale: opts.zoom,
        layoutMode: AT.LayoutMode.Page,
        // тёмный лист: светлые ноты и цифры, приглушённые линейки
        resources: {
          mainGlyphColor: '#e6e8f0',
          secondaryGlyphColor: 'rgba(230, 232, 240, 0.45)',
          scoreInfoColor: '#e6e8f0',
          staffLineColor: '#4b4d5c',
          barSeparatorColor: '#8a8d9e',
          barNumberColor: '#a98bff',
        },
      },
      player: {
        enablePlayer: true,
        playerMode: AT.PlayerMode.EnabledSynthesizer,
        soundFont: base + 'soundfont/sonivox.sf2',
        scrollElement: ref.scroll,
        scrollOffsetY: -40,
        enableCursor: true,
        enableAnimatedBeatCursor: true,
        enableElementHighlighting: true,
        enableUserInteraction: true,
        enablePlaybackRangeSelection: true,
      },
    });
    setLoading(false);
    api.scoreLoaded.on(onScore);
    api.renderFinished.on(() => {
      setLoading(false);
      drawMarks();
    });
    api.playerReady.on(() => {
      ready = true;
      applyPlayer();
      applyMix();
      syncTransport();
      if (opts.mode === 'wait') startWait();
    });
    api.playerStateChanged.on((e) => {
      playing = e.state === 1;
      syncTransport();
      runTicker(playing && opts.mode === 'along');
      if (!playing) closeAllPending();
    });
    // позиция приходит десятки раз в секунду — страницу трогаем, только когда цифра или полоса правда изменились
    let shown = { time: '', total: '', bar: '' };
    api.playerPositionChanged.on((e) => {
      endTime = e.endTime;
      const time = clock(e.currentTime);
      const total = clock(e.endTime);
      const bar = (e.endTime ? Math.min(1, e.currentTime / e.endTime) : 0).toFixed(3);
      if (time !== shown.time) ref.time.textContent = shown.time = time;
      if (total !== shown.total) ref.total.textContent = shown.total = total;
      if (bar !== shown.bar) ref.bar.style.transform = `scaleX(${(shown.bar = bar)})`;
    });
    api.playedBeatChanged.on(onPlayedBeat);
    // какие дорожки сейчас звучат: alphaTab сообщает о каждой сыгранной ноте, синхронно со звуком
    api.midiEventsPlayedFilter = [AT.midi.MidiEventType.NoteOn];
    api.midiEventsPlayed.on(onNotesPlayed);
    // звук готов один раз на всё время, а разметка долей по времени — заново для каждой песни
    api.midiLoaded.on(() => {
      applyMix();
      if (opts.mode === 'wait' && ready) startWait();
    });
    api.beatMouseDown.on((beat) => opts.mode === 'wait' && jumpTo(beat));
    api.error.on((e) => {
      setLoading(false);
      showError(friendlyError(e?.message || String(e)));
    });
    return api;
  }

  /** Есть ли у дорожки табулатура: у клавишных и ударных её нет — их показываем нотами. */
  const hasTab = (tr) => !!tr && tr.staves.some((s) => s.showTablature && !s.isPercussion);
  const profileValue = () =>
    track && !hasTab(track) ? AT.StaveProfile.Default : opts.profile === 'both' ? AT.StaveProfile.ScoreTab : AT.StaveProfile.Tab;

  /** Ошибки разбора — по-человечески: что случилось и что можно сделать. */
  function friendlyError(msg) {
    if (/safety threshold|end of data|unexpected end|unsupported format|no reader/i.test(msg))
      return 'Couldn’t parse the file: it seems to be damaged or saved in a format variant the tab module doesn’t understand. ' +
        'If the song has another version (.gp or .gpx), open that one, or re-save the file in Guitar Pro.';
    return 'Couldn’t show the tab: ' + msg;
  }

  // мастер-громкость из шапки действует и на табы (они звучат через Windows, а не через ASIO)
  const masterGain = () =>
    !chain ? 1 : chain.global('master.mute') > 0.5 ? 0 : Math.min(2, Math.pow(10, chain.global('master.level') / 20));
  chain?.on((what, d) => what === 'global' && d.name.startsWith('master.') && applyPlayer());
  function setVolume(v) {
    opts.volume = Math.max(0, Math.min(100, Math.round(v)));
    saveOpts();
    applyPlayer();
    syncTransport();
  }

  function applyPlayer() {
    if (!api) return;
    // скорость — только если изменилась: alphaTab при каждой записи скорости перематывает на то же место,
    // и звучащие ноты обрываются (громкость, петля и клик во время игры давали заикание)
    if (Math.abs(api.playbackSpeed - opts.speed / 100) > 1e-6) api.playbackSpeed = opts.speed / 100;
    api.masterVolume = (opts.volume / 100) * masterGain();
    api.isLooping = opts.loop;
    api.metronomeVolume = opts.metro ? 1 : 0;
    api.countInVolume = opts.countIn ? 1 : 0;
  }

  // ---------- микшер дорожек ----------
  function loadMix() {
    const m = store.get('tabs.mix.' + songKey(), null);
    mix = { vol: { ...(m?.vol || {}) }, mute: { ...(m?.mute || {}) }, solo: { ...(m?.solo || {}) } };
  }
  const saveMix = () => store.set('tabs.mix.' + songKey(), mix);
  // ---------- индикаторы: какие дорожки сейчас играют ----------
  // На каждую ноту дорожки — вспышка по её громкости, дальше плавно гаснет (половина за 140 мс).
  // Заглушённые и выключенные соло дорожки вспыхивают серым: играют, но не слышны.
  let levels = []; // по номеру дорожки, 0..1
  let meterRaf = 0;
  let meterT = 0;
  let meterDrawn = 0; // когда индикаторы рисовались в последний раз
  const audible = (i) => !mix.mute[i] && (!Object.values(mix.solo).some(Boolean) || !!mix.solo[i]);
  function onNotesPlayed(e) {
    for (const ev of e.events) {
      if (ev.type !== 128) continue; // NoteOn
      levels[ev.track] = Math.max(levels[ev.track] || 0, 0.35 + 0.65 * ((ev.noteVelocity || 0) / 127));
    }
    if (!meterRaf) meterRaf = requestAnimationFrame(drawMeters);
  }
  function drawMeters(t) {
    const k = Math.pow(0.5, (meterT ? Math.min(100, t - meterT) : 16) / 140);
    meterT = t;
    let any = false;
    for (let i = 0; i < levels.length; i++) {
      if (!levels[i]) continue;
      levels[i] = levels[i] < 0.02 ? 0 : levels[i] * k;
      any ||= levels[i] > 0;
    }
    // всё, что показывает уровень дорожки: строки окна «Tracks» и кнопка текущей дорожки.
    // Рисуем не чаще 30 раз в секунду: на мониторе 240 Гц перерисовка на каждом кадре заметно грузила систему.
    if (!any || t - meterDrawn >= 33) {
      meterDrawn = t;
      for (const n of root.querySelectorAll('[data-meter]')) {
        const i = +n.dataset.meter;
        n.style.setProperty('--lvl', (levels[i] || 0).toFixed(2));
        n.classList.toggle('is-silent', !audible(i));
      }
    }
    meterRaf = any ? requestAnimationFrame(drawMeters) : 0;
    if (!any) meterT = 0;
  }

  function applyMix() {
    if (!api || !score) return;
    score.tracks.forEach((t, i) => {
      api.changeTrackVolume([t], mix.vol[i] ?? 1);
      api.changeTrackMute([t], !!mix.mute[i]);
      api.changeTrackSolo([t], !!mix.solo[i]);
    });
  }
  function setMix(kind, i, value) {
    mix[kind][i] = value;
    saveMix();
    applyMix();
    renderTrackBtn();
  }

  function renderTrackBtn() {
    if (!track) return;
    const inst = instrument(track);
    const i = track.index;
    ref.trackBtn.dataset.meter = i;
    const muted = !!mix.mute[i];
    ref.trackBtn.innerHTML = `${icon(inst.icon, 'tb-tr-ic')}<span class="tb-tr-txt"><b></b><small></small></span>${muted ? icon('volumeOff', 'tb-tr-muted') : ''}${icon('chevron', 'tb-tr-chev')}`;
    ref.trackBtn.querySelector('b').textContent = track.name || `Track ${i + 1}`;
    ref.trackBtn.querySelector('small').textContent = score.tracks.length > 1 ? `${inst.label} · ${i + 1} of ${score.tracks.length}` : inst.label;
    ref.trackBtn.title = muted ? 'Your track is muted — you play it. Tracks: volume, mute, solo' : 'Tracks: which one to show and play, volume, mute, solo';
  }

  function buildMixer(box) {
    box.classList.add('tb-mixer');
    const head = el('div', 'tb-pop-head');
    head.append(el('b', '', 'Tracks'), el('small', '', 'click a name to show and play it; volume, mute and solo for each'));
    box.append(head);
    score.tracks.forEach((t, i) => {
      const inst = instrument(t);
      const row = el('div', 'mx-row' + (t === track ? ' is-active' : ''));
      row.dataset.meter = i;
      row.style.setProperty('--lvl', (levels[i] || 0).toFixed(3));
      const lvl = el('span', 'mx-meter');
      lvl.append(el('i'));
      lvl.title = 'Lights up while this track plays (grey — playing but muted)';
      const pick = el('button', 'mx-pick');
      pick.innerHTML = icon(inst.icon);
      const txt = el('span', 'mx-txt');
      txt.append(el('b', '', t.name || `Track ${i + 1}`), el('small', '', inst.label));
      pick.append(txt);
      pick.title = t === track ? 'This track is on screen' : 'Show and play this track';
      pick.addEventListener('click', () => {
        closePop();
        if (t !== track) selectTrack(i, true);
      });
      const mute = el('button', 'ib ib-sm');
      const syncMute = () => {
        mute.innerHTML = icon(mix.mute[i] ? 'volumeOff' : 'volume');
        mute.setAttribute('aria-pressed', !!mix.mute[i]);
        mute.title = mix.mute[i] ? 'Unmute the track' : 'Mute the track';
      };
      mute.addEventListener('click', () => {
        setMix('mute', i, !mix.mute[i]);
        syncMute();
        row.classList.toggle('is-muted', !!mix.mute[i]);
      });
      const solo = el('button', 'ib ib-sm mx-solo');
      solo.innerHTML = icon('solo');
      const syncSolo = () => {
        solo.setAttribute('aria-pressed', !!mix.solo[i]);
        solo.title = mix.solo[i] ? 'Unsolo' : 'Solo: hear only this track (and other soloed ones)';
      };
      solo.addEventListener('click', () => {
        setMix('solo', i, !mix.solo[i]);
        syncSolo();
      });
      const vol = el('input');
      vol.type = 'range';
      vol.min = 0;
      vol.max = 150;
      vol.step = 5;
      vol.value = Math.round((mix.vol[i] ?? 1) * 100);
      vol.setAttribute('aria-label', 'Volume: ' + (t.name || `track ${i + 1}`));
      const val = el('span', 'mx-val', vol.value);
      vol.addEventListener('input', () => {
        val.textContent = vol.value;
        setMix('vol', i, vol.value / 100);
      });
      vol.addEventListener('dblclick', () => {
        vol.value = 100;
        val.textContent = 100;
        setMix('vol', i, 1);
      });
      syncMute();
      syncSolo();
      row.classList.toggle('is-muted', !!mix.mute[i]);
      row.append(lvl, pick, mute, solo, vol, val);
      box.append(row);
    });
    if (Object.values(mix.solo).some(Boolean)) box.append(el('p', 'tb-pop-note', 'Solo is on: the other tracks are silent.'));
  }

  // ---------- открытие ----------
  async function openBytes(name, data, key = null, title = null) {
    showError(null);
    await ensureApi();
    setLoading(true, 'Opening “' + name + '”…');
    fileName = name;
    fileKey = key;
    fileTitle = title || name.replace(/\.[^.]+$/, '');
    library.setCurrent(key?.startsWith('lib:') ? key.slice(4) : null);
    const ok = api.load(new Uint8Array(data));
    if (!ok) {
      setLoading(false);
      showError(friendlyError('unsupported format')); // в том числе .gp5, который модуль табов не смог прочитать
      return;
    }
    dbPut(name, data);
  }

  /** Таб из библиотеки: файл читает приложение (только внутри выбранной папки). */
  async function openFromLibrary(rel, title) {
    showError(null);
    setLoading(true, 'Opening “' + title + '”…');
    const r = await engine.tabsRead(rel);
    if (!r.ok) {
      setLoading(false);
      showError(r.error || 'Couldn’t open the file.');
      return;
    }
    await openBytes(r.name, r.data, 'lib:' + rel, title);
  }

  const library = createTabLibrary(ref.lib, {
    engine,
    store,
    onOpen: (rel, title) => openFromLibrary(rel, title).catch(() => {}),
    onSongsterr: () => songsterr(),
  });

  function setLibOpen(on) {
    opts.lib = on;
    saveOpts();
    shell.classList.toggle('lib-open', on);
    ref.libBtn.setAttribute('aria-pressed', on);
    if (on) library.load();
    // ширина листа поменялась — перерисовываем таб под неё
    if (api && score) requestAnimationFrame(() => api.render());
  }
  ref.libBtn.addEventListener('click', () => setLibOpen(!opts.lib));

  async function openFile(file) {
    if (!file) return;
    try {
      await openBytes(file.name, await file.arrayBuffer());
    } catch (e) {
      showError('Couldn’t read the file: ' + e.message);
    }
  }

  async function openDemo() {
    showError(null);
    await ensureApi();
    setLoading(true, 'Opening the example…');
    fileName = null;
    fileKey = null;
    library.setCurrent(null);
    api.tex(DEMO);
  }

  function onScore(s) {
    score = s;
    levels = [];
    closePop();
    ref.empty.hidden = true;
    ref.paper.hidden = false;
    ref.transport.hidden = false;
    ref.mode.hidden = false;
    ref.trackBtn.hidden = false;
    ref.title.textContent = s.title || (fileName ? fileTitle : '') || 'Untitled';
    ref.artist.textContent = s.artist ? ' — ' + s.artist : '';
    ref.songsterr.hidden = !engine.isNative && (!fileName || !(s.title || s.artist)); // в браузере для своего примера искать нечего
    ref.time.textContent = '0:00';
    ref.bar.style.transform = 'scaleX(0)';
    loadMix();
    // дорожка, которую ты сам выбрал для этой песни, иначе — первая гитара
    const saved = store.get('tabs.pick.' + songKey(), null);
    selectTrack(saved != null && s.tracks[saved] ? saved : defaultTrack(s));
  }

  /** Дорожка по умолчанию — основная гитара. В файлах Songsterr у вокала тоже есть табулатура и шесть «струн»,
      поэтому гитару узнаём по инструменту (General MIDI 24–31) и названию, а не по строю. Из нескольких гитар
      берём ту, где больше всего нот: это основная партия, а не дорожка с парой нот фидбэка или эффекта. */
  const VOCAL = /vocal|voice|vox|sing|choir|вокал|голос/i;
  function defaultTrack(s) {
    const own = s.tracks.filter((t) => !t.isPercussion);
    const strings = (t) => t.staves[0]?.tuning?.length || 0;
    const guitarSound = (t) => t.playbackInfo.program >= 24 && t.playbackInfo.program <= 31;
    const counts = new Map();
    const notes = (t) => {
      if (!counts.has(t)) {
        let n = 0;
        for (const st of t.staves) for (const bar of st.bars) for (const v of bar.voices) for (const b of v.beats) n += b.notes.length;
        counts.set(t, n);
      }
      return counts.get(t);
    };
    const most = (list) => list.reduce((best, t) => (!best || notes(t) > notes(best) ? t : best), null);
    const pick =
      most(own.filter((t) => guitarSound(t) && hasTab(t) && !VOCAL.test(t.name))) ||
      most(own.filter((t) => hasTab(t) && strings(t) >= 6 && !VOCAL.test(t.name))) ||
      own.find((t) => strings(t));
    return pick ? pick.index : 0;
  }

  /** user — выбор из меню дорожек: его запоминаем для песни. Автоматический выбор не сохраняем,
      иначе он выглядел бы как твой и не исправлялся бы. */
  function selectTrack(i, user = false) {
    track = score.tracks[i];
    if (user) store.set('tabs.pick.' + songKey(), i);
    marks.clear();
    resetStats();
    if (opts.mode === 'along') muteOwnTrack();
    renderTrackBtn();
    setLoading(true, 'Rendering the tab…');
    // у дорожки без табулатуры (клавишные, ударные) режим «только таб» нечего показывать — берём ноты
    const want = profileValue();
    if (api.settings.display.staveProfile !== want) {
      api.settings.display.staveProfile = want;
      api.updateSettings();
    }
    showError(null);
    api.renderTracks([track]);
    applyPlayer();
    applyMix();
    syncTransport(); // например, значок «ноты над табом» неактивен у дорожки без таба
    setupFretboard();
    if (opts.mode === 'wait' && ready) startWait();
  }

  /** «Играть вместе» удобнее без своей партии: её сыграешь ты. */
  function muteOwnTrack() {
    if (!track || mix.mute[track.index]) return;
    mix.mute[track.index] = true;
    saveMix();
    applyMix();
    renderTrackBtn();
  }

  // ---------- гриф ----------
  let fb = null;
  const fretFits = () => (track?.staves[0]?.tuning?.length || 0) === 6;
  function setupFretboard() {
    const show = opts.fret && !!track;
    tb.classList.toggle('has-fret', show);
    ref.fret.hidden = !show;
    ref.fretBtn.setAttribute('aria-pressed', !!opts.fret);
    if (!show) return;
    if (!fretFits()) {
      ref.fret.replaceChildren(el('p', 'tb-pop-note', 'The fretboard is shown for six-string tracks.'));
      fb = null;
      return;
    }
    if (!fb) {
      ref.fret.replaceChildren();
      fb = new Fretboard(ref.fret, { frets: FRETS });
    }
  }
  function showOnFret(notes, kind) {
    if (!fb || ref.fret.hidden) return;
    fb.setMarkers(
      notes
        .filter((n) => n.string >= 1 && n.string <= 6 && n.fret <= FRETS && !n.isDead)
        .map((n) => ({ s: n.string - 1, f: n.fret, kind: n.fret === 0 && kind === 'chord' ? 'open' : kind, label: n.fret ? String(n.fret) : undefined }))
    );
  }

  // ---------- что нужно сыграть на доле ----------
  function expected(beat) {
    if (!beat || beat.isRest || beat.graceType !== 0 || beat.voice?.bar?.staff?.track !== track) return null;
    const notes = beat.notes.filter((n) => !n.isDead && !n.isTieDestination && n.isVisible !== false && !n.isPercussion);
    if (!notes.length) return null;
    const midis = notes.map((n) => n.realValue);
    return { beat, notes, midis, template: midis.length >= 3 ? templateFromMidis(midis) : null };
  }

  const matchNote = (exp, midi) => exp.midis.some((m) => m === midi || Math.abs(m - midi) === 12); // октавные ошибки распознавания прощаем

  function chordScore(exp) {
    const c = engine.chroma();
    if (!c || !exp.template || c.peakDb < -60) return 0;
    let dot = 0;
    for (let i = 0; i < 12; i++) dot += c.chroma[i] * exp.template[i];
    return dot;
  }

  function describe(exp) {
    if (!exp) return '';
    const strings = track.staves[0]?.tuning?.length || 6;
    if (exp.notes.length >= 3) return `chord: ${exp.midis.map(midiName).join(' ')}`;
    const ord = (k) => k + (k === 1 ? 'st' : k === 2 ? 'nd' : k === 3 ? 'rd' : 'th');
    return exp.notes
      .map((n) => `${ord(strings - n.string + 1)} string, ${n.fret ? 'fret ' + n.fret : 'open'} (${midiName(n.realValue)})`)
      .join(' + ');
  }

  // ---------- отметки на табе ----------
  // Попадание, промах и нота, которую ждём, перекрашивают сами цифры на табе (они — <text> в SVG alphaTab).
  // Цифру находим по границам ноты; без цифры (ноты на нотном стане) остаются прежние точка и рамка.
  const DIGIT = {
    hit: { fill: '#3fd39a', glow: 'drop-shadow(0 0 3px rgba(63, 211, 154, 0.75))' },
    miss: { fill: '#ef6a6a', glow: 'drop-shadow(0 0 3px rgba(239, 106, 106, 0.7))' },
    cur: { fill: '#a6a8ff', glow: 'drop-shadow(0 0 4px rgba(124, 127, 242, 0.95))' },
  };
  let digits = null; // [{ el, cx, cy }] цифр табулатуры в координатах листа; сбрасывается при перерисовке
  const painted = new Set();
  function digitIndex() {
    if (digits) return digits;
    const base = ref.at.getBoundingClientRect();
    digits = [];
    for (const t of ref.at.querySelectorAll('svg text')) {
      if (!t.textContent.trim()) continue;
      const r = t.getBoundingClientRect();
      digits.push({ el: t, cx: r.left - base.left + r.width / 2, cy: r.top - base.top + r.height / 2 });
    }
    return digits;
  }
  // alphaTab дорисовывает части листа по мере прокрутки — тогда пересобираем список цифр и красим заново
  let markRaf = 0;
  new MutationObserver(() => {
    digits = null;
    if (marks.size || waitCur) {
      cancelAnimationFrame(markRaf);
      markRaf = requestAnimationFrame(drawMarks);
    }
  }).observe(ref.at, { childList: true, subtree: true });

  function drawMarks() {
    ref.marks.replaceChildren();
    for (const t of painted) t.style.removeProperty('fill'), t.style.removeProperty('filter');
    painted.clear();
    const bl = api?.boundsLookup;
    if (!bl) return;
    for (const [beat, kind] of marks) placeMark(bl, beat, kind);
    if (opts.mode === 'wait' && waitCur) placeMark(bl, waitCur.exp.beat, 'cur');
  }
  function placeMark(bl, beat, kind) {
    const b = bl.findBeat(beat);
    if (!b) return;
    const heads = (b.notes || []).map((n) => n.noteHeadBounds).filter((r) => r && r.w > 0 && r.h > 0);
    let found = 0;
    if (heads.length) {
      const style = DIGIT[kind];
      for (const d of digitIndex()) {
        if (!heads.some((r) => d.cx >= r.x - 2 && d.cx <= r.x + r.w + 2 && d.cy >= r.y - 3 && d.cy <= r.y + r.h + 3)) continue;
        d.el.style.setProperty('fill', style.fill);
        d.el.style.setProperty('filter', style.glow);
        painted.add(d.el);
        found++;
      }
    }
    if (found) return;
    const v = b.visualBounds;
    const m = el('i', 'tb-mark ' + kind);
    if (kind === 'cur') Object.assign(m.style, { left: v.x - 4 + 'px', top: v.y - 4 + 'px', width: v.w + 8 + 'px', height: v.h + 8 + 'px' });
    else Object.assign(m.style, { left: v.x + v.w / 2 + 'px', top: v.y - 10 + 'px' });
    ref.marks.append(m);
  }
  function mark(beat, kind) {
    marks.set(beat, kind);
    stats.total++;
    if (kind === 'hit') {
      stats.hit++;
      stats.streak++;
      stats.best = Math.max(stats.best, stats.streak);
    } else stats.streak = 0;
    const bl = api?.boundsLookup;
    if (bl) placeMark(bl, beat, kind);
    renderStats();
  }
  function resetStats() {
    Object.assign(stats, { hit: 0, total: 0, streak: 0, best: 0 });
    pending.length = 0;
    renderStats();
  }
  function renderStats() {
    const pct = stats.total ? Math.round((stats.hit / stats.total) * 100) : 0;
    ref.stats.textContent = stats.total ? `${pct} % · ${stats.hit} of ${stats.total} · streak ${stats.streak}, best ${stats.best}` : 'accuracy shows up once you start playing';
    ref.accBar.style.transform = `scaleX(${(pct / 100).toFixed(3)})`;
    ref.accBar.classList.toggle('is-good', pct >= 80);
    ref.accBar.classList.toggle('is-bad', stats.total > 0 && pct < 50);
  }

  // ---------- «Играть вместе»: каждую долю ждём в окне вокруг её начала ----------
  const pending = []; // { exp, t, until, frames, onset }
  const recent = []; // недавно услышанные ноты { midi, t }

  function onPlayedBeat(beat) {
    if (beat?.voice?.bar?.staff?.track === track && opts.mode !== 'wait') showOnFret(beat.notes, 'chord');
    if (opts.mode !== 'along' || !playing) return;
    const now = performance.now();
    for (const p of pending) if (p.until == null) p.until = now + LATE_MS; // прошлой доле — ещё немного времени
    const exp = expected(beat);
    if (!exp) return;
    const p = { exp, t: now, until: null, frames: 0 };
    // нота могла прозвучать чуть раньше курсора
    if (recent.some((r) => now - r.t < EARLY_MS && matchNote(exp, r.midi) && !exp.template)) return hit(p);
    pending.push(p);
  }
  function hit(p) {
    const i = pending.indexOf(p);
    if (i >= 0) pending.splice(i, 1);
    mark(p.exp.beat, 'hit');
  }
  function closeExpired(now) {
    for (let i = pending.length - 1; i >= 0; i--) {
      const p = pending[i];
      if (p.until != null && now > p.until) {
        pending.splice(i, 1);
        mark(p.exp.beat, 'miss');
      }
    }
  }
  function closeAllPending() {
    pending.length = 0;
  }
  // окна долей закрывает свой таймер: на кадры анализа полагаться нельзя — без гитары их может не быть
  let ticker = null;
  function tick() {
    closeExpired(performance.now());
    for (const p of [...pending]) {
      if (!p.exp.template || !p.onset) continue;
      p.frames = chordScore(p.exp) >= CHORD_SCORE ? p.frames + 1 : 0;
      if (p.frames >= 2) hit(p);
    }
  }
  function runTicker(on) {
    clearInterval(ticker);
    ticker = on ? setInterval(tick, 40) : null;
  }

  // ---------- «Жди меня» ----------
  let waitCur = null; // { r: результат поиска доли, exp, frames, onset }

  function playableFrom(tick, includeCurrent = false) {
    const lookup = api?.tickCache;
    if (!lookup || !track) return null;
    const set = new Set([track.index]);
    let r = lookup.findBeat(set, tick);
    for (let guard = 0; r && guard < 20000; guard++) {
      const exp = expected(r.beat);
      if (exp && (includeCurrent || r.start >= tick - 1)) return { r, exp };
      const next = lookup.findBeat(set, r.end);
      if (!next || next.start <= r.start) return null; // конец песни
      r = next;
    }
    return null;
  }

  function startWait() {
    if (!api || !ready) return;
    api.pause();
    setWait(playableFrom(Math.max(0, api.tickPosition), true));
  }
  function setWait(w) {
    waitCur = w ? { ...w, frames: 0, onset: false } : null;
    ref.expect.replaceChildren();
    if (waitCur) {
      const cur = waitCur;
      api.tickPosition = cur.r.start;
      // пауза доходит до движка с задержкой и может вернуть курсор на старое место — ставим его ещё раз
      setTimeout(() => waitCur === cur && !playing && (api.tickPosition = cur.r.start), 250);
      ref.expect.append('Play: ', el('b', '', describe(cur.exp)));
      showOnFret(cur.exp.notes, 'target');
    } else {
      ref.expect.append(el('b', '', stats.total ? 'The end! To start over, press “Back to start”' : 'No notes found for this track'));
      showOnFret([], 'target');
    }
    drawMarks();
  }
  function advanceWait(kind) {
    if (!waitCur) return;
    mark(waitCur.exp.beat, kind);
    setWait(playableFrom(waitCur.r.end));
  }
  function jumpTo(beat) {
    const lookup = api?.tickCache;
    if (lookup) setWait(playableFrom(lookup.getBeatStart(beat)));
  }

  // ---------- слух ----------
  function onNote(n) {
    const now = performance.now();
    ref.heard.textContent = midiName(n.midi);
    recent.push({ midi: n.midi, t: now });
    while (recent.length && now - recent[0].t > 1000) recent.shift();
    if (opts.mode === 'along') {
      // нота засчитывается доле, ближайшей по времени (одна и та же нота может стоять в нескольких долях подряд);
      // ранние ноты следующей доли ещё не в списке — их подхватит onPlayedBeat по recent
      let best = null;
      for (const x of pending) {
        if (x.exp.template || !matchNote(x.exp, n.midi) || now < x.t - EARLY_MS) continue;
        if (!best || Math.abs(now - x.t) < Math.abs(now - best.t)) best = x;
      }
      if (best) hit(best);
    } else if (opts.mode === 'wait' && waitCur && !waitCur.exp.template && matchNote(waitCur.exp, n.midi)) {
      advanceWait('hit');
    }
  }
  function onOnset() {
    if (waitCur) waitCur.onset = true;
    for (const p of pending) p.onset = true;
  }
  function onFrame(frame) {
    if (frame.note == null) ref.heard.textContent = '—';
    if (opts.mode === 'wait' && waitCur?.exp.template && waitCur.onset) {
      waitCur.frames = chordScore(waitCur.exp) >= CHORD_SCORE ? waitCur.frames + 1 : 0;
      if (waitCur.frames >= 3) advanceWait('hit');
    }
  }

  let offs = [];
  function listen(on) {
    for (const f of offs) f();
    offs = [];
    const need = on && opts.mode !== 'listen';
    engine.setChromaEnabled(need);
    if (need) offs = [engine.on('note', onNote), engine.on('onset', onOnset), engine.on('frame', onFrame)];
  }

  // ---------- управление ----------
  function syncTransport() {
    const wait = opts.mode === 'wait';
    tb.classList.toggle('is-wait', wait); // в «Жди меня» нужную ноту показывает рамка — линия курсора её только перечёркивает
    ref.start.hidden = wait;
    ref.hear.hidden = !wait;
    ref.skip.hidden = !wait;
    ref.start.disabled = !ready;
    ref.start.innerHTML = icon(playing ? 'pause' : 'play');
    ref.start.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    ref.start.title = (playing ? 'Pause' : 'Play') + ' (Space)';
    ref.status.hidden = opts.mode === 'listen' || !score;
    ref.expect.hidden = !wait;
    ref.speedOut.textContent = opts.speed + ' %';
    ref.volBtn.innerHTML = icon(opts.volume === 0 ? 'volumeOff' : opts.volume < 45 ? 'volumeLow' : 'volume');
    ref.volBtn.setAttribute('aria-label', `Tab volume: ${opts.volume} %`);
    for (const k of ['loop', 'metro', 'countIn']) ref[k].setAttribute('aria-pressed', !!opts[k]);
    ref.fretBtn.setAttribute('aria-pressed', !!opts.fret);
    if (!ready && score) ref.stats.textContent = 'Loading sound…';
    else renderStats();
    for (const b of ref.mode.children) b.setAttribute('aria-pressed', b.dataset.v === opts.mode);
    ref.profile.setAttribute('aria-pressed', opts.profile === 'both');
    ref.profile.disabled = !!track && !hasTab(track);
    ref.profile.title = ref.profile.disabled ? 'This track has no tablature — it’s shown as notation' : 'Show notation above the tab (N)';
  }

  function setMode(m) {
    opts.mode = m;
    saveOpts();
    api?.pause();
    runTicker(false);
    marks.clear();
    resetStats();
    waitCur = null;
    if (m === 'along') muteOwnTrack();
    if (m === 'wait') startWait();
    else if (fb) fb.setMarkers([]);
    listen(active);
    drawMarks();
    syncTransport();
  }

  function setZoom(dir) {
    const i = ZOOMS.findIndex((z) => z >= opts.zoom - 1e-6);
    const next = ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, (i < 0 ? 3 : i) + dir))];
    if (next === opts.zoom) return;
    opts.zoom = next;
    saveOpts();
    if (api) {
      api.settings.display.scale = next;
      api.updateSettings();
      if (score) {
        setLoading(true, 'Rendering the tab…');
        api.render();
      }
    }
    ref.zoomOut.disabled = next === ZOOMS[0];
    ref.zoomIn.disabled = next === ZOOMS[ZOOMS.length - 1];
  }

  // ---------- события интерфейса ----------
  ref.open.addEventListener('click', () => ref.input.click());
  ref.open2.addEventListener('click', () => ref.input.click());
  ref.demo.addEventListener('click', () => openDemo().catch(() => {}));
  ref.input.addEventListener('change', () => {
    openFile(ref.input.files[0]).catch(() => {});
    ref.input.value = '';
  });

  ref.recentBtn.addEventListener('click', async () => {
    const list = await dbAll();
    openPop(ref.recentBtn, (box) => {
      box.classList.add('tb-recent');
      box.append(el('div', 'tb-pop-head', 'Recent tabs'));
      if (!list.length) box.append(el('p', 'tb-pop-note', 'Files you open will show up here.'));
      for (const f of list) {
        const b = el('button', 'tb-recent-item');
        b.append(el('b', '', f.name.replace(/\.(gpx?|gp\d|musicxml|mxl|xml)$/i, '')), el('small', '', new Date(f.opened).toLocaleDateString('en-US', { day: 'numeric', month: 'short' })));
        b.addEventListener('click', () => {
          closePop();
          openBytes(f.name, f.data).catch(() => {});
        });
        box.append(b);
      }
    });
  });

  ref.trackBtn.addEventListener('click', () => score && openPop(ref.trackBtn, buildMixer));

  ref.profile.addEventListener('click', () => {
    opts.profile = opts.profile === 'both' ? 'tab' : 'both';
    saveOpts();
    syncTransport();
    if (api) {
      api.settings.display.staveProfile = profileValue();
      api.updateSettings();
      if (score) {
        setLoading(true, 'Rendering the tab…');
        api.render();
      }
    }
  });

  ref.start.addEventListener('click', () => {
    if (!ready) return;
    if (opts.mode === 'wait') ref.hear.click(); // пробел в режиме «Жди меня» — послушать нужную ноту
    else api.playPause();
  });
  ref.rewind.addEventListener('click', () => {
    if (!api) return;
    api.stop();
    marks.clear();
    resetStats();
    // стоп доходит до плеера не сразу и позиция ещё старая — ищем первую ноту от самого начала
    if (opts.mode === 'wait') setWait(playableFrom(0, true));
    drawMarks();
  });
  ref.hear.addEventListener('click', () => waitCur && api.playBeat(waitCur.exp.beat));
  ref.skip.addEventListener('click', () => advanceWait('miss'));
  ref.progress.addEventListener('click', (e) => {
    if (!ready || !endTime) return;
    const r = ref.progress.getBoundingClientRect();
    api.timePosition = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * endTime;
    if (opts.mode === 'wait') setTimeout(startWait, 60);
  });

  function setSpeed(v) {
    opts.speed = Math.max(25, Math.min(125, v));
    saveOpts();
    applyPlayer();
    syncTransport();
    if (popFor !== ref.speedBtn) return;
    const slider = ref.pop.querySelector('input[type="range"]');
    if (slider) slider.value = opts.speed;
    for (const c of ref.pop.querySelectorAll('.chip')) c.setAttribute('aria-pressed', +c.dataset.v === opts.speed);
  }
  function stepSpeed(dir) {
    const next = dir > 0 ? SPEEDS.find((s) => s > opts.speed) : SPEEDS.findLast((s) => s < opts.speed);
    if (next != null) setSpeed(next);
  }

  // на такт назад или вперёд; «назад» в начале такта — на предыдущий такт, дальше — в начало текущего
  function stepBar(dir) {
    const bars = api?.tickCache?.masterBars;
    if (!ready || !bars?.length) return;
    const tick = opts.mode === 'wait' && waitCur ? waitCur.r.start : api.tickPosition;
    let i = bars.findIndex((b) => tick < b.end);
    if (i < 0) i = bars.length - 1;
    const b = bars[i];
    let to;
    if (dir > 0) {
      if (i + 1 >= bars.length) return;
      to = bars[i + 1].start;
    } else {
      to = tick - b.start > (b.end - b.start) / 4 ? b.start : bars[Math.max(0, i - 1)].start;
    }
    if (opts.mode === 'wait') setWait(playableFrom(to, true));
    else api.tickPosition = to;
  }

  ref.speedBtn.addEventListener('click', () =>
    openPop(ref.speedBtn, (box) => {
      box.classList.add('tb-speed-pop');
      box.append(el('div', 'tb-pop-head', 'Speed'));
      const chips = el('div', 'chips');
      const slider = el('input');
      for (const v of SPEEDS) {
        const c = el('button', 'chip', v + ' %');
        c.dataset.v = v;
        c.addEventListener('click', () => setSpeed(v));
        chips.append(c);
      }
      slider.type = 'range';
      slider.min = 25;
      slider.max = 125;
      slider.step = 5;
      slider.setAttribute('aria-label', 'Speed');
      slider.addEventListener('input', () => setSpeed(+slider.value));
      box.append(chips, slider);
      setSpeed(opts.speed);
    })
  );

  ref.volBtn.addEventListener('click', () =>
    openPop(ref.volBtn, (box) => {
      box.classList.add('tb-vol-pop');
      const head = el('div', 'tb-pop-head', 'Tab volume');
      const val = el('span', 'mx-val');
      const slider = el('input');
      slider.type = 'range';
      slider.min = 0;
      slider.max = 100;
      slider.step = 5;
      slider.value = opts.volume;
      slider.setAttribute('aria-label', 'Tab volume');
      val.textContent = opts.volume + ' %';
      slider.addEventListener('input', () => {
        opts.volume = +slider.value;
        val.textContent = opts.volume + ' %';
        saveOpts();
        applyPlayer();
        syncTransport();
      });
      const row = el('div', 'tb-vol-row');
      row.append(slider, val);
      box.append(head, row, el('p', 'tb-pop-note', 'Individual instrument volumes are under “Tracks”.'));
      // реверберация: синтезатор табов звучит сухо, немного «комнаты» делает его живее
      const rvHead = el('div', 'tb-pop-head', 'Reverb');
      const rvVal = el('span', 'mx-val', opts.reverb + ' %');
      const rv = el('input');
      rv.type = 'range';
      rv.min = 0;
      rv.max = 100;
      rv.step = 5;
      rv.value = opts.reverb;
      rv.setAttribute('aria-label', 'Reverb');
      rv.addEventListener('input', () => {
        opts.reverb = +rv.value;
        rvVal.textContent = opts.reverb + ' %';
        saveOpts();
        setTabReverb(opts.reverb / 100);
      });
      const rvRow = el('div', 'tb-vol-row');
      rvRow.append(rv, rvVal);
      const rvBox = el('div', 'tb-rv');
      rvBox.append(rvHead, rvRow);
      box.append(rvBox);
    })
  );

  for (const k of ['loop', 'metro', 'countIn']) {
    ref[k].addEventListener('click', () => {
      opts[k] = !opts[k];
      saveOpts();
      applyPlayer();
      syncTransport();
    });
  }
  ref.zoomOut.addEventListener('click', () => setZoom(-1));
  ref.zoomIn.addEventListener('click', () => setZoom(1));
  ref.fretBtn.addEventListener('click', () => {
    opts.fret = !opts.fret;
    saveOpts();
    setupFretboard();
    syncTransport();
    if (opts.mode === 'wait' && waitCur) showOnFret(waitCur.exp.notes, 'target');
  });
  ref.mode.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b && b.dataset.v !== opts.mode) setMode(b.dataset.v);
  });

  // ---------- Songsterr ----------
  // В приложении — своё окно: их кнопка «Download → Guitar Pro» кладёт файл прямо в библиотеку.
  // В браузере — просто их сайт в новой вкладке.
  function songsterr({ url = '', q = '' } = {}) {
    if (engine.isNative) return engine.songsterr(url, q);
    window.open(url || 'https://www.songsterr.com/?pattern=' + encodeURIComponent(q.trim()), '_blank', 'noopener');
  }
  ref.ssForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = ref.ssQuery.value.trim();
    const link = v.match(SS_LINK)?.[0];
    if (link) songsterr({ url: link });
    else if (v) songsterr({ q: v });
    else if (engine.isNative) songsterr();
    else ref.ssQuery.focus();
  });
  ref.songsterr.addEventListener('click', () => {
    // открыт таб из файла — сразу ищем эту песню; иначе — главная Songsterr
    const q = score && fileName ? [score.artist, score.title].filter(Boolean).join(' ') : '';
    songsterr({ q });
  });
  // скопировал ссылку на песню — Ctrl+V в любом месте экрана табов открывает её
  document.addEventListener('paste', (e) => {
    if (!active) return;
    const link = (e.clipboardData?.getData('text') || '').match(SS_LINK)?.[0];
    if (!link) return;
    e.preventDefault();
    songsterr({ url: link });
  });
  // файл скачан и уже лежит в библиотеке: показываем библиотеку и открываем песню
  if (engine.isNative) {
    engine.on('songsterrSaved', (m) => {
      if (!opts.lib) setLibOpen(true);
      toast('Added to your library: Songsterr / ' + m.name);
      openFromLibrary(m.rel, m.name).catch(() => {});
    });
  }
  let toastTimer = null;
  function toast(text) {
    ref.toast.textContent = text;
    ref.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (ref.toast.hidden = true), 5000);
  }

  // перетаскивание файла на вкладку
  root.addEventListener('dragover', (e) => {
    if ([...(e.dataTransfer?.items || [])].some((i) => i.kind === 'file')) {
      e.preventDefault();
      tb.classList.add('is-drop');
    }
  });
  root.addEventListener('dragleave', (e) => !root.contains(e.relatedTarget) && tb.classList.remove('is-drop'));
  root.addEventListener('drop', (e) => {
    tb.classList.remove('is-drop');
    const f = e.dataTransfer?.files?.[0];
    if (!f) return;
    e.preventDefault();
    openFile(f).catch(() => {});
  });

  ref.songsterr.hidden = !engine.isNative; // в приложении кнопка Songsterr есть всегда
  shell.classList.toggle('lib-open', !!opts.lib);
  ref.libBtn.setAttribute('aria-pressed', !!opts.lib);
  ref.zoomOut.disabled = opts.zoom <= ZOOMS[0];
  ref.zoomIn.disabled = opts.zoom >= ZOOMS[ZOOMS.length - 1];
  syncTransport();

  return {
    setActive(on) {
      active = on;
      if (!on) {
        api?.pause();
        closePop();
        listen(false);
        return;
      }
      listen(true);
      if (opts.lib) library.load();
      ensureApi().catch(() => {});
    },
    /** Для проверок. */
    /** Горячие клавиши экрана (k — из app.js: 'space', 'left', 'ctrl+o'…). true — клавиша обработана. */
    onKey(k, e) {
      if (k === 'ctrl+o') {
        ref.input.click();
        return true;
      }
      if (k === 'ctrl+-' || k === 'ctrl++') {
        if (!e.repeat) setZoom(k === 'ctrl++' ? 1 : -1); // каждый шаг заново рисует таб — повтор не нужен
        return true;
      }
      if (!score) return false;
      switch (k) {
        case 'space':
          if (!e.repeat) ref.start.click();
          return true;
        case 'home':
          ref.rewind.click();
          return true;
        case 'left':
        case 'right':
          stepBar(k === 'left' ? -1 : 1);
          return true;
        case '1':
        case '2':
        case '3': {
          const m = ['listen', 'along', 'wait'][k - 1];
          if (m !== opts.mode) setMode(m);
          return true;
        }
        case 's':
          if (opts.mode !== 'wait') return false;
          if (!e.repeat) ref.skip.click();
          return true;
        case '-':
        case '+':
          stepSpeed(k === '+' ? 1 : -1);
          return true;
        case 'l':
        case 'm':
        case 'c':
          if (!e.repeat) ref[{ l: 'loop', m: 'metro', c: 'countIn' }[k]].click();
          return true;
        case 'f':
          if (!e.repeat) ref.fretBtn.click();
          return true;
        case 'n':
          if (!e.repeat) ref.profile.click(); // у дорожки без табулатуры кнопка выключена — click() ничего не сделает
          return true;
      }
      return false;
    },
    get api() {
      return api;
    },
    get mix() {
      return mix;
    },
    /** Громкость табов, 0–100 % (для микшера в шапке). */
    get volume() {
      return opts.volume;
    },
    setVolume,
    openBytes,
    openDemo,
    openFromLibrary,
  };
}
