/* Runtime boundary for both JSON files and shared URLs. Version 1 is the
 * complete shape written by project.serialize(), not a partial state patch. */
import type { ProjectFile } from './project';
import { stack } from './stack';
import {
  BUILTIN_NAMES, MAX_USER_SOUNDS, MAX_USER_SAMPLES, MAX_SOUND_SECONDS, MAX_SOUND_ID,
  MAX_SOURCE_IDS, MIN_SAMPLE_RATE, MAX_SAMPLE_RATE, validSoundName,
} from './project-limits';

export const PROJECT_FORMAT = 'orbital-stack';
export const PROJECT_VERSION = 1;
// Version 1 stores parameter snapshots of the seven fixed native plates.
const PLATES = 7;
const SLOTS = 4;
const FX = ['ratchet', 'stutter', 'reverse', 'throw'];
const UINT32_MAX = 0xffffffff;
const MAX_CELLS = 960;
const ROOT_KEYS = ['format', 'version', 'global', 'view', 'plates', 'holds', 'keep', 'sounds', 'flight', 'exporter'];
const GLOBAL_KEYS = ['bpm', 'masterLevel', 'spaceLevel', 'panModel', 'earMode', 'evolveAmount', 'fxOn', 'fxWet', 'rollSeed', 'fxTypes', 'phraseBars', 'breaks', 'style', 'selected'];
const VIEW_KEYS = ['sepTarget', 'mode', 'autoOrbit', 'dragYaw', 'dragPitch', 'zoom'];
const SNAPSHOT_KEYS = ['steps', 'tracks', 'density', 'scatter', 'onBeat', 'cycle', 'dir', 'drift', 'micro', 'swing',
  'grainMs', 'spread', 'transpose', 'heads', 'level', 'chance', 'rest', 'fxDensity', 'cut', 'slices',
  'fadeIn', 'fadeOut', 'choke', 'mute', 'solo', 'seed', 'overrides', 'fxOverrides', 'sourceIds'];

function invalid(path: string): never { throw new Error(`invalid project: ${path}`); }
function record(value: unknown, path: string, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object') invalid(path);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) invalid(path);
  const keys = Reflect.ownKeys(value);
  if (keys.length > required.length + optional.length) invalid(path);
  for (const key of keys) {
    if (typeof key !== 'string' || (!required.includes(key) && !optional.includes(key))) invalid(path);
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) invalid(`${path}.${key}`);
  }
  for (const key of required) if (!Object.hasOwn(value, key)) invalid(`${path}.${key}`);
  return value as Record<string, unknown>;
}
function array(value: unknown, path: string, length?: number, max = length ?? MAX_SOURCE_IDS): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || value.length > max || (length !== undefined && value.length !== length)) invalid(path);
  if (Reflect.ownKeys(value).length !== value.length + 1) invalid(path);
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, i);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) invalid(path);
  }
  return value;
}
function number(value: unknown, path: string, min = -Infinity, max = Infinity): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) invalid(path);
  return value;
}
function integer(value: unknown, path: string, min: number, max: number): number {
  const n = number(value, path, min, max);
  if (!Number.isSafeInteger(n)) invalid(path);
  return n;
}
function boolean(value: unknown, path: string): void { if (typeof value !== 'boolean') invalid(path); }
function string(value: unknown, path: string): string {
  if (typeof value !== 'string') invalid(path);
  return value;
}
function choice(value: unknown, path: string, choices: readonly unknown[]): void {
  if (!choices.includes(value)) invalid(path);
}
function ids(value: unknown, path: string, known?: Set<number>): void {
  const seen = new Set<number>();
  for (const valueId of array(value, path)) {
    const id = integer(valueId, path, 1, MAX_SOUND_ID);
    if (seen.has(id) || (known && !known.has(id))) invalid(path);
    seen.add(id);
  }
}
function cells(value: unknown, path: string, fx: boolean, count: number): void {
  // File migration accepts old inert cells; strict URL validation uses current dimensions.
  const entries = array(value, path, undefined, count);
  const seen = new Set<number>();
  for (const entry of entries) {
    const pair = array(entry, path, 2);
    const key = integer(pair[0], path, 0, count - 1);
    if (seen.has(key)) invalid(path);
    seen.add(key);
    if (fx) { if (pair[1] !== null) choice(pair[1], path, FX); }
    else boolean(pair[1], path);
  }
}
function snapshot(value: unknown, path: string, strictCells: boolean, knownIds?: Set<number>): void {
  for (const [index, entry] of array(value, path, PLATES).entries()) {
    const p = record(entry, `${path}[${index}]`, SNAPSHOT_KEYS);
    const at = (key: string) => `${path}[${index}].${key}`;
    const steps = integer(p.steps, at('steps'), 1, Math.max(...stack.STEP_CHOICES));
    const tracks = integer(p.tracks, at('tracks'), 1, 10);
    // RAW can generate 96 steps at two pulses/beat: 48 beats, above the slider's 32.
    number(p.cycle, at('cycle'), 0.25, 48);
    choice(p.dir, at('dir'), [-1, 1]);
    for (const key of ['density', 'scatter', 'onBeat', 'micro', 'chance', 'rest', 'fxDensity']) number(p[key], at(key), 0, 1);
    number(p.drift, at('drift'), -0.03, 0.03);
    number(p.swing, at('swing'), 0, 0.5);
    number(p.grainMs, at('grainMs'), 5, 600);
    number(p.spread, at('spread'), 0, 24);
    number(p.transpose, at('transpose'), -24, 24);
    integer(p.heads, at('heads'), 1, 4);
    number(p.level, at('level'), 0, 1.2);
    choice(p.cut, at('cut'), ['overlap', 'divide', 'transient', 'random']);
    integer(p.slices, at('slices'), 2, 64);
    number(p.fadeIn, at('fadeIn'), 0, 0.5);
    number(p.fadeOut, at('fadeOut'), 0, 0.9);
    for (const key of ['choke', 'mute', 'solo']) boolean(p[key], at(key));
    integer(p.seed, at('seed'), 0, UINT32_MAX);
    const count = strictCells ? steps * tracks : MAX_CELLS;
    cells(p.overrides, at('overrides'), false, count);
    cells(p.fxOverrides, at('fxOverrides'), true, count);
    ids(p.sourceIds, at('sourceIds'), knownIds);
  }
}
function vector(value: unknown, path: string): number[] {
  return array(value, path, 3).map((v) => number(v, path));
}

