/* Shared helpers: seeded PRNG, math, euclidean rhythms. */
window.MR = window.MR || {};
(function (MR) {
  'use strict';

  const TAU = Math.PI * 2;

  // Small, fast, seedable PRNG.
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const randSeed = () => (Math.random() * 4294967296) >>> 0;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const mod = (a, n) => ((a % n) + n) % n;
  const fract = (x) => x - Math.floor(x);

  // Bresenham-style euclidean membership: is step i an onset of E(k, n) rotated by rot?
  function euclid(i, k, n, rot) {
    if (k <= 0) return false;
    if (k >= n) return true;
    return (((i + rot) * k) % n) < k;
  }

  // Minor pentatonic-ish scale used to quantise grain pitch.
  const SCALE = [0, 3, 5, 7, 10];
  function quantize(semis) {
    const oct = Math.floor(semis / 12);
    const rem = semis - oct * 12;
    let best = 0, bd = 99;
    for (const d of SCALE.concat([12])) {
      const dd = Math.abs(d - rem);
      if (dd < bd) { bd = dd; best = d; }
    }
    return oct * 12 + best;
  }

  const pad = (n, w, ch = '0') => String(n).padStart(w, ch);
  const signed = (v, digits = 2) => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(digits);

  MR.util = { TAU, mulberry32, randSeed, clamp, lerp, mod, fract, euclid, quantize, pad, signed };
})(window.MR);
