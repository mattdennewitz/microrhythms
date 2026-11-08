import assert from 'node:assert/strict';
import test from 'node:test';
import { mulberry32, euclid, quantize, mod, fract, clamp } from '../src/core/util.ts';

test('seeded randomness reproduces material, including unsigned seed wrapping', () => {
  assert.equal(mulberry32(1)(), 0.6270739405881613);
  const sequence = (seed) => {
    const random = mulberry32(seed);
    return Array.from({ length: 128 }, () => random());
  };
  const values = sequence(42);
  assert.deepEqual(values, sequence(42));
  assert.deepEqual(values, sequence(42 + 2 ** 32));
  assert.notDeepEqual(values, sequence(43));
  assert.ok(values.every((value) => value >= 0 && value < 1));
});

test('Euclidean rhythm has the requested onsets and wraps rotation', () => {
  const rhythm = (k, n, rotation = 0) => Array.from({ length: n }, (_, i) => euclid(i, k, n, rotation));
  assert.deepEqual(rhythm(3, 8), [true, false, false, true, false, false, true, false]);
  assert.deepEqual(rhythm(3, 8, 1), [false, false, true, false, false, true, false, true]);
  assert.deepEqual(rhythm(3, 8, 8), rhythm(3, 8));
  assert.deepEqual(rhythm(0, 8), Array(8).fill(false));
  assert.deepEqual(rhythm(9, 8), Array(8).fill(true));
  for (const n of [1, 3, 8, 16, 24]) {
    for (let k = 0; k <= n; k++) {
      assert.equal(rhythm(k, n, 5).filter(Boolean).length, k);
    }
  }
});

test('pitch quantization handles negative octaves, ties and octave boundaries', () => {
  for (const [input, expected] of [[0, 0], [1.5, 0], [2, 3], [4, 3], [6, 5], [9, 10], [11, 10], [11.5, 12], [12, 12], [-1, -2], [-0.5, 0], [-12, -12], [-10, -9]]) {
    assert.equal(quantize(input), expected, `quantize(${input})`);
  }
});

test('cyclic math wraps negative positions and clamps parameter boundaries', () => {
  assert.equal(mod(-1, 8), 7);
  assert.equal(mod(-16, 8), 0);
  assert.equal(mod(17, 8), 1);
  assert.equal(fract(-1.25), 0.75);
  assert.equal(clamp(-1, 0, 1), 0);
  assert.equal(clamp(2, 0, 1), 1);
  assert.equal(clamp(0.5, 0, 1), 0.5);
});