function pcmFrames(value: unknown, sampleRate: number, remaining: number): number {
  const path = 'sounds.user.pcm16';
  const pcm = string(value, path);
  const maxFrames = Math.min(remaining, sampleRate * MAX_SOUND_SECONDS);
  // Bound encoded size and decoded frames before scanning or allocating anything.
  if (!pcm.length || pcm.length % 4 || pcm.length > Math.ceil(maxFrames * 2 / 3) * 4) invalid(path);
  const padding = pcm.endsWith('==') ? 2 : pcm.endsWith('=') ? 1 : 0;
  const end = pcm.length - padding;
  const bytes = pcm.length / 4 * 3 - padding;
  if (bytes < 2 || bytes % 2 || bytes / 2 > maxFrames) invalid(path);
  let last = 0;
  for (let i = 0; i < end; i++) {
    const code = pcm.charCodeAt(i);
    if (code >= 65 && code <= 90) last = code - 65;
    else if (code >= 97 && code <= 122) last = code - 71;
    else if (code >= 48 && code <= 57) last = code + 4;
    else if (code === 43) last = 62;
    else if (code === 47) last = 63;
    else invalid(path);
  }
  // RFC 4648 requires unused bits in the final sextet to be zero.
  if ((padding === 2 && (last & 15)) || (padding === 1 && (last & 3))) invalid(path);
  return bytes / 2;
}

