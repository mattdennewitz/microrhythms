import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { project, validateProject } from '../src/core/project.ts';
import { stack } from '../src/core/stack.ts';
import { engine } from '../src/core/engine.ts';
import { view } from '../src/core/view.ts';
import { flight } from '../src/core/flight.ts';
import { exporter } from '../src/core/exporter.ts';
import { sounds } from '../src/core/sounds.ts';
import { history } from '../src/core/history.ts';
import { registerUi, ui } from '../src/core/bridge.ts';
import { mulberry32 } from '../src/core/util.ts';
import { MAX_USER_SOUNDS, MAX_USER_SAMPLES, MAX_SOUND_ID } from '../src/core/project-limits.ts';

// Exercise real sound import/remapping without requiring Web Audio in Node.
function buffer(data = new Float32Array([0, 0.5, -0.25, 1]), sampleRate = 48000) {
  return {
    length: data.length, duration: data.length / sampleRate, sampleRate, numberOfChannels: 1,
    getChannelData: () => data,
  };
}

beforeEach((t) => {
  t.mock.method(sounds, 'makeBuffer', (data, sampleRate) => buffer(data, sampleRate));
  stack.createDefault();
  stack.selected = 6; stack.style = 'normal'; stack.phraseBars = 8; stack.breaks = 0;
  stack.fxTypes = ['ratchet', 'stutter', 'reverse', 'throw'];
  Object.assign(engine, {
    ctx: null, playing: false, pending: [], bpm: 112, masterLevel: 0.9, spaceLevel: 0.28,
    panModel: 'HRTF', earMode: 'camera', evolveAmount: 0, fxOn: true, fxWet: 0.5, rollSeed: 0xdeadbeef,
  });
  Object.assign(view, { sep: 1.25, sepTarget: 1.25, mode: 'ORBIT', autoOrbit: true, dragYaw: 0, dragPitch: 0, zoom: 1 });
  Object.assign(flight, { on: false, saved: null, R: 0.38, sensorGain: 1, headMix: 0.3, falloff: 0.32, thrust: 1, useChance: false });
  Object.assign(exporter, { phrases: 1, mode: 'tail' });
  sounds.list = []; sounds.nextId = 1; sounds.listeners.clear();
  sounds.add('GLASS', buffer(), true, false);
  sounds.add('TICK', buffer(), true, false);
  stack.plates.forEach((p) => { p.sourceIds = new Set([1, 2]); });
  history.listeners.clear(); history.clear();
  registerUi({
    panelWidth: () => 0, slots: [null, null, null, null], activeSlot: null,
    togglePlay() { engine.playing = !engine.playing; },
    toggleFlight() { if (flight.on) flight.exit(); else flight.enter(); },
    syncAutopilot() {}, syncAll() {},
  });
});

afterEach(() => {
  engine.playing = false;
  flight.on = false;
  sounds.list = []; sounds.listeners.clear();
  stack.plates = [];
  history.listeners.clear(); history.clear();
});

test('serialize produces a complete versioned project and includes builtin ids directly', () => {
  const saved = JSON.parse(JSON.stringify(project.serialize()));
  assert.equal(saved.format, 'orbital-stack');
  assert.equal(saved.version, 1);
  assert.deepEqual(saved.sounds.builtinIds, [[1, 'GLASS'], [2, 'TICK']]);
  assert.doesNotThrow(() => validateProject(saved));
});

test('missing, noninteger and unsupported past/future versions are rejected before any changes', () => {
  for (const version of [undefined, null, '1', 0, -1, 2, 1.5, NaN, Infinity]) {
    const input = project.serialize();
    if (version === undefined) delete input.version;
    else input.version = version;
    input.global.bpm = 160;
    engine.playing = true;
    const pending = engine.pending = [{ kind: 'scene' }];
    const saved = project.serialize();
    assert.throws(() => project.apply(input), /version/, String(version));
    assert.equal(engine.playing, true);
    assert.equal(engine.pending, pending);
    assert.deepEqual(project.serialize(), saved);
    engine.playing = false;
  }
});

