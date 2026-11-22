// Игра «Glide»: планер летит сквозь ворота, высоту задаёт громкость гитары. Играешь громче — он
// поднимается, тише — опускается, тишина — снижается к земле. Учит управлять силой удара и сустейном.
// Диапазон громкости подстраивается под твой вход: перед стартом — один сильный удар по струнам.
// Без гитары: держи кнопку мыши на сцене — планер поднимается.
import { createShell, createLoop, createFx, COLORS } from './shell.js';

const LEVELS = {
  easy: { speed: 120, gap: 0.46, minGap: 0.32, spacing: 360 },
  normal: { speed: 150, gap: 0.4, minGap: 0.27, spacing: 330 },
  hard: { speed: 185, gap: 0.34, minGap: 0.22, spacing: 300 },
};
const PILLAR = 56;
const GLIDER_X = 0.22;
const CAL_TIME = 3;

export function createGlide(root, { engine, store }) {
  const cfg = Object.assign({ difficulty: 'normal' }, store.get('games.glide.cfg', {}));
  const shell = createShell(root, {
    id: 'glide',
    store,
    title: 'Glide',
    how: 'Fly through the gates with your volume',
    controls: `
      <div class="ctl"><span class="ctl-label">Difficulty</span>
        <div class="seg" data-ref="diff"><button data-v="easy">Easy</button><button data-v="normal">Normal</button><button data-v="hard">Hard</button></div>
      </div>
      <p class="hint game-hint">Play louder to climb, softer to sink, let it ring to hold the height. No guitar? Hold the mouse button on the stage.</p>`,
  });
  const { ref, hud } = shell;
  for (const n of root.querySelectorAll('.controls [data-ref]')) ref[n.dataset.ref] = n;
  ref.osub.textContent = 'The glider’s height is how loud you play. Strum or pick harder to climb, softer to dive, sustain a note to hold steady. Before the start, strum hard once so the game learns your range.';

  function syncControls() {
    for (const b of ref.diff.children) b.setAttribute('aria-pressed', b.dataset.v === cfg.difficulty);
  }
  ref.diff.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    cfg.difficulty = b.dataset.v;
    store.set('games.glide.cfg', cfg);
    syncControls();
  });

  // ---------- громкость входа → высота ----------
  const vol = { level: 0, gateLv: 0.2, peak: 0.6, active: false, manual: 0 };
  const lvOf = (rms) => Math.max(0, Math.min(1, (20 * Math.log10(Math.max(rms, 1e-6)) + 60) / 54));
  function onFrame(f) {
    vol.level = f.level || 0;
    vol.active = !!f.active;
    if (f.gate) vol.gateLv = lvOf(f.gate);
    if (vol.active && game) {
      if (game.phase === 'cal') vol.peak = Math.max(vol.peak, vol.level);
      // диапазон медленно подстраивается: громче прежнего — сразу, тише — потихоньку, не меньше 0,22
      else vol.peak = Math.max(vol.level, vol.peak - 0.002, vol.gateLv + 0.22);
    }
  }
  /** Желаемая высота 0…1 (0 — земля). */
  function wanted() {
    const range = Math.max(0.15, vol.peak - vol.gateLv);
    const fromGuitar = vol.active ? Math.max(0, Math.min(1, (vol.level - vol.gateLv) / range)) : 0;
    return Math.max(fromGuitar, vol.manual);
  }

  // ---------- игра ----------
  let game = null; // { phase: 'cal'|'fly', t, alt, gates, passed, hurt, trail }
  const fx = createFx();
  const L = () => LEVELS[cfg.difficulty] || LEVELS.normal;

  function start() {
    engine.ensure();
    vol.peak = vol.gateLv + 0.25;
    game = { phase: 'cal', t: 0, alt: 0, gates: [], passed: 0, hurt: 0, trail: [] };
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
      shell.overlay('Game over', `Score ${hud.score.toLocaleString('en-US')}`, `${g.passed} ${g.passed === 1 ? 'gate' : 'gates'} · level ${hud.level}${record ? ' · New record!' : ''}`);
    } else shell.overlay('Glide', 'Fly through the gates with your volume', 'Stopped. Press Start (or Space) to fly again.');
    loop.redraw();
  }
  ref.start.addEventListener('click', () => (game ? stop('user') : start()));

  function addGate(x) {
    const lv = L();
    const gap = Math.max(lv.minGap, lv.gap - 0.015 * (hud.level - 1));
    const prev = game.gates.at(-1);
    // соседние ворота не прыгают слишком резко: громкость не поменяешь мгновенно
    const base = prev ? prev.center : 0.45;
    const center = Math.max(gap / 2 + 0.04, Math.min(1 - gap / 2 - 0.04, base + (Math.random() - 0.5) * 0.55));
    game.gates.push({ x, center, gap, passed: false });
  }

  function update(dt) {
    fx.update(dt);
    if (!game) return;
    const { w, h } = loop.size;
    game.t += dt;
    const target = wanted();
    game.alt += (target - game.alt) * Math.min(1, dt * 5);
    if (game.phase === 'cal') {
      if (game.t >= CAL_TIME) {
        game.phase = 'fly';
        game.t = 0;
        if (vol.peak < vol.gateLv + 0.25) vol.peak = vol.gateLv + 0.25;
        addGate(w + 40);
      }
      return;
    }
    const lv = L();
    const speed = lv.speed + 10 * (hud.level - 1);
    for (const g of game.gates) g.x -= speed * dt;
    while (game.gates.length && game.gates[0].x < -PILLAR) game.gates.shift();
    const last = game.gates.at(-1);
    if (!last || last.x < w - lv.spacing) addGate(w + 20);
    game.hurt = Math.max(0, game.hurt - dt);
    game.trail.push({ x: GLIDER_X * w, y: altY(game.alt, h) });
    if (game.trail.length > 40) game.trail.shift();
    for (const p of game.trail) p.x -= speed * dt;

    const gx = GLIDER_X * w;
    const gy = altY(game.alt, h);
    for (const g of game.gates) {
      const inside = gx + 12 > g.x && gx - 12 < g.x + PILLAR;
      if (inside && game.hurt <= 0) {
        const top = altY(g.center + g.gap / 2, h);
        const bottom = altY(g.center - g.gap / 2, h);
        if (gy - 9 < top || gy + 9 > bottom) {
          game.hurt = 1.4;
          fx.burst(gx, gy, COLORS.bad, 20);
          hud.set({ lives: hud.lives - 1, combo: 0 });
          shell.toast(gy < top ? 'Too loud!' : 'Too quiet!', 'bad');
          if (hud.lives <= 0) return stop('over');
        }
      }
      if (!g.passed && g.x + PILLAR < gx - 12) {
        g.passed = true;
        game.passed++;
        const combo = hud.combo + 1;
        const pts = 100 * Math.min(4, 1 + Math.floor(combo / 4));
        const level = 1 + Math.floor(game.passed / 6);
        if (level > hud.level) shell.toast(`Level ${level}`, 'good');
        hud.set({ score: hud.score + pts, combo, level });
        fx.text(gx, gy - 24, `+${pts}`, COLORS.ink);
      }
    }
  }

  // ---------- отрисовка ----------
  const MARGIN_TOP = 24, MARGIN_BOTTOM = 34;
  function altY(a, h) {
    return h - MARGIN_BOTTOM - a * (h - MARGIN_TOP - MARGIN_BOTTOM);
  }

  function draw(ctx, w, h) {
    ctx.clearRect(0, 0, w, h);
    // земля и дальние холмы
    ctx.fillStyle = 'rgba(255,255,255,0.025)';
    for (let i = 0; i < 6; i++) {
      const x = ((i * 260 - (performance.now() / 40) % 260) + w) % (w + 260) - 130;
      ctx.beginPath();
      ctx.ellipse(x, h - MARGIN_BOTTOM + 10, 160, 46, 0, Math.PI, 0);
      ctx.fill();
    }
    ctx.fillStyle = '#1a1b22';
    ctx.fillRect(0, h - MARGIN_BOTTOM, w, MARGIN_BOTTOM);
    ctx.strokeStyle = COLORS.line2;
    ctx.beginPath();
    ctx.moveTo(0, h - MARGIN_BOTTOM + 0.5);
    ctx.lineTo(w, h - MARGIN_BOTTOM + 0.5);
    ctx.stroke();

    // ворота
    if (game) {
      for (const g of game.gates) {
        const top = altY(g.center + g.gap / 2, h);
        const bottom = altY(g.center - g.gap / 2, h);
        const grad = ctx.createLinearGradient(g.x, 0, g.x + PILLAR, 0);
        grad.addColorStop(0, '#4f51c9');
        grad.addColorStop(1, '#8a6ef0');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.roundRect(g.x, MARGIN_TOP - 40, PILLAR, top - MARGIN_TOP + 40, [0, 0, 12, 12]);
        ctx.fill();
        ctx.beginPath();
        ctx.roundRect(g.x, bottom, PILLAR, h - MARGIN_BOTTOM - bottom, [12, 12, 0, 0]);
        ctx.fill();
        ctx.fillStyle = g.passed ? 'rgba(34,192,138,0.6)' : 'rgba(255,255,255,0.35)';
        ctx.fillRect(g.x + 6, top - 4, PILLAR - 12, 3);
        ctx.fillRect(g.x + 6, bottom + 1, PILLAR - 12, 3);
      }
    }

    // шкала громкости слева: сейчас и куда тянет
    const meterTop = MARGIN_TOP, meterH = h - MARGIN_TOP - MARGIN_BOTTOM;
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.beginPath();
    ctx.roundRect(14, meterTop, 8, meterH, 4);
    ctx.fill();
    const want = wanted();
    ctx.fillStyle = vol.manual > 0 ? COLORS.ink2 : COLORS.good;
    ctx.beginPath();
    ctx.roundRect(14, meterTop + meterH * (1 - want), 8, meterH * want, 4);
    ctx.fill();

    // планер
    const alt = game ? game.alt : want * 0.6 + 0.2;
    const gx = GLIDER_X * w;
    const gy = altY(alt, h);
    if (game) {
      ctx.strokeStyle = 'rgba(156,123,246,0.35)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      game.trail.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.stroke();
    }
    const blink = game && game.hurt > 0 && Math.floor(game.hurt * 10) % 2 === 0;
    if (!blink) {
      const tilt = game ? Math.max(-0.5, Math.min(0.5, (game.alt - want) * 2.2)) : 0;
      ctx.save();
      ctx.translate(gx, gy);
      ctx.rotate(tilt);
      ctx.fillStyle = COLORS.ink;
      ctx.shadowColor = COLORS.accent2;
      ctx.shadowBlur = 16;
      ctx.beginPath();
      ctx.moveTo(22, 0);
      ctx.lineTo(-16, -11);
      ctx.lineTo(-9, 0);
      ctx.lineTo(-16, 11);
      ctx.closePath();
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = COLORS.accent2;
      ctx.beginPath();
      ctx.moveTo(4, 0);
      ctx.lineTo(-12, -6);
      ctx.lineTo(-8, 0);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    // разминка: подсказка и обратный отсчёт
    if (game && game.phase === 'cal') {
      const left = Math.ceil(CAL_TIME - game.t);
      ctx.textAlign = 'center';
      ctx.fillStyle = COLORS.ink;
      ctx.font = '650 30px "Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif';
      ctx.fillText(`Strum hard once · ${left}`, w / 2, h * 0.36);
      ctx.fillStyle = COLORS.ink2;
      ctx.font = '500 15px "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif';
      ctx.fillText('setting your loudest level — the top of the sky', w / 2, h * 0.36 + 28);
    }
    fx.draw(ctx);
  }

  const loop = createLoop(shell.canvas, { update, draw });

  // без гитары: держишь кнопку мыши — планер поднимается
  const up = () => (vol.manual = 0);
  shell.canvas.addEventListener('pointerdown', (e) => {
    vol.manual = 1;
    shell.canvas.setPointerCapture?.(e.pointerId);
  });
  shell.canvas.addEventListener('pointerup', up);
  shell.canvas.addEventListener('pointercancel', up);
  shell.canvas.addEventListener('lostpointercapture', up);

  syncControls();
  let off = null;
  return {
    setActive(on) {
      if (on && !off) off = engine.on('frame', onFrame);
      if (!on && off) {
        off();
        off = null;
        vol.manual = 0;
        if (game) stop('user');
      }
      if (on) requestAnimationFrame(() => loop.redraw());
    },
    /** Для проверок. */
    get state() {
      return game && { phase: game.phase, alt: game.alt, gates: game.gates.length, passed: game.passed, score: hud.score, lives: hud.lives, level: hud.level };
    },
    get frames() {
      return loop.frames;
    },
    /** Для проверок: «держать кнопку» без мыши. */
    hold(on) {
      vol.manual = on ? 1 : 0;
    },
  };
}
