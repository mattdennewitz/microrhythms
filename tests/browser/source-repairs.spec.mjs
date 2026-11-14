import assert from 'node:assert/strict';
import { test } from '@playwright/test';
import { setup } from './audio-fixture.mjs';

for (const dc of [0, 0.1]) {
  test(`native stereo import recovers opposite-phase audio with DC ${dc}`, async ({ page }) => {
    await setup(page);
    const result = await page.evaluate(dc => {
      const { sounds } = window.MR;
      const input = new AudioBuffer({ length: 44100, sampleRate: 44100, numberOfChannels: 2 });
      const left = input.getChannelData(0), right = input.getChannelData(1);
      for (let i = 0; i < input.length; i++) {
        const signal = 0.2 * Math.sin(2 * Math.PI * 440 * i / input.sampleRate);
        left[i] = dc + signal;
        right[i] = dc - signal;
      }
      const originalLeft = left.slice(), originalRight = right.slice();
      const sound = sounds.addUser(`Native anti-phase ${dc}`, input);
      try {
        const data = sound.buffer.getChannelData(0);
        let peak = 0, energy = 0, mean = 0;
        for (const value of data) {
          peak = Math.max(peak, Math.abs(value));
          energy += value * value;
          mean += value;
        }
        return {
          native: sound.buffer instanceof AudioBuffer,
          channels: sound.buffer.numberOfChannels, sampleRate: sound.buffer.sampleRate,
          peak, rms: Math.sqrt(energy / data.length), mean: mean / data.length,
          unchanged: left.every((value, i) => value === originalLeft[i])
            && right.every((value, i) => value === originalRight[i]),
        };
      } finally { sounds.remove(sound.id); }
    }, dc);
    assert.equal(result.native, true);
    assert.equal(result.channels, 1);
    assert.equal(result.sampleRate, 44100);
    assert.ok(result.peak >= 0.9 && result.peak <= 0.921);
    assert.ok(result.rms > 0.6);
    assert.ok(Math.abs(result.mean) < 1e-5);
    assert.equal(result.unchanged, true);
  });
}

test('native ordinary stereo preserves its mix rather than selecting one channel', async ({ page }) => {
  await setup(page);
  const result = await page.evaluate(() => {
    const { sounds } = window.MR;
    const input = new AudioBuffer({ length: 48000, sampleRate: 48000, numberOfChannels: 2 });
    const reference = new AudioBuffer({ length: input.length, sampleRate: input.sampleRate, numberOfChannels: 1 });
    const left = input.getChannelData(0), right = input.getChannelData(1), mix = reference.getChannelData(0);
    for (let i = 0; i < input.length; i++) {
      left[i] = 0.1 + 0.2 * Math.sin(2 * Math.PI * 440 * i / input.sampleRate);
      right[i] = -0.05 + 0.1 * Math.cos(2 * Math.PI * 660 * i / input.sampleRate);
      mix[i] = (left[i] + right[i]) / 2;
    }
    const stereo = sounds.condition(input), mono = sounds.condition(reference);
    let maxError = 0;
    for (let i = 0; i < stereo.length; i++) {
      maxError = Math.max(maxError, Math.abs(stereo.getChannelData(0)[i] - mono.getChannelData(0)[i]));
    }
    return { stereoLength: stereo.length, monoLength: mono.length, sampleRate: stereo.sampleRate, maxError };
  });
  assert.equal(result.stereoLength, result.monoLength);
  assert.equal(result.sampleRate, 48000);
  assert.ok(result.maxError < 1e-6);
});

test('native DC-only and sub-threshold inputs stay rejected after cancellation recovery', async ({ page }) => {
  await setup(page);
  const errors = await page.evaluate(() => {
    const { sounds } = window.MR;
    return [[0.1, 0.1], [0.1, -0.2], [0.1], [0]].map(offsets => {
      const input = new AudioBuffer({ length: 24000, sampleRate: 24000, numberOfChannels: offsets.length });
      offsets.forEach((offset, channel) => input.getChannelData(channel).fill(offset));
      try { sounds.condition(input); return null; } catch (error) { return error.message; }
    }).concat([0.0009, 0.0011].map(amplitude => {
      const input = new AudioBuffer({ length: 24000, sampleRate: 24000, numberOfChannels: 1 });
      const data = input.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = 0.1 + amplitude * Math.sin(2 * Math.PI * 440 * i / input.sampleRate);
      try { sounds.condition(input); return null; } catch (error) { return error.message; }
    }));
  });
  for (const error of errors.slice(0, 5)) assert.match(error, /silent or too short/);
  assert.equal(errors[5], null, 'above-threshold mono must remain accepted');
});

