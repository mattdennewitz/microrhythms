import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { setup } from './audio-fixture.mjs';

const naturalProject = JSON.parse(await readFile(new URL('./fixtures/flight-loop.json', import.meta.url), 'utf8'));

for (const sampleRate of [44100, 48000]) {
  for (const mode of ['loop', 'tail']) {
    test(`production HRTF: unchanged natural ${mode} renders preserve both channels at ${sampleRate} Hz`, async ({ page }) => {
      await setup(page);
      const result = await page.evaluate(async ({ project, sampleRate, mode }) => {
        const { engine, exporter } = window.MR;
        window.MR.project.apply(project);
        exporter.mode = mode;
        const plan = exporter.plan();
        const render = () => engine.renderOffline({ ...plan, sampleRate, loop: mode === 'loop', tail: 4 });
        const a = await render(), b = await render();
        // A real, identical graph with retirement deferred beyond completion
        // proves deterministic cleanup also preserves spatial/source tails.
        const retire = engine.retireOfflineVoices;
        let reference;
        try {
          engine.retireOfflineVoices = () => {};
          reference = await render();
        } finally { engine.retireOfflineVoices = retire; }
        const channels = [];
        for (let c = 0; c < 2; c++) {
          const x = a.getChannelData(c), y = b.getChannelData(c), z = reference.getChannelData(c);
          let peak = 0, difference = 0, square = 0, boundaryDifference = 0, referenceDifference = 0;
          for (let i = 0; i < x.length; i++) {
            const d = Math.abs(x[i] - y[i]);
            peak = Math.max(peak, Math.abs(x[i]));
            difference = Math.max(difference, d);
            referenceDifference = Math.max(referenceDifference, Math.abs(x[i] - z[i]));
            square += d * d;
            if (i < 4096 || i >= x.length - 4096) boundaryDifference = Math.max(boundaryDifference, d);
          }
          channels.push({ peak, difference, rms: Math.sqrt(square / x.length), boundaryDifference, referenceDifference });
        }
        return { frames: [a.length, b.length], panModel: engine.panModel, channels };
      }, { project: naturalProject, sampleRate, mode });
      expect(result.panModel).toBe('HRTF');
      expect(result.frames[0]).toBe(result.frames[1]);
      for (const channel of result.channels) {
        expect(channel.peak).toBeGreaterThan(1e-5);
        expect(channel.difference).toBeLessThan(2e-6);
        expect(channel.rms).toBeLessThan(1e-7);
        expect(channel.boundaryDifference).toBeLessThan(2e-6);
        expect(channel.referenceDifference).toBeLessThan(2e-6);
      }
    });
  }
}

test('AS PLAYED THROW starts at the historical initial tempo, not the final tempo', async ({ page }) => {
  await setup(page, { bpm: 60, mode: 'tail', cycle: 32 });
  const result = await page.evaluate(async () => {
    const { engine, stack } = window.MR;
    engine.fxOn = true;
    engine.fxWet = 1;
    const p = stack.plates[0];
    p.chips = [p.chips[0]];
    p.chips[0].fx = 'throw';
    p.level = 0; // Deliberate tagged pre-fader THROW: isolate the first echo.
    const motions = new Map([[p, [{ b0: 0, phi0: stack.HEAD - p.chips[0].angle, w: 2 * Math.PI / 32 }]]]);
    const firstAudible = (buf) => {
      const pcm = buf.getChannelData(0);
      for (let i = 0; i < pcm.length; i++) if (Math.abs(pcm[i]) > 1e-5) return i / buf.sampleRate;
      throw new Error('THROW echo was silent');
    };
    const options = { seconds: 3, tail: 1, onlyPlate: p, motions, listenerPose: window.MR.view.homePose() };
    const historical = await engine.renderOffline({ ...options, bpm: 60, clock: [{ t0: 0, b0: 0, bps: 2 }, { t0: 2, b0: 4, bps: 1 }] });
    const initialTempo = await engine.renderOffline({ ...options, bpm: 120, clock: [{ t0: 0, b0: 0, bps: 2 }] });
    return { historical: firstAudible(historical), initialTempo: firstAudible(initialTempo) };
  });
  expect(result.initialTempo).toBeGreaterThan(0.37);
  expect(result.initialTempo).toBeLessThan(0.41);
  expect(Math.abs(result.historical - result.initialTempo)).toBeLessThan(128 / 48000);
});

