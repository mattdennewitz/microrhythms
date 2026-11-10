import assert from 'node:assert/strict';

/** Install helpers in a fresh application page, without substituting any audio code. */
export async function setup(page, options = {}) {
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.MR));
  await page.locator('#output-block #btn-export-wav').waitFor();
  await page.evaluate((initialOptions) => {
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    const text = new TextDecoder('utf-8', { fatal: true });
    const crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let bit = 0; bit < 8; bit++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
    function crc32(bytes) {
      let crc = 0xffffffff;
      for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
      return (crc ^ 0xffffffff) >>> 0;
    }
    function measureWav(bytes) {
      check(bytes instanceof Uint8Array, 'WAV input must be Uint8Array');
      check(bytes.length >= 44, 'Truncated WAV');
      const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const label = (offset) => text.decode(bytes.subarray(offset, offset + 4));
      check(label(0) === 'RIFF' && label(8) === 'WAVE', 'Invalid RIFF/WAVE signature');
      check(v.getUint32(4, true) + 8 === bytes.length, 'RIFF size does not match file');
      let fmt = null, data = null, offset = 12;
      while (offset < bytes.length) {
        check(offset + 8 <= bytes.length, 'Truncated RIFF chunk header');
        const name = label(offset), size = v.getUint32(offset + 4, true), start = offset + 8;
        check(start + size + (size & 1) <= bytes.length, `Truncated ${name} chunk`);
        if (name === 'fmt ') {
          check(fmt === null && size >= 16, 'Invalid or duplicate fmt chunk');
          fmt = {
            format: v.getUint16(start, true), channels: v.getUint16(start + 2, true),
            sampleRate: v.getUint32(start + 4, true), byteRate: v.getUint32(start + 8, true),
            blockAlign: v.getUint16(start + 12, true), bits: v.getUint16(start + 14, true),
          };
        } else if (name === 'data') {
          check(data === null, 'Duplicate WAV data');
          data = { start, size };
        }
        offset = start + size + (size & 1);
      }
      check(offset === bytes.length && fmt && data, 'Incomplete WAV chunks');
      check(fmt.format === 1 && fmt.channels === 2 && fmt.bits === 24, 'Expected stereo 24-bit PCM');
      check(fmt.sampleRate > 0 && fmt.blockAlign === 6, 'Invalid PCM layout');
      check(fmt.byteRate === fmt.sampleRate * fmt.blockAlign, 'Invalid PCM byte rate');
      check(data.size % fmt.blockAlign === 0, 'Partial PCM frame');
      const frames = data.size / fmt.blockAlign, onsets = [];
      const mergeFrames = Math.round(fmt.sampleRate * 0.005);
      let firstAudible = -1, lastAudible = -Infinity, peak = 0, hashA = 0x811c9dc5, hashB = 0x9e3779b9;
      for (let frame = 0, pos = data.start; frame < frames; frame++) {
        let amplitude = 0;
        for (let channel = 0; channel < fmt.channels; channel++, pos += 3) {
          let integer = bytes[pos] | (bytes[pos + 1] << 8) | (bytes[pos + 2] << 16);
          if (integer & 0x800000) integer -= 0x1000000;
          const sample = integer / 8388608;
          check(Number.isFinite(sample), 'Non-finite PCM');
          amplitude = Math.max(amplitude, Math.abs(sample));
          hashA = Math.imul(hashA ^ integer, 0x01000193);
          hashB = Math.imul(hashB ^ integer, 0x85ebca6b);
        }
        peak = Math.max(peak, amplitude);
        if (amplitude > 1e-5) {
          if (firstAudible < 0) firstAudible = frame;
          if (frame - lastAudible > mergeFrames) onsets.push(frame / fmt.sampleRate);
          lastAudible = frame;
        }
      }
      // A continuously warmed loop can cut one burst across its file seam.
      // Count that circular burst once, retaining its real late-file onset.
      if (onsets.length > 1 && firstAudible + frames - lastAudible <= mergeFrames) onsets.shift();
      return {
        frames, sampleRate: fmt.sampleRate, channels: fmt.channels, bits: fmt.bits,
        format: fmt.format, blockAlign: fmt.blockAlign, onsets, peak,
        pcmHash: `${(hashA >>> 0).toString(16).padStart(8, '0')}${(hashB >>> 0).toString(16).padStart(8, '0')}`,
      };
    }
    async function measureZip(blob) {
      check(blob instanceof Blob, 'ZIP input must be Blob');
      const bytes = new Uint8Array(await blob.arrayBuffer());
      check(bytes.length >= 22, 'Truncated ZIP');
      const v = new DataView(bytes.buffer), end = bytes.length - 22;
      check(v.getUint32(end, true) === 0x06054b50, 'Invalid ZIP end record');
      check(v.getUint16(end + 4, true) === 0 && v.getUint16(end + 6, true) === 0, 'Multi-disk ZIP');
      const count = v.getUint16(end + 10, true), centralStart = v.getUint32(end + 16, true);
      check(v.getUint16(end + 8, true) === count && v.getUint16(end + 20, true) === 0, 'Invalid ZIP directory counts/comment');
      check(centralStart + v.getUint32(end + 12, true) === end, 'Invalid ZIP directory size');
      let local = 0, central = centralStart;
      const members = [], names = new Set();
      for (let index = 0; index < count; index++) {
        check(local + 30 <= centralStart && central + 46 <= end, 'Truncated ZIP headers');
        check(v.getUint32(local, true) === 0x04034b50 && v.getUint32(central, true) === 0x02014b50, 'Invalid ZIP member signatures');
        check(v.getUint16(local + 6, true) === 0x0800 && v.getUint16(central + 8, true) === 0x0800, 'Expected UTF-8 ZIP names');
        check(v.getUint16(local + 8, true) === 0 && v.getUint16(central + 10, true) === 0, 'ZIP member is not stored');
        check(v.getUint16(central + 34, true) === 0 && v.getUint32(central + 42, true) === local, 'Invalid ZIP member disk/offset');
        const size = v.getUint32(local + 18, true), crc = v.getUint32(local + 14, true);
        check(v.getUint32(local + 22, true) === size && v.getUint32(central + 20, true) === size && v.getUint32(central + 24, true) === size, 'ZIP member sizes disagree');
        check(v.getUint32(central + 16, true) === crc, 'ZIP CRC headers disagree');
        const localNameLength = v.getUint16(local + 26, true), centralNameLength = v.getUint16(central + 28, true);
        const dataStart = local + 30 + localNameLength + v.getUint16(local + 28, true);
        const centralNext = central + 46 + centralNameLength + v.getUint16(central + 30, true) + v.getUint16(central + 32, true);
        check(dataStart + size <= centralStart && centralNext <= end, 'ZIP member exceeds directory');
        const name = text.decode(bytes.subarray(local + 30, local + 30 + localNameLength));
        check(name === text.decode(bytes.subarray(central + 46, central + 46 + centralNameLength)), 'ZIP member names disagree');
        check(!names.has(name), 'Duplicate ZIP member name');
        names.add(name);
        const payload = bytes.subarray(dataStart, dataStart + size);
        check(crc32(payload) === crc, `Invalid ZIP CRC for ${name}`);
        members.push({ name, ...measureWav(payload) });
        local = dataStart + size;
        central = centralNext;
      }
      check(local === centralStart && central === end, 'Unaccounted ZIP bytes');
      return members;
    }
    function configure({ bpm = 120, phraseBars = 4, phrases = 1, mode = 'loop', audible = 1, cycle = 4 } = {}) {
      const { engine, exporter, stack, sounds, flight } = window.MR;
      if (engine.playing) engine.stop();
      check(stack.plates.length === 7, 'Fixture requires the seven real default plates');
      let source = sounds.byName('Timing reference');
      if (!source) {
        const buffer = new AudioBuffer({ length: 4800, sampleRate: 48000, numberOfChannels: 1 });
        const pcm = buffer.getChannelData(0);
        for (let i = 0; i < pcm.length; i++) pcm[i] = 0.2 * Math.sin(2 * Math.PI * 1000 * i / 48000);
        source = sounds.add('Timing reference', buffer);
      }
      flight.on = false;
      stack.breaks = 0;
      stack.phraseBars = phraseBars;
      Object.assign(engine, { evolveAmount: 0, rollSeed: 42, spaceLevel: 0, fxWet: 0, fxOn: false, panModel: 'equalpower', earMode: 'fixed' });
      engine.setBpm(bpm);
      exporter.phrases = phrases;
      exporter.mode = mode;
      stack.plates.forEach((plate, index) => {
        Object.assign(plate, {
          name: `Timing ${index + 1}`, seed: 42, steps: 4, tracks: 1, cycle, dir: 1,
          drift: 0, micro: 0, swing: 0, chance: 1, heads: 1, grainMs: 12,
          spread: 0, transpose: 0, fadeIn: 0, fadeOut: 0.1, choke: false,
          level: audible > 1 ? 0.15 : 0.3, fxDensity: 0, mute: index >= audible, solo: false,
        });
        plate.sourceIds = new Set([source.id]);
        plate.fxOverrides.clear();
        plate.overrides.clear();
        for (let cell = 0; cell < 4; cell++) plate.overrides.set(cell, true);
        plate.generate();
        plate.phiFrozen = plate.phase0;
        plate.startMotion();
      });
      window.MR.app.syncAll();
    }
    async function wav(options = {}) {
      const result = await window.MR.exporter.exportWav({ save: false, ...options });
      check(result !== null, 'WAV export did not complete');
      const measured = { name: result.name, measurement: measureWav(result.wav) };
      return measured;
    }
    async function stems(options = {}) {
      const result = await window.MR.exporter.exportStems({ save: false, ...options });
      check(result !== null, 'Stem export did not complete');
      const measured = { name: result.name, members: await measureZip(result.blob) };
      return measured;
    }
    window.audioFixture = { setup: configure, measureWav, measureZip, wav, stems };
    configure(initialOptions);
  }, options);
}

