/* Shared limits for native additions and the version-1 project boundary. */
export const MAX_USER_SOUNDS = 64;
export const MAX_USER_SAMPLES = 8_640_000;
export const MAX_SOUND_SECONDS = 90;
export const MAX_SOUND_NAME = 128;
export const MIN_SAMPLE_RATE = 3000;
export const MAX_SAMPLE_RATE = 768000;
export const MAX_SOUND_ID = 0xfffffffe;
export const BUILTIN_NAMES = ['GLASS', 'TICK', 'BREATH', 'WOOD', 'SUB', 'WIRE', 'CLOUD', 'METAL', 'VOWEL'] as const;
export const MAX_SOURCE_IDS = MAX_USER_SOUNDS + BUILTIN_NAMES.length;

/** Labels remain inert text; reject invisible controls, not punctuation or Unicode. */
export function validSoundName(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_SOUND_NAME && value.trim().length > 0
    && !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(value);
}
