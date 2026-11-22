// Библиотека табов: файлы Guitar Pro из выбранной папки (со всеми подпапками).
// Одна песня в разных форматах (.gp, .gpx, .gp5 и PDF рядом) показывается одной строкой со значками форматов.
// Порядок на выбор: по папкам, по названию, по исполнителю, недавно добавленные, недавно открытые.
// Название и исполнитель — из имени файла («Artist - Title», у Songsterr «Artist-Title-MM-DD-YYYY») и из папок
// («CHON-Grow Sheet Happens»); номера дорожек и служебные хвосты вроде «GP», «Guitar Tabs» в название не попадают.
// Сверху — кнопка «Add from Songsterr» и «Недавние». Песню можно удалить: её файлы уходят в Корзину.
import { icon } from '../icons.js';

const PRIORITY = ['gp', 'gpx', 'gp5', 'gp4', 'gp3', 'musicxml', 'mxl'];
const LABEL = { gp: 'GP', gpx: 'GPX', gp5: 'GP5', gp4: 'GP4', gp3: 'GP3', musicxml: 'XML', mxl: 'MXL', pdf: 'PDF' };
// служебные папки: «GPX», «PDF», «2. GuitarPro Files», «Guitar Pro 7 Files», «… Tabs GP GPX PDF», «Chimera Guitar Tabs»
const NOISE = /^(\d+[.)]?\s*)?(pdfs?|pdf tab books?|gpx?|gp\d|guitar ?pro( \d+)?( files)?|tabs?|.*\bguitar tabs?|.*\btabs? gp gpx pdf)$/i;
const SORTS = [
  ['folder', 'Folders'],
  ['title', 'Title'],
  ['artist', 'Artist'],
  ['added', 'Recently added'],
  ['opened', 'Recently opened'],
];
const SORT_LABEL = Object.fromEntries(SORTS);
const RECENT_N = 5; // строк в «Недавних»
const OPENED_MAX = 300; // сколько времён открытия помнить
const DAY = 86400000;
const RECENT_KEY = ':recent'; // ключ свёрнутости «Недавних» (в имени папки двоеточия не бывает)

// Songsterr называет файлы «Alice in Chains-Nutshell-10-19-2026»
const SS_NAME = /^(.+?)-(.+)[-\s]\d{2}[-\s]\d{2}[-\s]\d{4}$/;
const TRACK_DOT = /^\[\d+\]\s*|^\d{1,3}[.)]\s*/; // «[10] Chimera», «2. Resurrect», «03.Polyphia - Inspire»
const TRACK_PAD = /^\d{1,3}\s+(?=\S)/; // «01 Drift», «10 Dead End» — только в папке, где номера с нулём впереди

const norm = (s) => s.toLowerCase().replace(/ё/g, 'е');
const stripNum = (s) => s.replace(/^\[\d+\]\s*|^\d+[.)]?\s*/, '');
const cmp = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }).compare;
const isSongsterr = (name) => norm(name) === 'songsterr';

/** Имя файла → название, исполнитель (если он в имени) и номер дорожки. */
export function parseName(base, numbered = false) {
  let s = base.trim();
  let artist = '';
  let track = null;
  const ss = s.match(SS_NAME);
  if (ss) {
    artist = ss[1].trim();
    s = ss[2].trim();
  }
  s = s.replace(/\s+guitar\s+tabs?$/i, '').replace(/\s+gpx?(\s+pack)?$/i, '').trim();
  const t = s.match(TRACK_DOT) || (numbered ? s.match(TRACK_PAD) : null);
  if (t && t[0].length < s.length) {
    track = parseInt(t[0].match(/\d+/)[0], 10);
    s = s.slice(t[0].length);
  }
  if (!artist) {
    const d = s.match(/^(.+?)\s+[-–—]\s+(.+)$/); // «CHON - Breathe»
    if (d) {
      artist = d[1].trim();
      s = d[2].trim();
    }
  }
  if (!/\s/.test(s) && /[-_]/.test(s)) s = s.replace(/[-_]+/g, ' '); // Chapter-1-Song-1-Lavender → Chapter 1 Song 1 Lavender
  s = s.replace(/(\w)_(?=(?:s|t|re|ll|ve|d|m)\b)/gi, "$1'").trim(); // «Can_t Wait» → «Can't Wait»
  return { title: s || base, artist, track };
}

