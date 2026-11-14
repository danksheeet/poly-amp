// Библиотека табов: файлы Guitar Pro из выбранной папки (со всеми подпапками).
// Одна песня в разных форматах (.gp, .gpx, .gp5 и PDF рядом) показывается одной строкой со значками форматов.
// Песни сгруппированы по папкам верхнего уровня; служебные папки вроде «GPX», «PDF», «Guitar Tabs» в подписи не попадают.
import { icon } from '../icons.js';

const PRIORITY = ['gp', 'gpx', 'gp5', 'gp4', 'gp3', 'musicxml', 'mxl'];
const LABEL = { gp: 'GP', gpx: 'GPX', gp5: 'GP5', gp4: 'GP4', gp3: 'GP3', musicxml: 'XML', mxl: 'MXL' };
// служебные папки: «GPX», «PDF», «2. GuitarPro Files», «Guitar Pro 7 Files», «… Tabs GP GPX PDF», «Chimera Guitar Tabs»
const NOISE = /^(\d+[.)]?\s*)?(pdfs?|pdf tab books?|gpx?|gp\d|guitar ?pro( \d+)?( files)?|tabs?|.*\bguitar tabs?|.*\btabs? gp gpx pdf)$/i;

const norm = (s) => s.toLowerCase().replace(/ё/g, 'е');
const stripNum = (s) => s.replace(/^\[\d+\]\s*|^\d+[.)]?\s*/, '');

function cleanTitle(base) {
  let s = base.replace(/\s+guitar\s+tabs?$/i, '').replace(/\s+gpx?$/i, '').trim();
  if (!/\s/.test(s) && /[-_]/.test(s)) s = s.replace(/[-_]+/g, ' '); // Chapter-1-Song-1-Lavender → Chapter 1 Song 1 Lavender
  return s;
}

/** «CHON-CHON Self Titled Sheet Happens» → «CHON Self Titled», «CHON-Homey» → «CHON · Homey». */
function cleanSeg(seg) {
  let s = stripNum(seg).replace(/_+$/, '').replace(/\bsheet happens\b/gi, '').trim();
  s = s.replace(/^([^\s-]+)-\1\b/i, '$1');
  s = s.replace(/^([^\s-]+)-(?=\S)/, '$1 · ');
  return s.trim();
}

/** Подпись: альбом и подпапки без служебных папок и без папки, названной как сама песня. */
function context(segments, title) {
  const t = norm(stripNum(title));
  return segments
    .filter((seg) => {
      const s = norm(seg.trim());
      return !NOISE.test(seg.trim()) && !s.includes(t) && !t.includes(norm(stripNum(seg.trim())));
    })
    .map(cleanSeg)
    .filter(Boolean)
    .join(' · ');
}

/** Список файлов → песни, сгруппированные по папкам верхнего уровня. */
function buildEntries(items) {
  const map = new Map();
  for (const it of items) {
    const parts = it.rel.split(/[\\/]/);
    const file = parts.pop();
    const base = file.replace(/\.[^.]+$/, '');
    const dir = parts.join('/');
    const key = norm(dir + '/' + base);
    let e = map.get(key);
    if (!e) {
      const title = cleanTitle(base);
      e = {
        key,
        title,
        collection: parts[0] || 'No folder',
        context: context(parts.slice(1), title),
        files: {},
        pdf: null,
        mtime: 0,
      };
      map.set(key, e);
    }
    if (it.ext === 'pdf') e.pdf = it.rel;
    else e.files[it.ext] = it.rel;
    e.mtime = Math.max(e.mtime, it.mtime || 0);
  }
  const entries = [...map.values()];
  for (const e of entries) {
    e.formats = PRIORITY.filter((x) => e.files[x]);
    e.hay = norm([e.title, e.context, e.collection, ...Object.values(e.files), e.pdf || ''].join(' '));
  }
  const cmp = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }).compare;
  entries.sort((a, b) => cmp(a.collection, b.collection) || cmp(a.context, b.context) || cmp(a.title, b.title));
  return entries;
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

/**
 * @param {HTMLElement} host
 * @param {{ engine, store, onOpen: (rel: string, title: string) => void, onSongsterr?: () => void }} o
 */