test('complete nested validation rejects malformed projects without stopping or changing the machine', () => {
  const cases = [
    ['format', (p) => { p.format = 'other'; }],
    ['global', (p) => { delete p.global; }],
    ['global.bpm', (p) => { p.global.bpm = Infinity; }],
    ['global.rollSeed', (p) => { p.global.rollSeed = -1; }],
    ['global.selected', (p) => { p.global.selected = 7; }],
    ['global.fxTypes', (p) => { p.global.fxTypes = ['other']; }],
    ['global.style', (p) => { p.global.style = 'other'; }],
    ['global.panModel', (p) => { p.global.panModel = 'other'; }],
    ['view.zoom', (p) => { p.view.zoom = 0; }],
    ['view.mode', (p) => { p.view.mode = 'other'; }],
    ['plates length', (p) => { p.plates.pop(); }],
    ['plate object', (p) => { p.plates[0] = null; }],
    ['steps', (p) => { p.plates[0].steps = 1e9; }],
    ['tracks', (p) => { p.plates[0].tracks = 2.5; }],
    ['cycle', (p) => { p.plates[0].cycle = 0; }],
    ['dir', (p) => { p.plates[0].dir = 0; }],
    ['density', (p) => { p.plates[0].density = NaN; }],
    ['seed', (p) => { delete p.plates[0].seed; }],
    ['cut', (p) => { p.plates[0].cut = 'other'; }],
    ['cell tuple', (p) => { p.plates[0].overrides = [[0]]; }],
    ['cell index', (p) => { p.plates[0].overrides = [[960, true]]; }],
    ['duplicate cell', (p) => { p.plates[0].overrides = [[0, true], [0, false]]; }],
    ['cell boolean', (p) => { p.plates[0].overrides = [[0, 'yes']]; }],
    ['cell fx', (p) => { p.plates[0].fxOverrides = [[0, 'other']]; }],
    ['sound reference', (p) => { p.plates[0].sourceIds = [9999]; }],
    ['holds', (p) => { p.holds[0] = 1; }],
    ['keep length', (p) => { p.keep.slots = []; }],
    ['active empty keep', (p) => { p.keep.active = 0; }],
    ['keep snapshot', (p) => { p.keep.slots[0] = {}; }],
    ['builtin enabled', (p) => { p.sounds.builtins.GLASS = 'yes'; }],
    ['builtin tuple', (p) => { p.sounds.builtinIds = [[1]]; }],
    ['builtin duplicate id', (p) => { p.sounds.builtinIds[1][0] = 1; }],
    ['builtin duplicate name', (p) => { p.sounds.builtinIds[1][1] = 'GLASS'; }],
    ['sound array', (p) => { p.sounds.user = {}; }],
    ['flight setting', (p) => { p.flight.R = 0; }],
    ['flight state', (p) => { p.flight.state = {}; }],
    ['export mode', (p) => { p.exporter.mode = 'other'; }],
    ['export count', (p) => { p.exporter.phrases = 0; }],
  ];
  for (const [label, corrupt] of cases) {
    const input = project.serialize();
    corrupt(input);
    engine.playing = true;
    const current = project.serialize();
    const currentSounds = sounds.list.slice();
    const pending = engine.pending = [{ kind: 'scene' }];
    assert.throws(() => validateProject(input), undefined, label);
    assert.throws(() => project.apply(input), undefined, label);
    assert.equal(engine.playing, true, label);
    assert.equal(engine.pending, pending, label);
    assert.deepEqual(sounds.list, currentSounds, label);
    assert.deepEqual(project.serialize(), current, label);
    engine.playing = false;
  }
});

