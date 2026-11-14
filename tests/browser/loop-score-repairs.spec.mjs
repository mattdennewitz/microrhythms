import assert from 'node:assert/strict';
import { test } from '@playwright/test';
import { setup } from './audio-fixture.mjs';

async function installReference(page) {
  await page.evaluate(() => {
    // Deliberately eager and small: the original crossing/fire/fragment path is
    // an independent oracle for the new score's delayed and wrapped cursors.
    function eager(options) {
      const { engine, stack } = window.MR;
      const off = Object.create(engine), grains = [];
      Object.assign(off, { offline: true, bpm: options.bpm, clock: options.clock,
        motions: options.motions, flightRender: options.flight, sensorCursor: null,
        onlyPlate: null, rollSeed: options.seed, stats: { triggers: 0, scheduled: 0, dropped: 0 },
        scheduleGrain(g) { grains.push({ ...g }); return true; } });
      const startBeat = options.startBeat || 0;
      const endBeat = options.beats == null ? off.beatAt(options.seconds) : startBeat + options.beats;
      const seconds = off.timeAtBeat(endBeat), chunk = 0.1 * options.bpm / 60;
      for (let k = 0; startBeat + k * chunk < endBeat; k++) {
        off.scheduleBeats(startBeat + k * chunk, Math.min(endBeat, startBeat + (k + 1) * chunk));
      }
      for (const g of grains) g.time = ((g.time % seconds) + seconds) % seconds;
      grains.sort((a, b) => a.time - b.time);
      const compact = engine.captureLoop(options);
      const plan = { ...compact, createCursor(onlyPlate = null, startTime = 0) {
        let i = 0;
        return { next() {
          while (i < grains.length) {
            const g = grains[i++];
            if ((!onlyPlate || g.plate === onlyPlate) && g.time >= startTime) return g;
          }
          return null;
        } };
      } };
      return { grains, compact, plan, plates: stack.plates.slice() };
    }
    function list(plan, onlyPlate = null, startTime = 0) {
      const cursor = plan.createCursor(onlyPlate, startTime), out = [];
      for (let g = cursor.next(); g; g = cursor.next()) out.push(g);
      return out;
    }
    function compare(expected, actual) {
      if (expected.length !== actual.length) throw new Error(`grain count ${actual.length} != ${expected.length}`);
      const numeric = ['time', 'rate', 'dur', 'srcDur', 'offset', 'sourceOffset', 'amp', 'head', 'x', 'y', 'z'];
      const exact = ['plate', 'key', 'buffer', 'snd', 'reverse', 'throw', 'sensor', 'panModel', 'choke'];
      let largestError = 0;
      for (let i = 0; i < expected.length; i++) {
        for (const key of exact) if (expected[i][key] !== actual[i][key]) throw new Error(`grain ${i}: ${key} differs`);
        for (const key of numeric) {
          const error = Math.abs(expected[i][key] - actual[i][key]);
          largestError = Math.max(largestError, error);
          if (error > 1e-12) throw new Error(`grain ${i}: ${key} differs by ${error}`);
        }
        if (expected[i].dist !== actual[i].dist && Math.abs(expected[i].dist - actual[i].dist) > 1e-12) {
          throw new Error(`grain ${i}: sensor distance differs`);
        }
      }
      return largestError;
    }
    window.loopScoreReference = { eager, list, compare };
  });
}

test('LOOP retained score density is independent of 16 versus 512 future beats', async ({ page }, info) => {
  await setup(page, { bpm: 240, audible: 7 });
  const result = await page.evaluate(() => {
    const { engine, stack } = window.MR;
    const steps = Math.max(...stack.STEP_CHOICES);
    for (const p of stack.plates) {
      Object.assign(p, { steps, tracks: 10, heads: 4, cycle: 0.25, density: 1, chance: 1,
        dir: 1, drift: 0, micro: 0, swing: 0, choke: false });
      p.overrides.clear();
      for (let key = 0; key < steps * 10; key++) p.overrides.set(key, true);
      p.generate(); p.phiFrozen = p.phase0;
    }
    const options = { bpm: 240, seed: 42, listenerPose: engine.listenerPose(window.MR.view) };
    const small = engine.captureLoop({ ...options, beats: 16 });
    const large = engine.captureLoop({ ...options, beats: 512 });
    const cursor = large.createCursor(), horizon = 0.010031;
    let actual = 0, ordered = true, previous = -Infinity;
    for (let g = cursor.next(); g && g.time < horizon; g = cursor.next()) {
      actual++; ordered &&= g.time >= previous; previous = g.time;
    }
    // All cells, heads and revolutions are counted independently of the plan.
    let expected = 0;
    const beatLimit = horizon * 4, tau = 2 * Math.PI;
    for (const p of stack.plates) {
      const w = p.omega();
      for (const h of p.headAngles()) for (const c of p.chips) {
        const target = h - c.angle;
        let angle = target + tau * Math.ceil((p.phase0 - target - 1e-6) / tau);
        for (; angle < p.phase0 + w * beatLimit + 1e-6; angle += tau) {
          const B = Math.round(((angle - p.phase0) / w) * 1e9) / 1e9;
          if (B >= 0 && B / 4 < horizon) expected++;
        }
      }
    }
    return { small: small.metadata, large: large.metadata, expected, actual, ordered,
      hasEagerGrains: 'grains' in small || 'grains' in large,
      secondsRatio: large.seconds / small.seconds };
  });
  await info.attach('bounded-loop-score-density', { body: JSON.stringify(result), contentType: 'application/json' });
  assert.equal(result.secondsRatio, 32);
  assert.equal(result.hasEagerGrains, false);
  assert.equal(result.large.chips, result.small.chips);
  assert.equal(result.large.templates, result.small.templates);
  assert.ok(result.large.series <= result.small.series * 2);
  assert.equal(result.large.poses, 1);
  assert.equal(result.ordered, true);
  assert.equal(result.actual, result.expected);
  assert.ok(result.actual > 1000);
});

