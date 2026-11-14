import { test, expect } from '@playwright/test';
import { setup } from './audio-fixture.mjs';

test('AS PLAYED stems keep the click-time chance seed across a same-pattern project replacement', async ({ page }) => {
  await setup(page, { mode: 'tail', audible: 2 });
  const result = await page.evaluate(async () => {
    const { engine, exporter, project, sounds, stack } = window.MR;
    // Builtin PCM survives a project roundtrip without user-sound PCM16 quantization.
    const source = sounds.byName('TICK');
    if (!source) throw new Error('Builtin TICK is required');
    for (const plate of stack.plates.slice(0, 2)) {
      plate.chance = 0.5;
      plate.sourceIds = new Set([source.id]);
      plate.generate();
    }
    const replacement = project.serialize();
    replacement.global.rollSeed = 0xdeadbeef;
    const control = await window.audioFixture.stems();
    let changed = false;
    const edited = await window.audioFixture.stems({ onProgress(index, _count, _name, fraction) {
      if (!changed && index === 0 && fraction === 1) {
        changed = true;
        project.apply(replacement);
      }
    } });
    const following = await window.audioFixture.stems();
    return { control, edited, following, changed, seed: engine.rollSeed, busy: exporter.busy };
  });
  expect(result.changed).toBe(true);
  expect(result.seed).toBe(0xdeadbeef);
  expect(result.busy).toBe(false);
  expect(result.control.members).toHaveLength(2);
  expect(result.edited.members.map((member) => member.pcmHash)).toEqual(result.control.members.map((member) => member.pcmHash));
  for (let i = 0; i < 2; i++) {
    expect(result.control.members[i].peak).toBeGreaterThan(1e-5);
    expect(result.following.members[i].pcmHash).not.toEqual(result.control.members[i].pcmHash);
  }
});

test('compact LOOP captures survive later pattern, source, chance, phase and spatial edits', async ({ page }) => {
  await setup(page, { mode: 'loop', audible: 2 });
  const result = await page.evaluate(async () => {
    const { engine, exporter, stack, view } = window.MR;
    const plan = exporter.plan();
    const measure = async (captured) => window.audioFixture.measureWav(exporter.encodeWav(await exporter.render(null, captured)));
    const control = await measure(plan);
    engine.rollSeed = 0xdeadbeef;
    engine.fxOn = true;
    view.sep = view.sepTarget = 2;
    view.pos = [9, 8, 7];
    view.fwd = [1, 0, 0];
    for (const plate of stack.plates.slice(0, 2)) {
      plate.chance = 0;
      plate.phiFrozen += 0.37;
      plate.sourceIds.clear();
      for (let key = 0; key < 4; key++) plate.overrides.set(key, false);
      plate.generate();
    }
    const captured = await measure(plan);
    const following = await measure(exporter.plan());
    return { control, captured, following };
  });
  expect(result.control.peak).toBeGreaterThan(1e-5);
  expect(result.captured.pcmHash).toEqual(result.control.pcmHash);
  expect(result.captured.frames).toBe(result.control.frames);
  expect(result.following.peak).toBe(0);
});

