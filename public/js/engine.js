// Выбор движка: внутри приложения PolyAmp.exe — нативный (ASIO, низкая задержка),
// в обычном браузере — Web Audio.
import { webEngine } from './audio.js';
import { nativeEngine, isNative } from './native.js';

export const engine = isNative ? nativeEngine : webEngine;
export { isNative };
