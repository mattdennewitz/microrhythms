import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from '@playwright/test';
import { setup } from './audio-fixture.mjs';

// Source identity is measured from decoded PCM, independently of export plans,
// traces, filenames and hashes. Location A emits 400 Hz; location B emits 1400 Hz.
async function spatialFixture(page, { autopilot = false, playing = false } = {}) {
  await setup(page, { bpm: 120, audible: 2 });
  return page.evaluate(async ({ autopilot, playing }) => {
    const { engine, stack, sounds, flight, view } = window.MR;
    for (const [index, hz] of [400, 1400].entries()) {
      const buffer = new AudioBuffer({ length: 48000, sampleRate: 48000, numberOfChannels: 1 });
      const data = buffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = 0.2 * Math.sin(2 * Math.PI * hz * i / 48000);
      const source = sounds.add(`Location ${index ? 'B' : 'A'} ${hz} Hz`, buffer);
      const p = stack.plates[index];
      Object.assign(p, { x: index ? 3 : -3, rIn: 0.65, rOut: 0.75, grainMs: 120, cut: 'overlap' });
      p.sourceIds = new Set([source.id]);
      p.generate(); p.phiFrozen = p.phase0; p.startMotion();
    }
    Object.assign(flight, { on: true, autopilot, headMix: 1, sensorGain: 0, R: 0.12,
      falloff: 0.15, useChance: false, vel: [0, 0, 0], yaw: 0, pitch: 0,
      lookYaw: 0, lookPitch: 0, fwdSmooth: [1, 0, 0], blend: null, prevAp: null });
    flight.keys.clear();
    if (playing) {
      const ctx = engine.ensureCtx(); // Real suspended clock, no scheduler stub.
      if (ctx.state !== 'suspended') await ctx.suspend();
      engine.playing = true;
      engine.clock = [{ t0: engine.ctx.currentTime, b0: 0, bps: 2 }];
    }
    const tauAt = (index) => {
      const [lo, hi] = flight.span();
      return flight.PERIOD / (2 * Math.PI) * Math.acos(1 - 2 * (view.plateX(stack.plates[index]) - lo) / (hi - lo));
    };
    const move = (index) => {
      const t = flight.clock(), tau = tauAt(index);
      flight.ap = { t0: t, tau0: tau, speed: 0 };
      flight.lastTau = tau;
      const p = stack.plates[index], radius = p.chips[0].radius;
      flight.pos = autopilot ? flight.pathAtTau(tau)
        : [view.plateX(p), radius * Math.sin(stack.HEAD), -radius * Math.cos(stack.HEAD)];
      flight.vel.fill(0); flight.tNow = t;
      return flight.pos.slice();
    };
    const positionA = move(0);
    flight.histStart();
    if (playing) {
      const t = engine.timeAtBeat(0), pose = flight.pose();
      // A genuine recorded performance fixture, held at A for the requested window.
      flight.knots = [{ t, pos: positionA.slice() }, { t: t + 12, pos: positionA.slice() }];
      flight.track = [{ t, pos: positionA.slice(), fwd: pose.fwd.slice(), up: pose.up.slice() },
        { t: t + 12, pos: positionA.slice(), fwd: pose.fwd.slice(), up: pose.up.slice() }];
    }
    function identify(bytes) {
      const measurement = window.audioFixture.measureWav(bytes);
      const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      let offset = 12, start = 0, length = 0;
      while (offset < bytes.length) {
        const size = v.getUint32(offset + 4, true);
        if (String.fromCharCode(...bytes.subarray(offset, offset + 4)) === 'data') { start = offset + 8; length = size / 6; break; }
        offset += 8 + size + (size & 1);
      }
      const energy = [0, 0], channels = [0, 0];
      // Blockwise quadrature avoids cancellation from independently cut sine phases.
      for (let base = 0; base < length; base += 480) {
        const re = [0, 0], im = [0, 0];
        for (let i = 0; i < Math.min(480, length - base); i++) {
          let mono = 0;
          for (let ch = 0; ch < 2; ch++) {
            const at = start + (base + i) * 6 + ch * 3;
            let n = bytes[at] | bytes[at + 1] << 8 | bytes[at + 2] << 16;
            if (n & 0x800000) n -= 0x1000000;
            const sample = n / 8388608;
            channels[ch] += sample * sample; mono += sample;
          }
          for (let f = 0; f < 2; f++) {
            const angle = 2 * Math.PI * [400, 1400][f] * i / measurement.sampleRate;
            re[f] += mono * Math.cos(angle); im[f] += mono * Math.sin(angle);
          }
        }
        for (let f = 0; f < 2; f++) energy[f] += re[f] ** 2 + im[f] ** 2;
      }
      return { ...measurement, sourceEnergy: energy, channelEnergy: channels };
    }
    async function capture(kind, options = {}) {
      const result = kind === 'mix' ? await window.MR.exporter.exportWav({ save: false, ...options })
        : await window.MR.exporter.exportStems({ save: false, ...options });
      if (!result) throw new Error('Export refused');
      let pcm;
      if (kind === 'mix') pcm = [identify(result.wav)];
      else {
        // Validate the complete real ZIP/CRC first; then identify its stored PCM members.
        const measured = await window.audioFixture.measureZip(result.blob);
        const bytes = new Uint8Array(await result.blob.arrayBuffer()), v = new DataView(bytes.buffer);
        let offset = 0;
        pcm = measured.map((member) => {
          const size = v.getUint32(offset + 18, true);
          const start = offset + 30 + v.getUint16(offset + 26, true) + v.getUint16(offset + 28, true);
          const identified = { name: member.name, ...identify(bytes.subarray(start, start + size)) };
          offset = start + size;
          return identified;
        });
      }
      return { name: result.name, pcm };
    }
    window.positionFixture = { move, identify, capture };
    window.MR.app.syncAll();
    return { positionA, names: stack.plates.slice(0, 2).map((p) => `${p.name}.wav`) };
  }, { autopilot, playing });
}