export function createTabLibrary(host, { engine, store, onOpen, onSongsterr }) {
  host.innerHTML = `
    <div class="lb-head">
      <b>Library</b><span class="lb-count" data-ref="count"></span>
      <button class="ib ib-sm" data-ref="songsterr" title="Get a tab from Songsterr: its Guitar Pro file is saved straight into this library" aria-label="Get from Songsterr">${icon('download')}</button>
      <button class="ib ib-sm" data-ref="pick" title="Choose your tabs folder" aria-label="Choose folder">${icon('folder')}</button>
      <button class="ib ib-sm" data-ref="refresh" title="Re-read the folder" aria-label="Refresh">${icon('refresh')}</button>
    </div>
    <label class="lb-search">${icon('search')}<input data-ref="q" placeholder="Song, band, album" spellcheck="false" aria-label="Search the library"></label>
    <div class="lb-filters">
      <button class="chip" data-ref="pdfOnly" aria-pressed="false" title="Also show PDF books without a Guitar Pro file (they open in a viewer)">${icon('file')} PDF</button>
    </div>
    <div class="lb-tip" data-ref="tip" hidden>
      <span><b>Tip:</b> copy a song link on Songsterr and press <kbd>Ctrl</kbd>+<kbd>V</kbd> here. The window asks you to sign in once,
        then press the download button and choose <b>Guitar Pro</b> — the file lands in this library (folder “Songsterr”) and opens.</span>

      <button class="lb-tip-x" data-ref="tipClose" title="Hide the tip" aria-label="Hide the tip">×</button>
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

  function openEntry(e, ext) {
    if (ext === 'pdf' || (!e.formats.length && e.pdf)) return engine.tabsOpen(e.pdf);
    const fmt = ext || e.formats[0];
    if (fmt) onOpen(e.files[fmt], e.title);
  }

  function row(e) {
    const r = el('div', 'lb-item');
    r.tabIndex = 0;
    r.setAttribute('role', 'button');
    const isCurrent = current && (Object.values(e.files).includes(current));
    r.classList.toggle('is-current', !!isCurrent);
    r.classList.toggle('is-pdf', !e.formats.length);
    const ic = el('span', 'lb-ic');
    ic.innerHTML = icon(e.formats.length ? 'tab' : 'file');
    const txt = el('span', 'lb-txt');
    txt.append(el('b', '', e.title));
    if (e.context) txt.append(el('small', '', e.context));
    const fmts = el('span', 'lb-fmts');
    for (const f of e.formats) {
      const b = el('button', 'lb-badge', LABEL[f]);
      b.title = `Open ${LABEL[f]}`;
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        openEntry(e, f);
      });
      fmts.append(b);
    }
    if (e.pdf) {
      const b = el('button', 'lb-badge pdf', 'PDF');
      b.title = 'Open the PDF in a viewer';
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        openEntry(e, 'pdf');
      });
      fmts.append(b);
    }
    r.title = e.formats.length ? `${e.title}${e.context ? ' — ' + e.context : ''}` : 'The PDF opens in a viewer';
    r.append(ic, txt, fmts);
    r.addEventListener('click', () => openEntry(e));
    r.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        openEntry(e);
      }
    });
    return r;
  }

  function render() {
    ref.pdfOnly.setAttribute('aria-pressed', showPdf);
    ref.foot.textContent = dir || '';
    ref.foot.title = dir || '';
    const list = ref.list;
    const scroll = list.scrollTop;
    list.replaceChildren();
    if (!engine.isNative) {
      list.append(el('p', 'lb-note', 'The tabs folder library works in the Poly Amp app. Here you can open a file with the “Open” button.'));
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

    if (!visible.length) {
      list.append(el('p', 'lb-note', searching ? 'Nothing found.' : 'No Guitar Pro files in this folder.'
));
      return;
    }
    const groups = new Map();
    for (const e of visible) {
      if (!groups.has(e.collection)) groups.set(e.collection, []);
      groups.get(e.collection).push(e);
    }
    for (const [name, items] of groups) {
      const open = searching || !closed.has(name);
      const sec = el('section', 'lb-group' + (open ? '' : ' is-closed'));
      const h = el('button', 'lb-group-head');
      h.setAttribute('aria-expanded', open);
      h.innerHTML = icon('chevron', 'lb-chev');
      h.append(el('b', '', name), el('span', 'lb-group-count', String(items.length)));
      h.addEventListener('click', () => {
        if (searching) return;
        if (closed.has(name)) closed.delete(name);
        else closed.add(name);
        store.set('tabs.libClosed', [...closed]);
        render();
      });
      sec.append(h);
      if (open) {
        const box = el('div', 'lb-items');
        for (const e of items) box.append(row(e));
        sec.append(box);
      }
      list.append(sec);
    }
    list.scrollTop = scroll;
  }

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
    if (e.key === 'Enter') ref.list.querySelector('.lb-item')?.click(); // Enter — открыть первое найденное
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
  ref.pick.hidden = ref.refresh.hidden = !engine.isNative;
  ref.songsterr.hidden = !engine.isNative || !onSongsterr;
  ref.songsterr.addEventListener('click', () => onSongsterr?.());
  ref.tip.hidden = !engine.isNative || store.get('tabs.ssTipHidden', false);
  ref.tipClose.addEventListener('click', () => {
    ref.tip.hidden = true;
    store.set('tabs.ssTipHidden', true);
  });


  if (engine.isNative) {
    engine.on('tabsLib', (m) => {
      loaded = true;
      dir = m.dir || null;
      error = m.error || null;
      entries = buildEntries(m.items || []);
      render();
    });
  }
  render();

  return {
    /** Попросить список (при первом показе вкладки). */
    load() {
      if (engine.isNative && !loaded) engine.tabsLib();
    },
    /** Какой файл сейчас открыт — его строка подсвечивается. */
    setCurrent(rel) {
      current = rel;
      for (const r of ref.list.querySelectorAll('.lb-item.is-current')) r.classList.remove('is-current');
      if (rel) render();
    },
    focusSearch: () => ref.q.focus(),
  };
}
