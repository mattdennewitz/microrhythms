/* Shared shapes used across the core modules. */

/** A source sound: a built-in synth or a user sample. Every chip pulls its fragment from one. */
export interface Sound {
  id: number;
  name: string;
  buffer: AudioBuffer;
  builtin: boolean;
  enabled: boolean;
  /** [min, max] per bucket, for waveform drawing. */
  peaks: Array<[number, number]>;
  /** Detected attack times in seconds (always starts with 0). */
  onsets: number[];
  /** Reversed copy of `buffer`, built on demand. */
  rev?: AudioBuffer;
  /** Import was longer than the 90 s limit; only the start was kept. */
  truncated?: true;
}

export type FxType = 'ratchet' | 'stutter' | 'reverse' | 'throw';
export type CutMode = 'overlap' | 'divide' | 'transient';
export type PlateCut = CutMode | 'random';

/** One cell of a plate. Held in `plate.chips` when active, `plate.dust` otherwise. */
export interface Chip {
  key: number;
  track: number;
  sector: number;
  E: boolean;
  isBeat: boolean;
  beatScore: number;
  accent: boolean;
  trackOff: number;
  trackPitch: number;
  uOff: number;
  uDur: number;
  uPitch: number;
  uMicro: number;
  uGain: number;
  uProb: number;
  srcPick: number;
  uFx: number;
  uFxType: number;
  uFxN: number;
  fx: FxType | null;
  fxN: number;
  angle: number;
  radius: number;
  lastFire: number;
}

/** Piecewise-linear plate motion: from song beat b0 the angle is phi0 + w·(B − b0). */
export interface MotionSeg {
  b0: number;
  phi0: number;
  w: number;
}

/** A camera / listener pose in stack space. */
export interface Pose {
  pos: number[];
  fwd: number[];
  up: number[];
}
