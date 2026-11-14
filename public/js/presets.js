// Готовые пресеты, сгруппированные в коллекции.
//
// Блок пресета: { type, params, on? } — как в цепочке. Блоку с файлом можно задать tone — тон
// с TONE3000 (номер, название, подсказка для выбора модели), и alt — встроенные блоки, которые
// играют вместо тона, пока он не скачан. Так пресет звучит сразу, а после скачивания —
// настоящим усилителем или педалью.
//
// Коллекции — примеры по стилям: с чего начать и как собирать цепочки. Свои пресеты пользователь
// сохраняет сам (они хранятся только у него, в «My presets»).

const B = (type, params = {}, extra = {}) => ({ type, params, ...extra });
/** Блок с тоном TONE3000. kind блока — его type (pedal, amp, cab, space). */
// педали ставим в размер Lite: на слух почти то же, а с усилителем A2 вдвое легче для процессора
const LITE = { size: 0 };
const T = (type, tone, params, alt, extra = {}) => ({ type, params: params || {}, tone, alt: alt || null, ...extra });

// ---------- тоны с TONE3000 ----------
// match — часть имени модели, если в тоне несколько вариантов (каналы, бустеры, настройки)
const TONE = {
  bigMuff: { id: 37818, title: 'Op-Amp Big Muff' },
  ts9: { id: 86314, title: 'Ibanez TS9 Tube Screamer' },
  sd1: { id: 87914, title: 'Boss SD-1 Super Overdrive' },
  klon: { id: 104562, title: 'Klon Centaur (clone)' },
  rat: { id: 102945, title: 'ProCo Rat 2 · Drive 10', match: '10/7/6' },
  jcm800: { id: 87735, title: 'Marshall JCM800 + 1960 V30' },
  jmp: { id: 98643, title: 'Marshall JMP-100 / JCM800 · Drive' },
  superReverb: { id: 88775, title: 'Fender Super Reverb 1965 · Edge of Breakup' },
  twinClean: { id: 89797, title: "Fender '65 Twin Reverb · Clean", match: '_CLEAN_' },
  twinWarm: { id: 89797, title: "Fender '65 Twin Reverb · Warm", match: '_WARM_' },
  deluxeGain: { id: 93426, title: "Fender '65 Deluxe Reverb · Gain", match: 'Gain' },
  jcBright: { id: 108868, title: 'Roland JC-120 · Clean Bright', match: 'Clean Bright' },
  twoRock: { id: 104093, title: 'Two-Rock SSS · Ultimate Clean' },
  // в тоне семь вариантов с разными бустерами; берём чистый — бустер (Klon) стоит в цепочке отдельно
  ac30: { id: 57741, title: 'Vox AC30 · Clean', match: 'CLEAN' },
  dualRec: { id: 106343, title: 'Mesa Dual Rectifier Rev F · Red + OD808' },
  // каналы Red, Blue и Green+SD1; для ритма с TS9 впереди — синий
  stealth: { id: 84864, title: '5150 Stealth 100W · Blue · Mesa OS 4×12', match: 'Blue' },
  plate: { id: 109652, title: 'Plate Reverb 1964' },
  ambient: { id: 88860, title: 'Ambient Shoegaze Machine' },
  liveRoom: { id: 99227, title: 'Studio 3 Live Room' },
  hall: { id: 91585, title: 'Boss RV-6 · Hall', match: 'Hall' },
  springLush: { id: 92532, title: 'Deluxe Reverb spring · Long Lush', match: 'Long Lush' },
};

