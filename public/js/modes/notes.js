// Тренажёр «Ноты на грифе»: приложение называет ноту и струну — ты её находишь и играешь.
import { TUNING, STRING_ORD, noteName, posMidi, isSharp, pcOf } from '../music.js';
import { Fretboard } from '../fretboard.js';
import { fmtSec } from '../store.js';

const ROUND = 20;
const FRET_OPTIONS = [
  { v: 5, label: '0–5' },
  { v: 9, label: '0–9' },
  { v: 11, label: '0–11' },
];

export function createNotes(root, { engine, store }) {
  const cfg = Object.assign(
    { strings: [true, true, true, true, true, true], maxFret: 5, sharps: false, show: false },
    store.get('notes.cfg', {})
  );

  root.innerHTML = `
    <div class="controls">
      <div class="ctl"><span class="ctl-label">Strings</span>
        <div class="chips" data-ref="strings">
          ${TUNING.map((m, s) => `<button class="chip" data-s="${s}" title="${STRING_ORD[s]} string">${6 - s} · ${noteName(m)}</button>`).join('')}
        </div>
      </div>
      <div class="ctl"><span class="ctl-label">Frets</span>
        <div class="seg" data-ref="frets">${FRET_OPTIONS.map((o) => `<button data-v="${o.v}">${o.label}</button>`).join('')}</div>
      </div>
      <div class="ctl ctl-row"><label class="switch"><input type="checkbox" data-ref="sharps"><span class="switch-ui"></span><span>Sharps</span></label></div>
      <div class="ctl ctl-row"><label class="switch"><input type="checkbox" data-ref="show"><span class="switch-ui"></span><span>Show on the fretboard</span></label></div>
    </div>
    <div class="stage">
      <div>
        <div class="prompt-kicker" data-ref="kicker">Notes on the fretboard</div>
        <div class="prompt-main sm" data-ref="main">Find and play the note</div>
        <div class="prompt-sub" data-ref="sub">A round of ${ROUND} notes. I name a note and a string — you play it on the guitar.</div>
      </div>
      <div class="side">
        <div class="stats">
          <div class="stat"><div class="stat-val" data-ref="clean">—</div><div class="stat-label">first try</div></div>
          <div class="stat"><div class="stat-val" data-ref="avg">—</div><div class="stat-label">average time</div></div>
          <div class="stat"><div class="stat-val" data-ref="best">—</div><div class="stat-label">best</div></div>
        </div>
        <button class="btn btn-primary btn-lg" data-ref="start">Start</button>
      </div>
    </div>
    <div class="progress"><div data-ref="bar"></div></div>
    <div class="fb-host"></div>
    <div class="feedback" data-ref="feedback"></div>`;

  const ref = {};
  for (const n of root.querySelectorAll('[data-ref]')) ref[n.dataset.ref] = n;

  const fb = new Fretboard(root.querySelector('.fb-host'), {
    frets: 15,
    onPick(s, f) {
      fb.flash(s, f);
      engine.playNote(posMidi(s, f));
    },
  });

  let run = null;
  let off = null;
  let timer = null;

  // ----- настройки -----
  function syncControls() {
    for (const b of ref.strings.children) b.setAttribute('aria-pressed', cfg.strings[+b.dataset.s]);
    for (const b of ref.frets.children) b.setAttribute('aria-pressed', +b.dataset.v === cfg.maxFret);
    ref.sharps.checked = cfg.sharps;
    ref.show.checked = cfg.show;
  }
  function saveCfg() {
    store.set('notes.cfg', cfg);
    syncControls();
    if (run && !run.locked) drawTarget();
  }
  ref.strings.addEventListener('click', (e) => {
    const b = e.target.closest('.chip');
    if (!b) return;
    const s = +b.dataset.s;
    if (cfg.strings[s] && cfg.strings.filter(Boolean).length === 1) return; // хотя бы одна струна
    cfg.strings[s] = !cfg.strings[s];
    saveCfg();
  });
  ref.frets.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    cfg.maxFret = +b.dataset.v;
    saveCfg();
  });
  ref.sharps.addEventListener('change', () => ((cfg.sharps = ref.sharps.checked), saveCfg()));
  ref.show.addEventListener('change', () => ((cfg.show = ref.show.checked), saveCfg()));
  ref.start.addEventListener('click', () => (run ? stop() : start()));

  // ----- раунд -----
  function pick(prevMidi) {
    const pool = [];
    for (let s = 0; s < 6; s++) {
      if (!cfg.strings[s]) continue;
      for (let f = 0; f <= cfg.maxFret; f++) {
        const midi = posMidi(s, f);
        if (!cfg.sharps && isSharp(midi)) continue;
        if (midi === prevMidi) continue;
        pool.push({ s, f, midi });
      }
    }
    return pool[Math.floor(Math.random() * pool.length)];
  }

  function start() {
    engine.ensure();
    run = { i: 0, clean: 0, times: [], target: null, misses: 0, shownAt: 0, locked: false, revealed: false };
    ref.start.textContent = 'Stop';
    ref.start.classList.remove('btn-primary');
    setFeedback('');
    next();
  }

  function next() {
    run.target = pick(run.target?.midi);
    run.misses = 0;
    run.revealed = false;
    run.shownAt = performance.now();
    ref.kicker.textContent = `Note ${run.i + 1} of ${ROUND}`;
    ref.main.classList.remove('sm');
    ref.main.textContent = noteName(run.target.midi);
    ref.sub.innerHTML = `on the <b>${STRING_ORD[run.target.s]}</b> string`;
    ref.bar.style.width = (run.i / ROUND) * 100 + '%';
    drawTarget();
    updateStats();
  }

  function drawTarget() {
    const t = run.target;
    fb.setMarkers(cfg.show || run.revealed ? [{ s: t.s, f: t.f, kind: 'target', label: noteName(t.midi) }] : []);
  }

  function onNote({ midi }) {
    if (!run || run.locked) return;
    const t = run.target;
    if (midi === t.midi) {
      const dt = (performance.now() - run.shownAt) / 1000;
      run.times.push(dt);
      if (run.misses === 0) run.clean++;
      run.i++;
      run.locked = true;
      run.prevMidi = t.midi;
      fb.setMarkers([{ s: t.s, f: t.f, kind: 'hit', label: noteName(t.midi) }]);
      setFeedback(`Correct — ${fmtSec(dt)}`, 'good');
      updateStats();
      timer = setTimeout(() => {
        if (!run) return;
        run.locked = false;
        if (run.i >= ROUND) finish();
        else next();
      }, 550);
      return;
    }
    if (midi === run.prevMidi) return; // ещё звучит прошлая нота — это не ошибка
    run.misses++;
    if (pcOf(midi) === pcOf(t.midi)) {
      setFeedback(`That’s ${noteName(midi)}, but in another octave — look on the ${STRING_ORD[t.s]} string`, 'bad');
    } else {
      setFeedback(`That’s ${noteName(midi)}, you need ${noteName(t.midi)}`, 'bad');
    }
    if (run.misses >= 2 && !run.revealed) {
      run.revealed = true;
      drawTarget();
    }
  }

  function updateStats() {
    if (run) {
      ref.clean.textContent = `${run.clean}/${run.i}`;
      ref.avg.textContent = run.times.length ? fmtSec(avg(run.times)) : '—';
    }
    const best = store.get('notes.best', null);
    ref.best.textContent = best ? fmtSec(best) : '—';
  }

  function finish() {
    const a = avg(run.times);
    const clean = run.clean;
    const best = store.get('notes.best', null);
    const record = best == null || a < best;
    if (record) store.set('notes.best', a);
    ref.bar.style.width = '100%';
    ref.kicker.textContent = 'Round over';
    ref.main.classList.add('sm');
    ref.main.textContent = `${clean} of ${ROUND} on the first try`;
    ref.sub.textContent = `Average time per note — ${fmtSec(a)}.${record ? ' New record!' : ''}`;
    setFeedback('');
    fb.setMarkers([]);
    run = null;
    ref.start.textContent = 'Another round';
    ref.start.classList.add('btn-primary');
    updateStats();
  }

  function stop() {
    clearTimeout(timer);
    run = null;
    fb.setMarkers([]);
    ref.kicker.textContent = 'Notes on the fretboard';
    ref.main.classList.add('sm');
    ref.main.textContent = 'Find and play the note';
    ref.sub.textContent = `A round of ${ROUND} notes. I name a note and a string — you play it on the guitar.`;
    ref.bar.style.width = '0';
    ref.start.textContent = 'Start';

    ref.start.classList.add('btn-primary');
    setFeedback('');
  }

  function setFeedback(text, kind = '') {
    ref.feedback.textContent = text;
    ref.feedback.className = 'feedback ' + kind;
  }

  syncControls();
  updateStats();

  return {
    setActive(on) {
      if (on && !off) off = engine.on('note', onNote);
      if (!on && off) {
        off();
        off = null;
        if (run) stop();
      }
    },
  };
}

const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
