/* Zod schemas are the shared boundary for versioned project files and URLs. */
import { z } from 'zod';
import type { ProjectFile } from './project';
import { stack } from './stack';
import {
  BUILTIN_NAMES, MAX_USER_SOUNDS, MAX_USER_SAMPLES, MAX_SOUND_SECONDS, MAX_SOUND_ID,
  MAX_SOURCE_IDS, MIN_SAMPLE_RATE, MAX_SAMPLE_RATE, soundNameSchema,
} from './project-limits';

export const PROJECT_FORMAT = 'orbital-stack';
export const PROJECT_VERSION = 1;
const MAX_CELLS = 960;

/** Zod handles schema validation. This JSON-only guard prevents its parser from
 * invoking getters or accepting inherited/decorated data supplied to the JS API.
 * Prototype-mutating keys are forbidden even if a library ignores them. */
function jsonData<T extends z.ZodType>(schema: T, maxItems = MAX_CELLS) {
  return z.preprocess((value, ctx) => {
    if (!value || typeof value !== 'object') return value;
    const isArray = Array.isArray(value);
    const proto = Object.getPrototypeOf(value);
    if (isArray ? proto !== Array.prototype || value.length > maxItems : proto !== Object.prototype && proto !== null) {
      ctx.addIssue({ code: 'custom', message: 'Expected a bounded plain JSON container' });
      return z.NEVER;
    }
    const keys = Reflect.ownKeys(value);
    if (isArray && keys.length !== value.length + 1) {
      ctx.addIssue({ code: 'custom', message: 'Expected a dense JSON array without extra properties' });
      return z.NEVER;
    }
    for (const key of keys) {
      if (isArray && key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (typeof key !== 'string' || key === '__proto__' || key === 'constructor' || key === 'prototype'
        || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
        ctx.addIssue({ code: 'custom', message: 'Expected safe enumerable JSON data properties' });
        return z.NEVER;
      }
    }
    return value;
  }, schema);
}

function strictObject<T extends z.ZodRawShape>(shape: T) {
  return jsonData(z.strictObject(shape));
}

function boundedArray<T extends z.ZodType>(item: T, maximum: number, exact?: number) {
  const schema = z.array(item).max(maximum);
  return jsonData(exact === undefined ? schema : schema.length(exact), maximum);
}

const unit = z.number().min(0).max(1);
const soundId = z.int().min(1).max(MAX_SOUND_ID);
const seed = z.int().min(0).max(0xffffffff);
const fx = z.enum(['ratchet', 'stutter', 'reverse', 'throw']);
const sourceIds = boundedArray(soundId, MAX_SOURCE_IDS).refine((ids) => new Set(ids).size === ids.length, 'Duplicate sound IDs');
const cellKey = z.int().min(0).max(MAX_CELLS - 1);
const overrides = boundedArray(jsonData(z.tuple([cellKey, z.boolean()]), 2), MAX_CELLS)
  .refine((entries) => new Set(entries.map(([key]) => key)).size === entries.length, 'Duplicate cells');
const fxOverrides = boundedArray(jsonData(z.tuple([cellKey, fx.nullable()]), 2), MAX_CELLS)
  .refine((entries) => new Set(entries.map(([key]) => key)).size === entries.length, 'Duplicate cells');

const plateSchema = strictObject({
  steps: z.int().min(1).max(Math.max(...stack.STEP_CHOICES)),
  tracks: z.int().min(1).max(10),
  // Native RAW generation can exceed the cycle slider's upper limit of 32.
  cycle: z.number().min(0.25).max(48),
  dir: z.literal([-1, 1]),
  density: unit, scatter: unit, onBeat: unit, micro: unit, chance: unit, rest: unit, fxDensity: unit,
  drift: z.number().min(-0.03).max(0.03),
  swing: z.number().min(0).max(0.5),
  grainMs: z.number().min(5).max(600),
  spread: z.number().min(0).max(24),
  transpose: z.number().min(-24).max(24),
  heads: z.int().min(1).max(4),
  level: z.number().min(0).max(1.2),
  cut: z.enum(['overlap', 'divide', 'transient', 'random']),
  slices: z.int().min(2).max(64),
  fadeIn: z.number().min(0).max(0.5),
  fadeOut: z.number().min(0).max(0.9),
  choke: z.boolean(), mute: z.boolean(), solo: z.boolean(), seed,
  overrides, fxOverrides, sourceIds,
});
const stackSchema = boundedArray(plateSchema, 7, 7);
const vector = jsonData(z.tuple([z.number(), z.number(), z.number()]), 3);
const flightStateSchema = strictObject({
  pos: vector, autopilot: z.boolean(), tau: z.number(), yaw: z.number(),
  pitch: z.number().min(-Math.PI / 2).max(Math.PI / 2),
  lookYaw: z.number(), lookPitch: z.number().min(-1.3).max(1.3),
  fwd: vector.refine((v) => Math.abs(Math.hypot(...v) - 1) <= 1e-6, 'Expected a unit forward vector'),
});

const pcmSchema = z.string().min(4).max(Math.ceil(MAX_USER_SAMPLES * 2 / 3) * 4)
  .pipe(z.base64()).superRefine((pcm, ctx) => {
    const padding = pcm.endsWith('==') ? 2 : pcm.endsWith('=') ? 1 : 0;
    const bytes = pcm.length / 4 * 3 - padding;
    // Zod validates the alphabet/padding. PCM additionally requires whole Int16
    // samples and canonical unused bits (atob accepts non-zero padding bits).
    const last = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.indexOf(pcm[pcm.length - padding - 1]);
    if (bytes < 2 || bytes % 2 || (padding === 2 && (last & 15)) || (padding === 1 && (last & 3))) {
      ctx.addIssue({ code: 'custom', message: 'Expected canonical PCM16 base64' });
    }
  });
const userSoundSchema = strictObject({
  id: soundId,
  name: soundNameSchema,
  enabled: z.boolean(),
  sampleRate: z.number().min(MIN_SAMPLE_RATE).max(MAX_SAMPLE_RATE),
  pcm16: pcmSchema,
}).superRefine((sound, ctx) => {
  const padding = sound.pcm16.endsWith('==') ? 2 : sound.pcm16.endsWith('=') ? 1 : 0;
  const frames = (sound.pcm16.length / 4 * 3 - padding) / 2;
  if (frames > sound.sampleRate * MAX_SOUND_SECONDS) {
    ctx.addIssue({ code: 'custom', path: ['pcm16'], message: 'Sound exceeds its duration budget' });
  }
});

const projectSchema = strictObject({
  format: z.literal(PROJECT_FORMAT),
  version: z.literal(PROJECT_VERSION),
  global: strictObject({
    bpm: z.number().min(30).max(240), masterLevel: z.number().min(0).max(1.5), spaceLevel: unit,
    panModel: z.enum(['HRTF', 'equalpower']), earMode: z.enum(['camera', 'fixed']),
    evolveAmount: unit, fxOn: z.boolean(), fxWet: unit, rollSeed: seed,
    fxTypes: boundedArray(fx, 4).refine((types) => new Set(types).size === types.length, 'Duplicate FX types'),
    phraseBars: z.literal([4, 8, 16, 32]), breaks: unit, style: z.enum(stack.STYLE_NAMES),
    selected: z.int().min(0).max(6),
  }),
  view: strictObject({
    sepTarget: z.number().min(0.3).max(2.4), mode: z.enum(['ORBIT', 'SPLIT']), autoOrbit: z.boolean(),
    dragYaw: z.number(), dragPitch: z.number(), zoom: z.number().min(0.45).max(2.2),
  }),
  plates: stackSchema,
  holds: boundedArray(z.boolean(), 7, 7),
  keep: strictObject({ slots: boundedArray(stackSchema.nullable(), 4, 4), active: z.int().min(0).max(3).nullable() }),
  sounds: strictObject({
    builtins: jsonData(z.partialRecord(z.enum(BUILTIN_NAMES), z.boolean())),
    user: boundedArray(userSoundSchema, MAX_USER_SOUNDS),
    builtinIds: boundedArray(jsonData(z.tuple([soundId, z.enum(BUILTIN_NAMES)]), 2), BUILTIN_NAMES.length).optional(),
  }).superRefine((sounds, ctx) => {
    if (Object.hasOwn(sounds, 'builtinIds') && sounds.builtinIds === undefined) {
      ctx.addIssue({ code: 'custom', path: ['builtinIds'], message: 'Omit legacy metadata rather than setting it to undefined' });
    }
  }),
  flight: strictObject({
    on: z.boolean(), R: z.number().min(0.06).max(0.8), sensorGain: z.number().min(0).max(1.5),
    headMix: unit, falloff: z.number().min(0.15).max(3), thrust: z.number().min(0.25).max(3),
    useChance: z.boolean(), state: flightStateSchema.nullable(),
  }),
  exporter: strictObject({ phrases: z.literal([1, 2, 4]), mode: z.enum(['tail', 'loop']) }),
}).superRefine((project, ctx) => {
  const ids = new Set<number>();
  const names = new Set<string>(BUILTIN_NAMES);
  const metadata = project.sounds.builtinIds;
  if (metadata) {
    const savedNames = new Set<string>();
    for (const [id, name] of metadata) {
      if (!Object.hasOwn(project.sounds.builtins, name) || ids.has(id) || savedNames.has(name)) {
        ctx.addIssue({ code: 'custom', path: ['sounds', 'builtinIds'], message: 'Invalid builtin identities' });
      }
      ids.add(id); savedNames.add(name);
    }
    if (savedNames.size !== Object.keys(project.sounds.builtins).length) {
      ctx.addIssue({ code: 'custom', path: ['sounds', 'builtinIds'], message: 'Missing builtin identities' });
    }
  } else {
    Object.keys(project.sounds.builtins).forEach((_, i) => ids.add(i + 1));
  }
  let frames = 0;
  for (const [i, sound] of project.sounds.user.entries()) {
    if (ids.has(sound.id) || names.has(sound.name)) {
      ctx.addIssue({ code: 'custom', path: ['sounds', 'user', i], message: 'Duplicate sound identity' });
    }
    ids.add(sound.id); names.add(sound.name);
    const padding = sound.pcm16.endsWith('==') ? 2 : sound.pcm16.endsWith('=') ? 1 : 0;
    frames += (sound.pcm16.length / 4 * 3 - padding) / 2;
    if (frames > MAX_USER_SAMPLES) {
      ctx.addIssue({ code: 'custom', path: ['sounds', 'user', i, 'pcm16'], message: 'Project exceeds its decoded sample budget' });
      break;
    }
  }
  project.plates.forEach((plate, i) => {
    if (plate.sourceIds.some((id) => !ids.has(id))) {
      ctx.addIssue({ code: 'custom', path: ['plates', i, 'sourceIds'], message: 'Unknown sound identity' });
    }
  });
  if (project.keep.active !== null && project.keep.slots[project.keep.active] === null) {
    ctx.addIssue({ code: 'custom', path: ['keep', 'active'], message: 'Active keep slot is empty' });
  }
}) satisfies z.ZodType<ProjectFile>;

const shareSchema = projectSchema.superRefine((project, ctx) => {
  const snapshots = [{ value: project.plates, path: ['plates'] as (string | number)[] },
    ...project.keep.slots.flatMap((slot, i) => slot === null ? [] : [{ value: slot, path: ['keep', 'slots', i] }])];
  for (const { value, path } of snapshots) {
    value.forEach((plate, i) => {
      const count = plate.steps * plate.tracks;
      for (const key of ['overrides', 'fxOverrides'] as const) {
        if (plate[key].some(([cell]) => cell >= count)) {
          ctx.addIssue({ code: 'custom', path: [...path, i, key], message: 'Cell is outside current plate dimensions' });
        }
      }
    });
  }
});

/** No coercion, transforms, defaults, or silent unknown-key stripping. */
export function validateProject(value: unknown, strictCells = false): asserts value is ProjectFile {
  const result = (strictCells ? shareSchema : projectSchema).safeParse(value);
  if (result.success) return;
  const issue = result.error.issues[0];
  const path = issue.path.reduce<string>((text, key) => typeof key === 'number' ? `${text}[${key}]` : `${text}${text ? '.' : ''}${String(key)}`, '');
  throw new Error(`invalid project: ${path || 'root'}: ${issue.message}`);
}