test('user sound data, ids and flight vectors are validated before application', () => {
  sounds.add('CUSTOM', buffer(new Float32Array([0.4, -0.3, 0.1, 0.2])), false, false);
  flight.saved = { pos: [1, 2, 3], autopilot: false, tau: 17, yaw: 0.2, pitch: 0.3, lookYaw: 0, lookPitch: 0, fwd: [1, 0, 0] };
  const valid = project.serialize();
  const cases = [
    (p) => { p.sounds.user[0].id = 1; },
    (p) => { p.sounds.user[0].name = 'GLASS'; },
    (p) => { p.sounds.user[0].enabled = 1; },
    (p) => { p.sounds.user[0].sampleRate = 0; },
    (p) => { p.sounds.user[0].pcm16 = 'not base64'; },
    (p) => { p.sounds.user[0].pcm16 = 'AA=='; }, // Odd PCM byte count.
    (p) => { p.sounds.user[0].pcm16 = ''; },
    (p) => { p.flight.state.pos = [1, 2]; },
    (p) => { p.flight.state.pos[0] = Infinity; },
    (p) => { p.flight.state.fwd = [0, 0, 0]; },
    (p) => { p.flight.state.fwd = [1, 0, 0, 0]; },
    (p) => { p.flight.state.pitch = Math.PI; },
    (p) => { p.flight.state.autopilot = 1; },
  ];
  for (const corrupt of cases) {
    const input = structuredClone(valid);
    corrupt(input);
    assert.throws(() => project.apply(input), /invalid project/);
    assert.deepEqual(project.serialize(), valid);
  }
});

test('all native generated styles serialize and apply, including RAW cycles beyond the slider range', (t) => {
  t.mock.method(Math, 'random', mulberry32(12345));
  for (const style of stack.STYLE_NAMES) {
    for (let attempt = 0; attempt < 10; attempt++) {
      stack.style = style;
      stack.drawAll(style);
      const saved = project.serialize();
      assert.doesNotThrow(() => validateProject(saved), style);
      project.apply(JSON.parse(JSON.stringify(saved)));
      assert.deepEqual(project.serialize(), saved);
    }
  }
  stack.plates[0].steps = 96;
  stack.plates[0].cycle = 48;
  stack.plates[0].generate();
  engine.setBpm(30);
  view.dragPitch = 10;
  assert.doesNotThrow(() => validateProject(project.serialize()));
});

test('v1 JSON roundtrip preserves seeded material, settings, custom sound ids and kept sources', () => {
  // Supply already-conditioned PCM; this boundary test does not need Web Audio.
  const data = new Float32Array(512);
  for (let i = 0; i < data.length; i++) data[i] = Math.sin(i * 0.17) * 0.5;
  const custom = sounds.add('CUSTOM', buffer(data, 44100), false, false);
  stack.plates.forEach((p) => p.sourceIds.add(custom.id));
  custom.enabled = false;
  const plate = stack.plates[0];
  plate.overrides.set(0, true); plate.overrides.set(1, false); plate.fxOverrides.set(0, 'reverse');
  plate.hold = true; plate.generate();
  ui.slots[2] = stack.snapshot(); ui.activeSlot = 2;
  engine.rollSeed = 1234567890;
  engine.bpm = 147; engine.earMode = 'fixed'; engine.panModel = 'equalpower'; engine.fxOn = false;
  view.mode = 'SPLIT'; view.zoom = 1.7; view.dragYaw = 2; view.dragPitch = -0.7;
  exporter.phrases = 4; exporter.mode = 'loop';
  flight.saved = { pos: [2, -1, 0.3], autopilot: false, tau: 31, yaw: 0.4, pitch: -0.2, lookYaw: 0.1, lookPitch: 0.2, fwd: [1, 0, 0] };
  const saved = JSON.parse(JSON.stringify(project.serialize()));
  const chips = structuredClone(plate.chips);
  sounds.nextId = 100;
  engine.rollSeed = 0;
  exporter.phrases = 1;
  plate.seed = 4; plate.generate();
  history.push('old project edit');
  engine.playing = true;
  project.apply(saved);
  const imported = sounds.byName('CUSTOM');
  assert.equal(engine.playing, false);
  assert.equal(imported.id, custom.id);
  assert.equal(imported.enabled, false);
  assert.equal(imported.buffer.sampleRate, 44100);
  assert.ok(stack.plates[0].sourceIds.has(custom.id));
  assert.ok(ui.slots[2][0].sourceIds.includes(custom.id));
  assert.equal(engine.rollSeed, 1234567890);
  assert.equal(exporter.phrases, 4);
  assert.equal(exporter.mode, 'loop');
  assert.equal(history.past.length, 0);
  assert.deepEqual(stack.plates[0].chips, chips);
  assert.deepEqual(project.serialize(), saved);
  assert.doesNotThrow(() => validateProject(project.serialize()));
});

