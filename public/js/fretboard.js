// SVG-гриф: первая струна сверху (как в табулатуре), открытые струны слева от порожка.
import { NOTE_NAMES, TUNING } from './music.js';

const NS = 'http://www.w3.org/2000/svg';
const INLAYS = [3, 5, 7, 9, 15, 17];
const STRING_W = [3.2, 2.7, 2.2, 1.6, 1.3, 1.1];

function el(name, attrs, parent) {
  const n = document.createElementNS(NS, name);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(n);
  return n;
}

export class Fretboard {
  /**
   * @param {HTMLElement} host
   * @param {{frets?: number, onPick?: (s:number, f:number)=>void}} opts
   */
  constructor(host, { frets = 15, onPick = null } = {}) {
    this.frets = frets;
    this.fw = 62;
    this.x0 = 58;
    this.top = 24;
    this.gap = 27;
    this.W = this.x0 + frets * this.fw + 14;
    this.H = this.top + 5 * this.gap + 42;
    const { x0, top, gap, fw } = this;

    const svg = (this.svg = el('svg', {
      viewBox: `0 0 ${this.W} ${this.H}`,
      class: 'fretboard' + (onPick ? ' is-clickable' : ''),
      role: 'img',
      'aria-label': 'Guitar fretboard',

    }));
    svg.style.maxWidth = Math.round(this.W * 1.15) + 'px';

    el('rect', { x: x0, y: top - 13, width: frets * fw, height: 5 * gap + 26, rx: 3, class: 'fb-board' }, svg);

    const midY = top + 2.5 * gap;
    for (let f = 1; f <= frets; f++) {
      const cx = this.posX(f);
      if (INLAYS.includes(f)) el('circle', { cx, cy: midY, r: 6, class: 'fb-inlay' }, svg);
      if (f === 12) {
        el('circle', { cx, cy: top + 1.5 * gap, r: 6, class: 'fb-inlay' }, svg);
        el('circle', { cx, cy: top + 3.5 * gap, r: 6, class: 'fb-inlay' }, svg);
      }
    }
    for (let f = 1; f <= frets; f++) {
      const x = this.fretX(f);
      el('line', { x1: x, x2: x, y1: top - 13, y2: top + 5 * gap + 13, class: 'fb-fret' }, svg);
    }
    el('rect', { x: x0 - 6, y: top - 13, width: 6, height: 5 * gap + 26, rx: 1.5, class: 'fb-nut' }, svg);

    for (let s = 0; s < 6; s++) {
      const y = this.strY(s);
      el('line', { x1: x0 - 6, x2: this.W - 14, y1: y, y2: y, class: 'fb-string', 'stroke-width': STRING_W[s] }, svg);
      const label = el('text', { x: 4, y: y + 4, class: 'fb-open-label' }, svg);
      label.textContent = NOTE_NAMES[TUNING[s] % 12];
    }

    const numbered = frets <= 6 ? Array.from({ length: frets }, (_, i) => i + 1) : [1, 3, 5, 7, 9, 12, 15, 17];
    for (const f of numbered) {
      if (f > frets) continue;
      const t = el('text', { x: this.posX(f), y: this.H - 8, class: 'fb-num' }, svg);
      t.textContent = f;
    }

    this.layer = el('g', {}, svg);
    this.fx = el('g', {}, svg);
    host.appendChild(svg);

    if (onPick) {
      svg.addEventListener('click', (e) => {
        const pt = svg.createSVGPoint();
        pt.x = e.clientX;
        pt.y = e.clientY;
        const p = pt.matrixTransform(svg.getScreenCTM().inverse());
        const s = Math.max(0, Math.min(5, Math.round(5 - (p.y - top) / gap)));
        const f = p.x < x0 ? 0 : Math.max(1, Math.min(frets, Math.ceil((p.x - x0) / fw)));
        onPick(s, f);
      });
    }
  }

  fretX(f) {
    return this.x0 + f * this.fw;
  }

  posX(f) {
    return f === 0 ? this.x0 - 24 : this.fretX(f) - this.fw / 2;
  }

  strY(s) {
    return this.top + (5 - s) * this.gap;
  }

  /** @param {Array<{s:number,f:number,kind:string,label?:string}>} list */
  setMarkers(list) {
    this.layer.replaceChildren();
    for (const m of list) this.draw(m, this.layer);
  }

  /** Короткая вспышка на позиции (например, при клике). */
  flash(s, f, kind = 'pluck') {
    const g = this.draw({ s, f, kind }, this.fx);
    setTimeout(() => g.remove(), 450);
  }

  draw({ s, f, kind, label }, parent) {
    const g = el('g', { class: `mk mk-${kind}`, transform: `translate(${this.posX(f)} ${this.strY(s)})` }, parent);
    if (kind !== 'mute') el('circle', { r: 11 }, g);
    if (kind === 'mute' || label != null) {
      const t = el('text', { y: 4 }, g);
      t.textContent = kind === 'mute' ? '×' : label;
    }
    return g;
  }
}
