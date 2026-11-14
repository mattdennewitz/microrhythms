/* LOOP stores a frozen score, not a grain for every future crossing. Each
 * cursor merges small, ordered scheduling windows over that score. */
import { stack, type Plate } from './stack';
import { sounds } from './sounds';
import { view } from './view';
import { clamp, mulberry32 } from './util';
import type { ExportFlightCtx } from './flight';
import type { Chip, MotionSeg, Pose, Sound } from './types';

export interface LoopClockSeg { t0: number; b0: number; bps: number }
export interface LoopGrain {
  plate: Plate;
  key: number;
  time: number;
  buffer: AudioBuffer;
  snd: number;
  rate: number;
  srcDur: number;
  dur: number;
  offset: number;
  sourceOffset: number;
  amp: number;
  fadeIn: number;
  fadeOut: number;
  choke: boolean;
  reverse: boolean;
  throw: boolean;
  sensor: boolean;
  dist: number | null;
  head: number;
  x: number;
  y: number;
  z: number;
  panModel: PanningModelType;
}
export interface LoopPose { time: number; pose: Pose; tones: number[] }
export interface LoopWarmup { maxDuration: number; hasThrow: boolean }
/** Counts describe retained musical state, independently of future crossings. */
export interface LoopMetadata {
  plates: number;
  chips: number;
  templates: number;
  series: number;
  poses: number;
}
export interface LoopCursor { next(): LoopGrain | null }
export interface LoopPlan extends LoopWarmup {
  seconds: number;
  poses: readonly LoopPose[];
  metadata: Readonly<LoopMetadata>;
  metadataFor(onlyPlate?: Plate | null): LoopWarmup;
  /** A fresh ordered cursor, seeking directly to the requested local time. */
  createCursor(onlyPlate?: Plate | null, startTime?: number): LoopCursor;
}
export interface LoopCaptureOptions {
  seconds?: number;
  beats?: number | null;
  bpm: number;
  seed: number;
  startBeat?: number;
  motions?: Map<Plate, MotionSeg[]> | null;
  flight?: ExportFlightCtx | null;
  listenerPose?: Pose | null;
  clock?: LoopClockSeg[] | null;
  panModel: PanningModelType;
  fxOn: boolean;
}
/** The engine supplies its existing crossing solver, with these frozen inputs. */
export interface LoopScoreSnapshot {
  plates: Plate[];
  motions: Map<Plate, MotionSeg[]>;
  clock: LoopClockSeg[];
  flight: ExportFlightCtx | null;
  panModel: PanningModelType;
  fxOn: boolean;
  bpm: number;
  seed: number;
  restAt(p: Plate, B: number): boolean;
  plateX(p: Plate): number;
  soundPool(p: Plate): Sound[];
}
export type LoopFire = (p: Plate, c: Chip, t: number, headAngle: number, B: number,
  gainMul?: number, extra?: { sensor: boolean; dist: number } | null) => void;
export interface LoopScheduler {
  beatAt(t: number): number;
  timeAtBeat(B: number): number;
  scheduleBeats(Ba: number, Bb: number): void;
}
export type LoopSchedulerFactory = (score: LoopScoreSnapshot, onFire: LoopFire) => LoopScheduler;

interface Template {
  grain: LoopGrain;
  probability: number;
  subgrain: number;
  gainMul: number;
  chipOrder: number;
}
interface PlateScore {
  original: Plate;
  frozen: Plate;
  order: number;
  x: number;
  pool: Sound[];
  motion: MotionSeg[];
  warmup: LoopWarmup;
}
interface Series {
  score: LoopScoreSnapshot;
  plate: PlateScore;
  templates: Map<Chip, Template>;
  delay: number;
  from: number;
  to: number;
  half?: 'start' | 'end';
}
interface OrderedGrain { grain: LoopGrain; order: number[] }
interface SeriesCursor { next(): OrderedGrain | null }

const copyPose = (p: Pose): Pose => ({ pos: p.pos.slice(), fwd: p.fwd.slice(), up: p.up.slice() });
const wrap = (t: number, period: number): number => ((t % period) + period) % period;
const compare = (a: OrderedGrain, b: OrderedGrain): number => {
  const time = a.grain.time - b.grain.time;
  if (time) return time;
  for (let i = 0; i < a.order.length; i++) {
    const d = a.order[i] - b.order[i];
    if (d) return d;
  }
  return 0;
};

/** Capture happens synchronously. Buffers are retained by identity; no later
 * source-pool, plate, project, FX or geometry lookup participates in a cursor. */
