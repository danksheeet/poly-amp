// Браузер слева, как в DAW: всё, что можно поставить в канал, — встроенные эффекты и тоны TONE3000
// (уже скачанные и каталог). Строку перетаскивают в слот канала, или добавляют двойным кликом / кнопкой «+».
import { BLOCKS, iconSvg } from '../blocks.js';
import { safeImage } from './info.js';

/** Тип данных при перетаскивании из браузера в канал. */
export const DRAG_TYPE = 'application/x-polyamp-add';

const BUILTIN = ['gate', 'comp', 'drive', 'polyamp', 'polycab', 'chorus', 'phaser', 'tremolo', 'delay', 'reverb'];
const T3K = [
  ['amp', 'Amps'],
  ['pedal', 'Pedals'],
  ['cab', 'Cabs · IRs'],
  ['space', 'Spaces · reverb IRs'],
];

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

export function createBrowser(host, { engine, store, t3k, onAdd }) {
  const native = engine.isNative;
  host.classList.add('pb-browser');
  host.innerHTML = `
    <div class="pb-head"><b>Browser</b><span>drag into a slot</span></div>
    <label class="pb-search">${iconSvg('search') || ''}<input data-ref="q" placeholder="Search effects and tones" spellcheck="false" aria-label="Search effects and tones"></label>
    <div class="pb-tree" data-ref="tree" role="tree"></div>`;
  const q = host.querySelector('[data-ref="q"]');
  const tree = host.querySelector('[data-ref="tree"]');
  const open = Object.assign({ builtin: true, t3k: true, amp: true, pedal: false, cab: false, space: false }, store.get('rig.browserOpen', {}));

  function folder(key, label, count, extra) {
    const f = el('button', 'pb-fold' + (key === 't3k' ? ' is-cloud' : ''));
    f.setAttribute('role', 'treeitem');
    f.setAttribute('aria-expanded', !!open[key]);
    f.append(el('i', 'pb-arrow'), el('span', 'pb-fold-name', label));
    if (count != null) f.append(el('span', 'pb-count', String(count)));
    if (extra) f.append(extra);
    f.addEventListener('click', (e) => {
      if (e.target.closest('.pb-link')) return;
      open[key] = !open[key];
      store.set('rig.browserOpen', open);
      render();
    });
    return f;
  }

  // строка: перетаскивается в канал; двойной клик, Enter или «+» — добавить после выбранного слота
  function item({ label, sub, color, icon, image, payload, mark, cls = '' }) {
    const r = el('div', 'pb-item ' + cls);
    r.setAttribute('role', 'treeitem');
    r.tabIndex = 0;
    r.style.setProperty('--c', color);
    r.title = sub ? `${label} — ${sub}` : label;
    const ic = el('span', 'pb-ic');
    if (image) {
      const img = el('img');
      img.src = image;
      img.alt = '';
      img.draggable = false;
      img.addEventListener('error', () => {
        img.remove();
        ic.innerHTML = iconSvg(icon);
      });
      ic.append(img);
    } else ic.innerHTML = iconSvg(icon);
    const txt = el('span', 'pb-txt');
    txt.append(el('b', '', label));
    if (sub) txt.append(el('small', '', sub));
    r.append(ic, txt);
    if (mark) r.append(el('span', 'pb-mark', mark));
    if (payload) {
      r.draggable = true;
      const add = el('button', 'pb-add', '+');
      add.title = 'Add to the channel';
      add.setAttribute('aria-label', 'Add ' + label + ' to the channel');
      add.addEventListener('click', (e) => {
        e.stopPropagation();
        onAdd(payload);
      });
      r.append(add);
      r.addEventListener('dblclick', () => onAdd(payload));
      r.addEventListener('keydown', (e) => e.key === 'Enter' && onAdd(payload));
      r.addEventListener('dragstart', (e) => {
        e.dataTransfer.effectAllowed = 'copy';
        e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(payload));
        e.dataTransfer.setData('text/plain', label);
        r.classList.add('is-drag');
      });
      r.addEventListener('dragend', () => r.classList.remove('is-drag'));
    }
    return r;
  }

  function render() {
    const needle = q.value.trim().toLowerCase();
    const match = (...s) => !needle || s.some((x) => x && x.toLowerCase().includes(needle));
    const nodes = [];

    // встроенные эффекты
    const builtin = BUILTIN.filter((t) => match(BLOCKS[t].name, BLOCKS[t].role, BLOCKS[t].tag));
    if (builtin.length) {
      nodes.push(folder('builtin', 'Built-in effects', builtin.length));
      if (open.builtin || needle) {
        for (const t of builtin) {
          const d = BLOCKS[t];
          nodes.push(item({ label: d.name, sub: d.role, color: d.color, icon: d.icon, payload: { type: t } }));
        }
      }
    }

    // облако TONE3000: скачанные тоны и каталог
    // так требуют условия API TONE3000: подпись и ссылка на их сайт — первой строкой открытой папки
    const powered = el('button', 'pb-link pb-powered', 'Powered by TONE3000');
    powered.title = 'tone3000.com';
    powered.addEventListener('click', () => engine.openUrl?.('https://www.tone3000.com'));
    const lib = native ? engine.library || [] : [];
    const kinds = T3K.map(([kind, title]) => {
      const mine = lib.filter((x) => x.slot === kind && match(x.title, x.model, x.creator, title));
      const showBrowse = match(title, 'tone3000', 'catalog', BLOCKS[kind].name);
      return { kind, title, mine, showBrowse };
    }).filter((k) => !needle || k.mine.length || k.showBrowse);
    if (kinds.length || !native) {
      nodes.push(folder('t3k', 'TONE3000 Cloud'));
      if (open.t3k || needle) {
        nodes.push(powered);
        if (!native) nodes.push(el('p', 'pb-note', 'TONE3000 tones download and play in the Poly Amp app.'));
        else {
          for (const k of kinds) {
            const d = BLOCKS[k.kind];
            const sub = folder(k.kind, k.title, k.mine.length || null);
            sub.classList.add('is-sub');
            nodes.push(sub);
            if (!(open[k.kind] || needle)) continue;
            for (const x of k.mine) {
              nodes.push(item({
                label: x.title,
                sub: [x.model && x.model !== x.title ? x.model : '', x.creator].filter(Boolean).join(' · ') || d.role,
                color: d.color, icon: d.icon, image: safeImage(x.image), mark: '✓',
                payload: { type: k.kind, file: x.path }, cls: 'is-deep',
              }));
            }
            if (k.showBrowse) {
              const b = item({ label: 'Browse the catalog…', sub: 'download a new ' + d.name.toLowerCase() + ' from TONE3000', color: d.color, icon: 'search', cls: 'is-deep is-browse' });
              const go = () => t3k.open(d.t3k, store.get('t3k.arch', '2'), null);
              b.addEventListener('click', go);
              b.addEventListener('keydown', (e) => e.key === 'Enter' && go());
              nodes.push(b);
            }
          }
        }
      }
    }
    if (!nodes.length) nodes.push(el('p', 'pb-note', 'Nothing found'));
    tree.replaceChildren(...nodes);
  }

  q.addEventListener('input', render);
  q.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      q.value = '';
      render();
    }
  });
  if (native) engine.on('library', render);
  render();
  return { render };
}
