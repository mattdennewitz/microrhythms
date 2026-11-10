import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { app } from '../src/app/controller.ts';
import { subscribe } from '../src/app/store.ts';
import { sounds } from '../src/core/sounds.ts';
import { stack } from '../src/core/stack.ts';
import { engine } from '../src/core/engine.ts';
import { installAudioBuffer, recordingBuffer, TestAudioBuffer } from './audio-buffer.mjs';

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

let intervals, intervalStarts;

beforeEach((t) => {
  installAudioBuffer(t);
  intervals = new Map();
  intervalStarts = 0;
  t.mock.method(globalThis, 'setInterval', (callback) => {
    const id = ++intervalStarts;
    intervals.set(id, callback);
    return id;
  });
  t.mock.method(globalThis, 'clearInterval', (id) => { intervals.delete(id); });
  t.mock.method(console, 'warn', () => {});
  stack.createDefault();
  sounds.list = []; sounds.nextId = 1; sounds.listeners.clear();
  sounds.add('GLASS', recordingBuffer(), true, false);
  sounds.add('TICK', recordingBuffer(), true, false);
  stack.plates.forEach((p) => { p.sourceIds = new Set([1, 2]); });
  Object.assign(engine, { ctx: null, playing: false, pending: [] });
  Object.assign(app, {
    rec: null, recTimer: undefined, resampleCapture: null,
    mic: { state: 'idle', elapsed: 0 }, resampling: false, importsPending: 0,
    toastMsg: { text: '', n: 0 }, announceMsg: { text: '', n: 0 },
  });
});

afterEach(() => {
  // No real browser timers or audio resources are created by this I/O harness.
  intervals.clear();
  Object.assign(app, {
    rec: null, recTimer: undefined, resampleCapture: null,
    mic: { state: 'idle', elapsed: 0 }, resampling: false, importsPending: 0,
    toastMsg: { text: '', n: 0 }, announceMsg: { text: '', n: 0 },
  });
  sounds.list = []; sounds.listeners.clear(); stack.plates = [];
  Object.assign(engine, { ctx: null, playing: false, pending: [] });
});

function deferredFile(t, name) {
  const reading = deferred();
  const file = new File(['audio'], name);
  const read = t.mock.method(file, 'arrayBuffer', () => reading.promise);
  return { file, reading, read };
}

function decoder(t, decode = () => Promise.resolve(recordingBuffer())) {
  const decodeAudioData = t.mock.fn(decode);
  t.mock.method(engine, 'ensureCtx', () => ({ decodeAudioData }));
  return decodeAudioData;
}

function feedback() { return { toast: app.toastMsg, announce: app.announceMsg }; }

function assertClearedLibrary() {
  assert.deepEqual(sounds.list.filter((sound) => !sound.builtin), []);
  assert.ok(sounds.list.every((sound) => !sound.enabled));
  for (const plate of stack.plates) {
    assert.deepEqual([...plate.sourceIds], [1, 2]);
    assert.deepEqual(sounds.poolFor(plate), []);
  }
}

function assertUserSounds(names) {
  const users = sounds.list.filter((sound) => !sound.builtin);
  assert.deepEqual(users.map((sound) => sound.name), names);
  for (const sound of users) {
    assert.equal(sound.enabled, true);
    assert.ok(sound.buffer instanceof TestAudioBuffer);
    assert.equal(sound.buffer.numberOfChannels, 1);
    assert.ok(sound.buffer.length >= 64 && sound.buffer.length < 2048);
    const samples = sound.buffer.getChannelData(0);
    assert.ok(samples.some((sample) => Math.abs(sample) > 0.01));
    assert.ok(samples.every((sample) => Number.isFinite(sample) && Math.abs(sample) <= 1));
    assert.equal(sound.onsets[0], 0);
  }
  assert.ok(sounds.list.filter((sound) => sound.builtin).every((sound) => !sound.enabled));
  for (const plate of stack.plates) {
    assert.ok(users.every((sound) => plate.sourceIds.has(sound.id)));
    assert.deepEqual(sounds.poolFor(plate), users);
  }
}

