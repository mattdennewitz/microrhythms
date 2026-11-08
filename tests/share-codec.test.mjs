import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { project } from '../src/core/project.ts';
import { Plate, stack } from '../src/core/stack.ts';
import { encodeShare, decodeShare, MAX_SHARE_URL_LENGTH, MAX_SHARE_JSON_BYTES } from '../src/core/share-codec.ts';

function fixture() {
  const previous = stack.plates;
  try {
    const plate = new Plate({ seed: 42, steps: 8, tracks: 2, density: 0.5 }, 0);
    plate.overrides.set(0, true);
    plate.overrides.set(1, false);
    plate.fxOverrides.set(0, 'reverse');
    plate.generate();
    stack.createDefault();
    stack.plates[0] = plate;
    const value = project.serialize();
    value.global.rollSeed = 4294967295;
    value.global.masterLevel = 0.12345678901234568;
    value.global.selected = 0;
    value.holds = value.plates.map((_, index) => index === 0);
    value.keep = { slots: [structuredClone(value.plates), null, null, null], active: 0 };
    value.view.mode = 'SPLIT';
    value.view.dragYaw = -0.12345678901234568;
    value.sounds.user = [{ id: 900, name: 'Custom Ω sample', enabled: false, sampleRate: 44100, pcm16: Buffer.from([0, 128, 255, 127, 0, 0, 1, 0]).toString('base64') }];
    value.plates[0].sourceIds = [900];
    value.flight.on = true;
    value.flight.state = { pos: [0.12345678901234568, -2, 3], autopilot: false, tau: 1.2345678901234567, yaw: 0.2, pitch: -0.3, lookYaw: 0.4, lookPitch: -0.5, fwd: [0, 0, -1] };
    value.exporter = { phrases: 4, mode: 'loop' };
    return value;
  } finally {
    stack.plates = previous;
  }
}

const bytesLink = (bytes) => '#mr2.' + createHash('sha256').update(bytes).digest('base64url') + '.' + bytes.toString('base64url');
const rawLink = (text) => bytesLink(gzipSync(text, { mtime: 0 }));

