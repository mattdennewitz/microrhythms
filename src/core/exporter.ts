/* Export: offline-rendered WAV of the mix, or a ZIP of per-plate stems. */
import { stack, type Plate } from './stack';
import { engine, type ClockSeg, type LoopPlan, type MixSnapshot } from './engine';
import { flight, type ExportFlightCtx } from './flight';
import { view } from './view';
import type { MotionSeg, Pose } from './types';

export type ExportMode = 'tail' | 'loop';
/** (stem index, stem count, stem name, fraction of this stem rendered) */
export type ExportProgress = (index: number, count: number, name: string, fraction: number) => void;
/** A file inside the stems ZIP. */
export interface ZipEntry { name: string; data: Uint8Array<ArrayBuffer> | Blob; crc?: number }
/** Everything an export renders from; one plan serves every stem. */
export interface ExportPlan {
  bpm: number;
  bars: number;
  beats: number;
  mode: ExportMode;
  startBeat: number;
  motions: Map<Plate, MotionSeg[]> | null;
  flight: ExportFlightCtx | null;
  clock: ClockSeg[];
  listenerPose: Pose | null;
  loopPlan: LoopPlan | null;
  mix: MixSnapshot;
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
  const out = new Uint8Array(ab);
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
      out[o] = x & 255; out[o + 1] = (x >> 8) & 255; out[o + 2] = (x >> 16) & 255;
      o += 3;
    }
  }
  return out;
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
  const parts: BlobPart[] = [], central: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const size = f.data instanceof Blob ? f.data.size : f.data.length;
    if (f.data instanceof Blob && f.crc === undefined) throw new Error('zip: Blob entry needs a crc');
    const crc = f.crc ?? crc32(f.data as Uint8Array);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
    lh.setUint16(10, 0, true); lh.setUint16(12, 0x21, true); lh.setUint32(14, crc, true);
    lh.setUint32(18, size, true); lh.setUint32(22, size, true);
    lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
    parts.push(new Uint8Array(lh.buffer), name, f.data);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true); cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, 0, true); cd.setUint16(12, 0, true); cd.setUint16(14, 0x21, true); cd.setUint32(16, crc, true);
    cd.setUint32(20, size, true); cd.setUint32(24, size, true); cd.setUint16(28, name.length, true);
    cd.setUint16(30, 0, true); cd.setUint16(32, 0, true); cd.setUint16(34, 0, true); cd.setUint16(36, 0, true);
    cd.setUint32(38, 0, true); cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), name);
    offset += 30 + name.length + size;
  }
  const cdSize = central.reduce((s, a) => s + a.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export const exporter = {
  phrases: 1,
  mode: 'tail' as ExportMode,      // AS PLAYED | cyclic, warmed LOOP
  busy: false,

  seconds(): number { return this.phrases * stack.phraseBars * 4 * 60 / engine.bpm; },
  baseName(plan?: ExportPlan | null): string {
    const pl = plan || this.plan();
    const bar = Math.floor(pl.startBeat / 4) + 1;
    const bpm = pl.mode === 'loop' ? pl.bpm : Math.round(pl.bpm);
    return `orbital-${bpm}bpm-${pl.bars}bars-from${bar}${pl.flight ? '-flight' : ''}`;
  },

  /** Capture once: LOOP starts at the audible/displayed plate phase and current
   *  listener/ship; AS PLAYED retains motion, tempo and flight history from PLAY. */
  plan(): ExportPlan {
    const E = engine, S = stack;
    const bpm = E.bpm, bars = this.phrases * S.phraseBars, beats = bars * 4, mode = this.mode;
    const playing = E.playing && E.ctx;
    const startBeat = 0;
    const currentBeat = mode === 'loop' && playing ? E.songBeat(E.visualTime()) : 0;
    const motions = mode === 'loop'
      ? new Map<Plate, MotionSeg[]>(S.plates.map((p): [Plate, MotionSeg[]] => {
        if (!playing) return [p, [{ b0: 0, phi0: p.phiFrozen, w: p.omega() }]];
        // A queued speed change may already be in motion: use the segment that
        // is audible now, not the scheduling horizon or the next segment.
        let seg = p.motion[0];
        for (let i = p.motion.length - 1; i >= 0; i--) {
          if (p.motion[i].b0 <= currentBeat) { seg = p.motion[i]; break; }
        }
        return [p, [{ b0: 0, phi0: seg.phi0 + seg.w * (currentBeat - seg.b0), w: seg.w }]];
      }))
      : playing ? new Map<Plate, MotionSeg[]>(S.plates.map((p) => [p, p.motion.map((m) => Object.assign({}, m))])) : null;
    const fl = flight.on ? flight.exportCtx(mode) : null;
    // Only AS PLAYED replays the tempo map since PLAY (offline time 0 = bar 1).
    let clock: ClockSeg[] = [{ t0: 0, b0: 0, bps: bpm / 60 }];
    if (mode === 'tail' && playing) {
      const t0 = E.timeAtBeat(0);
      clock = E.clock.map((s: ClockSeg) => ({ t0: s.t0 - t0, b0: s.b0, bps: s.bps }));
      clock[0] = { t0: 0, b0: 0, bps: clock[0].bps };
    }
    const listenerPose = fl ? null : E.listenerPose(view);
    const plan: ExportPlan = { bpm, bars, beats, mode, startBeat, motions, flight: fl, clock,
      listenerPose: listenerPose && { pos: listenerPose.pos.slice(), fwd: listenerPose.fwd.slice(), up: listenerPose.up.slice() },
      loopPlan: null, mix: { master: E.masterLevel, space: E.spaceLevel, fxWet: E.fxWet, levels: S.plates.map((p) => p.level) } };
    if (mode === 'loop') plan.loopPlan = E.captureLoop(plan);
    return plan;
  },

  beats(): number { return this.phrases * stack.phraseBars * 4; },
  async render(onlyPlate: Plate | null, plan?: ExportPlan | null, onProgress?: ((f: number) => void) | null): Promise<AudioBuffer> {
    const pl = plan || this.plan();
    return engine.renderOffline({ ...pl, loop: pl.mode === 'loop', tail: 4, onlyPlate, onProgress });
  },

  describe(plan: ExportPlan): string {
    if (plan.mode === 'loop') return `current position · current pattern · local bar 1${plan.flight ? ` · flight, ${plan.flight.where}` : ''}`;
    const bar = Math.floor(plan.startBeat / 4) + 1;
    return `from bar ${bar}${plan.flight ? ` · flight, ${plan.flight.where}` : ''}`;
  },

  async exportWav({ save = true, onProgress }: ExportOptions = {}): Promise<WavExport | null> {
    if (this.busy) return null;
    this.busy = true;
    try {
      const plan = this.plan();
      const buf = await this.render(null, plan, onProgress ? (f: number) => onProgress(0, 1, 'mix', f) : null);
      await new Promise<void>((r) => setTimeout(r, 0));
      const wav = encodeWav(buf);
      const name = `${this.baseName(plan)}${plan.mode === 'loop' ? '-loop' : ''}.wav`;
      if (save) download(new Blob([wav], { type: 'audio/wav' }), name);
      return { name, wav, length: buf.length, sampleRate: buf.sampleRate, peak: peakOf(buf), from: this.describe(plan) };
    } finally { this.busy = false; }
  },

  async exportStems({ save = true, onProgress }: ExportOptions = {}): Promise<StemsExport | null> {
    if (this.busy) return null;
    this.busy = true;
    try {
      const anySolo = stack.anySolo();
      const plates = stack.plates.filter((p) => p.audible(anySolo));
      const files: ZipEntry[] = [];
      const plan = this.plan(); // shared timing and mix settings for every soloed stem
      for (let i = 0; i < plates.length; i++) {
        if (onProgress) onProgress(i, plates.length, plates[i].name, 0);
        const buf = await this.render(plates[i], plan, onProgress ? (f: number) => onProgress(i, plates.length, plates[i].name, f) : null);
        await new Promise<void>((r) => setTimeout(r, 0));
        const wav = encodeWav(buf);
        files.push({ name: `${plates[i].name}.wav`, data: new Blob([wav], { type: 'audio/wav' }), crc: crc32(wav) });
      }
      const blob = zip(files);
      const name = `${this.baseName(plan)}-stems.zip`;
      if (save) download(blob, name);
      return { name, blob, files: files.map((f) => f.name), from: this.describe(plan) };
    } finally { this.busy = false; }
  },

  encodeWav, zip, crc32,
};

function peakOf(buf: AudioBuffer): number {
  let pk = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > pk) pk = a; }
  }
  return pk;
}

