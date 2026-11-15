// Проверка тонов без гитары: DI-сэмпл по кругу вместо сигнала с входа — как превью на TONE3000.
// Пока сэмпл играет, можно переключать пресеты и крутить ручки: разницу слышно сразу.
import { baseName } from './info.js';

const PLAY = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.500 2.800v10.400a.8.8 0 0 0 1.200.700l8.600-5.200a.8.8 0 0 0 0-1.400L5.700 2.100a.8.8 0 0 0-1.200.700z" fill="currentColor"/></svg>';
const REC = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="4.600" fill="currentColor"/></svg>';
const STOP = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.500" y="3.500" width="9" height="9" rx="1.600" fill="currentColor"/></svg>';

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

export function createPlayer(host, { engine, store, rigRoot }) {
  host.classList.add('rig-player');
  host.innerHTML = `
    <button class="play-btn" data-ref="play"></button>
    <button class="rec-btn" data-ref="rec"></button>
    <div class="sp-info">
      <small data-ref="label"></small>
      <select class="sp-select" data-ref="sel" aria-label="Sample for testing the tone"></select>
    </div>
    <div class="sp-progress" aria-hidden="true"><i data-ref="bar"></i></div>
    <button class="rbtn sp-bypass" data-ref="bypass" aria-pressed="false"
      title="Turn off the whole chain and hear the dry signal — to compare (B)">Bypass</button>`;
  const ref = {};
  for (const n of host.querySelectorAll('[data-ref]')) ref[n.dataset.ref] = n;

  let playing = false;
  let bypass = false;
  let error = null;
  let note = null; // подсказка после записи (например, «тихо»)
  let recording = false;
  let recSec = 0;
  let recMax = 60;
  const clock = (s) => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
  let sel = store.get('samples.sel', null) || { id: 'power', path: null };
  const ownFiles = () => {
    const list = store.get('samples.files', []);
    return Array.isArray(list) ? list.filter((p) => typeof p === 'string') : [];
  };
  const keyOf = (s) => (s.id === 'file' ? 'f:' + s.path : 'r:' + s.id);

  function options() {
    const riffs = engine.samples?.riffs || [];
    const files = [...new Set([...(engine.samples?.files || []), ...ownFiles()])];
    const nodes = [];
    if (riffs.length) {
      const g = document.createElement('optgroup');
      g.label = 'Poly Amp riffs';
      for (const r of riffs) {
        const o = el('option', '', r.name);
        o.value = 'r:' + r.id;
        o.title = r.note;
        g.append(o);
      }
      nodes.push(g);
    }
    if (files.length) {
      const g = document.createElement('optgroup');
      g.label = 'My DI recordings';
      for (const p of files) {
        const o = el('option', '', baseName(p));
        o.value = 'f:' + p;
        o.title = p;
        g.append(o);
      }
      nodes.push(g);
    }
    const pick = el('option', '', 'Open your own DI recording (WAV)…');
    pick.value = '__pick';
    nodes.push(pick);
    ref.sel.replaceChildren(...nodes);
    if (![...ref.sel.options].some((o) => o.value === keyOf(sel)) && riffs.length) sel = { id: riffs[0].id, path: null };
    ref.sel.value = keyOf(sel);
    const riff = riffs.find((r) => r.id === sel.id);
    ref.sel.title = riff ? riff.note : sel.path || '';
  }

  function render() {
    ref.play.innerHTML = playing ? STOP : PLAY;
    ref.play.classList.toggle('is-on', playing);
    ref.play.setAttribute('aria-label', playing ? 'Stop the sample' : 'Play a sample instead of the guitar');
    ref.play.title = playing
      ? 'Stop (Space)'
      : 'Test the tone without a guitar: a sample loops in place of the input (Space)';
    ref.label.textContent = recording
      ? `Recording ${clock(recSec)} — play, then ■`
      : error || note || (playing ? 'Playing instead of the guitar' : 'Test without a guitar');
    ref.label.classList.toggle('is-bad', !!error && !recording);
    ref.label.classList.toggle('is-rec', recording);
    ref.rec.innerHTML = recording ? STOP : REC;
    ref.rec.classList.toggle('is-on', recording);
    ref.rec.setAttribute('aria-label', recording ? 'Stop recording' : 'Record your guitar playing');
    ref.rec.title = recording
      ? 'Stop recording and save'
      : 'Record your playing (up to a minute) and run it through presets without a guitar';
    ref.play.disabled = recording;
    ref.sel.disabled = recording;
    host.classList.toggle('is-rec', recording);
    ref.bypass.setAttribute('aria-pressed', bypass);
    rigRoot.classList.toggle('is-bypass', bypass);
    if (!playing && !recording) ref.bar.style.transform = 'scaleX(0)';
  }

  function start() {
    note = null;
    if (!engine.audio?.open) {
      error = 'Audio is off — turn it on in “Audio settings”';
      return render();
    }
    error = null;
    engine.playSample(sel.id, sel.path, true);
  }
  function stop() {
    if (playing) engine.playSample(sel.id, sel.path, false);
  }

  ref.play.addEventListener('click', () => (playing ? stop() : start()));
  ref.rec.addEventListener('click', () => {
    if (recording) return engine.recStop();
    error = null;
    note = null;
    if (!engine.audio?.open) {
      error = 'Audio is off — turn it on in “Audio settings”';
      return render();
    }
    engine.recStart();
  });
  ref.sel.addEventListener('change', () => {
    ref.sel.blur(); // выбрал — фокус уходит, и пробел снова запускает сэмпл, а не открывает список
    const v = ref.sel.value;
    if (v === '__pick') {
      ref.sel.value = keyOf(sel);
      engine.pickSample();
      return;
    }
    sel = v.startsWith('f:') ? { id: 'file', path: v.slice(2) } : { id: v.slice(2), path: null };
    store.set('samples.sel', sel);
    options();
    if (playing) start();
  });
  ref.bypass.addEventListener('click', () => {
    bypass = !bypass;
    engine.setBypass(bypass);
    render();
  });

  engine.on('samples', options);
  engine.on('sample', (m) => {
    playing = !!m.on;
    error = m.error || null;
    render();
  });
  engine.on('rec', (m) => {
    recording = !!m.on;
    if (m.on) {
      recSec = 0;
      recMax = m.max || 60;
      error = null;
    } else if (m.error) {
      error = m.error;
    } else if (m.path) {
      // запись сохранена — сразу ставим её играть по кругу через текущий пресет
      sel = { id: 'file', path: m.path };
      store.set('samples.sel', sel);
      options();
      start();
      note = m.quiet ? 'The recording is quiet — raise the Gain on your interface' : 'Recording saved';

    }
    render();
  });
  engine.on('pickedSample', (m) => {
    if (!m.path) return;
    store.set('samples.files', [m.path, ...ownFiles().filter((p) => p !== m.path)].slice(0, 8));
    sel = { id: 'file', path: m.path };
    store.set('samples.sel', sel);
    options();
    start();
  });

  options();
  render();

  return {
    get playing() {
      return playing;
    },
    toggle: () => (recording ? engine.recStop() : playing ? stop() : start()),
    /** Уйти с экрана: сэмпл и обход выключаются, чтобы в упражнениях снова звучала гитара. */
    stop() {
      if (recording) engine.recStop();
      stop();
      if (bypass) {
        bypass = false;
        engine.setBypass(false);
        render();
      }
    },
    frame(m) {
      if (recording) {
        if (m.recFull) engine.recStop(); // минута кончилась — сохраняем
        if (m.rec >= 0 && Math.floor(m.rec) !== Math.floor(recSec)) {
          recSec = m.rec;
          render();
        }
        recSec = Math.max(recSec, m.rec);
        ref.bar.style.transform = `scaleX(${Math.min(1, recSec / recMax).toFixed(3)})`;
      } else if (playing) ref.bar.style.transform = `scaleX(${Math.max(0, m.smp ?? 0).toFixed(3)})`;
    },
  };
}