test('full serialized project roundtrips without changing samples, precision, seed or settings', async () => {
  const value = fixture();
  const original = structuredClone(value);
  const hash = await encodeShare(value);
  assert.match(hash, /^#mr2\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]+$/);
  assert.deepEqual(await decodeShare(hash), original);
  assert.deepEqual(value, original, 'encoding must not mutate the project');
});

test('existing version-1 files without optional builtin IDs roundtrip', async () => {
  const value = fixture();
  delete value.sounds.builtinIds;
  assert.deepEqual(await decodeShare(await encodeShare(value)), value);
});

test('missing, old and future share envelope versions are rejected', async () => {
  for (const hash of ['', '#', '#mr0.AAAA', '#mr1.AAAA', '#mr3.AAAA', '#AAAA', 'mr2.AAAA']) {
    await assert.rejects(decodeShare(hash), /version/i);
  }
});

test('malformed and noncanonical base64url is rejected', async () => {
  for (const payload of ['', 'a', 'ab=', 'a+b/', 'a b', 'a\nb', 'AB']) {
    await assert.rejects(decodeShare('#mr2.' + 'A'.repeat(43) + '.' + payload), /base64/i);
  }
});

test('corrupt gzip, invalid UTF-8 and invalid JSON are rejected', async () => {
  await assert.rejects(decodeShare(bytesLink(Buffer.from('not gzip'))), /gzip/i);
  const good = gzipSync('{}');
  good[good.length - 8] ^= 1;
  await assert.rejects(decodeShare(bytesLink(good)), /gzip/i);
  await assert.rejects(decodeShare(rawLink(Buffer.from([0xff]))), /JSON/i);
  await assert.rejects(decodeShare(rawLink('{broken')), /JSON/i);
});

test('project payload versions are mandatory and must be supported in both directions', async () => {
  for (const version of [undefined, 0, 2, '1', null]) {
    const value = fixture();
    if (version === undefined) delete value.version;
    else value.version = version;
    await assert.rejects(decodeShare(rawLink(JSON.stringify(value))), /version/i);
    await assert.rejects(encodeShare(value), /version/i);
  }
  await assert.rejects(decodeShare(rawLink('{}')));
  const value = fixture();
  value.global.rollSeed = 'invalid';
  await assert.rejects(decodeShare(rawLink(JSON.stringify(value))));
  await assert.rejects(encodeShare(value));
});

test('encoded size limit rejects input before base64 decoding', async () => {
  await assert.rejects(decodeShare('#mr2.' + 'A'.repeat(MAX_SHARE_URL_LENGTH)), /too large.*file export/i);
});

test('bounded streaming decompression rejects highly compressed oversized JSON', async () => {
  const hash = rawLink(' '.repeat(MAX_SHARE_JSON_BYTES + 1));
  assert.ok(hash.length < MAX_SHARE_URL_LENGTH);
  await assert.rejects(decodeShare(hash), /too large.*file export/i);
});

test('encoding oversized projects fails explicitly rather than dropping custom PCM', async () => {
  const value = fixture();
  value.sounds.user[0].pcm16 = 'AAAA'.repeat(Math.ceil(MAX_SHARE_JSON_BYTES / 4));
  await assert.rejects(encodeShare(value), /too large.*file export/i);
});

test('payload edits, altered checksums and missing integrity metadata are rejected', async () => {
  const hash = await encodeShare(fixture());
  const [prefix, checksum, payload] = hash.split('.');
  const flip = (s) => (s[0] === 'A' ? 'B' : 'A') + s.slice(1);
  await assert.rejects(decodeShare([prefix, checksum, flip(payload)].join('.')), /checksum mismatch/i);
  await assert.rejects(decodeShare([prefix, flip(checksum), payload].join('.')), /checksum mismatch/i);
  await assert.rejects(decodeShare(prefix + '.' + payload), /checksum/i);
  await assert.rejects(decodeShare(hash + '.extra'), /checksum/i);
});

test('correct checksums cannot bypass schema validation', async () => {
  const value = fixture();
  value.plates[0].extra = { script: 'untrusted' };
  await assert.rejects(decodeShare(rawLink(JSON.stringify(value))), /invalid project/i);
  delete value.plates[0].extra;
  value.plates[0].overrides = [[value.plates[0].steps * value.plates[0].tracks, true]];
  await assert.rejects(decodeShare(rawLink(JSON.stringify(value))), /invalid project/i);
  await assert.rejects(encodeShare(value), /invalid project/i);
});

test('the caller reserves the origin, path and query within the full URL budget', async () => {
  const value = fixture();
  const hash = await encodeShare(value);
  assert.equal(await encodeShare(value, hash.length), hash);
  await assert.rejects(encodeShare(value, hash.length - 1), /too large/i);
  await assert.rejects(decodeShare(hash, hash.length - 1), /too large/i);
  await assert.rejects(encodeShare(value, 0), /too large/i);
});

test('valid incompressible audio cannot exceed the compact URL budget', async () => {
  const value = fixture();
  const pcm = Buffer.alloc(30000);
  let state = 0x12345678;
  for (let i = 0; i < pcm.length; i++) {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    pcm[i] = state >>> 24;
  }
  value.sounds.user[0].pcm16 = pcm.toString('base64');
  await assert.rejects(encodeShare(value), /too large.*file export/i);
});

test('superseded decoding can be cancelled before applying state', async () => {
  const hash = await encodeShare(fixture());
  const controller = new AbortController();
  const decoding = decodeShare(hash, MAX_SHARE_URL_LENGTH, controller.signal);
  controller.abort();
  await assert.rejects(decoding, { name: 'AbortError' });
});
