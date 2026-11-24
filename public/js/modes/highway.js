// «Highway»: ноты выбранной дорожки летят из глубины к грифу — играешь, когда нота долетает до струн.
// Своя 3D-сцена на canvas: X — лад, высота — струна (толстая сверху, как гриф при взгляде сверху), глубина — время до ноты.
// Время — часы плеера alphaTab (тик → мс по темпу песни, с повторами), попадания и промахи приходят
// из «Играть вместе» и «Жди меня» и хранятся у каждого прохода ноты отдельно (повторы, петля).
import { STRING_COLORS } from '../games/shell.js';

/**
 * Камера и вид дороги. look — сколько секунд песни видно вперёд: две секунды — ноты летят быстро и стоят далеко
 * друг от друга, а не жмутся в кашу; farScale — во сколько раз дальние ноты мельче ближних (0,4: ноты не «влетают
 * в экран»); pitch — насколько камера смотрит
 * вниз, yaw — насколько влево (головка грифа уходит вдаль), в градусах; top, bot — где на экране верх и низ струн;
 * far — дальний край дороги (доля высоты).
 */
export const TUNE = { look: 2, farScale: 0.4, pitch: 26, yaw: 4, top: 0.68, bot: 0.88, far: 0.12 };
const PAST = 0.35; // сколько секунд нота ещё видна после струн
const OFFSET_MS = 0; // поправка на задержку звука табов: больше нуля — ноты долетают позже
// ширина кадра — по разбросу нот: ноты в маленькой области — камера ближе (MIN_WIN ладов, ближе — теряется, что
// происходит), разбросаны по грифу — дальше (до MAX_WIN, почти весь гриф). Меняется только при смене места и плавно
const MIN_WIN = 13;
const MAX_WIN = 22;
// ноты вида стоят в кадре слева (отступ — доля ширины кадра), справа виден гриф к корпусу: дорога к ним идёт наискось
const LEFT = 0.1;
const RIGHT = 0.88; // правая граница нот вида — не дальше этой доли кадра
const HAND_LEAD = 250; // новая позиция руки показывается за столько мс до первой ноты в ней
const SUSTAIN_MS = 520; // длиннее — рисуем «хвост» (у коротких нот он только мешает)
const INLAYS = new Set([3, 5, 7, 9, 12, 15, 17, 19, 21, 24]);
const QUARTER = 960; // тиков в четверти (MidiUtils.QuarterTime)

/** Цвета струн от нижней к верхней; у 7- и 8-струнных добавляются свои. */
function palette(n) {
  const extra = ['#94a3b8', '#f472b6'];
  if (n <= 6) return STRING_COLORS.slice(0, n);
  return [...extra.slice(2 - Math.min(2, n - 6)), ...STRING_COLORS].slice(0, n);
}