function assertSource(result, location, kind, { tail = false } = {}) {
  const index = location === 'A' ? 0 : 1;
  assert.equal(result.pcm.length, kind === 'mix' ? 1 : 2);
  for (const m of result.pcm) assert.equal(m.frames, tail ? 576000 : 384000, 'exact four bars at 120 BPM plus AS PLAYED tail only');
  const audible = result.pcm[kind === 'mix' ? 0 : index];
  assert.ok(audible.peak > 1e-5, `${location} is audible`);
  assert.ok(audible.sourceEnergy[index] > 20 * audible.sourceEnergy[1 - index],
    `${location} must contain ${index ? 1400 : 400} Hz source, measured energies ${audible.sourceEnergy}`);
  if (kind === 'stems') assert.equal(result.pcm[1 - index].peak, 0, 'out-of-range plate is silent, not previous location');
}

async function attach(info, name, data) {
  await info.attach(name, { body: JSON.stringify(data, null, 2), contentType: 'application/json' });
}

for (const autopilot of [false, true]) {
  for (const playing of [false, true]) {
    for (const kind of ['mix', 'stems']) {
      const tag = (!autopilot && playing && kind === 'mix') || (autopilot && !playing && kind === 'stems') ? [] : ['@extended'];
      test(`fresh current position: ${autopilot ? 'autopilot' : 'manual'} ${playing ? 'playing' : 'stopped'} A then B ${kind} identifies the NEW source`, { tag }, async ({ page }, info) => {
        const fixture = await spatialFixture(page, { autopilot, playing });
        const a = await page.evaluate((kind) => window.positionFixture.capture(kind), kind);
        const positionB = await page.evaluate(() => window.positionFixture.move(1));
        const b = await page.evaluate((kind) => window.positionFixture.capture(kind), kind);
        await attach(info, 'independent-location-source-pcm', { fixture, positionB, a, b,
          oracle: { A: '400 Hz', B: '1400 Hz', frames: 384000, dominantEnergyRatio: 20 } });
        assertSource(a, 'A', kind);
        assertSource(b, 'B', kind);
        if (kind === 'stems') assert.deepEqual(b.pcm.map((m) => m.name), fixture.names);
      });
    }
  }
}

for (const autopilot of [false, true]) {
  for (const playing of [false, true]) {
    for (const kind of ['mix', 'stems']) {
      const tag = (!autopilot && playing && kind === 'mix') || (autopilot && !playing && kind === 'stems') ? [] : ['@extended'];
      test(`moving current pose: ${autopilot ? 'autopilot' : 'manual'} ${playing ? 'playing' : 'stopped'} ${kind} does not continue the route or coast`, { tag }, async ({ page }, info) => {
        await spatialFixture(page, { autopilot, playing });
        const result = await page.evaluate(async ({ autopilot, kind }) => {
          const { flight } = window.MR;
          const control = await window.positionFixture.capture(kind);
          // Start moving immediately before click. The click's current position
          // remains A; only a performance renderer should extrapolate this motion.
          if (autopilot) flight.ap.speed = 3;
          else flight.vel.splice(0, 3, 1, 0, 0);
          const captured = await window.positionFixture.capture(kind);
          return { control, captured };
        }, { autopilot, kind });
        await attach(info, 'stationary-versus-moving-current-pcm', result);
        assertSource(result.captured, 'A', kind);
        result.control.pcm.forEach((m, i) => {
          assert.equal(result.captured.pcm[i].pcmHash, m.pcmHash, 'same current pose produces the same loop regardless of live velocity');
        });
      });
    }
  }
}

