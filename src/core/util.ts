/* Shared helpers: seeded PRNG, math, euclidean rhythms. */

export const TAU = Math.PI * 2;

// Small, fast, seedable PRNG.
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const randSeed = () => (Math.random() * 4294967296) >>> 0;
export const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const mod = (a: number, n: number) => ((a % n) + n) % n;
export const fract = (x: number) => x - Math.floor(x);

// Bresenham-style euclidean membership: is step i an onset of E(k, n) rotated by rot?
export function euclid(i: number, k: number, n: number, rot: number): boolean {
  if (k <= 0) return false;
  if (k >= n) return true;
  return (((i + rot) * k) % n) < k;
}

// Minor pentatonic-ish scale used to quantise grain pitch.
const SCALE = [0, 3, 5, 7, 10];
export function quantize(semis: number): number {
  const oct = Math.floor(semis / 12);
  const rem = semis - oct * 12;
  let best = 0, bd = 99;
  for (const d of SCALE.concat([12])) {
    const dd = Math.abs(d - rem);
    if (dd < bd) { bd = dd; best = d; }
  }
  return oct * 12 + best;
}

export const pad = (n: number | string, w: number, ch = '0') => String(n).padStart(w, ch);
export const signed = (v: number, digits = 2) => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(digits);