/** «CHON-CHON Self Titled Sheet Happens» → «CHON Self Titled», «CHON-Homey» → «CHON · Homey». */
function cleanSeg(seg) {
  let s = stripNum(seg).replace(/_+$/, '').replace(/\bsheet happens\b/gi, '').trim();
  s = s.replace(/^([^\s-]+)-\1\b/i, '$1');
  s = s.replace(/^([^\s-]+)-(?=\S)/, '$1 · ');
  return s.trim();
}

/** Исполнитель из папки вида «CHON-Grow Sheet Happens» (папка верхнего уровня не в счёт: «Neo-Soul» — не исполнитель). */
function folderArtist(segments) {
  for (const seg of segments) {
    if (NOISE.test(seg.trim())) continue;
    const m = stripNum(seg.trim()).match(/^([^\s-]+)-(?=\S)/);
    if (m) return m[1];
  }
  return '';
}

/** Подпись: альбом и подпапки без служебных папок и без папки, названной как сама песня. */
function context(segments, title, songsIn = () => 0) {
  const t = norm(stripNum(title));
  return segments
    .filter((seg, i) => {
      const s = norm(seg.trim());
      if (NOISE.test(seg.trim())) return false;
      // папка с несколькими песнями — альбом, даже если называется как одна из них («CHON-Newborn Sun»)
      return songsIn(i) > 1 || (!s.includes(t) && !t.includes(norm(stripNum(seg.trim()))));
    })
    .map(cleanSeg)
    .filter(Boolean)
    .join(' · ');
}

/** Список файлов → песни (одна песня в нескольких форматах — одна запись). */
export function buildEntries(items) {
  // папки с нумерацией дорожек: хотя бы один файл начинается с «01 », «02.» и т. п.
  const numbered = new Set();
  const songs = new Map(); // папка (вместе с подпапками) → какие песни в ней лежат
  for (const it of items) {
    const parts = it.rel.split(/[\\/]/);
    const file = parts.pop();
    if (/^0\d[\s.)]/.test(file)) numbered.add(norm(parts.join('/')));
    const song = norm(parts.join('/') + '/' + file.replace(/\.[^.]+$/, ''));
    for (let i = 1; i <= parts.length; i++) {
      const p = norm(parts.slice(0, i).join('/'));
      if (!songs.has(p)) songs.set(p, new Set());
      songs.get(p).add(song);
    }
  }
  const map = new Map();
  for (const it of items) {
    const parts = it.rel.split(/[\\/]/);
    const file = parts.pop();
    const base = file.replace(/\.[^.]+$/, '');
    const dir = parts.join('/');
    const key = norm(dir + '/' + base);
    let e = map.get(key);
    if (!e) {
      const n = parseName(base, numbered.has(norm(dir)));
      const segs = parts.slice(1);
      e = {
        key,
        title: n.title,
        track: n.track,
        artist: n.artist || folderArtist(segs),
        nameArtist: !!n.artist,
        collection: parts[0] || 'No folder',
        context: context(segs, n.title, (i) => songs.get(norm(parts.slice(0, i + 2).join('/')))?.size || 0),
        files: {},
        pdf: null,
        rels: [],
        mtime: 0,
      };
      map.set(key, e);
    }
    if (it.ext === 'pdf') e.pdf = it.rel;
    else e.files[it.ext] = it.rel;
    e.rels.push(it.rel);
    e.mtime = Math.max(e.mtime, it.mtime || 0);
  }
  const entries = [...map.values()];
  for (const e of entries) {
    e.formats = PRIORITY.filter((x) => e.files[x]);
    const a = norm(e.artist);
    e.album = a && norm(e.context).startsWith(a + ' · ') ? e.context.slice(e.artist.length + 3) : a && norm(e.context) === a ? '' : e.context;
    e.group = e.artist || e.collection; // для сортировки по исполнителю: без исполнителя — по своей папке
    e.hay = norm([e.title, e.artist, e.context, e.collection, ...e.rels].join(' '));
  }
  entries.sort((a, b) => cmp(a.collection, b.collection) || cmp(a.context, b.context) || (a.track ?? 1e9) - (b.track ?? 1e9) || cmp(a.title, b.title));
  return entries;
}