for (const beats of [0.03125, 0.117, 5.25]) {
  test(`LOOP ordered cursor equals eager crossings with FX offsets over multiple ${beats}-beat periods`, async ({ page }) => {
    await setup(page, { bpm: 120, audible: 2, cycle: 8 });
    await installReference(page);
    const result = await page.evaluate((beats) => {
      const { engine, exporter, stack } = window.MR;
      engine.fxOn = true;
      for (const [index, p] of stack.plates.entries()) {
        if (index > 1) continue;
        Object.assign(p, { steps: 1, tracks: 2, heads: 2, cycle: index ? 1.75 : 8,
          dir: index ? -1 : 1, chance: 1, drift: 0.017, choke: true, micro: 0, swing: 0 });
        p.overrides = new Map([[0, true], [1, true]]);
        p.generate();
        p.chips.forEach((c, i) => { c.fx = i ? 'stutter' : 'ratchet'; c.fxN = 4; });
        p.phiFrozen = stack.HEAD - p.chips[0].angle;
      }
      const options = { ...exporter.plan(), beats };
      const { eager, list, compare } = window.loopScoreReference;
      const reference = eager(options), actual = list(reference.compact);
      const error = compare(reference.grains, actual);
      const perPlate = reference.plates.map((p) => {
        const expected = reference.grains.filter((g) => g.plate === p);
        const count = list(reference.compact, p);
        compare(expected, count);
        for (const start of [0, reference.compact.seconds * 0.271, reference.compact.seconds - 1e-7]) {
          compare(expected.filter((g) => g.time >= start), list(reference.compact, p, start));
        }
        return count.length;
      });
      compare(reference.grains, list(reference.compact)); // independent second cursor
      return { count: actual.length, error, perPlate, duration: reference.compact.seconds,
        hasThrow: reference.compact.metadataFor().hasThrow,
        warmDur: reference.compact.metadataFor(stack.plates[0]).maxDuration };
    }, beats);
    assert.ok(result.count >= 16);
    assert.ok(result.perPlate[0] > 0 && result.perPlate[1] > 0);
    assert.ok(result.error <= 1e-12);
    assert.equal(result.hasThrow, false);
    assert.ok(result.warmDur > 0);
  });
}

