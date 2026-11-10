import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from '@playwright/test';
import { setup } from './audio-fixture.mjs';

const project = JSON.parse(await readFile(new URL('./fixtures/flight-loop.json', import.meta.url), 'utf8'));

for (const sampleRate of [44100, 48000]) {
  test(`cyclic boundary: supplied flight CHOKE matches a continuously repeated performance at ${sampleRate} Hz`, async ({ page }, info) => {
    await setup(page);
    const result = await page.evaluate(async ({ project, sampleRate }) => {
      const { engine, exporter, stack } = window.MR;
      window.MR.project.apply(project);
      stack.plates.forEach((p) => { p.phiFrozen = p.phase0; });
      // Isolate the reported SUB/CHOKE failure, without HRTF implementation variance.
      engine.panModel = 'equalpower';
      const pl = exporter.plan(), plate = stack.plates[2];
      const seconds = 32 * 60 / 112, frames = Math.round(seconds * sampleRate);
      const opts = { ...pl, onlyPlate: plate, sampleRate, trace: true };
      const actual = sampleRate === 48000 ? await exporter.render(plate, pl)
        : await engine.renderOffline({ ...opts, loop: true });
      // Independent reference: repeat this plate's motion explicitly through three
      // periods in the existing performance renderer. Chance is 1 on this plate.
      const motions = new Map(stack.plates.map((p) => [p,
        [0, 32, 64].map((b0) => ({ b0, phi0: p.phiFrozen, w: p.omega() })),
      ]));
      const reference = await engine.renderOffline({ ...opts, loop: false, loopPlan: null, beats: 96, motions, tail: 4 });
      const target = reference.getChannelData(0), signal = actual.getChannelData(0);
      let error = 0, energy = 0, firstError = 0, firstEnergy = 0;
      for (let i = 0; i < Math.min(signal.length, frames - 2); i++) {
        const at = seconds * sampleRate + i, j = Math.floor(at), f = at - j;
        const expected = target[j] * (1 - f) + target[j + 1] * f;
        const diff = signal[i] - expected;
        error += diff * diff; energy += expected * expected;
        if (i < 0.05 * sampleRate) { firstError += diff * diff; firstEnergy += expected * expected; }
      }
      const cyclic = await engine.renderOffline({ ...opts, loop: true });
      const lastSensor = cyclic.trace.filter((v) => v.sensor).sort((a, b) => a.start - b.start).at(-1);
      return { frames: actual.length, expectedFrames: frames,
        relativeRmsError: Math.sqrt(error / energy), first50msRelativeRmsError: Math.sqrt(firstError / firstEnergy),
        lastSensor: { start: lastSensor.start, end: lastSensor.end, chokedAt: lastSensor.chokedAt },
        period: frames / sampleRate,
        pcm: window.audioFixture.measureWav(exporter.encodeWav(actual)),
      };
    }, { project, sampleRate });
    await info.attach('cyclic-boundary-measurements', { body: JSON.stringify(result), contentType: 'application/json' });
    assert.equal(result.frames, result.expectedFrames);
    assert.ok(result.pcm.peak > 1e-5);
    assert.ok(result.relativeRmsError < 0.005, `whole-loop relative RMS error ${result.relativeRmsError}`);
    assert.ok(result.first50msRelativeRmsError < 0.005, `boundary relative RMS error ${result.first50msRelativeRmsError}`);
    assert.ok(result.lastSensor.end > result.period, 'the final sensor grain crosses the boundary');
    assert.ok(Math.abs(result.lastSensor.chokedAt - result.period) <= 1 / sampleRate,
      `last sensor must be choked by the restarted downbeat, actual ${result.lastSensor.chokedAt}`);
  });
}

