/* Audio engine: beat clock, lookahead scheduler, grain voices, spatial graph.
 *
 * Song position in beats is a piecewise-linear function of AudioContext time
 * (the clock). Plate angle is a piecewise-linear function of beats. Every tick
 * computes, analytically, the beats inside the lookahead window at which each
 * chip's rotating angle crosses a read head, converts them to audio time, and
 * schedules a windowed grain there through an HRTF panner placed at the chip's
 * position in the stack. Queued scene / phrase switches split the window at
 * their exact beat, so they land sample-accurately on bar lines.
 */
(function (MR) {
  'use strict';
  const { TAU, clamp, mulberry32 } = MR.util;

  const LOOKAHEAD = 0.12;   // seconds scheduled ahead
  const TICK_MS = 25;

  const engine = {
    ctx: null,
    playing: false,
    offline: false,
    bpm: 112,
    masterLevel: 0.9,
    spaceLevel: 0.28,
    panModel: 'HRTF',
    earMode: 'camera',      // 'camera' (listener rides the camera) | 'fixed'
    evolveAmount: 0,        // 0..1 chance per bar of a generative change
    fxOn: true,
    fxWet: 0.5,
    maxVoices: 96,
    voices: 0,
    active: new Set(),
    lastScheduled: 0,
    startDelay: 0.06,       // PLAY starts bar 1 this long after the press
    clock: [{ t0: 0, b0: 0, bps: 112 / 60 }],
    nextBarBeat: 4,
    pending: [],            // queued switches {beat, kind, apply, label}
    events: [],             // visual events {t, plate, chip}
    lastVoice: new Map(),   // plate -> last voice (for choke)
    stats: { triggers: 0, dropped: 0, scheduled: 0 },
    buses: [],
    timer: null,
    // Chance rolls hash (session seed, plate, chip, beat): live playback varies beat to
    // beat, and an export of the same beats reproduces exactly the hits you heard.
    rollSeed: (Math.random() * 4294967296) >>> 0,
    sensorCursor: null,     // ship pose that ended the last scheduled window
    motions: null,          // per-plate motion override (offline render)
    onlyPlate: null,        // render a single plate (stems)
    trace: null,            // optional array of scheduled grains (tests)
    onEvolve: null,
    onSwitch: null,


    /** Flight parameters in force for this engine: the live ship, or the export's
     *  frozen copy of it. null when not flying. */
    flightCtx() {
      if (this.offline) return this.flightRender || null;
      return MR.flight && MR.flight.on ? MR.flight.liveCtx() : null;
    },

    // ------------------------------------------------------------ graph
    ensureCtx() {
      if (this.ctx) return this.ctx;
      const AC = window.AudioContext || window.webkitAudioContext;
      const ctx = new AC({ latencyHint: 'interactive' });
      this.ctx = ctx;
      Object.assign(this, this.buildGraph(ctx));
      return ctx;
    },

    /** Build the whole output graph on any (realtime or offline) context. */
    buildGraph(ctx) {
      const g = {};
      g.master = ctx.createGain();
      g.master.gain.value = this.masterLevel;
      g.comp = ctx.createDynamicsCompressor();
      g.comp.threshold.value = -16;
      g.comp.knee.value = 12;
      g.comp.ratio.value = 3.5;
      g.comp.attack.value = 0.004;
      g.comp.release.value = 0.22;
      g.makeup = ctx.createGain();
      g.makeup.gain.value = 1.5; // make-up gain after the glue compressor
      // brick-wall limiter, then a soft clipper so the output can never exceed ±1
      g.limiter = ctx.createDynamicsCompressor();
      g.limiter.threshold.value = -3;
      g.limiter.knee.value = 0;
      g.limiter.ratio.value = 20;
      g.limiter.attack.value = 0.001;
      g.limiter.release.value = 0.08;
      g.out = ctx.createWaveShaper();
      const N = 2048, curve = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        const x = (i / (N - 1)) * 2 - 1;
        curve[i] = Math.abs(x) < 0.8 ? x : Math.sign(x) * (0.8 + 0.2 * Math.tanh((Math.abs(x) - 0.8) / 0.2));
      }
      g.out.curve = curve;
      g.analyser = ctx.createAnalyser();
      g.analyser.fftSize = 1024;
      g.master.connect(g.comp).connect(g.makeup).connect(g.limiter).connect(g.out);
      g.out.connect(ctx.destination);
      g.out.connect(g.analyser);

      // "space": generated convolution reverb
      g.reverb = ctx.createConvolver();
      g.reverb.buffer = this.makeImpulse(ctx, 3.4);
      g.revIn = ctx.createGain();
      g.revOut = ctx.createGain();
      g.revOut.gain.value = this.spaceLevel;
      g.revIn.connect(g.reverb).connect(g.revOut).connect(g.master);

      // "throw": tempo-synced feedback delay fed by throw-FX chips
      g.throwIn = ctx.createGain();
      g.throwIn.gain.value = this.fxWet;
      g.delay = ctx.createDelay(4);
      g.delay.delayTime.value = this.delayTime();
      g.delayTone = ctx.createBiquadFilter();
      g.delayTone.type = 'lowpass';
      g.delayTone.frequency.value = 3800;
      g.delayFb = ctx.createGain();
      g.delayFb.gain.value = 0.45;
      g.throwIn.connect(g.delay).connect(g.delayTone).connect(g.delayFb).connect(g.delay);
      g.delayTone.connect(g.master);
      const toRev = ctx.createGain();
      toRev.gain.value = 0.35;
      g.delayTone.connect(toRev).connect(g.revIn);

      g.buses = MR.stack.plates.map(() => this.makeBus(ctx, g));
      return g;
    },

    makeBus(ctx, g) {
      const input = ctx.createGain();
      const tone = ctx.createBiquadFilter();
      tone.type = 'lowpass';
      tone.frequency.value = 16000;
      tone.Q.value = 0.4;
      const level = ctx.createGain();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      const send = ctx.createGain();
      send.gain.value = 0.9;
      input.connect(tone).connect(level);
      level.connect(g.master);
      level.connect(analyser);
      level.connect(send).connect(g.revIn);
      return { input, tone, level, analyser, send, buf: new Float32Array(256) };
    },

    makeImpulse(ctx, seconds) {
      const len = Math.floor(ctx.sampleRate * seconds);
      const ir = ctx.createBuffer(2, len, ctx.sampleRate);
      const rnd = mulberry32(3417);
      for (let c = 0; c < 2; c++) {
        const d = ir.getChannelData(c);
        for (let i = 0; i < len; i++) {
          const t = i / len;
          d[i] = (rnd() * 2 - 1) * Math.pow(1 - t, 3.2) * (i < 200 ? i / 200 : 1);
        }
        for (let k = 0; k < 8; k++) {
          const at = Math.floor((0.008 + rnd() * 0.07) * ctx.sampleRate);
          d[at] += (rnd() < 0.5 ? -1 : 1) * (0.5 - k * 0.05);
        }
      }
      return ir;
    },

    delayTime() { return 0.75 * 60 / this.bpm; }, // dotted eighth

    // ------------------------------------------------------------ beat clock
    seg(list, key, v) {
      let s = list[0];
      for (let i = list.length - 1; i >= 0; i--) { if (list[i][key] <= v) { s = list[i]; break; } }
      return s;
    },
    beatAt(t) { const s = this.seg(this.clock, 't0', t); return s.b0 + (t - s.t0) * s.bps; },
    timeAtBeat(B) { const s = this.seg(this.clock, 'b0', B); return s.t0 + (B - s.b0) / s.bps; },
    bpsAt(t) { return this.seg(this.clock, 't0', t).bps; },
    horizon() { return Math.max(this.ctx.currentTime, this.lastScheduled); },
    horizonBeat() { return this.beatAt(this.horizon()); },
    /** Song position for display: beats since PLAY (0 when stopped). */
    songBeat(tv) { return this.playing ? Math.max(0, this.beatAt(tv)) : 0; },

    // ------------------------------------------------------------ transport
    async start() {
      const ctx = this.ensureCtx();
      if (ctx.state !== 'running') { try { await ctx.resume(); } catch (e) { /* gesture needed */ } }
      if (this.playing) return;
      const t = ctx.currentTime + this.startDelay;
      this.clock = [{ t0: t, b0: 0, bps: this.bpm / 60 }];
      MR.stack.plates.forEach((p) => p.startMotion());
      this.lastScheduled = t;
      this.nextBarBeat = 4;
      this.lastVoice.clear();
      this.sensorCursor = null;
      this.playing = true;
      // the flight path switches to the audio clock before the first tick reads it
      if (MR.flight && MR.flight.on) MR.flight.clockChanged();
      this.startTimer();
    },

    stop() {
      if (!this.playing) return;
      const B = this.beatAt(this.ctx.currentTime);
      MR.stack.plates.forEach((p) => p.stopMotion(B));
      this.playing = false;
      if (MR.flight && MR.flight.on) MR.flight.clockChanged();
      this.stopTimer();
      this.active.forEach((src) => { try { src.stop(); } catch (e) { /* already stopped */ } });
      this.active.clear();
      this.voices = 0;
      this.events = [];
      // queued switches apply immediately rather than being lost
      const pend = this.pending;
      this.pending = [];
      pend.forEach((sw) => { sw.apply(); if (this.onSwitch) this.onSwitch(sw); });
    },

    toggle() { return this.playing ? (this.stop(), false) : (this.start(), true); },

    startTimer() {
      this.stopTimer();
      // A worker-driven clock keeps scheduling alive in background tabs.
      try {
        const src = `let id=null;onmessage=e=>{if(e.data==='start'){clearInterval(id);id=setInterval(()=>postMessage(0),${TICK_MS});}else{clearInterval(id);}}`;
        const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
        w.onmessage = () => this.tick();
        w.onerror = () => {   // blob workers can fail asynchronously (e.g. on file://)
          w.terminate();
          if (!this.playing) return;
          const id = setInterval(() => this.tick(), TICK_MS);
          this.timer = { stop: () => clearInterval(id) };
        };
        w.postMessage('start');
        this.timer = { stop: () => { w.postMessage('stop'); w.terminate(); } };
      } catch (e) {
        const id = setInterval(() => this.tick(), TICK_MS);
        this.timer = { stop: () => clearInterval(id) };
      }
      this.tick();
    },
    stopTimer() { if (this.timer) { this.timer.stop(); this.timer = null; } },

    /** Re-anchor plate motion at the scheduling horizon after a speed change.
     *  'align' snaps to the song grid; 'continuous' avoids any angle jump. */
    retime(plate, mode = 'align') {
      if (!this.ctx || !this.playing) return;
      const Bh = this.horizonBeat();
      const plates = plate ? [plate] : MR.stack.plates;
      plates.forEach((p) => (mode === 'align' ? p.align(Bh) : p.retimeContinuous(Bh)));
    },

    /** Change state now; future scheduling (from the horizon) uses it. */
    applyNow(fn, alignPlates) {
      const before = this.timingSigs();
      fn();
      if (alignPlates === false || !this.ctx || !this.playing) return;
      const Bh = this.horizonBeat();
      this.changedTiming(before).forEach((p) => p.align(Bh));
    },

    /** Per-plate timing signature: plates whose grid/phase/speed didn't change
     *  are left alone (so a drifting plate isn't snapped by edits elsewhere). */
    timingSigs() { return MR.stack.plates.map((p) => `${p.phase0}|${p.omega()}|${p.steps}`); },
    changedTiming(before) { return MR.stack.plates.filter((p, i) => this.timingSigs()[i] !== before[i]); },

    /** Change state on the next bar or phrase line. One pending switch per kind. */
    queue(kind, quant, apply, label) {
      this.pending = this.pending.filter((p) => p.kind !== kind);
      if (!this.playing) { apply(); return null; }
      const B = this.horizonBeat();
      const unit = quant === 'phrase' ? 4 * MR.stack.phraseBars : 4;
      const beat = Math.ceil((B + 1e-6) / unit) * unit;
      const sw = { kind, beat, apply, label, quant };
      this.pending.push(sw);
      return sw;
    },
    cancel(kind) { this.pending = this.pending.filter((p) => p.kind !== kind); },
    pendingOf(kind) { return this.pending.find((p) => p.kind === kind) || null; },

    setBpm(v) {
      this.bpm = clamp(v, 30, 240);
      if (this.ctx) this.delay.delayTime.setTargetAtTime(this.delayTime(), this.ctx.currentTime, 0.05);
      if (!this.ctx || !this.playing) return;
      const tH = this.horizon();
      const B = this.beatAt(tH);
      this.clock = this.clock.filter((s) => s.t0 < tH);
      this.clock.push({ t0: tH, b0: B, bps: this.bpm / 60 });
    },
    setMaster(v) { this.masterLevel = v; if (this.ctx) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.03); },
    setSpace(v) { this.spaceLevel = v; if (this.ctx) this.revOut.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05); },
    setFxWet(v) { this.fxWet = v; if (this.ctx) this.throwIn.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05); },

    // ------------------------------------------------------------ scheduler
    tick() {
      if (!this.playing) return;
      const now = this.ctx.currentTime;
      let a = this.lastScheduled;
      if (a < now) a = now; // fell behind (tab suspended): skip rather than burst
      const b = now + LOOKAHEAD;
      if (b <= a) return;
      this.scheduleRange(a, b);
      this.lastScheduled = b;

      const Bb = this.beatAt(b);
      if (Bb >= this.nextBarBeat) {
        this.nextBarBeat = (Math.floor(Bb / 4) + 1) * 4;
        if (this.evolveAmount > 0) {
          const p = MR.stack.evolve(this.evolveAmount);
          if (p && this.onEvolve) this.onEvolve(p);
        }
      }
      while (this.clock.length > 1 && this.clock[1].t0 < now - 30) this.clock.shift();
      if (this.events.length > 4000) this.events.splice(0, this.events.length - 4000);
    },

    /** Schedule [ta, tb), applying any queued switch exactly at its beat. */
    scheduleRange(ta, tb) {
      let Ba = this.beatAt(ta);
      const Bb = this.beatAt(tb);
      this.pending.sort((x, y) => x.beat - y.beat);
      while (this.pending.length && this.pending[0].beat < Bb) {
        const sw = this.pending.shift();
        const Bs = Math.max(sw.beat, Ba);
        this.scheduleBeats(Ba, Bs);
        const before = this.timingSigs();
        sw.apply();
        this.changedTiming(before).forEach((p) => p.align(Bs));
        sw.appliedAt = this.timeAtBeat(Bs);
        if (this.onSwitch) this.onSwitch(sw);
        Ba = Bs;
      }
      this.scheduleBeats(Ba, Bb);
    },

    scheduleBeats(Ba, Bb) {
      if (Bb <= Ba) return;
      const anySolo = MR.stack.anySolo();
      for (const p of MR.stack.plates) {
        if (this.onlyPlate ? p !== this.onlyPlate : !p.audible(anySolo)) continue;
        this.schedulePlate(p, Ba, Bb);
      }
      // the ship is a moving read head (live, or replayed by an export)
      const fc = this.flightCtx();
      if (fc) MR.flight.schedule(this, Ba, Bb, fc);
    },

    /** Find every head crossing of every chip in beats [Ba, Bb), fire in time order. */
    schedulePlate(p, Ba, Bb) {
      const heads = p.headAngles();
      const m = this.motions ? this.motions.get(p) : p.motion;
      const hits = [];
      for (let si = 0; si < m.length; si++) {
        const seg = m[si];
        const segEnd = si + 1 < m.length ? m[si + 1].b0 : Infinity;
        const sa = Math.max(Ba, seg.b0), sb = Math.min(Bb, segEnd);
        if (sb <= sa || seg.w === 0) continue;
        const phiA = seg.phi0 + seg.w * (sa - seg.b0);
        const phiB = seg.phi0 + seg.w * (sb - seg.b0);
        // Scan a slightly widened phase range, then keep hits whose snapped beat
        // lies in [sa, sb). Adjacent windows share endpoints exactly, so every
        // crossing lands in exactly one window whatever the spin direction.
        const lo = Math.min(phiA, phiB) - 1e-6, hi = Math.max(phiA, phiB) + 1e-6;
        for (let h = 0; h < heads.length; h++) {
          const hθ = heads[h];
          for (let ci = 0; ci < p.chips.length; ci++) {
            const c = p.chips[ci];
            const target = hθ - c.angle;
            let v = target + TAU * Math.ceil((lo - target) / TAU);
            while (v < hi) {
              const B = Math.round((sa + (v - phiA) / seg.w) * 1e9) / 1e9;
              if (B >= sa && B < sb && !MR.stack.restAt(p, B)) hits.push({ B, c, h: hθ });
              v += TAU;
            }
          }
        }
      }
      hits.sort((x, y) => x.B - y.B);
      const fcm = this.flightCtx();
      const mix = fcm ? fcm.headMix : 1;
      if (mix <= 0) return;
      for (const hit of hits) this.fire(p, hit.c, this.timeAtBeat(hit.B), hit.h, hit.B, mix);
    },

    /** Chance roll. Offline renders hash (seed, plate, chip, beat) so a stem
     *  rolls exactly like the same plate inside the full mix. */
    roll(p, c, B) {
      const h = (this.rollSeed ^ p.seed ^ Math.imul(c.key + 1, 0x27d4eb2d) ^ Math.imul(Math.round(B * 1000) + 7, 0x165667b1)) >>> 0;
      return mulberry32(h)();
    },

    fire(p, c, t, headAngle, B, gainMul = 1, extra = null) {
      this.stats.scheduled++;
      const sensor = !!(extra && extra.sensor);
      const fc = this.flightCtx();
      // every asteroid the ship passes sounds, unless flight is set to respect plate chance
      const useChance = !sensor || (fc && fc.useChance);
      if (useChance && this.roll(p, c, B) > p.probFor(c)) return;
      // in flight, a fixed-head grain is as loud as it is close to the ship
      if (!sensor && fc) {
        gainMul *= MR.flight.proximityAt(fc.shipAt(t), p, c, headAngle, fc.falloff);
        if (gainMul < 0.004) return; // inaudible: don't spend a voice on it
      }
      const fx = this.fxOn ? c.fx : null;
      if (fx === 'ratchet' || fx === 'stutter') {
        const n = c.fxN;
        const sub = (p.stepBeats / this.bpsAt(t)) / n;
        const stepSemis = [3, 5, -2, -5][(c.srcPick >> 3) % 4];
        for (let k = 0; k < n; k++) {
          const tk = t + k * sub;
          const ok = this.playGrain(p, c, tk, headAngle, {
            maxDur: sub * 0.92, gainMul: gainMul * (1 - k * 0.12), semis: fx === 'stutter' ? k * stepSemis : 0, extra,
          });
          if (ok && !this.offline) this.events.push({ t: tk, plate: p, chip: c, sensor });
        }
        return;
      }
      if (this.playGrain(p, c, t, headAngle, { reverse: fx === 'reverse', throw: fx === 'throw', gainMul, extra }) && !this.offline) {
        this.events.push({ t, plate: p, chip: c, sensor });
      }
    },

    grainCurve(dur, amp, fadeIn, fadeOut) {
      const N = 48;
      const curve = new Float32Array(N);
      let fi = Math.max(fadeIn, 0.0015 / dur), fo = Math.max(fadeOut, 0.0015 / dur);
      if (fi + fo > 1) { const s = 1 / (fi + fo); fi *= s; fo *= s; }
      for (let i = 0; i < N; i++) {
        const x = i / (N - 1);
        let w = 1;
        if (x < fi) w = 0.5 - 0.5 * Math.cos(Math.PI * x / fi);
        else if (x > 1 - fo) w = 0.5 - 0.5 * Math.cos(Math.PI * (1 - x) / fo);
        curve[i] = w * amp;
      }
      return curve;
    },

    playGrain(p, c, when, headAngle, opt = {}) {
      if (!this.offline && this.voices >= this.maxVoices) { this.stats.dropped++; return false; }
      if (p.choke) {
        // a choked plate is monophonic: a second grain at the same instant is dropped
        const prev = this.lastVoice.get(p);
        if (prev && Math.abs(prev.start - when) < 1e-6) return false;
      }
      const pool = MR.sounds.poolFor(p);
      if (!pool.length) return false;
      const snd = pool[c.srcPick % pool.length];
      const len = snd.buffer.duration;
      const frag = p.fragmentFor(c, snd);
      const rate = frag.rate * (opt.semis ? Math.pow(2, opt.semis / 12) : 1);
      let dur = frag.dur;
      if (opt.maxDur) dur = Math.min(dur, opt.maxDur);
      const srcDur = Math.max(0.002, Math.min(dur * rate, len));
      const offset = Math.min(frag.offset, Math.max(0, len - srcDur));
      const buf = opt.reverse ? MR.sounds.reversed(snd) : snd.buffer;
      const off = opt.reverse ? Math.max(0, len - offset - srcDur) : offset;
      const playDur = srcDur / rate;
      const amp = p.gainFor(c) * 1.1 * (opt.gainMul != null ? opt.gainMul : 1);

      const ctx = this.ctx;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = rate;
      const env = ctx.createGain();
      env.gain.value = 0;
      const choke = ctx.createGain();
      const pan = this.makePanner(p, c, headAngle);
      src.connect(env);
      env.connect(choke);
      choke.connect(pan);
      pan.connect(this.buses[p.index].input);
      if (opt.throw) pan.connect(this.throwIn);
      env.gain.setValueCurveAtTime(this.grainCurve(playDur, amp, p.fadeIn, p.fadeOut), when, playDur);
      src.start(when, off, srcDur);
      src.stop(when + playDur + 0.02);

      const voice = { start: when, end: when + playDur, choke, choked: false, plate: p.index, offset, snd: snd.id, key: c.key, reverse: !!opt.reverse, gain: amp,
        sensor: !!(opt.extra && opt.extra.sensor), dist: opt.extra ? opt.extra.dist : null, head: headAngle };
      if (p.choke) {
        const prev = this.lastVoice.get(p);
        if (prev && prev.end > when && prev.start < when) {
          prev.choke.gain.setTargetAtTime(0, when, 0.0025);
          prev.choked = true;
          prev.chokedAt = when;
        }
        this.lastVoice.set(p, voice);
      }
      if (this.trace) this.trace.push(voice);

      if (!this.offline) {
        this.voices++;
        this.active.add(src);
        src.onended = () => {
          if (this.active.delete(src)) this.voices = Math.max(0, this.voices - 1);
          src.disconnect(); env.disconnect(); choke.disconnect(); pan.disconnect();
        };
      }
      this.stats.triggers++;
      return true;
    },

    /** The grain sounds from where the chip sits as it crosses the head. */
    makePanner(p, c, headAngle) {
      const pan = this.ctx.createPanner();
      pan.panningModel = this.panModel;
      pan.distanceModel = 'inverse';
      pan.refDistance = 3;
      pan.rolloffFactor = 1.15;
      pan.maxDistance = 60;
      const x = MR.view.plateX(p);
      const y = c.radius * Math.sin(headAngle);
      const z = -c.radius * Math.cos(headAngle);
      if (pan.positionX) {
        pan.positionX.value = x; pan.positionY.value = y; pan.positionZ.value = z;
      } else {
        pan.setPosition(x, y, z);
      }
      return pan;
    },

    /** Where the live listener is: the ship in flight, else camera or home view. */
    listenerPose(cam) {
      if (MR.flight && MR.flight.on) return cam;
      return this.earMode === 'camera' ? cam : MR.view.homePose();
    },

    setListener(ctx, pose, smooth) {
      const L = ctx.listener;
      const now = ctx.currentTime;
      const [px, py, pz] = pose.pos, [fx, fy, fz] = pose.fwd, [ux, uy, uz] = pose.up;
      if (L.positionX) {
        const set = (param, v) => (smooth ? param.setTargetAtTime(v, now, 0.05) : (param.value = v));
        set(L.positionX, px); set(L.positionY, py); set(L.positionZ, pz);
        set(L.forwardX, fx); set(L.forwardY, fy); set(L.forwardZ, fz);
        set(L.upX, ux); set(L.upY, uy); set(L.upZ, uz);
      } else {
        L.setPosition(px, py, pz);
        L.setOrientation(fx, fy, fz, ux, uy, uz);
      }
    },

    distanceTone(p, pose) {
      const fc = this.flightCtx();
      if (fc) {
        // flying: plates darken with distance along the axis from the ship
        const ax = Math.abs(MR.view.plateX(p) - pose.pos[0]);
        return clamp(18000 * Math.exp(-ax * 1.1 / Math.max(0.2, fc.falloff)), 500, 18000);
      }
      const dx = MR.view.plateX(p) - pose.pos[0], dy = -pose.pos[1], dz = -pose.pos[2];
      const d = Math.hypot(dx, dy, dz);
      return clamp(18000 * Math.exp(-(d - 4.5) * 0.32), 700, 18000);
    },

    /** Per frame: listener follows the camera; far plates get darker. */
    updateSpace(cam) {
      if (!this.ctx) return;
      // in flight the listener is always the ship
      const pose = this.listenerPose(cam);
      const now = this.ctx.currentTime;
      this.setListener(this.ctx, pose, true);
      MR.stack.plates.forEach((p, i) => {
        const bus = this.buses[i];
        if (!bus) return;
        bus.tone.frequency.setTargetAtTime(this.distanceTone(p, pose), now, 0.1);
        bus.level.gain.setTargetAtTime(p.level, now, 0.03);
      });
    },

    /** RMS level per plate bus (0..1) for the meters. */
    readMeters() {
      if (!this.ctx) return;
      MR.stack.plates.forEach((p, i) => {
        const bus = this.buses[i];
        if (!bus) return;
        bus.analyser.getFloatTimeDomainData(bus.buf);
        let s = 0;
        for (let k = 0; k < bus.buf.length; k++) s += bus.buf[k] * bus.buf[k];
        const rms = Math.sqrt(s / bus.buf.length);
        const db = 20 * Math.log10(rms + 1e-6);
        const v = clamp((db + 60) / 60, 0, 1);
        p.meter = Math.max(v, p.meter * 0.9);
      });
    },

    /** Visual time: what is audible right now. */
    visualTime() {
      if (!this.ctx) return 0;
      return this.ctx.currentTime - (this.ctx.outputLatency || this.ctx.baseLatency || 0);
    },

    // ------------------------------------------------------------ offline render
    /** Render the stack from song beat `startBeat` for `seconds` (+tail) into an
     *  AudioBuffer, with the same scheduler on an OfflineAudioContext.
     *  - motions: plate motion to use (default: aligned from bar 1)
     *  - flight:  a frozen flight context (MR.flight.exportCtx) to replay the ship
     *  - listenerPose: static listener when not flying (default: home view)
     *  Chance uses the live roll seed, so the same beats roll the same way. */
    async renderOffline({ seconds, tail = 4, onlyPlate = null, seed = this.rollSeed, sampleRate = 48000, trace = false,
      startBeat = 0, motions = null, flight = null, listenerPose = null }) {
      const octx = new OfflineAudioContext(2, Math.ceil((seconds + tail) * sampleRate), sampleRate);
      const off = Object.create(engine);
      off.ctx = octx;
      off.offline = true;
      off.playing = true;
      Object.assign(off, this.buildGraph(octx));
      const bps = this.bpm / 60;
      off.clock = [{ t0: 0, b0: startBeat, bps }];
      off.motions = motions || new Map(MR.stack.plates.map((p) => [p, [{ b0: 0, phi0: p.phase0, w: p.omega() }]]));
      off.flightRender = flight;
      off.sensorCursor = null;
      off.active = new Set();
      off.voices = 0;
      off.events = [];
      off.pending = [];
      off.lastVoice = new Map();
      off.stats = { triggers: 0, dropped: 0, scheduled: 0 };
      off.rollSeed = seed >>> 0;
      off.onlyPlate = onlyPlate;
      off.trace = trace ? [] : null;
      MR.stack.plates.forEach((p, i) => { off.buses[i].level.gain.value = p.level; });
      if (flight) {
        // the listener rides the ship; plate tone follows its distance
        const L = octx.listener;
        const step = 0.05, total = seconds + tail;
        for (let t = 0; t <= total + 1e-9; t += step) {
          const pose = flight.poseAt(t);
          if (L.positionX) {
            const set = (param, v) => (t === 0 ? param.setValueAtTime(v, 0) : param.linearRampToValueAtTime(v, t));
            set(L.positionX, pose.pos[0]); set(L.positionY, pose.pos[1]); set(L.positionZ, pose.pos[2]);
            set(L.forwardX, pose.fwd[0]); set(L.forwardY, pose.fwd[1]); set(L.forwardZ, pose.fwd[2]);
            set(L.upX, pose.up[0]); set(L.upY, pose.up[1]); set(L.upZ, pose.up[2]);
          } else if (t === 0) {
            L.setPosition(...pose.pos); L.setOrientation(...pose.fwd, ...pose.up);
          }
          MR.stack.plates.forEach((p, i) => {
            const f = off.distanceTone(p, pose);
            const param = off.buses[i].tone.frequency;
            if (t === 0) param.setValueAtTime(f, 0); else param.linearRampToValueAtTime(f, t);
          });
          if (!flight.moving) break; // parked: one pose is the whole render
        }
      } else {
        const pose = listenerPose || MR.view.homePose();
        off.setListener(octx, pose, false);
        MR.stack.plates.forEach((p, i) => { off.buses[i].tone.frequency.value = off.distanceTone(p, pose); });
      }
      // schedule in ~0.1 s windows like the live scheduler (keeps a moving ship's ψ linear)
      const B1 = startBeat + seconds * bps, chunk = 0.1 * bps;
      for (let k = 0; ; k++) {
        const Ba = startBeat + k * chunk;
        if (Ba >= B1) break;
        off.scheduleBeats(Ba, Math.min(B1, startBeat + (k + 1) * chunk));
      }
      const buf = await octx.startRendering();
      buf.triggers = off.stats.triggers;
      buf.trace = off.trace;
      return buf;
    },

    // ------------------------------------------------------------ capture
    /** Record raw samples from a node into an AudioBuffer (mic or resample). */
    capture(node, maxSeconds, onDone) {
      const ctx = this.ensureCtx();
      const proc = ctx.createScriptProcessor(4096, 2, 2);
      const mute = ctx.createGain();
      mute.gain.value = 0;
      const chunks = [];
      let frames = 0, done = false;
      const max = Math.floor(maxSeconds * ctx.sampleRate);
      const finish = () => {
        if (done) return;
        done = true;
        try { node.disconnect(proc); } catch (e) { /* ignore */ }
        proc.disconnect(); mute.disconnect();
        const out = new Float32Array(frames);
        let o = 0;
        for (const ch of chunks) { out.set(ch.subarray(0, Math.min(ch.length, frames - o)), o); o += ch.length; if (o >= frames) break; }
        const buf = ctx.createBuffer(1, Math.max(1, frames), ctx.sampleRate);
        buf.copyToChannel(out, 0);
        onDone(buf);
      };
      proc.onaudioprocess = (e) => {
        if (done) return;
        const l = e.inputBuffer.getChannelData(0), r = e.inputBuffer.getChannelData(1);
        const m = new Float32Array(l.length);
        for (let i = 0; i < l.length; i++) m[i] = 0.5 * (l[i] + r[i]);
        chunks.push(m);
        frames += m.length;
        if (frames >= max) { frames = max; finish(); }
      };
      node.connect(proc);
      proc.connect(mute).connect(ctx.destination);
      return { stop: finish, elapsed: () => frames / ctx.sampleRate };
    },

    async recordMic(maxSeconds, onDone) {
      const ctx = this.ensureCtx();
      if (ctx.state !== 'running') await ctx.resume();
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      const srcNode = ctx.createMediaStreamSource(stream);
      return this.capture(srcNode, maxSeconds, (buf) => {
        stream.getTracks().forEach((t) => t.stop());
        onDone(buf);
      });
    },

    resample(seconds, onDone) {
      this.ensureCtx();
      return this.capture(this.out, seconds, onDone);
    },
  };

  MR.engine = engine;
})(window.MR);
