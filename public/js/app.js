// Оболочка приложения: области «Играть» и «Учиться», тюнер, подключение звука, индикаторы, метроном.
import { engine, isNative } from './engine.js';
import { store } from './store.js';
import { noteName, noteOctave } from './music.js';
import { createChain } from './chain.js';
import { START_CHAIN } from './blocks.js';
import { createSettings } from './settings.js';
import { createTone3000 } from './tone3000.js';
import { createRig } from './modes/rig.js';
import { createTuner } from './modes/tuner.js';
import { createNotes } from './modes/notes.js';
import { createScales } from './modes/scales.js';
import { createChords } from './modes/chords.js';
import { createTabs } from './modes/tabs.js';
import { createRain } from './games/rain.js';
import { createGlide } from './games/glide.js';
import { createWalls } from './games/walls.js';

const $ = (id) => document.getElementById(id);
document.documentElement.classList.toggle('is-native', isNative);

// цепочка блоков; при первом запуске — стартовая цепочка из встроенных блоков (звучит сразу)
const chain = createChain(engine, store, START_CHAIN);
const deps = { engine, store, chain };
deps.t3k = createTone3000($('t3k'), deps);

// ---------- две области: «Играть» (цепочка звука) и «Учиться» (упражнения) ----------
const views = {
  play: createRig($('view-play'), deps),
  notes: createNotes($('view-notes'), deps),
  scales: createScales($('view-scales'), deps),
  chords: createChords($('view-chords'), deps),
  tabs: createTabs($('view-tabs'), deps),
  rain: createRain($('view-rain'), deps),
  glide: createGlide($('view-glide'), deps),
  walls: createWalls($('view-walls'), deps),
};
const PRACTICE = ['notes', 'scales', 'chords']; // три упражнения на одной вкладке «Practice», между ними — переключатель
const GAMES = ['rain', 'glide', 'walls']; // мини-игры на вкладке «Games», переключатель такой же
const areaButtons = [...document.querySelectorAll('.area')];
const tabs = [...document.querySelectorAll('#learnTabs .tab')];
const exButtons = [...document.querySelectorAll('#practiceNav button, #gamesNav button')];
let current = null;

function show(id) {
  if (!views[id]) id = isNative ? 'play' : 'notes';
  current = id;
  document.documentElement.dataset.view = id; // по нему «Play» и табы растягиваются на всё окно
  // у табов свой клик метронома, нижней панели там нет — общий метроном не должен тикать невидимым
  if (id === 'tabs' && engine.metro.running) $('mToggle').click();
  const area = id === 'play' ? 'play' : 'learn';
  for (const b of areaButtons) b.setAttribute('aria-pressed', b.dataset.area === area);
  const isPractice = PRACTICE.includes(id);
  const isGame = GAMES.includes(id);
  for (const t of tabs) t.setAttribute('aria-selected', t.dataset.tab === (isPractice ? 'practice' : isGame ? 'games' : id));
  $('learnTabs').hidden = area !== 'learn';
  $('practiceNav').hidden = !isPractice;
  $('gamesNav').hidden = !isGame;
  for (const b of exButtons) b.setAttribute('aria-pressed', b.dataset.ex === id);
  if (isPractice) store.set('practiceTab', id);
  if (isGame) store.set('gamesTab', id);
  // сначала выключаем остальные экраны, потом включаем нужный: так общий спектр для аккордов,
  // который нужен и упражнению Chords, и игре Chord Wall, не выключится соседом
  for (const k in views) {
    $('view-' + k).hidden = k !== id;
    if (k !== id) views[k].setActive(false);
  }
  views[id].setActive(true);
  $('heard').hidden = id === 'chords' || id === 'tabs'; // у аккордов и табов свой индикатор
  store.set('view', id);
  if (area === 'learn') store.set('learnTab', id);
}
for (const b of areaButtons) {
  b.addEventListener('click', () => show(b.dataset.area === 'play' ? 'play' : store.get('learnTab', 'notes')));
}
const tabView = (tab) => (tab === 'practice' ? store.get('practiceTab', 'notes') : tab === 'games' ? store.get('gamesTab', GAMES[0]) : tab);
for (const t of tabs) t.addEventListener('click', () => show(tabView(t.dataset.tab)));
for (const b of exButtons) b.addEventListener('click', () => show(b.dataset.ex));

