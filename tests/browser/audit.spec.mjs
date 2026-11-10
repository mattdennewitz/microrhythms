import { stat } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { test } from '@playwright/test';
import { setup } from './audio-fixture.mjs';

test('audit stop freezes the displayed position', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => window.MR.engine.start());
  await page.waitForFunction(() => window.MR.engine.songBeat(window.MR.engine.visualTime()) > 1);
  const result = await page.evaluate(() => {
    const { engine, stack } = window.MR;
    const before = stack.plates.map(p => p.angleAt(engine.visualTime(), true));
    const latency = engine.ctx.outputLatency + engine.ctx.baseLatency;
    engine.stop();
    return { latency, errors: stack.plates.map((p, i) => Math.abs(Math.atan2(Math.sin(p.phiFrozen - before[i]), Math.cos(p.phiFrozen - before[i])))) };
  });
  console.log('STOP', result);
  assert.ok(result.errors.every(error => error < 1e-9));
});

test('audit stalled frames consume every due event', async ({ page }) => {
  await setup(page);
  const result = await page.evaluate(async () => {
    const { engine, stack } = window.MR;
    await engine.start();
    const plate = stack.plates[0], chip = plate.chips[0], tv = engine.visualTime();
    const before = plate.fireCount;
    engine.events = Array.from({ length: 4500 }, () => ({ t: tv - 1, plate, chip, sensor: true }));
    engine.events.push({ t: tv + 100, plate, chip, sensor: false });
    engine.lastScheduled = engine.ctx.currentTime;
    engine.tick();
    const result = { consumed: plate.fireCount - before, due: engine.events.filter(ev => ev.t <= tv).length, future: engine.events.filter(ev => ev.t > tv).length };
    engine.stop();
    return result;
  });
  console.log('EVENTS', result);
  assert.equal(result.consumed, 4500);
  assert.equal(result.due, 0);
  assert.ok(result.future >= 1);
});

test('audit manual prediction follows thrust and damping', async ({ page }) => {
  await setup(page);
  const errors = await page.evaluate(() => {
    const { flight } = window.MR;
    Object.assign(flight, { autopilot: false, pos: [0, 0, 0], vel: [1, 0, 0], yaw: 0, pitch: 0, thrust: 1, tNow: 10 });
    return [['w'], [], ['x']].map(keys => {
      flight.keys = new Set(keys);
      let p = 0, v = 1;
      const dt = 0.0001, a = keys.includes('w') ? 1.6 : 0, k = keys.includes('x') ? 9 : 1.4;
      for (let i = 0; i < 1200; i++) { const dv = a - k * v; p += v * dt + dv * dt * dt / 2; v += dv * dt; }
      const predicted = flight.predict(10.12);
      return Math.max(Math.abs(predicted[0] - p), Math.abs(predicted[1]), Math.abs(predicted[2]));
    });
  });
  console.log('PREDICT', errors);
  assert.ok(errors.every(error => error < 1e-4));
});

test('audit sensor rejects paths through the axis', async ({ page }) => {
  await setup(page);
  const result = await page.evaluate(() => {
    const { flight, stack, view } = window.MR, p = stack.plates[0];
    const X = view.plateX(p), seg = { b0: 0, phi0: 0, w: 2 * Math.PI };
    const crossing = [], control = [];
    flight.scanPlate(p, seg, 0, 4, [X, 0.3, 0], [X, -0.3, 0], 1, crossing);
    flight.scanPlate(p, seg, 0, 4, [X, 0.3, 0], [X, 0.3, 0], 1, control);
    return { crossing: crossing.length, control: control.length };
  });
  console.log('AXIS', result);
  assert.equal(result.crossing, 0);
  assert.ok(result.control > 0);
});

test('audit replay retains the exportable beginning only', async ({ page }) => {
  await setup(page);
  const result = await page.evaluate(() => {
    const { engine, flight } = window.MR;
    engine.clock = [{ t0: 0, b0: 0, bps: 1 }];
    flight.autopilot = false;
    flight.track = []; flight.knots = [];
    flight.recordSample(100); flight.prepareWindow(engine, 100, 101);
    const early = [flight.track.length, flight.knots.length];
    flight.recordSample(529); flight.prepareWindow(engine, 529, 530);
    return { early, late: [flight.track.length, flight.knots.length], cursor: engine.sensorCursor.t };
  });
  console.log('HISTORY', result);
  assert.deepEqual(result.early, [1, 2]);
  assert.deepEqual(result.late, result.early);
  assert.equal(result.cursor, 530);
});