for (const autopilot of [false, true]) {
  for (const kind of ['mix', 'stems']) {
    const tag = autopilot === (kind === 'stems') ? [] : ['@extended'];
    test(`current pose snapshot: ${autopilot ? 'autopilot' : 'manual'} ${kind} freezes movement, orientation, proximity and sensor edits`, { tag }, async ({ page }, info) => {
      await spatialFixture(page, { autopilot, playing: true });
      const result = await page.evaluate(async (kind) => {
        const { flight, exporter } = window.MR;
        const control = await window.positionFixture.capture(kind);
        let changed = false;
        const captured = await window.positionFixture.capture(kind, { onProgress: (index, _count, _name, fraction) => {
          if (changed || (kind === 'stems' && (index !== 0 || fraction !== 1))) return;
          changed = true;
          const capturedPosition = flight.pos;
          const next = window.positionFixture.move(1);
          // Mutate original arrays as well as scalars: closures must not retain live references.
          capturedPosition.splice(0, 3, ...next);
          flight.pos = capturedPosition;
          flight.fwdSmooth.splice(0, 3, 0, 0, -1);
          flight.yaw = -Math.PI / 2; flight.pitch = 0.2;
          flight.lookYaw = 0.7; flight.lookPitch = 0.2;
          flight.falloff = 0.3; flight.R = 0.6;
          flight.sensorGain = 0.8; flight.headMix = 0.2; flight.useChance = true;
        } });
        const next = await window.positionFixture.capture(kind);
        return { control, captured, next, changed, busy: exporter.busy };
      }, kind);
      await attach(info, 'captured-versus-next-position-pcm', result);
      assert.equal(result.changed, true);
      assert.equal(result.busy, false);
      assertSource(result.control, 'A', kind);
      assertSource(result.captured, 'A', kind);
      assertSource(result.next, 'B', kind);
      result.control.pcm.forEach((m, index) => {
        assert.equal(result.captured.pcm[index].pcmHash, m.pcmHash, 'every captured PCM sample matches unchanged control');
        assert.deepEqual(result.captured.pcm[index].sourceEnergy, m.sourceEnergy);
      });
    });
  }
}

test('current orientation and proximity have independent stereo/energy PCM evidence', async ({ page }, info) => {
  await spatialFixture(page);
  const result = await page.evaluate(async () => {
    const { flight } = window.MR;
    flight.pos[0] -= 0.1;
    flight.yaw = -Math.PI / 2;
    const right = await window.positionFixture.capture('mix');
    flight.yaw = Math.PI / 2;
    const left = await window.positionFixture.capture('mix');
    flight.falloff = 0.05;
    const narrow = await window.positionFixture.capture('mix');
    flight.falloff = 0.4;
    const wide = await window.positionFixture.capture('mix');
    return { right, left, narrow, wide };
  });
  await attach(info, 'orientation-proximity-pcm', result);
  const right = result.right.pcm[0].channelEnergy, left = result.left.pcm[0].channelEnergy;
  assert.ok(right[1] > 4 * right[0], `source on ship's right: ${right}`);
  assert.ok(left[0] > 4 * left[1], `turnaround puts source on ship's left: ${left}`);
  assert.ok(result.wide.pcm[0].sourceEnergy[0] > 10 * result.narrow.pcm[0].sourceEnergy[0],
    'larger proximity radius audibly increases the same identified source');
  for (const exported of Object.values(result)) assertSource(exported, 'A', 'mix');
});

test('current sensor radius and gain select audible PCM rather than retained flight settings', async ({ page }, info) => {
  await spatialFixture(page);
  const result = await page.evaluate(async () => {
    const { flight, stack } = window.MR;
    flight.headMix = 0; flight.sensorGain = 1;
    flight.pos[1] += 0.2 * Math.sin(stack.HEAD);
    flight.pos[2] -= 0.2 * Math.cos(stack.HEAD);
    flight.R = 0.1;
    const outside = await window.positionFixture.capture('mix');
    flight.R = 0.4;
    const inside = await window.positionFixture.capture('mix');
    flight.sensorGain = 0;
    const off = await window.positionFixture.capture('mix');
    return { outside, inside, off };
  });
  await attach(info, 'sensor-selection-pcm', result);
  assert.equal(result.outside.pcm[0].peak, 0);
  assertSource(result.inside, 'A', 'mix');
  assert.equal(result.off.pcm[0].peak, 0);
  for (const exported of Object.values(result)) assert.equal(exported.pcm[0].frames, 384000);
});

