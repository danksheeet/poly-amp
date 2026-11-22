// Канал, как дорожка в микшере DAW: вход, слоты-инсерты (цепочка сверху вниз) и выход.
// В слот перетаскивают эффект или тон из браузера; слоты меняют местами перетаскиванием;
// лампочка включает и выключает блок; клик по пустому слоту открывает меню добавления.
import { BLOCKS, ADD_MENU, iconSvg } from '../blocks.js';
import { describeBlock } from './info.js';
import { DRAG_TYPE } from './browser.js';

const MOVE_TYPE = 'application/x-polyamp-slot';
const MIN_ROWS = 10; // пустые слоты дорисовываются до десяти, как в микшере; длинная цепочка просто прокручивается
const db = (v) => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(1) + ' dB';

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

export function createSlots(host, { chain, engine, getSelected, onSelect, onAdd }) {
  host.classList.add('pb-channel');
  host.innerHTML = `
    <div class="ch-head"><span class="ch-led"></span><div><b>Guitar</b><small data-ref="src">insert slots · drag effects here</small></div></div>
    <button class="ch-io" data-cap="in" title="Input: guitar level before the chain"><span class="ch-io-l">IN</span><span class="ch-vu"><i></i></span><span class="ch-io-v" data-ref="inV"></span></button>
    <div class="ch-slots" data-ref="list" role="list" aria-label="Insert slots"></div>
    <button class="ch-io" data-cap="out" title="Output: guitar level after the chain"><span class="ch-io-l">OUT</span><span class="ch-vu"><i></i></span><span class="ch-io-v" data-ref="outV"></span></button>
    <div class="add-menu" data-ref="menu" role="menu" hidden></div>`;
  const ref = {};
  for (const n of host.querySelectorAll('[data-ref]')) ref[n.dataset.ref] = n;
  const ioIn = host.querySelector('[data-cap="in"]');
  const ioOut = host.querySelector('[data-cap="out"]');
  ioIn.addEventListener('click', () => onSelect('in'));
  ioOut.addEventListener('click', () => onSelect('out'));
  const line = el('i', 'ch-drop');

  // ---------- меню «добавить» по клику на пустой слот ----------
  let insertAt = 0;
  for (const g of ADD_MENU) {
    ref.menu.append(el('div', 'add-group', g.title));
    const grid = el('div', 'add-grid');
    for (const type of g.types) {
      const d = BLOCKS[type];
      const b = el('button', 'add-item');
      b.setAttribute('role', 'menuitem');
      b.style.setProperty('--c', d.color);
      const ic = el('span', 'add-icon');
      ic.innerHTML = iconSvg(d.icon);
      const txt = el('span', 'add-text');
      txt.append(el('b', '', d.name), el('small', '', d.role));
      b.append(ic, txt);
      b.addEventListener('click', () => {
        closeMenu();
        onAdd({ type }, insertAt);
      });
      grid.append(b);
    }
    ref.menu.append(grid);
  }
  function openMenu(anchor, at) {
    insertAt = at;
    ref.menu.hidden = false;
    const hb = host.getBoundingClientRect();
    const ab = anchor.getBoundingClientRect();
    const top = Math.min(ab.bottom - hb.top + 6, hb.height - ref.menu.offsetHeight - 8);
    ref.menu.style.top = Math.max(8, top) + 'px';
    ref.menu.querySelector('button')?.focus();
  }
  function closeMenu() {
    ref.menu.hidden = true;
  }
  document.addEventListener('pointerdown', (e) => {
    if (!ref.menu.hidden && !ref.menu.contains(e.target) && !e.target.closest('.slot.is-free')) closeMenu();
  });
  document.addEventListener('keydown', (e) => e.key === 'Escape' && !ref.menu.hidden && closeMenu());

  // ---------- слоты ----------
  function slot(b, i) {
    const d = BLOCKS[b.type];
    const info = describeBlock(b, engine);
    const s = el('div', 'slot is-' + info.state);
    s.dataset.id = b.id;
    s.setAttribute('role', 'listitem');
    s.tabIndex = 0;
    s.draggable = true;
    s.style.setProperty('--c', d.color);
    s.classList.toggle('is-off', !b.on);
    s.title = `${info.title} — ${info.sub}`;
    const led = el('button', 'slot-led');
    led.setAttribute('aria-pressed', b.on);
    led.setAttribute('aria-label', (b.on ? 'Turn off: ' : 'Turn on: ') + info.title);
    led.title = b.on ? 'Turn the block off' : 'Turn the block on';
    led.addEventListener('click', (e) => {
      e.stopPropagation();
      chain.setOn(b.id, !b.on, 'ui');
    });
    const ic = el('span', 'slot-ic');
    ic.innerHTML = iconSvg(d.icon);
    const txt = el('span', 'slot-txt');
    txt.append(el('b', '', info.title), el('small', '', d.file ? d.name.toLowerCase() + (info.state === 'ok' ? '' : ' · ' + info.sub) : d.role));
    s.append(el('span', 'slot-no', String(i + 1)), led, ic, txt);
    if (d.group === 't3k') s.append(el('span', 'slot-tag', 'T3K'));
    if (info.state === 'standin' || info.state === 'pending' || info.state === 'empty' || info.state === 'error') {
      s.append(el('span', 'slot-badge ' + (info.state === 'error' ? 'bad' : 'warn'), info.state === 'standin' ? 'stand-in' : info.state === 'pending' ? 'download' : info.state));
    }
    s.append(el('span', 'slot-grip', '⠿'));
    s.addEventListener('click', () => onSelect(b.id));
    s.addEventListener('keydown', (e) => {
      if (e.target !== s) return;
      if (e.key === 'Enter') onSelect(b.id);
      if ((e.key === 'Delete' || e.key === 'Backspace') && getSelected() === b.id) chain.remove(b.id);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const sib = e.key === 'ArrowDown' ? s.nextElementSibling : s.previousElementSibling;
        if (sib?.dataset.id) {
          sib.focus();
          onSelect(sib.dataset.id);
        }
      }
    });
    return s;
  }

  function empty(at, n) {
    const s = el('button', 'slot is-free');
    s.append(el('span', 'slot-no', String(n)), el('span', 'slot-plus', '+'), el('span', 'slot-txt', at === n - 1 ? 'Add effect or tone' : ''));
    s.title = 'Add a block here';
    s.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!ref.menu.hidden && insertAt === at) return closeMenu();
      openMenu(s, at);
    });
    return s;
  }

  function render() {
    const focusedId = document.activeElement?.closest?.('.slot')?.dataset.id;
    const blocks = chain.blocks();
    const nodes = blocks.map(slot);
    const rows = Math.max(MIN_ROWS, blocks.length + 1);
    for (let n = blocks.length + 1; n <= rows; n++) nodes.push(empty(blocks.length, n));
    ref.list.replaceChildren(...nodes, line);
    highlight();
    updateIO();
    if (focusedId) ref.list.querySelector(`.slot[data-id="${focusedId}"]`)?.focus();
  }

  function highlight() {
    const sel = getSelected();
    for (const n of ref.list.querySelectorAll('.slot[data-id]')) {
      const on = n.dataset.id === sel;
      n.classList.toggle('is-selected', on);
      n.setAttribute('aria-current', on ? 'true' : 'false');
    }
    ioIn.classList.toggle('is-selected', sel === 'in');
    ioOut.classList.toggle('is-selected', sel === 'out');
    const t = ref.list.querySelector('.slot.is-selected');
    if (t) {
      const top = t.offsetTop - 6;
      const bottom = t.offsetTop + t.offsetHeight + 6;
      if (top < ref.list.scrollTop) ref.list.scrollTop = top;
      else if (bottom > ref.list.scrollTop + ref.list.clientHeight) ref.list.scrollTop = bottom - ref.list.clientHeight;
    }
  }

  function updateIO() {
    ref.inV.textContent = db(chain.global('in.gain'));
    const muted = chain.global('out.mute') > 0.5;
    ref.outV.textContent = muted ? 'Muted' : db(chain.global('out.level'));
    ioOut.classList.toggle('is-muted', muted);
  }

  // ---------- перетаскивание: слоты между собой и эффекты из браузера ----------
  let dragId = null;
  let dropAt = -1;
  ref.list.addEventListener('dragstart', (e) => {
    const s = e.target.closest?.('.slot[data-id]');
    if (!s) return;
    dragId = s.dataset.id;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData(MOVE_TYPE, dragId);
    requestAnimationFrame(() => s.classList.add('is-drag'));
    closeMenu();
  });
  ref.list.addEventListener('dragover', (e) => {
    const types = [...e.dataTransfer.types];
    const adding = types.includes(DRAG_TYPE);
    if (!adding && !(dragId && types.includes(MOVE_TYPE))) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = adding ? 'copy' : 'move';
    // место считаем среди остальных слотов — это номер после того, как блок уберут со старого места
    const others = [...ref.list.querySelectorAll('.slot[data-id]')].filter((s) => s.dataset.id !== dragId);
    let at = others.length;
    for (let i = 0; i < others.length; i++) {
      const r = others[i].getBoundingClientRect();
      if (e.clientY < r.top + r.height / 2) {
        at = i;
        break;
      }
    }
    dropAt = at;
    const refEl = others[at];
    const y = refEl ? refEl.offsetTop - 3 : others.length ? others.at(-1).offsetTop + others.at(-1).offsetHeight + 2 : 4;
    line.style.top = y + 'px';
    line.classList.add('is-on');
  });
  ref.list.addEventListener('dragleave', (e) => {
    if (!ref.list.contains(e.relatedTarget)) line.classList.remove('is-on');
  });
  ref.list.addEventListener('drop', (e) => {
    line.classList.remove('is-on');
    const add = e.dataTransfer.getData(DRAG_TYPE);
    if (add) {
      e.preventDefault();
      try {
        onAdd(JSON.parse(add), dropAt >= 0 ? dropAt : chain.blocks().length);
      } catch {}
      return;
    }
    if (!dragId) return;
    e.preventDefault();
    const id = dragId;
    dragId = null;
    if (dropAt >= 0) chain.move(id, dropAt);
    render();
  });
  ref.list.addEventListener('dragend', () => {
    dragId = null;
    line.classList.remove('is-on');
    for (const s of ref.list.querySelectorAll('.is-drag')) s.classList.remove('is-drag');
  });

  // ---------- индикаторы входа и выхода ----------
  const toBar = (pk) => Math.max(0, Math.min(1, (20 * Math.log10(pk + 1e-6) + 54) / 54));
  const inBar = ioIn.querySelector('.ch-vu i');
  const outBar = ioOut.querySelector('.ch-vu i');
  function setMeters(inPk, outPk) {
    inBar.style.transform = `scaleX(${toBar(inPk).toFixed(3)})`;
    outBar.style.transform = `scaleX(${toBar(outPk).toFixed(3)})`;
    inBar.classList.toggle('clip', inPk > 0.97);
    outBar.classList.toggle('clip', outPk > 0.97);
  }

  render();
  return { render, highlight, setMeters, updateIO, closeMenu };
}
