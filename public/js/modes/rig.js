// Область «Play», как в DAW: слева браузер эффектов и тонов TONE3000, посередине канал со слотами,
// справа окно выбранного блока с его ручками. Цепочка любая: сколько угодно педалей, усилителей,
// кабинетов и ревербераторов в любом порядке — встроенных или с TONE3000.
import { BLOCKS } from '../blocks.js';
import { createBrowser } from '../rig/browser.js';
import { createSlots } from '../rig/slots.js';
import { createDetail } from '../rig/detail.js';
import { createTones } from '../rig/tones.js';
import { hasCab } from '../rig/info.js';

export function createRig(root, { engine, store, chain, t3k }) {
  const native = engine.isNative;
  root.innerHTML = `
    <div class="rig pl">
      <div class="pl-top">
        <div class="pl-title"><small>Play</small><b>Guitar channel</b></div>
        <span class="pl-sp"></span>
        <button class="rbtn pl-bypass" data-ref="bypass" aria-pressed="false" title="Turn off the whole chain and hear the dry guitar — to compare (B)">Bypass</button>
        <div class="cpu" data-ref="meters" title="CPU load of audio processing">CPU <b data-ref="cpu">0</b>%</div>
      </div>
      <div class="pl-body">
        <aside data-ref="browser" aria-label="Effects and tones"></aside>
        <section data-ref="channel" aria-label="Guitar channel"></section>
        <section class="pl-win" data-ref="detail" aria-label="Selected block"></section>
      </div>
    </div>`;
  const ref = {};
  for (const n of root.querySelectorAll('[data-ref]')) ref[n.dataset.ref] = n;
  const rigEl = root.querySelector('.rig');
  ref.bypass.hidden = !native;
  ref.meters.hidden = !native;

  const tones = createTones({ engine, chain, t3k });

  // ---------- выбор блока ----------
  let selected = store.get('rig.selected', null);
  const getSelected = () => selected;
  function select(id) {
    selected = id;
    store.set('rig.selected', id);
    slots.highlight();
    detail.render(id);
  }
  function selectDefault() {
    const bs = chain.blocks();
    const pick = bs.find((b) => b.type === 'amp' || b.type === 'polyamp' || b.standIn?.type === 'amp') || bs.find((b) => BLOCKS[b.type].file) || bs[0];
    select(pick ? pick.id : 'in');
  }

  // ---------- добавление из браузера и меню слота ----------
  // после того как пользователь сам поставил модель усилителя, проверим, нет ли в ней кабинета
  const cabCheck = new Set();
  function add(payload, at) {
    if (!payload || !BLOCKS[payload.type]) return;
    const index = at ?? (chain.get(selected) ? chain.index(selected) + 1 : chain.blocks().length);
    const id = chain.add(payload.type, index, payload.file ? { file: payload.file } : {});
    if (payload.file) cabCheck.add(id);
  }

  // ---------- тоны, которые цепочка ждёт с TONE3000 (встроенный блок пока играет вместо них) ----------
  let dl = null; // ход последнего скачивания: показываем в окне блока
  function download() {
    dl = null;
    tones.download((s) => {
      dl = s.stage === 'done' && !s.errors.length ? null : s;
      detail.render(selected);
    });
  }

  const browser = createBrowser(ref.browser, { engine, store, t3k, onAdd: (p) => add(p) });
  const slots = createSlots(ref.channel, { chain, engine, getSelected, onSelect: select, onAdd: add });
  const detail = createDetail(ref.detail, {
    chain, engine, store, t3k, tones,
    onSelect: select,
    onDownload: download,
    onUserFile: (id) => cabCheck.add(id),
    getDownload: () => dl,
  });

  chain.on((what, d) => {
    if (what === 'global') return slots.updateIO();
    if (what === 'param') {
      if (BLOCKS[chain.get(d.id)?.type]?.params[d.name]?.choices) slots.render();
      return;
    }
    if (what === 'size') return;
    slots.render();
    if (what === 'structure' && d.added) select(d.added);
    else if (what === 'structure' && selected !== 'in' && selected !== 'out' && !chain.get(selected)) selectDefault();
    else detail.render(selected);
  });

  if (native) {
    engine.on('block', (m) => {
      slots.render();
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
      if (BLOCKS[chain.get(selected)?.type]?.file) detail.render(selected);
    });
    engine.on('picked', (m) => {
      if (!chain.get(m.id)) return;
      cabCheck.add(m.id);
      chain.setFile(m.id, m.path, 'user');
    });
    // тон выбран в каталоге TONE3000 и скачан: ставим его в блок, для которого открывали каталог,
    // а если каталог открыли из браузера — новым слотом после выбранного
    engine.on('t3k', (m) => {
      if (m.stage !== 'done' || !m.path) return;
      const target = m.blockId && chain.get(m.blockId);
      if (target && target.type === m.kind) {
        cabCheck.add(target.id);
        chain.setFile(target.id, m.path, 'user');
        select(target.id);
        return;
      }
      add({ type: m.kind, file: m.path });
    });
  }

  // ---------- обход: вся цепочка выключена, слышна сухая гитара ----------
  let bypass = false;
  function setBypass(on) {
    if (bypass === on) return;
    bypass = on;
    if (native) engine.setBypass(on);
    ref.bypass.setAttribute('aria-pressed', on);
    rigEl.classList.toggle('is-bypass', on);
  }
  ref.bypass.addEventListener('click', () => setBypass(!bypass));

  // ---------- индикаторы ----------
  const hold = { inPk: 0, outPk: 0 };
  let off = null;
  let lastCpu = -1;
  function onFrame() {
    const m = engine.meters;
    if (!m) return;
    hold.inPk = Math.max(m.inPk, hold.inPk * 0.86);
    hold.outPk = Math.max(m.outPk, hold.outPk * 0.86);
    slots.setMeters(hold.inPk, hold.outPk);
    const cpu = Math.round(m.cpu * 100);
    if (cpu !== lastCpu) ref.cpu.textContent = lastCpu = cpu;
  }

  // ---------- старт ----------
  if (selected !== 'in' && selected !== 'out' && !chain.get(selected)) selectDefault();
  else select(selected);

  return {
    setActive(on) {
      if (on && !off && native) off = engine.on('frame', onFrame);
      if (!on && off) {
        off();
        off = null;
      }
      if (!on) {
        setBypass(false); // ушёл с экрана — в упражнениях и табах снова звучит обработанная гитара
        slots.closeMenu();
      }
    },
    /** Горячие клавиши экрана (k — из app.js). true — клавиша обработана. */
    onKey(k, e) {
      if (k === 'b' && native) {
        if (!e.repeat) setBypass(!bypass);
        return true;
      }
      return false;
    },
    /** Для проверок и консоли. */
    tones,
    browser,
    get bypass() {
      return bypass;
    },
  };
}
