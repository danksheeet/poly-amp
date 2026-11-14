// Музыкальная теория: ноты, строй, гаммы, аккорды.

export const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];

// Стандартный строй. Индекс 0 — шестая (самая толстая) струна.
export const TUNING = [40, 45, 50, 55, 59, 64]; // E2 A2 D3 G3 B3 E4
export const STRING_ORD = ['6th', '5th', '4th', '3rd', '2nd', '1st'];

export const midiToFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);
export const freqToMidi = (f) => 69 + 12 * Math.log2(f / 440);
export const pcOf = (m) => ((Math.round(m) % 12) + 12) % 12;
export const noteName = (m) => NOTE_NAMES[pcOf(m)];
export const noteOctave = (m) => Math.floor(Math.round(m) / 12) - 1;
export const posMidi = (s, f) => TUNING[s] + f;
export const isSharp = (m) => NOTE_NAMES[pcOf(m)].length > 1;

// ---------- Гаммы ----------
// lo/hi — окно ладов относительно тоники на шестой струне (классические «боксы»).
export const SCALES = [
  { id: 'pent-min', name: 'Minor pentatonic', short: 'minor pentatonic', intervals: [0, 3, 5, 7, 10], lo: 0, hi: 3 },
  { id: 'pent-maj', name: 'Major pentatonic', short: 'major pentatonic', intervals: [0, 2, 4, 7, 9], lo: -1, hi: 2 },
  { id: 'blues', name: 'Blues scale', short: 'blues scale', intervals: [0, 3, 5, 6, 7, 10], lo: 0, hi: 3 },
  { id: 'major', name: 'Major', short: 'major', intervals: [0, 2, 4, 5, 7, 9, 11], lo: -1, hi: 3 },
  { id: 'minor', name: 'Natural minor', short: 'minor', intervals: [0, 2, 3, 5, 7, 8, 10], lo: 0, hi: 3 },
  { id: 'spider', name: 'Chromatic 1-2-3-4', short: 'chromatic 1-2-3-4', exercise: true },

];

/**
 * Позиция гаммы на грифе.
 * @returns {{ box: Array, seq: Array, startFret: number }} box — все ноты позиции,
 *   seq — порядок игры: вверх от тоники и обратно.
 */
export function scaleLayout(rootPc, scale) {
  if (scale.exercise) return spiderLayout(5);
  let p = (rootPc - 4 + 12) % 12; // лад тоники на шестой струне
  if (p + scale.lo < 0) p += 12;
  const box = [];
  const seen = new Set();
  for (let s = 0; s < 6; s++) {
    for (let f = p + scale.lo; f <= p + scale.hi; f++) {
      const midi = posMidi(s, f);
      const iv = (((midi - rootPc) % 12) + 12) % 12;
      if (!scale.intervals.includes(iv) || seen.has(midi)) continue;
      seen.add(midi);
      box.push({ s, f, midi, root: iv === 0 });
    }
  }
  box.sort((a, b) => a.midi - b.midi);
  const rootMidi = posMidi(0, p);
  const up = box.filter((n) => n.midi >= rootMidi);
  const seq = up.concat(up.slice(0, -1).reverse());
  return { box, seq, startFret: p };
}

function spiderLayout(start) {
  const box = [];
  const up = [];
  for (let s = 0; s < 6; s++) {
    for (let f = start; f < start + 4; f++) {
      const n = { s, f, midi: posMidi(s, f), root: false };
      box.push(n);
      up.push(n);
    }
  }
  const down = [];
  for (let s = 5; s >= 0; s--) {
    for (let f = start + 3; f >= start; f--) down.push({ s, f, midi: posMidi(s, f), root: false });
  }
  return { box, seq: up.concat(down.slice(1)), startFret: start };
}

// ---------- Аккорды ----------
// frets/fingers — от шестой струны к первой; -1 — струна не звучит.
export const CHORDS = [
  { id: 'Em', frets: [0, 2, 2, 0, 0, 0], fingers: [0, 2, 3, 0, 0, 0] },
  { id: 'Am', frets: [-1, 0, 2, 2, 1, 0], fingers: [0, 0, 2, 3, 1, 0] },
  { id: 'C', frets: [-1, 3, 2, 0, 1, 0], fingers: [0, 3, 2, 0, 1, 0] },
  { id: 'G', frets: [3, 2, 0, 0, 0, 3], fingers: [2, 1, 0, 0, 0, 3] },
  { id: 'D', frets: [-1, -1, 0, 2, 3, 2], fingers: [0, 0, 0, 1, 3, 2] },
  { id: 'Dm', frets: [-1, -1, 0, 2, 3, 1], fingers: [0, 0, 0, 2, 3, 1] },
  { id: 'E', frets: [0, 2, 2, 1, 0, 0], fingers: [0, 2, 3, 1, 0, 0] },
  { id: 'A', frets: [-1, 0, 2, 2, 2, 0], fingers: [0, 0, 1, 2, 3, 0] },
  { id: 'F', frets: [1, 3, 3, 2, 1, 1], fingers: [1, 3, 4, 2, 1, 1] },
  { id: 'Bm', frets: [-1, 2, 4, 4, 3, 2], fingers: [0, 1, 3, 4, 2, 1] },
  { id: 'E7', frets: [0, 2, 0, 1, 0, 0], fingers: [0, 2, 0, 1, 0, 0] },
  { id: 'A7', frets: [-1, 0, 2, 0, 2, 0], fingers: [0, 0, 2, 0, 3, 0] },
  { id: 'D7', frets: [-1, -1, 0, 2, 1, 2], fingers: [0, 0, 0, 2, 1, 3] },
  { id: 'B7', frets: [-1, 2, 1, 2, 0, 2], fingers: [0, 2, 1, 3, 0, 4] },
];

export const chordById = (id) => CHORDS.find((c) => c.id === id);
export const chordMidis = (chord) =>
  chord.frets.map((f, s) => (f < 0 ? null : posMidi(s, f))).filter((m) => m != null);

export const PROGRESSIONS = [
  { id: 'p1', chords: ['Am', 'F', 'C', 'G'] },
  { id: 'p2', chords: ['G', 'D', 'Em', 'C'] },
  { id: 'p3', chords: ['Em', 'C', 'G', 'D'] },
  { id: 'p4', chords: ['Am', 'Dm', 'E', 'Am'] },
  { id: 'p5', chords: ['A', 'D', 'E', 'A'] },
  { id: 'p6', chords: ['E7', 'A7', 'B7', 'E7'] },
];
