// Область «Играть»: доска с цепочкой блоков, панель выбранного блока и список пресетов.
// Цепочка любая: сколько угодно педалей, усилителей, кабинетов и ревербераторов в любом порядке —
// встроенных или с TONE3000.
import { BLOCKS } from '../blocks.js';
import { COLLECTIONS, DEFAULT_PRESET, findPreset } from '../presets.js';
import { createBoard } from '../rig/board.js';
import { createDetail } from '../rig/detail.js';
import { createBrowser } from '../rig/browser.js';
import { createTones } from '../rig/tones.js';
import { createPlayer } from '../rig/player.js';
import { hasCab } from '../rig/info.js';

const plural = (n, one, other) => (n === 1 ? one : other);

export function createRig(root, { engine, store, chain, t3k }) {
  const native = engine.isNative;
  root.innerHTML = `
    <div class="rig">
      <div class="rig-top">
        <div class="rig-preset">
          <button class="rb" data-ref="prev" aria-label="Previous preset" title="Previous preset (←)">‹</button>
          <div class="rig-name"><small data-ref="colName"></small><b data-ref="presetName"></b></div>
          <button class="rb" data-ref="next" aria-label="Next preset" title="Next preset (→)">›</button>
        </div>
        <div class="rig-actions">
          <span class="rig-dirty" data-ref="dirty" hidden>modified</span>
          <button class="rbtn" data-ref="revert" hidden title="Revert the preset to how it was">Revert</button>
          <button class="rbtn" data-ref="save" title="Save the sound as your preset (Ctrl+S)">Save</button>
          <span class="rig-form" data-ref="form" hidden>
            <input class="text-input input-dark" data-ref="name" maxlength="40" placeholder="Preset name" spellcheck="false">
            <button class="rbtn rbtn-accent" data-ref="ok">Save</button>
            <button class="rbtn" data-ref="cancel">Cancel</button>
          </span>
        </div>
        <div data-ref="player"></div>
        <div class="rig-meters" data-ref="meters">
          <div class="cpu" title="CPU load of audio processing">CPU <b data-ref="cpu">0</b>%</div>
        </div>
      </div>
      <div class="rig-banner" data-ref="banner" hidden>
        <div class="rig-banner-text" data-ref="bannerText"></div>
        <button class="btn-t3k" data-ref="bannerGo"></button>
        <button class="rb" data-ref="bannerClose" aria-label="Hide" hidden>×</button>
      </div>
      <div class="rig-body">
        <aside data-ref="browser" aria-label="Presets"></aside>
        <div class="rig-main">
          <div data-ref="board"></div>
          <div data-ref="detail"></div>
        </div>
      </div>
    </div>`;
  const ref = {};
  for (const n of root.querySelectorAll('[data-ref]')) ref[n.dataset.ref] = n;

  const tones = createTones({ engine, chain, t3k });
  const player = createPlayer(ref.player, { engine, store, rigRoot: root.querySelector('.rig') });
  ref.player.hidden = !native;

  // ---------- выбор блока ----------
  let selected = store.get('rig.selected', null);
  const getSelected = () => selected;
  function select(id) {
    selected = id;
    store.set('rig.selected', id);
    board.highlight();
    detail.render(id);
  }
  function selectDefault() {
    const bs = chain.blocks();
    const pick = bs.find((b) => b.type === 'amp' || b.type === 'polyamp' || b.standIn?.type === 'amp') || bs.find((b) => BLOCKS[b.type].file) || bs[0];
    select(pick ? pick.id : 'in');
  }

  // ---------- пресеты ----------
  let current = store.get('rig.current', null) || DEFAULT_PRESET;
  let dirty = store.get('rig.dirty', false);
  const userPresets = () => {
    const list = store.get('rig.userPresets', []);
    return Array.isArray(list) ? list.filter((p) => p && typeof p.name === 'string' && Array.isArray(p.blocks)) : [];
  };
  const flat = () => [
    ...COLLECTIONS.flatMap((c) => c.presets.map((p) => ({ col: c.id, id: p.id }))),
    ...userPresets().map((p) => ({ user: p.name })),
  ];
  const same = (a, b) => (a.user != null ? a.user === b.user : a.col === b.col && a.id === b.id);

  function setClean() {
    dirty = false;
    store.set('rig.current', current);
    store.set('rig.dirty', false);
  }
  function markDirty() {
    if (dirty) return;
    dirty = true;
    store.set('rig.dirty', true);
    renderTop();
    browser.render();
  }

  function apply(target) {
    let blocks;
    if (target.user != null) {
      const p = userPresets().find((x) => x.name === target.user);
      if (!p) return;
      blocks = p.blocks;
    } else {
      const f = findPreset(target);
      if (!f) return;
      blocks = f.preset.blocks;
    }
    current = target.user != null ? { user: target.user } : { col: target.col, id: target.id };
    setClean();
    chain.replaceAll(tones.expand(blocks), { preset: true });
    tones.resolve();
    hideBannerResult();
    selectDefault();
    renderTop();
    browser.render();
  }

  function step(dir) {
    const list = flat();
    const i = list.findIndex((p) => same(p, current));
    apply(list[(i + dir + list.length) % list.length]);
  }

  function renderTop() {
    if (current.user != null) {
      ref.colName.textContent = 'My presets';
      ref.presetName.textContent = current.user;
    } else {
      const f = findPreset(current);
      ref.colName.textContent = f ? f.col.title : '';
      ref.presetName.textContent = f ? f.preset.name : 'Custom sound';
      ref.presetName.title = f ? f.preset.note : '';
    }
    ref.dirty.hidden = !dirty;
    ref.revert.hidden = !dirty;
    renderBanner();
  }

  const browser = createBrowser(ref.browser, {
    store,
    getState: () => ({ current, dirty, user: userPresets() }),
    presetMissing: (blocks) => native && tones.presetMissing(blocks),
    onFactory: (col, id) => apply({ col, id }),
    onUser: (name) => apply({ user: name }),
    onDeleteUser: (name) => {
      store.set('rig.userPresets', userPresets().filter((p) => p.name !== name));
      if (current.user === name) {
        current = DEFAULT_PRESET; // цепочка остаётся как есть, но это уже не сохранённый пресет
        markDirty();
        renderTop();
      }
      browser.render();
    },
  });

  ref.prev.addEventListener('click', () => step(-1));
  ref.next.addEventListener('click', () => step(1));
  ref.revert.addEventListener('click', () => apply(current));

  // сохранение своего пресета
  const openForm = () => {
    ref.form.hidden = false;
    ref.save.hidden = true;
    ref.name.value = current.user != null ? current.user : '';
    ref.name.placeholder = 'Preset name';
    ref.name.focus();
  };
  const closeForm = () => {
    ref.form.hidden = true;
    ref.save.hidden = false;
  };
  const commit = () => {
    const name = ref.name.value.trim();
    if (!name) return ref.name.focus();
    const list = userPresets().filter((p) => p.name !== name);
    list.push({ name, blocks: chain.snapshot() });
    store.set('rig.userPresets', list);
    current = { user: name };
    setClean();
    closeForm();
    renderTop();
    browser.render();
  };
  ref.save.addEventListener('click', openForm);
  ref.ok.addEventListener('click', commit);
  ref.cancel.addEventListener('click', closeForm);
  ref.name.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') commit();
    if (e.key === 'Escape') closeForm();
  });

  // ---------- скачивание тонов пресета ----------
  let result = null; // итог последнего скачивания, пока его не закрыли
  function hideBannerResult() {
    result = null;
  }

  function download() {
    result = null;
    tones.download((s) => {
      if (s.stage === 'progress') {
        progress = s;
      } else {
        progress = null;
        result = s;
      }
      renderBanner();
      detail.render(selected);
    });
  }
  let progress = null;

  function renderBanner() {
    const missing = native ? tones.missing() : [];
    const go = ref.bannerGo;
    ref.bannerClose.hidden = true;
    go.hidden = false;
    go.disabled = false;
    ref.banner.classList.remove('is-bad', 'is-good');
    if (progress) {
      ref.bannerText.textContent = `Downloading tone ${progress.index + 1} of ${progress.total}: “${progress.title}”. If TONE3000 asks you to sign in, sign in to your account — the rest downloads by itself.`;
      go.textContent = 'Downloading…';
      go.disabled = true;
    } else if (result && result.stage === 'done' && result.errors.length) {
      ref.banner.classList.add('is-bad');
      ref.bannerText.textContent = `Not all tones downloaded. ${result.errors.join('; ')}`;
      go.textContent = 'Try again';
      go.hidden = !missing.length;
      ref.bannerClose.hidden = false;
    } else if (result && result.stage === 'done' && result.count) {
      ref.banner.classList.add('is-good');
      ref.bannerText.textContent = `Done: ${result.count} ${plural(result.count, 'tone', 'tones')} downloaded and already in the chain.`;
      go.hidden = true;
      ref.bannerClose.hidden = false;
    } else if (missing.length) {
      const names = missing.map((t) => t.title).join(', ');
      ref.bannerText.textContent = `This preset uses ${missing.length} ${plural(missing.length, 'tone', 'tones')} from TONE3000: ${names}. Until they’re downloaded, built-in blocks play in their place.`;
      go.textContent = missing.length > 1 ? `Download ${missing.length} tones` : 'Download tone';

    } else {
      ref.banner.hidden = true;
      return;
    }
    ref.banner.hidden = false;
  }
  ref.bannerGo.addEventListener('click', download);
  ref.bannerClose.addEventListener('click', () => {
    result = null;
    renderBanner();
  });

  // ---------- доска и панель блока ----------
  // после того как пользователь сам поставил модель усилителя, проверим, нет ли в ней кабинета
  const cabCheck = new Set();
  const board = createBoard(ref.board, { chain, engine, getSelected, onSelect: select });
  const detail = createDetail(ref.detail, {
    chain, engine, store, t3k, tones,
    onSelect: select,
    onDownload: download,
    onUserFile: (id) => cabCheck.add(id),
  });

  chain.on((what, d) => {
    if (what === 'global') return;
    const auto = (what === 'structure' && (d.preset || d.auto)) || (what === 'file' && d.source === 'auto');
    if (!auto && what !== 'size') markDirty();
    if (what === 'param') {
      if (BLOCKS[chain.get(d.id)?.type]?.params[d.name]?.choices) board.render();
      return;
    }
    if (what === 'size') return;
    board.render();
    if (what === 'structure' && d.added) select(d.added);
    else if (what === 'structure' && selected !== 'in' && selected !== 'out' && !chain.get(selected)) selectDefault();
    else detail.render(selected);
    if (what === 'structure' || what === 'file') {
      renderBanner();
      browser.render();
    }
  });

  if (native) {
    engine.on('block', (m) => {
      board.render();
      if (m.id === selected) detail.render(selected);
      // модель «усилитель + кабинет»: отдельные кабинеты после неё выключаем, чтобы не было двойного кабинета
      if (cabCheck.has(m.id) && (m.loaded || m.error)) {
        cabCheck.delete(m.id);
        const b = chain.get(m.id);
        const gear = (m.source && m.source.gear) || m.gear;
        if (b && b.type === 'amp' && m.loaded && hasCab(gear)) {
          for (const x of chain.blocks().slice(chain.index(b.id) + 1)) {
            if (x.on && (x.type === 'cab' || x.type === 'polycab')) chain.setOn(x.id, false, 'auto');
          }
        }
      }
    });
    engine.on('library', () => {
      tones.resolve();
      browser.render();
      renderBanner();
      if (BLOCKS[chain.get(selected)?.type]?.file) detail.render(selected);
    });
    engine.on('picked', (m) => {
      if (!chain.get(m.id)) return;
      cabCheck.add(m.id);
      chain.setFile(m.id, m.path, 'user');
    });
    // тон выбран в каталоге TONE3000 и скачан: ставим его в блок, для которого открывали каталог
    engine.on('t3k', (m) => {
      if (m.stage !== 'done' || !m.path) return;
      const target = m.blockId && chain.get(m.blockId);
      if (target && target.type === m.kind) {
        cabCheck.add(target.id);
        chain.setFile(target.id, m.path, 'user');
        select(target.id);
        return;
      }
      // блок успели убрать — ставим новый после выбранного
      const at = chain.get(selected) ? chain.index(selected) + 1 : chain.blocks().length;
      const id = chain.add(m.kind, at, { file: m.path });
      cabCheck.add(id);
    });
  }

  // ---------- индикаторы ----------
  ref.meters.hidden = !native;
  const hold = { inPk: 0, outPk: 0 };
  let off = null;
  let active = false;
  let lastCpu = -1;
  function onFrame() {
    const m = engine.meters;
    if (!m) return;
    hold.inPk = Math.max(m.inPk, hold.inPk * 0.86);
    hold.outPk = Math.max(m.outPk, hold.outPk * 0.86);
    board.setMeters(hold.inPk, hold.outPk);
    player.frame(m);
    const cpu = Math.round(m.cpu * 100);
    if (cpu !== lastCpu) ref.cpu.textContent = lastCpu = cpu;
  }

  // ---------- старт ----------
  if (!findPreset(current) && current.user == null) current = DEFAULT_PRESET;
  if (current.user != null && !userPresets().some((p) => p.name === current.user)) current = DEFAULT_PRESET;
  if (selected !== 'in' && selected !== 'out' && !chain.get(selected)) selectDefault();
  else select(selected);
  board.render();
  renderTop();
  browser.render();

  return {
    setActive(on) {
      active = on;
      if (on && !off && native) off = engine.on('frame', onFrame);
      if (!on) player.stop();
      if (!on && off) {
        off();
        off = null;
      }
      if (!on) board.closeMenu();
    },
    /** Горячие клавиши экрана (k — из app.js: 'space', 'left', 'ctrl+s'…). true — клавиша обработана. */
    onKey(k, e) {
      switch (k) {
        case 'space':
          if (!native) return false;
          if (!e.repeat) player.toggle();
          return true;
        case 'b':
          if (!native) return false;
          if (!e.repeat) ref.player.querySelector('.sp-bypass').click();
          return true;
        case 'left':
        case 'right':
          if (!e.repeat) step(k === 'left' ? -1 : 1);
          return true;
        case 'ctrl+s':
          openForm();
          return true;
      }
      return false;
    },
    /** Для проверок и консоли. */
    apply,
    tones,
  };
}
