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
    ['cell index', (p) => { p.plates[0].overrides = [[72, true]]; }],
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

test('v1 JSON roundtrip preserves seeded material, settings, custom sounds and remapped keep sources', () => {
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
  assert.equal(imported.id, 100);
  assert.equal(imported.enabled, false);
  assert.equal(imported.buffer.sampleRate, 44100);
  assert.ok(stack.plates[0].sourceIds.has(100));
  assert.ok(!stack.plates[0].sourceIds.has(custom.id));
  assert.ok(ui.slots[2][0].sourceIds.includes(100));
  assert.equal(engine.rollSeed, 1234567890);
  assert.equal(exporter.phrases, 4);
  assert.equal(exporter.mode, 'loop');
  assert.equal(history.past.length, 0);
  assert.deepEqual(stack.plates[0].chips, chips);
  const expected = structuredClone(saved);
  expected.sounds.user[0].id = 100;
  for (const snapshot of [expected.plates, ...expected.keep.slots.filter(Boolean)]) {
    for (const p of snapshot) p.sourceIds = p.sourceIds.map((id) => id === custom.id ? 100 : id);
  }
  assert.deepEqual(project.serialize(), expected);
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
