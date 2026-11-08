/* Export: offline-rendered WAV of the mix, or a ZIP of per-plate stems. */
import { stack, type Plate } from './stack';
import { engine, type ClockSeg } from './engine';
import { flight, type ExportFlightCtx } from './flight';
import { view } from './view';
import type { MotionSeg, Pose } from './types';

export type ExportMode = 'tail' | 'loop';
/** (stem index, stem count, stem name, fraction of this stem rendered) */
export type ExportProgress = (index: number, count: number, name: string, fraction: number) => void;
/** A file inside the stems ZIP. */
export interface ZipEntry { name: string; data: Uint8Array<ArrayBuffer> }
/** Everything an export renders from; one plan serves every stem. */
export interface ExportPlan {
  startBeat: number;
  motions: Map<Plate, MotionSeg[]> | null;
  flight: ExportFlightCtx | null;
  clock: ClockSeg[] | null;
  listenerPose: Pose | null;
}
export interface WavExport { name: string; wav: Uint8Array<ArrayBuffer>; length: number; sampleRate: number; peak: number; from: string }
export interface StemsExport { name: string; blob: Blob; files: string[]; from: string }
export interface ExportOptions { save?: boolean; onProgress?: ExportProgress }

/** 24-bit PCM WAV. */
function encodeWav(buffer: AudioBuffer): Uint8Array<ArrayBuffer> {
  const ch = buffer.numberOfChannels, sr = buffer.sampleRate, n = buffer.length;
  const bytes = 3;
  const dataLen = n * ch * bytes;
  const ab = new ArrayBuffer(44 + dataLen);
  const v = new DataView(ab);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + dataLen, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * ch * bytes, true); v.setUint16(32, ch * bytes, true); v.setUint16(34, 24, true);
  str(36, 'data'); v.setUint32(40, dataLen, true);
  const chans: Float32Array[] = [];
  for (let c = 0; c < ch; c++) chans.push(buffer.getChannelData(c));
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      let s = Math.max(-1, Math.min(1, chans[c][i]));
      let x = Math.round(s * 8388607);
      if (x < 0) x += 16777216;
      v.setUint8(o, x & 255); v.setUint8(o + 1, (x >> 8) & 255); v.setUint8(o + 2, (x >> 16) & 255);
      o += 3;
    }
  }
  return new Uint8Array(ab);
}

// ---- minimal store-only ZIP writer
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(data: Uint8Array): number {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function zip(files: ZipEntry[]): Blob {
  const enc = new TextEncoder();
  const parts: Uint8Array<ArrayBuffer>[] = [], central: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0, true); lh.setUint16(8, 0, true);
    lh.setUint16(10, 0, true); lh.setUint16(12, 0x21, true); lh.setUint32(14, crc, true);
    lh.setUint32(18, f.data.length, true); lh.setUint32(22, f.data.length, true);
    lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
    parts.push(new Uint8Array(lh.buffer), name, f.data);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true); cd.setUint16(8, 0, true);
    cd.setUint16(10, 0, true); cd.setUint16(12, 0, true); cd.setUint16(14, 0x21, true); cd.setUint32(16, crc, true);
    cd.setUint32(20, f.data.length, true); cd.setUint32(24, f.data.length, true); cd.setUint16(28, name.length, true);
    cd.setUint16(30, 0, true); cd.setUint16(32, 0, true); cd.setUint16(34, 0, true); cd.setUint16(36, 0, true);
    cd.setUint32(38, 0, true); cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), name);
    offset += 30 + name.length + f.data.length;
  }
  const cdSize = central.reduce((s, a) => s + a.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
}

/** Fold everything past the loop point back onto the start: a seamless loop
 *  whose first bar already carries the previous pass's reverb/delay tail. */
