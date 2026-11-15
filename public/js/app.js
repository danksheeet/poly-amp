// Оболочка приложения: области «Играть» и «Учиться», тюнер, подключение звука, индикаторы, метроном.
import { engine, isNative } from './engine.js';
import { store } from './store.js';
import { noteName, noteOctave } from './music.js';
import { createChain } from './chain.js';
import { DEFAULT_PRESET, findPreset } from './presets.js';
import { createSettings } from './settings.js';
import { createTone3000 } from './tone3000.js';
import { createRig } from './modes/rig.js';
import { createTuner } from './modes/tuner.js';
import { createNotes } from './modes/notes.js';
import { createScales } from './modes/scales.js';
import { createChords } from './modes/chords.js';
import { createTabs } from './modes/tabs.js';

const $ = (id) => document.getElementById(id);
document.documentElement.classList.toggle('is-native', isNative);

// цепочка блоков; при первом запуске — пресет по умолчанию (встроенные блоки, звучат сразу)
const chain = createChain(engine, store, findPreset(DEFAULT_PRESET).preset.blocks);
const deps = { engine, store, chain };
deps.t3k = createTone3000($('t3k'), deps);

// ---------- две области: «Играть» (цепочка звука) и «Учиться» (упражнения) ----------
const views = {
  play: createRig($('view-play'), deps),
  notes: createNotes($('view-notes'), deps),
  scales: createScales($('view-scales'), deps),
  chords: createChords($('view-chords'), deps),
  tabs: createTabs($('view-tabs'), deps),
};
const LEARN = ['notes', 'scales', 'chords', 'tabs'];
const PRACTICE = ['notes', 'scales', 'chords']; // три упражнения на одной вкладке «Practice», между ними — переключатель
const areaButtons = [...document.querySelectorAll('.area')];
const tabs = [...document.querySelectorAll('#learnTabs .tab')];
const exButtons = [...document.querySelectorAll('#practiceNav button')];
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
  for (const t of tabs) t.setAttribute('aria-selected', t.dataset.tab === (isPractice ? 'practice' : id));
  $('learnTabs').hidden = area !== 'learn';
  $('practiceNav').hidden = !isPractice;
  for (const b of exButtons) b.setAttribute('aria-pressed', b.dataset.ex === id);
  if (isPractice) store.set('practiceTab', id);
  for (const k in views) {
    $('view-' + k).hidden = k !== id;
    views[k].setActive(k === id);
  }
  $('heard').hidden = id === 'chords' || id === 'tabs'; // у аккордов и табов свой индикатор
  store.set('view', id);
  if (area === 'learn') store.set('learnTab', id);
}
for (const b of areaButtons) {
  b.addEventListener('click', () => show(b.dataset.area === 'play' ? 'play' : store.get('learnTab', 'notes')));
}
for (const t of tabs) t.addEventListener('click', () => show(t.dataset.tab === 'practice' ? store.get('practiceTab', 'notes') : t.dataset.tab));
for (const b of exButtons) b.addEventListener('click', () => show(b.dataset.ex));

document.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || !LEARN.includes(current)) return;
  if (e.target.closest('button, input, select, textarea, [role="slider"]')) return;
  const btn = $('view-' + current).querySelector('[data-ref="start"]');
  if (btn) {
    e.preventDefault();
    btn.click();
  }
});

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
  if (!ok && navigator.clipboard) {
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
});

const notice = $('notice');
const errorBox = $('error');

if (isNative) setupNative();
else setupWeb();

// ---------- приложение: звук через ASIO ----------
function setupNative() {
  const settings = createSettings($('settings'), deps);
  const chip = $('audioChip');
  const outGroup = $('outGroup');
  const outMute = $('outMute');
  const outVol = $('outVol');
  chip.hidden = false;
  outGroup.hidden = false;
  chip.addEventListener('click', () => settings.open());
  notice.querySelector('div').innerHTML =
    '<strong>Audio is not set up.</strong> Open “Audio settings” and choose your audio interface driver.';
  notice.hidden = true;

  engine.on('state', () => {
    const a = engine.audio;
    if (a.open) {
      const lat = ((a.inputLatency + a.outputLatency) / a.sampleRate) * 1000;
      chip.innerHTML = `<i class="dot"></i>${a.driver} · ${(a.sampleRate / 1000).toString()} kHz · ${a.bufferSize} · ${lat.toFixed(1)} ms`;
      chain.sync(); // движок перезапустился — напоминаем ему цепочку и уровни
    } else {
      chip.innerHTML = `<i class="dot off"></i>${a.error ? 'Audio error' : 'Audio off'} — set up`;
    }
    chip.classList.toggle('is-error', !a.open);
    notice.hidden = a.open;
    errorBox.hidden = !a.error;
    errorBox.textContent = a.error || '';
  });

  // быстрые «громкость и mute» в нижней панели — те же параметры, что на экране усилителя
  const syncOut = () => {
    outMute.checked = chain.global('out.mute') < 0.5;
    outVol.value = chain.global('out.level');
  };
  outMute.addEventListener('change', () => chain.setGlobal('out.mute', outMute.checked ? 0 : 1, 'dock'));
  outVol.addEventListener('input', () => chain.setGlobal('out.level', +outVol.value, 'dock'));
  chain.on((what, d) => what === 'global' && d.source !== 'dock' && (d.name === 'out.mute' || d.name === 'out.level') && syncOut());
  syncOut();

  const mVol = $('mVol');
  mVol.hidden = false;
  mVol.value = chain.global('synth.level') * 100;
  mVol.addEventListener('input', () => chain.setGlobal('synth.level', mVol.value / 100, 'dock'));

  engine.start();
}

// ---------- браузер: звук через Web Audio ----------
function setupWeb() {
  const connectBtn = $('connectBtn');
  const deviceSelect = $('deviceSelect');
  const channelSeg = $('channelSeg');
  const monitorGroup = $('monitorGroup');
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
  mRange.value = metro.bpm;
  store.set('bpm', metro.bpm);
  if (metro.running) metro.apply();
}
function setBeats(n) {
  metro.beats = n;
  mSig.value = n;
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

});
$('mMinus').addEventListener('click', () => setBpm(metro.bpm - 5));
$('mPlus').addEventListener('click', () => setBpm(metro.bpm + 5));
mRange.addEventListener('input', () => setBpm(+mRange.value));
mSig.addEventListener('change', () => setBeats(+mSig.value));
$('mTap').addEventListener('click', () => {
  const bpm = metro.tap();
  if (bpm) setBpm(bpm);
});
setBpm(store.get('bpm', 90));
setBeats(store.get('beats', 4));

// ---------- старт ----------
show(store.get('view', isNative ? 'play' : 'notes'));

window.lad = { engine, metro, chain, t3k: deps.t3k, rig: views.play, tabs: views.tabs }; // для отладки и самопроверки
