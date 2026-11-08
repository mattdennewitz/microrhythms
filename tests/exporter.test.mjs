import assert from 'node:assert/strict';
import test from 'node:test';
import { exporter } from '../src/core/exporter.ts';

const text = new TextDecoder();

test('WAV encoding writes interleaved clipped 24-bit PCM and consistent headers', () => {
  // encodeWav only consumes this AudioBuffer data interface; no audio context is needed.
  const channels = [new Float32Array([-2, 0, 2]), new Float32Array([1, -1, 0.5])];
  const wav = exporter.encodeWav({
    numberOfChannels: 2,
    sampleRate: 48000,
    length: 3,
    getChannelData: (channel) => channels[channel],
  });
  const header = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  assert.equal(wav.length, 44 + 18);
  assert.equal(text.decode(wav.subarray(0, 4)), 'RIFF');
  assert.equal(header.getUint32(4, true), wav.length - 8);
  assert.equal(text.decode(wav.subarray(8, 16)), 'WAVEfmt ');
  assert.equal(header.getUint32(16, true), 16);
  assert.equal(header.getUint16(20, true), 1);
  assert.equal(header.getUint16(22, true), 2);
  assert.equal(header.getUint32(24, true), 48000);
  assert.equal(header.getUint32(28, true), 48000 * 6);
  assert.equal(header.getUint16(32, true), 6);
  assert.equal(header.getUint16(34, true), 24);
  assert.equal(text.decode(wav.subarray(36, 40)), 'data');
  assert.equal(header.getUint32(40, true), 18);
  assert.deepEqual([...wav.subarray(44)], [
    1, 0, 128, 255, 255, 127,
    0, 0, 0, 1, 0, 128,
    255, 255, 127, 0, 0, 64,
  ]);
});

test('CRC-32 matches the standard check vector and empty payload', () => {
  assert.equal(exporter.crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  assert.equal(exporter.crc32(new Uint8Array()), 0);
});

test('stem ZIP preserves names and bytes with valid local headers and central offsets', async () => {
  const files = [
    { name: 'BEAT.wav', data: new TextEncoder().encode('123456789') },
    { name: 'EMPTY.wav', data: new Uint8Array() },
  ];
  const blob = exporter.zip(files);
  assert.equal(blob.type, 'application/zip');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer);
  const end = bytes.length - 22;
  assert.equal(view.getUint32(end, true), 0x06054b50);
  assert.equal(view.getUint16(end + 8, true), 2);
  assert.equal(view.getUint16(end + 10, true), 2);
  let central = view.getUint32(end + 16, true);
  assert.equal(view.getUint32(end + 12, true), end - central);
  let local = 0;
  for (const [index, file] of files.entries()) {
    const crc = index === 0 ? 0xcbf43926 : 0;
    assert.equal(view.getUint32(local, true), 0x04034b50);
    assert.equal(view.getUint16(local + 8, true), 0); // stored, not compressed
    assert.equal(view.getUint32(local + 14, true), crc);
    assert.equal(view.getUint32(local + 18, true), file.data.length);
    assert.equal(view.getUint32(local + 22, true), file.data.length);
    const nameLength = view.getUint16(local + 26, true);
    const dataStart = local + 30 + nameLength + view.getUint16(local + 28, true);
    assert.equal(text.decode(bytes.subarray(local + 30, local + 30 + nameLength)), file.name);
    assert.deepEqual(bytes.subarray(dataStart, dataStart + file.data.length), file.data);
    assert.equal(view.getUint32(central, true), 0x02014b50);
    assert.equal(view.getUint32(central + 16, true), crc);
    assert.equal(view.getUint32(central + 20, true), file.data.length);
    assert.equal(view.getUint32(central + 24, true), file.data.length);
    assert.equal(view.getUint32(central + 42, true), local);
    const centralNameLength = view.getUint16(central + 28, true);
    assert.equal(text.decode(bytes.subarray(central + 46, central + 46 + centralNameLength)), file.name);
    central += 46 + centralNameLength + view.getUint16(central + 30, true) + view.getUint16(central + 32, true);
    local = dataStart + file.data.length;
  }
  assert.equal(local, view.getUint32(end + 16, true));
  assert.equal(central, end);
});

test('empty ZIP is a valid empty end-of-central-directory record', async () => {
  const bytes = new Uint8Array(await exporter.zip([]).arrayBuffer());
  assert.equal(bytes.length, 22);
  const view = new DataView(bytes.buffer);
  assert.equal(view.getUint32(0, true), 0x06054b50);
  assert.equal(view.getUint16(8, true), 0);
  assert.equal(view.getUint32(12, true), 0);
  assert.equal(view.getUint32(16, true), 0);
});
