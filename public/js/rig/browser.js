// Список пресетов слева от доски: коллекции (встроенные и по группам) и свои пресеты.
import { COLLECTIONS } from '../presets.js';

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

const initials = (title) =>
  title
    .split(/\s+/)
    .filter((w) => /^[\p{L}\d]/u.test(w) && !/^(the|so)$/i.test(w))
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('');

/**
 * @param {{ store, getState: () => ({ current, dirty, user: {name, blocks}[] }), presetMissing: (blocks) => boolean,
 *           onFactory: (col, id) => void, onUser: (name) => void, onDeleteUser: (name) => void }} o
 */
export function createBrowser(host, o) {
  host.classList.add('browser');
  const closed = new Set(o.store.get('rig.closedCols', []));

  function toggle(id, section) {
    if (closed.has(id)) closed.delete(id);
    else closed.add(id);
    section.classList.toggle('is-closed', closed.has(id));
    section.querySelector('.br-col-head').setAttribute('aria-expanded', !closed.has(id));
    o.store.set('rig.closedCols', [...closed]);
  }

  function column(id, title, subtitle, colors, rows) {
    const s = el('section', 'br-col');
    s.classList.toggle('is-closed', closed.has(id));
    const h = el('button', 'br-col-head');
    h.setAttribute('aria-expanded', !closed.has(id));
    h.style.setProperty('--a', colors[0]);
    h.style.setProperty('--b', colors[1]);
    const sw = el('span', 'br-swatch', initials(title));
    const tt = el('span', 'br-col-title');
    tt.append(el('b', '', title), el('small', '', subtitle));
    h.append(sw, tt, el('span', 'br-chev'));
    h.addEventListener('click', () => toggle(id, s));
    const list = el('div', 'br-presets');
    list.append(...rows);
    s.append(h, list);
    return s;
  }

  function row(name, note, active, dirty, missing, onClick, extra) {
    const b = el('button', 'br-preset');
    b.classList.toggle('is-active', active);
    if (active) b.setAttribute('aria-current', 'true');
    b.title = note || name;
    const n = el('span', 'br-name', name);
    if (active && dirty) n.append(el('i', 'br-dirty', ' •'));
    b.append(n);
    if (missing) {
      const m = el('span', 'br-cloud', 'T3K');
      m.title = 'This preset has TONE3000 tones that aren’t downloaded yet — built-in blocks play in their place for now';
      b.append(m);
    }
    if (extra) b.append(extra);
    b.addEventListener('click', onClick);
    return b;
  }

  function render() {
    const { current, dirty, user } = o.getState();
    const nodes = [];
    for (const c of COLLECTIONS) {
      const rows = c.presets.map((p) =>
        row(p.name, p.note, current?.col === c.id && current?.id === p.id, dirty, o.presetMissing(p.blocks), () => o.onFactory(c.id, p.id))
      );
      nodes.push(column(c.id, c.title, c.subtitle, c.colors, rows));
    }
    const mine = user.map((p) => {
      const del = el('span', 'br-del', '×');
      del.setAttribute('role', 'button');
      del.title = 'Delete preset';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        o.onDeleteUser(p.name);
      });
      return row(p.name, 'your preset', current?.user === p.name, dirty, o.presetMissing(p.blocks), () => o.onUser(p.name), del);
    });
    if (!mine.length) mine.push(el('p', 'br-empty', 'Build a chain and press “Save” — the preset will show up here.'));
    nodes.push(column('user', 'My presets', 'saved by you',
 ['#64748b', '#94a3b8'], mine));
    const scroll = host.scrollTop;
    host.replaceChildren(...nodes);
    host.scrollTop = scroll;
  }

  return { render };
}
