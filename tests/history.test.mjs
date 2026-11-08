import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { Plate, stack } from '../src/core/stack.ts';
import { history } from '../src/core/history.ts';
import { engine } from '../src/core/engine.ts';

beforeEach(() => {
  stack.plates = [new Plate({ seed: 42, steps: 8, tracks: 2, density: 0.5 }, 0)];
  history.past = [];
  history.future = [];
  history.lastPush = { label: null, at: 0 };
  history.max = 50;
  history.listeners.clear();
  engine.ctx = null;
  engine.playing = false;
});

afterEach(() => {
  history.listeners.clear();
  history.clear();
  history.max = 50;
  stack.plates = [];
});

test('seeded plates regenerate identical chips and retain material when density changes', () => {
  const plate = stack.plates[0];
  const original = structuredClone(plate.chips);
  plate.generate();
  assert.deepEqual(plate.chips, original);
  assert.deepEqual(new Plate({ seed: 42, steps: 8, tracks: 2, density: 0.5 }, 0).chips, original);
  const allCells = [...plate.chips, ...plate.dust];
  plate.density = 1;
  plate.generate();
  assert.equal(plate.chips.length + plate.dust.length, 16);
  assert.ok(plate.chips.length >= original.length);
  for (const cell of [...plate.chips, ...plate.dust]) {
    const previous = allCells.find((candidate) => candidate.key === cell.key);
    for (const key of ['uOff', 'uDur', 'uPitch', 'uMicro', 'uGain', 'uProb', 'srcPick']) {
      assert.equal(cell[key], previous[key], `${key} for cell ${cell.key}`);
    }
  }
});

test('JSON snapshots independently restore parameters, manual cells, FX and generated material', () => {
  const plate = stack.plates[0];
  plate.overrides.set(0, true);
  plate.overrides.set(1, false);
  plate.fxOverrides.set(0, 'reverse');
  plate.generate();
  const saved = JSON.parse(JSON.stringify(stack.snapshot()));
  const chips = structuredClone(plate.chips);
  plate.seed = 99;
  plate.steps = 16;
  plate.density = 0;
  plate.overrides.clear();
  plate.fxOverrides.clear();
  plate.generate();
  assert.notDeepEqual(plate.chips, chips);
  stack.restore(saved);
  assert.deepEqual(stack.snapshot(), saved);
  assert.deepEqual(plate.chips, chips);
  assert.equal(plate.chips.find((chip) => chip.key === 0).fx, 'reverse');
  assert.ok(!plate.chips.some((chip) => chip.key === 1));
  plate.overrides.set(2, true);
  assert.deepEqual(saved[0].overrides, [[0, true], [1, false]]);
});

test('undo/redo restore real plate edits and a new branch discards redo', () => {
  const events = [];
  const unsubscribe = history.onChange((event) => events.push(event));
  const original = stack.snapshot();
  history.push('edit cell');
  stack.plates[0].toggleCell(0, 0);
  const edited = stack.snapshot();
  assert.notDeepEqual(edited, original);
  assert.equal(history.undo(), 'edit cell');
  assert.deepEqual(stack.snapshot(), original);
  assert.equal(history.undo(), null);
  assert.equal(history.redo(), 'edit cell');
  assert.deepEqual(stack.snapshot(), edited);
  assert.equal(history.redo(), null);
  history.undo();
  history.push('change level');
  stack.plates[0].level = 0.25;
  assert.equal(history.redo(), null);
  assert.deepEqual(events, ['push', 'undo', 'redo', 'undo', 'push']);
  unsubscribe();
  history.clear();
  assert.equal(events.length, 5);
});

test('slider coalescing retains the first state and expires at 700 ms', (t) => {
  let now = 1000;
  t.mock.method(performance, 'now', () => now);
  const original = stack.snapshot();
  history.push('level', true);
  stack.plates[0].level = 0.2;
  now += 699;
  history.push('level', true);
  stack.plates[0].level = 0.3;
  assert.equal(history.past.length, 1);
  now += 700;
  history.push('level', true);
  stack.plates[0].level = 0.4;
  assert.equal(history.past.length, 2);
  history.undo();
  assert.equal(stack.plates[0].level, 0.3);
  history.undo();
  assert.deepEqual(stack.snapshot(), original);
});

test('discrete actions stay separate, history is bounded, and clear resets both directions', () => {
  history.max = 3;
  for (let i = 0; i < 5; i++) {
    history.push('level');
    stack.plates[0].level = i / 10;
  }
  assert.equal(history.past.length, 3);
  for (const level of [0.3, 0.2, 0.1]) {
    assert.equal(history.undo(), 'level');
    assert.equal(stack.plates[0].level, level);
  }
  assert.equal(history.undo(), null);
  const events = [];
  history.onChange((event) => events.push(event));
  history.clear();
  assert.equal(history.undo(), null);
  assert.equal(history.redo(), null);
  assert.deepEqual(events, ['reset']);
});