test('out-of-order ratchet CHOKE matches chronological real audio and voice cut times', async ({ page }) => {
  await setup(page);
  const result = await page.evaluate(async () => {
    const { engine, stack } = window.MR;
    const p = stack.plates[0];
    const buffer = new AudioBuffer({ length: 48000, sampleRate: 48000, numberOfChannels: 1 });
    const pcm = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) pcm[i] = 0.2 * Math.sin(2 * Math.PI * 220 * i / 48000);
    const render = async (order) => {
      const off = Object.create(engine), ctx = new OfflineAudioContext(2, 4 * 48000, 48000);
      Object.assign(off, { ctx, offline: true, trace: [], chokeVoices: new Map(), offlineVoices: [], stats: { triggers: 0, scheduled: 0, dropped: 0 }, spaceLevel: 0, fxWet: 0 });
      Object.assign(off, engine.buildGraph.call(off, ctx));
      off.buses[p.index].level.gain.value = 0.3;
      off.setListener(ctx, window.MR.view.homePose(), false);
      const g = { plate: p, key: 0, time: 0, buffer, snd: -1, rate: 1, srcDur: 1, dur: 1, offset: 0, sourceOffset: 0, amp: 0.2, fadeIn: 0, fadeOut: 0.1, choke: true, reverse: false, throw: false, sensor: false, dist: null, head: 0, x: 0, y: 0, z: 0, panModel: 'equalpower' };
      for (const t of order) off.scheduleGrain(g, t);
      const out = await ctx.startRendering();
      off.retireOfflineVoices(Infinity);
      return { out, cuts: off.trace.sort((a, b) => a.start - b.start).map((v) => ({ start: v.start, chokedAt: v.chokedAt ?? null })) };
    };
    const chronological = await render([0, 0.1, 1, 2, 3]);
    const ratchet = await render([0, 1, 2, 3, 0.1]);
    let difference = 0;
    for (let c = 0; c < 2; c++) {
      const a = chronological.out.getChannelData(c), b = ratchet.out.getChannelData(c);
      for (let i = 0; i < a.length; i++) difference = Math.max(difference, Math.abs(a[i] - b[i]));
    }
    return { chronological: chronological.cuts, ratchet: ratchet.cuts, difference };
  });
  expect(result.chronological[0].chokedAt).toBe(0.1);
  expect(result.ratchet).toEqual(result.chronological);
  expect(result.difference).toBeLessThan(1e-7);
});

test('real capture retains opposite-phase stereo until import conditioning', async ({ page }) => {
  await setup(page);
  const result = await page.evaluate(async () => {
    const { engine, sounds } = window.MR;
    const ctx = engine.ensureCtx();
    await ctx.resume();
    const original = new AudioBuffer({ length: 44100, sampleRate: 44100, numberOfChannels: 2 });
    const l = original.getChannelData(0), r = original.getChannelData(1);
    for (let i = 0; i < l.length; i++) { l[i] = 0.5 * Math.sin(2 * Math.PI * 440 * i / 44100); r[i] = -l[i]; }
    const source = ctx.createBufferSource();
    source.buffer = original;
    const captured = await new Promise((resolve) => {
      engine.capture(source, 0.5, resolve);
      source.start();
    });
    source.disconnect();
    let peak = 0, cancellation = 0;
    if (captured.numberOfChannels === 2) {
      const left = captured.getChannelData(0), right = captured.getChannelData(1);
      for (let i = 0; i < captured.length; i++) {
        peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
        cancellation = Math.max(cancellation, Math.abs(left[i] + right[i]));
      }
    }
    const sound = sounds.addUser('Captured anti-phase', captured);
    let conditionedPeak = 0;
    for (const v of sound.buffer.getChannelData(0)) conditionedPeak = Math.max(conditionedPeak, Math.abs(v));
    return { channels: captured.numberOfChannels, frames: captured.length, rate: captured.sampleRate, peak, cancellation, conditionedPeak };
  });
  expect(result.channels).toBe(2);
  expect(result.frames).toBe(Math.floor(result.rate * 0.5));
  expect(result.peak).toBeGreaterThan(0.45);
  expect(result.cancellation).toBeLessThan(1e-6);
  expect(result.conditionedPeak).toBeGreaterThanOrEqual(0.9);
});

test('offline voice retirement retains only the active scheduling window, including tail cleanup', async ({ page }) => {
  await setup(page, { bpm: 120, cycle: 0.25 });
  const result = await page.evaluate(async () => {
    const { engine } = window.MR;
    const schedule = engine.scheduleGrain, retire = engine.retireOfflineVoices;
    let peak = 0, completion = null, count = 0;
    const results = [];
    try {
      engine.scheduleGrain = function (...args) {
        const ok = schedule.apply(this, args);
        if (this.offline && ok) {
          count++;
          peak = Math.max(peak, this.offlineVoices.length);
        }
        return ok;
      };
      engine.retireOfflineVoices = function (time) {
        retire.call(this, time);
        if (time === Infinity) completion = this.offlineVoices.length;
      };
      for (const seconds of [8, 16]) {
        peak = 0; completion = null; count = 0;
        await engine.renderOffline({ seconds, tail: 4 });
        results.push({ seconds, peak, completion, count });
      }
    } finally {
      engine.scheduleGrain = schedule;
      engine.retireOfflineVoices = retire;
    }
    return results;
  });
  expect(result[0].count).toBeGreaterThan(100);
  expect(result[1].count).toBeGreaterThan(result[0].count * 1.9);
  for (const render of result) {
    expect(render.completion).toBe(0);
    expect(render.peak).toBeLessThan(render.count / 2);
  }
  expect(result[1].peak).toBeLessThanOrEqual(result[0].peak + 8);
});

