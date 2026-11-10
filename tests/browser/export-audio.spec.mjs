import assert from 'node:assert/strict';
import { test } from '@playwright/test';
import { setup, assertTiming } from './audio-fixture.mjs';

const phraseLengths = [4, 8, 16, 32];
const phraseCounts = [1, 2, 4];
const tempos = [30, 60, 112, 137.5, 240];

function recordTiming(measurement, { bpm, bars, sampleRate = 48000, tail = false }) {
  const seconds = bars * 4 * 60 / bpm;
  test.info().annotations.push({
    type: 'audio',
    description: JSON.stringify({
      bpm, bars, expectedFrames: tail ? Math.ceil((seconds + 4) * sampleRate) : Math.round(seconds * sampleRate),
      actualFrames: measurement.frames, expectedBeatSpacing: 60 / bpm,
      actualFirstSpacing: measurement.onsets.length > 1 ? measurement.onsets[1] - measurement.onsets[0] : null,
      actualLastOffset: measurement.onsets.at(-1) - measurement.onsets[0],
    }),
  });
}

for (const kind of ['mix WAV', 'one-stem ZIP']) {
  test.describe(`LOOP ${kind} supported length matrix`, () => {
    for (const phraseBars of phraseLengths) {
      for (const phrases of phraseCounts) {
        for (const bpm of tempos) {
          const bars = phraseBars * phrases;
          const tempoLabel = Number.isInteger(bpm) ? `${bpm} BPM` : `fractional BPM ${bpm}`;
          test(`${phraseBars} bars × ${phrases} phrases at ${tempoLabel}`, async ({ page }) => {
            await setup(page, { bpm, phraseBars, phrases });
            const result = await page.evaluate(async (format) => format === 'mix WAV'
              ? window.audioFixture.wav() : window.audioFixture.stems(), kind);
            if (kind === 'mix WAV') {
              assert.equal(result.name, `orbital-${bpm}bpm-${bars}bars-from1-loop.wav`);
              assertTiming(result.measurement, { bpm, bars });
              recordTiming(result.measurement, { bpm, bars });
            } else {
              assert.equal(result.name, `orbital-${bpm}bpm-${bars}bars-from1-stems.zip`);
              assert.deepEqual(result.members.map((member) => member.name), ['Timing 1.wav']);
              for (const member of result.members) {
                assertTiming(member, { bpm, bars });
                recordTiming(member, { bpm, bars });
              }
            }
            assert.equal(await page.evaluate(() => window.MR.exporter.busy), false);
          });
        }
      }
    }
  });
}

for (const bpm of [112, 137.5]) {
  for (const sampleRate of [44100, 48000]) {
    test(`rounding and exclusive trace boundaries at ${bpm} BPM / ${sampleRate} Hz`, async ({ page }) => {
      const bars = 4, beats = bars * 4, seconds = beats * 60 / bpm;
      await setup(page, { bpm });
      const result = await page.evaluate(async ({ bpm, beats, sampleRate }) => {
        const { engine, exporter } = window.MR;
        const raw = await engine.renderOffline({ bpm, beats, tail: 4, sampleRate, trace: true });
        const folded = exporter.foldLoop(raw, raw.loopSeconds);
        return {
          raw: window.audioFixture.measureWav(exporter.encodeWav(raw)),
          folded: window.audioFixture.measureWav(exporter.encodeWav(folded)),
          starts: raw.trace.map((voice) => voice.start),
          loopSeconds: raw.loopSeconds,
        };
      }, { bpm, beats, sampleRate });
      assert.equal(result.raw.frames, Math.ceil((seconds + 4) * sampleRate));
      assertTiming(result.raw, { bpm, bars, sampleRate, tail: true });
      assertTiming(result.folded, { bpm, bars, sampleRate });
      assert.ok(Math.abs(result.loopSeconds - seconds) <= 1 / sampleRate);
      assert.equal(result.starts.length, beats, 'one real scheduled grain per beat, excluding endpoint');
      for (let beat = 0; beat < beats; beat++) {
        assert.ok(Math.abs(result.starts[beat] - beat * 60 / bpm) <= 1 / sampleRate,
          `trace beat ${beat}: expected ${beat * 60 / bpm}s, actual ${result.starts[beat]}s`);
        assert.ok(result.starts[beat] < seconds, 'exclusive endpoint has no grain');
      }
      recordTiming(result.folded, { bpm, bars, sampleRate });
    });
  }
}

