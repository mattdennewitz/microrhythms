import assert from 'node:assert/strict';
import { test } from '@playwright/test';
import { setup } from './audio-fixture.mjs';

test('AS PLAYED preserves actual autopilot listener look after later turns and manual takeover', async ({ page }) => {
  await setup(page, { mode: 'tail' });
  await page.evaluate(async () => {
    window.MR.flight.enter(true);
    await window.MR.engine.start();
  });
  await page.waitForFunction(() => window.MR.engine.songBeat(window.MR.engine.visualTime()) > 1);
  const before = await page.evaluate(() => {
    const { flight, engine } = window.MR;
    const origin = engine.timeAtBeat(0);
    const sample = flight.track.find(s => s.t > origin + 0.1);
    if (!sample) throw new Error('The real frame loop did not record autopilot listener poses');
    window.historicalFlightTime = sample.t - origin + 1e-6;
    const recorded = flight.exportCtx('tail').poseAt(window.historicalFlightTime);
    flight.look(Math.PI, 0.4);
    return { recorded, expected: sample.fwd };
  });
  await page.waitForFunction(() => window.MR.engine.songBeat(window.MR.engine.visualTime()) > 2);
  const after = await page.evaluate(() => {
    const { flight, engine } = window.MR;
    flight.takeManual();
    const pose = flight.exportCtx('tail').poseAt(window.historicalFlightTime);
    engine.stop();
    return pose;
  });
  assert.deepEqual(before.recorded.fwd, before.expected);
  assert.deepEqual(after.fwd, before.recorded.fwd);
  assert.deepEqual(after.up, before.recorded.up);
});

test('real PLAY records landed, airborne, landed and re-entry intervals without resetting the first bars', async ({ page }) => {
  await setup(page, { mode: 'tail' });
  await page.evaluate(() => window.MR.engine.start());
  await page.waitForFunction(() => window.MR.engine.songBeat(window.MR.engine.visualTime()) > 1);
  await page.evaluate(() => {
    const { flight, engine } = window.MR;
    if (flight.exportCtx('tail') !== null) throw new Error('A wholly landed PLAY should not get flight treatment');
    flight.enter(true);
    window.takeoffAt = flight.hist.at(-1).t0 - engine.timeAtBeat(0);
  });
  await page.waitForFunction(() => window.MR.engine.songBeat(window.MR.engine.visualTime()) > 3);
  await page.evaluate(() => {
    const { flight, engine } = window.MR;
    flight.exit();
    window.landingAt = flight.hist.at(-1).t0 - engine.timeAtBeat(0);
  });
  await page.waitForFunction(() => window.MR.engine.songBeat(window.MR.engine.visualTime()) > 4);
  const result = await page.evaluate(() => {
    const { flight, engine, view } = window.MR;
    const ctx = flight.exportCtx('tail');
    if (!ctx) throw new Error('Landing lost the recorded flight context');
    const takeoff = window.takeoffAt, landing = window.landingAt;
    const result = {
      activities: [ctx.activeAt(0), ctx.activeAt(takeoff, true), ctx.activeAt(takeoff), ctx.activeAt(landing, true), ctx.activeAt(landing)],
      cuts: ctx.knotsIn(0, landing + 1), takeoff, landing,
      landedPose: ctx.poseAt(engine.visualTime() - engine.timeAtBeat(0)),
      orbit: engine.listenerPose(view.orbitPose),
    };
    flight.enter(true);
    window.MR.app.restartFlightPath();
    result.intervals = flight.hist.map(s => s.active);
    result.capturedStillLanded = ctx.activeAt(100);
    result.firstBarsStillLanded = flight.exportCtx('tail').activeAt(0);
    engine.stop();
    return result;
  });
  assert.deepEqual(result.activities, [false, false, true, true, false]);
  assert.ok(result.cuts.includes(result.takeoff));
  assert.ok(result.cuts.includes(result.landing));
  assert.deepEqual(result.intervals, [false, true, false, true, true]);
  assert.equal(result.capturedStillLanded, false);
  assert.equal(result.firstBarsStillLanded, false);
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(result.landedPose.pos[i] - result.orbit.pos[i]) < 0.1);
});

test('captured replay callbacks survive actual transport restart, in-place history mutation and geometry edits', async ({ page }) => {
  await setup(page, { mode: 'tail' });
  await page.evaluate(async () => { window.MR.flight.enter(true); await window.MR.engine.start(); });
  await page.waitForFunction(() => window.MR.engine.songBeat(window.MR.engine.visualTime()) > 1);
  const result = await page.evaluate(async () => {
    const { flight, engine, stack, view, app } = window.MR;
    const ctx = flight.exportCtx('tail');
    const read = () => [0, 0.2, 1, 10].map(t => ({ ship: ctx.shipAt(t), pose: ctx.poseAt(t), active: ctx.activeAt(t) }));
    const before = read(), cuts = ctx.knotsIn(0, 20);
    flight.track[0].fwd.fill(9);
    flight.knots[0].pos.fill(9);
    flight.hist[0].ap.tau0 += 90;
    app.restartFlightPath(); engine.stop(); await engine.start();
    flight.look(Math.PI, 0.6); view.sep = 7; stack.plates[0].rOut += 1;
    const after = read(), afterCuts = ctx.knotsIn(0, 20);
    engine.stop();
    return { before, after, cuts, afterCuts };
  });
  assert.deepEqual(result.after, result.before);
  assert.deepEqual(result.afterCuts, result.cuts);
});

