// Тренажёр аккордов: показываю аккорд — ты ставишь и играешь, меряем скорость смены.
import { CHORDS, PROGRESSIONS, chordById, chordMidis } from '../music.js';
import { chordTemplate, rankChords } from '../chroma.js';
import { Fretboard } from '../fretboard.js';
import { fmtSec } from '../store.js';

const ROUND = 16;
const MATCH_SCORE = 0.78;
const MATCH_FRAMES = 4;

export function createChords(root, { engine, store }) {
  const cfg = Object.assign({ source: 'random', set: ['Em', 'Am', 'C', 'G', 'D'] }, store.get('chords.cfg', {}));
  const templates = CHORDS.map((chord) => ({ chord, template: chordTemplate(chord) }));

  root.innerHTML = `
    <div class="controls">
      <div class="ctl"><label for="chordSrc">Order</label>
        <select class="select" id="chordSrc" data-ref="source">
          <option value="random">Random from selected</option>
          ${PROGRESSIONS.map((p) => `<option value="${p.id}">${p.chords.join(' – ')}</option>`).join('')}
        </select>
      </div>
      <div class="ctl"><span class="ctl-label">Chords</span>
        <div class="chips" data-ref="set">${CHORDS.map((c) => `<button class="chip" data-id="${c.id}">${c.id}</button>`).join('')}</div>
      </div>
    </div>
    <div class="stage chord-stage">
      <div>
        <div class="prompt-kicker" data-ref="kicker">Chord</div>
        <div class="prompt-main" data-ref="main"></div>
        <div class="chord-next" data-ref="next"></div>
        <div class="chord-heard" data-ref="heard">Hearing: <b>—</b></div>
      </div>
      <div class="fb-host narrow chord-diagram"></div>
      <div class="side">
        <div class="stats">
          <div class="stat"><div class="stat-val" data-ref="count">—</div><div class="stat-label">played</div></div>
          <div class="stat"><div class="stat-val" data-ref="avg">—</div><div class="stat-label">change</div></div>
          <div class="stat"><div class="stat-val" data-ref="best">—</div><div class="stat-label">best</div></div>
        </div>
        <div class="chord-actions">
          <button class="btn btn-lg" data-ref="listen">Listen</button>
          <button class="btn btn-primary btn-lg" data-ref="start">Start</button>
        </div>
      </div>
    </div>
    <div class="progress"><div data-ref="bar"></div></div>
    <div class="feedback" data-ref="feedback"></div>
    <p class="hint">Numbers on the fretboard are fingers: 1 is the index finger, 4 is the pinky. A circle left of the nut is an open string, × is a muted string.
      Strum the chord across all its strings and let it ring: recognition takes about a third of a second.</p>`;

  const ref = {};
  for (const n of root.querySelectorAll('[data-ref]')) ref[n.dataset.ref] = n;
  const heardEl = ref.heard.querySelector('b');

  const fb = new Fretboard(root.querySelector('.fb-host'), { frets: 5 });

  let shown = chordById(cfg.set[0]) || CHORDS[0]; // аккорд на диаграмме
  let run = null; // { i, seq, times, lastHitAt, lastHitId, streak, onset, locked }
  let offs = [];
  let timer = null;

  function drawChord(chord, hit = false) {
    const markers = [];
    chord.frets.forEach((f, s) => {
      if (f < 0) markers.push({ s, f: 0, kind: 'mute' });
      else if (f === 0) markers.push({ s, f: 0, kind: hit ? 'hit' : 'open' });
      else markers.push({ s, f, kind: hit ? 'hit' : 'chord', label: String(chord.fingers[s] || '') });
    });
    fb.setMarkers(markers);
  }

  function show(chord) {
    shown = chord;
    ref.main.textContent = chord.id;
    drawChord(chord);
  }

  function syncControls() {
    ref.source.value = cfg.source;
    const prog = PROGRESSIONS.find((p) => p.id === cfg.source);
    for (const b of ref.set.children) {
      const inSet = prog ? prog.chords.includes(b.dataset.id) : cfg.set.includes(b.dataset.id);
      b.setAttribute('aria-pressed', inSet);
    }
  }

  ref.source.addEventListener('change', () => {
    cfg.source = ref.source.value;
    store.set('chords.cfg', cfg);
    if (run) stop();
    syncControls();
    const prog = PROGRESSIONS.find((p) => p.id === cfg.source);
    show(chordById(prog ? prog.chords[0] : cfg.set[0]));
  });

  ref.set.addEventListener('click', (e) => {
    const b = e.target.closest('.chip');
    if (!b) return;
    const id = b.dataset.id;
    if (cfg.source === 'random') {
      if (cfg.set.includes(id)) {
        if (cfg.set.length > 2) cfg.set = cfg.set.filter((x) => x !== id);
      } else cfg.set.push(id);
      store.set('chords.cfg', cfg);
      if (run) stop();
      syncControls();
    }
    if (!run) show(chordById(id)); // заодно показываем аппликатуру
  });

  ref.listen.addEventListener('click', () => engine.strum(chordMidis(shown)));
  ref.start.addEventListener('click', () => (run ? stop() : start()));

  function buildSeq() {
    const prog = PROGRESSIONS.find((p) => p.id === cfg.source);
    const seq = [];
    for (let i = 0; i < ROUND; i++) {
      if (prog) seq.push(prog.chords[i % prog.chords.length]);
      else {
        let id;
        do id = cfg.set[Math.floor(Math.random() * cfg.set.length)];
        while (i > 0 && id === seq[i - 1]);
        seq.push(id);
      }
    }
    return seq.map(chordById);
  }

  function start() {
    engine.ensure();
    run = { i: 0, seq: buildSeq(), times: [], lastHitAt: null, lastHitId: null, streak: 0, onset: false, locked: false };
    ref.start.textContent = 'Stop';
    ref.start.classList.remove('btn-primary');
    setFeedback('');
    next();
  }

  function next() {
    const chord = run.seq[run.i];
    run.streak = 0;
    run.onset = false;
    ref.kicker.textContent = `Chord ${run.i + 1} of ${ROUND}`;
    show(chord);
    const after = run.seq[run.i + 1];
    ref.next.innerHTML = after ? `next: <b>${after.id}</b>` : 'last one';
    ref.bar.style.width = (run.i / ROUND) * 100 + '%';
    updateStats();
  }

  function onFrame(frame) {
    if (!frame.active) {
      heardEl.textContent = '—';
      if (run) run.streak = 0;
      return;
    }
    const res = engine.chroma();
    if (!res || res.peakDb < -78) return;
    const ranked = rankChords(res.chroma, templates);
    const top = ranked[0];
    heardEl.textContent = top.score >= 0.7 ? top.chord.id : '…';

    if (!run || run.locked) return;
    const target = run.seq[run.i];
    if (top.chord.id === target.id && top.score >= MATCH_SCORE) run.streak++;
    else run.streak = 0;
    if (run.streak >= MATCH_FRAMES && (target.id !== run.lastHitId || run.onset)) hit(target);
  }

  function hit(chord) {
    const now = performance.now();
    if (run.lastHitAt != null) run.times.push((now - run.lastHitAt) / 1000);
    run.lastHitAt = now;
    run.lastHitId = chord.id;
    run.i++;
    run.locked = true;
    drawChord(chord, true);
    setFeedback(run.times.length ? `Correct — changed in ${fmtSec(run.times[run.times.length - 1])}` : 'Correct', 'good');
    updateStats();
    timer = setTimeout(() => {
      if (!run) return;
      run.locked = false;
      if (run.i >= ROUND) finish();
      else next();
    }, 350);
  }

  function finish() {
    const a = avg(run.times);
    const best = store.get('chords.best', null);
    const record = best == null || a < best;
    if (record) store.set('chords.best', a);
    ref.bar.style.width = '100%';
    ref.kicker.textContent = 'Round over';
    ref.next.textContent = '';
    setFeedback(`${ROUND} chords, average change — ${fmtSec(a)}.${record ? ' New record!' : ''}`, 'good');
    run = null;
    ref.start.textContent = 'Another round';
    ref.start.classList.add('btn-primary');
    drawChord(shown);
    updateStats(a);
  }

  function stop() {
    clearTimeout(timer);
    run = null;
    ref.kicker.textContent = 'Chord';
    ref.next.textContent = '';
    ref.bar.style.width = '0';
    ref.start.textContent = 'Start';

    ref.start.classList.add('btn-primary');
    setFeedback('');
    drawChord(shown);
    updateStats();
  }

  function updateStats(finalAvg) {
    if (run) {
      ref.count.textContent = `${run.i}/${ROUND}`;
      ref.avg.textContent = run.times.length ? fmtSec(avg(run.times)) : '—';
    } else if (finalAvg != null) {
      ref.count.textContent = `${ROUND}/${ROUND}`;
      ref.avg.textContent = fmtSec(finalAvg);
    } else {
      ref.count.textContent = '—';
      ref.avg.textContent = '—';
    }
    const best = store.get('chords.best', null);
    ref.best.textContent = best ? fmtSec(best) : '—';
  }

  function setFeedback(text, kind = '') {
    ref.feedback.textContent = text;
    ref.feedback.className = 'feedback ' + kind;
  }

  syncControls();
  {
    const prog = PROGRESSIONS.find((p) => p.id === cfg.source);
    show(chordById(prog ? prog.chords[0] : cfg.set[0]) || CHORDS[0]);
  }
  updateStats();

  return {
    setActive(on) {
      engine.setChromaEnabled(on); // спектр для аккордов считаем, только пока открыта эта вкладка
      if (on && !offs.length) {
        offs = [engine.on('frame', onFrame), engine.on('onset', () => run && (run.onset = true))];
      }
      if (!on && offs.length) {
        offs.forEach((f) => f());
        offs = [];
        if (run) stop();
      }
    },
  };
}

const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
