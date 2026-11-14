// Тренажёр гамм: позиция на грифе + табулатура, играешь вверх и вниз на время.
import { NOTE_NAMES, SCALES, scaleLayout, noteName, posMidi } from '../music.js';
import { Fretboard } from '../fretboard.js';
import { fmtSec } from '../store.js';

export function createScales(root, { engine, store }) {
  const cfg = Object.assign({ root: 9, scale: 'pent-min' }, store.get('scales.cfg', {}));

  root.innerHTML = `
    <div class="controls">
      <div class="ctl"><span class="ctl-label">Root</span>
        <div class="chips" data-ref="roots">${NOTE_NAMES.map((n, i) => `<button class="chip" data-pc="${i}">${n}</button>`).join('')}</div>
      </div>
      <div class="ctl"><label for="scaleSel">Scale or exercise</label>
        <select class="select" id="scaleSel" data-ref="scale">${SCALES.map((s) => `<option value="${s.id}">${s.name}</option>`).join('')}</select>
      </div>
    </div>
    <div class="stage">
      <div>
        <div class="prompt-kicker" data-ref="kicker">Scale</div>
        <div class="prompt-main sm" data-ref="main"></div>
        <div class="prompt-sub" data-ref="sub"></div>
      </div>
      <div class="side">
        <div class="stats">
          <div class="stat"><div class="stat-val" data-ref="time">—</div><div class="stat-label">time</div></div>
          <div class="stat"><div class="stat-val" data-ref="miss">—</div><div class="stat-label">misses</div></div>
          <div class="stat"><div class="stat-val" data-ref="best">—</div><div class="stat-label">best</div></div>
        </div>
        <button class="btn btn-primary btn-lg" data-ref="start">Start</button>
      </div>
    </div>
    <div class="tab-strip" data-ref="strip"><div class="tab-grid" data-ref="tab"></div></div>
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

  let layout = null;
  let scale = null;
  let run = null; // { i, misses, t0 }
  let off = null;
  let clock = null;

  const bestKey = () => `scales.best.${scale.id}`;

  function rebuild() {
    scale = SCALES.find((s) => s.id === cfg.scale) || SCALES[0];
    layout = scaleLayout(cfg.root, scale);
    for (const b of ref.roots.children) {
      b.setAttribute('aria-pressed', +b.dataset.pc === cfg.root);
      b.disabled = !!scale.exercise;
    }
    ref.scale.value = scale.id;
    ref.kicker.textContent = scale.exercise ? 'Exercise' : 'Scale';
    ref.main.textContent = scale.exercise ? scale.name : `${NOTE_NAMES[cfg.root]} ${scale.short}`;
    describe();
    buildTab();
    draw();
    updateStats();
  }

  function describe() {
    const n = layout.seq.length;
    ref.sub.textContent = scale.exercise
      ? `Four fingers, four frets, starting at fret ${layout.startFret}. ${n} notes: from the 6th string to the 1st and back.`
      : `Position from fret ${layout.startFret}. ${n} notes: up from the root and back. The first note starts the timer.`;
  }

  function buildTab() {
    const cells = [];
    for (let row = 0; row < 6; row++) cells.push(`<div class="tab-cell label">${noteName(posMidi(5 - row, 0))}</div>`);
    layout.seq.forEach((n, i) => {
      for (let row = 0; row < 6; row++) {
        const s = 5 - row;
        cells.push(`<div class="tab-cell" data-i="${i}">${n.s === s ? `<span>${n.f}</span>` : ''}</div>`);
      }
    });
    ref.tab.innerHTML = cells.join('');
  }

  function draw() {
    const i = run ? run.i : -1;
    const target = i >= 0 ? layout.seq[i] : null;
    const markers = layout.box.map((n) => ({
      s: n.s,
      f: n.f,
      kind: target && n.midi === target.midi ? 'target' : n.root ? 'root' : 'scale',
      label: noteName(n.midi),
    }));
    fb.setMarkers(markers);

    for (const c of ref.tab.querySelectorAll('.tab-cell[data-i]')) {
      const ci = +c.dataset.i;
      c.classList.toggle('is-done', run != null && ci < i);
      c.classList.toggle('is-cur', ci === i);
    }
    if (i >= 0) {
      const cur = ref.tab.querySelector(`.tab-cell[data-i="${i}"]`);
      if (cur) {
        const strip = ref.strip;
        const want = cur.offsetLeft - strip.clientWidth / 2;
        if (Math.abs(strip.scrollLeft - want) > 60) strip.scrollTo({ left: want, behavior: 'smooth' });
      }
    }
  }

  function start() {
    engine.ensure();
    run = { i: 0, misses: 0, t0: null };
    ref.start.textContent = 'Stop';
    ref.start.classList.remove('btn-primary');
    ref.strip.scrollLeft = 0;
    setFeedback('Play the first note to start the timer');
    draw();
    updateStats();
  }

  function stop(message = '') {
    clearInterval(clock);
    run = null;
    ref.start.textContent = 'Start';
    ref.start.classList.add('btn-primary');
    setFeedback(message, message ? 'good' : '');
    draw();
  }

  function onNote({ midi }) {
    if (!run) return;
    const t = layout.seq[run.i];
    if (midi !== t.midi) {
      if (run.t0 == null) return; // до старта секундомера ошибки не считаем
      if (midi === run.prevMidi) return; // ещё звучит прошлая нота — это не ошибка
      run.misses++;
      fb.flash(t.s, t.f, 'miss');
      setFeedback(`That’s ${noteName(midi)}, you need ${noteName(t.midi)}`, 'bad');
      updateStats();
      return;
    }
    if (run.t0 == null) {
      run.t0 = performance.now();
      clock = setInterval(updateStats, 100);
    }
    fb.flash(t.s, t.f, 'hit');
    run.prevMidi = t.midi;
    run.i++;
    setFeedback('');
    if (run.i >= layout.seq.length) {
      finish();
      return;
    }
    draw();
    updateStats();
  }

  function finish() {
    const sec = (performance.now() - run.t0) / 1000;
    const misses = run.misses;
    const npm = Math.round(((layout.seq.length - 1) / sec) * 60);
    const best = store.get(bestKey(), null);
    const record = best == null || sec < best;
    if (record) store.set(bestKey(), sec);
    ref.time.textContent = fmtSec(sec);
    stop(
      `Done: ${fmtSec(sec)}, ${npm} notes per minute, misses — ${misses}.${record ? ' New record!' : ''}` +
        (misses === 0 ? ' Clean run — try it faster or turn on the metronome.' : '')
    );
    updateStats(sec, misses);
  }

  function updateStats(finalSec, finalMiss) {
    if (run) {
      ref.time.textContent = run.t0 == null ? '0.0 s' : fmtSec((performance.now() - run.t0) / 1000);

      ref.miss.textContent = run.misses;
    } else if (finalSec != null) {
      ref.time.textContent = fmtSec(finalSec);
      ref.miss.textContent = finalMiss;
    } else {
      ref.time.textContent = '—';
      ref.miss.textContent = '—';
    }
    const best = store.get(bestKey(), null);
    ref.best.textContent = best ? fmtSec(best) : '—';
  }

  function setFeedback(text, kind = '') {
    ref.feedback.textContent = text;
    ref.feedback.className = 'feedback ' + kind;
  }

  function changeCfg() {
    store.set('scales.cfg', cfg);
    if (run) stop();
    setFeedback('');
    rebuild();
  }
  ref.roots.addEventListener('click', (e) => {
    const b = e.target.closest('.chip');
    if (!b || b.disabled) return;
    cfg.root = +b.dataset.pc;
    changeCfg();
  });
  ref.scale.addEventListener('change', () => {
    cfg.scale = ref.scale.value;
    changeCfg();
  });
  ref.start.addEventListener('click', () => (run ? stop() : start()));

  rebuild();

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
