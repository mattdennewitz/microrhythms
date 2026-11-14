import assert from 'node:assert/strict';
import { test } from 'node:test';
import { flight } from '../src/core/flight.ts';
import { engine } from '../src/core/engine.ts';
import { stack } from '../src/core/stack.ts';
import { view } from '../src/core/view.ts';

function fixture(t) {
  const savedFlight = { ...flight }, savedEngine = { ...engine }, savedView = { ...view }, savedPlates = stack.plates;
  t.after(() => {
    Object.assign(engine, savedEngine); Object.assign(flight, savedFlight);
    Object.assign(view, savedView); stack.plates = savedPlates;
  });
  stack.createDefault();
  Object.assign(engine, { playing: true, ctx: { currentTime: 10 }, clock: [{ t0: 10, b0: 0, bps: 1 }],
    earMode: 'camera', lastScheduled: 0, sensorCursor: null, shipWin: null });
  Object.assign(flight, { on: true, autopilot: false, pos: [0, 0, 0], vel: [0, 0, 0], tNow: 10,
    yaw: 0, pitch: 0, lookYaw: 0, lookPitch: 0, thrust: 3, keys: new Set(), hist: [], track: [], knots: [],
    blend: null, prevAp: null, ap: { t0: 10, tau0: 0, speed: 1 }, fwdSmooth: [1, 0, 0] });
  view.orbitPose = { pos: [8, 2, 1], fwd: [-1, 0, 0], up: [0, 1, 0], right: [0, 0, -1] };
}

function near(actual, expected, tolerance = 1e-12) {
  for (let i = 0; i < expected.length; i++) assert.ok(Math.abs(actual[i] - expected[i]) < tolerance, `${actual} != ${expected}`);
}

test('manual update and predict share the exact damped trajectory, including boosted and long steps', (t) => {
  fixture(t);
  for (const keys of [['w', 'shift'], [], ['w', 'x'], ['a', 'e']]) for (const dt of [0.1, 0.9]) {
    Object.assign(flight, { pos: [0.3, -0.2, 1], vel: [1, -0.4, 0.2], tNow: 10, keys: new Set(keys) });
    const expected = flight.predict(10 + dt);
    engine.ctx.currentTime = 10 + dt;
    flight.update();
    near(flight.pos, expected);
  }
});

test('exact manual integration is invariant to splitting a frame and handles a zero clock origin', (t) => {
  fixture(t);
  Object.assign(flight, { tNow: 0, vel: [0.2, 0.1, -0.3], keys: new Set(['w', 'shift']) });
  const expected = flight.predict(0.1);
  engine.ctx.currentTime = 0.04; flight.update();
  engine.ctx.currentTime = 0.1; flight.update();
  near(flight.pos, expected);
});

test('off-axis sensor chord pruning is conservative for both outer annulus and chip radii', (t) => {
  fixture(t);
  const p = stack.plates[0], c = { ...p.chips[0], radius: 0.38, angle: 0 };
  p.chips = [c];
  const geometry = { plateX: () => 123, restAt: () => false };
  const seg = { b0: 0, phi0: -0.5, w: 1 }, a = [123, -0.35, -0.38], b = [123, 0.35, -0.38], mid = [123, 0, -0.38];
  for (const [rIn, rOut] of [[0.36, 0.4], [0.1, 0.8]]) {
    Object.assign(p, { rIn, rOut });
    const whole = [], split = [], axis = [];
    flight.scanPlate(p, seg, 0, 1, a, b, 0.06, whole, geometry);
    flight.scanPlate(p, seg, 0, 0.5, a, mid, 0.06, split, geometry);
    flight.scanPlate(p, seg, 0.5, 1, mid, b, 0.06, split, geometry);
    flight.scanPlate(p, seg, 0, 1, [123, -0.35, 0], [123, 0.35, 0], 0.06, axis, geometry);
    assert.deepEqual(whole.map(h => h.B), [0.5]);
    assert.deepEqual(split.map(h => h.B), [0.5]);
    assert.equal(axis.length, 0);
  }
});

