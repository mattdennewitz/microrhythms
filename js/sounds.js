/* Sound library: synthesized built-in sources + user-added samples.
 * Every chip pulls its fragment from one of these buffers. */
(function (MR) {
  'use strict';
  const { mulberry32, clamp } = MR.util;
  const SR = 48000;
  const MAX_SECONDS = 90;

  function makeBuffer(data, sr = SR) {
    const buf = new AudioBuffer({ length: data.length, numberOfChannels: 1, sampleRate: sr });
    buf.copyToChannel(data, 0);
    return buf;
  }

  function normalize(d, peak = 0.9, maxGain = Infinity) {
    let m = 0;
    for (let i = 0; i < d.length; i++) m = Math.max(m, Math.abs(d[i]));
    if (m > 0) { const g = Math.min(peak / m, maxGain); for (let i = 0; i < d.length; i++) d[i] *= g; }
    return d;
  }

  // ---------------------------------------------------------------- synths
  const synth = {
    GLASS(rnd) {
      const d = new Float32Array(SR * 2.6);
      const notes = [72, 75, 79, 82, 77, 84, 70];
      notes.forEach((n, j) => {
        const f = 440 * Math.pow(2, (n - 69) / 12);
        const start = Math.floor(j * 0.36 * SR);
        const partials = [[1, 1, 1.6], [2.76, 0.5, 0.9], [5.4, 0.3, 0.5], [8.93, 0.18, 0.28]];
        for (let i = 0; i < SR * 1.6 && start + i < d.length; i++) {
          const t = i / SR;
          let s = 0;
          for (const [r, a, dec] of partials) s += a * Math.sin(6.2832 * f * r * t) * Math.exp(-t / dec * 3);
          d[start + i] += s * Math.min(1, t * 800);
        }
      });
      return normalize(d);
    },
    TICK(rnd) {
      const d = new Float32Array(SR * 2);
      for (let k = 0; k < 64; k++) {
        const start = Math.floor(rnd() * (d.length - 800));
        const f = 1500 + rnd() * 7000;
        const dec = 0.0006 + rnd() * 0.004;
        const noisy = rnd() < 0.5;
        const amp = 0.3 + rnd() * 0.7;
        for (let i = 0; i < 800; i++) {
          const t = i / SR;
          const e = Math.exp(-t / dec);
          const s = noisy ? (rnd() * 2 - 1) : Math.sin(6.2832 * f * t);
          d[start + i] += amp * s * e;
        }
      }
      return normalize(d);
    },
    BREATH(rnd) {
      const d = new Float32Array(SR * 3);
      // state-variable bandpass sweeping over noise
      let low = 0, band = 0;
      for (let i = 0; i < d.length; i++) {
        const t = i / d.length;
        const fc = 300 + 2600 * (0.5 - 0.5 * Math.cos(t * 6.2832 * 1.5));
        const f = 2 * Math.sin(Math.PI * fc / SR);
        const q = 0.35;
        const x = rnd() * 2 - 1;
        low += f * band;
        const high = x - low - q * band;
        band += f * high;
        const env = Math.sin(Math.PI * t) ** 0.6 * (0.6 + 0.4 * Math.sin(t * 40));
        d[i] = band * env;
      }
      return normalize(d);
    },
    WOOD(rnd) {
      const d = new Float32Array(SR * 2);
      for (let j = 0; j < 9; j++) {
        const start = Math.floor(j * 0.21 * SR);
        const f = 180 + rnd() * 520;
        const modes = [[1, 1, 0.09], [2.57, 0.5, 0.05], [4.2, 0.25, 0.03], [6.9, 0.12, 0.015]];
        for (let i = 0; i < SR * 0.3 && start + i < d.length; i++) {
          const t = i / SR;
          let s = 0;
          for (const [r, a, dec] of modes) s += a * Math.sin(6.2832 * f * r * t) * Math.exp(-t / dec);
          d[start + i] += s;
        }
      }
      return normalize(d);
    },
    SUB(rnd) {
      const d = new Float32Array(SR * 1.6);
      for (let j = 0; j < 4; j++) {
        const start = Math.floor(j * 0.4 * SR);
        let ph = 0;
        for (let i = 0; i < SR * 0.4 && start + i < d.length; i++) {
          const t = i / SR;
          const f = 42 + 110 * Math.exp(-t * 28);
          ph += 6.2832 * f / SR;
          const click = i < 90 ? (rnd() * 2 - 1) * 0.25 * (1 - i / 90) : 0;
          d[start + i] += Math.sin(ph) * Math.exp(-t * 7) + click;
        }
      }
      return normalize(d);
    },
    WIRE(rnd) {
      const d = new Float32Array(SR * 3);
      const notes = [45, 52, 57, 60, 55, 64];
      notes.forEach((n, j) => {
        const f = 440 * Math.pow(2, (n - 69) / 12);
        const N = Math.round(SR / f);
        const ring = new Float32Array(N);
        for (let i = 0; i < N; i++) ring[i] = rnd() * 2 - 1;
        const start = Math.floor(j * 0.5 * SR);
        let idx = 0;
        for (let i = 0; i < SR * 1.2 && start + i < d.length; i++) {
          const nxt = (idx + 1) % N;
          const v = 0.4985 * (ring[idx] + ring[nxt]);
          d[start + i] += ring[idx];
          ring[idx] = v;
          idx = nxt;
        }
      });
      return normalize(d);
    },
    CLOUD(rnd) {
      const d = new Float32Array(SR * 3);
      const chord = [57, 60, 64, 67, 71, 74, 76, 79];
      for (let g = 0; g < 360; g++) {
        const n = chord[Math.floor(rnd() * chord.length)] + (rnd() < 0.2 ? 12 : 0);
        const f = 440 * Math.pow(2, (n - 69) / 12) * (1 + (rnd() - 0.5) * 0.004);
        const len = Math.floor((0.02 + rnd() * 0.07) * SR);
        const start = Math.floor(rnd() * (d.length - len));
        const amp = 0.2 + rnd() * 0.8;
        for (let i = 0; i < len; i++) {
          const w = 0.5 - 0.5 * Math.cos(6.2832 * i / len);
          d[start + i] += amp * w * Math.sin(6.2832 * f * i / SR);
        }
      }
      return normalize(d);
    },
    METAL(rnd) {
      const d = new Float32Array(SR * 2);
      const ratios = [1, 1.41, 2.23, 2.93, 3.61, 4.7, 5.81];
      for (let j = 0; j < 3; j++) {
        const start = Math.floor(j * 0.62 * SR);
        const f = 220 + rnd() * 330;
        for (let i = 0; i < SR * 1.2 && start + i < d.length; i++) {
          const t = i / SR;
          let s = 0;
          ratios.forEach((r, k) => { s += Math.sin(6.2832 * f * r * t + k) / (k + 1) * Math.exp(-t * (2 + k * 1.3)); });
          s *= 0.6 + 0.4 * Math.sin(6.2832 * 31 * t);
          d[start + i] += s * Math.min(1, t * 2000);
        }
      }
      return normalize(d);
    },
    VOWEL(rnd) {
      const d = new Float32Array(SR * 3);
      // sawtooth voice through two moving formants: a - e - i - o - u
      const F = [[800, 1150], [400, 1600], [300, 2300], [450, 800], [325, 700]];
      const bp = () => ({ l: 0, b: 0 });
      const f1 = bp(), f2 = bp();
      let ph = 0;
      for (let i = 0; i < d.length; i++) {
        const t = i / d.length;
        const pos = t * (F.length - 1);
        const a = Math.floor(pos), fr = pos - a;
        const b = Math.min(F.length - 1, a + 1);
        const c1 = F[a][0] + (F[b][0] - F[a][0]) * fr;
        const c2 = F[a][1] + (F[b][1] - F[a][1]) * fr;
        const pitch = 110 * (1 + 0.012 * Math.sin(i / SR * 6.2832 * 5.5)) * (t < 0.5 ? 1 : 1.335);
        ph += pitch / SR; if (ph > 1) ph -= 1;
        const x = (ph * 2 - 1) + (rnd() - 0.5) * 0.05;
        const run = (st, fc, q) => {
          const f = 2 * Math.sin(Math.PI * fc / SR);
          st.l += f * st.b; const h = x - st.l - q * st.b; st.b += f * h; return st.b;
        };
        const env = Math.min(1, t * 30) * Math.min(1, (1 - t) * 30);
        d[i] = (run(f1, c1, 0.12) + 0.6 * run(f2, c2, 0.1)) * env;
      }
      return normalize(d);
    },
  };

  // Waveform overview (min/max per bin) for list thumbnails.
  function peaks(buffer, bins = 96) {
    const d = buffer.getChannelData(0);
    const step = Math.max(1, Math.floor(d.length / bins));
    const out = [];
    for (let b = 0; b < bins; b++) {
      let mn = 0, mx = 0;
      const s0 = b * step, s1 = Math.min(d.length, s0 + step);
      for (let i = s0; i < s1; i += 4) { const v = d[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
      out.push([mn, mx]);
    }
    return out;
  }

  /** Onset times (seconds) by energy-flux peak picking; always includes 0. */
  function detectOnsets(buffer) {
    const d = buffer.getChannelData(0);
    const sr = buffer.sampleRate;
    const hop = Math.max(64, Math.round(sr * 0.005));
    const frames = Math.floor(d.length / hop);
    const env = new Float32Array(frames);
    for (let f = 0; f < frames; f++) {
      let s = 0;
      const o = f * hop;
      for (let i = 0; i < hop; i++) { const v = d[o + i]; s += v * v; }
      env[f] = Math.sqrt(s / hop);
    }
    const flux = new Float32Array(frames);
    for (let f = 1; f < frames; f++) flux[f] = Math.max(0, env[f] - env[f - 1]);
    let peak = 0, maxEnv = 0;
    for (let f = 0; f < frames; f++) { peak = Math.max(peak, flux[f]); maxEnv = Math.max(maxEnv, env[f]); }
    // every peak above a local + absolute threshold, then the strongest 255 in time order
    const cand = [];
    const W = 10, minGap = Math.round(0.05 * sr / hop);
    let last = -minGap;
    for (let f = 1; f < frames - 1; f++) {
      if (flux[f] < flux[f - 1] || flux[f] < flux[f + 1]) continue;
      let m = 0, n = 0;
      for (let k = Math.max(0, f - W); k < Math.min(frames, f + W); k++) { m += flux[k]; n++; }
      const thr = Math.max((m / n) * 1.6 + peak * 0.06, 0.02 * maxEnv);
      if (flux[f] > thr && f - last >= minGap) {
        const t = Math.max(0, (f - 1) * hop / sr);
        if (t > 0.01) cand.push({ t, s: flux[f] });
        last = f;
      }
    }
    // too many: drop the weakest half, then sample evenly in time so the whole file is reachable
    let pool = cand;
    if (pool.length > 255) {
      const sorted = pool.slice().sort((a, b) => b.s - a.s);
      const floor = sorted[Math.min(sorted.length - 1, 510)].s;
      pool = pool.filter((c) => c.s >= floor);
    }
    const keep = [];
    if (pool.length > 255) for (let i = 0; i < 255; i++) keep.push(pool[Math.floor((i * pool.length) / 255)]);
    else keep.push(...pool);
    return [0].concat(keep.map((c) => c.t));
  }

  /** Mono-ise, trim silence, cap length, normalise. */
  function condition(buffer) {
    const ch = buffer.numberOfChannels;
    const len = Math.min(buffer.length, Math.floor(buffer.sampleRate * MAX_SECONDS));
    const mono = new Float32Array(len);
    for (let c = 0; c < ch; c++) {
      const d = buffer.getChannelData(c);
      for (let i = 0; i < len; i++) mono[i] += d[i] / ch;
    }
    // remove DC so trimming and normalising act on the signal, not an offset
    let mean = 0;
    for (let i = 0; i < len; i++) mean += mono[i];
    mean /= Math.max(1, len);
    if (mean) for (let i = 0; i < len; i++) mono[i] -= mean;
    let peak = 0;
    for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(mono[i]));
    if (peak < 1e-3) throw new Error('sound is silent or too short'); // below about −60 dBFS
    const thr = peak * 0.004;
    let a = 0, b = len - 1;
    while (a < len && Math.abs(mono[a]) < thr) a++;
    while (b > a && Math.abs(mono[b]) < thr) b--;
    const trimmed = mono.slice(Math.max(0, a - 64), Math.min(len, b + 64));
    if (trimmed.length < 64) throw new Error('sound is silent or too short');
    normalize(trimmed, 0.92, 100); // at most +40 dB, so a near-silent take isn't blown up into noise
    return makeBuffer(trimmed, buffer.sampleRate);
  }

  const sounds = {
    list: [],
    nextId: 1,
    listeners: new Set(),
    onChange(fn) { this.listeners.add(fn); },
    emit() { this.listeners.forEach((fn) => fn()); },

    initBuiltins() {
      const rnd = mulberry32(20261107);
      for (const name of Object.keys(synth)) this.add(name, makeBuffer(synth[name](rnd)), true, false);
      // resolve plate source names to ids
      for (const p of MR.stack.plates) {
        p.sourceIds = new Set(p.sources.map((n) => this.byName(n)).filter(Boolean).map((s) => s.id));
      }
      this.emit();
    },

    byName(name) { return this.list.find((s) => s.name === name); },
    get(id) { return this.list.find((s) => s.id === id); },

    add(name, buffer, builtin = false, emit = true) {
      let nm = name, k = 2;
      while (this.byName(nm)) nm = `${name} ${k++}`;
      const snd = { id: this.nextId++, name: nm, buffer, builtin, enabled: true, peaks: peaks(buffer), onsets: detectOnsets(buffer) };
      this.list.push(snd);
      if (emit) this.emit();
      return snd;
    },

    /** Add a user sound and feed it to every plate (rhythms are preserved). */
    addUser(name, buffer) {
      const snd = this.add(name, condition(buffer));
      MR.stack.plates.forEach((p) => p.sourceIds.add(snd.id));
      this.emit();
      return snd;
    },

    async addFile(file) {
      const ctx = MR.engine.ensureCtx();
      const arr = await file.arrayBuffer();
      const buf = await new Promise((res, rej) => {
        const p = ctx.decodeAudioData(arr, res, rej);
        if (p && p.then) p.then(res, rej);
      });
      const base = file.name.replace(/\.[^.]+$/, '').toUpperCase().slice(0, 18) || 'SAMPLE';
      return this.addUser(base, buf);
    },

    remove(id) {
      const s = this.get(id);
      if (!s || s.builtin) return;
      this.list = this.list.filter((x) => x.id !== id);
      MR.stack.plates.forEach((p) => p.sourceIds.delete(id));
      this.emit();
    },

    /** Reversed copy of a sound's buffer, built once and cached. */
    reversed(snd) {
      if (!snd.rev) {
        const src = snd.buffer.getChannelData(0);
        const r = new Float32Array(src.length);
        for (let i = 0, n = src.length; i < n; i++) r[i] = src[n - 1 - i];
        snd.rev = makeBuffer(r, snd.buffer.sampleRate);
      }
      return snd.rev;
    },

    setEnabled(id, on) { const s = this.get(id); if (s) { s.enabled = on; this.emit(); } },
    setAllBuiltins(on) { this.list.forEach((s) => { if (s.builtin) s.enabled = on; }); this.emit(); },

    /** Sounds a plate samples from. Falls back to every enabled sound. */
    poolFor(plate) {
      let pool = this.list.filter((s) => s.enabled && plate.sourceIds.has(s.id));
      if (!pool.length) pool = this.list.filter((s) => s.enabled);
      return pool;
    },

    togglePlateSource(plate, id) {
      if (plate.sourceIds.has(id)) plate.sourceIds.delete(id); else plate.sourceIds.add(id);
      this.emit();
    },

    peaks, condition, detectOnsets, makeBuffer,
  };

  MR.sounds = sounds;
})(window.MR);
