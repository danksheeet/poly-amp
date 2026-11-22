// Общий каркас мини-игр: настройки сверху, сцена-холст со счётом, комбо, жизнями и рекордом,
// кнопка «Start» (её же нажимает пробел), экран «как играть» и итог. Цикл отрисовки крутится,
// только пока игра идёт, и останавливается, когда вкладку закрыли.

/** Цвета темы для холста (те же, что в style.css). */
export const COLORS = {
  bg: '#14151c',
  panel: '#1b1c24',
  line: 'rgba(255, 255, 255, 0.08)',
  line2: 'rgba(255, 255, 255, 0.16)',
  ink: '#eceef5',
  ink2: '#a8abbb',
  ink3: '#747789',
  accent: '#6a6cf0',
  accent2: '#9c7bf6',
  good: '#22c08a',
  bad: '#f0565b',
  warn: '#f2a31b',
};

/** Цвет струны: от шестой к первой (как ряды табулатуры, только в цвете). */
export const STRING_COLORS = ['#f0565b', '#f2a31b', '#e8d44d', '#22c08a', '#38bdf8', '#9c7bf6'];

const HEART = '♥';

/**
 * @param {HTMLElement} root
 * @param {{ id: string, title: string, how: string, controls?: string, store: any, lives?: number }} opts
 */
export function createShell(root, { id, title, how, controls = '', store, lives = 3 }) {
  root.classList.add('game-view');
  root.innerHTML = `
    <div class="controls">${controls}</div>
    <div class="game">
      <div class="game-hud">
        <div class="hud"><b data-ref="score">0</b><small>score</small></div>
        <div class="hud"><b data-ref="combo">—</b><small>combo</small></div>
        <div class="hud"><b data-ref="level">—</b><small>level</small></div>
        <div class="hud hud-lives"><b data-ref="lives"></b><small>lives</small></div>
        <div class="hud"><b data-ref="best">—</b><small>best</small></div>
        <span class="hud-sp"></span>
        <button class="btn btn-primary" data-ref="start">Start</button>
      </div>
      <div class="game-stage">
        <canvas class="game-canvas" data-ref="canvas"></canvas>
        <div class="game-overlay" data-ref="overlay">
          <div class="go-kicker" data-ref="kicker">${title}</div>
          <div class="go-title" data-ref="otitle">${how}</div>
          <div class="go-sub" data-ref="osub"></div>
        </div>
        <div class="game-toast" data-ref="toast"></div>
      </div>
    </div>`;
  const ref = {};
  for (const n of root.querySelectorAll('[data-ref]')) ref[n.dataset.ref] = n;
  const bestKey = `games.${id}.best`;

  const hud = {
    score: 0,
    combo: 0,
    level: 1,
    lives,
    set(o) {
      Object.assign(hud, o);
      ref.score.textContent = hud.score.toLocaleString('en-US');
      ref.combo.textContent = hud.combo > 1 ? '×' + hud.combo : '—';
      ref.level.textContent = String(hud.level);
      ref.lives.textContent = HEART.repeat(Math.max(0, hud.lives)) + '♡'.repeat(Math.max(0, lives - hud.lives));
      ref.lives.classList.toggle('is-low', hud.lives <= 1);
    },
    reset() {
      hud.set({ score: 0, combo: 0, level: 1, lives });
    },
  };

  const best = {
    get: () => store.get(bestKey, 0),
    /** Записать результат; true — новый рекорд. */
    submit(score) {
      const record = score > best.get();
      if (record) store.set(bestKey, score);
      showBest();
      return record;
    },
  };
  function showBest() {
    const b = best.get();
    ref.best.textContent = b ? b.toLocaleString('en-US') : '—';
  }

  function overlay(kicker, titleText, sub = '') {
    ref.kicker.textContent = kicker;
    ref.otitle.textContent = titleText;
    ref.osub.textContent = sub;
    ref.overlay.hidden = false;
  }
  function hideOverlay() {
    ref.overlay.hidden = true;
  }
  let toastTimer = 0;
  function toast(text, kind = '') {
    ref.toast.textContent = text;
    ref.toast.className = 'game-toast is-on ' + kind;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (ref.toast.className = 'game-toast'), 1100);
  }
  function setRunning(on) {
    ref.start.textContent = on ? 'Stop' : 'Start';
    ref.start.classList.toggle('btn-primary', !on);
  }

  hud.reset();
  showBest();
  return { root, ref, hud, best, overlay, hideOverlay, toast, setRunning, canvas: ref.canvas };
}

/**
 * Холст с учётом плотности пикселей и цикл requestAnimationFrame по времени (dt в секундах, не больше 50 мс:
 * после свёрнутого окна игра не прыгает вперёд).
 * @param {HTMLCanvasElement} canvas
 * @param {{ update: (dt:number)=>void, draw: (ctx:CanvasRenderingContext2D, w:number, h:number)=>void }} game
 */
export function createLoop(canvas, { update, draw }) {
  const ctx = canvas.getContext('2d');
  let w = 0, h = 0, raf = 0, last = 0, running = false;
  let frames = 0;
  function resize() {
    const r = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    if (!r.width || !r.height) return;
    w = r.width;
    h = r.height;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw(ctx, w, h);
  }
  new ResizeObserver(resize).observe(canvas);
  function frame(t) {
    const dt = Math.min(0.05, Math.max(0, (t - last) / 1000));
    last = t;
    frames++;
    update(dt);
    draw(ctx, w, h);
    if (running) raf = requestAnimationFrame(frame);
  }
  return {
    start() {
      if (running) return;
      running = true;
      last = performance.now();
      raf = requestAnimationFrame(frame);
    },
    stop() {
      running = false;
      cancelAnimationFrame(raf);
    },
    redraw() {
      if (w && h) draw(ctx, w, h);
    },
    get running() {
      return running;
    },
    get frames() {
      return frames;
    },
    get size() {
      return { w, h };
    },
  };
}

/** Короткие частицы и всплывающие надписи — общие для игр. */
export function createFx() {
  const parts = [];
  const texts = [];
  return {
    burst(x, y, color, n = 18) {
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        const v = 60 + Math.random() * 180;
        parts.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 40, life: 0.5 + Math.random() * 0.4, t: 0, color, r: 2 + Math.random() * 2.5 });
      }
    },
    text(x, y, str, color) {
      texts.push({ x, y, str, color, t: 0, life: 0.9 });
    },
    update(dt) {
      for (const p of parts) {
        p.t += dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vy += 260 * dt;
      }
      for (const t of texts) {
        t.t += dt;
        t.y -= 40 * dt;
      }
      for (let i = parts.length - 1; i >= 0; i--) if (parts[i].t >= parts[i].life) parts.splice(i, 1);
      for (let i = texts.length - 1; i >= 0; i--) if (texts[i].t >= texts[i].life) texts.splice(i, 1);
    },
    draw(ctx) {
      for (const p of parts) {
        ctx.globalAlpha = Math.max(0, 1 - p.t / p.life);
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.textAlign = 'center';
      ctx.font = '700 18px "Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif';
      for (const t of texts) {
        ctx.globalAlpha = Math.max(0, 1 - t.t / t.life);
        ctx.fillStyle = t.color;
        ctx.fillText(t.str, t.x, t.y);
      }
      ctx.globalAlpha = 1;
    },
    clear() {
      parts.length = 0;
      texts.length = 0;
    },
  };
}

/** Скруглённый прямоугольник (путь). */
export function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}