for (const bpm of [30, 112, 240]) {
  for (const kind of ['mix', 'two stems']) {
    test(`stopped AS PLAYED ${kind} at ${bpm} BPM retains four-second tail`, async ({ page }) => {
      await setup(page, { bpm, mode: 'tail', audible: 2 });
      assert.equal(await page.evaluate(() => window.MR.engine.playing), false);
      const result = await page.evaluate(async (format) => format === 'mix'
        ? window.audioFixture.wav() : window.audioFixture.stems(), kind);
      if (kind === 'mix') {
        assert.equal(result.name, `orbital-${bpm}bpm-4bars-from1.wav`);
        assertTiming(result.measurement, { bpm, bars: 4, tail: true });
        recordTiming(result.measurement, { bpm, bars: 4, tail: true });
      } else {
        assert.equal(result.name, `orbital-${bpm}bpm-4bars-from1-stems.zip`);
        assert.deepEqual(result.members.map((member) => member.name), ['Timing 1.wav', 'Timing 2.wav']);
        for (const member of result.members) {
          assertTiming(member, { bpm, bars: 4, tail: true });
          recordTiming(member, { bpm, bars: 4, tail: true });
        }
      }
      assert.equal(await page.evaluate(() => window.MR.exporter.busy), false);
    });
  }
}

test('space-enabled LOOP folds the real rendered tail into its exact frame count', async ({ page }) => {
  const bpm = 112, bars = 4;
  await setup(page, { bpm });
  const result = await page.evaluate(async () => {
    const dry = await window.audioFixture.wav();
    window.MR.engine.spaceLevel = 0.65;
    const wet = await window.audioFixture.wav();
    return { dry, wet, busy: window.MR.exporter.busy };
  });
  assertTiming(result.dry.measurement, { bpm, bars });
  assert.equal(result.wet.measurement.frames, Math.round(bars * 4 * 60 / bpm * 48000));
  assert.equal(result.wet.measurement.sampleRate, 48000);
  assert.ok(result.wet.measurement.peak > 1e-5);
  assert.notEqual(result.wet.measurement.pcmHash, result.dry.measurement.pcmHash, 'space changes the actual PCM');
  assert.equal(result.busy, false);
});

for (const selection of ['mute', 'solo']) {
  test(`${selection} selects the correct audible ZIP members with uniform timing`, async ({ page }) => {
    await setup(page, { bpm: 120, audible: 3 });
    const result = await page.evaluate(async (selection) => {
      const { plates } = window.MR.stack;
      if (selection === 'mute') plates[0].mute = true;
      else plates[1].solo = true;
      const result = await window.audioFixture.stems();
      return { ...result, busy: window.MR.exporter.busy };
    }, selection);
    assert.deepEqual(result.members.map((member) => member.name), selection === 'mute'
      ? ['Timing 2.wav', 'Timing 3.wav'] : ['Timing 2.wav']);
    for (const member of result.members) assertTiming(member, { bpm: 120, bars: 4 });
    assert.equal(result.busy, false);
  });
}

test('all-muted mix stays exact and silent; busy clears and a subsequent export succeeds', async ({ page }) => {
  await setup(page, { bpm: 120, audible: 0 });
  const silent = await page.evaluate(async () => {
    const result = await window.audioFixture.wav();
    return { ...result, busy: window.MR.exporter.busy };
  });
  assertTiming(silent.measurement, { bpm: 120, bars: 4, audible: false });
  assert.equal(silent.busy, false);
  const audible = await page.evaluate(async () => {
    window.MR.stack.plates[0].mute = false;
    const result = await window.audioFixture.wav();
    return { ...result, busy: window.MR.exporter.busy };
  });
  assertTiming(audible.measurement, { bpm: 120, bars: 4 });
  assert.equal(audible.busy, false);
});

test('all-muted stems form a valid empty ZIP and the next export can run', async ({ page }) => {
  await setup(page, { bpm: 120, audible: 0 });
  const empty = await page.evaluate(async () => {
    const result = await window.audioFixture.stems();
    return { ...result, busy: window.MR.exporter.busy };
  });
  assert.deepEqual(empty.members, []);
  assert.equal(empty.name, 'orbital-120bpm-4bars-from1-stems.zip');
  assert.equal(empty.busy, false);
  const next = await page.evaluate(async () => {
    window.MR.stack.plates[0].mute = false;
    const result = await window.audioFixture.stems();
    return { ...result, busy: window.MR.exporter.busy };
  });
  assert.deepEqual(next.members.map((member) => member.name), ['Timing 1.wav']);
  assertTiming(next.members[0], { bpm: 120, bars: 4 });
  assert.equal(next.busy, false);
});

test('missing sound sources preserve the defined silent mix duration', async ({ page }) => {
  await setup(page, { bpm: 137.5 });
  const result = await page.evaluate(async () => {
    window.MR.sounds.clearAll();
    const result = await window.audioFixture.wav();
    return { ...result, busy: window.MR.exporter.busy };
  });
  assertTiming(result.measurement, { bpm: 137.5, bars: 4, audible: false });
  assert.equal(result.busy, false);
});
