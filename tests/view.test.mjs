import assert from 'node:assert/strict';
import { test } from 'node:test';
import { view } from '../src/core/view.ts';
import { stack } from '../src/core/stack.ts';
import { flight } from '../src/core/flight.ts';

// A browser pinch/pan changes client coordinates, not the cell under a visible chip.
test('picking keeps the same plate and cell after viewport pan and CSS scaling', (t) => {
  const savedView = { ...view }, savedPlates = stack.plates;
  t.after(() => { Object.assign(view, savedView); stack.plates = savedPlates; });
  stack.createDefault();
  const plate = stack.plates[0];
  stack.plates = [plate];
  let bounds = { left: 0, top: 0, width: 400, height: 300 };
  Object.assign(view, {
    canvas: { getBoundingClientRect: () => bounds },
    w: 800, h: 600, dpr: 2, sep: 1.25,
    pos: [10, 0, 0], fwd: [-1, 0, 0], right: [0, 0, 1], up: [0, 1, 0],
    F: 800, cx: 400, cy: 300, near: 0.2,
  });
  const track = 2, sector = 3;
  const r = plate.rIn + (track + 0.5) * plate.trackW;
  const a = plate.angleAt(0, false) + sector * 2 * Math.PI / plate.steps;
  const point = view.pp(view.plateX(plate), r, a);
  assert.ok(point);
  for (const rect of [bounds, { left: -95, top: -177, width: 400, height: 300 },
    { left: -40, top: 12, width: 600, height: 450 }]) {
    bounds = rect;
    const hit = view.pick(rect.left + point[0] * rect.width / view.w,
      rect.top + point[1] * rect.height / view.h, 0, false);
    assert.equal(hit?.plate, plate);
    assert.equal(hit?.track, track);
    assert.equal(hit?.sector, sector);
    assert.equal(hit?.inAnnulus, true);
  }
});

function fixture(t) {
  const savedView = { ...view }, savedPlates = stack.plates, savedFlight = flight.on;
  t.after(() => { Object.assign(view, savedView); stack.plates = savedPlates; flight.on = savedFlight; });
  stack.createDefault();
  const plate = stack.plates[0];
  Object.assign(plate, {
    x: 0, rIn: 0.4, rOut: 0.8, tracks: 1, steps: 16, micro: 1, swing: 0.5,
    phaseStep: 1, onBeat: 0, dir: 1, density: 1, fxDensity: 0, grainMs: 40, phiFrozen: 0,
  });
  for (let key = 0; key < 16; key++) plate.overrides.set(key, true);
  plate.generate();
  // Fixed valid jitter samples make key 0 visibly occupy nominal sector 15.
  plate.chips.forEach(c => { c.uMicro = c.key === 0 ? 0.1 : 0.5; });
  plate.phaseStep = 1;
  plate.refresh();
  stack.plates = [plate];
  flight.on = false;
  const state = { bounds: { left: 0, top: 0, width: 400, height: 300 } };
  Object.assign(view, {
    canvas: { getBoundingClientRect: () => state.bounds },
    w: 800, h: 600, dpr: 2, sep: 1,
    pos: [10, 0, 0], fwd: [-1, 0, 0], right: [0, 0, -1], up: [0, 1, 0],
    F: 800, cx: 400, cy: 300, near: 0.2,
  });
  return { plate, state };
}

test('rendered displaced chip body wins over the nominal neighbor through DPR and viewport pan', t => {
  const { plate, state } = fixture(t), chip = plate.chips.find(c => c.key === 0);
  assert.equal(Math.round(chip.angle * plate.steps / (2 * Math.PI)) % plate.steps, -1);
  for (const bounds of [
    state.bounds, { left: -95, top: -177, width: 400, height: 300 },
    { left: -40, top: 12, width: 600, height: 450 },
  ]) {
    state.bounds = bounds;
    const point = view.pp(0, chip.radius, chip.angle);
    const hit = view.pick(bounds.left + point[0] * bounds.width / view.w,
      bounds.top + point[1] * bounds.height / view.h, 0, false);
    assert.equal(hit?.chip, chip);
    assert.equal(hit?.track, 0);
    assert.equal(hit?.sector, 0);
  }
});

