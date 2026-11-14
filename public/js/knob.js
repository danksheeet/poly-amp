// Ручка-крутилка: тянешь вверх/вниз, колёсико, стрелки, двойной щелчок — сброс.
const NS = 'http://www.w3.org/2000/svg';
const START = -135;
const SWEEP = 270;

function polar(r, deg) {
  const a = ((deg - 90) * Math.PI) / 180;
  return [32 + r * Math.cos(a), 32 + r * Math.sin(a)];
}

function arc(r, from, to) {
  const [x0, y0] = polar(r, from);
  const [x1, y1] = polar(r, to);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 ${to - from > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

/**
 * @param {{label:string, min:number, max:number, value:number, def:number,
 *          fmt?:(v:number)=>string, size?:number, onChange:(v:number)=>void}} o
 */
export function createKnob(o) {
  const { min, max, def, fmt = (v) => v.toFixed(2), size = 64 } = o;
  let value = o.value;

  const el = document.createElement('div');
  el.className = 'knob';
  el.tabIndex = 0;
  el.setAttribute('role', 'slider');
  el.setAttribute('aria-label', o.label);
  el.setAttribute('aria-valuemin', min);
  el.setAttribute('aria-valuemax', max);
  el.innerHTML = `
    <svg viewBox="0 0 64 64" width="${size}" height="${size}" aria-hidden="true">
      <path class="knob-track" d="${arc(28, START, START + SWEEP)}"/>
      <path class="knob-arc"/>
      <circle class="knob-cap" cx="32" cy="32" r="20.5"/>
      <circle class="knob-face" cx="32" cy="32" r="17"/>
      <line class="knob-pointer" x1="32" y1="17" x2="32" y2="25"/>
    </svg>
    <div class="knob-label"></div>
    <div class="knob-value"></div>`;
  const labelEl = el.querySelector('.knob-label');
  labelEl.textContent = o.label;
  /** Сменить подпись (та же ручка может называться Input или Gain — смотря что стоит в гнезде). */
  function setLabel(text) {
    labelEl.textContent = text;
    el.setAttribute('aria-label', text);
  }
  const arcEl = el.querySelector('.knob-arc');
  const pointer = el.querySelector('.knob-pointer');
  const valueEl = el.querySelector('.knob-value');

  function render() {
    const t = (value - min) / (max - min);
    const deg = START + SWEEP * t;
    arcEl.setAttribute('d', t > 0.002 ? arc(28, START, deg) : '');
    pointer.setAttribute('transform', `rotate(${deg.toFixed(1)} 32 32)`);
    const text = fmt(value);
    valueEl.textContent = text;
    el.setAttribute('aria-valuenow', value);
    el.setAttribute('aria-valuetext', text);
  }

  function set(v, silent) {
    v = Math.max(min, Math.min(max, v));
    if (v === value) return;
    value = v;
    render();
    if (!silent) o.onChange(v);
  }

  let drag = null;
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    drag = { y: e.clientY, v: value };
    el.setPointerCapture(e.pointerId);
    el.classList.add('is-drag');
    e.preventDefault();
    el.focus();
  });
  el.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const range = e.shiftKey ? 900 : 190; // с Shift — точная подстройка
    set(drag.v + ((drag.y - e.clientY) / range) * (max - min));
  });
  const end = () => {
    drag = null;
    el.classList.remove('is-drag');
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('dblclick', () => set(def));
  el.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      set(value + (e.deltaY < 0 ? 1 : -1) * (max - min) * (e.shiftKey ? 0.005 : 0.02));
    },
    { passive: false }
  );
  el.addEventListener('keydown', (e) => {
    const step = (max - min) * (e.shiftKey ? 0.005 : 0.02);
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') set(value + step);
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') set(value - step);
    else if (e.key === 'Home') set(min);
    else if (e.key === 'End') set(max);
    else return;
    e.preventDefault();
  });

  render();
  return { el, set, setLabel, get: () => value };
}
