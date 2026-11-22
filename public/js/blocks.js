// Виды блоков цепочки: название, оттенок, значок, ручки. Имена параметров совпадают с движком (native/Blocks.cs).

const knob10 = (v) => (v * 10).toFixed(1);
const db = (v) => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(1) + ' dB';
const dbInt = (v) => Math.round(v) + ' dB';
const pct = (max) => (v) => Math.round((v / max) * 100) + ' %';
const hz = (v) => v.toFixed(2) + ' Hz';

const k = (label, def = 0.5) => ({ label, min: 0, max: 1, def, fmt: knob10 });
const gain = (label) => ({ label, min: -20, max: 20, def: 0, fmt: db });

// значки 24×24: только контуры, цвет берётся из текста
const ICONS = {
  gate: '<path d="M4 20V10a8 8 0 0 1 16 0v10M3 20h18M9 20v-8M15 20v-8"/>',
  comp: '<path d="M4 12h16M12 3v6m-2.5-2.5L12 9l2.500-2.500M12 21v-6m-2.500 2.500L12 15l2.500 2.500"/>',
  pedal: '<rect x="5.500" y="3" width="13" height="18" rx="2.500"/><circle cx="9.500" cy="7.500" r="1.200"/><circle cx="14.500" cy="7.500" r="1.200"/><circle cx="12" cy="15.500" r="2.400"/>',
  amp: '<rect x="2.500" y="5.500" width="19" height="13" rx="2"/><path d="M2.500 10.500h19M6 14.500h12"/><circle cx="6.500" cy="8" r="0.700"/><circle cx="10" cy="8" r="0.700"/><circle cx="13.500" cy="8" r="0.700"/>',
  cab: '<rect x="4" y="3.500" width="16" height="17" rx="2"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.600"/>',
  chorus: '<path d="M3 9c3-4 6 4 9 0s6 4 9 0M3 15c3-4 6 4 9 0s6 4 9 0"/>',
  phaser: '<circle cx="12" cy="12" r="8.500"/><path d="M6.500 12c1.800-4.500 3.700-4.500 5.500 0s3.700 4.500 5.500 0"/>',
  tremolo: '<path d="M3 12h1.500M19.500 12H21M5 12c.800-5 1.700-5 2.500 0s1.700 5 2.500 0M10 12c.800-3 1.700-3 2.500 0s1.700 3 2.500 0M15 12c.700-1.600 1.500-1.600 2.200 0s1.200 1.200 2.300 0"/>',
  delay: '<path d="M5 5.500v13M10 8v8M14.500 10v4M18.500 11.200v1.600"/>',
  reverb: '<circle cx="5.500" cy="12" r="1.300"/><path d="M10 8.500a5 5 0 0 1 0 7M13.500 6a9 9 0 0 1 0 12M17 3.500a13 13 0 0 1 0 17"/>',
  space: '<path d="M11 4l1.700 4.800L17.500 10.500l-4.800 1.700L11 17l-1.700-4.800L4.500 10.500l4.800-1.700zM18 15l.800 2.200L21 18l-2.200.800L18 21l-.800-2.200L15 18l2.200-.800z"/>',
  search: '<circle cx="11" cy="11" r="6.500"/><path d="M16 16l4.500 4.500"/>',
};
export const iconSvg = (name) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ICONS.pedal}</svg>`;

/**
 * type → описание блока.
 *   tag: короткая подпись на плитке; icon: значок;
 *   file: 'nam' | 'ir' — блоку нужен файл (тон с TONE3000 или свой);
 *   t3k: раздел каталога TONE3000;
 *   params: имя → { label, min, max, def, fmt } или { label, choices: [...] , def } для переключателя.
 */
export const BLOCKS = {
  gate: {
    name: 'Gate', role: 'noise gate', tag: 'GATE', icon: 'gate', group: 'builtin', color: '#94a3b8',
    params: { thresh: { label: 'Threshold', min: -80, max: -30, def: -62, fmt: dbInt } },
  },
  comp: {
    name: 'Compressor', role: 'compressor', tag: 'COMP', icon: 'comp', group: 'builtin', color: '#38bdf8',
    params: {
      thresh: { label: 'Threshold', min: -50, max: 0, def: -24, fmt: dbInt },
      ratio: { label: 'Ratio', min: 1, max: 12, def: 4, fmt: (v) => v.toFixed(1) + ':1' },

      makeup: { label: 'Makeup', min: 0, max: 18, def: 4, fmt: db },
    },
  },
  pedal: {
    name: 'Pedal', role: 'pedal from TONE3000', tag: 'PEDAL', icon: 'pedal', group: 't3k', color: '#34d399', file: 'nam', t3k: 'pedal',
    empty: 'Overdrive, distortion, fuzz or boost — pick a pedal on TONE3000',
    params: { input: gain('Input'), output: gain('Output') },
  },
  drive: {
    name: 'Poly Drive', role: 'built-in overdrive', tag: 'DRIVE', icon: 'pedal', group: 'builtin', color: '#4ade80',
    params: { drive: k('Drive', 0.4), tone: k('Tone'), level: k('Level') },
  },
  amp: {
    name: 'Amp', role: 'amp from TONE3000', tag: 'AMP', icon: 'amp', group: 't3k', color: '#fbbf24', file: 'nam', t3k: 'amp',
    empty: 'Pick an amp on TONE3000 — on its own or with a cab',
    params: { input: gain('Input'), bass: k('Bass'), mid: k('Middle'), treble: k('Treble'), output: gain('Output') },
  },
  polyamp: {
    name: 'Poly Amp', role: 'built-in amp', tag: 'AMP', icon: 'amp', group: 'builtin', color: '#fb923c',
    params: {
      channel: { label: 'Channel', choices: ['Clean', 'Crunch', 'Lead'], def: 1 },
      gain: k('Gain'), bass: k('Bass'), mid: k('Middle'), treble: k('Treble'), presence: k('Presence'), master: k('Master'),
    },
  },
  cab: {
    name: 'Cab', role: 'cab from TONE3000', tag: 'CAB', icon: 'cab', group: 't3k', color: '#e0b184', file: 'ir', t3k: 'cab',
    empty: 'Pick a cab IR on TONE3000',
    params: { level: { label: 'Level', min: -12, max: 12, def: 0, fmt: db } },
  },
  polycab: {
    name: 'Poly Cab', role: 'built-in cab', tag: 'CAB', icon: 'cab', group: 'builtin', color: '#c9a27c',
    params: {
      type: { label: 'Cab', choices: ['4×12 British', '2×12 Open', '1×12 Vintage'], def: 0 },
      level: { label: 'Level', min: -12, max: 12, def: 0, fmt: db },
    },
  },
  chorus: {
    name: 'Chorus', role: 'chorus', tag: 'MOD', icon: 'chorus', group: 'builtin', color: '#60a5fa',
    params: { rate: { label: 'Rate', min: 0.1, max: 5, def: 0.8, fmt: hz }, depth: k('Depth'), mix: k('Mix') },
  },
  phaser: {
    name: 'Phaser', role: 'phaser', tag: 'MOD', icon: 'phaser', group: 'builtin', color: '#f472b6',
    params: {
      rate: { label: 'Rate', min: 0.05, max: 4, def: 0.5, fmt: hz }, depth: k('Depth', 0.7),
      feedback: { label: 'Feedback', min: 0, max: 0.9, def: 0.3, fmt: pct(0.9) }, mix: k('Mix'),
    },
  },
  tremolo: {
    name: 'Tremolo', role: 'tremolo', tag: 'MOD', icon: 'tremolo', group: 'builtin', color: '#2dd4bf',
    params: {
      shape: { label: 'Shape', choices: ['Sine', 'Square', 'Harmonic'], def: 0 },
      rate: { label: 'Rate', min: 0.5, max: 12, def: 4.5, fmt: hz }, depth: k('Depth', 0.6),
    },
  },
  delay: {
    name: 'Delay', role: 'delay', tag: 'DELAY', icon: 'delay', group: 'builtin', color: '#818cf8',
    params: {
      time: { label: 'Time', min: 50, max: 800, def: 380, fmt: (v) => Math.round(v) + ' ms' },
      feedback: { label: 'Feedback', min: 0, max: 0.85, def: 0.35, fmt: pct(0.85) },
      mix: { label: 'Mix', min: 0, max: 0.7, def: 0.25, fmt: pct(0.7) },
    },
  },
  reverb: {
    name: 'Reverb', role: 'built-in reverb', tag: 'REVERB', icon: 'reverb', group: 'builtin', color: '#a78bfa',
    params: { size: k('Size', 0.45), damp: k('Damp'), mix: { label: 'Mix', min: 0, max: 0.6, def: 0.15, fmt: pct(0.6) } },
  },
  space: {
    name: 'Space', role: 'reverb from TONE3000', tag: 'SPACE', icon: 'space', group: 't3k', color: '#c084fc', file: 'ir', t3k: 'space',
    empty: 'Reverb, room or hall — pick an IR on TONE3000',
    params: { mix: { label: 'Mix', min: 0, max: 1, def: 0.3, fmt: pct(1) } },
  },
};

/** Цепочка при первом запуске: британский кранч на встроенных блоках, звучит сразу, без скачиваний. */
export const START_CHAIN = [
  { type: 'gate' },
  { type: 'polyamp', params: { channel: 1, gain: 0.5, bass: 0.55, mid: 0.6, treble: 0.55 } },
  { type: 'polycab', params: { type: 0 } },
  { type: 'reverb', params: { mix: 0.12 } },
];

/** Порядок в меню «Добавить блок». */
export const ADD_MENU = [
  { title: 'Tones from TONE3000', types: ['pedal', 'amp', 'cab', 'space'] },
  { title: 'Built-in',
 types: ['gate', 'comp', 'drive', 'polyamp', 'polycab', 'chorus', 'phaser', 'tremolo', 'delay', 'reverb'] },
];

export function defaultParams(type) {
  const p = {};
  for (const [name, d] of Object.entries(BLOCKS[type].params)) p[name] = d.def;
  return p;
}

let counter = 0;
export const newId = () => 'b' + Date.now().toString(36) + (counter++).toString(36);

/**
 * Блок с параметрами по умолчанию; init может задать часть параметров, файл и состояние.
 * tone — ссылка на тон TONE3000 из готового пресета: { id, title, match? }. По ней блок находит
 * уже скачанный файл или предлагает скачать его.
 */
export function makeBlock(type, init = {}) {
  const block = {
    id: init.id || newId(),
    type,
    on: init.on !== false,
    file: init.file || null,
    size: init.size ?? 1,
    tone: BLOCKS[type].file ? cleanTone(init.tone) : null,
    params: { ...defaultParams(type), ...(init.params || {}) },
  };
  // встроенный блок, который временно играет вместо нескачанного тона пресета
  const s = init.standIn;
  if (s && BLOCKS[s.type]?.file && cleanTone(s.tone)) {
    block.standIn = { type: s.type, tone: cleanTone(s.tone), params: { ...(s.params || {}) }, on: s.on !== false, size: s.size ?? 1, group: String(s.group || '') };
  }
  return block;
}

function cleanTone(t) {
  return t && typeof t.id === 'number' ? { id: t.id, title: String(t.title || ''), match: t.match || null } : null;
}