for (const headMix of [0, 0.6]) {
  test(`LOOP ${headMix ? 'mixed' : 'sensor-only'} flight cursors preserve eager event order and real PCM`, async ({ page }, info) => {
    await setup(page, { bpm: 120, audible: 2, cycle: 1.75 });
    await installReference(page);
    const result = await page.evaluate(async (headMix) => {
      const { engine, exporter, stack, flight, view } = window.MR;
      engine.fxOn = true;
      for (const p of stack.plates.slice(0, 2)) {
        p.choke = true;
        p.chips.forEach((c, i) => { c.fx = ['stutter', 'ratchet', 'reverse', 'throw'][i % 4]; c.fxN = 2 + i % 3; });
      }
      const p = stack.plates[0], angle = stack.HEAD + 0.3, radius = p.chips[0].radius;
      Object.assign(flight, { on: true, autopilot: false, headMix, sensorGain: 0.8, useChance: false,
        R: 0.5, falloff: 2, pos: [view.plateX(p), radius * Math.sin(angle), -radius * Math.cos(angle)],
        vel: [0, 0, 0], yaw: 0.4, pitch: -0.1 });
      const options = { ...exporter.plan(), beats: 2.3, sampleRate: 48000 };
      const { eager, list, compare } = window.loopScoreReference;
      const reference = eager(options), events = list(reference.compact);
      compare(reference.grains, events);
      const compact = await engine.renderOffline({ ...options, loop: true, loopPlan: reference.compact });
      const eagerPcm = await engine.renderOffline({ ...options, loop: true, loopPlan: reference.plan });
      let error = 0, energy = 0, peak = 0;
      for (let c = 0; c < 2; c++) {
        const actual = compact.getChannelData(c), expected = eagerPcm.getChannelData(c);
        for (let i = 0; i < actual.length; i++) {
          error += (actual[i] - expected[i]) ** 2; energy += expected[i] ** 2;
          peak = Math.max(peak, Math.abs(actual[i]));
        }
      }
      const baseline = reference.plates.map((p) => list(reference.compact, p));
      // The same captured score must outlive every live ownership boundary.
      const project = window.MR.project.serialize();
      window.MR.sounds.clearAll();
      for (const p of stack.plates) {
        p.mute = true; p.solo = false; p.chance = 0; p.seed ^= 123;
        p.sourceIds.clear(); p.fxOverrides.clear(); p.generate(); p.motion = [];
      }
      engine.fxOn = false; engine.fxWet = 1; engine.panModel = 'HRTF';
      view.sep *= 1.7; flight.pos = [100, 100, 100]; flight.R = 0; flight.on = false;
      stack.breaks = 1; stack.phraseBars = 32;
      baseline.forEach((expected, i) => compare(expected, list(reference.compact, reference.plates[i])));
      window.MR.project.apply(project);
      baseline.forEach((expected, i) => compare(expected, list(reference.compact, reference.plates[i])));
      const after = await engine.renderOffline({ ...options, loop: true, loopPlan: reference.compact });
      let changed = 0;
      for (let c = 0; c < 2; c++) {
        const a = compact.getChannelData(c), b = after.getChannelData(c);
        for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) changed++;
      }
      return { sensors: events.filter((g) => g.sensor).length, heads: events.filter((g) => !g.sensor).length,
        relativeError: Math.sqrt(error / energy), changed, peak, frames: compact.length };
    }, headMix);
    await info.attach('compact-eager-flight-pcm', { body: JSON.stringify(result), contentType: 'application/json' });
    assert.ok(result.sensors > 0);
    assert.equal(result.heads > 0, headMix > 0);
    assert.ok(result.relativeError < 1e-6, `compact/eager PCM RMS ${result.relativeError}`);
    assert.ok(result.peak > 1e-5);
    assert.equal(result.changed, 0);
    assert.equal(result.frames, 55200);
  });
}

test('LOOP freezes chance, rests, piecewise motion and tempo-dependent FX spacing', async ({ page }) => {
  await setup(page, { bpm: 120, audible: 2, cycle: 1.75 });
  await installReference(page);
  const result = await page.evaluate(() => {
    const { engine, exporter, stack } = window.MR;
    engine.fxOn = true;
    stack.breaks = 0.4;
    for (const p of stack.plates.slice(0, 2)) {
      Object.assign(p, { chance: 0.61, rest: 0.35, heads: 3, micro: 0.37, swing: 0.23 });
      p.refresh();
      p.chips.forEach((c, i) => { c.fx = ['ratchet', 'stutter', 'reverse', 'throw'][i % 4]; c.fxN = 2 + i % 3; });
    }
    const options = { ...exporter.plan(), beats: 9.125,
      clock: [{ t0: 0, b0: 0, bps: 2 }, { t0: 1.137, b0: 2.274, bps: 3 }],
      motions: new Map(stack.plates.map((p) => [p, [
        { b0: 0, phi0: p.phiFrozen, w: p.omega() },
        { b0: 2.6, phi0: p.phiFrozen + 0.17, w: -p.omega() * 0.93 },
      ]])),
    };
    const { eager, list, compare } = window.loopScoreReference;
    const reference = eager(options);
    compare(reference.grains, list(reference.compact));
    options.clock[0].bps = 0.5; options.clock[1].t0 = 100;
    for (const motion of options.motions.values()) motion[0].w = 0;
    stack.breaks = 1; stack.phraseBars = 32;
    for (const p of stack.plates) { p.chance = 0; p.rest = 1; p.seed ^= 987; p.generate(); }
    compare(reference.grains, list(reference.compact));
    return { count: reference.grains.length, hasThrow: reference.compact.hasThrow,
      sourceCount: new Set(reference.grains.map((g) => g.snd)).size };
  });
  assert.ok(result.count > 0);
  assert.equal(result.hasThrow, true);
  assert.equal(result.sourceCount, 1);
});