// ---------- встроенные замены ----------
const ALT = {
  muff: [B('drive', { drive: 0.92, tone: 0.42, level: 0.55 })],
  ts: [B('drive', { drive: 0.14, tone: 0.6, level: 0.78 })],
  sd1: [B('drive', { drive: 0.2, tone: 0.55, level: 0.72 })],
  klon: [B('drive', { drive: 0.22, tone: 0.62, level: 0.64 })],
  rat: [B('drive', { drive: 0.85, tone: 0.5, level: 0.58 })],
  marshall: [B('polyamp', { channel: 1, gain: 0.62, bass: 0.55, mid: 0.62, treble: 0.6, presence: 0.55 }), B('polycab', { type: 0 })],
  plexi: [B('polyamp', { channel: 1, gain: 0.72, bass: 0.5, mid: 0.66, treble: 0.58, presence: 0.5 }), B('polycab', { type: 0 })],
  fender: [B('polyamp', { channel: 0, gain: 0.5, bass: 0.48, mid: 0.45, treble: 0.62, presence: 0.55 }), B('polycab', { type: 1 })],
  twin: [B('polyamp', { channel: 0, gain: 0.4, bass: 0.48, mid: 0.45, treble: 0.6, presence: 0.58 }), B('polycab', { type: 1 })],
  deluxe: [B('polyamp', { channel: 0, gain: 0.55, bass: 0.5, mid: 0.5, treble: 0.55, presence: 0.5 }), B('polycab', { type: 2 })],
  jc: [B('polyamp', { channel: 0, gain: 0.28, bass: 0.45, mid: 0.5, treble: 0.68, presence: 0.66 }), B('polycab', { type: 1 })],
  twoRock: [B('polyamp', { channel: 0, gain: 0.34, bass: 0.5, mid: 0.5, treble: 0.6, presence: 0.62 }), B('polycab', { type: 1 })],
  vox: [B('polyamp', { channel: 1, gain: 0.34, bass: 0.45, mid: 0.55, treble: 0.66, presence: 0.62 }), B('polycab', { type: 1 })],
  rect: [B('polyamp', { channel: 2, gain: 0.7, bass: 0.62, mid: 0.38, treble: 0.6, presence: 0.6 }), B('polycab', { type: 0 })],
  stealth: [B('polyamp', { channel: 2, gain: 0.55, bass: 0.58, mid: 0.5, treble: 0.58, presence: 0.55 }), B('polycab', { type: 0 })],
  plate: [B('reverb', { size: 0.6, damp: 0.35, mix: 0.24 })],
  ambient: [B('reverb', { size: 0.95, damp: 0.3, mix: 0.46 })],
  room: [B('reverb', { size: 0.3, damp: 0.55, mix: 0.12 })],
  hall: [B('reverb', { size: 0.85, damp: 0.4, mix: 0.3 })],
  springBig: [B('reverb', { size: 0.7, damp: 0.25, mix: 0.4 })],
};