/** «Today», «This week», … или месяц: заголовки групп по дате. */
function period(t) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (t >= today) return 'Today';
  if (t >= today - DAY) return 'Yesterday';
  if (t >= today - 6 * DAY) return 'This week';
  if (t >= today - 30 * DAY) return 'This month';
  return new Date(t).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}
const shortDate = (t) => new Date(t).toLocaleDateString('en-US', { day: 'numeric', month: 'short' });

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

/**
 * @param {HTMLElement} host
 * @param {{ engine, store,
 *   onOpen: (rel: string, title: string) => void,
 *   onSongsterr?: (text: string) => void,
 *   onOpenOutside?: (name: string) => void,
 *   onForgetOutside?: (name: string) => void,
 *   onDeleted?: (r: { ok: boolean, recycled: boolean, title: string, error?: string }) => void }} o
 */
export function createTabLibrary(host, { engine, store, onOpen, onSongsterr, onOpenOutside, onForgetOutside, onDeleted }) {
  host.innerHTML = `
    <div class="lb-head">
      <b>Library</b><span class="lb-count" data-ref="count"></span>
      <button class="ib ib-sm" data-ref="pick" title="Choose your tabs folder" aria-label="Choose folder">${icon('folder')}</button>
      <button class="ib ib-sm" data-ref="refresh" title="Re-read the folder" aria-label="Refresh">${icon('refresh')}</button>
    </div>
    <button class="lb-add" data-ref="ssBtn" aria-expanded="false" title="Find a song on Songsterr and download its Guitar Pro file into this library">${icon('plus')}<span>Add from Songsterr</span></button>
    <form class="lb-ss" data-ref="ssForm" hidden>
      <div class="lb-ss-row">
        <input class="text-input" data-ref="ssQ" placeholder="Song link or name" spellcheck="false" aria-label="Songsterr link, band or song">
        <button class="btn btn-primary" type="submit">Open</button>
      </div>
      <p>Sign in to Songsterr once, then press their download button and choose <b>Guitar Pro</b>. The tab lands in the <b>Songsterr</b> folder below and opens.</p>
    </form>
    <label class="lb-search" data-ref="search">${icon('search')}<input data-ref="q" placeholder="Song, band, album" spellcheck="false" aria-label="Search the library"></label>
    <div class="lb-filters" data-ref="filters">
      <button class="chip lb-sortbtn" data-ref="sortBtn" aria-haspopup="menu" aria-expanded="false" title="Sort the library">${icon('sort')}<span data-ref="sortLabel"></span>${icon('chevron', 'lb-sortchev')}</button>
      <button class="chip" data-ref="pdfOnly" aria-pressed="false" title="Also show PDF books without a Guitar Pro file (they open in a viewer)">${icon('file')} PDF</button>
      <div class="lb-menu" data-ref="sortMenu" role="menu" aria-label="Sort" hidden></div>
    </div>
    <div class="lb-list" data-ref="list"></div>
    <div class="lb-foot" data-ref="foot"></div>`;
  const ref = {};
  for (const n of host.querySelectorAll('[data-ref]')) ref[n.dataset.ref] = n;

  let entries = [];
  let dir = null;
  let error = null;
  let loaded = false;
  let current = null; // rel открытого файла
  const closed = new Set(store.get('tabs.libClosed', []));
  let showPdf = store.get('tabs.libPdf', false);
  let sort = SORT_LABEL[store.get('tabs.libSort', 'folder')] ? store.get('tabs.libSort', 'folder') : 'folder';
  const opened = Object.assign({}, store.get('tabs.libOpened', {})); // rel → когда открывали
  let recentRaw = []; // файлы, открытые не из библиотеки (кнопкой Open, перетаскиванием): { name, opened }
  let outside = [];
  const fresh = new Set(); // rel файлов, скачанных с Songsterr за этот запуск
  // «Удалить?» спрашиваем в одной строке: песня бывает и в «Недавних», и в своей папке — важно, где нажали
  let confirming = null; // { key, gid }
  let deleting = null;
  let recycle = true; // у диска библиотеки есть Корзина (на флешке и сетевом диске её нет)
  let revealRel = null; // прокрутить к этой песне после отрисовки
  let resetScroll = false;

  const native = engine.isNative;
  const openedAt = (e) => Math.max(0, ...e.rels.map((r) => opened[r] || 0));

  function saveOpened() {
    const keep = Object.entries(opened).sort((a, b) => b[1] - a[1]);
    for (const [rel] of keep.slice(OPENED_MAX)) delete opened[rel];
    store.set('tabs.libOpened', opened);
  }

  /** Недавние из IndexedDB: файлы из библиотеки (по имени) идут в «время открытия», остальные — отдельными строками. */
  function splitRecent() {
    const byName = new Map();
    for (const e of entries) for (const rel of e.rels) byName.set(norm(rel.split(/[\\/]/).pop()), rel);
    let seeded = false;
    outside = [];
    for (const r of recentRaw) {
      const rel = byName.get(norm(r.name));
      if (rel) {
        if (!opened[rel]) {
          opened[rel] = r.opened;
          seeded = true;
        }
      } else outside.push(r);
    }
    if (seeded) saveOpened();
  }

  function openEntry(e, ext) {
    if (ext === 'pdf' || (!e.formats.length && e.pdf)) return engine.tabsOpen(e.pdf);
    const fmt = ext || e.formats[0];
    if (fmt) onOpen(e.files[fmt], e.title);
  }

  /** Вторая строка: что поможет узнать песню при этом порядке. */
  function subtitle(e, mode) {
    if (mode === 'folder') {
      const own = (e.nameArtist || !e.context) && !norm(e.context).includes(norm(e.artist)) ? e.artist : '';
      return [own, e.context].filter(Boolean).join(' · ');
    }
    if (mode === 'artist') return e.album || (e.artist ? e.collection : '');
    const parts = [e.artist || e.collection, e.album || (e.artist ? e.collection : '')];
    return parts.filter((p, i) => p && (i === 0 || norm(p) !== norm(parts[0]))).join(' · ');
  }

  const rowSel = (key, gid) => `.lb-group[data-gid="${CSS.escape(gid)}"] .lb-item[data-key="${CSS.escape(key)}"]`;
  const isConfirming = (e, gid) => confirming?.key === e.key && confirming.gid === gid;

  function askDelete(e, gid) {
    confirming = { key: e.key, gid };
    render();
    ref.list.querySelector(rowSel(e.key, gid) + ' .lb-yes')?.focus({ preventScroll: true });
  }

  async function doDelete(e) {
    deleting = e.key;
    render();
    const res = await engine.tabsDelete(e.rels);
    deleting = null;
    confirming = null;
    if (res.ok) {
      for (const rel of e.rels) {
        delete opened[rel];
        fresh.delete(rel);
      }
      saveOpened();
      entries = entries.filter((x) => x !== e); // свежий список придёт следом, а строка уходит сразу
    }
    render();
    if (res.ok || !res.canceled) onDeleted?.({ ok: !!res.ok, recycled: recycle, title: e.title, error: res.error });
  }

  function confirmRow(e, gid) {
    const r = el('div', 'lb-item is-confirm');
    r.dataset.key = e.key;
    const busy = deleting === e.key;
    const ic = el('span', 'lb-ic bad');
    ic.innerHTML = icon('trash');
    const txt = el('span', 'lb-txt');
    const files = [...e.formats, ...(e.pdf ? ['pdf'] : [])].map((f) => LABEL[f]).join(', ');
    const where = recycle ? 'goes to the Recycle Bin' : 'deleted for good: this drive has no Recycle Bin';
    txt.append(el('b', '', `Delete “${e.title}”?`), el('small', '', busy ? 'Deleting…' : `${files} · ${where}`));
    const acts = el('span', 'lb-confirm-actions');
    const no = el('button', 'btn', 'Cancel');
    const yes = el('button', 'btn btn-danger lb-yes', 'Delete');
    no.disabled = yes.disabled = busy;
    no.addEventListener('click', () => {
      confirming = null;
      render();
      ref.list.querySelector(rowSel(e.key, gid))?.focus({ preventScroll: true });
    });
    yes.addEventListener('click', () => doDelete(e));
    r.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && !busy) {
        ev.stopPropagation();
        no.click();
      }
    });
    acts.append(no, yes);
    r.append(ic, txt, acts);
    return r;
  }

  function row(e, mode, gid) {
    if (isConfirming(e, gid)) return confirmRow(e, gid);
    const r = el('div', 'lb-item');
    r.tabIndex = 0;
    r.setAttribute('role', 'button');
    r.dataset.key = e.key;
    r.classList.toggle('is-current', !!current && e.rels.includes(current));
    r.classList.toggle('is-pdf', !e.formats.length);
    const ic = el('span', 'lb-ic');
    ic.innerHTML = icon(e.formats.length ? 'tab' : 'file');
    const txt = el('span', 'lb-txt');
    const line = el('span', 'lb-line');
    line.append(el('b', '', e.title));
    if (e.rels.some((rel) => fresh.has(rel))) line.append(el('span', 'lb-new', 'new'));
    txt.append(line);
    const sub = subtitle(e, mode);
    if (sub) txt.append(el('small', '', sub));
    const fmts = el('span', 'lb-fmts');
    for (const f of e.formats) {
      const b = el('button', 'lb-badge', LABEL[f]);
      b.title = `Open ${LABEL[f]}`;
      b.tabIndex = -1;
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        openEntry(e, f);
      });
      fmts.append(b);
    }
    if (e.pdf) {
      const b = el('button', 'lb-badge pdf', 'PDF');
      b.title = 'Open the PDF in a viewer';
      b.tabIndex = -1;
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        openEntry(e, 'pdf');
      });
      fmts.append(b);
    }
    r.append(ic, txt, fmts);
    if (native) {
      const del = el('button', 'lb-act lb-del');
      del.innerHTML = icon('trash');
      del.title = recycle ? 'Delete (Del): the files go to the Recycle Bin' : 'Delete (Del)';
      del.setAttribute('aria-label', 'Delete ' + e.title);
      del.tabIndex = -1;
      del.addEventListener('click', (ev) => {
        ev.stopPropagation();
        askDelete(e, gid);
      });
      r.append(del);
    }
    r.title = e.formats.length ? [e.title, e.artist].filter(Boolean).join(' — ') + '\n' + e.rels[0] : 'The PDF opens in a viewer';
    r.addEventListener('click', () => openEntry(e));
    r.addEventListener('keydown', (ev) => {
      if (ev.target !== r) return;
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        openEntry(e);
      } else if (ev.key === 'Delete' && native) {
        ev.preventDefault();
        askDelete(e, gid);
      }
    });
    return r;
  }

  /** Файл, открытый не из библиотеки: копия лежит в приложении, на диске его искать не нужно. */
  function outsideRow(o) {
    const r = el('div', 'lb-item is-outside');
    r.tabIndex = 0;
    r.setAttribute('role', 'button');
    const ic = el('span', 'lb-ic');
    ic.innerHTML = icon('tab');
    const txt = el('span', 'lb-txt');
    const line = el('span', 'lb-line');
    line.append(el('b', '', o.name.replace(/\.(gpx?|gp\d|musicxml|mxl|xml)$/i, '')));
    txt.append(line, el('small', '', (native ? 'Not in the library · ' : 'Opened ') + shortDate(o.opened)));
    const x = el('button', 'lb-act');
    x.innerHTML = icon('close');
    x.title = 'Remove from Recent';
    x.setAttribute('aria-label', 'Remove from Recent');
    x.tabIndex = -1;
    x.addEventListener('click', (ev) => {
      ev.stopPropagation();
      recentRaw = recentRaw.filter((f) => f.name !== o.name);
      outside = outside.filter((f) => f.name !== o.name);
      onForgetOutside?.(o.name);
      render();
    });
    r.append(ic, txt, x);
    r.title = o.name;
    r.addEventListener('click', () => onOpenOutside?.(o.name));
    r.addEventListener('keydown', (ev) => {
      if (ev.target === r && (ev.key === 'Enter' || ev.key === ' ')) {
        ev.preventDefault();
        onOpenOutside?.(o.name);
      }
    });
    return r;
  }

  /** Недавние: песни из библиотеки и отдельные файлы вперемешку, новые сверху. */
  function recentItems(filter = () => true) {
    const lib = entries.filter((e) => openedAt(e) && filter(e)).map((e) => ({ e, t: openedAt(e) }));
    const own = outside.filter((o) => filter(null, o)).map((o) => ({ o, t: o.opened }));
    return [...lib, ...own].sort((a, b) => b.t - a.t);
  }

  function groupsFor(visible, tokens) {
    const searching = tokens.length > 0;
    const groups = [];
    const add = (id, name, items, extra = {}) => items.length && groups.push({ id, name, items, ...extra });
    const byTime = (list, time) => {
      const out = new Map();
      for (const it of list) {
        const p = period(time(it));
        if (!out.has(p)) out.set(p, []);
        out.get(p).push(it);
      }
      return out;
    };

    if (!searching && sort !== 'opened') {
      add(RECENT_KEY, 'Recent', recentItems().slice(0, RECENT_N).map((x) => x.e || { outside: x.o }), { recent: true });
    }
    if (sort === 'folder') {
      const by = new Map();
      for (const e of visible) {
        if (!by.has(e.collection)) by.set(e.collection, []);
        by.get(e.collection).push(e);
      }
      // папка Songsterr — первой: туда ложатся новые песни
      const names = [...by.keys()].sort((a, b) => isSongsterr(b) - isSongsterr(a));
      for (const n of names) add(n, n, by.get(n), { songsterr: isSongsterr(n) });
    } else if (sort === 'title') {
      const by = new Map();
      for (const e of [...visible].sort((a, b) => cmp(a.title, b.title) || cmp(a.group, b.group))) {
        const c = e.title.trim().charAt(0).toUpperCase();
        const letter = /\p{L}/u.test(c) ? c : '#';
        if (!by.has(letter)) by.set(letter, []);
        by.get(letter).push(e);
      }
      for (const [l, items] of [...by].sort((a, b) => (a[0] === '#') - (b[0] === '#') || cmp(a[0], b[0]))) add('title:' + l, l, items);
    } else if (sort === 'artist') {
      const by = new Map();
      for (const e of visible) {
        const k = norm(e.group);
        if (!by.has(k)) by.set(k, { name: e.group, items: [] });
        const g = by.get(k);
        if (e.nameArtist && !g.fromName) Object.assign(g, { name: e.group, fromName: true }); // написание из имён файлов
        g.items.push(e);
      }
      for (const g of [...by.values()].sort((a, b) => cmp(a.name, b.name))) {
        g.items.sort((a, b) => cmp(a.album, b.album) || (a.track ?? 1e9) - (b.track ?? 1e9) || cmp(a.title, b.title));
        add('artist:' + norm(g.name), g.name, g.items);
      }
    } else if (sort === 'added') {
      const list = [...visible].sort((a, b) => b.mtime - a.mtime || cmp(a.title, b.title));
      for (const [p, items] of byTime(list, (e) => e.mtime)) add('added:' + p, p, items);
    } else {
      const shown = new Set(visible);
      const match = (e, o) => (e ? shown.has(e) : tokens.every((t) => norm(o.name).includes(t)));
      const rec = recentItems(match);
      for (const [p, items] of byTime(rec, (x) => x.t)) add('opened:' + p, p, items.map((x) => x.e || { outside: x.o }));
      const rest = visible.filter((e) => !openedAt(e)).sort((a, b) => cmp(a.title, b.title));
      add('opened:never', 'Not opened yet', rest);
    }
    return groups;
  }

  function section(g, searching) {
    const open = searching || !closed.has(g.id);
    const sec = el('section', 'lb-group' + (open ? '' : ' is-closed') + (g.recent ? ' is-recent' : ''));
    sec.dataset.gid = g.id;
    const head = el('div', 'lb-group-head');
    const tog = el('button', 'lb-group-btn');
    tog.setAttribute('aria-expanded', open);
    tog.innerHTML = icon(g.recent ? 'recent' : 'chevron', 'lb-chev');
    tog.append(el('b', '', g.name), el('span', 'lb-group-count', String(g.items.length)));
    tog.addEventListener('click', () => {
      if (searching) return;
      if (closed.has(g.id)) closed.delete(g.id);
      else closed.add(g.id);
      store.set('tabs.libClosed', [...closed]);
      render();
    });
    head.append(tog);
    if (g.songsterr && native && onSongsterr) {
      const plus = el('button', 'ib ib-sm lb-group-add');
      plus.innerHTML = icon('plus');
      plus.title = 'Add a song from Songsterr';
      plus.setAttribute('aria-label', 'Add a song from Songsterr');
      plus.addEventListener('click', () => openSs(true));
      head.append(plus);
    }
    sec.append(head);
    if (open) {
      const box = el('div', 'lb-items');
      const mode = g.recent || sort === 'opened' ? 'flat' : sort === 'folder' ? 'folder' : sort === 'artist' ? 'artist' : 'flat';
      for (const it of g.items) box.append(it.outside ? outsideRow(it.outside) : row(it, mode, g.id));
      sec.append(box);
    }
    return sec;
  }

  function render() {
    ref.pdfOnly.setAttribute('aria-pressed', showPdf);
    ref.sortLabel.textContent = SORT_LABEL[sort];
    ref.foot.textContent = dir || '';
    ref.foot.title = dir || '';
    const list = ref.list;
    const scroll = resetScroll ? 0 : list.scrollTop;
    resetScroll = false;
    list.replaceChildren();
    if (!native) {
      list.append(el('p', 'lb-note', 'The tabs folder library works in the Poly Amp app. Here you can open a file with the “Open” button.'));
      if (outside.length) list.append(section({ id: RECENT_KEY, name: 'Recent', items: outside.map((o) => ({ outside: o })), recent: true }, false));
      ref.count.textContent = '';
      return;
    }
    if (!loaded) {
      list.append(el('p', 'lb-note', 'Reading the folder…'));
      return;
    }
    if (!dir) {
      const p = el('div', 'lb-empty');
      p.append(el('p', 'lb-note', 'Choose your tabs folder — all Guitar Pro files from it and its subfolders will show up here.'));
      const b = el('button', 'btn btn-primary', 'Choose folder…');
      b.addEventListener('click', () => engine.tabsLibPick());
      p.append(b);
      list.append(p);
      ref.count.textContent = '';
      return;
    }
    if (error) list.append(el('p', 'lb-note bad', error));

    const tokens = norm(ref.q.value.trim()).split(/\s+/).filter(Boolean);
    const searching = tokens.length > 0;
    const visible = entries.filter((e) => (e.formats.length || showPdf) && tokens.every((t) => e.hay.includes(t)));
    const songs = entries.filter((e) => e.formats.length).length;
    ref.count.textContent = searching ? `${visible.length} of ${songs}` : String(songs);

    const groups = groupsFor(visible, tokens);
    if (!groups.some((g) => !g.recent)) {
      for (const g of groups) list.append(section(g, searching));
      list.append(el('p', 'lb-note', searching ? 'Nothing found.' : 'No Guitar Pro files in this folder.'));
      return;
    }
    for (const g of groups) list.append(section(g, searching));
    list.scrollTop = scroll;
    if (revealRel) {
      const e = entries.find((x) => x.rels.includes(revealRel));
      revealRel = null;
      const sel = e && `.lb-item[data-key="${CSS.escape(e.key)}"]`;
      const r = sel && (list.querySelector(`.lb-group:not(.is-recent) ${sel}`) || list.querySelector(sel));
      r?.scrollIntoView({ block: 'nearest' });
    }
  }

  // ---------- Songsterr ----------
  function openSs(on) {
    ref.ssForm.hidden = !on;
    ref.ssBtn.setAttribute('aria-expanded', on);
    if (on) {
      ref.ssQ.focus();
      ref.ssQ.select();
    }
  }
  ref.ssBtn.addEventListener('click', () => openSs(ref.ssForm.hidden));
  ref.ssForm.addEventListener('submit', (e) => {
    e.preventDefault();
    onSongsterr?.(ref.ssQ.value);
    ref.ssQ.value = '';
    openSs(false);
  });
  ref.ssQ.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      openSs(false);
      ref.ssBtn.focus();
    }
  });

  // ---------- сортировка ----------
  function sortMenu(on) {
    ref.sortMenu.hidden = !on;
    ref.sortBtn.setAttribute('aria-expanded', on);
    if (!on) return;
    ref.sortMenu.replaceChildren(
      ...SORTS.map(([id, label]) => {
        const b = el('button', 'lb-menu-item');
        b.setAttribute('role', 'menuitemradio');
        b.setAttribute('aria-checked', id === sort);
        b.dataset.sort = id;
        b.innerHTML = icon('check', 'lb-menu-check');
        b.append(el('span', '', label));
        b.addEventListener('click', () => {
          sortMenu(false);
          ref.sortBtn.focus();
          if (id === sort) return;
          sort = id;
          store.set('tabs.libSort', sort);
          resetScroll = true;
          render();
        });
        return b;
      })
    );
    ref.sortMenu.querySelector('[aria-checked="true"]')?.focus();
  }
  ref.sortBtn.addEventListener('click', () => sortMenu(ref.sortMenu.hidden));
  ref.sortMenu.addEventListener('keydown', (e) => {
    const items = [...ref.sortMenu.querySelectorAll('.lb-menu-item')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'Escape') {
      e.stopPropagation();
      sortMenu(false);
      ref.sortBtn.focus();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
    }
  });
  document.addEventListener('pointerdown', (e) => {
    if (!ref.sortMenu.hidden && !ref.sortMenu.contains(e.target) && !ref.sortBtn.contains(e.target)) sortMenu(false);
  });

  // ---------- поиск, фильтр, папка ----------
  let timer = null;
  ref.q.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(render, 90);
  });
  ref.q.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      ref.q.value = '';
      render();
    }
    if (e.key === 'Enter') ref.list.querySelector('.lb-group:not(.is-recent) .lb-item')?.click(); // Enter — открыть первое найденное
  });
  ref.pdfOnly.addEventListener('click', () => {
    showPdf = !showPdf;
    store.set('tabs.libPdf', showPdf);
    render();
  });
  ref.pick.addEventListener('click', () => engine.tabsLibPick());
  ref.refresh.addEventListener('click', () => {
    loaded = false;
    render();
    engine.tabsLib();
  });
  ref.pick.hidden = ref.refresh.hidden = ref.search.hidden = ref.filters.hidden = !native;
  ref.ssBtn.hidden = !native || !onSongsterr;

  if (native) {
    engine.on('tabsLib', (m) => {
      loaded = true;
      dir = m.dir || null;
      error = m.error || null;
      entries = buildEntries(m.items || []);
      recycle = m.recycle !== false;
      if (confirming && !entries.some((e) => e.key === confirming.key)) confirming = null;
      splitRecent();
      render();
    });
  }
  render();

  return {
    /** Попросить список (при первом показе вкладки). */
    load() {
      if (native && !loaded) engine.tabsLib();
    },
    /** Какой файл сейчас открыт — его строка подсвечивается, а время открытия запоминается. */
    setCurrent(rel) {
      current = rel;
      if (rel) {
        opened[rel] = Date.now();
        saveOpened();
      }
      render();
    },
    /** Недавние файлы из IndexedDB ({ name, opened }, новые первыми). */
    setRecent(list) {
      recentRaw = list;
      splitRecent();
      render();
    },
    /** Только что скачанная песня: метка «new» и прокрутка к ней. */
    markNew(rel) {
      fresh.add(rel);
      revealRel = rel;
      if (sort === 'folder') {
        const e = entries.find((x) => x.rels.includes(rel));
        if (e && closed.delete(e.collection)) store.set('tabs.libClosed', [...closed]);
      }
      render();
    },
    /** Открыть поле «Add from Songsterr». */
    openSongsterr: () => openSs(true),
    focusSearch: () => ref.q.focus(),
  };
}