test('legacy complete v1 JSON without builtinIds still opens and restores builtin sources', async () => {
  const saved = JSON.parse(JSON.stringify(project.serialize()));
  delete saved.sounds.builtinIds;
  engine.bpm = 180;
  const opened = await project.open(new File([JSON.stringify(saved)], 'legacy.json'));
  assert.deepEqual(opened, saved);
  assert.equal(engine.bpm, saved.global.bpm);
  assert.deepEqual(stack.plates[0].sourceIds, new Set([1, 2]));
});

test('kept snapshots containing removed sample ids remain compatible with existing v1 files', () => {
  ui.slots[0] = stack.snapshot();
  ui.slots[0][0].sourceIds.push(999);
  const saved = project.serialize();
  assert.doesNotThrow(() => validateProject(saved));
  project.apply(saved);
  assert.deepEqual(ui.slots[0][0].sourceIds, [1, 2]);
});

test('native buffer construction errors are staged before any machine mutation', (t) => {
  const saved = project.serialize();
  saved.sounds.user.push({ id: 3, name: 'CUSTOM', enabled: true, sampleRate: 48000, pcm16: 'AAA=' });
  t.mock.method(sounds, 'makeBuffer', () => { throw new Error('unsupported native sample rate'); });
  engine.playing = true;
  const before = project.serialize();
  assert.throws(() => project.apply(saved), /unsupported native sample rate/);
  assert.equal(engine.playing, true);
  assert.deepEqual(project.serialize(), before);
});

function userSound(id = 3, name = 'CUSTOM', pcm16 = 'AAA=', sampleRate = 48000) {
  return { id, name, enabled: true, sampleRate, pcm16 };
}

test('fixed records reject unknown trees and prototype keys at every boundary', () => {
  const seed = project.serialize();
  seed.sounds.user.push(userSound());
  seed.flight.state = { pos: [1, 2, 3], autopilot: false, tau: 0, yaw: 0, pitch: 0, lookYaw: 0, lookPitch: 0, fwd: [1, 0, 0] };
  seed.keep.slots[0] = structuredClone(seed.plates);
  const records = [
    (p) => p, (p) => p.global, (p) => p.view, (p) => p.plates[0], (p) => p.keep,
    (p) => p.keep.slots[0][0], (p) => p.sounds, (p) => p.sounds.builtins,
    (p) => p.sounds.user[0], (p) => p.flight, (p) => p.flight.state, (p) => p.exporter,
  ];
  for (const select of records) {
    for (const key of ['unknown', '__proto__', 'constructor', 'prototype']) {
      const input = structuredClone(seed);
      Object.defineProperty(select(input), key, { enumerable: true, value: { nested: ['not retained'] } });
      assert.throws(() => validateProject(input), /invalid project/, key);
    }
  }
  assert.doesNotThrow(() => validateProject(seed));
});

test('inherited values and accessors are rejected without invoking getters', () => {
  let reads = 0;
  for (const corrupt of [
    (p) => { p.global = Object.create(p.global); },
    (p) => { Object.setPrototypeOf(p.view, { extra: true }); },
    (p) => { Object.defineProperty(p.global, 'bpm', { enumerable: true, get() { reads++; return 120; } }); },
    (p) => { Object.defineProperty(p, 'sounds', { enumerable: true, get() { reads++; return {}; } }); },
    (p) => { Object.defineProperty(p.plates, 0, { enumerable: true, get() { reads++; return {}; } }); },
    (p) => { Object.defineProperty(p.sounds.builtins, 'GLASS', { enumerable: true, get() { reads++; return true; } }); },
    (p) => { Object.defineProperty(p.global, 'bpm', { enumerable: false, value: 120 }); },
    (p) => { p.global[Symbol('hidden')] = true; },
  ]) {
    const input = project.serialize();
    corrupt(input);
    assert.throws(() => validateProject(input), /invalid project/);
    assert.equal(reads, 0);
  }
  const nullPrototype = project.serialize();
  nullPrototype.global = Object.assign(Object.create(null), nullPrototype.global);
  assert.doesNotThrow(() => validateProject(nullPrototype));
});