test('audit scheduler reuses one worker script URL', async ({ page }) => {
  await page.addInitScript(() => {
    const create = URL.createObjectURL;
    window.workerUrls = 0;
    URL.createObjectURL = function(blob) {
      if (blob.type === 'text/javascript') window.workerUrls++;
      return create.call(this, blob);
    };
  });
  await setup(page);
  const count = await page.evaluate(async () => {
    const { engine } = window.MR;
    for (let i = 0; i < 5; i++) { await engine.start(); engine.stop(); }
    return window.workerUrls;
  });
  console.log('WORKER_URLS', count);
  assert.equal(count, 1);
});

for (const mode of ['loop', 'tail']) {
  test(`audit ${mode} stems share a mix snapshot`, async ({ page }) => {
    await setup(page, { audible: 2, phraseBars: 1, mode });
    const result = await page.evaluate(async () => {
      const { exporter, stack, engine } = window.MR;
      engine.setMaster(0.7);
      const control = await window.audioFixture.stems();
      let edited = false;
      const changed = await window.audioFixture.stems({ onProgress(i, n, name, f) {
        if (i === 0 && f === 1 && !edited) {
          edited = true;
          stack.plates[1].level = 0; engine.setSpace(1); engine.setFxWet(1); engine.setMaster(0.1);
        }
      } });
      const following = await window.audioFixture.stems();
      return { control: control.members.map(m => m.pcmHash), changed: changed.members.map(m => m.pcmHash), following: following.members.map(m => m.pcmHash) };
    });
    console.log('SNAPSHOT', mode, result);
    assert.deepEqual(result.changed, result.control);
    assert.notDeepEqual(result.following, result.control);
  });
}

test('audit export releases results and writes UTF-8 ZIP headers', async ({ page }) => {
  await setup(page, { phraseBars: 1 });
  const result = await page.evaluate(async () => {
    const { exporter, stack } = window.MR;
    stack.plates[0].name = 'Größe';
    const exported = await exporter.exportStems({ save: false });
    const bytes = new Uint8Array(await exported.blob.arrayBuffer()), v = new DataView(bytes.buffer);
    const central = v.getUint32(bytes.length - 6, true);
    return { retained: 'last' in exporter, localFlag: v.getUint16(6, true), centralFlag: v.getUint16(central + 8, true),
      name: new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(30, 30 + v.getUint16(26, true))) };
  });
  console.log('ZIP', result);
  assert.deepEqual(result, { retained: false, localFlag: 0x0800, centralFlag: 0x0800, name: 'Größe.wav' });
});

test('audit ZIP rejects Blob entries without a CRC', async ({ page }) => {
  await setup(page);
  const error = await page.evaluate(() => {
    try { window.MR.exporter.zip([{ name: 'a', data: new Blob(['x']) }]); return null; }
    catch (error) { return error.message; }
  });
  assert.equal(error, 'zip: Blob entry needs a crc');
});

test('audit UI paints encoding before saving a WAV', async ({ page }, testInfo) => {
  await setup(page, { phraseBars: 1 });
  await page.evaluate(() => {
    window.exportStatuses = [];
    const node = document.querySelector('#export-status');
    new MutationObserver(() => window.exportStatuses.push(node.textContent)).observe(node, { childList: true, subtree: true, characterData: true });
  });
  const pending = page.waitForEvent('download');
  await page.locator('#btn-export-wav').click();
  const download = await pending;
  assert.equal(await download.failure(), null);
  await page.waitForFunction(() => document.querySelector('#export-status').textContent.startsWith('saved '));
  const statuses = await page.evaluate(() => window.exportStatuses);
  console.log('STATUSES', statuses);
  await page.locator('#output-block').screenshot({ path: testInfo.outputPath('encoding-saved.png') });
  assert.ok(statuses.includes('encoding mix…'));
  assert.ok(statuses.findIndex(s => s === 'encoding mix…') < statuses.findIndex(s => s.startsWith('saved ')));
});

test('audit maximum LOOP WAV download is complete', { tag: '@large' }, async ({ page }) => {
  await setup(page, { phraseBars: 32, phrases: 4, bpm: 30 });
  const pending = page.waitForEvent('download');
  await page.locator('#btn-export-wav').click();
  const download = await pending;
  assert.equal(await download.failure(), null);
  const size = (await stat(await download.path())).size;
  console.log('MAX_DOWNLOAD', size);
  assert.equal(size, 294912044);
});