test('AS PLAYED callbacks own deep copies of history, listener samples, knots and future geometry', (t) => {
  fixture(t);
  flight.histStart();
  flight.knots = [{ t: 10, pos: [0, 0.38, 0] }, { t: 12, pos: [2, 0.38, 0] }];
  flight.recordSample(11, { pos: [1, 0.38, 0], fwd: [0, 0, 1], up: [0, 1, 0] });
  engine.ctx.currentTime = 12;
  const ctx = flight.exportCtx('tail');
  const read = () => [0, 0.5, 1, 4, 20].map(t => ({ ship: ctx.shipAt(t), pose: ctx.poseAt(t), active: ctx.activeAt(t) }));
  const before = read(), cuts = ctx.knotsIn(-1, 20);
  flight.hist[0].ap.tau0 = 100; flight.hist[0].pose.pos.fill(99);
  flight.knots[0].pos.fill(99); flight.track[0].fwd.fill(99);
  flight.histStart(); flight.enter(true); flight.exit();
  flight.pos.fill(-99); flight.vel.fill(-99); flight.fwdSmooth.fill(-99);
  view.sep = 20; stack.plates[0].rIn = 100; stack.plates[0].x = 100;
  near(ctx.shipAt(0.5), before[1].ship);
  assert.deepEqual(read(), before);
  assert.deepEqual(ctx.knotsIn(-1, 20), cuts);
});

test('autopilot replay retains recorded listener look rather than reconstructing past orientation', (t) => {
  fixture(t);
  flight.autopilot = true;
  flight.histStart();
  flight.recordSample(10.5, { pos: [1, 0, 0], fwd: [0, 0, 1], up: [0, 1, 0] });
  engine.ctx.currentTime = 11;
  const before = flight.exportCtx('tail').poseAt(0.5);
  flight.look(Math.PI, 0.5);
  flight.recordSample(11, flight.pose());
  flight.takeManual();
  const after = flight.exportCtx('tail').poseAt(0.5);
  assert.deepEqual(after, before);
  assert.deepEqual(after.fwd, [0, 0, 1]);
});

test('PLAY history includes landed time, takeoff, landing and restart without retroactive flight', (t) => {
  fixture(t);
  flight.on = false; flight.clockChanged();
  assert.equal(flight.exportCtx('tail'), null);
  engine.ctx.currentTime = 11;
  flight.enter(true);
  const takeoff = flight.hist.at(-1).t0 - 10;
  engine.ctx.currentTime = 12;
  flight.exit();
  const landing = flight.hist.at(-1).t0 - 10;
  const ctx = flight.exportCtx('tail');
  assert.ok(ctx);
  assert.equal(ctx.activeAt(0), false);
  assert.equal(ctx.activeAt(takeoff), true);
  assert.equal(ctx.activeAt(takeoff, true), false);
  assert.equal(ctx.activeAt(landing), false);
  assert.equal(ctx.activeAt(landing, true), true);
  assert.deepEqual(ctx.poseAt(0).pos, view.orbitPose.pos);
  assert.ok(ctx.knotsIn(0, 20).includes(takeoff));
  assert.ok(ctx.knotsIn(0, 20).includes(landing));
  engine.ctx.currentTime = 13; flight.enter(true);
  assert.equal(flight.hist.length, 4);
  assert.equal(ctx.activeAt(20), false, 'captured landing stays landed after a later takeoff');
  assert.equal(flight.exportCtx('tail').activeAt(0), false);
});

test('stopped autopilot next-PLAY prediction and LOOP poses are independent of later stack edits', (t) => {
  fixture(t);
  engine.playing = false; flight.autopilot = true;
  const tail = flight.exportCtx('tail'), loop = flight.exportCtx('loop');
  const tailBefore = [tail.shipAt(0), tail.shipAt(9), tail.poseAt(9)];
  const loopBefore = loop.poseAt(0);
  flight.look(Math.PI, 1); flight.ap.tau0 = 90; flight.pos.fill(100);
  view.sep *= 10; stack.plates[0].rOut += 10;
  assert.deepEqual([tail.shipAt(0), tail.shipAt(9), tail.poseAt(9)], tailBefore);
  assert.deepEqual(loop.poseAt(10), loopBefore);
});