// Fake only capture/permission I/O. The callbacks run the real controller and
// addBuffer/addUser/conditioning path, including synchronous completion on stop.
function captureRequest(onDone, { completeOnStop = true } = {}) {
  const resource = { released: false, stops: 0 };
  const request = {
    resource,
    complete(buffer = recordingBuffer()) { resource.released = true; onDone(buffer); },
    capture: {
      elapsed: () => 0.75,
      stop() {
        resource.stops++;
        if (resource.released) return;
        resource.released = true;
        if (completeOnStop) onDone(recordingBuffer());
      },
    },
  };
  return request;
}

function microphoneInput(t, options) {
  const requests = [];
  t.mock.method(engine, 'recordMic', (_seconds, onDone) => {
    const request = { ...captureRequest(onDone, options), permission: deferred() };
    requests.push(request);
    return request.permission.promise;
  });
  return requests;
}

function resampleInput(t, options) {
  const requests = [];
  t.mock.method(engine, 'resample', (_seconds, onDone) => {
    const request = captureRequest(onDone, options);
    requests.push(request);
    return request.capture;
  });
  return requests;
}

test('clear cancels a pending multi-file batch without reading its remaining files or replacing clear feedback', async (t) => {
  const decode = decoder(t);
  const first = deferredFile(t, 'old.wav');
  const second = deferredFile(t, 'never-started.wav');
  const importing = app.addFiles([first.file, second.file]);
  assert.equal(app.importsPending, 1);

  app.clearSounds();
  assert.equal(app.importsPending, 0);
  const cleared = feedback();
  first.reading.resolve(new ArrayBuffer(4));
  await importing;

  assert.equal(second.read.mock.callCount(), 0);
  assert.equal(decode.mock.callCount(), 0);
  assert.equal(app.importsPending, 0);
  assert.deepEqual(feedback(), cleared);
  assertClearedLibrary();
});

test('empty-library batches notify their count and old finalizers cannot decrement an overlapping new batch', async (t) => {
  decoder(t);
  app.clearSounds();
  const counts = [];
  const unsubscribe = subscribe(() => counts.push(app.importsPending));
  t.after(unsubscribe);
  const oldRead = deferredFile(t, 'old-read.wav');
  const oldFailure = deferredFile(t, 'old-error.wav');
  const first = app.addFiles([oldRead.file]);
  assert.equal(app.importsPending, 1);
  const second = app.addFiles([oldFailure.file]);
  assert.equal(app.importsPending, 2);
  assert.ok(counts.includes(1) && counts.includes(2));
  assertClearedLibrary();

  app.clearSounds();
  assert.equal(app.importsPending, 0);
  assert.equal(counts.at(-1), 0);
  const fresh = deferredFile(t, 'fresh.wav');
  const freshImport = app.addFiles([fresh.file]);
  assert.equal(app.importsPending, 1);
  const cleared = feedback();
  oldRead.reading.resolve(new ArrayBuffer(4));
  oldFailure.reading.reject(new Error('obsolete read failed'));
  await Promise.all([first, second]);
  assert.equal(app.importsPending, 1);
  assert.deepEqual(feedback(), cleared);
  assertClearedLibrary();

  fresh.reading.resolve(new ArrayBuffer(4));
  await freshImport;
  assert.equal(app.importsPending, 0);
  assert.equal(counts.at(-1), 0);
  assertUserSounds(['FRESH']);
});

test('a stale decoder rejection cannot overwrite a fresh import success or continue the old batch', async (t) => {
  const oldDecode = deferred(), enteredDecode = deferred();
  let decodes = 0;
  decoder(t, () => {
    if (++decodes === 1) { enteredDecode.resolve(); return oldDecode.promise; }
    return Promise.resolve(recordingBuffer());
  });
  const remaining = deferredFile(t, 'never-started.wav');
  const staleImport = app.addFiles([new File(['audio'], 'old.wav'), remaining.file]);
  await enteredDecode.promise;
  app.clearSounds();
  await app.addFiles([new File(['audio'], 'fresh.wav')]);
  const success = feedback();
  assertUserSounds(['FRESH']);

  oldDecode.reject(new Error('obsolete decoder failed'));
  await staleImport;
  assert.deepEqual(feedback(), success);
  assert.equal(app.importsPending, 0);
  assert.equal(remaining.read.mock.callCount(), 0);
  assertUserSounds(['FRESH']);
});