test('playing-landed AS PLAYED stems retain recorded flight after a restart between stems', async ({ page }) => {
  await setup(page, { mode: 'tail', audible: 2 });
  await page.evaluate(async () => {
    const { engine, flight } = window.MR;
    flight.enter(true);
    await engine.start();
  });
  await page.waitForFunction(() => window.MR.engine.songBeat(window.MR.engine.visualTime()) > 1);
  const landingOffset = await page.evaluate(async () => {
    const { engine, flight, view } = window.MR;
    const offset = engine.horizon() - engine.timeAtBeat(0);
    flight.exit();
    // Wait for the real frame loop to apply and record the landed listener.
    // Otherwise the first click predicts from the last flight sample, while a
    // later click legitimately includes a newly recorded non-flight pose.
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await engine.ctx.suspend();
    engine.stopTimer();
    flight.recordSample(engine.ctx.currentTime, engine.listenerPose(view));
    await engine.ctx.resume();
    return offset;
  });
  const result = await page.evaluate(async (landingOffset) => {
    const { engine, exporter, flight, stack, view } = window.MR;
    const plan = exporter.plan();
    if (!plan.flight) throw new Error('Landed PLAY must retain its recorded flight');
    const flightAtStart = plan.flight.activeAt(landingOffset / 2);
    const flightAfterLanding = plan.flight.activeAt(landingOffset + 0.001);
    const control = await window.audioFixture.stems();
    const landed = await exporter.render(stack.plates[0], { ...plan, flight: null, listenerPose: engine.listenerPose(view) });
    const withoutFlight = window.audioFixture.measureWav(exporter.encodeWav(landed));
    let changed = false;
    const edited = await window.audioFixture.stems({ onProgress(index, _count, _name, fraction) {
      if (!changed && index === 0 && fraction === 1) {
        changed = true;
        engine.stop();
        flight.enter(true);
        void engine.start();
        flight.look(0.7, 0.2);
      }
    } });
    engine.stop();
    flight.exit();
    return { control, edited, withoutFlight, changed, flightAtStart, flightAfterLanding, busy: exporter.busy };
  }, landingOffset);
  expect(result.changed).toBe(true);
  expect(result.flightAtStart).toBe(true);
  expect(result.flightAfterLanding).toBe(false);
  expect(result.busy).toBe(false);
  expect(result.control.name).toContain('-flight-stems.zip');
  expect(result.control.members).toHaveLength(2);
  expect(result.control.members[0].peak).toBeGreaterThan(1e-5);
  expect(result.control.members[0].pcmHash).not.toEqual(result.withoutFlight.pcmHash);
  expect(result.edited.members.map((member) => member.pcmHash)).toEqual(result.control.members.map((member) => member.pcmHash));
});

test('AS PLAYED THROW stems retain captured control-time automation after restart between stems', async ({ page }) => {
  await setup(page, { mode: 'tail', audible: 2 });
  await page.evaluate(async () => {
    const { engine, stack } = window.MR;
    engine.fxOn = true;
    engine.setFxWet(0.5);
    for (const plate of stack.plates.slice(0, 2)) {
      for (let key = 0; key < 4; key++) plate.fxOverrides.set(key, 'throw');
      plate.assignFx();
    }
    await engine.start();
  });
  await page.waitForFunction(() => window.MR.engine.songBeat(window.MR.engine.visualTime()) > 1);
  await page.evaluate(() => window.MR.engine.setBpm(60));
  await page.waitForFunction(() => window.MR.engine.songBeat(window.MR.engine.visualTime()) > 2);
  const result = await page.evaluate(async () => {
    const { engine, exporter, stack } = window.MR;
    const plan = exporter.plan();
    // A tempo-segment replay delays the control change to the scheduling horizon.
    // Actual THROW automation must retain the earlier control-time transition.
    const horizonBuffer = await exporter.render(stack.plates[0], { ...plan, throwClock: null });
    const horizonOnly = window.audioFixture.measureWav(exporter.encodeWav(horizonBuffer));
    const control = await window.audioFixture.stems();
    let changed = false;
    const edited = await window.audioFixture.stems({ onProgress(index, _count, _name, fraction) {
      if (!changed && index === 0 && fraction === 1) {
        changed = true;
        engine.stop();
        engine.setBpm(240);
        void engine.start();
      }
    } });
    const following = await window.audioFixture.stems();
    engine.stop();
    return { control, edited, following, horizonOnly, changed, busy: exporter.busy };
  });
  expect(result.changed).toBe(true);
  expect(result.busy).toBe(false);
  expect(result.control.members).toHaveLength(2);
  expect(result.control.members[0].pcmHash).not.toEqual(result.horizonOnly.pcmHash);
  expect(result.edited.members.map((member) => member.pcmHash)).toEqual(result.control.members.map((member) => member.pcmHash));
  for (let i = 0; i < 2; i++) {
    expect(result.control.members[i].peak).toBeGreaterThan(1e-5);
    expect(result.following.members[i].pcmHash).not.toEqual(result.control.members[i].pcmHash);
  }
});
