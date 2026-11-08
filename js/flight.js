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
    tNow: 0,                      // clock time of the last update
    ap: { t0: 0, tau0: 0, speed: 1 },
    cursor: null,                 // {t, pos}: pose used at the end of the last scheduled window
    stats: { sensor: 0 },
    near: null,                   // HUD info for the nearest plate in range

    clock() {
      const E = MR.engine;
      return E.ctx && E.playing ? E.ctx.currentTime : performance.now() / 1000;
    },

    // ------------------------------------------------------------ autopilot
    /** Closed-form path: ping-pong along the axis while swinging in radius and
     *  in angle around the read-head side of the plates. */
    tau(t) { return this.ap.tau0 + this.ap.speed * (t - this.ap.t0); },
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
    apPos(t) {
      const raw = this.pathPos(t);
      const b = this.blend;
      if (!b) return raw;
      const f = clamp((t - b.t0) / b.dur, 0, 1);
      if (f >= 1) return raw;
      const s = f * f * (3 - 2 * f);
      return lerp3(b.from, raw, s);
    },
    pathPos(t) {
      const tau = this.tau(t);
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
      const t = this.clock();
      this.ap = { t0: t, tau0: this.tau(t), speed };
    },

    /** Ship position at clock time t (exact on autopilot, extrapolated by hand). */
    predict(t) {
      if (this.autopilot) return this.apPos(t);
      const dt = clamp(t - this.tNow, -0.5, 0.5);
      return [this.pos[0] + this.vel[0] * dt, this.pos[1] + this.vel[1] * dt, this.pos[2] + this.vel[2] * dt];
    },

    // ------------------------------------------------------------ control
    enter() {
      this.on = true;
      this.autopilot = true;
      this.ap = { t0: this.clock(), tau0: this.startTau(), speed: this.thrust };
      this.lastTau = this.ap.tau0;
      this.blend = null;
      this.lookYaw = this.lookPitch = 0;
      this.cursor = null;
      this.keys.clear();
      const t = this.clock();
      this.fwdSmooth = this.pathHeading(t);
    },
    /** Heading along the path, with pitch flattened so turnarounds don't stare at the floor. */
    pathHeading(t) {
      const a = this.apPos(t), b = this.apPos(t + 0.6);
      const d = [b[0] - a[0], (b[1] - a[1]) * 0.35, b[2] - a[2]];
      return Math.hypot(d[0], d[1], d[2]) > 1e-5 ? norm(d) : this.fwdSmooth;
    },
    exit() { this.on = false; this.keys.clear(); this.cursor = null; },

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
      this.blend = { from: this.pos.slice(), t0: t, dur: 1.2 };
      this.fwdSmooth = this.heading();
      this.autopilot = true;
      this.cursor = null;
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
      if (this.blend) this.blend = null;
      this.tNow = t;
      this.cursor = null;
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
    proximity(p, c, t, headAngle) {
      const s = this.predict(t);
      const X = MR.view.plateX(p);
      const d = Math.hypot(s[0] - X, s[1] - c.radius * Math.sin(headAngle), s[2] + c.radius * Math.cos(headAngle));
      const q = d / this.falloff;
      return 1 / (1 + q * q);
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
    schedule(E, Ba, Bb) {
      if (!this.on || Bb <= Ba) return;
      const ta = E.timeAtBeat(Ba), tb = E.timeAtBeat(Bb);
      // reuse the exact pose that ended the previous window so crossings at the
      // shared edge land in exactly one window
      const posA = this.cursor && Math.abs(this.cursor.t - ta) < 1e-9 ? this.cursor.pos : this.predict(ta);
      const posB = this.predict(tb);
      this.cursor = { t: tb, pos: posB };
      const R = this.R;
      const anySolo = MR.stack.anySolo();
      for (const p of MR.stack.plates) {
        if (!p.audible(anySolo)) continue;
        const X = MR.view.plateX(p);
        const A = this.polar(posA, X), B = this.polar(posB, X);
        const minDx = A.dx * B.dx <= 0 ? 0 : Math.min(Math.abs(A.dx), Math.abs(B.dx));
        if (minDx > R) continue;
        const rLo = Math.max(0.05, p.rIn - R), rHi = p.rOut + R;
        if (Math.max(A.r, B.r) < rLo || Math.min(A.r, B.r) > rHi) continue;
        if (Math.min(A.r, B.r) < 0.05) continue; // angle is meaningless on the axis
        const thB = A.th + wrapPi(B.th - A.th);
        const psiA = p.angleAtBeat(Ba) - A.th;
        const psiB = p.angleAtBeat(Bb) - thB;
        if (psiA === psiB) continue;
        const lo = Math.min(psiA, psiB) - 1e-6, hi = Math.max(psiA, psiB) + 1e-6;
        const rMid = (A.r + B.r) / 2, rSlack = R + Math.abs(A.r - B.r) / 2;
        const hits = [];
        for (const c of p.chips) {
          if (Math.abs(c.radius - rMid) > rSlack) continue;
          const target = -c.angle;
          let v = target + TAU * Math.ceil((lo - target) / TAU);
          while (v < hi) {
            const f = (v - psiA) / (psiB - psiA);
            const Bh = Math.round((Ba + f * (Bb - Ba)) * 1e9) / 1e9;
            if (Bh >= Ba && Bh < Bb) {
              const fs = (Bh - Ba) / (Bb - Ba);
              const P = this.polar(lerp3(posA, posB, fs), X);
              const d = Math.hypot(P.dx, c.radius - P.r);
              if (d < R && !MR.stack.restAt(p, Bh)) hits.push({ B: Bh, c, th: A.th + fs * (thB - A.th), d });
            }
            v += TAU;
          }
        }
        hits.sort((x, y) => x.B - y.B);
        for (const h of hits) {
          const gain = this.sensorGain * Math.pow(1 - h.d / R, 1.3);
          E.fire(p, h.c, E.timeAtBeat(h.B), h.th, h.B, gain, { sensor: true, dist: h.d });
          this.stats.sensor++;
        }
      }
    },
  };

  // keep the sensor wrap helper available for tests / HUD
  flight.wrapPi = wrapPi;
  MR.flight = flight;
})(window.MR);