function foldLoop(buf: AudioBuffer, seconds: number): AudioBuffer {
  const n = Math.round(seconds * buf.sampleRate);
  const out = new AudioBuffer({ length: n, numberOfChannels: buf.numberOfChannels, sampleRate: buf.sampleRate });
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const src = buf.getChannelData(c), dst = out.getChannelData(c);
    for (let i = 0; i < src.length; i++) dst[i % n] += src[i];
    for (let i = 0; i < n; i++) dst[i] = Math.max(-1, Math.min(1, dst[i]));
  }
  return out;
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export const exporter = {
  phrases: 1,
  mode: 'tail' as ExportMode,      // 'tail' (as played) | 'loop' (tail folded onto the start)
  busy: false,
  last: null as WavExport | StemsExport | null,        // last result, kept for tests

  seconds(): number { return this.phrases * stack.phraseBars * 4 * 60 / engine.bpm; },
  baseName(plan?: ExportPlan | null): string {
    const bar = plan ? Math.floor(plan.startBeat / 4) + 1 : 1;
    return `orbital-${Math.round(engine.bpm)}bpm-${this.phrases * stack.phraseBars}bars-from${bar}${plan && plan.flight ? '-flight' : ''}`;
  },

  /** Render what PLAY plays: the song from bar 1. Stopped, that's exactly what the
   *  next PLAY will produce (plates from their start, the paused ship carrying on);
   *  playing, it's this PLAY from bar 1, with the plates as they have moved. */
  plan(): ExportPlan {
    const E = engine, S = stack;
    const playing = E.playing && E.ctx;
    const startBeat = 0;
    const motions = playing ? new Map<Plate, MotionSeg[]>(S.plates.map((p) => [p, p.motion.map((m) => Object.assign({}, m))])) : null;
    const fl = flight.on ? flight.exportCtx() : null;
    // while playing, replay the tempo map since PLAY (offline time 0 = bar 1)
    let clock: ClockSeg[] | null = null;
    if (playing) {
      const t0 = E.timeAtBeat(0);
      clock = E.clock.map((s: ClockSeg) => ({ t0: s.t0 - t0, b0: s.b0, bps: s.bps }));
      clock[0] = { t0: 0, b0: 0, bps: clock[0].bps };
    }
    const listenerPose = fl ? null : E.listenerPose(view);
    return { startBeat, motions, flight: fl, clock, listenerPose: listenerPose && { pos: listenerPose.pos.slice(), fwd: listenerPose.fwd.slice(), up: listenerPose.up.slice() } };
  },

  beats(): number { return this.phrases * stack.phraseBars * 4; },
  async render(onlyPlate: Plate | null, plan?: ExportPlan | null, onProgress?: ((f: number) => void) | null): Promise<AudioBuffer> {
    const pl = plan || this.plan();
    const buf = await engine.renderOffline(Object.assign({ beats: this.beats(), tail: 4, onlyPlate, onProgress }, pl));
    return this.mode === 'loop' ? foldLoop(buf, buf.loopSeconds!) : buf;
  },

  describe(plan: ExportPlan): string {
    const bar = Math.floor(plan.startBeat / 4) + 1;
    return `from bar ${bar}${plan.flight ? ` · flight, ${plan.flight.where}` : ''}`;
  },

  async exportWav({ save = true, onProgress }: ExportOptions = {}): Promise<WavExport | null> {
    if (this.busy) return null;
    this.busy = true;
    try {
      const plan = this.plan();
      const buf = await this.render(null, plan, onProgress ? (f: number) => onProgress(0, 1, 'mix', f) : null);
      const wav = encodeWav(buf);
      const name = `${this.baseName(plan)}${this.mode === 'loop' ? '-loop' : ''}.wav`;
      this.last = { name, wav, length: buf.length, sampleRate: buf.sampleRate, peak: peakOf(buf), from: this.describe(plan) };
      if (save) download(new Blob([wav], { type: 'audio/wav' }), name);
      return this.last;
    } finally { this.busy = false; }
  },

  async exportStems({ save = true, onProgress }: ExportOptions = {}): Promise<StemsExport | null> {
    if (this.busy) return null;
    this.busy = true;
    try {
      const anySolo = stack.anySolo();
      const plates = stack.plates.filter((p) => p.audible(anySolo));
      const files: ZipEntry[] = [];
      const plan = this.plan(); // one plan for every stem, so they sum to the mix
      for (let i = 0; i < plates.length; i++) {
        if (onProgress) onProgress(i, plates.length, plates[i].name, 0);
        const buf = await this.render(plates[i], plan, onProgress ? (f: number) => onProgress(i, plates.length, plates[i].name, f) : null);
        files.push({ name: `${plates[i].name}.wav`, data: encodeWav(buf) });
      }
      const blob = zip(files);
      const name = `${this.baseName(plan)}-stems.zip`;
      this.last = { name, blob, files: files.map((f) => f.name), from: this.describe(plan) };
      if (save) download(blob, name);
      return this.last;
    } finally { this.busy = false; }
  },

  encodeWav, zip, crc32, foldLoop,
};

function peakOf(buf: AudioBuffer): number {
  let pk = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > pk) pk = a; }
  }
  return pk;
}

