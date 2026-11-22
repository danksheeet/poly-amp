// Как показать блок: заголовок, подпись, обложка и состояние (для плитки и панели блока).
import { BLOCKS } from '../blocks.js';

export const GEAR = {
  amp: 'amp', pedal: 'pedal', cab: 'cab', outboard: 'studio gear', space: 'space',
  'amp-cab': 'amp + cab', amp_cab: 'amp + cab', 'full-rig': 'amp + cab',
  pedal_amp: 'pedal + amp', amp_pedal_cab: 'pedal + amp + cab', preamp: 'preamp', studio: 'studio gear',
};

/** Модель «усилитель + кабинет»: отдельный кабинет после неё не нужен. */
export const hasCab = (gear) => typeof gear === 'string' && gear.includes('cab') && gear !== 'cab';

export const baseName = (path) => String(path).split(/[\\/]/).pop().replace(/\.[^.]+$/, '');

export const safeImage = (url) => (typeof url === 'string' && url.startsWith('https://') ? url : null);

/**
 * state: ok — играет; loading — файл загружается; error — файл не загрузился; pending — тон пресета
 * не скачан (блок молчит); empty — блок без файла; standin — встроенный блок вместо нескачанного тона;
 * builtin — обычный встроенный блок.
 */
export function describeBlock(b, engine) {
  const def = BLOCKS[b.type];
  if (def.plugin) {
    const p = b.plugin;
    const title = p?.name || def.name;
    if (!p) return { title, sub: 'no plugin chosen', state: 'error' };
    if (!engine.isNative) return { title, sub: 'plays only in the app', state: 'ok' };
    const info = engine.blockInfo?.get(b.id);
    if (info?.error) return { title, sub: info.error, state: 'error' };
    if (info?.loaded) return { title, sub: (p.vendor ? p.vendor + ' · ' : '') + 'VST3', state: 'ok', latency: info.latency || 0 };
    return { title, sub: 'loading…', state: 'loading' };
  }
  if (def.file) {
    const info = engine.blockInfo?.get(b.id);
    if (b.file) {
      if (info && info.error && info.requested === b.file) {
        return { title: b.tone?.title || baseName(b.file), sub: info.error, state: 'error' };
      }
      if (info && info.loaded && info.path === b.file) {
        const src = info.source;
        const gear = (src && src.gear) || info.gear || null;
        const bits = [];
        if (src && src.model && src.model !== src.title) bits.push(src.model);
        if (def.file === 'ir') bits.push(`${Math.round(info.ms || 0)} ms${info.stereo ? ' · stereo' : ''}`);
        else bits.push(info.flavor || null, GEAR[gear] || null);
        if (info.mismatch) bits.push(`⚠ made for ${(info.sampleRate || 0) / 1000} kHz`);
        return {
          title: (src && src.title) || info.name || baseName(b.file),
          sub: bits.filter(Boolean).join(' · ') || def.role,
          creator: src && src.creator,
          cover: safeImage(src && src.image),
          url: src && src.url,
          t3k: !!src,
          gear,
          slimmable: !!info.slimmable,
          modelSize: info.modelSize,
          state: 'ok',
        };
      }
      if (!engine.isNative) return { title: b.tone?.title || baseName(b.file), sub: 'plays only in the app', state: 'ok' };
      return { title: b.tone?.title || baseName(b.file), sub: 'loading…', state: 'loading' };
    }
    if (b.tone) return { title: b.tone.title, sub: 'TONE3000 tone not downloaded', state: 'pending' };
    return { title: def.name, sub: 'empty — the signal passes through', state: 'empty' };
  }

  let title = def.name;
  let sub = def.role;
  if (b.type === 'polyamp') sub = 'channel ' + def.params.channel.choices[b.params.channel];
  if (b.type === 'polycab') sub = def.params.type.choices[b.params.type];
  if (b.standIn) return { title, sub: 'instead of: ' + b.standIn.tone.title, state: 'standin' };

  return { title, sub, state: 'builtin' };
}