test('AS PLAYED THROW replays real control times and startDelay smoothing independently of the scheduling horizon', async ({ page }) => {
  await setup(page, { bpm: 120, mode: 'tail' });
  const result = await page.evaluate(async () => {
    const { engine, exporter, stack, view } = window.MR;
    engine.fxOn = true;
    engine.fxWet = 1;
    const p = stack.plates[0];
    p.level = 0;
    for (const c of p.chips) c.fx = 'throw';
    p.phiFrozen = -p.chips[0].angle;
    const ctx = engine.ensureCtx(), controls = [];
    const nativeTarget = AudioParam.prototype.setTargetAtTime;
    AudioParam.prototype.setTargetAtTime = function (target, time, constant) {
      if (this === engine.delay.delayTime) controls.push({ seconds: target, t0: time });
      return nativeTarget.call(this, target, time, constant);
    };
    let plan, origin;
    try {
      await engine.start();
      engine.stopTimer();
      origin = engine.timeAtBeat(0);
      engine.lastScheduled = ctx.currentTime + 0.12;
      engine.setBpm(60); // Before bar 1: its target must already be moving at time 0.
      await new Promise((resolve) => setTimeout(resolve, 300));
      engine.lastScheduled = ctx.currentTime + 0.12;
      engine.setBpm(90);
      plan = exporter.plan();
    } finally { AudioParam.prototype.setTargetAtTime = nativeTarget; }
    engine.stop();
    const seconds = 4, tail = 2, sampleRate = 48000;
    const actual = await engine.renderOffline({ ...plan, seconds, beats: null, tail, sampleRate });
    // Independent native automation oracle: leave enough real silent pre-roll
    // to schedule even the pre-bar-1 control at its original time. No analytic
    // negative-time folding or tempo-clock-derived target times are used here.
    const pre = 0.2, preFrames = Math.round(pre * sampleRate);
    const refCtx = new OfflineAudioContext(2, actual.length + preFrames, sampleRate);
    const off = Object.create(engine);
    Object.assign(off, { ctx: refCtx, offline: true, playing: true, flightRender: null,
      clock: plan.clock.map((s) => ({ ...s, t0: s.t0 + pre })), motions: plan.motions,
      onlyPlate: null, sensorCursor: null, rollSeed: plan.seed, trace: null,
      offlineVoices: [], chokeVoices: new Map(), stats: { triggers: 0, scheduled: 0, dropped: 0 },
      masterLevel: plan.mix.master, spaceLevel: plan.mix.space, fxWet: plan.mix.fxWet });
    Object.assign(off, engine.buildGraph.call(off, refCtx));
    const initial = plan.throwClock[0];
    off.delay.delayTime.setValueAtTime(initial.value ?? initial.seconds, 0);
    off.delay.delayTime.setTargetAtTime(initial.seconds, initial.t0 + pre, 0.05);
    for (const c of controls) off.delay.delayTime.setTargetAtTime(c.seconds, c.t0 - origin + pre, 0.05);
    off.setListener(refCtx, plan.listenerPose || view.homePose(), false);
    stack.plates.forEach((plate, i) => {
      off.buses[i].level.gain.value = plan.mix.levels[i];
      off.buses[i].tone.frequency.value = off.distanceTone(plate, plan.listenerPose || view.homePose(), pre);
    });
    const endBeat = off.beatAt(pre + seconds), chunk = 0.15;
    for (let k = 0; k * chunk < endBeat; k++) off.scheduleBeats(k * chunk, Math.min(endBeat, (k + 1) * chunk));
    const reference = await refCtx.startRendering();
    off.retireOfflineVoices(Infinity);
    let error = 0, energy = 0;
    for (let c = 0; c < 2; c++) {
      const a = actual.getChannelData(c), b = reference.getChannelData(c);
      for (let i = 0; i < a.length; i++) {
        error += (a[i] - b[i + preFrames]) ** 2;
        energy += b[i + preFrames] ** 2;
      }
    }
    return { controls: controls.map((c) => ({ ...c, t0: c.t0 - origin })),
      captured: plan.throwClock.slice(1), tempoTimes: plan.clock.slice(1).map((s) => s.t0),
      energy, relativeError: Math.sqrt(error / energy) };
  });
  expect(result.controls).toHaveLength(2);
  expect(result.controls[0].t0).toBeLessThan(0);
  expect(result.controls[1].t0).toBeGreaterThan(0);
  expect(result.captured).toEqual(result.controls);
  for (let i = 0; i < result.controls.length; i++) {
    expect(result.tempoTimes[i] - result.controls[i].t0).toBeGreaterThan(0.1);
  }
  expect(result.energy).toBeGreaterThan(1e-5);
  expect(result.relativeError).toBeLessThan(0.005);
});
