// Тюнер: хроматический, с подсказкой по ближайшей струне.
import { TUNING, STRING_ORD, noteName, noteOctave, freqToMidi } from '../music.js';

const IN_TUNE = 5; // центов

export function createTuner(root, { engine }) {
  root.innerHTML = `
    <div class="tuner">
      <div class="tuner-note"><span class="tn-name">—</span><span class="tn-oct"></span></div>
      <div class="tuner-hint">Pluck any string</div>
      <div class="gauge">
        <div class="gauge-track"></div>
        <div class="gauge-zone"></div>
        ${[-50, -25, 0, 25, 50]
          .map((c) => `<div class="gauge-tick${c === 0 ? ' mid' : ''}" style="left:${50 + c}%"><span>${c > 0 ? '+' + c : c}</span></div>`)
          .join('')}
        <div class="gauge-needle"></div>
      </div>
      <div class="tuner-read"><b class="tn-cents">0</b> cents · <b class="tn-hz">—</b> Hz</div>
      <div class="tuner-strings">
        ${TUNING.map(
          (m, s) => `<button class="string-btn" data-s="${s}" title="Hear the reference pitch"><b>${noteName(m)}</b><small>${STRING_ORD[s]}</small></button>`
        ).join('')}
      </div>
      <p class="hint">Click a string to hear how it should sound.</p>
    </div>`;

  const $ = (s) => root.querySelector(s);
  const box = $('.tuner');
  const nameEl = $('.tn-name');
  const octEl = $('.tn-oct');
  const hintEl = $('.tuner-hint');
  const needle = $('.gauge-needle');
  const centsEl = $('.tn-cents');
  const hzEl = $('.tn-hz');
  const stringBtns = [...root.querySelectorAll('.string-btn')];

  for (const b of stringBtns) {
    b.addEventListener('click', () => engine.playNote(TUNING[+b.dataset.s], { gain: 0.6 }));
  }

  let hist = [];
  let lastHeard = 0;
  let off = null;

  function onFrame(frame) {
    const now = performance.now();
    if (frame.freq == null) {
      if (now - lastHeard > 1500 && box.classList.contains('is-live')) idle();
      return;
    }
    lastHeard = now;
    hist.push(frame.freq);
    if (hist.length > 5) hist.shift();
    const freq = [...hist].sort((a, b) => a - b)[hist.length >> 1];
    const midi = freqToMidi(freq);
    const note = Math.round(midi);
    const cents = (midi - note) * 100;

    // новая нота — старую историю выбрасываем, чтобы стрелка не «плыла» между нотами
    if (Math.abs(freqToMidi(frame.freq) - midi) > 0.8) hist = [frame.freq];

    nameEl.textContent = noteName(note);
    octEl.textContent = noteOctave(note);
    const c = Math.round(cents);
    centsEl.textContent = (c > 0 ? '+' : c < 0 ? '−' : '') + Math.abs(c);
    hzEl.textContent = freq.toFixed(1);

    needle.style.left = 50 + Math.max(-50, Math.min(50, cents)) + '%';

    let near = 0;
    for (let s = 1; s < 6; s++) if (Math.abs(midi - TUNING[s]) < Math.abs(midi - TUNING[near])) near = s;
    const diff = midi - TUNING[near]; // в полутонах от нужной ноты струны
    const onString = Math.abs(diff) < 3.5;
    stringBtns.forEach((b, s) => b.classList.toggle('is-near', onString && s === near));

    const ok = Math.abs(cents) <= IN_TUNE && (!onString || note === TUNING[near]);
    box.classList.add('is-live');
    box.classList.toggle('is-ok', ok);

    if (!onString) {
      hintEl.textContent = Math.abs(cents) <= IN_TUNE ? 'In tune' : cents < 0 ? 'Slightly flat' : 'Slightly sharp';
    } else if (ok) {
      hintEl.textContent = `${STRING_ORD[near]} string is in tune`;
    } else {
      const far = Math.abs(diff) >= 0.5;
      hintEl.textContent =
        diff < 0
          ? `${STRING_ORD[near]} string is ${far ? 'way ' : ''}flat — tighten it`
          : `${STRING_ORD[near]} string is ${far ? 'way ' : ''}sharp — loosen it`;
    }
  }

  function idle() {
    hist = [];
    box.classList.remove('is-live', 'is-ok');
    nameEl.textContent = '—';
    octEl.textContent = '';
    hintEl.textContent = 'Pluck any string';

    centsEl.textContent = '0';
    hzEl.textContent = '—';
    stringBtns.forEach((b) => b.classList.remove('is-near'));
  }

  return {
    setActive(on) {
      if (on && !off) off = engine.on('frame', onFrame);
      if (!on && off) {
        off();
        off = null;
        idle();
      }
    },
  };
}