/** Reject an unsupported or malformed project before any live state changes. */
export function validateProject(value: unknown, strictCells = false): asserts value is ProjectFile {
  const obj = record(value, 'root', ROOT_KEYS);
  if (obj.format !== PROJECT_FORMAT) throw new Error('not an Orbital Stack project');
  if (!Number.isInteger(obj.version)) throw new Error('project version is required and must be an integer');
  if (obj.version !== PROJECT_VERSION) throw new Error(`unsupported project version (${String(obj.version)})`);

  const g = record(obj.global, 'global', GLOBAL_KEYS);
  number(g.bpm, 'global.bpm', 30, 240); // Engine's supported tempo range, including values outside the slider.
  number(g.masterLevel, 'global.masterLevel', 0, 1.5);
  number(g.spaceLevel, 'global.spaceLevel', 0, 1);
  choice(g.panModel, 'global.panModel', ['HRTF', 'equalpower']);
  choice(g.earMode, 'global.earMode', ['camera', 'fixed']);
  number(g.evolveAmount, 'global.evolveAmount', 0, 1);
  boolean(g.fxOn, 'global.fxOn');
  number(g.fxWet, 'global.fxWet', 0, 1);
  integer(g.rollSeed, 'global.rollSeed', 0, UINT32_MAX);
  const fxTypes = array(g.fxTypes, 'global.fxTypes', undefined, FX.length);
  for (const fx of fxTypes) choice(fx, 'global.fxTypes', FX);
  if (new Set(fxTypes).size !== fxTypes.length) invalid('global.fxTypes');
  choice(g.phraseBars, 'global.phraseBars', [4, 8, 16, 32]);
  number(g.breaks, 'global.breaks', 0, 1);
  choice(g.style, 'global.style', stack.STYLE_NAMES);
  integer(g.selected, 'global.selected', 0, PLATES - 1);

  const v = record(obj.view, 'view', VIEW_KEYS);
  number(v.sepTarget, 'view.sepTarget', 0.3, 2.4);
  choice(v.mode, 'view.mode', ['ORBIT', 'SPLIT']);
  boolean(v.autoOrbit, 'view.autoOrbit');
  number(v.dragYaw, 'view.dragYaw');
  number(v.dragPitch, 'view.dragPitch'); // Drag offsets accumulate; only the derived camera pitch is clamped.
  number(v.zoom, 'view.zoom', 0.45, 2.2);

  const sounds = record(obj.sounds, 'sounds', ['builtins', 'user'], ['builtinIds']);
  const builtins = record(sounds.builtins, 'sounds.builtins', [], BUILTIN_NAMES);
  for (const [name, enabled] of Object.entries(builtins)) boolean(enabled, `sounds.builtins.${name}`);
  const knownIds = new Set<number>();
  if (Object.hasOwn(sounds, 'builtinIds')) {
    const names = new Set<string>();
    for (const entry of array(sounds.builtinIds, 'sounds.builtinIds', undefined, BUILTIN_NAMES.length)) {
      const pair = array(entry, 'sounds.builtinIds', 2);
      const id = integer(pair[0], 'sounds.builtinIds.id', 1, MAX_SOUND_ID);
      const name = string(pair[1], 'sounds.builtinIds.name');
      if (!Object.hasOwn(builtins, name) || knownIds.has(id) || names.has(name)) invalid('sounds.builtinIds');
      knownIds.add(id);
      names.add(name);
    }
    if (names.size !== Object.keys(builtins).length) invalid('sounds.builtinIds');
  } else {
    // Original v1 exports predate name/id metadata; builtin ids followed insertion order.
    Object.keys(builtins).forEach((_, i) => knownIds.add(i + 1));
  }
  const names = new Set<string>(BUILTIN_NAMES);
  let frames = 0;
  for (const entry of array(sounds.user, 'sounds.user', undefined, MAX_USER_SOUNDS)) {
    const u = record(entry, 'sounds.user[]', ['id', 'name', 'enabled', 'sampleRate', 'pcm16']);
    const id = integer(u.id, 'sounds.user.id', 1, MAX_SOUND_ID);
    if (!validSoundName(u.name)) invalid('sounds.user.name');
    const name = u.name;
    if (knownIds.has(id) || names.has(name)) invalid('sounds.user');
    knownIds.add(id);
    names.add(name);
    boolean(u.enabled, 'sounds.user.enabled');
    // AudioBuffer construction is staged before application if a browser is stricter.
    const sr = number(u.sampleRate, 'sounds.user.sampleRate', MIN_SAMPLE_RATE, MAX_SAMPLE_RATE);
    frames += pcmFrames(u.pcm16, sr, MAX_USER_SAMPLES - frames);
  }

  snapshot(obj.plates, 'plates', strictCells, knownIds);
  array(obj.holds, 'holds', PLATES).forEach((h) => boolean(h, 'holds'));
  const keep = record(obj.keep, 'keep', ['slots', 'active']);
  const slots = array(keep.slots, 'keep.slots', SLOTS);
  // Removing a sample clears live plate references, but native keep slots can
  // still contain its old id. Application deliberately drops those stale ids.
  slots.forEach((slot, i) => { if (slot !== null) snapshot(slot, `keep.slots[${i}]`, strictCells); });
  if (keep.active !== null) {
    const active = integer(keep.active, 'keep.active', 0, SLOTS - 1);
    if (slots[active] === null) invalid('keep.active');
  }

  const f = record(obj.flight, 'flight', ['on', 'R', 'sensorGain', 'headMix', 'falloff', 'thrust', 'useChance', 'state']);
  boolean(f.on, 'flight.on');
  number(f.R, 'flight.R', 0.06, 0.8);
  number(f.sensorGain, 'flight.sensorGain', 0, 1.5);
  number(f.headMix, 'flight.headMix', 0, 1);
  number(f.falloff, 'flight.falloff', 0.15, 3);
  number(f.thrust, 'flight.thrust', 0.25, 3);
  boolean(f.useChance, 'flight.useChance');
  if (f.state !== null) {
    const state = record(f.state, 'flight.state', ['pos', 'autopilot', 'tau', 'yaw', 'pitch', 'lookYaw', 'lookPitch', 'fwd']);
    vector(state.pos, 'flight.state.pos'); // Manual flight has no artificial world boundary.
    boolean(state.autopilot, 'flight.state.autopilot');
    number(state.tau, 'flight.state.tau');
    number(state.yaw, 'flight.state.yaw');
    number(state.pitch, 'flight.state.pitch', -Math.PI / 2, Math.PI / 2);
    number(state.lookYaw, 'flight.state.lookYaw');
    number(state.lookPitch, 'flight.state.lookPitch', -1.3, 1.3);
    const forward = vector(state.fwd, 'flight.state.fwd');
    if (Math.abs(Math.hypot(...forward) - 1) > 1e-6) invalid('flight.state.fwd');
  }
  const x = record(obj.exporter, 'exporter', ['phrases', 'mode']);
  choice(x.phrases, 'exporter.phrases', [1, 2, 4]);
  choice(x.mode, 'exporter.mode', ['tail', 'loop']);
}