test('paused manual flight stops residual velocity and repeated export sensor timing stays fixed', async ({ page }, info) => {
  await setup(page);
  await page.evaluate((snapshot) => window.MR.project.apply(snapshot), project);
  await page.locator('#btn-play').click();
  await page.waitForFunction(() => window.MR.engine.playing);
  const result = await page.evaluate(async () => {
    const { engine, flight, exporter, stack } = window.MR;
    flight.vel = [0, 0, -0.25];
    flight.keys.add('w');
    engine.stop();
    const paused = { pos: flight.pos.slice(), vel: flight.vel.slice(), keys: [...flight.keys] };
    const plan = exporter.plan();
    const first = await engine.renderOffline({ ...plan, loop: false, loopPlan: null, onlyPlate: stack.plates[2], trace: true });
    const firstPos = flight.pos.slice();
    const second = await engine.renderOffline({ ...exporter.plan(), loop: false, loopPlan: null, onlyPlate: stack.plates[2], trace: true });
    const intervals = (raw) => {
      const starts = raw.trace.filter((v) => v.sensor).map((v) => v.start).sort((a, b) => a - b);
      return starts.slice(1, 8).map((t, i) => t - starts[i]);
    };
    return { paused, firstPos, secondPos: flight.pos.slice(), moving: plan.flight.moving,
      firstIntervals: intervals(first), secondIntervals: intervals(second), busy: exporter.busy };
  });
  await info.attach('paused-flight-measurements', { body: JSON.stringify(result), contentType: 'application/json' });
  assert.deepEqual(result.paused.vel, [0, 0, 0]);
  assert.deepEqual(result.paused.keys, []);
  assert.deepEqual(result.firstPos, result.paused.pos);
  assert.deepEqual(result.secondPos, result.paused.pos);
  assert.equal(result.moving, false);
  for (const interval of [...result.firstIntervals, ...result.secondIntervals]) {
    assert.ok(Math.abs(interval - 0.25 * 60 / 112) < 1 / 48000);
  }
  assert.equal(result.busy, false);
});

test('cyclic event snapshot: chance, stutter and source choices survive edits between stems', async ({ page }, info) => {
  await setup(page, { bpm: 120, phraseBars: 4, phrases: 1, audible: 2, cycle: 1.75 });
  const result = await page.evaluate(async () => {
    const { engine, exporter, stack } = window.MR;
    engine.fxOn = true;
    engine.spaceLevel = 0.3;
    for (const p of stack.plates.slice(0, 2)) {
      p.chance = 0.6;
      p.grainMs = 350;
      for (let key = 0; key < 4; key++) p.fxOverrides.set(key, 'stutter');
      p.assignFx();
    }
    const control = await window.audioFixture.stems();
    let edited = false;
    const captured = await window.audioFixture.stems({ onProgress: (index, _count, _name, fraction) => {
      if (edited || index !== 0 || fraction !== 1) return;
      edited = true;
      engine.rollSeed = 12345678;
      for (const p of stack.plates.slice(0, 2)) {
        p.seed = 987654;
        p.grainMs = 20;
        p.sourceIds.clear();
        p.generate();
      }
    } });
    const next = await window.audioFixture.stems();
    return { control, captured, next, edited, busy: exporter.busy };
  });
  await info.attach('cyclic-event-snapshot', { body: JSON.stringify(result), contentType: 'application/json' });
  assert.equal(result.edited, true);
  assert.equal(result.busy, false);
  for (let i = 0; i < 2; i++) {
    assert.equal(result.captured.members[i].frames, 384000);
    assert.equal(result.captured.members[i].pcmHash, result.control.members[i].pcmHash);
  }
  assert.notEqual(result.next.members[1].pcmHash, result.control.members[1].pcmHash);
});

test('supplied flight project exports real UI mix and seven-stem downloads at the configured length', { tag: '@extended' }, async ({ page }, info) => {
  await setup(page);
  const names = await page.evaluate((snapshot) => {
    window.MR.project.apply(snapshot);
    return window.MR.stack.plates.map((p) => `${p.name}.wav`);
  }, project);
  const results = [];
  for (const kind of ['wav', 'stems']) {
    const pending = page.waitForEvent('download', { timeout: 600000 });
    await page.locator(`#btn-export-${kind}`).click();
    const download = await pending;
    assert.equal(await download.failure(), null);
    const path = info.outputPath(`supplied-flight-corrected.${kind === 'wav' ? 'wav' : 'zip'}`);
    await download.saveAs(path);
    const encoded = (await readFile(path)).toString('base64');
    const measured = await page.evaluate(async ({ encoded, kind }) => {
      const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
      const result = kind === 'wav' ? [window.audioFixture.measureWav(bytes)]
        : await window.audioFixture.measureZip(new Blob([bytes]));
      return result;
    }, { encoded, kind });
    assert.equal(measured.length, kind === 'wav' ? 1 : 7);
    if (kind === 'stems') assert.deepEqual(measured.map((m) => m.name), names);
    else assert.ok(measured[0].peak > 1e-5);
    for (const m of measured) {
      assert.equal(m.frames, 822857);
      assert.equal(m.sampleRate, 48000);
    }
    results.push({ kind, filename: download.suggestedFilename(), measured });
  }
  await info.attach('supplied-flight-downloads', { body: JSON.stringify(results), contentType: 'application/json' });
  await page.locator('#output-block').screenshot({ path: info.outputPath('supplied-flight-output.png') });
  assert.equal(await page.evaluate(() => window.MR.exporter.busy), false);
});
