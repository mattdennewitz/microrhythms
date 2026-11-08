/* Runtime boundary for both JSON files and shared URLs. Version 1 is the
 * complete shape written by project.serialize(), not a partial state patch. */
import type { ProjectFile } from './project';
import { stack } from './stack';

export const PROJECT_FORMAT = 'orbital-stack';
export const PROJECT_VERSION = 1;
// Version 1 stores parameter snapshots of the seven fixed native plates.
const PLATES = 7;
const SLOTS = 4;
const FX = ['ratchet', 'stutter', 'reverse', 'throw'];
const UINT32_MAX = 0xffffffff;

function invalid(path: string): never { throw new Error(`invalid project: ${path}`); }
function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(path);
  return value as Record<string, unknown>;
}
function array(value: unknown, path: string, length?: number): unknown[] {
  if (!Array.isArray(value) || (length !== undefined && value.length !== length)) invalid(path);
  for (let i = 0; i < value.length; i++) if (!Object.hasOwn(value, i)) invalid(path);
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
    const id = integer(valueId, path, 1, Number.MAX_SAFE_INTEGER);
    if (seen.has(id) || (known && !known.has(id))) invalid(path);
    seen.add(id);
  }
}
function cells(value: unknown, path: string, count: number, fx: boolean): void {
  const entries = array(value, path);
  if (entries.length > count) invalid(path);
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
function snapshot(value: unknown, path: string, knownIds?: Set<number>): void {
  for (const [index, entry] of array(value, path, PLATES).entries()) {
    const p = record(entry, `${path}[${index}]`);
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
    cells(p.overrides, at('overrides'), steps * tracks, false);
    cells(p.fxOverrides, at('fxOverrides'), steps * tracks, true);
    ids(p.sourceIds, at('sourceIds'), knownIds);
  }
}
function vector(value: unknown, path: string): number[] {
  return array(value, path, 3).map((v) => number(v, path));
}

/** Reject an unsupported or malformed project before any live state changes. */
export function validateProject(value: unknown): asserts value is ProjectFile {
  const obj = record(value, 'root');
  if (obj.format !== PROJECT_FORMAT) throw new Error('not an Orbital Stack project');
  if (!Number.isInteger(obj.version)) throw new Error('project version is required and must be an integer');
  if (obj.version !== PROJECT_VERSION) throw new Error(`unsupported project version (${String(obj.version)})`);

  const g = record(obj.global, 'global');
  number(g.bpm, 'global.bpm', 30, 240); // Engine's supported tempo range, including values outside the slider.
  number(g.masterLevel, 'global.masterLevel', 0, 1.5);
  number(g.spaceLevel, 'global.spaceLevel', 0, 1);
  choice(g.panModel, 'global.panModel', ['HRTF', 'equalpower']);
  choice(g.earMode, 'global.earMode', ['camera', 'fixed']);
  number(g.evolveAmount, 'global.evolveAmount', 0, 1);
  boolean(g.fxOn, 'global.fxOn');
  number(g.fxWet, 'global.fxWet', 0, 1);
  integer(g.rollSeed, 'global.rollSeed', 0, UINT32_MAX);
  const fxTypes = array(g.fxTypes, 'global.fxTypes');
  for (const fx of fxTypes) choice(fx, 'global.fxTypes', FX);
  if (new Set(fxTypes).size !== fxTypes.length) invalid('global.fxTypes');
  choice(g.phraseBars, 'global.phraseBars', [4, 8, 16, 32]);
  number(g.breaks, 'global.breaks', 0, 1);
  choice(g.style, 'global.style', stack.STYLE_NAMES);
  integer(g.selected, 'global.selected', 0, PLATES - 1);

  const v = record(obj.view, 'view');
  number(v.sepTarget, 'view.sepTarget', 0.3, 2.4);
  choice(v.mode, 'view.mode', ['ORBIT', 'SPLIT']);
  boolean(v.autoOrbit, 'view.autoOrbit');
  number(v.dragYaw, 'view.dragYaw');
  number(v.dragPitch, 'view.dragPitch'); // Drag offsets accumulate; only the derived camera pitch is clamped.
  number(v.zoom, 'view.zoom', 0.45, 2.2);

  const sounds = record(obj.sounds, 'sounds');
  const builtins = record(sounds.builtins, 'sounds.builtins');
  for (const [name, enabled] of Object.entries(builtins)) {
    if (!name) invalid('sounds.builtins');
    boolean(enabled, `sounds.builtins.${name}`);
  }
  const knownIds = new Set<number>();
  if (sounds.builtinIds !== undefined) {
    const names = new Set<string>();
    for (const entry of array(sounds.builtinIds, 'sounds.builtinIds')) {
      const pair = array(entry, 'sounds.builtinIds', 2);
      const id = integer(pair[0], 'sounds.builtinIds.id', 1, Number.MAX_SAFE_INTEGER);
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
  const names = new Set(Object.keys(builtins));
  for (const entry of array(sounds.user, 'sounds.user')) {
    const u = record(entry, 'sounds.user[]');
    const id = integer(u.id, 'sounds.user.id', 1, Number.MAX_SAFE_INTEGER);
    const name = string(u.name, 'sounds.user.name');
    if (knownIds.has(id) || names.has(name)) invalid('sounds.user');
    knownIds.add(id);
    names.add(name);
    boolean(u.enabled, 'sounds.user.enabled');
    // AudioBuffer implementations support this native rate range; actual buffer
    // construction is staged before application in case a browser is stricter.
    const sr = number(u.sampleRate, 'sounds.user.sampleRate', 3000, 768000);
    const pcm = string(u.pcm16, 'sounds.user.pcm16');
    // Check bytes without decoding/allocating a second copy of every embedded sound.
    if (!pcm.length || pcm.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(pcm)) invalid('sounds.user.pcm16');
    const bytes = pcm.length / 4 * 3 - (pcm.endsWith('==') ? 2 : pcm.endsWith('=') ? 1 : 0);
    if (bytes % 2 || bytes < 2 || bytes / 2 > sr * 90) invalid('sounds.user.pcm16');
  }

  snapshot(obj.plates, 'plates', knownIds);
  array(obj.holds, 'holds', PLATES).forEach((h) => boolean(h, 'holds'));
  const keep = record(obj.keep, 'keep');
  const slots = array(keep.slots, 'keep.slots', SLOTS);
  // Removing a sample clears live plate references, but native keep slots can
  // still contain its old id. Application deliberately drops those stale ids.
  slots.forEach((slot, i) => { if (slot !== null) snapshot(slot, `keep.slots[${i}]`); });
  if (keep.active !== null) {
    const active = integer(keep.active, 'keep.active', 0, SLOTS - 1);
    if (slots[active] === null) invalid('keep.active');
  }

  const f = record(obj.flight, 'flight');
  boolean(f.on, 'flight.on');
  number(f.R, 'flight.R', 0.06, 0.8);
  number(f.sensorGain, 'flight.sensorGain', 0, 1.5);
  number(f.headMix, 'flight.headMix', 0, 1);
  number(f.falloff, 'flight.falloff', 0.15, 3);
  number(f.thrust, 'flight.thrust', 0.25, 3);
  boolean(f.useChance, 'flight.useChance');
  if (f.state !== null) {
    const state = record(f.state, 'flight.state');
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
  const x = record(obj.exporter, 'exporter');
  choice(x.phrases, 'exporter.phrases', [1, 2, 4]);
  choice(x.mode, 'exporter.mode', ['tail', 'loop']);
}