for (const kind of ['mix', 'stems']) {
  test(`AS PLAYED intentionally preserves A history after ship moves to B in ${kind}`, async ({ page }, info) => {
    await spatialFixture(page, { playing: true });
    const result = await page.evaluate(async (kind) => {
      window.positionFixture.move(1);
      const loop = await window.positionFixture.capture(kind);
      window.MR.exporter.mode = 'tail';
      const played = await window.positionFixture.capture(kind);
      return { loop, played };
    }, kind);
    await attach(info, 'current-loop-versus-played-history-pcm', result);
    assertSource(result.loop, 'B', kind);
    assertSource(result.played, 'A', kind, { tail: true });
  });
}

async function downloaded(page, info, kind, name) {
  const pending = page.waitForEvent('download', { timeout: 600000 });
  await page.locator(kind === 'mix' ? '#btn-export-wav' : '#btn-export-stems').click();
  const download = await pending;
  assert.equal(await download.failure(), null);
  const path = info.outputPath(name);
  await download.saveAs(path);
  const encoded = (await readFile(path)).toString('base64');
  const result = await page.evaluate(async ({ encoded, kind }) => {
    const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
    if (kind === 'mix') return { pcm: [window.positionFixture.identify(bytes)] };
    const measured = await window.audioFixture.measureZip(new Blob([bytes]));
    const v = new DataView(bytes.buffer);
    let offset = 0;
    return { pcm: measured.map((member) => {
      const size = v.getUint32(offset + 18, true);
      const start = offset + 30 + v.getUint16(offset + 26, true) + v.getUint16(offset + 28, true);
      const result = { name: member.name, ...window.positionFixture.identify(bytes.subarray(start, start + size)) };
      offset = start + size;
      return result;
    }) };
  }, { encoded, kind });
  await page.waitForFunction(() => !window.MR.exporter.busy);
  return { name: download.suggestedFilename(), ...result };
}

test('actual PLAY and keyboard forward flight downloads the new B loop and stems', async ({ page }, info) => {
  await spatialFixture(page);
  try {
    await page.locator('#btn-play').click();
    await page.waitForFunction(() => window.MR.engine.playing && window.MR.engine.songBeat(window.MR.engine.visualTime()) > 0);
    const a = await downloaded(page, info, 'mix', 'keyboard-location-A.wav');
    assertSource(a, 'A', 'mix');
    const target = await page.evaluate(() => {
      const { stack, view, flight } = window.MR;
      flight.thrust = 1; flight.yaw = 0; flight.pitch = 0;
      return view.plateX(stack.plates[1]);
    });
    // Real global key handlers and per-frame physics, not setting B's position.
    await page.locator('#dock-fly').focus();
    await page.keyboard.down('w');
    await page.waitForFunction((x) => window.MR.flight.pos[0] >= x - 0.13, target, { timeout: 30000 });
    await page.keyboard.up('w');
    await page.keyboard.down('x');
    await page.waitForFunction(() => window.MR.flight.speed() < 0.005, null, { timeout: 10000 });
    await page.keyboard.up('x');
    const pose = await page.evaluate(() => ({ pos: window.MR.flight.pos.slice(), playing: window.MR.engine.playing,
      manual: !window.MR.flight.autopilot }));
    assert.equal(pose.playing, true); assert.equal(pose.manual, true);
    assert.ok(Math.abs(pose.pos[0] - target) < 0.15, 'keyboard flight reaches independent B plate coordinate');
    const b = await downloaded(page, info, 'mix', 'keyboard-location-B.wav');
    const stems = await downloaded(page, info, 'stems', 'keyboard-location-B-stems.zip');
    await attach(info, 'keyboard-flight-download-pcm', { target, pose, a, b, stems });
    assertSource(b, 'B', 'mix');
    assertSource(stems, 'B', 'stems');
  } finally {
    await page.keyboard.up('w'); await page.keyboard.up('x');
    await page.evaluate(() => { if (window.MR.engine.playing) window.MR.engine.stop(); });
    await page.locator('#output-block').scrollIntoViewIfNeeded();
    const screenshot = info.outputPath('keyboard-flight-output.png');
    await page.locator('#output-block').screenshot({ path: screenshot });
    await info.attach('keyboard-flight-output', { path: screenshot, contentType: 'image/png' });
    await page.close();
  }
});
