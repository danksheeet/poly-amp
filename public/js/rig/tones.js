// Тоны TONE3000, которых цепочка ждёт по ссылке (так их сохраняли прежние версии с пресетами):
// найти уже скачанные в «Моих тонах», подставить их в цепочку, скачать недостающие.

/** Тон однозначно задают номер и подсказка, какой вариант из него взять. */
const toneKey = (t) => t.id + '|' + (t.match || '');

export function createTones({ engine, chain, t3k }) {
  const fresh = new Map(); // toneId → путь: только что скачанное, пока не пришёл новый список библиотеки
  let busy = false;

  /** Путь к уже скачанному файлу тона или null. */
  function findPath(tone) {
    if (!tone) return null;
    const items = (engine.library || []).filter((x) => x.toneId === tone.id && x.path);
    const key = toneKey(tone);
    if (tone.match) {
      // в одном тоне бывает несколько вариантов (Clean, Bright, Hall, Spring…) — нужен именно указанный
      try {
        const re = new RegExp(tone.match, 'i');
        const hit = items.find((x) => re.test(x.model || ''));
        if (hit) return hit.path;
      } catch {
        return items[0]?.path || fresh.get(key) || null;
      }
      return fresh.get(key) || null;
    }
    return items[0]?.path || fresh.get(key) || null;
  }

  const api = {
    findPath,
    get busy() {
      return busy;
    },

    /** Подставить в текущую цепочку всё, что уже скачано (встроенные блоки-заместители уступают место тону). */
    resolve() {
      for (const b of chain.blocks()) {
        if (b.tone && !b.file) {
          const p = findPath(b.tone);
          if (p) chain.setFile(b.id, p, 'auto');
        }
      }
      const ready = new Map();
      for (const b of chain.blocks()) {
        if (b.standIn && !ready.has(b.standIn.group)) {
          const p = findPath(b.standIn.tone);
          if (p) ready.set(b.standIn.group, p);
        }
      }
      if (!ready.size) return false;
      const next = [];
      const done = new Set();
      for (const b of chain.blocks()) {
        const s = b.standIn;
        if (!s || !ready.has(s.group)) {
          next.push(b);
          continue;
        }
        if (done.has(s.group)) continue; // вторая часть замены (например, встроенный кабинет) уходит вместе с первой
        done.add(s.group);
        next.push({ type: s.type, on: s.on, size: s.size, params: s.params, tone: s.tone, file: ready.get(s.group) });
      }
      chain.replaceAll(next, { auto: true });
      return true;
    },

    /** Тоны текущей цепочки, которые ещё не скачаны: [{ id, title, match, kind }]. */
    missing() {
      const map = new Map();
      for (const b of chain.blocks()) {
        const tone = b.standIn ? b.standIn.tone : b.tone && !b.file ? b.tone : null;
        if (tone && !map.has(toneKey(tone))) map.set(toneKey(tone), { ...tone, kind: b.standIn ? b.standIn.type : b.type });
      }
      return [...map.values()];
    },

    /**
     * Скачать недостающие тоны текущей цепочки по одному. onState получает
     * { stage: 'progress', index, total, title } | { stage: 'done', errors, count } | { stage: 'canceled' }.
     */
    async download(onState) {
      if (busy || !engine.isNative) return;
      const list = api.missing();
      if (!list.length) return;
      busy = true;
      // если TONE3000 попросит ключ приложения, после его ввода продолжим отсюда же
      t3k.setResume(() => api.download(onState));
      const errors = [];
      let count = 0;
      try {
        for (let i = 0; i < list.length; i++) {
          const tone = list[i];
          onState({ stage: 'progress', index: i, total: list.length, title: tone.title });
          const r = await engine.t3kLoadTone(tone.id, tone.kind, tone.match);
          if (r.canceled) {
            onState({ stage: 'canceled', count });
            return;
          }
          if (!r.ok || !r.path) {
            errors.push(`${tone.title}: ${r.error || 'unknown error'
}`);
            continue;
          }
          count++;
          fresh.set(toneKey(tone), r.path);
          api.resolve(); // если блок успели убрать, файл останется в «Моих тонах», а цепочку не трогаем
        }
        onState({ stage: 'done', errors, count });
      } finally {
        busy = false;
      }
    },
  };

  if (engine.isNative) engine.on('library', () => fresh.clear());
  return api;
}