// ---------- тюнер: открывается поверх любой области ----------
const tuner = createTuner($('tunerBody'), deps);
const tunerModal = $('tunerModal');
function setTuner(open) {
  tunerModal.hidden = !open;
  tuner.setActive(open);
  $('tunerBtn').setAttribute('aria-pressed', open);
}
$('tunerBtn').addEventListener('click', () => setTuner(tunerModal.hidden));
$('tunerClose').addEventListener('click', () => setTuner(false));
tunerModal.addEventListener('pointerdown', (e) => e.target === tunerModal && setTuner(false));
document.addEventListener('keydown', (e) => e.key === 'Escape' && !tunerModal.hidden && setTuner(false));

// ---------- поддержать автора: звезда на GitHub, криптоадреса с копированием ----------
const supportModal = $('supportModal');
function setSupport(open) {
  supportModal.hidden = !open;
  $('supportBtn').setAttribute('aria-pressed', open);
}
$('supportBtn').addEventListener('click', () => setSupport(supportModal.hidden));
$('supportClose').addEventListener('click', () => setSupport(false));
supportModal.addEventListener('pointerdown', (e) => e.target === supportModal && setSupport(false));
document.addEventListener('keydown', (e) => e.key === 'Escape' && !supportModal.hidden && setSupport(false));
supportModal.addEventListener('click', async (e) => {
  const link = e.target.closest('[data-link]');
  if (link) {
    e.preventDefault();
    // в приложении ссылку открывает системный браузер (адреса разрешены в MainForm.IsHelpUrl)
    if (isNative) engine.openUrl(link.dataset.link);
    else window.open(link.dataset.link, '_blank', 'noopener');
    return;
  }
  const btn = e.target.closest('.sp-copy');
  if (!btn) return;
  const code = btn.parentElement.querySelector('code');
  const text = code.textContent.trim();
  // сначала синхронно, прямо внутри клика: так работает без запросов разрешений; потом — через буфер обмена браузера
  let ok = copyNow(text);
  // Буфер обмена браузера — только после настоящего клика: без него WebView2 спрашивает
  // «Сайт lad.example хочет просматривать буфер обмена» (так бывает, когда кнопку нажимает скрипт).
  if (!ok && navigator.clipboard && navigator.userActivation?.isActive !== false) {
    try {
      await Promise.race([navigator.clipboard.writeText(text), new Promise((_, fail) => setTimeout(fail, 1200))]);
      ok = true;
    } catch {}
  }
  if (!ok) {
    // скопировать не дали — выделяем адрес, чтобы скопировать его самому
    const range = document.createRange();
    range.selectNodeContents(code);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  }
  btn.textContent = ok ? 'Copied' : 'Press Ctrl+C';
  btn.classList.toggle('is-done', ok);
  clearTimeout(btn.resetTimer);
  btn.resetTimer = setTimeout(() => {
    btn.textContent = 'Copy';
    btn.classList.remove('is-done');
  }, ok ? 1600 : 4000);
});
function copyNow(text) {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
  document.body.append(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {}
  area.remove();
  return ok;
}

// ---------- мастер-громкость и микшер: в шапке, видны на всех экранах ----------
const master = $('master');
const msVol = $('msVol');
const msMute = $('msMute');
const msOpen = $('msOpen');
const mixPop = $('mixPop');
const dbText = (v) => {
  const a = Math.abs(v);
  return (v > 0 ? '+' : v < 0 ? '−' : '') + (a % 1 ? a.toFixed(1) : a) + ' dB';
};
// громкость табов живёт у табов (сохраняется в их настройках), остальное — общие уровни движка
const MIX = [
  { name: 'Master', hint: 'everything', level: 'master.level', mute: 'master.mute' },
  { name: 'Guitar', hint: 'the sound chain', level: 'out.level', mute: 'out.mute', native: true },
  { name: 'Metronome', hint: 'and reference notes', level: 'synth.level', scale: 100, native: true },
  { name: 'Tabs', hint: 'the tab player', tabs: true },
];
const mixRows = [];
for (const r of MIX) {
  if (r.native && !isNative) continue;
  const row = document.createElement('div');
  row.className = 'mix-row';
  const label = document.createElement('div');
  label.className = 'mix-name';
  label.innerHTML = `<b>${r.name}</b><small>${r.hint}</small>`;
  const mute = document.createElement('button');
  mute.className = 'mix-mute';
  if (r.mute) {
    mute.innerHTML = msMute.innerHTML;
    mute.setAttribute('aria-label', 'Mute: ' + r.name);
    mute.title = 'Mute: ' + r.name;
    mute.addEventListener('click', () => chain.setGlobal(r.mute, chain.global(r.mute) > 0.5 ? 0 : 1, 'mix'));
  } else {
    // кнопки нет, но место в сетке остаётся — ползунки всех строк стоят ровно
    mute.style.visibility = 'hidden';
    mute.tabIndex = -1;
    mute.setAttribute('aria-hidden', 'true');
  }
  const input = document.createElement('input');
  input.type = 'range';
  Object.assign(input, r.tabs || r.scale ? { min: 0, max: 100, step: r.tabs ? 5 : 1 } : { min: -40, max: 6, step: 0.5 });
  input.setAttribute('aria-label', r.name + ' volume');
  input.addEventListener('input', () => {
    if (r.tabs) views.tabs.setVolume(+input.value);
    else chain.setGlobal(r.level, r.scale ? input.value / r.scale : +input.value, 'mix');
    syncMix();
  });
  const out = document.createElement('output');
  row.append(label, mute, input, out);
  $('mixRows').append(row);
  mixRows.push({ r, row, mute, input, out });
}
function syncMix() {
  for (const { r, row, mute, input, out } of mixRows) {
    const v = r.tabs ? views.tabs.volume : chain.global(r.level) * (r.scale || 1);
    const muted = !!r.mute && chain.global(r.mute) > 0.5;
    input.value = v;
    out.textContent = muted ? 'Muted' : r.tabs || r.scale ? Math.round(v) + ' %' : dbText(v);
    row.classList.toggle('is-muted', muted);
    mute.setAttribute('aria-pressed', muted);
  }
  const muted = chain.global('master.mute') > 0.5;
  msVol.value = chain.global('master.level');
  $('msVal').textContent = muted ? 'Muted' : dbText(chain.global('master.level'));
  master.classList.toggle('is-muted', muted);
  msMute.setAttribute('aria-pressed', muted);
  msMute.title = (muted ? 'Turn the sound back on' : 'Mute all sound') + ' (0)';
}
msVol.addEventListener('input', () => {
  chain.setGlobal('master.level', +msVol.value, 'master');
  if (chain.global('master.mute') > 0.5) chain.setGlobal('master.mute', 0, 'master'); // повёл ползунок — значит, хочет слышать
});
msMute.addEventListener('click', toggleMasterMute);
function toggleMasterMute() {
  chain.setGlobal('master.mute', chain.global('master.mute') > 0.5 ? 0 : 1, 'master');
}
chain.on((what) => what === 'global' && syncMix());
function setMix(open) {
  mixPop.hidden = !open;
  msOpen.setAttribute('aria-expanded', open);
  if (open) syncMix(); // громкость табов могли поменять на их экране
}
msOpen.addEventListener('click', () => setMix(mixPop.hidden));
document.addEventListener('pointerdown', (e) => !mixPop.hidden && !master.contains(e.target) && setMix(false));
document.addEventListener('keydown', (e) => e.key === 'Escape' && !mixPop.hidden && setMix(false));
let clipUntil = 0;
syncMix();

// ---------- горячие клавиши ----------
const keysModal = $('keysModal');
function setKeys(open) {
  keysModal.hidden = !open;
  $('keysBtn').setAttribute('aria-pressed', open);
}
$('keysBtn').addEventListener('click', () => setKeys(keysModal.hidden));
$('keysClose').addEventListener('click', () => setKeys(false));
keysModal.addEventListener('pointerdown', (e) => e.target === keysModal && setKeys(false));
document.addEventListener('keydown', (e) => e.key === 'Escape' && !keysModal.hidden && setKeys(false));

// Клавишу узнаём по физической кнопке (e.code), а не по букве: на русской раскладке L — это «д».
const CODES = { Space: 'space', ArrowLeft: 'left', ArrowRight: 'right', Home: 'home', F1: 'f1', Minus: '-', NumpadSubtract: '-', Equal: '+', NumpadAdd: '+', Comma: ',', Slash: '/' };
const KEYS = { ' ': 'space', ArrowLeft: 'left', ArrowRight: 'right', Home: 'home', F1: 'f1', '-': '-', '+': '+', '=': '+', ',': ',', '/': '/' };
function combo(e) {
  if (e.altKey || e.metaKey) return null;
  let k;
  if (e.key === '?') k = '?'; // где бы «?» ни был на раскладке (на русской — Shift+7)
  else if (e.code) k = CODES[e.code] || (/^Key[A-Z]$/.test(e.code) ? e.code.slice(3).toLowerCase() : /^(Digit|Numpad)\d$/.test(e.code) ? e.code.slice(-1) : null);
  else k = KEYS[e.key] || (/^[a-z0-9]$/i.test(e.key) ? e.key.toLowerCase() : null); // без кода клавиши (экранная клавиатура) — по символу
  if (k === '/') k = e.shiftKey ? '?' : null;
  if (!k) return null;
  return (e.ctrlKey ? 'ctrl+' : '') + k;
}
// Пришёл на кнопку клавишей Tab — пробел нажимает её. Кликнул мышью — пробел снова «Играть», а не повторный клик.
let keyboardFocus = false;
window.addEventListener('pointerdown', () => (keyboardFocus = false), true);
const CONTROL = 'button, a[href], input, [role="slider"], [role="button"], [tabindex]:not([tabindex="-1"])';

window.addEventListener(
  'keydown',
  (e) => {
    if (e.key === 'Tab') keyboardFocus = true;
    if (e.isComposing) return;
    const k = combo(e);
    if (!k) return;
    const t = e.target instanceof Element ? e.target : document.body;
    // в полях ввода клавиши — для текста
    if (t.closest('textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
    if (t.matches('input') && !/^(range|checkbox|radio|button)$/.test(t.type)) return;
    if (k === 'left' || k === 'right' || k === 'home') {
      // ручки забирают стрелки всегда (иначе после поворота ручки стрелка перелистнёт такт в табах);
      // обычный ползунок — только если на него пришли с клавиатуры: подвинул мастер мышью — стрелки снова листают такты
      if (t.closest('[role="slider"]')) return;
      if (t.matches('input[type="range"]') && keyboardFocus) return;
    }
    if (k === 'space' && keyboardFocus && t !== document.body && t.closest(CONTROL)) return;
    const modal = document.querySelector('.modal-backdrop:not([hidden])');
    if (modal) {
      // поверх открытого окна — только закрыть его той же клавишей
      if (modal === tunerModal && k === 't') setTuner(false);
      else if (modal === keysModal && (k === '?' || k === 'f1')) setKeys(false);
      else return;
    } else if (!globalKey(k, e) && !views[current].onKey?.(k, e)) {
      return;
    }
    e.preventDefault();
    e.stopPropagation(); // обработчики на самих кнопках и плитках этот пробел уже не получат
  },
  true
);

function globalKey(k, e) {
  switch (k) {
    case '?':
    case 'f1':
      setKeys(true);
      return true;
    case 't':
      if (!e.repeat) setTuner(true);
      return true;
    case '0':
      if (!e.repeat) toggleMasterMute();
      return true;
    case 'ctrl+1':
      show('play');
      return true;
    case 'ctrl+2':
      show(store.get('practiceTab', 'notes'));
      return true;
    case 'ctrl+3':
      show('tabs');
      return true;
    case 'ctrl+4':
      show(store.get('gamesTab', GAMES[0]));
      return true;
    case 'ctrl+,':
      if (!settings) return false;
      settings.open();
      return true;
    case 'g':
      if (!isNative) return false;
      if (!e.repeat) chain.setGlobal('out.mute', chain.global('out.mute') > 0.5 ? 0 : 1, 'key');
      return true;
  }
  const group = PRACTICE.includes(current) ? PRACTICE : GAMES.includes(current) ? GAMES : null;
  if (group) {
    if (k === 'space') {
      const btn = $('view-' + current).querySelector('[data-ref="start"]');
      if (!btn) return false;
      if (!e.repeat) btn.click();
      return true;
    }
    if (/^[1-9]$/.test(k) && group[k - 1]) {
      show(group[k - 1]);
      return true;
    }
  }
  if (current === 'tabs') return false; // у табов свой клик метронома и своя скорость
  switch (k) {
    case 'm':
      if (!e.repeat) mToggle.click();
      return true;
    case '-':
      setBpm(metro.bpm - 5);
      return true;
    case '+':
      setBpm(metro.bpm + 5);
      return true;
  }
  return false;
}

// ---------- индикаторы входа ----------
const heard = $('heard');
const heardNote = $('heardNote');
const meterFill = $('meterFill');
let heardText = '—';

engine.on('frame', (frame) => {
  meterFill.style.transform = `scaleX(${frame.level.toFixed(3)})`;
  const text = frame.note == null ? '—' : noteName(frame.note) + noteOctave(frame.note);
  if (text !== heardText) {
    heardText = text;
    heardNote.textContent = text;
    heard.classList.toggle('is-on', frame.note != null);
  }
  // выход у самого верха (работает ограничитель) — мастер подсвечивается красным
  const m = engine.meters;
  if (isNative && m) {
    if (m.outPk > 0.97) clipUntil = performance.now() + 1200;
    master.classList.toggle('is-hot', performance.now() < clipUntil);
  }
});

const notice = $('notice');
const errorBox = $('error');
let settings = null; // окно настроек звука — только в приложении

if (isNative) setupNative();
else setupWeb();

// ---------- приложение: звук через ASIO ----------
function setupNative() {
  settings = createSettings($('settings'), deps);
  const chip = $('audioChip');
  chip.hidden = false;
  chip.addEventListener('click', () => settings.open());
  notice.querySelector('div').innerHTML =
    '<strong>Audio is not set up.</strong> Open “Audio settings” and choose your audio interface driver.';
  notice.hidden = true;

  engine.on('state', () => {
    const a = engine.audio;
    if (a.open) {
      const lat = ((a.inputLatency + a.outputLatency) / a.sampleRate) * 1000;
      // в узком окне название драйвера прячется (оно остаётся в подсказке)
      chip.innerHTML = `<i class="dot"></i><span class="chip-drv">${a.driver} · </span>${(a.sampleRate / 1000).toString()} kHz · ${a.bufferSize} · ${lat.toFixed(1)} ms`;
      chip.title = `${a.driver} — audio settings (Ctrl+,)`;
      chain.sync(); // движок перезапустился — напоминаем ему цепочку и уровни
    } else {
      chip.innerHTML = `<i class="dot off"></i>${a.error ? 'Audio error' : 'Audio off'} — set up`;
      chip.title = 'Audio settings (Ctrl+,)';
    }
    chip.classList.toggle('is-error', !a.open);
    notice.hidden = a.open;
    errorBox.hidden = !a.error;
    errorBox.textContent = a.error || '';
  });

  // громкость клика и нот-подсказок — в окошке метронома; громкость и mute гитары — в микшере мастера
  const mVol = $('mVol');
  mVol.value = chain.global('synth.level') * 100;
  mVol.addEventListener('input', () => chain.setGlobal('synth.level', mVol.value / 100, 'metro'));
  chain.on((what, d) => what === 'global' && d.name === 'synth.level' && d.source !== 'metro' && (mVol.value = d.value * 100));

  engine.start();
}

// ---------- браузер: звук через Web Audio ----------
function setupWeb() {
  const connectBtn = $('connectBtn');
  const deviceSelect = $('deviceSelect');
  const channelSeg = $('channelSeg');
  const monitorGroup = $('monitorGroup');
  $('dock').hidden = false; // в браузере внизу остаётся мониторинг гитары
  const monOn = $('monOn');
  const monTone = $('monTone');
  const monVol = $('monVol');
  connectBtn.hidden = false;
  monitorGroup.hidden = false;
  engine.channelMode = store.get('channel', '1');

  const ERRORS = {
    NotAllowedError:
      'The browser denied access to the audio input. Allow the microphone for this site (the icon left of the address bar) and press “Connect guitar” again.',
    NotFoundError: 'No audio input found. Check that the interface is connected over USB and visible to the system.',
    NotReadableError:
      'The input is busy in another program. Close your DAW or any other app using the interface and try again.',
    NotSupportedError: 'This browser can’t use audio input. Open the app in Chrome or Edge at http://localhost.',
  };

  async function connect(deviceId) {
    errorBox.hidden = true;
    connectBtn.disabled = true;
    connectBtn.textContent = 'Connecting…';
    try {
      await engine.connectInput(deviceId ?? store.get('device', null));
      store.set('device', engine.deviceId);
    } catch (err) {
      errorBox.textContent = ERRORS[err.name] || `Couldn’t connect the input: ${err.message || err.name}`;
      errorBox.hidden = false;
    } finally {
      connectBtn.disabled = false;
      connectBtn.textContent = 'Connect guitar';
    }
    syncInput();
  }

  async function syncInput() {
    const on = engine.connected;
    connectBtn.hidden = on;
    notice.hidden = on;
    deviceSelect.hidden = !on;
    channelSeg.hidden = !(on && engine.inputChannels >= 2);
    for (const b of channelSeg.children) b.setAttribute('aria-pressed', b.dataset.v === engine.channelMode);
    monitorGroup.classList.toggle('is-disabled', !on);
    monOn.disabled = !on;
    if (!on && monOn.checked) {
      monOn.checked = false;
      engine.setMonitor({ on: false });
    }
    if (!on) return;
    const inputs = await engine.listInputs();
    deviceSelect.replaceChildren(
      ...inputs.map((d, i) => {
        const o = document.createElement('option');
        o.value = d.deviceId;
        o.textContent = d.label || `Input ${i + 1}`;
        return o;
      })
    );
    if (inputs.some((d) => d.deviceId === engine.deviceId)) deviceSelect.value = engine.deviceId;
  }

  connectBtn.addEventListener('click', () => connect());
  deviceSelect.addEventListener('change', () => connect(deviceSelect.value));
  channelSeg.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    engine.setChannelMode(b.dataset.v);
    store.set('channel', b.dataset.v);
    syncInput();
  });
  engine.on('state', syncInput);
  navigator.mediaDevices?.addEventListener?.('devicechange', () => engine.connected && syncInput());

  // мониторинг (простой; настоящий усилитель — в приложении)
  const syncTone = () => {
    for (const b of monTone.children) b.setAttribute('aria-pressed', b.dataset.v === engine.monitor.tone);
  };
  monOn.addEventListener('change', () => {
    engine.ensure();
    engine.setMonitor({ on: monOn.checked });
  });
  monTone.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    engine.monitor.tone = b.dataset.v;
    store.set('tone', b.dataset.v);
    if (engine.ctx) engine.applyMonitor();
    syncTone();
  });
  monVol.addEventListener('input', () => {
    engine.monitor.volume = monVol.value / 100;
    if (engine.ctx) engine.applyMonitor();
  });
  engine.monitor.tone = store.get('tone', 'clean');
  syncTone();
  syncInput();
}

