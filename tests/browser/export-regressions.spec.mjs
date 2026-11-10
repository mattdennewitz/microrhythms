import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { setup, assertTiming } from './audio-fixture.mjs';

const SAMPLE_RATE = 48000;
const QUANTUM = 128 / SAMPLE_RATE;

function assertPcm(measurement, frames) {
  expect(measurement.format).toBe(1);
  expect(measurement.channels).toBe(2);
  expect(measurement.sampleRate).toBe(SAMPLE_RATE);
  expect(measurement.bits).toBe(24);
  expect(measurement.blockAlign).toBe(6);
  expect(measurement.frames).toBe(frames);
  expect(Number.isFinite(measurement.peak)).toBe(true);
  expect(measurement.peak).toBeGreaterThan(1e-5);
}

function assertPlayedHistory(measurement) {
  // Eight beats at 120 BPM, then eight at 60 BPM: 12 musical seconds + 4 s tail.
  assertPcm(measurement, Math.ceil((8 * 60 / 120 + 8 * 60 / 60 + 4) * SAMPLE_RATE));
  const expected = Array.from({ length: 16 }, (_, k) => k < 8 ? k * 0.5 : 4 + (k - 8));
  expect(measurement.onsets).toHaveLength(expected.length);
  const first = measurement.onsets[0];
  expected.forEach((time, k) => {
    expect(Math.abs(measurement.onsets[k] - first - time), `AS PLAYED onset ${k}`).toBeLessThanOrEqual(QUANTUM);
  });
}

async function evidence(testInfo, name, result, expected) {
  await testInfo.attach(name, {
    body: JSON.stringify({ expected, actual: result }, null, 2),
    contentType: 'application/json',
  });
}

async function exportAudio(page, kind) {
  return page.evaluate(async (type) => type === 'mix'
    ? window.audioFixture.wav()
    : window.audioFixture.stems(), kind);
}

function measurements(result, kind) {
  return kind === 'mix' ? [result.measurement] : result.members;
}

for (const mode of ['loop', 'tail']) {
  for (const kind of ['mix', 'stems']) {
    test(`tempo history: ${mode === 'loop' ? 'LOOP ignores' : 'AS PLAYED preserves'} prior tempos in ${kind}`, async ({ page }, testInfo) => {
      await setup(page, { bpm: 60, phraseBars: 4, phrases: 1, mode });
      const names = await page.evaluate(() => {
        const { engine, stack } = window.MR;
        engine.ensureCtx(); // A real initialized AudioContext, without starting a realtime scheduler.
        engine.setBpm(60);
        engine.playing = true;
        engine.clock = [{ t0: 0, b0: 0, bps: 2 }, { t0: 4, b0: 8, bps: 1 }];
        stack.plates.forEach((plate) => plate.startMotion());
        return stack.plates.filter((plate) => !plate.mute).map((plate) => `${plate.name}.wav`);
      });
      const result = await exportAudio(page, kind);
      const expectedFrames = 768000; // LOOP: 16 s; AS PLAYED: 12 musical seconds + 4 s tail.
      await evidence(testInfo, 'tempo-history-pcm', result, {
        frames: expectedFrames, bpm: mode === 'loop' ? 60 : [120, 60], bars: 4,
        onsetSeconds: mode === 'loop' ? 'k' : 'k < 8 ? k / 2 : 4 + k - 8',
      });
      expect(result.name).toBe(`orbital-60bpm-4bars-from1${kind === 'stems' ? '-stems.zip' : mode === 'loop' ? '-loop.wav' : '.wav'}`);
      if (kind === 'stems') expect(result.members.map((member) => member.name)).toEqual(names);
      for (const measurement of measurements(result, kind)) {
        if (mode === 'loop') assertTiming(measurement, { bpm: 60, bars: 4 });
        else assertPlayedHistory(measurement);
      }
      expect(await page.evaluate(() => window.MR.exporter.busy)).toBe(false);
    });
  }
}

