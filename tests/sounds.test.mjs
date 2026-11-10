import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sounds } from '../src/core/sounds.ts';
import { installAudioBuffer, TestAudioBuffer } from './audio-buffer.mjs';

function sine(seconds, opposite = false) {
  const buffer = new TestAudioBuffer({ length: seconds * 48000, sampleRate: 48000, numberOfChannels: 2 });
  for (let i = 0; i < buffer.length; i++) {
    const s = 0.5 * Math.sin(2 * Math.PI * 440 * i / 48000);
    buffer.channels[0][i] = s; buffer.channels[1][i] = opposite ? -s : s;
  }
  return buffer;
}

test('opposite-phase stereo retains audible audio', t => {
  installAudioBuffer(t);
  const snd = sounds.addUser('Opposite phase', sine(1, true));
  t.after(() => sounds.remove(snd.id));
  let peak = 0;
  for (const sample of snd.buffer.getChannelData(0)) peak = Math.max(peak, Math.abs(sample));
  assert.ok(peak >= 0.9);
});

test('imports announce truncation only beyond 90 seconds', t => {
  installAudioBuffer(t);
  const long = sounds.addUser('Long import', sine(91));
  const short = sounds.addUser('Short import', sine(10));
  t.after(() => { sounds.remove(long.id); sounds.remove(short.id); });
  assert.equal(long.truncated, true);
  assert.ok(long.buffer.duration <= 90);
  assert.equal(short.truncated, undefined);
});