// ---------- метроном ----------
const metro = engine.metro;
const mToggle = $('mToggle');
const mBeats = $('mBeats');
const mBpm = $('mBpm');
const mRange = $('mRange');
const mSig = $('mSig');

function setBpm(v) {
  metro.bpm = Math.max(40, Math.min(220, Math.round(v)));
  mBpm.textContent = metro.bpm;
  $('mBpmBig').textContent = metro.bpm;
  mRange.value = metro.bpm;
  store.set('bpm', metro.bpm);
  if (metro.running) metro.apply();
}
function setBeats(n) {
  metro.beats = n;
  mSig.value = n;
  $('mSigLabel').textContent = n === 6 ? '6/8' : n + '/4';
  mBeats.replaceChildren(...Array.from({ length: n }, () => document.createElement('i')));
  store.set('beats', n);
  if (metro.running) metro.apply();
}
metro.onBeat = (b) => {
  const dot = mBeats.children[b];
  if (!dot) return;
  dot.classList.add('on');
  dot.classList.toggle('first', b === 0);
  setTimeout(() => dot.classList.remove('on'), 110);
};
mToggle.addEventListener('click', () => {
  if (metro.running) metro.stop();
  else metro.start();
  mToggle.textContent = metro.running ? '■' : '▶';
  mToggle.setAttribute('aria-label', metro.running ? 'Stop the metronome' : 'Start the metronome');
  $('metroTop').classList.toggle('is-on', metro.running);
});
// окошко с темпом, размером и Tap — под кнопкой метронома в шапке
const mPop = $('mPop');
function setMetroPop(open) {
  mPop.hidden = !open;
  $('mOpen').setAttribute('aria-expanded', open);
}
$('mOpen').addEventListener('click', () => setMetroPop(mPop.hidden));
document.addEventListener('pointerdown', (e) => !mPop.hidden && !$('metroTop').contains(e.target) && setMetroPop(false));
document.addEventListener('keydown', (e) => e.key === 'Escape' && !mPop.hidden && setMetroPop(false));
$('mMinus').addEventListener('click', () => setBpm(metro.bpm - 5));
$('mPlus').addEventListener('click', () => setBpm(metro.bpm + 5));
mRange.addEventListener('input', () => setBpm(+mRange.value));
mSig.addEventListener('change', () => {
  mSig.blur(); // выбрал размер — горячие клавиши снова работают
  setBeats(+mSig.value);
});
$('mTap').addEventListener('click', () => {
  const bpm = metro.tap();
  if (bpm) setBpm(bpm);
});
setBpm(store.get('bpm', 90));
setBeats(store.get('beats', 4));

// ---------- старт ----------
show(store.get('view', isNative ? 'play' : 'notes'));

window.lad = { engine, metro, chain, t3k: deps.t3k, rig: views.play, tabs: views.tabs, games: { rain: views.rain, glide: views.glide, walls: views.walls } }; // для отладки и самопроверки