test('finishing one of two current batches decrements the count without hiding the other import', async (t) => {
  decoder(t);
  app.clearSounds();
  const first = deferredFile(t, 'one.wav'), second = deferredFile(t, 'two.wav');
  const firstImport = app.addFiles([first.file]);
  const secondImport = app.addFiles([second.file]);
  assert.equal(app.importsPending, 2);
  first.reading.resolve(new ArrayBuffer(4));
  await firstImport;
  assert.equal(app.importsPending, 1);
  assertUserSounds(['ONE']);
  second.reading.resolve(new ArrayBuffer(4));
  await secondImport;
  assert.equal(app.importsPending, 0);
  assertUserSounds(['ONE', 'TWO']);
});

for (const stage of ['read', 'decode', 'silent']) {
  test(`a genuine current ${stage} import failure remains visible and releases its pending count`, async (t) => {
    app.clearSounds();
    const file = new File(['audio'], 'broken.wav');
    decoder(t, () => stage === 'silent'
      ? Promise.resolve(new TestAudioBuffer({ length: 2048, numberOfChannels: 1, sampleRate: 48000 }))
      : Promise.reject(new Error('decoder failed')));
    if (stage === 'read') t.mock.method(file, 'arrayBuffer', () => Promise.reject(new Error('disk failed')));
    const previousFeedback = feedback();

    await app.addFiles([file]);
    assert.notDeepEqual(feedback(), previousFeedback);
    assert.ok(app.toastMsg.text.includes(file.name));
    assert.equal(app.importsPending, 0);
    assertClearedLibrary();
  });
}

for (const outcome of ['grant', 'reject']) {
  test(`a pending microphone ${outcome} after clear cannot resurrect resources, timers or feedback`, async (t) => {
    const requests = microphoneInput(t);
    const starting = app.toggleMic();
    assert.equal(app.mic.state, 'starting');
    app.clearSounds();
    const cleared = feedback();
    if (outcome === 'grant') requests[0].permission.resolve(requests[0].capture);
    else requests[0].permission.reject(new Error('obsolete permission denial'));
    await starting;

    if (outcome === 'grant') {
      assert.equal(requests[0].resource.stops, 1);
      assert.equal(requests[0].resource.released, true);
    }
    assert.equal(app.rec, null);
    assert.equal(app.recTimer, undefined);
    assert.deepEqual(app.mic, { state: 'idle', elapsed: 0 });
    assert.equal(intervals.size, 0);
    assert.equal(intervalStarts, 0);
    assert.deepEqual(feedback(), cleared);
    assertClearedLibrary();
  });

  test(`a stale microphone permission ${outcome} cannot reset a newer recording or its timer`, async (t) => {
    const requests = microphoneInput(t);
    const oldStart = app.toggleMic();
    app.clearSounds();
    const newStart = app.toggleMic();
    requests[1].permission.resolve(requests[1].capture);
    await newStart;
    const timer = app.recTimer;
    assert.equal(intervals.size, 1);
    intervals.get(timer)();
    assert.deepEqual(app.mic, { state: 'recording', elapsed: 0.75 });
    const state = app.mic, message = feedback();

    if (outcome === 'grant') requests[0].permission.resolve(requests[0].capture);
    else requests[0].permission.reject(new Error('obsolete permission denial'));
    await oldStart;
    if (outcome === 'grant') {
      assert.equal(requests[0].resource.stops, 1);
      assert.equal(requests[0].resource.released, true);
    }
    assert.equal(app.rec, requests[1].capture);
    assert.equal(app.recTimer, timer);
    assert.equal(app.mic, state);
    assert.equal(intervals.size, 1);
    assert.equal(intervalStarts, 1);
    assert.deepEqual(feedback(), message);
    assertClearedLibrary();

    requests[1].complete();
    assert.equal(app.rec, null);
    assert.equal(app.mic.state, 'idle');
    assert.equal(intervals.size, 0);
    assertUserSounds(['MIC']);
  });
}