// грани плиток: насыщенный цвет струны, светлый верх, тёмный бок, светлые рёбра
const hexRgb = (h) => {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const mixRgb = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const css = (c) => `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
function makeShades(hex) {
  const c = hexRgb(hex);
  const m = (c[0] + c[1] + c[2]) / 3;
  const b = c.map((v) => Math.max(0, Math.min(255, Math.round(m + (v - m) * 1.2)))); // чуть насыщеннее
  return { base: css(b), front: css(b), top: css(mixRgb(b, [255, 255, 255], 0.4)), side: css(mixRgb(b, [0, 0, 0], 0.4)), edge: css(mixRgb(b, [255, 255, 255], 0.62)) };
}
const MISS_SHADES = makeShades('#5b5f70');

const hasTab = (tr) => !!tr && tr.staves.some((s) => s.showTablature && !s.isPercussion);

/** Тик → мс по темпу песни. Такты в tickCache идут в порядке игры, с повторами. */
export function tempoMap(lookup) {
  const segs = [];
  for (const mb of lookup?.masterBars || []) {
    for (const tc of mb.tempoChanges || []) {
      const last = segs[segs.length - 1];
      if (last && tc.tick < last.tick) continue;
      const ms = last ? last.ms + ((tc.tick - last.tick) * 60000) / (last.tempo * QUARTER) : 0;
      segs.push({ tick: tc.tick, tempo: tc.tempo || 120, ms });
    }
  }
  if (!segs.length) segs.push({ tick: 0, tempo: 120, ms: 0 });
  return (tick) => {
    let lo = 0;
    let hi = segs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (segs[mid].tick <= tick) lo = mid;
      else hi = mid - 1;
    }
    const s = segs[lo];
    return s.ms + ((tick - s.tick) * 60000) / (s.tempo * QUARTER);
  };
}

/** Приёмы на ноте — короткой подписью над ней. */
function technique(n) {
  const t = [];
  if (n.isHammerPullDestination && n.hammerPullOrigin) t.push(n.fret >= n.hammerPullOrigin.fret ? 'H' : 'P');
  if (n.hasBend && n.maxBendPoint) {
    const v = n.maxBendPoint.value; // четверти тона: 4 — целый тон
    t.push('↑' + (v >= 8 ? '2' : v >= 4 ? '1' : '½'));
  }
  if (n.slideOutType) t.push(n.slideTarget && n.slideTarget.fret < n.fret ? '↘' : '↗');
  if (n.vibrato) t.push('~');
  return t.join(' ');
}

/**
 * Приёмы на ноте — для значков на дороге: хаммер/пулл-офф, бенд (четверти тона), слайд, вибрато, тремоло, акцент,
 * тэппинг, флажолет (pinch — искусственный «свист»), палец левой руки из файла (1–4, 0 — большой).
 */
function marks(n, beat) {
  const hp = n.isHammerPullDestination && n.hammerPullOrigin ? (n.fret >= n.hammerPullOrigin.fret ? 'h' : 'p') : null;
  const out = n.slideOutType; // 1, 2 — к следующей ноте; 3, 6 — вверх в никуда; 4, 5 — вниз
  const slide = out === 1 || out === 2 ? { to: null, endMs: null } : out === 3 || out === 6 ? { to: n.fret + 2 } : out === 4 || out === 5 ? { to: Math.max(1, n.fret - 2) } : null;
  return {
    hp,
    bend: n.hasBend && n.maxBendPoint ? n.maxBendPoint.value : 0,
    slide,
    vib: n.vibrato > 0,
    trem: !!beat.isTremolo,
    acc: n.accentuated === 1 || n.accentuated === 2,
    tap: !!beat.tap,
    pinch: n.harmonicType === 3,
    finger: n.leftHandFinger >= 0 ? n.leftHandFinger : null,
  };
}

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
/** Название, если в файле его нет: пауэр-аккорд (квинта, можно с октавой) — «E5»; остальное без названия. */
export function chordName(group) {
  const midis = group.filter((it) => !it.dead).map((it) => it.midi).filter((m) => m != null);
  if (midis.length < 2) return '';
  const root = Math.min(...midis);
  const rel = new Set(midis.map((m) => (m - root) % 12));
  return rel.size === 2 && rel.has(0) && rel.has(7) ? NAMES[root % 12] + '5' : '';
}

/**
 * Ноты дорожки по времени игры: { tick, ms, endMs, s (0 — нижняя струна), f, beat, tech, harm, dead, sec, …приёмы }.
 * Лиги продлевают ноту, форшлаги и паузы пропускаются. Глушёные ноты (dead) видны крестиком, но их не ждут:
 * у них нет высоты. sec — номер части песни (phrases: части по меткам файла, без меток — по восемь тактов).
 */
export function buildTimeline(lookup, track) {
  const toMs = tempoMap(lookup);
  const strings = track?.staves?.[0]?.tuning?.length || 6;
  const out = { items: [], chords: [], bars: [], sections: [], strings, toMs, tab: hasTab(track) };
  if (!lookup || !track) return out;
  out.bars = (lookup.masterBars || []).map((mb) => toMs(mb.start));
  // части песни (Intro, Verse…) — подписью над дорогой
  out.sections = (lookup.masterBars || []).filter((mb) => mb.masterBar?.section?.text).map((mb) => ({ ms: toMs(mb.start), tick: mb.start, text: mb.masterBar.section.text.trim() }));
  out.phrases = phrases(lookup, toMs, out.sections);
  if (!out.tab) return out;
  const set = new Set([track.index]);
  const open = new Map(); // струна → последняя нота на ней (для лиг)
  let prev = null; // прошлая доля с нотами: { key, ms } — чтобы узнать повтор аккорда
  let r = lookup.findBeat(set, 0);
  for (let guard = 0; r && guard < 100000; guard++) {
    const beat = r.beat;
    if (beat && !beat.isRest && beat.graceType === 0 && beat.voice?.bar?.staff?.track === track) {
      const group = [];
      for (const n of beat.notes) {
        if (n.isPercussion || n.isVisible === false) continue;
        if (n.isTieDestination) {
          const o = open.get(n.string);
          if (o) o.endMs = toMs(r.end);
          continue;
        }
        const ms = toMs(r.start);
        const it = { tick: r.start, ms, endMs: toMs(r.end), s: n.string - 1, f: n.fret, midi: n.realValue, beat, note: n, tech: technique(n), harm: n.harmonicType > 0, pm: n.isPalmMute, dead: n.isDead, state: null, ...marks(n, beat) };
        // слайд к этой ноте с прошлой на той же струне: хвост прошлой ноты едет сюда
        const o = open.get(n.string);
        if (o?.slide && o.slide.to == null && o.note.slideTarget === n) Object.assign(o.slide, { to: n.fret, endMs: ms });
        out.items.push(it);
        group.push(it);
        open.set(n.string, it);
      }
      if (group.length) {
        const key = group.map((it) => it.s + ':' + it.f + (it.dead ? 'x' : '')).sort().join(' ');
        if (group.length >= 2) {
          // тот же аккорд сразу ещё раз — пустая рамка без плиток: на долгих аккордах дорога не пестрит
          const repeat = !!prev && prev.key === key && group[0].ms - prev.ms < 2500;
          if (repeat) for (const it of group) it.rep = true;
          const chord = { tick: r.start, ms: group[0].ms, items: group, repeat, name: beat.chord?.name || chordName(group) };
          for (const it of group) it.chord = chord;
          out.chords.push(chord);
        }
        prev = { key, ms: group[0].ms };
      }
    }
    const next = lookup.findBeat(set, r.end, r);
    if (!next || next.start <= r.start) break;
    r = next;
  }
  for (const it of out.items) if (it.slide && it.slide.to == null) it.slide = null; // цель слайда не нашлась
  // глушёные — ритм, а не ноты: места на уровнях им не достаются (иначе на Easy крестик вытеснил бы настоящую ноту)
  assignLevels(out.items.filter((it) => !it.dead));
  for (const it of out.items) if (it.dead) it.lvl = 3; // видны с Hard
  let pi = 0;
  for (const it of out.items) {
    while (pi + 1 < out.phrases.length && out.phrases[pi + 1].ms <= it.ms + 1) pi++;
    it.sec = pi;
  }
  out.positions = handPositions(out.items);
  out.views = cameraViews(out.items, out.positions);
  return out;
}

export const LEVELS = ['Easy', 'Medium', 'Hard', 'Full'];

/**
 * Части песни для сложности по частям: по меткам файла (Intro, Verse…) в порядке игры, с повторами; если меток меньше
 * двух — по восемь тактов. { ms, end, tick, text }.
 */
function phrases(lookup, toMs, sections) {
  const mbs = lookup.masterBars || [];
  const out = [];
  if (sections.length >= 2) {
    if (sections[0].ms > 1) out.push({ ms: 0, tick: 0, text: 'Intro' });
    for (const s of sections) out.push({ ms: s.ms, tick: s.tick, text: s.text.trim() });
  } else for (let i = 0; i < mbs.length; i += 8) out.push({ ms: toMs(mbs[i].start), tick: mbs[i].start, text: `Bars ${i + 1}–${Math.min(mbs.length, i + 8)}` });
  if (!out.length) out.push({ ms: 0, tick: 0, text: 'Song' });
  const endMs = mbs.length ? toMs(mbs[mbs.length - 1].end) : 0;
  out.forEach((p, i) => (p.end = i + 1 < out.length ? out[i + 1].ms : endMs));
  return out;
}
/**
 * Уровни сложности — сначала мало нот, потом больше: у каждой ноты lvl — с какого уровня (1…4) она видна.
 * 1 Easy — ноты на долях, не чаще раза в 0,4 с, у аккорда — одна нижняя нота;
 * 2 Medium — восьмые, не чаще раза в 0,2 с, у аккорда — две нижние;
 * 3 Hard — шестнадцатые, не чаще раза в 0,14 с, у аккорда — до трёх; 4 Full — вся партия (триоли, совсем быстрое).
 * Что видно на уровне ниже, видно и на всех уровнях выше: при повышении сложности ноты только добавляются.
 */
export function assignLevels(items) {
  for (const it of items) it.lvl = 4;
  const rules = [
    { grid: 1, gap: 400, max: 1 },
    { grid: 0.5, gap: 200, max: 2 },
    { grid: 0.25, gap: 140, max: 3 },
  ];
  rules.forEach((rule, li) => {
    const L = li + 1;
    let lastMs = -Infinity;
    for (let i = 0; i < items.length; ) {
      let j = i;
      while (j < items.length && items[j].tick === items[i].tick) j++;
      const group = items.slice(i, j);
      const beat = group[0].beat;
      const mb = beat.voice?.bar?.masterBar;
      const num = mb?.timeSignatureNumerator || 4;
      const den = mb?.timeSignatureDenominator || 4;
      let unit = 3840 / den; // доля такта в тиках; в 6/8, 9/8, 12/8 — пунктирная четверть
      if (den === 8 && num % 3 === 0) unit *= 3;
      const step = unit * rule.grid;
      const onGrid = !step || Math.abs(((beat.playbackStart % step) + step) % step) < 1;
      const forced = group.some((it) => it.lvl < L); // уже видна на уровне ниже
      if (forced || (onGrid && group[0].ms - lastMs >= rule.gap)) {
        lastMs = group[0].ms;
        const keep = [...group].sort((a, b) => (a.midi ?? 0) - (b.midi ?? 0)).slice(0, rule.max);
        for (const it of keep) it.lvl = Math.min(it.lvl, L);
      }
      i = j;
    }
  });
}

/**
 * Виды камеры на всю песню заранее: { ms, L, R } — какие лады должны быть в кадре (между проволоками L и R).
 * Новый вид — только когда ноты ближайших четырёх секунд не помещаются в прежний; иначе камера стоит.
 */
export function cameraViews(items, positions) {
  const views = [];
  let cur = null;
  let i = 0;
  for (const p of positions) {
    while (i < items.length && items[i].ms < p.ms) i++;
    let L = p.a - 1;
    let R = p.b ?? p.a + 3;
    for (let j = i; j < items.length && items[j].ms < p.ms + 4000; j++) {
      if (items[j].f > 0 && !items[j].dead) {
        L = Math.min(L, items[j].f - 1);
        R = Math.max(R, items[j].f);
      }
    }
    if (cur && L >= cur.L && R <= cur.R) continue; // всё помещается в прежний вид
    // если вместе с прежним видом выходит не шире обычного кадра — расширяем его, а не переезжаем
    if (cur && Math.max(R, cur.R) - Math.min(L, cur.L) <= 9) {
      L = Math.min(L, cur.L);
      R = Math.max(R, cur.R);
    }
    cur = { ms: p.ms, L, R };
    views.push(cur);
  }
  if (!views.length) views.push({ ms: 0, L: 0, R: 5 });
  return views;
}

/**
 * Позиции руки на всю песню заранее: { ms, a, b } — указательный палец на ладу a, рука накрывает лады a…b (обычно a+3)
 * (с растяжкой — до a+4). Считается по долям целиком (все ноты аккорда разом): позиция держится, пока доля
 * в неё помещается, а новая выбирается так, чтобы доля поместилась и накрылось больше нот следующих двух секунд.
 * Чаще чем раз в 0,3 с позиция не меняется: две смены подряд сливаются в одну; короткие позиции сглаживает steady().
 */
export function handPositions(items) {
  const out = [];
  let cur = null;
  for (let i = 0; i < items.length; ) {
    let j = i;
    while (j < items.length && items[j].tick === items[i].tick) j++;
    const frets = [];
    for (let x = i; x < j; x++) if (items[x].f > 0 && !items[x].dead) frets.push(items[x].f); // глушёные руку не двигают
    if (frets.length) {
      const lo = Math.min(...frets);
      const hi = Math.max(...frets);
      if (cur == null || lo < cur || hi > cur + 4) {
        const ahead = [];
        for (let x = i; x < items.length && items[x].ms < items[i].ms + 2000; x++) if (items[x].f > 0 && !items[x].dead) ahead.push(items[x].f);
        const aMin = Math.max(1, hi - 4);
        const aMax = Math.max(aMin, lo);
        let best = aMin;
        let bestScore = -Infinity;
        for (let a = aMin; a <= aMax; a++) {
          const fit = ahead.filter((f) => f >= a && f <= a + 3).length;
          const score = fit * 10 - (cur == null ? 0 : Math.abs(a - cur) * 0.5) - (lo - a) * 0.1; // ближе к прошлой позиции, палец пониже
          if (score > bestScore) {
            best = a;
            bestScore = score;
          }
        }
        cur = best;
        const last = out[out.length - 1];
        if (last && items[i].ms - last.ms < 300) Object.assign(last, { a: cur, b: Math.max(cur + 3, Math.min(hi, cur + 4)) });
        else out.push({ ms: items[i].ms, a: cur, b: cur + 3 });
      }
      // зона руки шире четырёх ладов, только если ноты позиции правда тянутся до пятого
      const last = out[out.length - 1];
      last.b = Math.max(last.b, Math.min(hi, last.a + 4));
    }
    i = j;
  }
  if (!out.length) out.push({ ms: 0, a: 1, b: 4 });
  return steady(out);
}

/**
 * Зона руки не мечется: позиция короче HOLD мс сливается с соседней (с той, где выходит уже), если вместе они
 * не шире MAX_ZONE ладов — рука чуть тянется, а не прыгает туда-обратно. Одинаковые соседние позиции — одна.
 * Проверено на песнях: в Master of Puppets смен вдвое меньше (16 → 8 в минуту), нот вне зоны не больше.
 */
const HOLD = 1500;
const MAX_ZONE = 6;
function steady(ps) {
  const out = ps.map((p) => ({ ...p }));
  for (let changed = true; changed; ) {
    changed = false;
    for (let i = 0; i < out.length; i++) {
      const p = out[i];
      const pv = out[i - 1];
      const nx = out[i + 1];
      if (pv && pv.a === p.a && pv.b === p.b) {
        out.splice(i, 1);
        changed = true;
        break;
      }
      if (!nx || nx.ms - p.ms >= HOLD) continue; // последняя позиция держится до конца песни
      const union = (q) => {
        const a = Math.min(q.a, p.a);
        const b = Math.max(q.b, p.b);
        return b - a + 1 <= MAX_ZONE ? { a, b } : null;
      };
      const u1 = pv && union(pv);
      const u2 = nx && union(nx);
      if (u1 && (!u2 || u1.b - u1.a <= u2.b - u2.a)) {
        Object.assign(pv, u1);
        out.splice(i, 1);
        changed = true;
        break;
      }
      if (u2) {
        Object.assign(nx, u2, { ms: p.ms });
        out.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  return out;
}

/** Последняя запись списка { ms, … }, которая действует в момент ms. */
function at(list, ms) {
  if (!list?.length) return null;
  if (list[0].ms > ms) return list[0];
  let lo = 0;
  let hi = list.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (list[mid].ms <= ms) lo = mid;
    else hi = mid - 1;
  }
  return list[lo];
}

/** Позиция руки в момент ms: { a, b } — первый и последний лад зоны (новая показывается чуть заранее — HAND_LEAD). */
export function handAt(tl, ms) {
  const p = at(tl.positions, ms + HAND_LEAD);
  return { a: p?.a ?? 1, b: p?.b ?? (p?.a ?? 1) + 3 };
}

/**
 * Кадр камеры в момент ms: центр и ширина в ладах. Виды посчитаны на всю песню заранее (cameraViews),
 * камера переезжает только на новый вид. Ширина кадра — по разбросу нот вида (13–22 лада), ноты — в его левой
 * части, а справа гриф к корпусу: дорога подходит к нотам наискось, как в игре с места гитариста. Если ноты вида
 * шире — кадр по центру. Переезд плавный.
 */
export function cameraAt(tl, ms, width) {
  // на узком окне ладов в кадре чуть больше: иначе соседние лады совсем пропадают
  const base = width && width < 900 ? MIN_WIN + 1 : MIN_WIN;
  const h = handAt(tl, ms);
  const vs = tl.views || [];
  const cur = at(vs, ms + 300) || { L: h.a - 1, R: h.b };
  let L = cur.L;
  let R = cur.R;
  // ноты следующего места уже летят по дороге — камера едет к ним заранее, а не догоняет, когда их пора играть:
  // кадр захватывает и их (если вместе не шире 16 ладов), а если место далеко — переезжает туда за 1,2 с до первой ноты
  const nx = vs[vs.indexOf(cur) + 1];
  if (nx && cur !== vs[vs.length - 1] && nx.ms - ms < TUNE.look * 1000 + 300) {
    const uL = Math.min(L, nx.L);
    const uR = Math.max(R, nx.R);
    if (uR - uL <= 16) [L, R] = [uL, uR];
    else if (nx.ms - ms < 1200) [L, R] = [nx.L, nx.R];
  }
  const span = R - L;
  const w = Math.min(MAX_WIN, Math.max(base, (span + 0.4) / (RIGHT - LEFT)));
  const fits = span + 0.4 <= (RIGHT - LEFT) * w;
  const x = fits ? L - 0.2 - LEFT * w + w / 2 : (L + R) / 2;
  return { w, x: Math.max(w / 2 - 1, Math.min(24.8 - w / 2, x)) };
}

function el(tag, cls) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  return n;
}

/**
 * @param {HTMLElement} host
 * @param {{ getClock: () => { ms: number, playing: boolean, speed: number }, getStats?: () => { streak: number } }} o
 */
export function createHighway(host, { getClock, getStats }) {
  const cv = el('canvas', 'hw-canvas');
  const msg = el('div', 'hw-note');
  msg.hidden = true;
  host.replaceChildren(cv, msg);
  const ctx = cv.getContext('2d');

  let tl = { items: [], chords: [], bars: [], strings: 6, tab: false };
  let pal = palette(6);
  let shades = pal.map(makeShades);
  let deadShades = shades.map((x) => ({ ...x, front: '#2a2c38', top: '#3a3d4c', side: '#1c1e27' })); // глушёная: тёмная, рёбра цвета струны
  let byBeat = new Map(); // доля → её проходы (один на каждое повторение)
  let active = false;
  let mode = 'listen';
  let wait = null; // { beat, tick } — нота, которую ждём
  let shown = 0; // время на экране, мс песни
  let lastFrame = 0;
  let lastDraw = 0;
  let raf = 0;
  let dirty = true;
  const cam = { x: 3, w: 8, tx: 3, tw: 8, moving: false };
  const hand = { a: 0, b: 4, ta: 0, tb: 4 }; // зона руки на грифе (между проволоками ладов a и b)
  const sparks = []; // { x, y, vx, vy, life, color }
  const pops = []; // { x, y, text, life, color }
  let W = 0;
  let H = 0;
  let dpr = 1;
  let streakShown = 0;
  // после перемотки, начала петли или «Жди меня» первый аккорд серии повторов показывается целиком (плитки и название):
  // иначе посреди серии видны одни пустые рамки и непонятно, что играть
  let fullChord = null;
  const perf = { ms: 0, frames: 0 }; // сколько стоит рисование (для проверок)
  let geo = null; // геометрия последнего кадра — по ней искры встают точно на струну

  function resize() {
    const r = host.getBoundingClientRect();
    const d = Math.min(2, window.devicePixelRatio || 1);
    if (Math.round(r.width) === W && Math.round(r.height) === H && d === dpr) return;
    W = Math.round(r.width);
    H = Math.round(r.height);
    dpr = d;
    cv.width = Math.max(1, W * dpr);
    cv.height = Math.max(1, H * dpr);
    aimCamera(shown, true); // ширина кадра зависит от размера: встаём сразу, без медленного «наезда»
  }

  /**
   * Сцена в 3D и камера. Мир: x — лады (кадр всегда 10 единиц шириной: при широком кадре лады уже), y — высота
   * над дорогой, z — вглубь (секунды до ноты × v). Гриф — стенка на z = 0: тонкая струна внизу, толстая вверху.
   * Ноты летят на высоте своих струн. Камера сверху и чуть справа, со стороны игрока: смотрит вниз (pitch) и немного
   * влево (yaw) — головка грифа уходит вдаль, лады у корпуса ближе, дорога идёт к горизонту чуть наискось.
   * Дальность, точка схода и ширина кадра подбираются под размер окна; от сдвига камеры по грифу они не зависят.
   */
  function geometry() {
    const n = tl.strings;
    const span = Math.max(1, n - 1);
    const REF = 10;
    const M = 0.75; // поля грифа над и под крайними струнами — в шагах между струнами
    const fw = REF / cam.w; // мировых единиц на лад
    const xw = (fx) => (fx - cam.x) * fw;
    const gapPx = (H * (TUNE.bot - TUNE.top)) / span; // шаг струн на экране — примерно такой
    const g = gapPx / ((W * 0.96) / REF);
    const top = (span + 2 * M) * g; // верхний край грифа
    const yOf = (u) => (M + u) * g; // струна u (0 — тонкая)
    const psi = (TUNE.yaw * Math.PI) / 180;
    const phi = (TUNE.pitch * Math.PI) / 180;
    const f = [-Math.sin(psi) * Math.cos(phi), -Math.sin(phi), Math.cos(psi) * Math.cos(phi)]; // взгляд
    const r = [Math.cos(psi), 0, Math.sin(psi)]; // вправо
    const up = [-Math.sin(psi) * Math.sin(phi), Math.cos(phi), Math.cos(psi) * Math.sin(phi)]; // вверх
    const cyS = (H * (TUNE.top + TUNE.bot)) / 2; // середина грифа на экране
    // точка схода дороги — так высоко, чтобы дальние ноты были примерно в farScale от ближних
    const floorPx = H * TUNE.bot + gapPx * M;
    const vp = (H * TUNE.far - TUNE.farScale * floorPx) / (1 - TUNE.farScale);
    const F = Math.max(H * 0.5, (cyS - vp) / Math.tan(phi));
    // расстояние до грифа и сдвиг цели: кадр (10 единиц) ровно на 96 % ширины, с учётом поворота
    const c = W * 0.48;
    const a = Math.cos(psi);
    const b = Math.sin(psi) * Math.cos(phi);
    const dist = (REF * (F * F * a * a - c * c * b * b)) / (2 * c * F * a);
    const tx = REF / 2 - (c * dist) / (F * a + c * b);
    const C = [tx - dist * f[0], top / 2 - dist * f[1], -dist * f[2]];
    /** Точка мира → [x, y на экране, пикселей на единицу мира в этой точке]. */
    const proj = (x, y, z) => {
      const rx = x - C[0];
      const ry = y - C[1];
      const rz = z - C[2];
      const dp = Math.max(0.05 * dist, rx * f[0] + ry * f[1] + rz * f[2]);
      return [W / 2 + (F * (rx * r[0] + rz * r[2])) / dp, cyS - (F * (rx * up[0] + ry * up[1] + rz * up[2])) / dp, F / dp];
    };
    // скорость дороги: дальний край (look секунд) — на высоте far
    let lo = 0;
    let hi = dist * 200;
    if (proj(tx, 0, hi)[1] < H * TUNE.far) {
      for (let i = 0; i < 40; i++) {
        const mid = (lo + hi) / 2;
        if (proj(tx, 0, mid)[1] > H * TUNE.far) lo = mid;
        else hi = mid;
      }
    }
    const v = hi / TUNE.look;
    const S0 = F / dist; // масштаб у грифа (для размеров надписей)
    /** Нота на струне u за d секунд до неё (пролетевшая остаётся на струне). */
    const P = (fx, u, d) => proj(xw(fx), yOf(u), Math.max(d, 0) * v);
    return { n, look: TUNE.look, g, M, top, fw, xw, yOf, proj, P, v, S0, gap: gapPx, camX: C[0], uOf: (s) => n - 1 - s };
  }

  /** Первый индекс ноты, которая начинается не раньше ms. */
  function lowerBound(ms) {
    const a = tl.items;
    let lo = 0;
    let hi = a.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (a[mid].ms < ms) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /**
   * Перемотка (петля, «в начало», переход): у нот впереди стираем прошлые попадания и промахи. Промахнутые
   * в прошлом проходе помечаются «!» — в петле видно, где ошибся в прошлый раз.
   */
  function jump(ms) {
    if (ms < shown - 1) {
      for (let i = lowerBound(ms - 60); i < tl.items.length; i++) {
        const it = tl.items[i];
        if (it.state) it.prevMiss = it.state === 'miss';
        it.state = null;
      }
    }
    shown = ms;
    markFull(ms);
  }
  // уровень сложности: видны ноты с lvl не выше него (4 — вся партия). 5 — «Auto»: у каждой части песни свой уровень
  let level = 4;
  let phraseLevels = [];
  const levelOf = (it) => (level === 5 ? phraseLevels[it.sec] || 1 : level);
  const vis = (it) => (it.lvl ?? 4) <= levelOf(it);
  const visCount = (c) => c.items.reduce((n, it) => n + (vis(it) ? 1 : 0), 0);
  /** Первый аккорд с момента ms (из видимых на этом уровне): если это повтор — показать его целиком. */
  function markFull(ms) {
    const c = tl.chords.find((x) => x.ms >= ms - 50 && visCount(x) >= 2);
    fullChord = c?.repeat ? c : null;
  }
  // повтор — пустая рамка, только если на этом уровне от аккорда видно хотя бы две ноты (иначе это просто нота)
  const emptyRep = (c) => !!c && c.repeat && c !== fullChord && visCount(c) >= 2;

  /**
   * Камера стоит, пока ноты помещаются в кадр: виды посчитаны на всю песню заранее (cameraViews),
   * и она переезжает только на новый вид — плавно, вместе с наездом.
   */
  function aimCamera(now, fast) {
    const h = handAt(tl, now);
    hand.ta = h.a - 1;
    hand.tb = h.b;
    const v = cameraAt(tl, now, W);
    cam.tw = v.w;
    cam.tx = v.x;
    if (fast) {
      cam.x = cam.tx;
      cam.w = cam.tw;
      hand.a = hand.ta;
      hand.b = hand.tb;
    }
  }

  // ---------- кадр ----------
  function frame(t) {
    raf = 0;
    if (!active) return;
    const dt = lastFrame ? Math.min(0.1, (t - lastFrame) / 1000) : 0;
    lastFrame = t;
    const clk = getClock();
    const target = clk.ms - OFFSET_MS;
    if (clk.playing) {
      // свои часы идут плавно, а сообщения плеера только подправляют их (они приходят неровно)
      // и идут только вперёд: мелкие поправки назад не дёргают ноты, назад — только перемотка
      const predicted = shown + dt * 1000 * clk.speed;
      const err = target - predicted;
      if (Math.abs(err) > 400) jump(target);
      else shown = Math.max(shown, predicted + err * 0.08);
    } else {
      const d = target - shown;
      if (d < -250 || d > 6000) jump(target);
      else {
        if (Math.abs(d) > 300 && !wait) markFull(target); // перемотка на паузе: дорога доедет плавно
        // «Жди меня»: дорога плавно подъезжает к следующей ноте (и встаёт точно на место, без хвоста)
        shown = Math.abs(d) < 0.5 ? target : shown + d * (1 - Math.exp(-dt / 0.09));
      }
    }
    aimCamera(shown, false);
    // плавный переезд камеры и зоны руки; последние сотые доли лада — сразу, без бесконечного «хвоста»
    const ease = (v, to, k) => (Math.abs(to - v) < 0.02 ? to : v + (to - v) * k);
    const a = 1 - Math.exp(-dt / 0.35); // переезд камеры — быстрый, но плавный
    cam.x = ease(cam.x, cam.tx, a);
    cam.w = ease(cam.w, cam.tw, a);
    const ha = 1 - Math.exp(-dt / 0.3);
    hand.a = ease(hand.a, hand.ta, ha);
    hand.b = ease(hand.b, hand.tb, ha);
    cam.moving = cam.x !== cam.tx || cam.w !== cam.tw || hand.a !== hand.ta || hand.b !== hand.tb;
    const easing = Math.abs(target - shown) > 1;
    const pulse = mode === 'wait' && wait && t - lastDraw > 50; // мигание ждущей ноты — не чаще 20 раз в секунду
    if (dirty || clk.playing || easing || cam.moving || sparks.length || pops.length || pulse) {
      const t0 = performance.now();
      draw(dt, t);
      perf.ms += performance.now() - t0;
      perf.frames++;
      lastDraw = t;
      dirty = false;
    }
    raf = requestAnimationFrame(frame);
  }

  function draw(dt, t) {
    resize();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (!tl.tab || !tl.items.length || W < 50 || H < 50) return;
    const now = shown;
    geo = geometry();
    const { n, look, g, top, fw, xw, yOf, proj, P, v, S0, uOf, camX } = geo;
    const zFar = look * v;
    const L0 = Math.floor(cam.x - cam.w / 2 - 1);
    const R0 = Math.ceil(cam.x + cam.w / 2 + 1);
    const bx0 = cam.x - cam.w * 1.2; // гриф и струны — далеко за края экрана
    const bx1 = cam.x + cam.w * 1.2;
    const first = lowerBound(now - 8000);
    const lastMs = now + look * 1000;
    // верхний край грифа на экране (прямая): дорога ниже него — за грифом
    const [tax, tay] = proj(xw(bx0), top, 0);
    const [tbx, tby] = proj(xw(bx1), top, 0);
    const boardTopAt = (sx) => tay + ((tby - tay) * (sx - tax)) / (tbx - tax || 1);
    // зона руки в момент ноты: открытая струна — планка через неё (у будущих нот — через будущую позицию, не текущую)
    const zoneOf = (it) => {
      const z = handAt(tl, it.ms);
      return [z.a - 1, z.b];
    };
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineCap = 'butt';

    // ближайшая доля (то, что играть следующим): её лады подсвечиваются на дороге и на грифе (у глушёных — нет)
    const nextNotes = [];
    for (let i = lowerBound(now - 60); i < tl.items.length; i++) {
      const it = tl.items[i];
      if (it.ms > now + 1300) break;
      if (it.state || !vis(it) || it.dead) continue;
      if (nextNotes.length && it.tick !== nextNotes[0].tick) break;
      nextNotes.push(it);
    }
    const nextD = nextNotes.length ? Math.max(0, (nextNotes[0].ms - now) / 1000) : 9;
    const nextOn = Math.max(0, 1 - nextD / 1.3); // 0 — далеко, 1 — у грифа

    // ---------- дорога ----------
    const F0 = (fx, z) => proj(xw(fx), 0, z);
    const floor = (a, b, z0 = 0, z1 = zFar) => poly([F0(a, z0), F0(b, z0), F0(b, z1), F0(a, z1)]);
    ctx.fillStyle = 'rgba(14, 15, 24, 0.7)';
    floor(L0 - 2, R0 + 2);
    // где стоит рука, видно по ярким цифрам ладов под грифом: границ диапазона на дороге и грифе нет — дорога не пестрит
    // дорожка следующей ноты
    if (nextOn > 0) {
      ctx.fillStyle = `rgba(150, 160, 255, ${(0.22 * nextOn).toFixed(3)})`;
      for (const it of nextNotes) if (it.f > 0) floor(it.f - 1, it.f);
    }
    ctx.strokeStyle = 'rgba(130, 140, 255, 0.22)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let f = L0 - 2; f <= R0 + 2; f++) path(F0(f, 0), F0(f, zFar));
    ctx.stroke();
    // такты — поперечные линии
    ctx.strokeStyle = 'rgba(200, 205, 255, 0.14)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const b of tl.bars) {
      const d = (b - now) / 1000;
      if (d < 0.05 || d > look) continue;
      path(F0(L0 - 2, d * v), F0(R0 + 2, d * v));
    }
    ctx.stroke();
    // номера ладов с метками посреди дороги
    ctx.font = '700 13px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(160, 200, 255, 0.45)';
    for (let f = Math.max(1, L0); f <= R0; f++) {
      if (!INLAYS.has(f)) continue;
      const [x, y] = F0(f - 0.5, 0.65 * look * v);
      ctx.fillText(String(f), x, y - 9);
    }
    ctx.globalAlpha = 1;

    // хвосты — ленты шириной с ноту на высоте струны: у слайда лента сворачивает к целевому ладу, у вибрато идёт
    // волной, у тремоло — зубцами. У открытой струны — лента через зону руки. У нот аккорда своих хвостов нет:
    // сколько держать аккорд, показывают рейки на дороге (ниже)
    for (let i = first; i < tl.items.length && tl.items[i].ms <= lastMs; i++) {
      const it = tl.items[i];
      if (!vis(it) || it.dead || it.state === 'miss') continue;
      const slide = !!it.slide && it.f > 0;
      const endMs = slide ? it.slide.endMs ?? it.endMs : it.endMs;
      if (!slide && endMs - it.ms < SUSTAIN_MS) continue;
      if (!slide && it.chord && visCount(it.chord) >= 2) continue;
      const d0 = Math.max((it.ms - now) / 1000, 0);
      const d1 = Math.min((endMs - now) / 1000, look - 0.3); // у дальнего края дороги хвост обрывается вместе с нотами
      if (d1 <= d0) continue;
      const y = yOf(uOf(it.s));
      ctx.strokeStyle = ctx.fillStyle = pal[it.s];
      if (it.f === 0) {
        const [za, zb] = zoneOf(it);
        const pts = [proj(xw(za + 0.06), y, d0 * v), proj(xw(zb - 0.06), y, d0 * v), proj(xw(zb - 0.06), y, d1 * v), proj(xw(za + 0.06), y, d1 * v)];
        ctx.globalAlpha = 0.16;
        poly(pts);
        ctx.globalAlpha = 0.6;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        path(pts[0], pts[3]);
        path(pts[1], pts[2]);
        ctx.stroke();
        continue;
      }
      ribbon(it, d0, d1, endMs, y);
    }
    ctx.globalAlpha = 1;

    // ---------- гриф: стенка поперёк экрана, толстая струна вверху ----------
    const B = (fx, y) => proj(xw(fx), y, 0);
    ctx.fillStyle = '#15161f';
    poly([B(bx0, 0), B(bx1, 0), B(bx1, top), B(bx0, top)]);
    // верхний край грифа — светлая кромка
    ctx.strokeStyle = 'rgba(200, 205, 255, 0.3)';
    ctx.lineWidth = 2;
    line(B(bx0, top), B(bx1, top));
    // метки на накладке
    ctx.fillStyle = 'rgba(230, 232, 240, 0.16)';
    const midU = (a, b) => n - 1 - (a + b) / 2;
    for (let f = Math.max(1, L0); f <= R0; f++) {
      if (!INLAYS.has(f)) continue;
      const us = f % 12 === 0 ? [midU(1, 2), midU(n - 3, n - 2)] : [midU(Math.floor((n - 1) / 2), Math.ceil((n - 1) / 2))];
      for (const u of us) {
        const [x, y, s] = B(f - 0.5, yOf(u));
        const rr = Math.max(2.5, 0.26 * g * s);
        ctx.beginPath();
        ctx.ellipse(x, y, rr, rr * 0.85, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // лады
    ctx.strokeStyle = 'rgba(190, 194, 214, 0.45)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let f = Math.max(0, L0 - 2); f <= R0 + 2; f++) path(B(f, 0), B(f, top));
    ctx.stroke();
    if (L0 - 2 <= 0) {
      ctx.strokeStyle = 'rgba(235, 236, 245, 0.85)';
      ctx.lineWidth = 5;
      line(B(0, 0), B(0, top));
    }
    // струны — через весь экран
    for (let s = 0; s < n; s++) {
      const y = yOf(uOf(s));
      // струна светится: мягкий широкий ореол и яркая сердцевина
      const lw = 1.6 + (n - 1 - s) * 0.5;
      ctx.strokeStyle = pal[s];
      ctx.globalAlpha = 0.22;
      ctx.lineWidth = lw * 3;
      line(B(bx0, y), B(bx1, y));
      ctx.globalAlpha = 1;
      ctx.lineWidth = lw;
      line(B(bx0, y), B(bx1, y));
    }
    ctx.globalAlpha = 1;
    // номера ладов под грифом: зона руки — светлые, лад следующей ноты — цветом струны (размер не меняется)
    const nextFret = new Map(nextNotes.filter((x) => x.f > 0).map((x) => [x.f, pal[x.s]]));
    const rz = Math.round(Math.max(16, Math.min(26, H * 0.032)));
    // жёлтые со свечением: в зоне руки — ярко, остальные приглушённо; лад следующей ноты — чуть крупнее
    ctx.shadowColor = 'rgba(255, 196, 40, 0.85)';
    for (let f = Math.max(1, L0); f <= R0; f++) {
      const inHand = f > hand.a + 0.5 && f < hand.b + 0.5;
      const next = nextOn > 0.2 && nextFret.get(f);
      ctx.font = `800 ${next ? Math.round(rz * 1.2) : rz}px system-ui, sans-serif`;
      ctx.fillStyle = inHand || next ? '#ffd23f' : 'rgba(255, 210, 63, 0.4)';
      ctx.shadowBlur = inHand || next ? (next ? 14 : 9) : 0;
      const [x, y] = B(f - 0.5, 0);
      ctx.fillText(String(f), x, y + rz * 0.95);
    }
    ctx.shadowBlur = 0;

    // столбики на ладу следующей ноты: загораются по мере подлёта; ждущая нота в «Жди меня» мигает
    const pulse = 0.55 + 0.45 * Math.sin(t / 160);
    const waiting = (it) => wait && it.beat === wait.beat && Math.abs(it.tick - wait.tick) < 2;
    const postOn = nextNotes.some(waiting) ? pulse : nextOn;
    if (postOn > 0) {
      const frets = new Set();
      for (const it of nextNotes) if (it.f > 0) frets.add(it.f - 1).add(it.f);
      for (const e of frets) {
        const a = B(e, -0.4 * g);
        const b = B(e, top + 0.4 * g);
        ctx.strokeStyle = `rgba(255, 255, 255, ${(0.25 * postOn).toFixed(3)})`;
        ctx.lineWidth = 9;
        line(a, b);
        ctx.strokeStyle = `rgba(255, 255, 255, ${(0.95 * postOn).toFixed(3)})`;
        ctx.lineWidth = 3;
        line(a, b);
      }
      // плашка на струне, куда сядет нота: плоская, полупрозрачная, цвета струны, со светлой серединой.
      // У открытой струны — тонкая плашка через зону руки
      for (const it of nextNotes) {
        const yc = yOf(uOf(it.s));
        const wx0 = 0.6 * fw;
        const [xa, xb] = it.f === 0 ? [xw(hand.a + 0.1), xw(hand.b - 0.1)] : [xw(it.f - 0.5) - wx0 * 0.62, xw(it.f - 0.5) + wx0 * 0.62];
        const hy = it.f === 0 ? 0.36 * g : g * 0.92;
        const pts = [proj(xa, yc - hy / 2, 0), proj(xb, yc - hy / 2, 0), proj(xb, yc + hy / 2, 0), proj(xa, yc + hy / 2, 0)];
        const inner = [proj(xa, yc - hy * 0.18, 0), proj(xb, yc - hy * 0.18, 0), proj(xb, yc + hy * 0.18, 0), proj(xa, yc + hy * 0.18, 0)];
        ctx.fillStyle = shades[it.s].base;
        ctx.globalAlpha = postOn * 0.38;
        poly(pts);
        ctx.fillStyle = shades[it.s].edge;
        ctx.globalAlpha = postOn * 0.5;
        poly(inner);
      }
      ctx.globalAlpha = 1;
    }

    // ---------- ноты: от дальних к ближним, открытые струны — первым проходом ----------
    const end = lowerBound(lastMs + 1);
    for (const pass of [0, 1]) {
      for (let i = end - 1; i >= first; i--) {
        const it = tl.items[i];
        if ((it.f === 0) !== (pass === 0) || !vis(it)) continue;
        const d = (it.ms - now) / 1000;
        if (d < -PAST || d > look) continue;
        let alpha = d > look - 0.35 ? (look - d) / 0.35 : d < 0 ? Math.max(0, 1 + d / PAST) : 1; // вдали ноты проявляются
        if (it.state === 'hit' && d < 0) alpha *= 0.25; // сыгранная нота рассыпается искрами
        if (alpha <= 0.02 || (it.rep && emptyRep(it.chord))) continue; // повтор аккорда — только пустая рамка (ниже)
        const u = uOf(it.s);
        const shrink = d < 0 ? 1 + d * 1.2 : 1;
        const color = it.state === 'miss' ? '#5b5f70' : pal[it.s];
        const z = Math.max(d, 0) * v;
        if (it.f === 0) {
          // открытая струна — тонкая светящаяся линия через всю зону руки, без цифры
          const [za, zb] = zoneOf(it);
          const pa = proj(xw(za + 0.06), yOf(u), z);
          const pb = proj(xw(zb - 0.06), yOf(u), z);
          const th = Math.max(2, 0.2 * g * pa[2] * shrink);
          openBar(pa, pb, th, it.dead ? '#8a8ea0' : color, alpha);
          const mx = (pa[0] + pb[0]) / 2;
          const my = (pa[1] + pb[1]) / 2;
          const gs = Math.max(7, Math.min(14, th * 3.2));
          ctx.globalAlpha = alpha;
          if (it.dead) cross(mx, my, gs * 0.6, color);
          if (it.pm) cross(mx, my, gs * 0.45, 'rgba(230, 232, 240, 0.9)', 0.35);
          glyphs(it, mx, my - th, gs, false);
          if (it.prevMiss && !it.state) badge(pb[0] - gs, my - th - gs * 0.2, gs * 0.55);
          continue;
        }
        // нота — объёмный брусок цвета струны: лицевая грань, верх и бок. Цифры на нём нет: лад — у основания ножки
        // на дороге и на линейке под грифом (так глаз смотрит на дорогу, а не читает каждую плитку)
        const xc = xw(it.f - 0.5);
        const yc = yOf(u);
        const wx = 0.6 * fw * shrink;
        const hy = Math.min(wx * 0.42, g * 0.78) * shrink; // не выше промежутка до соседней струны
        const dz = Math.min(wx * 0.5, 0.14 * v);
        const x0 = xc - wx / 2;
        const x1 = xc + wx / 2;
        const F00 = proj(x0, yc - hy / 2, z);
        const F10 = proj(x1, yc - hy / 2, z);
        const F11 = proj(x1, yc + hy / 2, z);
        const F01 = proj(x0, yc + hy / 2, z);
        const T0 = proj(x0, yc + hy / 2, z + dz);
        const T1 = proj(x1, yc + hy / 2, z + dz);
        const front = [F00, F10, F11, F01];
        const x = (F00[0] + F10[0]) / 2;
        const y = (F00[1] + F01[1]) / 2;
        const w = F10[0] - F00[0];
        const h = F00[1] - F01[1];
        const kk = F00[2] / S0;
        const sh = it.state === 'miss' ? MISS_SHADES : it.dead ? deadShades[it.s] : shades[it.s];
        if (d > 0.03) {
          // тонкая ножка до дороги и номер лада у её основания. Где дорога ещё за грифом, ножка обрывается у его
          // верхнего края, а лад видно на линейке под грифом
          let [fx, fy, fs] = proj(xc, 0, z);
          const y0 = F00[1];
          const edge = boardTopAt(fx);
          const hidden = fy > edge;
          if (!hidden || y0 < edge) {
            if (hidden) {
              fx = x + ((fx - x) * (edge - y0)) / (fy - y0);
              fy = edge;
            }
            ctx.globalAlpha = alpha * 0.45;
            ctx.strokeStyle = sh.base;
            ctx.lineWidth = Math.max(1, 1.5 * kk);
            line([x, y0], [fx, fy]);
            if (!hidden) {
              ctx.globalAlpha = alpha * 0.6;
              ctx.fillStyle = sh.base;
              const tw = 0.22 * fw * fs;
              ctx.fillRect(fx - tw, fy - 1, tw * 2, 2);
              if (!it.dead) {
                const fz = Math.round(Math.max(10, Math.min(24, 0.5 * fw * fs)));
                ctx.globalAlpha = alpha;
                ctx.font = `800 ${fz}px system-ui, sans-serif`;
                ctx.lineWidth = 3;
                ctx.strokeStyle = 'rgba(8, 9, 14, 0.85)';
                ctx.strokeText(String(it.f), fx, fy + fz * 0.7);
                ctx.fillStyle = sh.edge;
                ctx.fillText(String(it.f), fx, fy + fz * 0.7);
              }
            }
          }
        }
        // свечение вокруг лицевой грани (у акцента — ярче и шире)
        ctx.strokeStyle = sh.base;
        ctx.globalAlpha = alpha * (it.acc && !it.dead ? 0.7 : 0.3);
        ctx.lineWidth = it.acc && !it.dead ? 7 : 4;
        poly(front, true);
        ctx.globalAlpha = alpha;
        // верх и бок, который смотрит на камеру
        ctx.fillStyle = sh.top;
        poly([F01, F11, T1, T0]);
        if (camX > x1) {
          ctx.fillStyle = sh.side;
          poly([F10, proj(x1, yc - hy / 2, z + dz), T1, F11]);
        } else if (camX < x0) {
          ctx.fillStyle = sh.side;
          poly([F00, proj(x0, yc - hy / 2, z + dz), T0, F01]);
        }
        ctx.fillStyle = sh.front;
        poly(front);
        // блик по верху лицевой грани и светлые рёбра
        ctx.fillStyle = 'rgba(255, 255, 255, 0.22)';
        poly([F01, F11, [F11[0], F11[1] + h * 0.3], [F01[0], F01[1] + h * 0.3]]);
        ctx.strokeStyle = sh.edge;
        ctx.lineWidth = 1.2;
        poly(front, true);
        poly([F01, F11, T1, T0], true);
        if (it.dead) cross(x, y, Math.min(h * 0.38, w * 0.2), '#e6e8f0');
        if (it.harm) {
          // флажолет — кольцо, у искусственного — золотое
          ctx.strokeStyle = it.pinch ? '#ffd36b' : 'rgba(255, 255, 255, 0.95)';
          ctx.lineWidth = Math.max(1.5, h * 0.14);
          ctx.beginPath();
          ctx.ellipse(x, y, Math.min(w * 0.3, h * 0.8), h * 0.34, 0, 0, Math.PI * 2);
          ctx.stroke();
        }
        if (it.pm) {
          // глушение ладонью — черта под нотой
          ctx.fillStyle = 'rgba(230, 232, 240, 0.85)';
          ctx.fillRect(x - w * 0.36, F00[1] + Math.max(1.5, 3 * kk), w * 0.72, Math.max(1.5, 3 * kk));
        }
        const gs = Math.max(7, Math.min(15, h * 0.8));
        glyphs(it, x, Math.min(T0[1], T1[1]), gs, it.endMs - it.ms < SUSTAIN_MS);
        // палец из файла — у грифа
        if (it.finger != null && d < 1.2 && h >= 8) {
          const r = Math.max(6, h * 0.5);
          ctx.fillStyle = '#e6e8f0';
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = '#101118';
          ctx.font = `800 ${Math.round(r * 1.3)}px system-ui, sans-serif`;
          ctx.fillText(it.finger === 0 ? 'T' : String(it.finger), x, y + 1);
        }
        if (it.prevMiss && !it.state) badge(F11[0], F11[1], Math.max(6, h * 0.45));
      }
    }
    ctx.globalAlpha = 1;

    // аккорды: прозрачная рамка во всю зону руки (шире, если ноты выходят за неё) от дороги до верха грифа,
    // название над ней. Тот же аккорд сразу ещё раз — пустая нижняя половина рамки: доезжает до грифа, и там
    // загораются лады и клетки нот, как у обычного аккорда. Сколько держать аккорд — две рейки на дороге
    let upcoming = null; // крупное название слева: ближайший аккорд впереди или тот, что ещё звучит
    let ringing = null;
    for (let ci = tl.chords.length - 1; ci >= 0; ci--) {
      const c = tl.chords[ci];
      if (c.ms > lastMs) continue;
      if (c.ms < now - 20000) break;
      const d = (c.ms - now) / 1000;
      const items = c.items.filter(vis);
      if (items.length < 2) continue; // на лёгком уровне от аккорда может остаться одна нота — тогда без рамки
      const endMs = Math.max(...items.map((it) => it.endMs));
      if (endMs < now - PAST * 1000 && d < -PAST) continue;
      if (c.name && c.ms >= now - 100 && d < Math.min(2.2, look)) upcoming = c;
      else if (c.name && !ringing && c.ms < now - 100 && endMs > now) ringing = c;
      const empty = emptyRep(c);
      // по ширине — ноты аккорда; с открытой струной — вся зона руки (струна звучит через неё)
      let fx1 = Infinity;
      let fx2 = -Infinity;
      let u2 = 0;
      for (const it of items) {
        u2 = Math.max(u2, uOf(it.s));
        if (it.f === 0) {
          const [za, zb] = zoneOf(it);
          fx1 = Math.min(fx1, za + 0.04);
          fx2 = Math.max(fx2, zb - 0.04);
        } else {
          fx1 = Math.min(fx1, it.f - 0.5 - 0.4);
          fx2 = Math.max(fx2, it.f - 0.5 + 0.4);
        }
      }
      const z = Math.max(d, 0) * v;
      // рейки длины аккорда
      if (endMs - c.ms >= SUSTAIN_MS) {
        const z1 = (Math.min(look, (endMs - now) / 1000) * v);
        if (z1 > z) {
          const missed = items.some((it) => it.state === 'miss');
          ctx.globalAlpha = 0.06;
          ctx.fillStyle = '#c9ccff';
          floor(fx1, fx2, z, z1);
          ctx.globalAlpha = missed ? 0.3 : 0.75;
          ctx.strokeStyle = missed ? '#6b6f80' : '#c9ccff';
          ctx.lineWidth = 2.5;
          ctx.beginPath();
          path(F0(fx1, z), F0(fx1, z1));
          path(F0(fx2, z), F0(fx2, z1));
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
      }
      if (d < -PAST || d > look - 0.3) continue;
      if (d < -0.05 && !empty) continue;
      const missed = items.some((it) => it.state === 'miss');
      const hit = items.every((it) => it.state === 'hit');
      let alpha = d > look - 0.8 ? (look - 0.3 - d) / 0.5 : 1;
      if (d < 0) alpha *= Math.max(0, 1 + d / PAST) * (hit ? 0.3 : 1);
      if (alpha <= 0.02) continue;
      // от дороги до верхней ноты аккорда; повтор — нижняя половина
      const hTop = yOf(u2) + 0.6 * g;
      const yTop = empty ? hTop * 0.5 : hTop;
      const A = proj(xw(fx1), yTop, z);
      const B2 = proj(xw(fx2), yTop, z);
      const C2 = proj(xw(fx2), 0, z);
      const D = proj(xw(fx1), 0, z);
      const kk = A[2] / S0;
      alpha *= 0.45 + 0.55 * Math.min(1, kk); // дальние рамки бледнее — не заслоняют ноты
      ctx.globalAlpha = alpha * (empty ? 0.16 : 0.05);
      ctx.fillStyle = missed ? '#5b5f70' : '#c9ccff';
      poly([A, B2, C2, D]);
      ctx.globalAlpha = alpha * (empty ? 0.9 : 0.7);
      ctx.strokeStyle = missed ? '#6b6f80' : empty ? '#c9ccff' : 'rgba(214, 218, 255, 0.85)';
      ctx.lineWidth = empty ? Math.max(1.5, 2.5 * kk) : Math.max(1.2, 2 * kk);
      ctx.beginPath();
      if (empty) {
        // нижняя половина: стойки и низ
        path(A, D);
        path(D, C2);
        path(C2, B2);
      } else {
        path(A, B2);
        path(B2, C2);
        path(C2, D);
        path(D, A);
      }
      ctx.stroke();
      if (c.name && !empty && kk > 0.45) {
        ctx.globalAlpha = alpha;
        ctx.fillStyle = '#e6e8f0';
        ctx.font = `700 ${Math.round(Math.max(11, 17 * kk))}px system-ui, sans-serif`;
        ctx.fillText(c.name, (A[0] + B2[0]) / 2, (A[1] + B2[1]) / 2 - 10 * kk);
      }
    }
    ctx.globalAlpha = 1;
    const bigName = upcoming || ringing;
    if (bigName) {
      const d = (bigName.ms - now) / 1000;
      const ahead = Math.min(2.2, look);
      ctx.globalAlpha = d > ahead - 0.8 ? Math.max(0, (ahead - d) / 0.8) : 1;
      ctx.textAlign = 'left';
      ctx.fillStyle = '#e6e8f0';
      ctx.font = `800 ${Math.round(Math.min(46, Math.max(26, H * 0.07)))}px system-ui, sans-serif`;
      ctx.fillText(bigName.name, 22, H * 0.2);
      ctx.textAlign = 'center';
      ctx.globalAlpha = 1;
    }

    /** Открытая струна: тонкая линия с мягким свечением. */
    function openBar(a, b, th, color, alpha) {
      ctx.lineCap = 'round';
      ctx.strokeStyle = color;
      ctx.globalAlpha = alpha * 0.18;
      ctx.lineWidth = th * 2.4;
      line(a, b);
      ctx.globalAlpha = alpha * 0.95;
      ctx.lineWidth = th;
      line(a, b);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
      ctx.lineWidth = Math.max(1, th * 0.3);
      line(a, b);
      ctx.lineCap = 'butt';
      ctx.globalAlpha = 1;
    }

    /**
     * Хвост ноты — лента шириной с ноту, лежит на высоте струны. Слайд — лента плавно сворачивает к целевому ладу,
     * вибрато — волной, тремоло — зубцами по краям. Бенд — шевроны на ленте.
     */
    function ribbon(it, d0, d1, endMs, y) {
      const fx0 = it.f - 0.5;
      const fx1 = it.slide ? it.slide.to - 0.5 : fx0;
      const wavy = it.vib || it.trem;
      // точки ленты — на сетке времени песни (каждые 30 мс): волна и зубцы едут вместе с нотой, а не дрожат
      const ds = [d0];
      if (it.slide || wavy) {
        const step = Math.max(30, (endMs - it.ms) / 60); // шаг по длине всей ноты — не меняется, пока она едет
        for (let ms = Math.ceil((now + d0 * 1000) / step) * step; ms < now + d1 * 1000; ms += step) ds.push((ms - now) / 1000);
      }
      ds.push(d1);
      const left = [];
      const right = [];
      for (const d of ds) {
        const ms = now + d * 1000;
        const q = Math.max(0, Math.min(1, (ms - it.ms) / Math.max(1, endMs - it.ms)));
        let cx = fx0 + (fx1 - fx0) * q * q * (3 - 2 * q);
        let hw = 0.24;
        if (it.vib) cx += 0.09 * Math.sin((ms / 170) * Math.PI * 2);
        if (it.trem) hw *= Math.floor(ms / 45) % 2 ? 0.62 : 1;
        left.push(proj(xw(cx - hw), y, d * v));
        right.push(proj(xw(cx + hw), y, d * v));
      }
      const pts = [...left, ...right.reverse()];
      ctx.globalAlpha = 0.3;
      poly(pts);
      ctx.globalAlpha = 0.8;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(left[0][0], left[0][1]);
      for (const p of left) ctx.lineTo(p[0], p[1]);
      ctx.moveTo(right[0][0], right[0][1]);
      for (const p of right) ctx.lineTo(p[0], p[1]);
      ctx.stroke();
      if (it.slide) {
        // стрелка на конце слайда
        const a = left[left.length - 1];
        const b = right[0];
        const tip = proj(xw(fx1 + Math.sign(fx1 - fx0) * 0.35), y, d1 * v);
        ctx.globalAlpha = 0.85;
        poly([a, tip, b]);
      }
      if (it.bend >= 1) {
        // шевроны вдоль ленты бенда
        ctx.globalAlpha = 0.9;
        ctx.strokeStyle = '#ffffff';
        for (let dd = d0 + 0.18; dd < d1 - 0.05; dd += 0.3) {
          const [cx, cy, s] = proj(xw(fx0), y, dd * v);
          chevron(cx, cy, Math.max(4, 0.16 * fw * s), it.bend >= 6 ? 2 : 1, it.bend < 4);
        }
        ctx.strokeStyle = pal[it.s];
      }
      ctx.globalAlpha = 1;
    }
    /**
     * Значки приёмов над нотой: хаммер — треугольник вниз, пулл-офф — вверх, бенд — шевроны (два — полтора тона
     * и больше, контурный — полтона), тэппинг — «T», у короткой ноты вибрато — волна, тремоло — зубцы.
     */
    function glyphs(it, x, yTop, gs, short) {
      const list = [];
      if (it.hp) list.push('hp');
      if (it.bend >= 1) list.push('bend');
      if (it.tap) list.push('tap');
      if (short && it.vib) list.push('vib');
      if (short && it.trem) list.push('trem');
      if (!list.length) return;
      const step = gs * 1.25;
      let gx = x - ((list.length - 1) * step) / 2;
      const gy = yTop - gs * 0.75;
      ctx.lineCap = 'round';
      for (const k of list) {
        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = Math.max(1.5, gs * 0.18);
        if (k === 'hp') {
          const dn = it.hp === 'h';
          ctx.beginPath();
          ctx.moveTo(gx - gs * 0.5, gy + (dn ? -gs * 0.4 : gs * 0.4));
          ctx.lineTo(gx + gs * 0.5, gy + (dn ? -gs * 0.4 : gs * 0.4));
          ctx.lineTo(gx, gy + (dn ? gs * 0.45 : -gs * 0.45));
          ctx.closePath();
          ctx.strokeStyle = 'rgba(6, 7, 12, 0.8)';
          ctx.lineWidth = 2;
          ctx.stroke();
          ctx.fill();
        } else if (k === 'bend') chevron(gx, gy, gs * 0.55, it.bend >= 6 ? 2 : 1, it.bend < 4);
        else if (k === 'tap') {
          ctx.font = `800 ${Math.round(gs * 1.1)}px system-ui, sans-serif`;
          ctx.fillText('T', gx, gy);
        } else {
          ctx.beginPath();
          for (let q = 0; q <= 12; q++) {
            const px = gx - gs * 0.6 + (gs * 1.2 * q) / 12;
            const py = k === 'vib' ? gy + Math.sin((q / 12) * Math.PI * 3) * gs * 0.25 : gy + (q % 2 ? -1 : 1) * gs * 0.25;
            if (q) ctx.lineTo(px, py);
            else ctx.moveTo(px, py);
          }
          ctx.stroke();
        }
        gx += step;
      }
      ctx.lineCap = 'butt';
    }
    /** Шевроны бенда «^» — один или два, контурный — полтона. */
    function chevron(x, y, r, count, hollow) {
      ctx.lineWidth = hollow ? Math.max(1, r * 0.22) : Math.max(1.5, r * 0.42);
      ctx.lineJoin = 'miter';
      for (let c = 0; c < count; c++) {
        const cy = y + (c - (count - 1) / 2) * r * 0.9;
        ctx.beginPath();
        ctx.moveTo(x - r, cy + r * 0.45);
        ctx.lineTo(x, cy - r * 0.45);
        ctx.lineTo(x + r, cy + r * 0.45);
        ctx.stroke();
      }
      ctx.lineJoin = 'round';
    }
    /** Крест: глушёная нота (на открытой струне) и глушение ладонью. */
    function cross(x, y, r, color, squash = 1) {
      ctx.strokeStyle = 'rgba(6, 7, 12, 0.8)';
      ctx.lineWidth = Math.max(3, r * 0.5);
      for (const c of [ctx.strokeStyle, color]) {
        ctx.strokeStyle = c;
        ctx.beginPath();
        ctx.moveTo(x - r, y - r * squash);
        ctx.lineTo(x + r, y + r * squash);
        ctx.moveTo(x + r, y - r * squash);
        ctx.lineTo(x - r, y + r * squash);
        ctx.stroke();
        ctx.lineWidth = Math.max(1.5, r * 0.25);
      }
    }
    /** «!» — в прошлом проходе петли здесь был промах. */
    function badge(x, y, r) {
      ctx.fillStyle = '#ef6a6a';
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.font = `900 ${Math.round(r * 1.5)}px system-ui, sans-serif`;
      ctx.fillText('!', x, y + 1);
    }

    // искры и надписи
    for (let i = sparks.length - 1; i >= 0; i--) {
      const p = sparks[i];
      p.life -= dt;
      if (p.life <= 0) {
        sparks.splice(i, 1);
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 520 * dt;
      ctx.globalAlpha = Math.min(1, p.life / 0.35);
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - 2, p.y - 2, 4, 4);
    }
    for (let i = pops.length - 1; i >= 0; i--) {
      const p = pops[i];
      p.life -= dt;
      if (p.life <= 0) {
        pops.splice(i, 1);
        continue;
      }
      p.y -= 26 * dt;
      ctx.globalAlpha = Math.min(1, p.life / 0.4);
      ctx.fillStyle = p.color;
      ctx.font = `800 ${p.size || 15}px system-ui, sans-serif`;
      ctx.fillText(p.text, p.x, p.y);
    }
    ctx.globalAlpha = 1;

    // часть песни сейчас и следующая, если она близко
    let cur = null;
    let next = null;
    for (const s of tl.sections || []) {
      if (s.ms <= now + 100) cur = s;
      else {
        next = s;
        break;
      }
    }
    if (cur || next) {
      ctx.font = '700 13px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(230, 232, 240, 0.55)';
      const soon = next && next.ms - now < 4000 ? '   →  ' + next.text : '';
      ctx.fillText((cur ? cur.text : '') + soon, W / 2, 22);
    }

    // серия попаданий
    const streak = mode !== 'listen' ? getStats?.()?.streak || 0 : 0;
    if (streak >= 2) {
      ctx.textAlign = 'left';
      ctx.fillStyle = streak >= 10 ? '#3fd39a' : 'rgba(230, 232, 240, 0.75)';
      ctx.font = '800 22px system-ui, sans-serif';
      ctx.fillText('×' + streak, W - 90, 26);
      ctx.font = '600 11px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(230, 232, 240, 0.5)';
      ctx.fillText('in a row', W - 90, 46);
      ctx.textAlign = 'center';
    }
    if (streak >= 10 && streak % 10 === 0 && streak !== streakShown) {
      streakShown = streak;
      pops.push({ x: W / 2, y: H * 0.3, text: `${streak} in a row!`, life: 1.2, color: '#3fd39a', size: 22 });
    }

    /** Многоугольник по точкам [x, y]: залить или обвести. */
    function poly(pts, stroke = false) {
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.closePath();
      if (stroke) ctx.stroke();
      else ctx.fill();
    }
    function path(a, b) {
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
    }
    function line(a, b) {
      ctx.beginPath();
      path(a, b);
      ctx.stroke();
    }
    function diamond(x, y, rx, ry) {
      ctx.beginPath();
      ctx.moveTo(x, y - ry);
      ctx.lineTo(x + rx, y);
      ctx.lineTo(x, y + ry);
      ctx.lineTo(x - rx, y);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
  }

  /** Искры у струны, где сыграна нота (координаты — как у мишени на грифе). */
  function burst(it, kind) {
    if (!W || !H || !geo) return;
    const [x, y] = geo.P(it.f === 0 ? (hand.a + hand.b) / 2 : it.f - 0.5, geo.uOf(it.s), 0);
    if (kind === 'hit') {
      for (let i = 0; i < 12; i++) {
        const a = Math.random() * Math.PI * 2;
        const v = 90 + Math.random() * 190;
        sparks.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 120, life: 0.45 + Math.random() * 0.25, color: pal[it.s] });
      }
    } else pops.push({ x, y: y - geo.gap * 0.7, text: '×', life: 0.6, color: '#ef6a6a', size: 18 });
  }

  function note(text) {
    msg.hidden = !text;
    msg.textContent = text || '';
  }

  return {
    setActive(on) {
      active = on;
      if (on && !raf) {
        lastFrame = 0;
        dirty = true;
        raf = requestAnimationFrame(frame);
      } else if (!on && raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
    },
    /** Новая песня или дорожка. */
    setTimeline(t) {
      tl = t;
      phraseLevels = [];
      markFull(shown); // новая дорожка с середины песни: первый аккорд — целиком
      pal = palette(t.strings);
      shades = pal.map(makeShades);
      deadShades = shades.map((x) => ({ ...x, front: '#2a2c38', top: '#3a3d4c', side: '#1c1e27' }));
      byBeat = new Map();
      for (const it of t.items) {
        if (!byBeat.has(it.beat)) byBeat.set(it.beat, []);
        byBeat.get(it.beat).push(it);
      }
      sparks.length = pops.length = 0;
      streakShown = 0;
      note(!t.tab ? 'This track has no tablature. Pick a guitar or bass track in Tracks.' : !t.items.length ? 'No notes in this track.' : '');
      aimCamera(shown, true);
      dirty = true;
    },
    /** Уровень сложности 1…4 (4 — вся партия), 5 — «Auto»: свой уровень у каждой части (setPhraseLevels). */
    setLevel(l) {
      level = Math.max(1, Math.min(5, l | 0));
      markFull(shown);
      dirty = true;
    },
    /** Уровни частей песни для «Auto»: [1…4] по номеру части (timeline.phrases). */
    setPhraseLevels(list) {
      phraseLevels = list.slice();
      markFull(shown);
      dirty = true;
    },
    /**
     * Сколько долей части i видно на дороге сейчас (без глушёных): столько и ждут «Играть вместе» и «Жди меня».
     * from, to — только внутри петли (тики).
     */
    phraseBeats(i, from = -Infinity, to = Infinity) {
      const ticks = new Set();
      for (const it of tl.items) if (it.sec === i && !it.dead && it.tick >= from && it.tick < to && vis(it)) ticks.add(it.tick);
      return ticks.size;
    },
    /** Надпись над дорогой (итог части, смена уровня). */
    pop(text, color = '#c9ccff') {
      pops.push({ x: W / 2, y: H * 0.3, text, life: 2.2, color, size: 20 });
      dirty = true;
    },
    get level() {
      return level;
    },
    /** Какие ноты доли видны на дороге в этом проходе (tick — где доля игралась). Их и ждёт «Играть вместе». */
    shownNotes(beat, tick) {
      const list = byBeat.get(beat);
      if (!list) return null;
      let best = Infinity;
      for (const it of list) best = Math.min(best, Math.abs(it.tick - tick));
      return new Set(list.filter((it) => Math.abs(it.tick - tick) === best && vis(it)).map((it) => it.note));
    },
    /** Размер поменялся (окно, панели) — перерисовать и на паузе. */
    refresh() {
      dirty = true;
    },
    setMode(m) {
      mode = m;
      this.clearMarks();
    },
    clearMarks() {
      for (const it of tl.items) it.state = it.prevMiss = null;
      sparks.length = pops.length = 0;
      streakShown = 0;
      dirty = true;
    },
    /** Попадание или промах доли; tick — где она игралась (у повторов одна доля в нескольких местах). */
    mark(beat, kind, tick) {
      const list = byBeat.get(beat);
      if (!list) return;
      let best = Infinity;
      for (const it of list) best = Math.min(best, Math.abs(it.tick - tick));
      for (const it of list) {
        if (Math.abs(it.tick - tick) !== best) continue;
        it.state = kind;
        it.prevMiss = false;
        burst(it, kind);
      }
      dirty = true;
    },
    setWait(beat, tick) {
      const fresh = !wait && beat; // «Жди меня» только что началось
      wait = beat ? { beat, tick } : null;
      if (fresh) {
        const it = byBeat.get(beat)?.find((x) => x.tick === tick);
        fullChord = it?.chord?.repeat ? it.chord : null;
      }
      dirty = true;
    },
    /** Для проверок: на сколько секунд нота этого прохода не долетела до струн (минус — уже пролетела). */
    dtOf(beat, tick) {
      const list = byBeat.get(beat) || [];
      let it = null;
      for (const x of list) if (!it || Math.abs(x.tick - tick) < Math.abs(it.tick - tick)) it = x;
      return it ? (it.ms - shown) / 1000 : null;
    },
    get state() {
      return { shown, cam: { x: cam.x, w: cam.w, tx: cam.tx, tw: cam.tw, moving: cam.moving }, hand: { ...hand }, clock: getClock(), dirty, items: tl.items.length, strings: tl.strings, tab: tl.tab, hit: tl.items.filter((x) => x.state === 'hit').length, miss: tl.items.filter((x) => x.state === 'miss').length, sparks: sparks.length, active, running: !!raf, fullChordMs: fullChord?.ms ?? null, level, phraseLevels: phraseLevels.slice(), prevMiss: tl.items.filter((x) => x.prevMiss).length, visible: tl.items.filter(vis).length, frames: perf.frames, drawMs: perf.frames ? perf.ms / perf.frames : 0 };
    },
    get timeline() {
      return tl;
    },
  };
}