test('recording retains only the exportable first 528 beats without truncating its beginning', (t) => {
  fixture(t);
  flight.histStart();
  flight.recordSample(110);
  const E = { sensorCursor: null, timeAtBeat: B => 10 + B };
  flight.prepareWindow(E, 100, 101);
  const lengths = [flight.track.length, flight.knots.length, flight.hist.length];
  engine.ctx.currentTime = 539;
  flight.recordSample(539); flight.prepareWindow(E, 529, 530); flight.histPush('manual');
  assert.deepEqual([flight.track.length, flight.knots.length, flight.hist.length], lengths);
  assert.equal(flight.track[0].t, 10);
  assert.equal(E.sensorCursor.t, 540);
});

test('restarted path knots retain independent left and right limits at an exact boundary', (t) => {
  fixture(t);
  flight.histStart();
  const E = { sensorCursor: null, timeAtBeat: B => 10 + B };
  flight.prepareWindow(E, 0, 1);
  engine.ctx.currentTime = 11;
  flight.pos = [4, 0, 0];
  flight.histPush('manual');
  E.sensorCursor = null; // Restart clears the scheduler's old shared edge.
  flight.prepareWindow(E, 1, 2);
  engine.ctx.currentTime = 12;
  const ctx = flight.exportCtx('tail');
  assert.deepEqual(ctx.shipAt(1, true), [0, 0, 0]);
  assert.deepEqual(ctx.shipAt(1), [4, 0, 0]);
  assert.deepEqual(ctx.poseAt(1, true).pos, [0, 0, 0]);
  assert.deepEqual(ctx.poseAt(1).pos, [0, 0, 0], 'a sensor restart cannot fabricate a listener frame');
});

test('future scheduling transitions do not suppress actual listener frame samples', (t) => {
  fixture(t);
  flight.histStart();
  engine.lastScheduled = 10.12;
  flight.histPush('manual');
  const turned = { pos: [0, 0, 0], fwd: [0, 0, 1], up: [0, 1, 0] };
  flight.recordSample(10.02, turned);
  flight.recordSample(10.04, turned);
  assert.deepEqual(flight.track.map(s => s.t), [10, 10.02, 10.04]);
  engine.ctx.currentTime = 10.04;
  assert.deepEqual(flight.exportCtx('tail').poseAt(0.03).fwd, turned.fwd);
});

test('captured manual continuation joins the final scheduled knot after an input change', (t) => {
  fixture(t);
  flight.histStart();
  flight.knots = [{ t: 10, pos: [0, 0, 0], interval: 0 }, { t: 10.12, pos: [0.12, 0, 0], interval: 0 }];
  // The previous lookahead used the old velocity. New controls change its future
  // prediction, but may not rewrite the endpoint already scheduled live.
  Object.assign(flight, { pos: [0, 0, 0], vel: [0, 0, 0], keys: new Set(['w', 'shift']) });
  const ctx = flight.exportCtx('tail'), end = 0.12, epsilon = 1e-8;
  near(ctx.shipAt(end), [0.12, 0, 0]);
  near(ctx.shipAt(end + epsilon), ctx.shipAt(end), 1e-7);
  assert.ok(ctx.shipAt(end + 0.1)[0] > 0.12, 'captured acceleration continues beyond the authoritative endpoint');
  flight.keys.clear(); flight.vel.fill(100);
  near(ctx.shipAt(end + epsilon), ctx.shipAt(end), 1e-7);
});

test('actual listener samples do not rewind at a horizon-dated same-mode transition', (t) => {
  fixture(t);
  flight.histStart();
  engine.ctx.currentTime = 10.1; engine.lastScheduled = 10.5;
  flight.histPush('manual');
  const actual = { pos: [4, 0.2, -0.1], fwd: [0, 0, 1], up: [0, 1, 0] };
  flight.recordSample(10.4, actual);
  engine.ctx.currentTime = 10.6;
  const ctx = flight.exportCtx('tail');
  assert.deepEqual(ctx.poseAt(0.5 - 1e-8), actual);
  assert.deepEqual(ctx.poseAt(0.5 + 1e-8), actual);
});