test('sensor finds an off-axis chord hit identically in whole and split scheduling windows', async ({ page }) => {
  await setup(page);
  const result = await page.evaluate(() => {
    const { flight, stack, view } = window.MR, p = stack.plates[0], X = view.plateX(p);
    Object.assign(p, { rIn: 0.36, rOut: 0.4 });
    p.chips = [{ ...p.chips[0], radius: 0.38, angle: 0 }];
    const seg = { b0: 0, phi0: -0.5, w: 1 }, whole = [], split = [], axis = [];
    const a = [X, -0.35, -0.38], b = [X, 0.35, -0.38], m = [X, 0, -0.38];
    flight.scanPlate(p, seg, 0, 1, a, b, 0.06, whole);
    flight.scanPlate(p, seg, 0, 0.5, a, m, 0.06, split);
    flight.scanPlate(p, seg, 0.5, 1, m, b, 0.06, split);
    flight.scanPlate(p, seg, 0, 1, [X, -0.35, 0], [X, 0.35, 0], 0.06, axis);
    return { whole: whole.map(h => h.B), split: split.map(h => h.B), axis: axis.length };
  });
  assert.deepEqual(result.whole, [0.5]);
  assert.deepEqual(result.split, result.whole);
  assert.equal(result.axis, 0);
});

test('frame listener history is timestamped at actual audio automation time, not visual time', async ({ page }) => {
  await setup(page, { mode: 'tail' });
  await page.evaluate(async () => { window.MR.flight.enter(true); await window.MR.engine.start(); });
  await page.waitForFunction(() => window.MR.engine.songBeat(window.MR.engine.visualTime()) > 1);
  const result = await page.evaluate(async () => {
    const { engine, flight } = window.MR, updateSpace = engine.updateSpace;
    let target;
    engine.updateSpace = function (cam) {
      target = { t: this.ctx.currentTime, fwd: this.listenerPose(cam).fwd.slice() };
      return updateSpace.call(this, cam);
    };
    const frames = [];
    try {
      flight.look(Math.PI, 0);
      for (let i = 0; i < 5; i++) {
        await new Promise(resolve => requestAnimationFrame(resolve));
        const sample = flight.track.at(-1);
        frames.push({ targetT: target.t, sampleT: sample.t, targetFwd: target.fwd, sampleFwd: sample.fwd,
          latency: engine.ctx.currentTime - engine.visualTime() });
      }
      const sample = flight.track.at(-2), next = flight.track.at(-1);
      const historical = flight.exportCtx('tail').poseAt((sample.t + next.t) / 2 - engine.timeAtBeat(0));
      return { frames, historicalFwd: historical.fwd, recordedFwd: sample.fwd };
    } finally {
      engine.updateSpace = updateSpace;
      engine.stop();
    }
  });
  for (const frame of result.frames) {
    assert.ok(frame.sampleT >= frame.targetT, `listener target backdated by ${frame.targetT - frame.sampleT}s (latency ${frame.latency}s)`);
    assert.deepEqual(frame.sampleFwd, frame.targetFwd);
  }
  assert.deepEqual(result.historicalFwd, result.recordedFwd);
});

for (const autopilot of [false, true]) test(`${autopilot ? 'autopilot' : 'manual'} listener capture has no future position or orientation jump`, async ({ page }) => {
  await setup(page, { mode: 'tail' });
  await page.evaluate(async (autopilot) => {
    const { flight, engine } = window.MR;
    flight.enter(true);
    if (!autopilot) { flight.takeManual(); flight.keys = new Set(['w', 'shift']); }
    await engine.start();
  }, autopilot);
  await page.waitForFunction(() => window.MR.engine.songBeat(window.MR.engine.visualTime()) > 1);
  const result = await page.evaluate(async () => {
    const { engine, flight, app } = window.MR;
    // Freeze the real audio clock, not its getters, so capture±epsilon refers
    // to the exact export click despite render-quantum clock advancement.
    await engine.ctx.suspend();
    flight.keys = new Set(['x']);
    const time = engine.ctx.currentTime - engine.timeAtBeat(0), ctx = flight.exportCtx('tail'), epsilon = 1e-9;
    const before = ctx.poseAt(time - epsilon), at = ctx.poseAt(time), after = ctx.poseAt(time + epsilon);
    const future = ctx.poseAt(time + 0.2);
    app.restartFlightPath(); flight.look(Math.PI, 0.5);
    const afterRestart = ctx.poseAt(time + 0.2);
    engine.stop();
    return { before, at, after, future, afterRestart };
  });
  for (const key of ['pos', 'fwd', 'up']) for (let i = 0; i < 3; i++) {
    assert.ok(Math.abs(result.before[key][i] - result.at[key][i]) < 1e-7, `past ${key}[${i}] changed at capture`);
    assert.ok(Math.abs(result.after[key][i] - result.at[key][i]) < 1e-7, `future ${key}[${i}] jumped at capture`);
  }
  assert.deepEqual(result.afterRestart, result.future);
});
