// Состояние цепочки: какие блоки, в каком порядке, с какими ручками и файлами.
// Интерфейс меняет цепочку здесь, а модуль сам сообщает об этом движку и сохраняет её.
import { BLOCKS, makeBlock } from './blocks.js';

const GLOBAL_DEFAULTS = { 'in.gain': 0, 'out.level': -6, 'out.mute': 0, 'synth.level': 0.8, 'master.level': 0, 'master.mute': 0 };
export const GLOBALS = {
  'in.gain': { min: -12, max: 24 },
  'out.level': { min: -40, max: 6 },
  'out.mute': { min: 0, max: 1 },
  'synth.level': { min: 0, max: 1 },
  'master.level': { min: -40, max: 6 }, // общая громкость: гитара, метроном, ноты и табы
  'master.mute': { min: 0, max: 1 },
};

export function createChain(engine, store, initialBlocks) {
  const globals = { ...GLOBAL_DEFAULTS };
  // уровни из прежней версии (три гнезда) хранились вместе с ручками — переносим их при первом запуске
  const savedGlobals = store.get('rig.globals', null) || store.get('rig.state', null) || {};
  for (const [k, v] of Object.entries(savedGlobals)) if (k in globals && typeof v === 'number') globals[k] = v;
  globals['master.mute'] = 0; // «выключить всё» — на минутку; при следующем запуске звук снова есть
  const saved = store.get('rig.chain', null);
  let blocks = (Array.isArray(saved) ? saved : initialBlocks)
    .filter((b) => b && BLOCKS[b.type])
    .map((b) => makeBlock(b.type, b));

  const subs = new Set();
  const emit = (what, detail = {}) => {
    for (const fn of subs) fn(what, detail);
  };
  let saveTimer = null;
  const save = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      store.set('rig.chain', blocks);
      store.set('rig.globals', globals);
    }, 300);
  };
  const clamp = (type, name, v) => {
    const d = BLOCKS[type].params[name];
    if (!d || typeof v !== 'number' || Number.isNaN(v)) return null;
    if (d.choices) return Math.max(0, Math.min(d.choices.length - 1, Math.round(v)));
    return Math.max(d.min, Math.min(d.max, v));
  };
  /** Цепочка в том виде, в каком её ждёт движок. */
  const wire = () => blocks.map((b) => ({ id: b.id, type: b.type, on: b.on ? 1 : 0, file: b.file, size: b.size, params: b.params }));
  const pushAll = () => engine.setChain(wire());
  const changed = (what, detail) => {
    pushAll();
    save();
    emit(what, detail);
  };

  const api = {
    blocks: () => blocks,
    get: (id) => blocks.find((b) => b.id === id),
    index: (id) => blocks.findIndex((b) => b.id === id),

    /** Добавить блок на место index (в конец, если не задано). Возвращает id. */
    add(type, index = blocks.length, init = {}) {
      const b = makeBlock(type, init);
      blocks.splice(Math.max(0, Math.min(blocks.length, index)), 0, b);
      changed('structure', { added: b.id });
      return b.id;
    },
    remove(id) {
      blocks = blocks.filter((b) => b.id !== id);
      changed('structure', { removed: id });
    },
    /** Переставить блок на место toIndex (в нумерации после удаления блока со старого места). */
    move(id, toIndex) {
      const from = api.index(id);
      if (from < 0) return;
      const [b] = blocks.splice(from, 1);
      blocks.splice(Math.max(0, Math.min(blocks.length, toIndex)), 0, b);
      if (blocks.indexOf(b) === from) return;
      changed('structure', { moved: id });
    },
    /**
     * Заменить цепочку целиком. detail уходит подписчикам: { auto: true } — цепочку поправило само приложение
     * (например, подставило скачанный тон).
     */
    replaceAll(next, detail = {}) {
      blocks = next.filter((b) => b && BLOCKS[b.type]).map((b) => makeBlock(b.type, b));
      changed('structure', detail);
    },

    setParam(id, name, value, source) {
      const b = api.get(id);
      if (!b) return;
      const v = clamp(b.type, name, value);
      if (v == null || b.params[name] === v) return;
      b.params[name] = v;
      engine.blockParam(id, { [name]: v });
      save();
      emit('param', { id, name, value: v, source });
    },
    setOn(id, on, source) {
      const b = api.get(id);
      if (!b || b.on === on) return;
      b.on = on;
      engine.blockOn(id, on);
      save();
      emit('on', { id, source });
    },
    /** Поставить файл в блок; source 'auto' — приложение подставило его само (не меняет пресет). */
    setFile(id, path, source) {
      const b = api.get(id);
      if (!b || b.file === (path || null)) return;
      b.file = path || null;
      if (source === 'user') b.tone = null; // свой выбор заменяет тон пресета
      changed('file', { id, source }); // файл загружает движок, о результате сообщит событием «block»
    },
    setSize(id, size) {
      const b = api.get(id);
      if (!b || b.size === size) return;
      b.size = size;
      engine.blockSize(id, size);
      save();
      emit('size', { id });
    },

    global: (name) => globals[name],
    setGlobal(name, value, source) {
      const d = GLOBALS[name];
      if (!d || typeof value !== 'number') return;
      value = Math.max(d.min, Math.min(d.max, value));
      if (globals[name] === value) return;
      globals[name] = value;
      engine.setGlobals({ [name]: value });
      save();
      emit('global', { name, value, source });
    },

    on(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    /** Отправить движку всё состояние (после запуска или переоткрытия звука). */
    sync() {
      engine.setGlobals({ ...globals });
      pushAll();
    },
  };
  api.sync();
  return api;
}