test('listener activity retains every actual transition while sensor activity waits for its horizon', (t) => {
  fixture(t);
  flight.on = false; flight.histStart();
  engine.lastScheduled = 10.5;
  engine.ctx.currentTime = 10.1; flight.enter(true);
  engine.ctx.currentTime = 10.2; flight.exit();
  engine.ctx.currentTime = 10.3; flight.enter(true);
  engine.ctx.currentTime = 10.4;
  const ctx = flight.exportCtx('tail');
  assert.deepEqual([0.05, 0.15, 0.25, 0.35].map(t => ctx.listenerActiveAt(t)), [false, true, false, true]);
  assert.equal(ctx.activeAt(0.4), false);
  assert.equal(ctx.activeAt(0.5, true), false);
  assert.equal(ctx.activeAt(0.5), true);
  near(ctx.listenerKnotsIn(0, 1), [0.1, 0.2, 0.3]);
  assert.deepEqual(ctx.knotsIn(0, 1), [0.5], 'listener-only changes do not subdivide the committed sensor chord');
  const takeoff = flight.hist[1].listenerT0 - 10;
  assert.equal(ctx.listenerActiveAt(takeoff, true), false);
  assert.equal(ctx.listenerActiveAt(takeoff), true);
});

for (const autopilot of [false, true]) test(`captured ${autopilot ? 'auto' : 'manual'} listener continuation is C0 and independent of sensor knots`, (t) => {
  fixture(t);
  Object.assign(flight, { autopilot, lookYaw: 0.7, fwdSmooth: [1, 0, 0], pos: [2, 0.2, -0.3], vel: [0.7, -0.2, 0.1] });
  engine.ctx.outputLatency = 0.2;
  flight.histStart();
  const actual = flight.pose();
  flight.recordSample(10.9, actual);
  flight.recordSample(11, actual);
  flight.knots = [{ t: 10.9, pos: [8, 0, 0], interval: 0 }, { t: 11.12, pos: [9, 0, 0], interval: 0 }];
  engine.ctx.currentTime = 11; flight.tNow = 11;
  const ctx = flight.exportCtx('tail'), capture = 1, epsilon = 1e-8;
  const at = ctx.poseAt(capture), before = ctx.poseAt(capture - epsilon), after = ctx.poseAt(capture + epsilon);
  near(before.pos, at.pos); near(before.fwd, at.fwd);
  near(after.pos, at.pos, 1e-7); near(after.fwd, at.fwd, 1e-7); near(after.up, at.up, 1e-7);
  assert.ok(Math.abs(ctx.shipAt(capture + epsilon)[0] - after.pos[0]) > 1, 'listener does not inherit the older scheduled sensor trajectory');
  const frozenFuture = ctx.poseAt(capture + 0.2);
  flight.look(Math.PI, 1); flight.pos.fill(99); flight.vel.fill(99); flight.ap.tau0 += 90;
  assert.deepEqual(ctx.poseAt(capture + 0.2), frozenFuture);
});

test('captured autopilot listener retains its old anchor until the audible path reaches a pending speed change', (t) => {
  fixture(t);
  Object.assign(flight, { autopilot: true, ap: { t0: 10, tau0: 20, speed: 1 } });
  engine.ctx.outputLatency = 0.2;
  flight.pos = flight.apPos(9.8);
  flight.histStart();
  engine.lastScheduled = 10.5;
  flight.reanchor(3);
  const ctx = flight.exportCtx('tail');
  // Listener path time is export time + PLAY origin - output latency.
  const cases = [[0.1, 19.9], [0.6, 20.4], [0.8, 20.8]];
  const expected = cases.map(([, tau]) => flight.pathAtTau(tau));
  for (let i = 0; i < cases.length; i++) near(ctx.poseAt(cases[i][0]).pos, expected[i]);
  flight.prevAp.speed = 99; flight.ap.speed = 99; flight.ap.tau0 = 90;
  for (let i = 0; i < cases.length; i++) near(ctx.poseAt(cases[i][0]).pos, expected[i]);
});
