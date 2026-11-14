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

function signalBuffer({ sampleRate = 24000, length = sampleRate, channels }) {
  const buffer = new TestAudioBuffer({ length, sampleRate, numberOfChannels: channels.length });
  channels.forEach((signal, channel) => {
    for (let i = 0; i < length; i++) buffer.channels[channel][i] = signal(i, sampleRate);
  });
  return buffer;
}

function peakOf(buffer) {
  let peak = 0;
  for (const sample of buffer.getChannelData(0)) peak = Math.max(peak, Math.abs(sample));
  return peak;
}

test('common DC cannot hide opposite-phase stereo from import conditioning', t => {
  installAudioBuffer(t);
  const input = signalBuffer({ channels: [
    (i, sr) => 0.1 + 0.2 * Math.sin(2 * Math.PI * 440 * i / sr),
    (i, sr) => 0.1 - 0.2 * Math.sin(2 * Math.PI * 440 * i / sr),
  ] });
  const original = input.channels.map(channel => channel.slice());
  const snd = sounds.addUser('Common DC opposite phase', input);
  t.after(() => sounds.remove(snd.id));
  assert.equal(snd.buffer.numberOfChannels, 1);
  assert.equal(snd.buffer.sampleRate, input.sampleRate);
  assert.ok(peakOf(snd.buffer) >= 0.9);
  const pcm = snd.buffer.getChannelData(0);
  const rms = Math.sqrt(pcm.reduce((sum, value) => sum + value * value, 0) / pcm.length);
  assert.ok(rms > 0.6, 'recovered output must contain audible signal, not a DC residual');
  assert.deepEqual(input.channels, original, 'conditioning must not modify source channels');
});

test('ordinary stereo retains its averaged waveform after removing DC', t => {
  installAudioBuffer(t);
  const left = (i, sr) => 0.15 + 0.2 * Math.sin(2 * Math.PI * 440 * i / sr);
  const right = (i, sr) => -0.05 + 0.1 * Math.cos(2 * Math.PI * 660 * i / sr);
  const mixed = sounds.condition(signalBuffer({ sampleRate: 44100, channels: [left, right] }));
  const reference = sounds.condition(signalBuffer({
    sampleRate: 44100, channels: [(i, sr) => (left(i, sr) + right(i, sr)) / 2],
  }));
  assert.equal(mixed.sampleRate, 44100);
  assert.equal(mixed.length, reference.length);
  for (let i = 0; i < mixed.length; i++) {
    assert.ok(Math.abs(mixed.getChannelData(0)[i] - reference.getChannelData(0)[i]) < 1e-6);
  }
});

test('DC-only stereo and mono remain silent, including different channel offsets', t => {
  installAudioBuffer(t);
  for (const offsets of [[0.1, 0.1], [0.1, -0.2], [0.1], [0]]) {
    assert.throws(() => sounds.condition(signalBuffer({ channels: offsets.map(dc => () => dc) })), /silent or too short/);
  }
});

test('DC removal preserves mono trim, normalization and silence boundaries', t => {
  installAudioBuffer(t);
  const mono = sounds.condition(signalBuffer({ channels: [
    (i, sr) => 0.1 + (i >= 1000 && i < 5000 ? 0.2 * Math.sin(2 * Math.PI * 440 * i / sr) : 0),
  ] }));
  assert.ok(mono.length > 4000 && mono.length < 4200);
  assert.equal(mono.sampleRate, 24000);
  assert.ok(Math.abs(peakOf(mono) - 0.92) < 1e-6);
  assert.throws(() => sounds.condition(signalBuffer({ channels: [
    (i, sr) => 0.1 + 0.0009 * Math.sin(2 * Math.PI * 440 * i / sr),
  ] })), /silent or too short/);
  const quiet = sounds.condition(signalBuffer({ channels: [
    (i, sr) => 0.1 + 0.0011 * Math.sin(2 * Math.PI * 440 * i / sr),
  ] }));
  assert.ok(peakOf(quiet) > 0.1 && peakOf(quiet) < 0.12, 'normalization retains the +40 dB ceiling');
  assert.throws(() => sounds.condition(signalBuffer({
    length: 32, channels: [i => i % 2 ? 0.2 : -0.2],
  })), /silent or too short/);
});
