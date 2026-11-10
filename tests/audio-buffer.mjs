// The in-memory Web Audio data boundary used by real sample conditioning in Node.
export class TestAudioBuffer {
  constructor({ length, numberOfChannels, sampleRate }) {
    this.length = length;
    this.numberOfChannels = numberOfChannels;
    this.sampleRate = sampleRate;
    this.duration = length / sampleRate;
    this.channels = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }

  getChannelData(channel) { return this.channels[channel]; }
  copyToChannel(data, channel) { this.channels[channel].set(data); }
}

export function installAudioBuffer(t) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'AudioBuffer');
  Object.defineProperty(globalThis, 'AudioBuffer', { configurable: true, writable: true, value: TestAudioBuffer });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'AudioBuffer', original);
    else delete globalThis.AudioBuffer;
  });
}

export function recordingBuffer() {
  const buffer = new TestAudioBuffer({ length: 2048, numberOfChannels: 2, sampleRate: 48000 });
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const data = buffer.getChannelData(channel);
    for (let i = 128; i < data.length - 128; i++) data[i] = (i % 64 < 32 ? 1 : -1) * (channel + 1) * 0.2;
  }
  return buffer;
}