test('an empty sensor-only LOOP is not rescanned once per offline scheduling window', async ({ page }) => {
  await setup(page, { bpm: 120 });
  const result = await page.evaluate(async () => {
    const { engine, exporter, flight } = window.MR;
    Object.assign(flight, { on: true, autopilot: false, headMix: 0, sensorGain: 1,
      R: 0.05, pos: [100, 100, 100], vel: [0, 0, 0] });
    const options = { ...exporter.plan(), beats: 8 };
    const captured = engine.captureLoop(options);
    let cursorCalls = 0;
    const loopPlan = { ...captured, createCursor(...args) {
      cursorCalls++;
      return captured.createCursor(...args);
    } };
    const buffer = await engine.renderOffline({ ...options, loop: true, loopPlan });
    let peak = 0;
    for (let c = 0; c < 2; c++) for (const sample of buffer.getChannelData(c)) peak = Math.max(peak, Math.abs(sample));
    return { cursorCalls, peak, frames: buffer.length };
  });
  assert.ok(result.cursorCalls >= 1 && result.cursorCalls <= 2,
    `one optional warmup suffix and one empty whole-period proof, got ${result.cursorCalls}`);
  assert.equal(result.peak, 0);
  assert.equal(result.frames, 192000);
});

test('all reverse plates share one captured reverse AudioBuffer per source', async ({ page }) => {
  await setup(page, { audible: 7 });
  const result = await page.evaluate(() => {
    const { engine, stack, sounds } = window.MR;
    const source = sounds.byName('Timing reference');
    delete source.rev;
    engine.fxOn = true;
    for (const p of stack.plates) for (const c of p.chips) c.fx = 'reverse';
    const loop = engine.captureLoop({ beats: 4 });
    const cursor = loop.createCursor(), buffers = new Set();
    let count = 0, reverse = true, reversedSamples = true;
    for (let g = cursor.next(); g; g = cursor.next()) {
      count++; buffers.add(g.buffer); reverse &&= g.reverse;
      reversedSamples &&= g.buffer !== source.buffer
        && g.buffer.getChannelData(0)[0] === source.buffer.getChannelData(0).at(-1);
    }
    return { count, uniqueBuffers: buffers.size, reverse, reversedSamples };
  });
  assert.equal(result.count, 28);
  assert.equal(result.uniqueBuffers, 1);
  assert.equal(result.reverse, true);
  assert.equal(result.reversedSamples, true);
});

test('moving replay flight keeps the original path cuts when compact cursors seek or restart', async ({ page }) => {
  await setup(page, { bpm: 120, cycle: 1.75 });
  await installReference(page);
  const result = await page.evaluate(() => {
    const { engine, exporter, stack, flight, view } = window.MR;
    const p = stack.plates[0], radius = p.chips[0].radius;
    const origin = engine.ensureCtx().currentTime;
    engine.clock = [{ t0: origin, b0: 0, bps: 2 }];
    engine.playing = true;
    Object.assign(flight, { on: true, autopilot: false, headMix: 0.4, sensorGain: 0.8,
      R: 0.4, falloff: 1, useChance: false, vel: [0, 0, 0] });
    const samples = [0, 0.37, 0.91, 1.5].map((t) => {
      const angle = stack.HEAD - 0.3 + t * 0.45;
      return { t: origin + t, pos: [view.plateX(p) + 0.03 * t,
        radius * Math.sin(angle), -radius * Math.cos(angle)], fwd: [1, 0, 0], up: [0, 1, 0] };
    });
    flight.pos = samples[0].pos.slice();
    flight.histStart();
    flight.track = samples.map((s) => ({ ...s, pos: s.pos.slice(), fwd: s.fwd.slice(), up: s.up.slice() }));
    flight.knots = samples.map((s) => ({ t: s.t, pos: s.pos.slice() }));
    const replay = flight.exportCtx('tail');
    engine.playing = false;
    const options = { ...exporter.plan(), flight: replay, beats: 3 };
    const { eager, list, compare } = window.loopScoreReference;
    const reference = eager(options);
    compare(reference.grains, list(reference.compact));
    for (const start of [0.19, 0.67, 1.37]) {
      compare(reference.grains.filter((g) => g.time >= start), list(reference.compact, null, start));
    }
    flight.track = []; flight.knots = []; flight.hist = [];
    flight.pos = [99, 99, 99]; flight.on = false; flight.headMix = 0;
    compare(reference.grains, list(reference.compact));
    return { sensors: reference.grains.filter((g) => g.sensor).length,
      moving: replay.moving, poses: reference.compact.metadata.poses };
  });
  assert.equal(result.moving, true);
  assert.ok(result.sensors > 0);
  assert.ok(result.poses > 20);
});