test('clear stops active mic and resample handles before their synchronous callbacks can add sounds', async (t) => {
  const mics = microphoneInput(t), resamples = resampleInput(t);
  const starting = app.toggleMic();
  mics[0].permission.resolve(mics[0].capture);
  await starting;
  engine.playing = true;
  app.resample();
  assert.equal(app.rec, mics[0].capture);
  assert.equal(app.resampleCapture, resamples[0].capture);
  assert.equal(app.resampling, true);
  assert.equal(intervals.size, 1);

  app.clearSounds();
  for (const request of [mics[0], resamples[0]]) {
    assert.equal(request.resource.stops, 1);
    assert.equal(request.resource.released, true);
  }
  assert.equal(app.rec, null);
  assert.equal(app.resampleCapture, null);
  assert.equal(app.recTimer, undefined);
  assert.deepEqual(app.mic, { state: 'idle', elapsed: 0 });
  assert.equal(app.resampling, false);
  assert.equal(app.importsPending, 0);
  assert.equal(intervals.size, 0);
  assertClearedLibrary();
});

test('delayed old capture completions cannot clear newer capture state, and fresh completions still populate real pools', async (t) => {
  const mics = microphoneInput(t, { completeOnStop: false });
  const resamples = resampleInput(t, { completeOnStop: false });
  engine.playing = true;
  const oldStart = app.toggleMic();
  mics[0].permission.resolve(mics[0].capture);
  await oldStart;
  app.resample();
  app.clearSounds();
  assert.ok(mics[0].resource.released && resamples[0].resource.released);

  const newStart = app.toggleMic();
  mics[1].permission.resolve(mics[1].capture);
  await newStart;
  app.resample();
  const timer = app.recTimer, state = app.mic, message = feedback();
  mics[0].complete();
  resamples[0].complete();

  assert.equal(app.rec, mics[1].capture);
  assert.equal(app.recTimer, timer);
  assert.equal(app.mic, state);
  assert.equal(app.resampleCapture, resamples[1].capture);
  assert.equal(app.resampling, true);
  assert.equal(intervals.size, 1);
  assert.equal(intervalStarts, 2);
  assert.deepEqual(feedback(), message);
  assertClearedLibrary();

  mics[1].complete();
  assert.equal(app.rec, null);
  assert.equal(app.recTimer, undefined);
  assert.equal(app.mic.state, 'idle');
  assert.equal(intervals.size, 0);
  assert.equal(app.resampling, true);
  assert.equal(app.resampleCapture, resamples[1].capture);
  resamples[1].complete();
  assert.equal(app.resampleCapture, null);
  assert.equal(app.resampling, false);
  assertUserSounds(['MIC', 'RESAMPLE']);
});

test('a genuine microphone permission error stays visible and a fresh retry remains usable after clear', async (t) => {
  app.clearSounds();
  const requests = microphoneInput(t);
  const previousFeedback = feedback();
  const failure = new Error('permission denied');
  const denied = app.toggleMic();
  requests[0].permission.reject(failure);
  await denied;
  assert.notDeepEqual(feedback(), previousFeedback);
  assert.ok(app.toastMsg.text.includes(failure.message));
  assert.equal(app.rec, null);
  assert.equal(app.recTimer, undefined);
  assert.deepEqual(app.mic, { state: 'idle', elapsed: 0 });
  assert.equal(intervals.size, 0);
  assert.equal(intervalStarts, 0);
  assertClearedLibrary();

  const retry = app.toggleMic();
  requests[1].permission.resolve(requests[1].capture);
  await retry;
  requests[1].complete();
  assert.equal(app.mic.state, 'idle');
  assert.equal(intervals.size, 0);
  assertUserSounds(['MIC']);
});