/** The duration and beat oracle uses test inputs, never exporter preview/plan/trace data. */
export function assertTiming(measurement, { bpm, bars, sampleRate = 48000, tail = false, step = 1, audible = true }) {
  const beats = bars * 4, seconds = beats * 60 / bpm;
  const frames = tail ? Math.ceil((seconds + 4) * sampleRate) : Math.round(seconds * sampleRate);
  assert.equal(measurement.format, 1, 'PCM format');
  assert.equal(measurement.channels, 2, 'stereo channels');
  assert.equal(measurement.sampleRate, sampleRate, 'sample rate');
  assert.equal(measurement.bits, 24, 'PCM bit depth');
  assert.equal(measurement.blockAlign, 6, 'PCM block alignment');
  assert.equal(measurement.frames, frames, `${bpm} BPM / ${bars} bars: expected ${frames} frames, actual ${measurement.frames}`);
  assert.ok(Number.isFinite(measurement.peak), 'finite PCM peak');
  if (!audible) {
    assert.equal(measurement.peak, 0, 'silent PCM');
    assert.deepEqual(measurement.onsets, [], 'no silent onsets');
    return;
  }
  assert.ok(measurement.peak > 1e-5, 'audible PCM');
  const count = Math.ceil(beats / step);
  assert.equal(measurement.onsets.length, count, `expected ${count} PCM bursts, actual ${measurement.onsets.length}`);
  const origin = measurement.onsets[0], tolerance = 128 / sampleRate;
  for (let index = 0; index < count; index++) {
    const expected = index * step * 60 / bpm, actual = measurement.onsets[index] - origin;
    assert.ok(Math.abs(actual - expected) <= tolerance, `PCM beat ${index}: expected ${expected}s, actual ${actual}s (tolerance ${tolerance}s)`);
  }
}
