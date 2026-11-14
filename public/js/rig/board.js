// Доска: цепочка блоков слева направо — вход, плитки блоков, выход. Между плитками — «+» для
// вставки; плитки можно перетаскивать; огонёк на плитке включает и выключает блок.
import { BLOCKS, ADD_MENU, iconSvg } from '../blocks.js';
import { describeBlock } from './info.js';

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

export function createBoard(host, { chain, engine, getSelected, onSelect }) {
  host.classList.add('board');
  const strip = el('div', 'strip');
  strip.setAttribute('role', 'list');
  strip.setAttribute('aria-label', 'Block chain');
  const mark = el('div', 'drop-mark');
  const menu = el('div', 'add-menu');
  menu.hidden = true;
  menu.setAttribute('role', 'menu');
  host.append(strip, menu);

  let capIn = null;
  let capOut = null;

  // ---------- меню «добавить блок» ----------
  let insertAt = 0;
  function buildMenu() {
    menu.replaceChildren();
    for (const g of ADD_MENU) {
      menu.append(el('div', 'add-group', g.title));
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
          onSelect(chain.add(type, insertAt));
        });
        grid.append(b);
      }
      menu.append(grid);
    }
  }
  buildMenu();

  function openMenu(anchor, at) {
    insertAt = at;
    menu.hidden = false;
    const hb = host.getBoundingClientRect();
    const ab = anchor.getBoundingClientRect();
    const w = menu.offsetWidth;
    let left = ab.left + ab.width / 2 - hb.left - w / 2;
    left = Math.max(0, Math.min(hb.width - w, left));
    menu.style.left = left + 'px';
    menu.style.top = ab.bottom - hb.top + 10 + 'px';
    menu.querySelector('button')?.focus();
  }
  function closeMenu() {
    menu.hidden = true;
  }
  document.addEventListener('pointerdown', (e) => {
    if (!menu.hidden && !menu.contains(e.target) && !e.target.closest('.ins')) closeMenu();
  });
  document.addEventListener('keydown', (e) => e.key === 'Escape' && !menu.hidden && closeMenu());

  // ---------- плитки ----------
  function inserter(at) {
    const b = el('button', 'ins', '+');
    b.setAttribute('aria-label', 'Add a block here');
    b.title = 'Add block';
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!menu.hidden && insertAt === at) return closeMenu();
      openMenu(b, at);
    });
    return b;
  }

  function cap(kind) {
    const c = el('button', 'cap cap-' + kind);
    c.dataset.cap = kind;
    c.setAttribute('aria-label', kind === 'in' ? 'Input: guitar level' : 'Output: master level');
    const meter = el('span', 'cap-meter');
    meter.append(el('i'));
    c.append(el('span', 'cap-label', kind === 'in' ? 'IN' : 'OUT'), meter);
    c.addEventListener('click', () => onSelect(kind));
    return c;
  }

  function tile(b) {
    const d = BLOCKS[b.type];
    const info = describeBlock(b, engine);
    const t = el('div', 'tile is-' + info.state);
    t.dataset.id = b.id;
    t.setAttribute('role', 'listitem');
    t.tabIndex = 0;
    t.draggable = true;
    t.style.setProperty('--c', d.color);
    t.classList.toggle('is-off', !b.on);
    t.title = `${info.title} — ${info.sub}`;

    const art = el('div', 'tile-art');
    if (info.cover) {
      const img = el('img');
      img.src = info.cover;
      img.alt = '';
      img.draggable = false;
      img.addEventListener('error', () => {
        img.remove();
        art.classList.remove('has-image');
      });
      art.classList.add('has-image');
      art.append(img);
    }
    const ic = el('span', 'tile-icon');
    ic.innerHTML = iconSvg(d.icon);
    art.append(ic);

    const led = el('button', 'tile-led');
    led.setAttribute('aria-pressed', b.on);
    led.setAttribute('aria-label', (b.on ? 'Turn off: ' : 'Turn on: ') + info.title);
    led.title = b.on ? 'Turn the block off' : 'Turn the block on';
    led.addEventListener('click', (e) => {
      e.stopPropagation();
      chain.setOn(b.id, !b.on, 'ui');
    });

    const tag = el('div', 'tile-tag', d.tag);
    if (d.group === 't3k') tag.append(el('span', 'tile-t3k', 'T3K'));
    if (info.state === 'standin') tag.append(el('span', 'tile-badge', 'stand-in'));
    if (info.state === 'pending' || info.state === 'empty') tag.append(el('span', 'tile-badge warn', info.state === 'pending' ? 'download' : 'empty'));
    if (info.state === 'error') tag.append(el('span', 'tile-badge bad', 'error'));

    t.append(art, led, tag, el('div', 'tile-name', info.title), el('div', 'tile-sub', info.sub));
    t.addEventListener('click', () => onSelect(b.id));
    t.addEventListener('keydown', (e) => {
      if (e.target !== t) return;
      if (e.key === 'Enter') onSelect(b.id);
      if (e.key === ' ') {
        e.preventDefault();
        chain.setOn(b.id, !b.on, 'ui');
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && getSelected() === b.id) chain.remove(b.id);
    });
    return t;
  }

  function render() {
    const focusedId = document.activeElement?.closest?.('.tile')?.dataset.id;
    const blocks = chain.blocks();
    const nodes = [(capIn = cap('in'))];
    blocks.forEach((b, i) => nodes.push(inserter(i), tile(b)));
    nodes.push(inserter(blocks.length), (capOut = cap('out')), mark);
    if (!blocks.length) {
      const hint = el('div', 'strip-hint', 'The chain is empty — press “+” to add a pedal, amp or reverb');

      nodes.splice(2, 0, hint);
    }
    strip.replaceChildren(...nodes);
    highlight();
    if (focusedId) strip.querySelector(`.tile[data-id="${focusedId}"]`)?.focus();
  }

  function highlight() {
    const sel = getSelected();
    for (const n of strip.querySelectorAll('.tile, .cap')) {
      const on = n.dataset.id ? n.dataset.id === sel : n.dataset.cap === sel;
      n.classList.toggle('is-selected', on);
      n.setAttribute('aria-current', on ? 'true' : 'false');
    }
    const t = strip.querySelector('.is-selected');
    if (t) {
      // выбранная плитка должна быть видна, даже если цепочка длинная и прокручена
      const l = t.offsetLeft - 12;
      const r = t.offsetLeft + t.offsetWidth + 12;
      if (l < strip.scrollLeft) strip.scrollLeft = l;
      else if (r > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = r - strip.clientWidth;
    }
  }

  // ---------- перетаскивание ----------
  let dragId = null;
  let dropAt = -1;

  strip.addEventListener('dragstart', (e) => {
    const t = e.target.closest?.('.tile');
    if (!t) return;
    dragId = t.dataset.id;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragId);
    requestAnimationFrame(() => t.classList.add('is-drag'));
    closeMenu();
  });
  strip.addEventListener('dragover', (e) => {
    if (!dragId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    // место считаем среди остальных плиток — это и есть номер после того, как блок уберут со старого места
    const others = [...strip.querySelectorAll('.tile')].filter((t) => t.dataset.id !== dragId);
    let at = others.length;
    for (let i = 0; i < others.length; i++) {
      const r = others[i].getBoundingClientRect();
      if (e.clientX < r.left + r.width / 2) {
        at = i;
        break;
      }
    }
    dropAt = at;
    const ref = others[at] || null;
    const x = ref ? ref.offsetLeft - 9 : others.length ? others.at(-1).offsetLeft + others.at(-1).offsetWidth + 9 : capIn.offsetLeft + capIn.offsetWidth + 20;
    mark.style.left = x + 'px';
    mark.classList.add('is-on');
  });
  strip.addEventListener('dragleave', (e) => {
    if (!strip.contains(e.relatedTarget)) mark.classList.remove('is-on');
  });
  strip.addEventListener('drop', (e) => {
    if (!dragId) return;
    e.preventDefault();
    const id = dragId;
    dragId = null;
    mark.classList.remove('is-on');
    if (dropAt >= 0) chain.move(id, dropAt);
    render();
  });
  strip.addEventListener('dragend', () => {
    dragId = null;
    mark.classList.remove('is-on');
    for (const t of strip.querySelectorAll('.is-drag')) t.classList.remove('is-drag');
  });

  // ---------- индикаторы на входе и выходе ----------
  const toBar = (pk) => Math.max(0, Math.min(1, (20 * Math.log10(pk + 1e-6) + 54) / 54));
  function setMeters(inPk, outPk) {
    if (!capIn || !capOut) return;
    const a = capIn.querySelector('i');
    const b = capOut.querySelector('i');
    a.style.transform = `scaleY(${toBar(inPk).toFixed(3)})`;
    b.style.transform = `scaleY(${toBar(outPk).toFixed(3)})`;
    a.classList.toggle('clip', inPk > 0.97);
    b.classList.toggle('clip', outPk > 0.97);
  }

  render();
  return { render, highlight, setMeters, closeMenu };
}
