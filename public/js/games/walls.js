// Игра «Chord Wall»: на тебя едут стены, на каждой — аккорд. Сыграй его, пока стена не дошла до
// черты, — она рассыпается. Аккорды узнаются так же, как в упражнении «Chords» (по спектру, ~0,3 с),
// поэтому стены едут неспешно и по одной впереди. Без гитары: щёлкни по стене — приложение сыграет
// аккорд и само его услышит.
import { CHORDS, chordById, chordMidis } from '../music.js';
import { chordTemplate, rankChords } from '../chroma.js';
import { createShell, createLoop, createFx, COLORS } from './shell.js';

const MATCH_SCORE = 0.78;
const MATCH_FRAMES = 4;
const LINE_X = 86; // черта, до которой стена не должна доехать
const WALL_W = 132;
const CHORD_COLORS = ['#6a6cf0', '#9c7bf6', '#22c08a', '#38bdf8', '#f2a31b', '#f0565b'];

export function createWalls(root, { engine, store }) {
  const cfg = Object.assign({ set: ['Em', 'Am', 'C', 'G', 'D'], shapes: true }, store.get('games.walls.cfg', {}));
  const templates = CHORDS.map((chord) => ({ chord, template: chordTemplate(chord) }));
  const shell = createShell(root, {
    id: 'walls',
    store,
    title: 'Chord Wall',
    how: 'Strum the chord before the wall reaches you',
    controls: `
      <div class="ctl"><span class="ctl-label">Chords</span>
        <div class="chips" data-ref="set">${CHORDS.map((c) => `<button class="chip" data-id="${c.id}">${c.id}</button>`).join('')}</div>
      </div>
      <div class="ctl ctl-row"><label class="switch"><input type="checkbox" data-ref="shapes"><span class="switch-ui"></span><span>Show shapes</span></label></div>`,
  });
  const { ref, hud } = shell;
  for (const n of root.querySelectorAll('.controls [data-ref]')) ref[n.dataset.ref] = n;
  ref.osub.textContent = 'Walls roll in from the right, each with a chord. Strum it across all its strings and let it ring — the front wall breaks. Three walls at the line and it’s over. No guitar? Click a wall to hear and play its chord.';

  function syncControls() {
    for (const b of ref.set.children) b.setAttribute('aria-pressed', cfg.set.includes(b.dataset.id));
    ref.shapes.checked = cfg.shapes;
  }
  ref.set.addEventListener('click', (e) => {
    const b = e.target.closest('.chip');
    if (!b) return;
    const id = b.dataset.id;
    if (cfg.set.includes(id)) {
      if (cfg.set.length > 2) cfg.set = cfg.set.filter((x) => x !== id);
    } else cfg.set.push(id);
    store.set('games.walls.cfg', cfg);
    syncControls();
  });
  ref.shapes.addEventListener('change', () => {
    cfg.shapes = ref.shapes.checked;
    store.set('games.walls.cfg', cfg);
    loop.redraw();
  });

  // ---------- игра ----------
  let game = null; // { walls, broken, streak, onset, lastHitId, heard, spawnX }
  const fx = createFx();
  const speed = () => 70 + 7 * (hud.level - 1); // пикселей в секунду

  function pickChord() {
    const prev = game.walls.at(-1)?.chord.id ?? game.lastHitId;
    const pool = cfg.set.filter((id) => id !== prev);
    return chordById(pool[Math.floor(Math.random() * pool.length)] || cfg.set[0]);
  }

  function start() {
    engine.ensure();
    game = { walls: [], broken: 0, streak: 0, onset: false, lastHitId: null, heard: null, color: 0 };
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
      shell.overlay('Game over', `Score ${hud.score.toLocaleString('en-US')}`, `${g.broken} ${g.broken === 1 ? 'wall' : 'walls'} broken · level ${hud.level}${record ? ' · New record!' : ''}`);
    } else shell.overlay('Chord Wall', 'Strum the chord before the wall reaches you', 'Stopped. Press Start (or Space) to play again.');
    loop.redraw();
  }
  ref.start.addEventListener('click', () => (game ? stop('user') : start()));

  function update(dt) {
    fx.update(dt);
    if (!game) return;
    const { w } = loop.size;
    const spacing = Math.max(250, 380 - 12 * (hud.level - 1));
    const last = game.walls.at(-1);
    if (game.walls.length < 3 && (!last || last.x < w - spacing)) {
      game.walls.push({ x: w + 10, chord: pickChord(), color: CHORD_COLORS[game.color++ % CHORD_COLORS.length], shake: 0 });
    }
    for (const wl of game.walls) {
      wl.x -= speed() * dt;
      wl.shake = Math.max(0, wl.shake - dt);
    }
    const front = game.walls[0];
    if (front && front.x <= LINE_X) {
      game.walls.shift();
      fx.burst(LINE_X, loop.size.h / 2, COLORS.bad, 26);
      hud.set({ lives: hud.lives - 1, combo: 0 });
      shell.toast(`The ${front.chord.id} wall got through`, 'bad');
      game.streak = 0;
      game.onset = false;
      if (hud.lives <= 0) stop('over');
    }
  }

  function onFrame(frame) {
    if (!game) return;
    if (!frame.active) {
      game.streak = 0;
      game.heard = null;
      return;
    }
    const res = engine.chroma();
    if (!res || res.peakDb < -78) return;
    const top = rankChords(res.chroma, templates)[0];
    game.heard = top.score >= 0.7 ? top.chord.id : null;
    const front = game.walls[0];
    if (!front) return;
    if (top.chord.id === front.chord.id && top.score >= MATCH_SCORE) game.streak++;
    else game.streak = 0;
    // тот же аккорд, что и на прошлой стене, засчитываем только после нового удара по струнам
    if (game.streak >= MATCH_FRAMES && (front.chord.id !== game.lastHitId || game.onset)) breakWall(front);
  }

  function breakWall(wl) {
    game.walls.shift();
    game.broken++;
    game.lastHitId = wl.chord.id;
    game.streak = 0;
    game.onset = false;
    const combo = hud.combo + 1;
    const mult = Math.min(4, 1 + Math.floor(combo / 4));
    const { h } = loop.size;
    const distance = Math.max(0, Math.min(1, (wl.x - LINE_X) / (loop.size.w - LINE_X)));
    const pts = 100 * mult + Math.round(distance * 100);
    const level = 1 + Math.floor(game.broken / 5);
    if (level > hud.level) shell.toast(`Level ${level}`, 'good');
    hud.set({ score: hud.score + pts, combo, level });
    const cx = wl.x + WALL_W / 2;
    for (let i = 0; i < 4; i++) fx.burst(cx, h * (0.25 + i * 0.17), wl.color, 12);
    fx.text(cx, h * 0.2, `+${pts}`, COLORS.ink);
  }

  // ---------- отрисовка ----------
  function drawShape(ctx, chord, x, y) {
    const sw = 11, fh = 13, n = 4;
    ctx.strokeStyle = 'rgba(17,18,24,0.55)';
    ctx.lineWidth = 1.2;
    for (let s = 0; s < 6; s++) {
      ctx.beginPath();
      ctx.moveTo(x + s * sw, y);
      ctx.lineTo(x + s * sw, y + n * fh);
      ctx.stroke();
    }
    for (let f = 0; f <= n; f++) {
      ctx.lineWidth = f === 0 ? 3 : 1.2;
      ctx.beginPath();
      ctx.moveTo(x, y + f * fh);
      ctx.lineTo(x + 5 * sw, y + f * fh);
      ctx.stroke();
    }
    ctx.font = '700 9px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'center';
    chord.frets.forEach((f, s) => {
      const sx = x + s * sw;
      if (f < 0) {
        ctx.fillStyle = 'rgba(17,18,24,0.7)';
        ctx.fillText('×', sx, y - 4);
      } else if (f === 0) {
        ctx.strokeStyle = 'rgba(17,18,24,0.7)';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(sx, y - 7, 3, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        ctx.fillStyle = '#111218';
        ctx.beginPath();
        ctx.arc(sx, y + (f - 0.5) * fh, 4.3, 0, Math.PI * 2);
        ctx.fill();
      }
    });
  }

  function draw(ctx, w, h) {
    ctx.clearRect(0, 0, w, h);
    // черта обороны
    ctx.fillStyle = 'rgba(240,86,91,0.08)';
    ctx.fillRect(0, 0, LINE_X, h);
    ctx.strokeStyle = 'rgba(240,86,91,0.6)';
    ctx.setLineDash([8, 8]);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(LINE_X, 14);
    ctx.lineTo(LINE_X, h - 14);
    ctx.stroke();
    ctx.setLineDash([]);
    // пол
    ctx.fillStyle = 'rgba(255,255,255,0.03)';
    ctx.fillRect(0, h - 30, w, 30);

    if (game) {
      const top = 34, bottom = h - 44;
      game.walls.forEach((wl, i) => {
        const front = i === 0;
        const x = wl.x;
        ctx.globalAlpha = front ? 1 : 0.55;
        // кирпичная кладка
        const grad = ctx.createLinearGradient(x, top, x + WALL_W, bottom);
        grad.addColorStop(0, wl.color);
        grad.addColorStop(1, '#2a2b36');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.roundRect(x, top, WALL_W, bottom - top, 10);
        ctx.fill();
        ctx.strokeStyle = 'rgba(17,18,24,0.25)';
        ctx.lineWidth = 1;
        for (let y = top + 22, row = 0; y < bottom; y += 22, row++) {
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x + WALL_W, y);
          ctx.stroke();
          for (let bx = x + (row % 2 ? 22 : 44); bx < x + WALL_W; bx += 44) {
            ctx.beginPath();
            ctx.moveTo(bx, y);
            ctx.lineTo(bx, y + 22);
            ctx.stroke();
          }
        }
        if (front) {
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 2.5;
          ctx.beginPath();
          ctx.roundRect(x - 2, top - 2, WALL_W + 4, bottom - top + 4, 12);
          ctx.stroke();
        }
        // табличка с аккордом
        const cy = top + (bottom - top) * 0.32;
        ctx.fillStyle = 'rgba(255,255,255,0.92)';
        ctx.beginPath();
        ctx.roundRect(x + 14, cy - 34, WALL_W - 28, cfg.shapes ? 150 : 58, 10);
        ctx.fill();
        ctx.fillStyle = '#111218';
        ctx.textAlign = 'center';
        ctx.font = '750 30px "Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif';
        ctx.fillText(wl.chord.id, x + WALL_W / 2, cy + 6);
        if (cfg.shapes) drawShape(ctx, wl.chord, x + WALL_W / 2 - 27.5, cy + 34);
        ctx.globalAlpha = 1;
      });
      // что слышно сейчас
      ctx.textAlign = 'left';
      ctx.font = '600 13px "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif';
      ctx.fillStyle = COLORS.ink3;
      ctx.fillText('hearing', LINE_X + 14, h - 12);
      ctx.fillStyle = game.heard ? COLORS.accent2 : COLORS.ink3;
      ctx.font = '700 15px "Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif';
      ctx.fillText(game.heard || '—', LINE_X + 70, h - 12);
    }
    fx.draw(ctx);
  }

  const loop = createLoop(shell.canvas, { update, draw });

  // без гитары: щелчок по стене — сыграть её аккорд (анализатор его услышит)
  shell.canvas.addEventListener('pointerdown', (e) => {
    if (!game) return;
    const r = shell.canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const wl = game.walls.find((wl) => x >= wl.x && x <= wl.x + WALL_W);
    if (wl) engine.strum(chordMidis(wl.chord));
  });

  syncControls();
  let offs = [];
  return {
    setActive(on) {
      if (on) engine.setChromaEnabled?.(true); // спектр для аккордов считаем, только пока открыта эта игра
      if (on && !offs.length) offs = [engine.on('frame', onFrame), engine.on('onset', () => game && (game.onset = true))];
      if (!on && offs.length) {
        engine.setChromaEnabled?.(false);
        offs.forEach((f) => f());
        offs = [];
        if (game) stop('user');
      }
      if (on) requestAnimationFrame(() => loop.redraw());
    },
    /** Для проверок. */
    get state() {
      return game && { walls: game.walls.map((w) => ({ x: w.x, chord: w.chord.id })), broken: game.broken, score: hud.score, lives: hud.lives, level: hud.level, heard: game.heard };
    },
    get frames() {
      return loop.frames;
    },
  };
}
