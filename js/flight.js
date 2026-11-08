/* Flight: pilot a ship through the stack as if the plates were asteroid fields.
 *
 * The ship is a moving read head. For every plate whose plane is within the
 * sensor radius R, the ship's position projected into that plate's plane gives
 * a radius r_s and an angle θ_s. A chip "passes the ship" when its rotating
 * angle crosses θ_s, and it sounds if its track is within R of the ship in 3D.
 * Crossings are solved exactly, like the fixed heads, on the relative phase
 * ψ(B) = φ(B) − θ_s(B), linear within each scheduling window.
 *
 * Where you park relative to a plate's fixed read head sets a second hit for
 * each chip Δθ/ω later: a flam that tightens to nothing as you fly into the
 * head and opens into its own rhythm as you pull away. Radius picks tracks,
 * the sensor radius sets how many, and depth sets which plates you hear.
 */
(function (MR) {
  'use strict';
  const { TAU, clamp, lerp, mod } = MR.util;

  const wrapPi = (a) => a - TAU * Math.round(a / TAU);
  const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const lerp3 = (a, b, f) => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];

  const flight = {
    on: false,
    autopilot: true,
    R: 0.38,           // sensor radius (world units)
    sensorGain: 1,
    headMix: 0.3,      // level of the plates' fixed heads while flying
    useChance: false,  // sensor hits ignore plate CHANCE: everything you pass sounds
    falloff: 0.32,     // PROXIMITY: distance at which a fixed-head grain drops to half level
    thrust: 1,         // manual thrust / autopilot speed multiplier
    pos: [-5, 0.6, -0.4],
    vel: [0, 0, 0],
    yaw: 0, pitch: 0,             // manual heading
    lookYaw: 0, lookPitch: 0,     // free-look offset (drag) on top of autopilot heading
    fwdSmooth: [1, 0, 0],
    keys: new Set(),
    saved: null,                  // flight state at the last landing (resumed on take-off)
    hist: [],                     // since PLAY: [{t0, mode:'auto'|'manual', ap, blend}]
    track: [],                    // since PLAY, manual flight samples [{t, pos, fwd, up}] (listener orientation)
    knots: [],                    // since PLAY, the ship path the scheduler used [{t, pos}] (piecewise linear)
    tNow: 0,                      // clock time of the last update
    ap: { t0: 0, tau0: 0, speed: 1 },
    stats: { sensor: 0 },
    near: null,                   // HUD info for the nearest plate in range

    clock() {
      const E = MR.engine;
      return E.ctx && E.playing ? E.ctx.currentTime : performance.now() / 1000;
    },

    // ------------------------------------------------------------ autopilot
    /** Closed-form path: ping-pong along the axis while swinging in radius and
     *  in angle around the read-head side of the plates. */
    /** Path phase. The autopilot only cruises while the music plays: stopped, the
     *  phase is frozen where playback stopped, and resumes from there on play. */
    tau(t) {
      if (this.paused()) return this.ap.tau0;
      const ap = this.prevAp && t < this.ap.t0 ? this.prevAp : this.ap;
      return ap.tau0 + ap.speed * (t - ap.t0);
    },
    paused() { return this.on && !MR.engine.playing; },
    PERIOD: 110,       // seconds for one ping-pong along the stack (at SPEED ×1)
    span() {
      const xs = MR.stack.plates.map((p) => MR.view.plateX(p));
      return [Math.min(...xs) - 0.7, Math.max(...xs) + 0.5];
    },
    /** Annulus centre and half-width interpolated along the axis between plates,
     *  so the path threads the fields instead of missing them. */
    lane(x) {
      const ps = MR.stack.plates.map((p) => ({ x: MR.view.plateX(p), mid: (p.rIn + p.rOut) / 2, half: (p.rOut - p.rIn) / 2 }))
        .sort((a, b) => a.x - b.x);
      if (x <= ps[0].x) return ps[0];
      for (let i = 1; i < ps.length; i++) {
        if (x <= ps[i].x) {
          const f = (x - ps[i - 1].x) / (ps[i].x - ps[i - 1].x);
          const s = 0.5 - 0.5 * Math.cos(Math.PI * f);
          return { mid: lerp(ps[i - 1].mid, ps[i].mid, s), half: lerp(ps[i - 1].half, ps[i].half, s) };
        }
      }
      return ps[ps.length - 1];
    },
    /** Autopilot position, eased in from where the ship was when autopilot engaged. */
    apPos(t) { return this.ease(this.pathPos(t), this.blend, t); },
    ease(raw, b, t) {
      if (!b) return raw;
      const f = clamp((t - b.t0) / b.dur, 0, 1);
      if (f >= 1) return raw;
      const s = f * f * (3 - 2 * f);
      return lerp3(b.from, raw, s);
    },
    /** Autopilot position under a recorded anchor (for replaying the flight). */
    apPosWith(seg, t) {
      return this.ease(this.pathAtTau(seg.ap.tau0 + seg.ap.speed * (t - seg.ap.t0)), seg.blend, t);
    },

    // ------------------------------------------------------------ flight history
    histStart() {
      const t = this.clock();
      this.hist = [{ t0: t, mode: this.autopilot ? 'auto' : 'manual', ap: Object.assign({}, this.ap), blend: this.copyBlend() }];
      this.track = [];
      this.knots = [];
      if (!this.autopilot) this.recordSample(t);
    },
    copyBlend() { return this.blend ? { from: this.blend.from.slice(), t0: this.blend.t0, dur: this.blend.dur } : null; },
    /** Record a change in how the ship flies. Dated at the scheduling horizon: the
     *  live scheduler has already scheduled up to there with the previous mode. */
    histPush(mode) {
      if (!this.on || !MR.engine.playing) return;
      this.hist.push({ t0: MR.engine.horizon(), mode, ap: Object.assign({}, this.ap), blend: this.copyBlend() });
    },
    recordSample(t) {
      const pose = this.pose();
      const tr = this.track;
      if (tr.length && t <= tr[tr.length - 1].t) return;
      tr.push({ t, pos: this.pos.slice(), fwd: pose.fwd, up: pose.up });
      if (tr.length > 200000) tr.splice(0, tr.length - 200000);
    },
    histAt(t) {
      const h = this.hist;
      for (let i = h.length - 1; i >= 0; i--) if (h[i].t0 <= t) return h[i];
      return h[0];
    },
    /** Live: decide the ship's path over a scheduling window (linear between its ends,
     *  each end predicted once and shared with the neighbouring window) and record it. */
    prepareWindow(E, Ba, Bb) {
      const ta = E.timeAtBeat(Ba), tb = E.timeAtBeat(Bb);
      const cur = E.sensorCursor;
      const posA = cur && Math.abs(cur.t - ta) < 1e-9 ? cur.pos : this.predict(ta);
      const posB = this.predict(tb);
      E.shipWin = { ta, tb, posA, posB };
      E.sensorCursor = { t: tb, pos: posB };
      const k = this.knots;
      if (!k.length || k[k.length - 1].t < ta - 1e-9) k.push({ t: ta, pos: posA });
      k.push({ t: tb, pos: posB });
      if (k.length > 400000) k.splice(0, k.length - 400000);
    },
    /** Live ship position as the scheduler sees it. */
    liveShipAt(t) {
      const w = MR.engine.shipWin;
      if (w && t >= w.ta - 1e-9 && t <= w.tb + 1e-9) {
        const f = w.tb > w.ta ? (t - w.ta) / (w.tb - w.ta) : 0;
        return lerp3(w.posA, w.posB, clamp(f, 0, 1));
      }
      return this.predict(t);
    },
    knotAt(t) {
      const k = this.knots;
      let lo = 0, hi = k.length - 1;
      if (t <= k[0].t) return k[0].pos;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (k[mid].t <= t) lo = mid; else hi = mid; }
      const a = k[lo], b = k[hi], f = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
      return lerp3(a.pos, b.pos, clamp(f, 0, 1));
    },
    /** Knot times strictly inside (ta, tb). */
    knotsIn(ta, tb) {
      const k = this.knots, out = [];
      if (!k.length) return out;
      let lo = 0, hi = k.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (k[mid].t <= ta) lo = mid + 1; else hi = mid; }
      for (let i = lo; i < k.length && k[i].t < tb; i++) out.push(k[i].t);
      return out;
    },

    /** Where the ship was at clock time t during this PLAY (future: as predicted). */
    shipAtPlayed(t) {
      // what the scheduler actually used, while it has been recorded
      if (this.knots.length && t <= this.knots[this.knots.length - 1].t) return this.knotAt(t);
      if (!this.hist.length) return this.predict(t);
      const seg = this.histAt(t);
      if (seg.mode === 'auto') return this.apPosWith(seg, t);
      return this.sampleAt(t, seg).pos;
    },
    poseAtPlayed(t, frameAt) {
      if (!this.hist.length) return frameAt(this.predict(t), this.predict(t + 0.6));
      const seg = this.histAt(t);
      if (seg.mode === 'auto') return frameAt(this.apPosWith(seg, t), this.apPosWith(seg, t + 0.6));
      return this.sampleAt(t, seg);
    },
    sampleAt(t, seg) {
      const tr = this.track;
      const isLast = seg === this.hist[this.hist.length - 1];
      if (!tr.length || t >= tr[tr.length - 1].t) {
        const last = tr[tr.length - 1];
        if (isLast && !this.autopilot) { const pose = this.pose(); return { pos: this.predict(t), fwd: pose.fwd, up: pose.up }; }
        return last ? { pos: last.pos, fwd: last.fwd, up: last.up } : { pos: this.pos.slice(), fwd: this.pose().fwd, up: this.pose().up };
      }
      if (t <= tr[0].t) return { pos: tr[0].pos, fwd: tr[0].fwd, up: tr[0].up };
      let lo = 0, hi = tr.length - 1;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (tr[mid].t <= t) lo = mid; else hi = mid; }
      const a = tr[lo], b = tr[hi], f = (t - a.t) / (b.t - a.t);
      return { pos: lerp3(a.pos, b.pos, f), fwd: a.fwd, up: a.up };
    },
    pathPos(t) { return this.pathAtTau(this.tau(t)); },
    pathAtTau(tau) {
      const [x0, x1] = this.span();
      const u = 0.5 - 0.5 * Math.cos((TAU * tau) / this.PERIOD);
      const x = lerp(x0, x1, u);
      const L = this.lane(x);
      const r = L.mid + L.half * 0.85 * Math.sin((TAU * tau) / 23);
      const th = MR.stack.HEAD + 0.45 + 0.42 * Math.sin((TAU * tau) / 41);
      return [x, r * Math.sin(th), -r * Math.cos(th)];
    },
    /** Path phase at which the ship sits in the first plate's field. */
    startTau() {
      const [x0, x1] = this.span();
      const X = Math.min(...MR.stack.plates.map((p) => MR.view.plateX(p)));
      const u = clamp((X - x0) / (x1 - x0), 0, 1);
      return (this.PERIOD / TAU) * Math.acos(1 - 2 * u);
    },
    reanchor(speed) {
      // change speed from the scheduling horizon on (already-scheduled grains used the old one)
      const t = MR.engine.playing ? MR.engine.horizon() : this.clock();
      const tau0 = this.tau(t);
      this.prevAp = Object.assign({}, this.ap);
      this.ap = { t0: t, tau0, speed };
      this.histPush('auto');
    },

    /** Ship position at clock time t (exact on autopilot, extrapolated by hand). */
    predict(t) {
      if (this.autopilot) return this.apPos(t);
      const dt = clamp(t - this.tNow, -0.5, 0.5);
      return [this.pos[0] + this.vel[0] * dt, this.pos[1] + this.vel[1] * dt, this.pos[2] + this.vel[2] * dt];
    },

    // ------------------------------------------------------------ control
    /** Take off. Resumes where the ship was when it last landed (position, heading,
     *  mode, autopilot phase) unless `fresh`, which starts the path at the first plate. */
    enter(fresh = false) {
      this.on = true;
      this.prevAp = null;
      this.blend = null;
      this.cursor = null;
      this.keys.clear();
      const t = this.clock();
      const s = fresh ? null : this.saved;
      if (s) {
        this.autopilot = s.autopilot;
        this.ap = { t0: t, tau0: s.tau, speed: this.thrust };
        this.lastTau = s.tau;
        this.lookYaw = s.lookYaw; this.lookPitch = s.lookPitch;
        this.yaw = s.yaw; this.pitch = s.pitch;
        this.vel = [0, 0, 0];
        this.fwdSmooth = s.fwd.slice();
        this.pos = this.autopilot ? this.apPos(t) : s.pos.slice();
        this.tNow = t;
      } else {
        this.autopilot = true;
        this.ap = { t0: t, tau0: this.startTau(), speed: this.thrust };
        this.lastTau = this.ap.tau0;
        this.lookYaw = this.lookPitch = 0;
        this.pos = this.apPos(t); // on the path immediately, not at the default spot until the next frame
        this.fwdSmooth = this.pathHeading(t);
      }
      if (MR.engine.playing) this.histStart(); // taking off mid-play: record from here
    },
    /** Everything needed to pick the flight up again later (also saved in projects). */
    flightState() {
      // the path phase at the moment you're seeing, so take-off resumes exactly there
      const t = MR.engine.playing ? MR.engine.visualTime() : this.clock();
      return { pos: this.pos.slice(), autopilot: this.autopilot, tau: this.tau(t), yaw: this.yaw, pitch: this.pitch,
        lookYaw: this.lookYaw, lookPitch: this.lookPitch, fwd: this.heading().slice() };
    },
    /** Heading along the path, with pitch flattened so turnarounds don't stare at the floor. */
    pathHeading(t) {
      const a = this.apPos(t), b = this.apPos(t + 0.6);
      const d = [b[0] - a[0], (b[1] - a[1]) * 0.35, b[2] - a[2]];
      return Math.hypot(d[0], d[1], d[2]) > 1e-5 ? norm(d) : this.fwdSmooth;
    },
    exit() {
      if (this.on) this.saved = this.flightState(); // land: remember where we were
      this.on = false; this.keys.clear(); this.cursor = null;
    },

    /** Take the stick: keep the current pose and velocity. */
    takeManual() {
      if (!this.autopilot) return;
      const t = this.clock();
      const a = this.apPos(t), b = this.apPos(t + 0.05);
      this.pos = a;
      this.vel = [(b[0] - a[0]) / 0.05, (b[1] - a[1]) / 0.05, (b[2] - a[2]) / 0.05];
      const f = this.pose().fwd;
      this.yaw = Math.atan2(f[2], f[0]);
      this.pitch = Math.asin(clamp(f[1], -1, 1));
      this.lookYaw = this.lookPitch = 0;
      this.autopilot = false;
      this.tNow = t;
      this.cursor = null;
      this.histPush('manual');
      if (MR.engine.playing) this.recordSample(t);
    },
    engageAutopilot() {
      if (this.autopilot) return;
      // pick up the path at the ship's axial position, keeping its direction of
      // travel, and ease in from the current pose instead of jumping onto the path
      const t = this.clock();
      const [x0, x1] = this.span();
      const u = clamp((this.pos[0] - x0) / (x1 - x0), 0, 1);
      const up = (this.PERIOD / TAU) * Math.acos(1 - 2 * u);   // ascending half (+x)
      const tau0 = this.vel[0] < 0 ? this.PERIOD - up : up;     // descending half (−x)
      this.ap = { t0: t, tau0, speed: this.thrust };
      this.prevAp = null;
      this.blend = { from: this.pos.slice(), t0: t, dur: 1.2 };
      this.fwdSmooth = this.heading();
      this.autopilot = true;
      this.cursor = null;
      this.histPush('auto');
    },
    setThrust(v) {
      this.thrust = v;
      if (this.on && this.autopilot) this.reanchor(v);
    },
    look(dx, dy) {
      if (this.autopilot) {
        this.lookYaw += dx;
        this.lookPitch = clamp(this.lookPitch + dy, -1.3, 1.3);
      } else {
        this.yaw += dx;
        this.pitch = clamp(this.pitch + dy, -1.45, 1.45);
      }
    },

    heading() {
      if (this.autopilot) return this.fwdSmooth;
      const cp = Math.cos(this.pitch);
      return [cp * Math.cos(this.yaw), Math.sin(this.pitch), cp * Math.sin(this.yaw)];
    },

    /** The clock switches between wall time (stopped) and audio time (playing):
     *  keep the autopilot path continuous across the switch. */
    clockChanged() {
      const t = this.clock();
      this.ap = { t0: t, tau0: this.lastTau || 0, speed: this.ap.speed };
      this.prevAp = null;
      if (this.blend) this.blend = null;
      this.tNow = t;
      this.cursor = null;
      if (MR.engine.playing) this.histStart(); // a new PLAY: start recording the flight
    },

    /** Per frame: integrate manual physics on the clock, update the view pose. */
    update(tv) {
      const t = this.clock();
      this.lastTau = this.tau(t);
      const dt = clamp(t - (this.tNow || t), 0, 0.1);
      this.tNow = t;
      if (this.autopilot) {
        // pose for what is audible now; heading follows the path, smoothed
        this.pos = this.apPos(tv || t);
        const n = this.pathHeading(tv || t);
        const a = 1 - Math.exp(-3 * dt); // same smoothing at any frame rate
        this.fwdSmooth = norm(lerp3(this.fwdSmooth, n, a));
      } else {
        const k = this.keys;
        const f = this.heading();
        const right = norm(cross(f, [0, 1, 0]));
        const up = cross(right, f);
        const ax = (k.has('w') ? 1 : 0) - (k.has('s') ? 1 : 0);
        const st = (k.has('d') ? 1 : 0) - (k.has('a') ? 1 : 0);
        const vt = (k.has('e') ? 1 : 0) - (k.has('q') ? 1 : 0);
        const acc = 1.6 * this.thrust * (k.has('shift') ? 3 : 1);
        for (let i = 0; i < 3; i++) this.vel[i] += (f[i] * ax + right[i] * st + up[i] * vt) * acc * dt;
        const damp = Math.exp(-(k.has('x') ? 9 : 1.4) * dt);
        for (let i = 0; i < 3; i++) { this.vel[i] *= damp; this.pos[i] += this.vel[i] * dt; }
        if (MR.engine.playing) this.recordSample(t);
      }
      this.updateNear();
    },

    /** Camera pose for the renderer and the listener. */
    pose() {
      let f = this.heading();
      if (this.autopilot && (this.lookYaw || this.lookPitch)) {
        const yaw = Math.atan2(f[2], f[0]) + this.lookYaw;
        const pitch = clamp(Math.asin(clamp(f[1], -1, 1)) + this.lookPitch, -1.45, 1.45);
        const cp = Math.cos(pitch);
        f = [cp * Math.cos(yaw), Math.sin(pitch), cp * Math.sin(yaw)];
      }
      const right = norm(cross(f, [0, 1, 0]));
      const up = cross(right, f);
      return { pos: this.pos.slice(), fwd: f, right, up };
    },

    speed() {
      if (!this.autopilot) return Math.hypot(this.vel[0], this.vel[1], this.vel[2]);
      const t = this.clock(), a = this.apPos(t), b = this.apPos(t + 0.05);
      return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / 0.05;
    },

    /** Gain for a fixed-head grain: 1 / (1 + (d / falloff)²), d = ship → where the
     *  grain sounds. With falloff 0.32: 0.2 u → 0.72, 0.75 u → 0.15, 2 u → 0.025. */
    proximityAt(s, p, c, headAngle, falloff) {
      const X = MR.view.plateX(p);
      const d = Math.hypot(s[0] - X, s[1] - c.radius * Math.sin(headAngle), s[2] + c.radius * Math.cos(headAngle));
      const q = d / falloff;
      return 1 / (1 + q * q);
    },
    proximity(p, c, t, headAngle) { return this.proximityAt(this.predict(t), p, c, headAngle, this.falloff); },

    /** Live flight parameters for the engine. */
    liveCtx() {
      return { shipAt: (t) => this.liveShipAt(t), headMix: this.headMix, falloff: this.falloff, R: this.R,
        sensorGain: this.sensorGain, useChance: this.useChance };
    },

    /** A frozen copy of the flight for an export of what PLAY plays (song from bar 1;
     *  export time tOff = 0 is the downbeat of bar 1).
     *  - Autopilot, stopped: the paused path resumes when PLAY starts the song, so the
     *    ship moves exactly as it will after you press play.
     *  - Autopilot, playing: the path as it has run since this PLAY.
     *  - By hand: the ship where it is (coasting to a stop if it's still drifting). */
    exportCtx() {
      const E = MR.engine;
      const bps = E.bpm / 60;
      const base = { headMix: this.headMix, falloff: this.falloff, R: this.R, sensorGain: this.sensorGain, useChance: this.useChance };
      const lookYaw = this.autopilot ? this.lookYaw : 0, lookPitch = this.autopilot ? this.lookPitch : 0;
      const frameAt = (a, b) => {
        let f = [b[0] - a[0], (b[1] - a[1]) * 0.35, b[2] - a[2]];
        f = Math.hypot(f[0], f[1], f[2]) > 1e-5 ? norm(f) : this.fwdSmooth;
        if (lookYaw || lookPitch) {
          const yaw = Math.atan2(f[2], f[0]) + lookYaw;
          const pitch = clamp(Math.asin(clamp(f[1], -1, 1)) + lookPitch, -1.45, 1.45);
          const cp = Math.cos(pitch);
          f = [cp * Math.cos(yaw), Math.sin(pitch), cp * Math.sin(yaw)];
        }
        const right = norm(cross(f, [0, 1, 0]));
        return { pos: a, fwd: f, up: cross(right, f) };
      };
      if (E.playing) {
        // this PLAY as it was flown: autopilot anchors and hand-flown samples, then the prediction
        // offline time 0 is bar 1; the export replays the played tempo map, so offline
        // time maps to live time by a fixed shift
        const t0 = E.timeAtBeat(0);
        const liveT = (tOff) => t0 + tOff;
        const shipAt = (tOff) => this.shipAtPlayed(liveT(tOff));
        const poseAt = (tOff) => this.poseAtPlayed(liveT(tOff), frameAt);
        // the recorded path's corners, in export time, so the export splits windows there too
        const knotsIn = (a, b) => this.knotsIn(t0 + a, t0 + b).map((t) => t - t0);
        return Object.assign(base, { moving: true, shipAt, poseAt, knotsIn, where: 'as flown since PLAY', liveT });
      }
      if (this.autopilot) {
        let shipAt;
        {
          // paused: on PLAY the path restarts from this phase, bar 1 lands startDelay later
          const tau0 = this.ap.tau0, sp = this.ap.speed, d = E.startDelay;
          shipAt = (tOff) => this.pathAtTau(tau0 + sp * (tOff + d));
        }
        const poseAt = (tOff) => frameAt(shipAt(tOff), shipAt(tOff + 0.6));
        return Object.assign(base, { moving: true, shipAt, poseAt, where: 'along the autopilot path' });
      }
      const pose = this.pose();
      const pos = pose.pos.slice();
      const vel = E.playing ? [0, 0, 0] : this.vel.slice();
      const k = 1.4, d = E.playing ? 0 : E.startDelay;
      const drifting = Math.hypot(vel[0], vel[1], vel[2]) > 1e-3;
      const shipAt = drifting
        ? (tOff) => { const g = (1 - Math.exp(-k * (tOff + d))) / k; return [pos[0] + vel[0] * g, pos[1] + vel[1] * g, pos[2] + vel[2] * g]; }
        : () => pos;
      return Object.assign(base, { moving: drifting, shipAt, poseAt: (tOff) => ({ pos: shipAt(tOff), fwd: pose.fwd, up: pose.up }), where: 'at the ship\'s position' });
    },

    /** Ship position expressed in a plate's plane. */
    polar(pos, X) {
      return { dx: pos[0] - X, r: Math.hypot(pos[1], pos[2]), th: Math.atan2(pos[1], -pos[2]) };
    },

    /** Is the ship near enough to a plate to sense it (with margin)? */
    inRange(p, P, margin = 1) {
      const R = this.R * margin;
      return Math.abs(P.dx) <= R && P.r >= Math.max(0.05, p.rIn - R) && P.r <= p.rOut + R;
    },

    /** Nearest plate + flam readout for the HUD. */
    updateNear() {
      let best = null;
      const E = MR.engine;
      for (const p of MR.stack.plates) {
        const P = this.polar(this.pos, MR.view.plateX(p));
        if (P.r < p.rIn - this.R * 2 || P.r > p.rOut + this.R * 2 || Math.abs(P.dx) > 1.2) continue;
        if (!best || Math.abs(P.dx) < Math.abs(best.P.dx)) best = { p, P };
      }
      if (!best) { this.near = null; return; }
      const { p, P } = best;
      let dth = Infinity;
      for (const h of p.headAngles()) { const d = wrapPi(P.th - h); if (Math.abs(d) < Math.abs(dth)) dth = d; }
      const bps = E.bpm / 60;
      const w = p.omega(); // rad per beat
      const flam = (dth / w) / bps;           // ship hit lands this long after the head hit
      const step = p.stepBeats / bps;
      this.near = { plate: p, dx: P.dx, r: P.r, th: P.th, flamMs: flam * 1000, stepMs: step * 1000,
        inside: this.inRange(p, P), steps: flam / step };
    },

    // ------------------------------------------------------------ scheduling
    /** Called by the engine for every window [Ba, Bb) (after the fixed heads). */
    segAt(m, B) {
      let seg = m[0];
      for (let i = m.length - 1; i >= 0; i--) if (m[i].b0 <= B) { seg = m[i]; break; }
      return seg;
    },
    /** Crossings of plate p's chips past the ship over [sa, sb) under one motion segment. */
    scanPlate(p, seg, sa, sb, posA, posB, R, hits) {
      if (sb <= sa) return;
      const X = MR.view.plateX(p);
      const A = this.polar(posA, X), B = this.polar(posB, X);
      const minDx = A.dx * B.dx <= 0 ? 0 : Math.min(Math.abs(A.dx), Math.abs(B.dx));
      if (minDx > R) return;
      const rLo = Math.max(0.05, p.rIn - R), rHi = p.rOut + R;
      if (Math.max(A.r, B.r) < rLo || Math.min(A.r, B.r) > rHi) return;
      if (Math.min(A.r, B.r) < 0.05) return; // angle is meaningless on the axis
      const thB = A.th + wrapPi(B.th - A.th);
      const psiA = seg.phi0 + seg.w * (sa - seg.b0) - A.th;
      const psiB = seg.phi0 + seg.w * (sb - seg.b0) - thB;
      if (psiA === psiB) return;
      const lo = Math.min(psiA, psiB) - 1e-6, hi = Math.max(psiA, psiB) + 1e-6;
      const rMid = (A.r + B.r) / 2, rSlack = R + Math.abs(A.r - B.r) / 2;
      for (const c of p.chips) {
        if (Math.abs(c.radius - rMid) > rSlack) continue;
        const target = -c.angle;
        let v = target + TAU * Math.ceil((lo - target) / TAU);
        while (v < hi) {
          const f = (v - psiA) / (psiB - psiA);
          const Bh = Math.round((sa + f * (sb - sa)) * 1e9) / 1e9;
          if (Bh >= sa && Bh < sb) {
            const fs = (Bh - sa) / (sb - sa);
            const P = this.polar(lerp3(posA, posB, fs), X);
            const d = Math.hypot(P.dx, c.radius - P.r);
            if (d < R && !MR.stack.restAt(p, Bh)) hits.push({ B: Bh, c, th: A.th + fs * (thB - A.th), d });
          }
          v += TAU;
        }
      }
    },

    schedule(E, Ba, Bb, fc) {
      if (!fc || Bb <= Ba) return;
      const ta = E.timeAtBeat(Ba), tb = E.timeAtBeat(Bb);
      // offline: keep consecutive windows' shared edge identical (live: prepareWindow did)
      let posA, posB;
      if (E.offline) {
        const cur = E.sensorCursor;
        posA = cur && Math.abs(cur.t - ta) < 1e-9 ? cur.pos : fc.shipAt(ta);
        posB = fc.shipAt(tb);
        E.sensorCursor = { t: tb, pos: posB };
      } else {
        posA = fc.shipAt(ta); posB = fc.shipAt(tb);
      }
      // corners of the recorded path inside this window (export replays of hand flight)
      const pathCuts = fc.knotsIn ? fc.knotsIn(ta, tb).map((t) => E.beatAt(t)) : [];
      const anySolo = MR.stack.anySolo();
      for (const p of MR.stack.plates) {
        if (E.onlyPlate ? p !== E.onlyPlate : !p.audible(anySolo)) continue;
        // the motion being rendered (an export's own copy offline), split at segment
        // starts so ψ is never interpolated across an angle jump
        const m = E.motions ? E.motions.get(p) : p.motion;
        const cuts = [Ba];
        for (const s of m) if (s.b0 > Ba && s.b0 < Bb) cuts.push(s.b0);
        for (const b of pathCuts) if (b > Ba && b < Bb) cuts.push(b);
        cuts.sort((x, y) => x - y);
        cuts.push(Bb);
        const hits = [];
        for (let i = 0; i + 1 < cuts.length; i++) {
          const sa = cuts[i], sb = cuts[i + 1];
          if (sb - sa < 1e-12) continue;
          // ends of each piece: exact path where the context knows it, else window lerp
          const pa = i === 0 ? posA : pathCuts.length ? fc.shipAt(E.timeAtBeat(sa)) : lerp3(posA, posB, (sa - Ba) / (Bb - Ba));
          const pb = i + 2 === cuts.length ? posB : pathCuts.length ? fc.shipAt(E.timeAtBeat(sb)) : lerp3(posA, posB, (sb - Ba) / (Bb - Ba));
          this.scanPlate(p, this.segAt(m, sa), sa, sb, pa, pb, fc.R, hits);
        }
        hits.sort((x, y) => x.B - y.B);
        for (const h of hits) {
          const gain = fc.sensorGain * Math.pow(1 - h.d / fc.R, 1.3);
          E.fire(p, h.c, E.timeAtBeat(h.B), h.th, h.B, gain, { sensor: true, dist: h.d });
          if (!E.offline) this.stats.sensor++;
        }
      }
    },
  };

  // keep the sensor wrap helper available for tests / HUD
  flight.wrapPi = wrapPi;
  // the window cursor lives on the engine (an export's offline engine keeps its own)
  Object.defineProperty(flight, 'cursor', {
    get() { return MR.engine.sensorCursor; },
    set(v) { MR.engine.sensorCursor = v; },
  });
  MR.flight = flight;
})(window.MR);