for (const [kind, large] of [['mix', false], ['stems', false], ['mix', true], ['stems', true]]) {
  test(`export snapshot: ${kind} retains BPM, length and LOOP mode; next export uses ${large ? '128-bar' : 'short'} edits`, { tag: large ? '@large' : [] }, async ({ page }, testInfo) => {
    await setup(page, { bpm: 120, phraseBars: 4, phrases: 2, mode: 'loop', audible: kind === 'stems' ? 2 : 1 });
    const result = await page.evaluate(async ({ type, large }) => {
      const { engine, stack, exporter } = window.MR;
      const names = stack.plates.filter((plate) => !plate.mute).map((plate) => `${plate.name}.wav`);
      let changed = false;
      const onProgress = (index, _count, _name, fraction) => {
        // The second stem must build its graph only after this mutation.
        if (changed || (type === 'stems' && (index !== 0 || fraction !== 1))) return;
        changed = true;
        engine.setBpm(60);
        stack.phraseBars = large ? 32 : 4;
        exporter.phrases = large ? 4 : 1;
        exporter.mode = 'tail';
      };
      const exported = type === 'mix'
        ? await exporter.exportWav({ save: false, onProgress })
        : await exporter.exportStems({ save: false, onProgress });
      if (!exported) throw new Error('snapshot export unexpectedly refused');
      const measured = type === 'mix'
        ? { name: exported.name, measurement: window.audioFixture.measureWav(exported.wav) }
        : { name: exported.name, members: await window.audioFixture.measureZip(exported.blob) };
      return { ...measured, changed, names, busy: exporter.busy,
        current: { bpm: engine.bpm, phraseBars: stack.phraseBars, phrases: exporter.phrases, mode: exporter.mode } };
    }, { type: kind, large });
    await evidence(testInfo, 'in-flight-export-pcm', result, { bpm: 120, bars: 8, frames: 768000, mode: 'loop' });
    expect(result.changed).toBe(true);
    expect(result.busy).toBe(false);
    expect(result.current).toEqual({ bpm: 60, phraseBars: large ? 32 : 4, phrases: large ? 4 : 1, mode: 'tail' });
    expect(result.name).toBe(`orbital-120bpm-8bars-from1${kind === 'mix' ? '-loop.wav' : '-stems.zip'}`);
    if (kind === 'stems') expect(result.members.map((member) => member.name)).toEqual(result.names);
    for (const measurement of measurements(result, kind)) assertTiming(measurement, { bpm: 120, bars: 8 });

    // Exercise the edited settings with real PCM; the 128-bar variant is opt-in.
    const bars = large ? 128 : 4;
    const next = await exportAudio(page, kind);
    await evidence(testInfo, 'subsequent-export-pcm', next, { bpm: 60, bars, frames: (bars * 4 + 4) * SAMPLE_RATE, tailSeconds: 4 });
    expect(next.name).toBe(`orbital-60bpm-${bars}bars-from1${kind === 'mix' ? '.wav' : '-stems.zip'}`);
    if (kind === 'stems') expect(next.members.map((member) => member.name)).toEqual(result.names);
    for (const measurement of measurements(next, kind)) assertTiming(measurement, { bpm: 60, bars, tail: true });
    expect(await page.evaluate(() => window.MR.exporter.busy)).toBe(false);
  });
}

test('export snapshot: later stem throw delay keeps the captured BPM in actual PCM', async ({ page }, testInfo) => {
  await setup(page, { bpm: 120, phraseBars: 4, phrases: 2, mode: 'loop', audible: 2 });
  await page.evaluate(() => {
    const { engine, stack } = window.MR;
    engine.fxOn = true;
    engine.setFxWet(0.5);
    for (const plate of stack.plates.slice(0, 2)) {
      for (let key = 0; key < 4; key++) plate.fxOverrides.set(key, 'throw');
      plate.assignFx();
    }
  });
  const control = await exportAudio(page, 'stems');
  const edited = await page.evaluate(async () => {
    const { engine, exporter } = window.MR;
    let changed = false;
    const result = await exporter.exportStems({ save: false, onProgress: (index, _count, _name, fraction) => {
      if (!changed && index === 0 && fraction === 1) {
        changed = true;
        engine.setBpm(60);
      }
    } });
    if (!result) throw new Error('throw snapshot export unexpectedly refused');
    const members = await window.audioFixture.measureZip(result.blob);
    return { name: result.name, members, changed, busy: exporter.busy };
  });
  await page.evaluate(() => {
    window.MR.engine.setBpm(120);
    window.MR.engine.fxOn = false;
  });
  const dry = await exportAudio(page, 'stems');
  await evidence(testInfo, 'throw-delay-pcm-comparison', { control, edited, dry }, { bpm: 120, bars: 8, frames: 768000, delaySeconds: 0.375 });
  expect(edited.changed).toBe(true);
  expect(edited.busy).toBe(false);
  expect(control.members).toHaveLength(2);
  expect(edited.members.map((member) => member.name)).toEqual(control.members.map((member) => member.name));
  expect(edited.name).toBe('orbital-120bpm-8bars-from1-stems.zip');
  for (let index = 0; index < 2; index++) {
    assertPcm(control.members[index], 768000);
    assertPcm(edited.members[index], 768000);
    assertTiming(dry.members[index], { bpm: 120, bars: 8 });
    expect(control.members[index].pcmHash).toBeTruthy();
    expect(edited.members[index].pcmHash, `stem ${index + 1}: all parsed PCM samples agree with control`).toEqual(control.members[index].pcmHash);
    expect(control.members[index].pcmHash, `stem ${index + 1}: throw changes audible PCM`).not.toEqual(dry.members[index].pcmHash);
  }
});

