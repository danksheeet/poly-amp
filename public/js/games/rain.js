// Игра «Fret Rain»: на гриф падают капли, каждая — на свой лад, цвет капли — струна.
// Сыграй эту ноту на гитаре, пока капля не упала, — она лопнет. С каждым уровнем капли падают
// быстрее и их больше. Без гитары можно щёлкать по грифу: приложение сыграет ноту и само её услышит.
import { TUNING, noteName, posMidi, isSharp, pcOf } from '../music.js';
import { createShell, createLoop, createFx, COLORS, STRING_COLORS } from './shell.js';

const FRET_OPTIONS = [3, 5, 7, 12];
const STRING_NAMES = ['E', 'A', 'D', 'G', 'B', 'E'];
const INLAYS = [3, 5, 7, 9, 12];
const ROW = 20; // расстояние между струнами на холсте
const R = 19; // радиус капли

export function createRain(root, { engine, store }) {
  const cfg = Object.assign({ strings: [false, false, false, false, true, true], maxFret: 5, labels: 'frets', sharps: false, guide: true }, store.get('games.rain.cfg', {}));
  const shell = createShell(root, {
    id: 'rain',
    store,
    title: 'Fret Rain',
    how: 'Play the fret before the drop lands',
    controls: `
      <div class="ctl"><span class="ctl-label">Strings</span>
        <div class="chips" data-ref="strings">${TUNING.map((m, s) => `<button class="chip" data-s="${s}">${6 - s} · ${noteName(m)}</button>`).join('')}</div>
      </div>
      <div class="ctl"><span class="ctl-label">Frets</span>
        <div class="seg" data-ref="frets">${FRET_OPTIONS.map((v) => `<button data-v="${v}">0–${v}</button>`).join('')}</div>
      </div>
      <div class="ctl"><span class="ctl-label">Drops show</span>
        <div class="seg" data-ref="labels"><button data-v="frets">Frets</button><button data-v="notes">Notes</button></div>
      </div>
      <div class="ctl ctl-row" data-ref="sharpsBox"><label class="switch"><input type="checkbox" data-ref="sharps"><span class="switch-ui"></span><span>Sharps</span></label></div>
      <div class="ctl ctl-row"><label class="switch"><input type="checkbox" data-ref="guide"><span class="switch-ui"></span><span>Show the spot</span></label></div>`,
  });
  const { ref, hud } = shell;
  for (const n of root.querySelectorAll('.controls [data-ref]')) ref[n.dataset.ref] = n;
  shell.ref.osub.textContent = 'Each drop falls onto a fret, its color is the string. Play that note on the guitar to burst it — three drops on the board and the game is over. No guitar? Click the fretboard.';

  // ---------- настройки ----------
  function syncControls() {
    for (const b of ref.strings.children) b.setAttribute('aria-pressed', cfg.strings[+b.dataset.s]);
    for (const b of ref.frets.children) b.setAttribute('aria-pressed', +b.dataset.v === cfg.maxFret);
    for (const b of ref.labels.children) b.setAttribute('aria-pressed', b.dataset.v === cfg.labels);
    ref.sharps.checked = cfg.sharps;
    ref.guide.checked = cfg.guide;
    ref.sharpsBox.hidden = cfg.labels !== 'notes';
  }
  function saveCfg() {
    store.set('games.rain.cfg', cfg);
    syncControls();
    loop.redraw();
  }
  ref.strings.addEventListener('click', (e) => {
    const b = e.target.closest('.chip');
    if (!b) return;
    const s = +b.dataset.s;
    if (cfg.strings[s] && cfg.strings.filter(Boolean).length === 1) return;
    cfg.strings[s] = !cfg.strings[s];
    saveCfg();
  });
  ref.frets.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) ((cfg.maxFret = +b.dataset.v), saveCfg());
  });
  ref.labels.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) ((cfg.labels = b.dataset.v), saveCfg());
  });
  ref.sharps.addEventListener('change', () => ((cfg.sharps = ref.sharps.checked), saveCfg()));
  ref.guide.addEventListener('change', () => ((cfg.guide = ref.guide.checked), saveCfg()));

  // ---------- игра ----------
  let game = null; // { drops, spawnIn, hits, lastHit, lastHitAt, over }
  const fx = createFx();
  const flashes = []; // подсветка мест на грифе: { s, f, color, t }

  const fallTime = () => Math.max(2.4, 6.5 - 0.42 * (hud.level - 1));
  const spawnEvery = () => Math.max(0.85, 2.5 - 0.17 * (hud.level - 1));
  const maxDrops = () => Math.min(5, 2 + Math.floor(hud.level / 2));

  function pickDrop() {
    const pool = [];
    for (let s = 0; s < 6; s++) {
      if (!cfg.strings[s]) continue;
      for (let f = 0; f <= cfg.maxFret; f++) {
        const midi = posMidi(s, f);
        if (cfg.labels === 'notes' && !cfg.sharps && isSharp(midi)) continue;
        // не две капли с одной нотой (иначе непонятно, какую лопнуть) и не в колонку, где капля только начала падать
        if (game.drops.some((d) => d.midi === midi || (d.f === f && d.p < 0.4))) continue;
        pool.push({ s, f, midi });
      }
    }
    if (!pool.length) return null;
    const d = pool[Math.floor(Math.random() * pool.length)];
    return { ...d, p: 0, speed: 1 / fallTime(), wobble: Math.random() * Math.PI * 2 };
  }

  function start() {
    engine.ensure();
    game = { drops: [], spawnIn: 0.9, hits: 0, lastHit: null, lastHitAt: 0, over: false };
    fx.clear();
    hud.reset();
    shell.hideOverlay();
    shell.setRunning(true);
    loop.start();
  }

  function stop(reason) {
    if (!game) return;
    const g = game;
    game = null;
    loop.stop();
    shell.setRunning(false);
    if (reason === 'over') {
      const record = shell.best.submit(hud.score);
      shell.overlay('Game over', `Score ${hud.score.toLocaleString('en-US')}`, `Level ${hud.level} · ${g.hits} ${g.hits === 1 ? 'drop' : 'drops'} burst${record ? ' · New record!' : ''}`);
    } else {
      shell.overlay('Fret Rain', 'Play the fret before the drop lands', 'Stopped. Press Start (or Space) to play again.');
    }
    loop.redraw();
  }
  ref.start.addEventListener('click', () => (game ? stop('user') : start()));

  function update(dt) {
    fx.update(dt);
    for (const fl of flashes) fl.t += dt;
    for (let i = flashes.length - 1; i >= 0; i--) if (flashes[i].t > 0.6) flashes.splice(i, 1);
    if (!game) return;
    game.spawnIn -= dt;
    if (game.spawnIn <= 0 && game.drops.length < maxDrops()) {
      const d = pickDrop();
      if (d) game.drops.push(d);
      game.spawnIn = spawnEvery() * (0.8 + Math.random() * 0.4);
    }
    for (const d of game.drops) {
      d.p += d.speed * dt;
      d.wobble += dt * 3;
    }
    for (let i = game.drops.length - 1; i >= 0; i--) {
      const d = game.drops[i];
      if (d.p < 1) continue;
      game.drops.splice(i, 1);
      miss(d);
      if (!game) return;
    }
  }

  function miss(d) {
    const { x, y } = spot(d.s, d.f);
    fx.burst(x, y, COLORS.bad, 14);
    flashes.push({ s: d.s, f: d.f, color: COLORS.bad, t: 0 });
    hud.set({ lives: hud.lives - 1, combo: 0 });
    shell.toast(`Missed ${label(d)} on the ${STRING_NAMES[d.s]} string`, 'bad');
    if (hud.lives <= 0) stop('over');
  }

  function onNote({ midi }) {
    if (!game) return;
    const now = performance.now();
    // та же нота ещё звенит после удачного попадания — не ошибка
    if (midi === game.lastHit && now - game.lastHitAt < 1200) return;
    const hit = game.drops.filter((d) => d.midi === midi).sort((a, b) => b.p - a.p)[0];
    if (hit) {
      game.drops.splice(game.drops.indexOf(hit), 1);
      game.hits++;
      game.lastHit = midi;
      game.lastHitAt = now;
      const combo = hud.combo + 1;
      const mult = Math.min(4, 1 + Math.floor(combo / 5));
      const pts = 100 * mult + Math.round((1 - hit.p) * 50);
      const level = 1 + Math.floor(game.hits / 8);
      if (level > hud.level) shell.toast(`Level ${level}`, 'good');
      hud.set({ score: hud.score + pts, combo, level });
      const pos = dropPos(hit);
      fx.burst(pos.x, pos.y, STRING_COLORS[hit.s], 22);
      fx.text(pos.x, pos.y - 26, `+${pts}`, COLORS.ink);
      flashes.push({ s: hit.s, f: hit.f, color: COLORS.good, t: 0 });
      return;
    }
    // не та нота: комбо сгорает; подскажем, если нота верная, но не в той октаве
    if (hud.combo) hud.set({ combo: 0 });
    const same = game.drops.find((d) => pcOf(d.midi) === pcOf(midi));
    shell.toast(same ? `${noteName(midi)} — right note, other octave` : `That’s ${noteName(midi)}`, 'bad');
  }

  // ---------- геометрия ----------
  let geo = { w: 0, h: 0, x0: 46, colW: 40, boardTop: 0 };
  function layout(w, h) {
    const x0 = 46;
    const colW = (w - x0 - 16) / (cfg.maxFret + 1);
    const boardH = ROW * 5 + 26;
    const boardTop = h - boardH - 24;
    geo = { w, h, x0, colW, boardTop, boardH };
  }
  const colX = (f) => geo.x0 + geo.colW * (f + 0.5);
  const strY = (s) => geo.boardTop + 13 + (5 - s) * ROW;
  const spot = (s, f) => ({ x: colX(f), y: strY(s) });
  const dropPos = (d) => ({ x: colX(d.f) + Math.sin(d.wobble) * 1.5, y: 18 + R + d.p * (geo.boardTop - 18 - 2 * R) });
  const label = (d) => (cfg.labels === 'notes' ? noteName(d.midi) : String(d.f));

  // ---------- отрисовка ----------
  function draw(ctx, w, h) {
    layout(w, h);
    ctx.clearRect(0, 0, w, h);
    const { x0, colW, boardTop, boardH } = geo;
    const right = x0 + colW * (cfg.maxFret + 1);

    // колонки ладов над грифом — дорожки, по которым падают капли
    for (let f = 0; f <= cfg.maxFret; f++) {
      ctx.fillStyle = f % 2 ? 'rgba(255,255,255,0.018)' : 'rgba(255,255,255,0.035)';
      ctx.fillRect(x0 + colW * f, 8, colW, boardTop - 8);
    }
    // гриф
    ctx.fillStyle = '#1d1712';
    ctx.beginPath();
    ctx.roundRect(x0, boardTop, right - x0, boardH, 4);
    ctx.fill();
    for (const f of INLAYS) {
      if (f > cfg.maxFret) continue;
      ctx.fillStyle = 'rgba(255,255,255,0.13)';
      const cy = boardTop + boardH / 2;
      if (f === 12) {
        for (const dy of [-ROW, ROW]) ((ctx.beginPath(), ctx.arc(colX(f), cy + dy, 5, 0, Math.PI * 2)), ctx.fill());
      } else ((ctx.beginPath(), ctx.arc(colX(f), cy, 5, 0, Math.PI * 2)), ctx.fill());
    }
    for (let f = 1; f <= cfg.maxFret + 1; f++) {
      const x = x0 + colW * f;
      ctx.fillStyle = f === 1 ? '#e8e2d0' : 'rgba(200, 205, 215, 0.45)';
      ctx.fillRect(x - (f === 1 ? 2.5 : 1), boardTop, f === 1 ? 5 : 2, boardH);
    }
    ctx.font = '600 12px "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'center';
    for (let s = 0; s < 6; s++) {
      const y = strY(s);
      const on = cfg.strings[s];
      ctx.strokeStyle = on ? STRING_COLORS[s] : 'rgba(255,255,255,0.18)';
      ctx.globalAlpha = on ? 0.9 : 0.6;
      ctx.lineWidth = 3.2 - s * 0.38;
      ctx.beginPath();
      ctx.moveTo(x0, y);
      ctx.lineTo(right, y);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = on ? STRING_COLORS[s] : COLORS.ink3;
      ctx.fillText(STRING_NAMES[s], 22, y + 4);
    }
    ctx.fillStyle = COLORS.ink3;
    for (let f = 0; f <= cfg.maxFret; f++) ctx.fillText(String(f), colX(f), h - 7);

    // где сыграть: призрачное кольцо на грифе под каждой каплей
    if (game && cfg.guide) {
      for (const d of game.drops) {
        const { x, y } = spot(d.s, d.f);
        ctx.strokeStyle = STRING_COLORS[d.s];
        ctx.globalAlpha = 0.35 + 0.5 * d.p;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, 9, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    for (const fl of flashes) {
      const { x, y } = spot(fl.s, fl.f);
      ctx.globalAlpha = Math.max(0, 1 - fl.t / 0.6);
      ctx.fillStyle = fl.color;
      ctx.beginPath();
      ctx.arc(x, y, 10 + fl.t * 18, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // капли
    if (game) {
      ctx.font = '700 17px "Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif';
      for (const d of game.drops) {
        const { x, y } = dropPos(d);
        const c = STRING_COLORS[d.s];
        const danger = d.p > 0.78;
        ctx.strokeStyle = c;
        ctx.globalAlpha = 0.25;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x, y + R);
        ctx.lineTo(x, boardTop);
        ctx.stroke();
        ctx.globalAlpha = 1;
        const g = ctx.createRadialGradient(x - 6, y - 7, 2, x, y, R);
        g.addColorStop(0, '#ffffff');
        g.addColorStop(0.25, c);
        g.addColorStop(1, c);
        ctx.fillStyle = g;
        ctx.shadowColor = danger ? COLORS.bad : c;
        ctx.shadowBlur = danger ? 22 + 8 * Math.sin(d.wobble * 3) : 14;
        ctx.beginPath();
        ctx.arc(x, y, R, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.fillStyle = '#111218';
        ctx.fillText(label(d), x, y + 6);
      }
    }
    fx.draw(ctx);
  }

  const loop = createLoop(shell.canvas, { update, draw });

  // без гитары: щелчок по грифу играет ноту, приложение её слышит
  shell.canvas.addEventListener('pointerdown', (e) => {
    const r = shell.canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    if (y < geo.boardTop - 6 || y > geo.boardTop + geo.boardH + 6) return;
    const f = Math.floor((x - geo.x0) / geo.colW);
    const s = 5 - Math.round((y - geo.boardTop - 13) / ROW);
    if (f < 0 || f > cfg.maxFret || s < 0 || s > 5) return;
    engine.playNote(posMidi(s, f));
    flashes.push({ s, f, color: COLORS.ink2, t: 0 });
    if (!loop.running) loop.redraw();
  });

  syncControls();
  let off = null;
  return {
    setActive(on) {
      if (on && !off) off = engine.on('note', onNote);
      if (!on && off) {
        off();
        off = null;
        if (game) stop('user');
      }
      if (on) requestAnimationFrame(() => loop.redraw());
    },
    /** Для проверок. */
    get state() {
      return game && { drops: game.drops.map((d) => ({ s: d.s, f: d.f, midi: d.midi, p: d.p })), hits: game.hits, ...{ score: hud.score, lives: hud.lives, combo: hud.combo, level: hud.level } };
    },
    get frames() {
      return loop.frames;
    },
  };
}