test('sparse, decorated and excessive arrays are rejected before element reads', () => {
  for (const corrupt of [
    (p) => { delete p.plates[0]; },
    (p) => { p.holds.extra = true; },
    (p) => { p.plates[0].overrides = [[0, true, 'extra']]; },
    (p) => { p.plates[0].overrides = Array.from({ length: 961 }, (_, i) => [i, true]); },
    (p) => { p.plates[0].overrides = [[-1, true]]; },
    (p) => { p.plates[0].sourceIds = Array.from({ length: 74 }, (_, i) => i + 1); },
    (p) => { p.global.fxTypes = new Array(1000000); },
    (p) => { Object.setPrototypeOf(p.holds, Object.create(Array.prototype)); },
    (p) => { p.holds[Symbol('hidden')] = true; },
  ]) {
    const input = project.serialize();
    corrupt(input);
    assert.throws(() => validateProject(input), /invalid project/);
  }
  const input = project.serialize();
  input.sounds.user = new Array(50000);
  Object.defineProperty(input.sounds.user, 0, { get() { throw new Error('must not inspect oversized array'); } });
  assert.throws(() => validateProject(input), /invalid project: sounds.user/);
});

test('legacy bounded cells outside current dimensions validate and are dropped on application', () => {
  const input = project.serialize();
  input.plates[0].steps = 24;
  input.plates[0].tracks = 3;
  input.plates[0].overrides = [[0, true], [72, true], [216, false], [959, true]];
  input.plates[0].fxOverrides = [[0, 'reverse'], [216, 'throw']];
  assert.doesNotThrow(() => validateProject(input));
  assert.throws(() => validateProject(input, true), /invalid project: plates\[0\].overrides/);
  project.apply(input);
  assert.deepEqual([...stack.plates[0].overrides], [[0, true]]);
  assert.deepEqual([...stack.plates[0].fxOverrides], [[0, 'reverse']]);
  assert.doesNotThrow(() => validateProject(project.serialize(), true));
});

test('builtin identity metadata accepts only canonical native names and unique bounded ids', () => {
  for (const corrupt of [
    (p) => { p.sounds.builtins['GLASS 2'] = true; },
    (p) => { p.sounds.builtins.FORGED = true; },
    (p) => { p.sounds.builtinIds.push([3, 'GLASS']); },
    (p) => { p.sounds.builtinIds[0][0] = MAX_SOUND_ID + 1; },
    (p) => { p.sounds.builtinIds[0][1] = 'WOOD'; },
    (p) => { p.sounds.builtinIds = new Array(10); },
    (p) => { p.sounds.builtinIds = undefined; },
    (p) => { p.sounds.user.push(userSound(3, 'VOWEL')); },
  ]) {
    const input = project.serialize();
    corrupt(input);
    assert.throws(() => validateProject(input), /invalid project/);
  }
});