for (const transport of ['JSON', 'share']) {
  test(`fractional BPM: ${transport} creation roundtrip restores tempo and actual 16-bar audio`, async ({ page }, testInfo) => {
    await setup(page, { bpm: 137.5, phraseBars: 8, phrases: 2, mode: 'loop' });
    const restored = await page.evaluate(async (format) => {
      const { engine, stack, exporter, project } = window.MR;
      const snapshot = project.serialize();
      const roundtrip = format === 'JSON'
        ? JSON.parse(JSON.stringify(snapshot))
        : await (async () => {
          const { encodeShare, decodeShare } = await import('/src/core/share-codec.ts');
          return decodeShare(await encodeShare(snapshot));
        })();
      engine.setBpm(60);
      stack.phraseBars = 4;
      exporter.phrases = 1;
      exporter.mode = 'tail';
      stack.plates[0].mute = true;
      project.apply(roundtrip);
      return { savedBpm: snapshot.global.bpm, serializedBpm: roundtrip.global.bpm,
        bpm: engine.bpm, phraseBars: stack.phraseBars, phrases: exporter.phrases, mode: exporter.mode,
        plates: stack.plates.length, muted: stack.plates[0].mute };
    }, transport);
    expect(restored).toEqual({ savedBpm: 137.5, serializedBpm: 137.5, bpm: 137.5,
      phraseBars: 8, phrases: 2, mode: 'loop', plates: 7, muted: false });
    const result = await exportAudio(page, 'mix');
    await evidence(testInfo, 'restored-fractional-bpm-pcm', { restored, ...result }, {
      bpm: 137.5, bars: 16, frames: Math.round(16 * 4 * 60 / 137.5 * SAMPLE_RATE), beatSeconds: 60 / 137.5,
    });
    expect(result.name).toBe('orbital-137.5bpm-16bars-from1-loop.wav');
    assertTiming(result.measurement, { bpm: 137.5, bars: 16 });
  });
}

test('fractional BPM: plate cycle doubles grain spacing without changing export bar length', async ({ page }, testInfo) => {
  await setup(page, { bpm: 137.5, phraseBars: 4, phrases: 1, mode: 'loop', cycle: 4 });
  const original = await exportAudio(page, 'mix');
  await page.evaluate(() => {
    const plate = window.MR.stack.plates[0];
    plate.cycle = 8;
    plate.generate();
    plate.phiFrozen = plate.phase0;
    plate.startMotion();
  });
  const doubled = await exportAudio(page, 'mix');
  await evidence(testInfo, 'cycle-independent-bar-length', { original, doubled }, {
    bpm: 137.5, bars: 4, frames: Math.round(16 * 60 / 137.5 * SAMPLE_RATE), stepsInBeats: [1, 2],
  });
  assertTiming(original.measurement, { bpm: 137.5, bars: 4 });
  assertTiming(doubled.measurement, { bpm: 137.5, bars: 4, step: 2 });
  expect(doubled.name).toBe(original.name);
  expect(doubled.measurement.frames).toBe(original.measurement.frames);
});

async function measureDownload(page, download, testInfo, kind, artifactName) {
  expect(await download.failure()).toBeNull();
  const path = testInfo.outputPath(artifactName);
  await download.saveAs(path);
  const encoded = (await readFile(path)).toString('base64');
  const result = await page.evaluate(async ({ base64, type }) => {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    return type === 'mix' ? { measurement: window.audioFixture.measureWav(bytes) }
      : { members: await window.audioFixture.measureZip(new Blob([bytes])) };
  }, { base64: encoded, type: kind });
  return { name: download.suggestedFilename(), ...result };
}

async function clickDownload(page, selector) {
  const pending = page.waitForEvent('download', { timeout: 600000 });
  await page.locator(selector).click();
  const download = await pending;
  await expect(page.locator('#output-block')).not.toHaveAttribute('aria-busy', 'true', { timeout: 600000 });
  return download;
}