test('empty disc cells retain nominal insertion coordinates outside chip bodies', t => {
  const { plate, state } = fixture(t);
  plate.micro = plate.swing = 0;
  plate.chips = plate.chips.filter(c => c.key !== 7);
  plate.refresh();
  const point = view.pp(0, 0.6, 7 * 2 * Math.PI / plate.steps);
  const hit = view.pick(point[0] * state.bounds.width / view.w,
    point[1] * state.bounds.height / view.h, 0, false);
  assert.equal(hit?.chip, null);
  assert.equal(hit?.track, 0);
  assert.equal(hit?.sector, 7);
  assert.equal(hit?.inAnnulus, true);
});

test('picking rejects foreground intersections before the camera near plane', t => {
  const { plate } = fixture(t);
  const far = new plate.constructor({ x: 0.15, rIn: 0.4, rOut: 1.2 }, 1);
  plate.x = 0.01;
  stack.plates = [plate, far];
  Object.assign(view, {
    pos: [0, 0.6, 0], fwd: [1, 0, 0], right: [0, 0, 1], up: [0, 1, 0], near: 0.03,
  });
  assert.equal(view.project(plate.x, 0.6, 0), null);
  assert.ok(view.project(far.x, 0.6, 0));
  assert.equal(view.pick(200, 150, 0, false)?.plate, far);
  // Ray distance can exceed near while camera-forward depth is still clipped.
  plate.x = 0.02;
  view.F = 40;
  assert.equal(view.pick(200, 110, 0, false)?.plate, far);
});

test('a foreground selection halo never hides an annulus on the disc behind it', t => {
  const { plate } = fixture(t);
  const far = new plate.constructor({ x: 0, rIn: 0.4, rOut: 0.8 }, 1);
  Object.assign(plate, { x: 1, rIn: 0.63, rOut: 0.9 });
  stack.plates = [plate, far];
  const point = view.pp(0, 0.6, 0);
  const hit = view.pick(point[0] / 2, point[1] / 2, 0, false);
  assert.equal(hit?.plate, far);
  assert.equal(hit?.inAnnulus, true);
});

for (const layout of [
  { width: 740, height: 400, panel: { left: 0, top: 208 }, cx: 370, cy: 104 },
  { width: 820, height: 1180, panel: { left: 490, top: 0 }, cx: 245, cy: 590 },
]) {
  test(`camera centers the actual unobscured ${layout.width}x${layout.height} layout in CSS pixels`, t => {
    fixture(t);
    const savedWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const savedDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    t.after(() => {
      if (savedWindow) Object.defineProperty(globalThis, 'window', savedWindow); else delete globalThis.window;
      if (savedDocument) Object.defineProperty(globalThis, 'document', savedDocument); else delete globalThis.document;
    });
    const panel = { getBoundingClientRect: () => layout.panel };
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { innerWidth: layout.width } });
    Object.defineProperty(globalThis, 'document', {
      configurable: true, value: { body: { classList: { contains: () => false } }, getElementById: () => panel },
    });
    Object.assign(view, {
      canvas: { getBoundingClientRect: () => ({ left: 0, top: 0, width: layout.width, height: layout.height }) },
      w: layout.width * 2, h: layout.height * 2, dpr: 2,
    });
    view.updateCamera(0);
    assert.equal(view.cx / view.dpr, layout.cx);
    assert.equal(view.cy / view.dpr, layout.cy);
    assert.deepEqual(view.orbitPose.pos, view.pos);
    assert.deepEqual(view.orbitPose.fwd, view.fwd);
    flight.on = true;
    view.updateCamera(0);
    assert.deepEqual(view.pos, flight.pose().pos);
    assert.notEqual(view.orbitPose.pos, view.pos, 'landed listener capture must not alias the ship');
    assert.notDeepEqual(view.orbitPose.pos, view.pos);
  });
}
