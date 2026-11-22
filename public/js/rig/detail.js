// Окно выбранного слота справа, как окно плагина в DAW: что в блоке стоит, откуда это, ручки,
// порядок и удаление. Для входа и выхода — общие уровни канала.
import { BLOCKS, iconSvg } from '../blocks.js';
import { createKnob } from '../knob.js';
import { describeBlock, GEAR, hasCab, baseName } from './info.js';

const db = (v) => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(1) + ' dB';
const ARCH = { 1: 'A1', 2: 'A2' };

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function button(text, cls, onClick, title) {
  const b = el('button', cls, text);
  if (title) b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

function seg(options, value, onPick, cls = '') {
  const s = el('div', 'seg seg-dark ' + cls);
  options.forEach((label, i) => {
    const b = el('button', '', label);
    b.setAttribute('aria-pressed', i === value);
    b.addEventListener('click', () => {
      for (const x of s.children) x.setAttribute('aria-pressed', x === b);
      onPick(i);
    });
    s.append(b);
  });
  return s;
}

export function createDetail(host, { chain, engine, store, t3k, tones, onSelect, onDownload, onUserFile, getDownload = () => null }) {
  host.classList.add('detail');
  const native = engine.isNative;
  let knobs = {}; // имя параметра → ручка, чтобы обновлять без перерисовки

  function head(color, icon, title, sub, tools) {
    host.style.setProperty('--c', color);
    const h = el('header', 'dt-head');
    const ic = el('div', 'dt-icon');
    ic.innerHTML = iconSvg(icon);
    const t = el('div', 'dt-title');
    t.append(el('h3', '', title));
    if (sub) t.append(sub instanceof Node ? sub : el('span', '', sub));
    h.append(ic, t);
    if (tools) h.append(tools);
    return h;
  }

  // ---------- вход и выход ----------
  function renderGlobal(kind) {
    knobs = {};
    const isIn = kind === 'in';
    const nodes = [
      head('#9aa3b5', isIn ? 'gate' : 'reverb', isIn ? 'Input' : 'Output',
        isIn ? 'guitar level before the chain — raise it if the signal is quiet' : 'master level after the chain'),
    ];
    const row = el('div', 'dt-knobs');
    const name = isIn ? 'in.gain' : 'out.level';
    const k = createKnob({
      label: isIn ? 'Gain' : 'Level', min: isIn ? -12 : -40, max: isIn ? 24 : 6, def: isIn ? 0 : -6,
      value: chain.global(name), fmt: db, size: 76,
      onChange: (v) => chain.setGlobal(name, v, 'detail'),
    });
    knobs[name] = k;
    row.append(k.el);
    if (!isIn) {
      const muted = chain.global('out.mute') > 0.5;
      const m = button(muted ? 'Muted' : 'Mute', 'rbtn mute' + (muted ? ' is-muted' : ''), () =>
        chain.setGlobal('out.mute', chain.global('out.mute') > 0.5 ? 0 : 1, 'detail'), 'Mute the guitar at the output');
      row.append(m);
    }
    nodes.push(row, el('p', 'dt-note', 'Set these levels once for your guitar and headphones.'));
    host.replaceChildren(...nodes);
  }

  // ---------- блок ----------
  function tools(b) {
    const i = chain.index(b.id);
    const n = chain.blocks().length;
    const box = el('div', 'dt-tools');
    const up = button('↑', 'rb', () => chain.move(b.id, i - 1), 'Move up the chain (earlier)');
    const down = button('↓', 'rb', () => chain.move(b.id, i + 1), 'Move down the chain (later)');
    up.disabled = i <= 0;
    down.disabled = i >= n - 1;
    up.setAttribute('aria-label', 'Move up');
    down.setAttribute('aria-label', 'Move down');
    const power = el('button', 'power');
    power.setAttribute('aria-pressed', b.on);
    power.setAttribute('aria-label', b.on ? 'Turn the block off' : 'Turn the block on');
    power.title = b.on ? 'Block is on' : 'Block is off (bypassed)';
    power.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 3v8M6.300 6.800a8 8 0 1 0 11.400 0"/></svg>';
    power.addEventListener('click', () => chain.setOn(b.id, !b.on, 'ui'));
    const del = button('', 'rb del', () => {
      const next = chain.blocks()[i + 1] || chain.blocks()[i - 1];
      chain.remove(b.id);
      onSelect(next ? next.id : 'in');
    }, 'Remove the block from the chain');
    del.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/></svg>';
    del.setAttribute('aria-label', 'Remove block');
    box.append(up, down, power, del);
    return box;
  }

  function libraryOptions(b) {
    const select = el('select', 'select select-dark');
    select.setAttribute('aria-label', 'What’s in the block');
    const mine = (engine.library || []).filter((x) => x.slot === b.type);
    const groups = [];
    if (mine.length) {
      const g = document.createElement('optgroup');
      g.label = 'My TONE3000 tones';
      for (const x of mine) {
        const o = el('option', '', x.model && x.model !== x.title ? `${x.title} — ${x.model}` : x.title);
        o.value = x.path;
        g.append(o);
      }
      groups.push(g);
    }
    if (b.file && !mine.some((x) => x.path === b.file)) {
      const g = document.createElement('optgroup');
      g.label = 'Your file';
      const o = el('option', '', baseName(b.file));
      o.value = b.file;
      g.append(o);
      groups.push(g);
    }
    const none = el('option', '', mine.length ? '— empty —' : '— empty: download a tone or open a file —');
    none.value = '';
    select.replaceChildren(...groups, none);
    select.value = b.file || '';
    select.addEventListener('change', () => {
      chain.setFile(b.id, select.value || null, 'user');
      if (select.value) onUserFile(b.id);
    });
    return select;
  }

  function toneArea(b, info) {
    const d = BLOCKS[b.type];
    const area = el('div', 'dt-tone');
    const cover = el('div', 'dt-cover');
    if (info.cover) {
      const img = el('img');
      img.src = info.cover;
      img.alt = '';
      img.addEventListener('error', () => img.remove());
      cover.append(img);
    } else cover.innerHTML = iconSvg(d.icon);

    const text = el('div', 'dt-tone-text');
    text.append(el('b', '', info.title));
    const meta = el('span', 'dt-meta' + (info.state === 'error' ? ' is-error' : ''));
    const bits = [];
    if (info.t3k) bits.push('TONE3000');
    bits.push(info.sub);
    if (info.creator) bits.push(info.creator);
    meta.textContent = bits.filter(Boolean).join(' · ');
    if (info.url && info.state === 'ok') {
      meta.classList.add('is-link');
      meta.title = 'Open the tone page on TONE3000';
      meta.addEventListener('click', () => engine.openUrl(info.url));
    }
    text.append(meta);
    area.append(cover, text);

    const actions = el('div', 'dt-actions');
    if (native) {
      actions.append(libraryOptions(b));
      if (info.slimmable) {
        const s = seg(['Full', 'Lite'], info.modelSize >= 0.5 ? 0 : 1, (i) => chain.setSize(b.id, i === 0 ? 1 : 0), 'seg-size');
        s.title = 'An A2 file has two model sizes: Full is more accurate, Lite is lighter on the CPU';
        actions.append(s);
      }
      const t3kRow = el('div', 'dt-t3k');
      const arch = store.get('t3k.arch', '2');
      t3kRow.append(button('TONE3000', 'btn-t3k', () => t3k.open(d.t3k, store.get('t3k.arch', '2'), b.id),
        'Choose from the TONE3000 catalog'));
      if (d.file === 'nam') {
        const s = seg(['A2', 'A1'], arch === '1' ? 1 : 0, (i) => store.set('t3k.arch', i === 1 ? '1' : '2'), 'seg-arch');
        s.title = 'Which models to show in the catalog: A2 is the new standard, A1 the older one';
        t3kRow.append(s);
      }
      t3kRow.append(button('File…', 'rbtn', () => engine.pickFile(b.id, d.file), 'Open your own file from disk'));
      // так требуют условия API TONE3000: подпись и ссылка на их сайт
      t3kRow.append(button('Powered by TONE3000', 'dt-powered', () => engine.openUrl('https://www.tone3000.com'), 'tone3000.com'));
      actions.append(t3kRow);
    }
    area.append(actions);
    return area;
  }

  function notes(b, info) {
    const out = [];
    if (!native && BLOCKS[b.type].file) {
      out.push(el('p', 'dt-note', 'TONE3000 tones download and play in the Poly Amp app.'));
      return out;
    }
    const tone = b.standIn ? b.standIn.tone : info.state === 'pending' ? b.tone : null;
    if (tone) {
      const box = el('div', 'dt-callout');
      const p = el('p');
      if (b.standIn) {
        p.append('A built-in block is playing here for now in place of ');
        p.append(el('b', '', tone.title));
        p.append(' from TONE3000. Download the tone and it will take its place.');
      } else {
        p.append('The tone ');
        p.append(el('b', '', tone.title));
        p.append(' isn’t downloaded yet, so the block is silent for now.');
      }
      box.append(p);
      const dl = getDownload();
      if (dl?.stage === 'progress') box.append(el('p', 'dt-dl', `Downloading ${dl.index + 1} of ${dl.total}: “${dl.title}”. If TONE3000 asks you to sign in, sign in — the rest downloads by itself.`));
      else if (dl?.stage === 'done' && dl.errors.length) box.append(el('p', 'dt-dl is-bad', 'Not all tones downloaded. ' + dl.errors.join('; ')));
      if (native) {
        const go = button(tones.busy ? 'Downloading…' : dl?.errors?.length ? 'Try again' : 'Download tones', 'btn-t3k', () => onDownload());
        go.disabled = tones.busy;
        box.append(go);
      }
      out.push(box);
    }
    if (b.type === 'amp' && info.state === 'ok' && hasCab(info.gear)) {
      const after = chain.blocks().slice(chain.index(b.id) + 1).some((x) => x.on && (x.type === 'cab' || x.type === 'polycab'));
      out.push(el('p', 'dt-note' + (after ? ' warn' : ''), after
        ? 'This model already includes a cab, and there’s another one after it — the sound will be muffled. Turn off the extra cab.'
        : `Model type: ${GEAR[info.gear] || 'amp + cab'} — it doesn’t need a separate cab after it.`));
    }
    if (b.type === 'amp' && info.state === 'ok' && !hasCab(info.gear) && info.gear) {
      const cab = chain.blocks().slice(chain.index(b.id) + 1).some((x) => x.on && (x.type === 'cab' || x.type === 'polycab'));
      if (!cab) out.push(el('p', 'dt-note warn', 'This is an amp only, without a cab — add a cab after it, otherwise the sound will be harsh.'));
    }
    return out;
  }

  function knobRow(b) {
    const d = BLOCKS[b.type];
    const row = el('div', 'dt-knobs');
    for (const [name, p] of Object.entries(d.params)) {
      if (p.choices) {
        const box = el('div', 'dt-choice');
        box.append(el('span', 'dt-choice-label', p.label), seg(p.choices, b.params[name], (i) => chain.setParam(b.id, name, i, 'detail')));
        row.prepend(box);
        continue;
      }
      const k = createKnob({
        label: p.label, min: p.min, max: p.max, def: p.def, value: b.params[name], fmt: p.fmt, size: 68,
        onChange: (v) => chain.setParam(b.id, name, v, 'knob'),
      });
      knobs[name] = k;
      row.append(k.el);
    }
    return row;
  }

  function renderBlock(b) {
    knobs = {};
    const d = BLOCKS[b.type];
    const info = describeBlock(b, engine);
    const sub = el('span', '', d.file ? d.role : info.sub === d.role ? d.role : `${d.role} · ${info.sub}`);
    const nodes = [head(d.color, d.icon, d.file ? d.name : info.title, sub, tools(b))];
    if (d.file) nodes.push(toneArea(b, info));
    nodes.push(...notes(b, info));
    if (d.file && info.state === 'empty' && native) nodes.push(el('p', 'dt-note', d.empty));
    nodes.push(knobRow(b));
    host.classList.toggle('is-off', !b.on);
    host.replaceChildren(...nodes);
  }

  let current = null;
  function render(selected) {
    current = selected;
    host.classList.remove('is-off');
    if (selected === 'in' || selected === 'out') return renderGlobal(selected);
    const b = chain.get(selected);
    if (b) return renderBlock(b);
    knobs = {};
    host.style.setProperty('--c', '#9aa3b5');
    host.replaceChildren(el('p', 'dt-empty', 'Select a slot in the channel to see its controls.'));
  }

  // ручки, которые поменялись не из этого окна (например, выход заглушили клавишей G)
  chain.on((what, d) => {
    if (what === 'global' && d.source !== 'detail' && knobs[d.name]) knobs[d.name].set(d.value, true);
    if (what === 'global' && d.name === 'out.mute' && current === 'out') render('out');
    if (what === 'param' && d.source !== 'knob' && d.source !== 'detail' && d.id === current && knobs[d.name]) knobs[d.name].set(d.value, true);
  });

  return { render, get current() { return current; } };
}