test('tempo history: actual UI WAV/ZIP downloads and PLAY tempo change honor LOOP controls', async ({ page }, testInfo) => {
  await setup(page, { bpm: 112, phraseBars: 8, phrases: 1, mode: 'tail' });
  try {
    // Keyboard events exercise the mounted React controls, including phrase index -> bars mapping.
    await page.locator('#sl-phrase').focus();
    await page.locator('#sl-phrase').press('Home');
    for (let step = 0; step < 8; step++) await page.locator('#sl-bpm').press('ArrowRight');
    await page.locator('#len-row').getByRole('button', { name: '2 PHRASES', exact: true }).click();
    const loop = page.locator('#loop-row').getByRole('button', { name: 'LOOP', exact: true });
    await loop.click();
    await expect(loop).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#sl-phrase')).toHaveAttribute('aria-valuetext', '4 BARS');
    await expect(page.locator('#sl-bpm')).toHaveAttribute('aria-valuetext', '120 BPM');

    const mix = await measureDownload(page, await clickDownload(page, '#btn-export-wav'), testInfo, 'mix', 'ui-120bpm-loop.wav');
    const stems = await measureDownload(page, await clickDownload(page, '#btn-export-stems'), testInfo, 'stems', 'ui-120bpm-stems.zip');
    await evidence(testInfo, 'ui-initial-download-pcm', { mix, stems }, { bpm: 120, bars: 8, frames: 768000 });
    expect(mix.name).toBe('orbital-120bpm-8bars-from1-loop.wav');
    expect(stems.name).toBe('orbital-120bpm-8bars-from1-stems.zip');
    expect(stems.members).toHaveLength(1);
    assertTiming(mix.measurement, { bpm: 120, bars: 8 });
    for (const member of stems.members) assertTiming(member, { bpm: 120, bars: 8 });

    await page.locator('#btn-play').click();
    await expect(page.locator('#btn-play')).toHaveAttribute('aria-pressed', 'true');
    await page.waitForFunction(() => window.MR.engine.ctx.currentTime > window.MR.engine.clock[0].t0 + 0.25);
    for (let step = 0; step < 60; step++) await page.locator('#sl-bpm').press('ArrowLeft');
    const played = await page.evaluate(() => ({ bpm: window.MR.engine.bpm,
      playing: window.MR.engine.playing, tempos: window.MR.engine.clock.map((segment) => segment.bps * 60) }));
    expect(played.bpm).toBe(60);
    expect(played.playing).toBe(true);
    expect(played.tempos.length).toBeGreaterThan(1);
    expect(played.tempos[0]).toBe(120);
    expect(played.tempos.at(-1)).toBe(60);
    const changed = await measureDownload(page, await clickDownload(page, '#btn-export-wav'), testInfo, 'mix', 'ui-after-play-tempo-change.wav');
    await evidence(testInfo, 'ui-live-tempo-change-pcm', { played, ...changed }, { bpm: 60, bars: 8, frames: 1536000, beatSeconds: 1 });
    expect(changed.name).toBe('orbital-60bpm-8bars-from1-loop.wav');
    assertTiming(changed.measurement, { bpm: 60, bars: 8 });
    await page.locator('#btn-play').click();
    await expect(page.locator('#btn-play')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#export-status')).toContainText('saved orbital-60bpm-8bars-from1-loop.wav');
    expect(await page.evaluate(() => window.MR.exporter.busy)).toBe(false);
  } finally {
    const output = page.locator('#output-block');
    await output.scrollIntoViewIfNeeded();
    await output.screenshot({ path: testInfo.outputPath('output-controls-status.png') });
    await testInfo.attach('output-controls-status', { path: testInfo.outputPath('output-controls-status.png'), contentType: 'image/png' });
    await page.close();
  }
});

for (const playing of [false, true]) {
  test(`current plate phase: ${playing ? 'playing active speed ignores historical and future segments' : 'stopped displayed phase'} has independent PCM onset timing`, async ({ page }, testInfo) => {
    await setup(page, { bpm: 120 });
    const result = await page.evaluate(async (playing) => {
      const { engine, stack } = window.MR;
      const control = await window.audioFixture.wav();
      const p = stack.plates[0], w = p.omega();
      if (playing) {
        const ctx = engine.ensureCtx();
        if (ctx.state !== 'suspended') await ctx.suspend();
        engine.playing = true;
        // The real display clock now reads precisely beat 2.25. No timer or audio stub.
        engine.clock = [{ t0: engine.visualTime() - 2.25 * 0.5, b0: 0, bps: 2 }];
        p.motion = [
          { b0: 0, phi0: p.phase0, w },
          { b0: 2, phi0: p.phase0 + w * 2, w: 2 * w },
          { b0: 4, phi0: p.phase0 + w * 6, w: w / 2 },
        ];
      } else p.phiFrozen = p.phase0 + w * 0.25;
      const shifted = await window.audioFixture.wav();
      return { control, shifted };
    }, playing);
    const step = playing ? 0.5 : 1, onsetShift = playing ? 0.125 : 0.375;
    await evidence(testInfo, 'current-phase-onset-pcm', result, {
      frames: 384000, firstOnsetShiftSeconds: onsetShift,
      beatSpacingSeconds: step * 0.5, bursts: playing ? 32 : 16,
    });
    assertTiming(result.control.measurement, { bpm: 120, bars: 4 });
    assertTiming(result.shifted.measurement, { bpm: 120, bars: 4, step });
    const actual = result.shifted.measurement.onsets[0] - result.control.measurement.onsets[0];
    expect(Math.abs(actual - onsetShift), 'first PCM onset follows the current displayed phase').toBeLessThanOrEqual(QUANTUM);
  });
}
