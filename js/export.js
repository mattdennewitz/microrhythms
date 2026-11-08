/* Export: offline-rendered WAV of the mix, or a ZIP of per-plate stems. */
(function (MR) {
  'use strict';

  /** 24-bit PCM WAV. */
  function encodeWav(buffer) {
    const ch = buffer.numberOfChannels, sr = buffer.sampleRate, n = buffer.length;
    const bytes = 3;
    const dataLen = n * ch * bytes;
    const ab = new ArrayBuffer(44 + dataLen);
    const v = new DataView(ab);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + dataLen, true); str(8, 'WAVE');
    str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true);
    v.setUint32(24, sr, true); v.setUint32(28, sr * ch * bytes, true); v.setUint16(32, ch * bytes, true); v.setUint16(34, 24, true);
    str(36, 'data'); v.setUint32(40, dataLen, true);
    const chans = [];
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
  function crc32(data) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function zip(files) {
    const enc = new TextEncoder();
    const parts = [], central = [];
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
  function foldLoop(buf, seconds) {
    const n = Math.round(seconds * buf.sampleRate);
    const out = new AudioBuffer({ length: n, numberOfChannels: buf.numberOfChannels, sampleRate: buf.sampleRate });
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const src = buf.getChannelData(c), dst = out.getChannelData(c);
      for (let i = 0; i < src.length; i++) dst[i % n] += src[i];
      for (let i = 0; i < n; i++) dst[i] = Math.max(-1, Math.min(1, dst[i]));
    }
    return out;
  }

  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  const exporter = {
    phrases: 1,
    mode: 'loop',      // 'loop' | 'tail'
    busy: false,
    last: null,        // last result, kept for tests

    seconds() { return this.phrases * MR.stack.phraseBars * 4 * 60 / MR.engine.bpm; },
    baseName(plan) {
      const bar = plan ? Math.floor(plan.startBeat / 4) + 1 : 1;
      return `orbital-${Math.round(MR.engine.bpm)}bpm-${this.phrases * MR.stack.phraseBars}bars-from${bar}${plan && plan.flight ? '-flight' : ''}`;
    },

    /** What to render so the file is what you hear: while playing, from the start of
     *  the current phrase with the plates exactly as they are moving (and the ship, in
     *  flight); when stopped, from bar 1. */
    plan() {
      const E = MR.engine, S = MR.stack;
      const phraseBeats = 4 * S.phraseBars;
      const playing = E.playing && E.ctx;
      const startBeat = playing ? Math.floor(E.songBeat(E.ctx.currentTime) / phraseBeats) * phraseBeats : 0;
      const motions = playing ? new Map(S.plates.map((p) => [p, p.motion.map((m) => Object.assign({}, m))])) : null;
      const flight = MR.flight.on ? MR.flight.exportCtx(startBeat) : null;
      const listenerPose = flight ? null : E.listenerPose(MR.view);
      return { startBeat, motions, flight, listenerPose: listenerPose && { pos: listenerPose.pos.slice(), fwd: listenerPose.fwd.slice(), up: listenerPose.up.slice() } };
    },

    async render(onlyPlate, plan) {
      const L = this.seconds();
      const pl = plan || this.plan();
      const buf = await MR.engine.renderOffline(Object.assign({ seconds: L, tail: 4, onlyPlate }, pl));
      return this.mode === 'loop' ? foldLoop(buf, L) : buf;
    },

    describe(plan) {
      const bar = Math.floor(plan.startBeat / 4) + 1;
      return `from bar ${bar}${plan.flight ? ` · flight, ${plan.flight.where}` : ''}`;
    },

    async exportWav({ save = true } = {}) {
      if (this.busy) return null;
      this.busy = true;
      try {
        const plan = this.plan();
        const buf = await this.render(null, plan);
        const wav = encodeWav(buf);
        const name = `${this.baseName(plan)}${this.mode === 'loop' ? '-loop' : ''}.wav`;
        this.last = { name, wav, length: buf.length, sampleRate: buf.sampleRate, peak: peakOf(buf), from: this.describe(plan) };
        if (save) download(new Blob([wav], { type: 'audio/wav' }), name);
        return this.last;
      } finally { this.busy = false; }
    },

    async exportStems({ save = true, onProgress } = {}) {
      if (this.busy) return null;
      this.busy = true;
      try {
        const anySolo = MR.stack.anySolo();
        const plates = MR.stack.plates.filter((p) => p.audible(anySolo));
        const files = [];
        const plan = this.plan(); // one plan for every stem, so they sum to the mix
        for (let i = 0; i < plates.length; i++) {
          if (onProgress) onProgress(i, plates.length, plates[i].name);
          const buf = await this.render(plates[i], plan);
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

  function peakOf(buf) {
    let pk = 0;
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > pk) pk = a; }
    }
    return pk;
  }

  MR.exporter = exporter;
})(window.MR);