export const COLLECTIONS = [
  {
    id: 'poly',
    title: 'Poly Amp',
    subtitle: 'built-in blocks — play right away',
    colors: ['#7c7ff2', '#b48cff'],
    presets: [
      {
        id: 'clean', name: 'Clean', note: 'transparent clean with a touch of reverb',
        blocks: [B('gate'), B('polyamp', { channel: 0, gain: 0.32, treble: 0.6, master: 0.6 }), B('polycab', { type: 1 }), B('reverb', { mix: 0.2 })],
      },
      {
        id: 'crunch', name: 'Crunch', note: 'British crunch that responds to your picking',
        blocks: [B('gate'), B('polyamp', { channel: 1, gain: 0.5, bass: 0.55, mid: 0.6, treble: 0.55 }), B('polycab', { type: 0 }), B('reverb', { mix: 0.12 })],
      },
      {
        id: 'blues', name: 'Blues lead', note: 'overdrive into a warmed-up amp, delay',
        blocks: [
          B('gate'), B('drive', { drive: 0.35, tone: 0.55, level: 0.62 }),
          B('polyamp', { channel: 1, gain: 0.62, mid: 0.66, treble: 0.55 }), B('polycab', { type: 0 }),
          B('delay', { time: 360, feedback: 0.3, mix: 0.18 }), B('reverb', { mix: 0.16 }),
        ],
      },
      {
        id: 'hard', name: 'Hard rock', note: 'tight lead channel',
        blocks: [B('gate', { thresh: -56 }), B('polyamp', { channel: 2, gain: 0.45, bass: 0.55, mid: 0.55, treble: 0.6 }), B('polycab', { type: 0 }), B('reverb', { mix: 0.1 })],
      },
      {
        id: 'metal', name: 'Metal', note: 'a boost tightens the low end, high gain',
        blocks: [
          B('gate', { thresh: -50 }), B('drive', { drive: 0.08, tone: 0.62, level: 0.82 }),
          B('polyamp', { channel: 2, gain: 0.8, bass: 0.6, mid: 0.35, treble: 0.65, presence: 0.6 }), B('polycab', { type: 0 }),
        ],
      },
      {
        id: 'ambient', name: 'Ambient', note: 'chorus, long delay and a big reverb',
        blocks: [
          B('comp', { thresh: -28, ratio: 3, makeup: 5 }), B('polyamp', { channel: 0, gain: 0.25, bass: 0.45, treble: 0.6 }), B('polycab', { type: 1 }),
          B('chorus', { rate: 0.5, depth: 0.45, mix: 0.4 }), B('delay', { time: 520, feedback: 0.45, mix: 0.35 }),
          B('reverb', { size: 0.85, damp: 0.35, mix: 0.4 }),
        ],
      },
    ],
  },
  {
    id: 'clean',
    title: 'Clean & ambient',
    subtitle: 'clean amps from TONE3000 with modulation and space',
    colors: ['#38d6c0', '#7aa8ff'],
    presets: [
      {
        id: 'glass', name: 'Glassy clean', note: 'bright solid-state clean with chorus and a plate',
        blocks: [
          B('comp', { thresh: -24, ratio: 4, makeup: 5 }),
          T('amp', TONE.jcBright, { treble: 0.6 }, ALT.jc),
          B('chorus', { rate: 0.8, depth: 0.3, mix: 0.3 }),
          T('space', TONE.plate, { mix: 0.22 }, ALT.plate),
        ],
      },
      {
        id: 'warm', name: 'Warm clean', note: 'a warm Twin with gentle compression — for chords and double stops',
        blocks: [
          B('comp', { thresh: -26, ratio: 3, makeup: 4 }),
          T('amp', TONE.twinWarm, { treble: 0.5 }, ALT.twin),
          B('chorus', { rate: 0.6, depth: 0.35, mix: 0.25 }),
          B('reverb', { size: 0.55, damp: 0.55, mix: 0.2 }),
        ],
      },
      {
        id: 'boutique', name: 'Boutique clean', note: 'firm compression, a boutique clean amp, delay and plate — every note comes through',
        blocks: [
          B('comp', { thresh: -30, ratio: 5, makeup: 7 }),
          T('amp', TONE.twoRock, { bass: 0.48, treble: 0.58 }, ALT.twoRock),
          B('delay', { time: 380, feedback: 0.28, mix: 0.16 }),
          T('space', TONE.plate, { mix: 0.22 }, ALT.plate),
        ],
      },
      {
        id: 'swells', name: 'Ambient swells', note: 'long delay into a huge ambient reverb',
        blocks: [
          B('comp', { thresh: -28, ratio: 4, makeup: 6 }),
          T('amp', TONE.twoRock, { bass: 0.45, treble: 0.6 }, ALT.twoRock),
          B('delay', { time: 560, feedback: 0.55, mix: 0.33 }),
          T('space', TONE.ambient, { mix: 0.45 }, ALT.ambient),
        ],
      },
      {
        id: 'tremolo', name: 'Tremolo & spring', note: 'harmonic tremolo, delay and a long spring reverb',
        blocks: [
          B('comp', { thresh: -26, ratio: 3, makeup: 4 }),
          T('amp', TONE.twinClean, { input: -3 }, ALT.twin),
          B('tremolo', { shape: 2, rate: 4.5, depth: 0.65 }),
          B('delay', { time: 450, feedback: 0.4, mix: 0.24 }),
          T('space', TONE.springLush, { mix: 0.4 }, ALT.springBig),
        ],
      },
    ],
  },
  {
    id: 'rock',
    title: 'Rock & blues',
    subtitle: 'edge of breakup, classic overdrives and fuzz',
    colors: ['#facc15', '#fb7185'],
    presets: [
      {
        id: 'edge', name: 'Edge of breakup', note: 'a Fender that cleans up with your guitar volume',
        blocks: [
          B('comp', { thresh: -24, ratio: 3, makeup: 3 }),
          T('amp', TONE.superReverb, { input: -4, treble: 0.58 }, ALT.fender),
          T('space', TONE.springLush, { mix: 0.22 }, ALT.springBig),
        ],
      },
      {
        id: 'klonvox', name: 'Klon into AC30', note: 'a transparent boost pushes a Vox into light breakup',
        blocks: [
          B('comp', { thresh: -24, ratio: 3, makeup: 3 }),
          T('pedal', TONE.klon, {}, ALT.klon, LITE),
          T('amp', TONE.ac30, { input: -2, treble: 0.55 }, ALT.vox),
          B('delay', { time: 380, feedback: 0.28, mix: 0.16 }),
          T('space', TONE.plate, { mix: 0.2 }, ALT.plate),
        ],
      },
      {
        id: 'blues', name: 'Tube Screamer blues', note: 'a TS9 into a cranked Deluxe Reverb',
        blocks: [
          B('gate', { thresh: -58 }),
          T('pedal', TONE.ts9, { output: -2 }, ALT.ts, LITE),
          T('amp', TONE.deluxeGain, {}, ALT.deluxe),
          B('delay', { time: 360, feedback: 0.25, mix: 0.14 }),
          T('space', TONE.plate, { mix: 0.18 }, ALT.plate),
        ],
      },
      {
        id: 'crunch', name: 'Classic crunch', note: 'an old Marshall on the drive channel in a live room',
        blocks: [
          B('gate', { thresh: -54 }),
          T('amp', TONE.jmp, { bass: 0.5, mid: 0.58 }, ALT.plexi),
          T('space', TONE.liveRoom, { mix: 0.14 }, ALT.room),
        ],
      },
      {
        id: 'fuzz', name: 'Fuzz rock', note: 'a Big Muff into a crunchy JCM800',
        blocks: [
          B('gate', { thresh: -52 }),
          T('pedal', TONE.bigMuff, { output: -2 }, ALT.muff, LITE),
          T('amp', TONE.jcm800, { input: -3, bass: 0.55, mid: 0.45, treble: 0.58 }, ALT.marshall),
          B('reverb', { size: 0.4, mix: 0.1 }),
        ],
      },
    ],
  },
  {
    id: 'heavy',
    title: 'High gain',
    subtitle: 'tight rhythm, big leads and modern metal',
    colors: ['#f0569b', '#ff9f68'],
    presets: [
      {
        id: 'rhythm', name: 'Modern rhythm', note: 'a TS9 tightens a 5150 — for palm mutes and chugs',
        blocks: [
          B('gate', { thresh: -50 }),
          T('pedal', TONE.ts9, {}, ALT.ts, LITE),
          T('amp', TONE.stealth, { bass: 0.55, mid: 0.55, treble: 0.55 }, ALT.stealth),
          T('space', TONE.liveRoom, { mix: 0.12 }, ALT.room),
        ],
      },
      {
        id: 'rectifier', name: 'Rectifier', note: 'a Dual Rectifier with an OD808 in front',
        blocks: [
          B('gate', { thresh: -46 }),
          T('amp', TONE.dualRec, { bass: 0.52, mid: 0.55, treble: 0.55 }, ALT.rect),
          T('space', TONE.liveRoom, { mix: 0.1 }, ALT.room),
        ],
      },
      {
        id: 'lead', name: 'British lead', note: 'an SD-1 into a JCM800 with delay — leads that cut through',
        blocks: [
          B('gate', { thresh: -52 }),
          T('pedal', TONE.sd1, {}, ALT.sd1, LITE),
          T('amp', TONE.jcm800, { mid: 0.6, treble: 0.55 }, ALT.marshall),
          B('delay', { time: 420, feedback: 0.3, mix: 0.18 }),
          T('space', TONE.hall, { mix: 0.18 }, ALT.hall),
        ],
      },
      {
        id: 'ratphase', name: 'Rat & phaser', note: 'a maxed-out Rat into a Marshall with a slow phaser',
        blocks: [
          B('gate', { thresh: -54 }),
          T('pedal', TONE.rat, { output: -4 }, ALT.rat, LITE),
          T('amp', TONE.jcm800, { input: -4, mid: 0.5 }, ALT.marshall),
          B('phaser', { rate: 0.35, depth: 0.7, feedback: 0.45, mix: 0.5 }),
          B('reverb', { size: 0.6, mix: 0.18 }),
        ],
      },
    ],
  },
];

export const DEFAULT_PRESET = { col: 'poly', id: 'crunch' };

export function findPreset(ref) {
  const col = COLLECTIONS.find((c) => c.id === ref?.col);
  const preset = col?.presets.find((p) => p.id === ref.id);
  return preset ? { col, preset } : null;
}

/** Все тоны TONE3000, которые встречаются в пресете. */
export function presetTones(preset) {
  return preset.blocks.filter((b) => b.tone).map((b) => ({ ...b.tone, kind: b.type }));
}