export function captureLoopScore(options: LoopCaptureOptions, makeScheduler: LoopSchedulerFactory): LoopPlan {
  const { bpm, panModel, fxOn } = options;
  const seed = options.seed >>> 0, startBeat = options.startBeat ?? 0;
  const clock = (options.clock || [{ t0: 0, b0: startBeat, bps: bpm / 60 }]).map((s) => ({ ...s }));
  const flight = options.flight ? Object.freeze({ ...options.flight }) : null;
  const plateXs = stack.plates.map((p) => flight ? flight.plateX(p) : view.plateX(p));
  const restSettings = { breaks: stack.breaks, phraseBars: stack.phraseBars };
  const rest = stack.restAt;
  const restAt = (p: Plate, B: number) => rest.call(restSettings, p, B);
  const anySolo = stack.anySolo();
  const plateScores: PlateScore[] = [];
  const sourceCopies = new Map<Sound, Sound>();
  let chipCount = 0, templateCount = 0;
  for (let order = 0; order < stack.plates.length; order++) {
    const original = stack.plates[order];
    if (!original.audible(anySolo)) continue;
    const frozen: Plate = Object.assign(Object.create(Object.getPrototypeOf(original)), original, {
      chips: original.chips.map((c) => Object.freeze({ ...c })),
      dust: [], sourceIds: new Set(original.sourceIds),
      overrides: new Map(original.overrides), fxOverrides: new Map(original.fxOverrides),
      style: { ...original.style }, sources: original.sources.slice(),
    });
    const motion = (options.motions?.get(original) || [{ b0: 0, phi0: original.phase0, w: original.omega() }]).map((m) => ({ ...m }));
    frozen.motion = motion;
    const pool = sounds.poolFor(original).map((s) => {
      let copy = sourceCopies.get(s);
      if (!copy) {
        copy = { ...s, onsets: s.onsets.slice() };
        sourceCopies.set(s, copy);
      }
      return copy;
    });
    chipCount += frozen.chips.length;
    plateScores.push({ original, frozen, motion, pool, order, x: plateXs[order], warmup: { maxDuration: 0, hasThrow: false } });
  }
  const snapshot = (p: PlateScore, chips: Chip[]): LoopScoreSnapshot => {
    const plate: Plate = Object.assign(Object.create(Object.getPrototypeOf(p.frozen)), p.frozen, { chips });
    return { plates: [plate], motions: new Map([[plate, p.motion]]), clock, flight, panModel, fxOn, bpm, seed,
      restAt, plateX: () => p.x, soundPool: () => p.pool };
  };
  // The clock helper also works for an entirely silent score.
  const clockScore: LoopScoreSnapshot = { plates: [], motions: new Map(), clock, flight, panModel, fxOn, bpm, seed,
    restAt, plateX: () => 0, soundPool: () => [] };
  const timing = makeScheduler(clockScore, () => {});
  const endBeat = options.beats == null ? timing.beatAt(options.seconds!) : startBeat + options.beats;
  const seconds = timing.timeAtBeat(endBeat);
  const chunk = 0.1 * bpm / 60;
  const series: Series[] = [];
  for (const p of plateScores) {
    if (!p.pool.length) continue;
    const chipOrders = new Map(p.frozen.chips.map((c, i) => [c, i]));
    for (let ci = 0; ci < clock.length; ci++) {
      const from = Math.max(0, clock[ci].t0), to = Math.min(seconds, ci + 1 < clock.length ? clock[ci + 1].t0 : seconds);
      if (to <= from) continue;
      const groups = new Map<number, Map<Chip, Template>>();
      for (const c of p.frozen.chips) {
        const snd = p.pool[c.srcPick % p.pool.length];
        const fx = fxOn ? c.fx : null;
        const subdivided = fx === 'ratchet' || fx === 'stutter';
        const n = subdivided ? c.fxN : 1;
        const sub = subdivided ? p.frozen.stepBeats / clock[ci].bps / n : 0;
        const stepSemis = [3, 5, -2, -5][(c.srcPick >> 3) % 4];
        for (let k = 0; k < n; k++) {
          const delay = k * sub;
          let group = groups.get(delay);
          if (!group) { group = new Map(); groups.set(delay, group); }
          const g = p.frozen.fragmentFor(c, snd);
          g.rate *= fx === 'stutter' ? Math.pow(2, k * stepSemis / 12) : 1;
          if (subdivided && sub * 0.92) g.dur = Math.min(g.dur, sub * 0.92);
          g.srcDur = Math.max(0.002, Math.min(g.dur * g.rate, snd.buffer.duration));
          g.offset = Math.min(g.offset, Math.max(0, snd.buffer.duration - g.srcDur));
          const reverse = fx === 'reverse', buffer = reverse ? sounds.reversed(snd) : snd.buffer;
          const grain: LoopGrain = { plate: p.original, key: c.key, time: 0, buffer, snd: snd.id,
            rate: g.rate, srcDur: g.srcDur, dur: g.srcDur / g.rate, offset: g.offset,
            sourceOffset: reverse ? Math.max(0, snd.buffer.duration - g.offset - g.srcDur) : g.offset,
            amp: p.frozen.gainFor(c) * 1.1,
            fadeIn: p.frozen.fadeIn, fadeOut: p.frozen.fadeOut, choke: p.frozen.choke,
            reverse, throw: fx === 'throw', sensor: false, dist: null, head: 0,
            x: p.x, y: 0, z: 0, panModel };
          group.set(c, { grain: Object.freeze(grain), probability: p.frozen.probFor(c), subgrain: k,
            chipOrder: chipOrders.get(c)!, gainMul: subdivided ? 1 - k * 0.12 : 1 });
          templateCount++;
          p.warmup.maxDuration = Math.max(p.warmup.maxDuration, grain.dur);
          p.warmup.hasThrow ||= grain.throw;
        }
      }
      for (const [delay, templates] of groups) {
        const score = snapshot(p, Array.from(templates.keys()));
        // Circularly shift the input traversal, not retained future grains.
        // Offsets spanning many periods still need only two ordinary ranges.
        // A tiny seam band is split by the actual modulo result: floating
        // addition may round an endpoint to either side of the period.
        const pivot = (Math.floor(delay / seconds) + 1) * seconds - delay;
        const epsilon = Number.EPSILON * Math.max(1, seconds, delay) * 8;
        const before = Math.max(0, pivot - epsilon), after = Math.min(seconds, pivot + epsilon);
        const earlyFrom = Math.max(from, after);
        if (earlyFrom < to) series.push({ score, plate: p, templates, delay, from: earlyFrom, to });
        const lateTo = Math.min(to, before);
        if (from < lateTo) series.push({ score, plate: p, templates, delay, from, to: lateTo });
        const seamFrom = Math.max(from, before), seamTo = Math.min(to, after);
        if (seamFrom < seamTo) {
          series.push({ score, plate: p, templates, delay, from: seamFrom, to: seamTo, half: 'start' });
          series.push({ score, plate: p, templates, delay, from: seamFrom, to: seamTo, half: 'end' });
        }
      }
    }
  }
  const activeFlight = (t: number): ExportFlightCtx | null =>
    flight && (!flight.activeAt || flight.activeAt(t)) ? flight : null;
  const poses: LoopPose[] = [];
  const fallback = copyPose(options.listenerPose || view.homePose());
  const addPose = (time: number) => {
    const pose = copyPose(flight ? flight.poseAt(time) : fallback);
    const listenerActiveAt = flight?.listenerActiveAt ?? flight?.activeAt;
    const fc = flight && (!listenerActiveAt || listenerActiveAt(time)) ? flight : null;
    // Tones retain bus order, including currently inaudible plates.
    const tones = plateXs.map((x) => {
      return fc ? clamp(18000 * Math.exp(-Math.abs(x - pose.pos[0]) * 1.1 / Math.max(0.2, fc.falloff)), 500, 18000)
        : clamp(18000 * Math.exp(-(Math.hypot(x - pose.pos[0], pose.pos[1], pose.pos[2]) - 4.5) * 0.32), 700, 18000);
    });
    Object.freeze(pose.pos); Object.freeze(pose.fwd); Object.freeze(pose.up);
    poses.push(Object.freeze({ time, pose: Object.freeze(pose), tones: Object.freeze(tones) as unknown as number[] }));
  };
  addPose(0);
  if (flight?.moving) {
    for (let t = 0.05; t < seconds; t += 0.05) addPose(t);
    const last = Math.max(0, seconds - 1 / 192000);
    if (last > poses[poses.length - 1].time) addPose(last);
  }
  const metadataFor = (onlyPlate: Plate | null = null): LoopWarmup => {
    let maxDuration = 0, hasThrow = false;
    for (const p of plateScores) {
      if (onlyPlate && p.original !== onlyPlate) continue;
      maxDuration = Math.max(maxDuration, p.warmup.maxDuration);
      hasThrow ||= p.warmup.hasThrow;
    }
    return { maxDuration, hasThrow };
  };
  const createSeriesCursor = (s: Series, startTime: number): SeriesCursor => {
    const cycle = Math.floor((s.from + s.delay) / seconds);
    const from = Math.max(s.from, startTime + cycle * seconds - s.delay);
    // Include the neighbouring grid cell at a rounded seek boundary; the
    // output-time predicate below is authoritative, not inverse float math.
    let windowIndex = Math.max(0, Math.floor((timing.beatAt(from) - startBeat) / chunk) - 1);
    let batch: OrderedGrain[] = [], index = 0, done = false;
    const heads = s.plate.frozen.headAngles();
    const runner = makeScheduler(s.score, (_p, c, t, head, B, gainMul = 1, extra = null) => {
      if (t < s.from || t >= s.to) return;
      const template = s.templates.get(c)!;
      const sensor = !!extra?.sensor, fc = activeFlight(t);
      if ((!sensor || fc?.useChance) && mulberry32((seed ^ s.plate.frozen.seed ^ Math.imul(c.key + 1, 0x27d4eb2d)
        ^ Math.imul(Math.round(B * 1000) + 7, 0x165667b1)) >>> 0)() > template.probability) return;
      if (!sensor && fc) {
        const ship = fc.shipAt(t);
        const d = Math.hypot(ship[0] - s.plate.x, ship[1] - c.radius * Math.sin(head), ship[2] + c.radius * Math.cos(head));
        gainMul *= 1 / (1 + (d / fc.falloff) ** 2);
        if (gainMul < 0.004) return;
      }
      const grain: LoopGrain = { ...template.grain, time: wrap(t + s.delay, seconds), amp: template.grain.amp * (gainMul * template.gainMul),
        sensor, dist: extra?.dist ?? null, head, y: c.radius * Math.sin(head), z: -c.radius * Math.cos(head) };
      if (grain.time < startTime || (s.half === 'start' && grain.time >= seconds / 2)
        || (s.half === 'end' && grain.time < seconds / 2)) return;
      batch.push({ grain, order: [windowIndex, sensor ? 1 : 0, s.plate.order, B,
        sensor ? 0 : heads.indexOf(head), template.chipOrder, template.subgrain] });
    });
    return { next(): OrderedGrain | null {
      while (index === batch.length) {
        if (done) return null;
        batch = []; index = 0;
        const Ba = startBeat + windowIndex * chunk;
        if (Ba >= endBeat || timing.timeAtBeat(Ba) >= s.to) { done = true; return null; }
        runner.scheduleBeats(Ba, Math.min(endBeat, startBeat + (windowIndex + 1) * chunk));
        batch.sort(compare);
        windowIndex++;
      }
      return batch[index++];
    } };
  };
  const createCursor = (onlyPlate: Plate | null = null, startTime = 0): LoopCursor => {
    const heap: Array<{ cursor: SeriesCursor; value: OrderedGrain }> = [];
    const push = (entry: { cursor: SeriesCursor; value: OrderedGrain }) => {
      let i = heap.length;
      heap.push(entry);
      while (i > 0) {
        const parent = (i - 1) >>> 1;
        if (compare(heap[parent].value, entry.value) <= 0) break;
        heap[i] = heap[parent]; i = parent;
      }
      heap[i] = entry;
    };
    for (const s of series) {
      if (onlyPlate && s.plate.original !== onlyPlate) continue;
      const cursor = createSeriesCursor(s, startTime), value = cursor.next();
      if (value) push({ cursor, value });
    }
    return { next(): LoopGrain | null {
      if (!heap.length) return null;
      const first = heap[0], last = heap.pop()!;
      if (heap.length) {
        let i = 0;
        while (2 * i + 1 < heap.length) {
          let child = 2 * i + 1;
          if (child + 1 < heap.length && compare(heap[child + 1].value, heap[child].value) < 0) child++;
          if (compare(last.value, heap[child].value) <= 0) break;
          heap[i] = heap[child]; i = child;
        }
        heap[i] = last;
      }
      const next = first.cursor.next();
      if (next) push({ cursor: first.cursor, value: next });
      return first.value.grain;
    } };
  };
  return Object.freeze({ seconds, poses: Object.freeze(poses), ...metadataFor(), metadataFor, createCursor,
    metadata: Object.freeze({ plates: plateScores.length, chips: chipCount, templates: templateCount, series: series.length, poses: poses.length }) });
}