test('sound labels accept inert markup and Unicode but reject empty, long and control text', () => {
  const label = '<img src=x onerror=alert(1)> — café 🎵 & "quotes"';
  const input = project.serialize();
  input.sounds.user.push(userSound(3, label));
  assert.doesNotThrow(() => validateProject(input));
  project.apply(input);
  assert.equal(sounds.byName(label).name, label);
  assert.equal(project.serialize().sounds.user[0].name, label);
  for (const name of ['', '  ', 'x'.repeat(129), 'a\nb', 'a\u0000b', 'a\u007fb', 'a\u009bb', 'a\u202eb', 'a\u2066b']) {
    input.sounds.user[0].name = name;
    assert.throws(() => validateProject(input), /invalid project: sounds.user.name/);
    assert.throws(() => sounds.add(name, buffer(), false, false), /sound name/);
    assert.throws(() => sounds.addUser(name, buffer()), /sound name/);
  }
  assert.equal(sounds.add('x'.repeat(128), buffer(), false, false).name.length, 128);
  assert.equal(sounds.add('x'.repeat(128), buffer(), false, false).name.length, 128);
  assert.doesNotThrow(() => validateProject(project.serialize()));
});

test('PCM16 base64 requires canonical padding, alphabet, trailing bits and even bytes', () => {
  for (const pcm of ['AAA=', 'AAE=', 'AAAAAA==', 'AAAAAAAA']) {
    const input = project.serialize();
    input.sounds.user.push(userSound(3, 'CUSTOM', pcm));
    assert.doesNotThrow(() => validateProject(input), pcm);
  }
  for (const pcm of ['AAB=', 'AAAAAB==', 'AAA', 'AAA==', '=AAA', 'AA=A', 'AA-_', 'AAA=\n', 'AA==', 'AAAA', '====', 'A'.repeat(100000) + '!===']) {
    const input = project.serialize();
    input.sounds.user.push(userSound(3, 'CUSTOM', pcm));
    assert.throws(() => validateProject(input), /invalid project: sounds.user.pcm16/, pcm.slice(0, 20));
  }
});

test('sound count and aggregate decoded frame budgets reject before native allocation', (t) => {
  let allocations = 0;
  t.mock.method(sounds, 'makeBuffer', () => { allocations++; throw new Error('must not allocate'); });
  const tiny = project.serialize();
  tiny.sounds.user = Array.from({ length: 50000 }, (_, i) => userSound(i + 3, `SAMPLE ${i}`));
  assert.throws(() => project.apply(tiny), /invalid project: sounds.user/);
  const capped = project.serialize();
  capped.sounds.user = Array.from({ length: MAX_USER_SOUNDS }, (_, i) => userSound(i + 3, `SAMPLE ${i}`));
  assert.doesNotThrow(() => validateProject(capped));
  capped.sounds.user.push(userSound(67, 'OVER LIMIT'));
  assert.throws(() => project.apply(capped), /invalid project: sounds.user/);
  const fullPcm = Buffer.alloc(MAX_USER_SAMPLES).toString('base64'); // 90 seconds, mono PCM16 at 48 kHz.
  const full = project.serialize();
  full.sounds.user = [userSound(3, 'FIRST', fullPcm), userSound(4, 'SECOND', fullPcm)];
  assert.doesNotThrow(() => validateProject(full)); // Exactly 8,640,000 mono frames.
  full.sounds.user.push(userSound(5, 'ONE FRAME TOO MANY'));
  assert.throws(() => project.apply(full), /invalid project: sounds.user.pcm16/);
  assert.equal(allocations, 0);
});

test('native count and frame budgets fail before conditioning or sample analysis and mutation', () => {
  for (let i = 0; i < MAX_USER_SOUNDS; i++) sounds.add(`SAMPLE ${i}`, buffer(), false, false);
  const before = sounds.list.slice(), nextId = sounds.nextId;
  const unreadable = { length: 128, sampleRate: 48000, numberOfChannels: 1, getChannelData() { throw new Error('must not read samples'); } };
  assert.throws(() => sounds.add('EXCESS', unreadable), /at most 64 user sounds/);
  assert.throws(() => sounds.addUser('EXCESS', unreadable), /at most 64 user sounds/);
  assert.deepEqual(sounds.list, before);
  assert.equal(sounds.nextId, nextId);
  sounds.list = sounds.list.filter((s) => s.builtin);
  const full = buffer(new Float32Array(MAX_USER_SAMPLES / 2));
  sounds.add('FIRST', full, false, false);
  sounds.add('SECOND', full, false, false);
  const filled = sounds.list.slice(), filledId = sounds.nextId;
  assert.throws(() => sounds.add('EXCESS', unreadable), /sample-frame limit/);
  assert.throws(() => sounds.addUser('EXCESS', unreadable), /sample-frame limit/);
  assert.deepEqual(sounds.list, filled);
  assert.equal(sounds.nextId, filledId);
});

