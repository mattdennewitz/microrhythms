import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { project } from '../src/core/project.ts';
import { Plate, stack } from '../src/core/stack.ts';
import { encodeShare, decodeShare, MAX_SHARE_HASH_LENGTH, MAX_SHARE_JSON_BYTES } from '../src/core/share-codec.ts';

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

const rawLink = (text) => '#mr1.' + gzipSync(text, { mtime: 0 }).toString('base64url');

test('full serialized project roundtrips without changing samples, precision, seed or settings', async () => {
  const value = fixture();
  const original = structuredClone(value);
  const hash = await encodeShare(value);
  assert.match(hash, /^#mr1\.[A-Za-z0-9_-]+$/);
  assert.deepEqual(await decodeShare(hash), original);
  assert.deepEqual(value, original, 'encoding must not mutate the project');
});

test('existing version-1 files without optional builtin IDs roundtrip', async () => {
  const value = fixture();
  delete value.sounds.builtinIds;
  assert.deepEqual(await decodeShare(await encodeShare(value)), value);
});

test('missing, old and future share envelope versions are rejected', async () => {
  for (const hash of ['', '#', '#mr0.AAAA', '#mr2.AAAA', '#AAAA', 'mr1.AAAA']) {
    await assert.rejects(decodeShare(hash), /version/i);
  }
});

test('malformed and noncanonical base64url is rejected', async () => {
  for (const payload of ['', 'a', 'ab=', 'a+b/', 'a b', 'a\nb', 'AB']) {
    await assert.rejects(decodeShare('#mr1.' + payload), /base64/i);
  }
});

test('corrupt gzip, invalid UTF-8 and invalid JSON are rejected', async () => {
  await assert.rejects(decodeShare('#mr1.' + Buffer.from('not gzip').toString('base64url')), /gzip/i);
  const good = gzipSync('{}');
  good[good.length - 8] ^= 1;
  await assert.rejects(decodeShare('#mr1.' + good.toString('base64url')), /gzip/i);
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
  await assert.rejects(decodeShare('#mr1.' + 'A'.repeat(MAX_SHARE_HASH_LENGTH)), /too large.*file export/i);
});

test('bounded streaming decompression rejects highly compressed oversized JSON', async () => {
  const hash = rawLink(' '.repeat(MAX_SHARE_JSON_BYTES + 1));
  assert.ok(hash.length < MAX_SHARE_HASH_LENGTH);
  await assert.rejects(decodeShare(hash), /too large.*file export/i);
});

test('encoding oversized projects fails explicitly rather than dropping custom PCM', async () => {
  const value = fixture();
  value.sounds.user[0].pcm16 = 'AAAA'.repeat(Math.ceil(MAX_SHARE_JSON_BYTES / 4));
  await assert.rejects(encodeShare(value), /too large.*file export/i);
});