for (const sampleRate of [44100, 96000]) {
  test(`native ${sampleRate} Hz import exports near-end reverse at 48 kHz without pitch or duration drift`, async ({ page }) => {
    await setup(page, { bpm: 123.45, audible: 1, phraseBars: 1 });
    const result = await page.evaluate(async sampleRate => {
      const { sounds, stack, engine, exporter } = window.MR;
      const input = new AudioBuffer({ length: sampleRate, sampleRate, numberOfChannels: 1 });
      const data = input.getChannelData(0);
      // Distinct source regions expose reverse-offset mistakes independently of traces.
      for (let i = 0; i < data.length; i++) {
        const hz = i < 0.8 * sampleRate ? 400 : 1200;
        data[i] = 0.2 * Math.sin(2 * Math.PI * hz * i / sampleRate);
      }
      const sound = sounds.addUser(`Native rate ${sampleRate}`, input);
      try {
        const plate = stack.plates[0];
        plate.sourceIds = new Set([sound.id]);
        Object.assign(plate, { grainMs: 100, cut: 'overlap', fadeIn: 0.05, fadeOut: 0.05 });
        engine.fxOn = true;
        for (const chip of plate.chips) {
          Object.assign(chip, { uDur: 0.5, trackOff: 0.99, uOff: 0.5, fx: 'reverse' });
          plate.fxOverrides.set(chip.key, 'reverse');
        }
        const exported = await exporter.exportWav({ save: false });
        if (!exported) throw new Error('native-rate WAV export failed');
        const measured = window.audioFixture.measureWav(exported.wav);
        const wav = new DataView(exported.wav.buffer, exported.wav.byteOffset, exported.wav.byteLength);
        const pcm = new Float64Array(measured.frames);
        let peak = 0;
        for (let i = 0; i < pcm.length; i++) {
          const offset = 44 + i * 6;
          let value = wav.getUint8(offset) | wav.getUint8(offset + 1) << 8 | wav.getUint8(offset + 2) << 16;
          if (value & 0x800000) value -= 0x1000000;
          pcm[i] = value / 8388608;
          peak = Math.max(peak, Math.abs(pcm[i]));
        }
        // Find an interior burst, leaving any warmed seam fragment out of the measurement.
        const threshold = peak * 0.02, gap = 0.02 * 48000;
        let start = -1, end = -1, last = -gap;
        for (let i = Math.round(0.2 * 48000); i < pcm.length; i++) {
          if (Math.abs(pcm[i]) <= threshold) continue;
          if (start < 0) start = i;
          else if (i - last > gap) { end = last; break; }
          last = i;
        }
        if (end < 0) end = last;
        if (start < 0 || end <= start) throw new Error('no audible interior source burst');
        const strength = hz => {
          let re = 0, im = 0;
          for (let i = start; i <= end; i++) {
            const angle = 2 * Math.PI * hz * i / 48000;
            re += pcm[i] * Math.cos(angle); im += pcm[i] * Math.sin(angle);
          }
          return Math.hypot(re, im);
        };
        return {
          sourceRate: sound.buffer.sampleRate, sourceDuration: sound.buffer.duration,
          outputRate: measured.sampleRate, duration: (end - start + 1) / 48000,
          expectedTone: strength(1200), wrongRegion: strength(400),
          slowResample: strength(1200 * sampleRate / 48000),
        };
      } finally { sounds.remove(sound.id); }
    }, sampleRate);
    assert.equal(result.sourceRate, sampleRate);
    assert.ok(Math.abs(result.sourceDuration - 1) < 1 / sampleRate);
    assert.equal(result.outputRate, 48000);
    assert.ok(Math.abs(result.duration - 0.1) < 0.01, `grain duration ${result.duration}`);
    assert.ok(result.expectedTone > 10 * result.wrongRegion, 'reverse must read the late 1200 Hz region');
    assert.ok(result.expectedTone > 5 * result.slowResample, 'native source rate must not shift output pitch');
  });
}