test('saved sound ids avoid allocator poisoning and ordinary additions skip occupied ids', () => {
  const before = sounds.nextId;
  sounds.add('HIGH ID', buffer(), false, false, MAX_SOUND_ID);
  assert.equal(sounds.nextId, before);
  sounds.add('SAVED ID', buffer(), false, false, before);
  const ordinary = sounds.add('ORDINARY', buffer(), false, false);
  assert.equal(ordinary.id, before + 1);
  const nextId = sounds.nextId, list = sounds.list.slice();
  for (const id of [1, before, MAX_SOUND_ID + 1, 0, 1.5, NaN]) {
    const unreadable = { length: 1, sampleRate: 48000, getChannelData() { throw new Error('must not read samples'); } };
    assert.throws(() => sounds.add('DUPLICATE', unreadable, false, false, id), /invalid or duplicate sound id/);
    assert.deepEqual(sounds.list, list);
    assert.equal(sounds.nextId, nextId);
  }
});

test('individual duration, rate and frame validity are enforced before sample reads', () => {
  const input = project.serialize();
  input.sounds.user.push(userSound(3, 'TOO LONG', Buffer.alloc(270001 * 2).toString('base64'), 3000));
  assert.throws(() => validateProject(input), /invalid project: sounds.user.pcm16/);
  for (const [length, sampleRate] of [[0, 48000], [48000 * 90 + 1, 48000], [1, 2999], [1, 768001], [1, Infinity]]) {
    const bad = { length, sampleRate, getChannelData() { throw new Error('must not read samples'); } };
    const list = sounds.list.slice(), nextId = sounds.nextId;
    assert.throws(() => sounds.add('INVALID', bad, false, false), /supported sample rate/);
    assert.deepEqual(sounds.list, list);
    assert.equal(sounds.nextId, nextId);
  }
  assert.throws(() => sounds.add('FORGED', buffer(), true, false), /invalid or duplicate builtin/);
  assert.throws(() => sounds.add('GLASS', buffer(), true, false), /invalid or duplicate builtin/);
});

test('random-cut fragments stay identical when reopening sparse custom sound identities', () => {
  const data = new Float32Array(48000);
  for (let i = 0; i < data.length; i++) data[i] = Math.sin(i * 0.17) * 0.4;
  const sound = sounds.add('CUSTOM', buffer(data), false, false);
  const plate = stack.plates[0];
  plate.seed = 42;
  plate.cut = 'random';
  plate.grainMs = 60;
  plate.sourceIds = new Set([sound.id]);
  plate.overrides.set(0, true);
  plate.generate();
  const chip = plate.chips.find((c) => c.key === 0);
  const before = plate.fragmentFor(chip, sound);
  const saved = JSON.parse(JSON.stringify(project.serialize()));
  sounds.nextId = 100;
  project.apply(saved);
  assert.deepEqual(plate.fragmentFor(plate.chips.find((c) => c.key === 0), sounds.byName('CUSTOM')), before);
});

test('forged builtin metadata cannot replace a live builtin id during import', (t) => {
  const input = project.serialize();
  input.sounds.builtinIds = input.sounds.builtinIds.map(([id, name]) => [id + 100, name]);
  input.plates.forEach((plate) => { plate.sourceIds = []; });
  input.sounds.user.push(userSound(1, 'FORGED'));
  let allocations = 0;
  t.mock.method(sounds, 'makeBuffer', () => { allocations++; throw new Error('must not allocate'); });
  engine.playing = true;
  const before = project.serialize();
  assert.throws(() => project.apply(input), /collides with a builtin/);
  assert.equal(allocations, 0);
  assert.equal(engine.playing, true);
  assert.deepEqual(project.serialize(), before);
});
