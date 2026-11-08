/* The orbital stack: plates (rhythm layers) and chips (sound fragments).
 *
 * A plate is an annulus spinning about the shared stack axis. It is divided
 * into `steps` sectors and `tracks` concentric rows. Every (track, sector)
 * cell may hold a chip. A chip fires its fragment of sound when its rotating
 * angle crosses one of the plate's fixed read heads, so rotation IS time.
 *
 * Plate angle is a piecewise-linear function of song position in BEATS (the
 * engine maps audio time <-> beats). Tempo changes therefore never disturb the
 * plates, and a plate's base phase is quantised so its steps land on the grid.
 */
(function (MR) {
  'use strict';
  const { TAU, mulberry32, randSeed, clamp, mod, fract, euclid, quantize } = MR.util;

  // Angle (radians, in the plate plane) of the primary read head: just above "3 o'clock".
  const HEAD = 15 * Math.PI / 180;

  const DEFAULTS = {
    name: 'LYR',
    x: 0,            // position on the stack axis (before separation scaling)
    rIn: 0.4, rOut: 0.8,
    steps: 16, tracks: 3,
    density: 0.3,    // fraction of cells that hold chips
    scatter: 0.3,    // 0 = strict euclidean, 1 = random scatter
    onBeat: 0,       // pull chips onto beats (selection bonus + less micro jitter)
    cycle: 4,        // beats per revolution
    dir: 1,          // spin direction
    drift: 0,        // fractional detune of the revolution period (phasing)
    micro: 0.2,      // random micro-timing offset, in fractions of a step
    swing: 0,        // delay of odd steps, in fractions of a step
    grainMs: 60,     // nominal fragment length
    spread: 7,       // pitch spread in semitones
    transpose: 0,
    heads: 1,        // number of evenly spaced read heads
    level: 0.7,
    chance: 0.8,     // 1 = every chip always fires
    rest: 0.5,       // how readily this plate drops out when BREAKS is up
    fxDensity: 0.06, // fraction of chips carrying an FX
    cut: 'overlap',  // overlap | divide | transient | random
    slices: 16,      // for cut = divide
    fadeIn: 0.05,    // fraction of each grain
    fadeOut: 0.2,
    choke: false,    // a new grain cuts the previous grain on this plate
    hold: false,     // survive NEW PHRASE / REGENERATE ALL / MUTATE ALL / EVOLVE
    mute: false, solo: false,
    sources: [],     // names of builtins this plate samples from initially
    style: {},
  };

  // Everything a keep slot / undo step must capture.
  const SNAP_KEYS = ['steps', 'tracks', 'density', 'scatter', 'onBeat', 'cycle', 'dir', 'drift', 'micro', 'swing',
    'grainMs', 'spread', 'transpose', 'heads', 'level', 'chance', 'rest', 'fxDensity', 'cut', 'slices',
    'fadeIn', 'fadeOut', 'choke', 'mute', 'solo', 'seed'];

  const FX_ORDER = [null, 'ratchet', 'stutter', 'reverse', 'throw'];
  const CUT_MODES = ['overlap', 'divide', 'transient'];

  class Plate {
    constructor(def, index) {
      Object.assign(this, JSON.parse(JSON.stringify(DEFAULTS)), def);
      this.style = Object.assign({}, def.style || {});
      this.index = index;
      this.seed = def.seed != null ? def.seed : randSeed();
      this.sourceIds = new Set();
      this.overrides = new Map();   // cell key -> true (force on) / false (force off)
      this.fxOverrides = new Map(); // cell key -> fx type | null
      this.chips = [];
      this.dust = [];
      this.motion = [{ b0: 0, phi0: 0, w: 0 }];
      this.lastFire = -1e9;
      this.fireCount = 0;
      this.meter = 0;
      this.evolveFlash = -1e9;
      this.generate();
      this.phiFrozen = this.phase0;
    }

    get trackW() { return (this.rOut - this.rIn) / this.tracks; }
    get stepBeats() { return (this.cycle * (1 + this.drift)) / this.steps; }

    /** Build chips from the seed. All per-cell randoms are drawn in a fixed
     *  order so changing density/scatter/onBeat keeps the material stable. */
    generate() {
      const rnd = mulberry32(this.seed);
      const n = this.steps, T = this.tracks;
      // Quantised base phase: phase0 = HEAD - j·step puts every step crossing on the beat grid.
      this.phaseStep = Math.floor(rnd() * n);
      this.phase0 = HEAD - (this.phaseStep * TAU) / n;
      const stepB = this.cycle / n;
      const tol = Math.min(0.25, stepB * 0.5) - 1e-9;
      // A cycle of e.g. 1.75 beats shifts the beat grid every revolution, so score
      // each cell by the fraction of (revolution, head) crossings that land on a beat.
      let R = 1;
      while (R < 16 && Math.abs(R * this.cycle - Math.round(R * this.cycle)) > 1e-9) R++;
      const beatScore = (i) => {
        let hit = 0;
        for (let k = 0; k < R; k++) {
          for (let m = 0; m < this.heads; m++) {
            const x = (this.phaseStep - i) * stepB + (m * this.cycle) / this.heads + k * this.cycle;
            const d = fract(x);
            if (Math.min(d, 1 - d) < tol) hit++;
          }
        }
        return hit / (R * this.heads);
      };
      const chips = [], dust = [];
      for (let t = 0; t < T; t++) {
        const weight = 0.55 + rnd() * 0.9;
        const rot = Math.floor(rnd() * n);
        const trackOff = rnd();
        const trackPitch = rnd();
        const k = clamp(Math.round(this.density * n * weight), 0, n);
        const cells = [];
        for (let i = 0; i < n; i++) {
          const E = euclid(i, k, n, rot);
          const r = rnd();
          const score = beatScore(i);
          const isBeat = score >= 0.5;
          cells.push({
            i, E, isBeat, score,
            pri: (1 - this.scatter) * (E ? 0 : 1) + this.scatter * r - this.onBeat * score * 1.01,
            accent: (E && (((i + rot) * k) % n) === 0) || (isBeat && this.onBeat > 0.5),
            uOff: rnd(), uDur: rnd(), uPitch: rnd(), uMicro: rnd(),
            uGain: rnd(), uProb: rnd(), srcPick: Math.floor(rnd() * 9973),
            uFx: rnd(), uFxType: rnd(), uFxN: rnd(),
          });
        }
        const order = cells.slice().sort((a, b) => a.pri - b.pri);
        const active = new Set(order.slice(0, k).map((c) => c.i));
        for (const c of cells) {
          const key = t * n + c.i;
          const ov = this.overrides.get(key);
          const on = ov === undefined ? active.has(c.i) : ov;
          const chip = {
            key, track: t, sector: c.i, E: c.E, isBeat: c.isBeat, beatScore: c.score, accent: c.accent,
            trackOff, trackPitch,
            uOff: c.uOff, uDur: c.uDur, uPitch: c.uPitch, uMicro: c.uMicro,
            uGain: c.uGain, uProb: c.uProb, srcPick: c.srcPick,
            uFx: c.uFx, uFxType: c.uFxType, uFxN: c.uFxN,
            fx: null, fxN: 2,
            angle: 0, radius: 0, lastFire: -1e9,
          };
          (on ? chips : dust).push(chip);
        }
      }
      this.chips = chips;
      this.dust = dust;
      this.assignFx();
      this.refresh();
    }

    /** FX are seeded per chip; overrides come from alt-click edits. */
    assignFx() {
      const types = MR.stack ? MR.stack.fxTypes : FX_ORDER.slice(1);
      for (const c of this.chips) {
        const ov = this.fxOverrides.get(c.key);
        if (ov !== undefined) c.fx = ov;
        else {
          // type drawn over the full list, so disabling one type never re-types other chips
          const t = FX_ORDER[1 + Math.floor(c.uFxType * (FX_ORDER.length - 1))];
          c.fx = c.uFx < this.fxDensity && types.includes(t) ? t : null;
        }
        c.fxN = 2 + Math.floor(c.uFxN * 3);
      }
    }

    /** Recompute derived geometry/timing after a parameter change. */
    refresh() {
      const n = this.steps, step = TAU / n, tw = this.trackW;
      const place = (c) => {
        const tame = 1 - this.onBeat * c.beatScore;
        const microOff = (c.uMicro - 0.5) * this.micro * tame;
        // musical step index in playing order; delay odd steps (angle offset −dir·swing)
        const m = mod(this.dir * (this.phaseStep - c.sector), n);
        const swingOff = (m % 2) ? -this.dir * this.swing : 0;
        c.angle = (c.sector + microOff + swingOff) * step;
        c.radius = this.rIn + (c.track + 0.5) * tw;
      };
      this.chips.forEach(place);
      this.dust.forEach(place);
    }

    // ---- per-chip sound parameters (derived live from plate params) ----
    durFor(c) { return Math.max(0.006, (this.grainMs / 1000) * (0.45 + 1.1 * c.uDur)); }
    rateFor(c) {
      const base = (c.trackPitch - 0.5) * this.spread;
      const semis = quantize(base + (c.uPitch - 0.5) * this.spread * 0.6) + this.transpose;
      return Math.pow(2, semis / 12);
    }
    offsetFor(c) { return mod(c.trackOff + (c.uOff - 0.5) * 0.35, 1); }
    gainFor(c) { return (c.accent ? 1 : 0.68) * (0.5 + 0.5 * c.uGain); }
    probFor(c) {
      const p = 0.3 + 0.7 * c.uProb;
      return Math.pow(p, (1 - this.chance) * 4);
    }

    cutModeFor(snd) {
      return this.cut === 'random' ? CUT_MODES[(snd.id + this.index) % CUT_MODES.length] : this.cut;
    }

    /** Where in `snd` this chip's fragment sits: the single source of truth for
     *  the engine, the HUD readout and the fragment map. */
    fragmentFor(c, snd) {
      const len = snd.buffer.duration;
      const rate = this.rateFor(c);
      const dur = this.durFor(c);
      const srcDur = Math.min(dur * rate, len);
      const maxOff = Math.max(0, len - srcDur);
      const u = this.offsetFor(c);
      const mode = this.cutModeFor(snd);
      let offset;
      if (mode === 'divide') {
        const N = Math.max(1, this.slices);
        const idx = Math.floor(u * N) % N;
        offset = Math.min(maxOff, (idx * len) / N);
      } else if (mode === 'transient' && snd.onsets && snd.onsets.length) {
        let cnt = 0;
        for (const o of snd.onsets) if (o <= maxOff) cnt++;
        offset = cnt ? snd.onsets[Math.floor(u * cnt) % cnt] : 0;
      } else {
        offset = u * maxOff;
      }
      return { offset, dur: srcDur / rate, srcDur, rate, mode };
    }

    headAngles() {
      const out = [];
      for (let j = 0; j < this.heads; j++) out.push(HEAD + (j * TAU) / this.heads);
      return out;
    }

    // ---- motion: piecewise-linear angle as a function of song beats ----
    omega() { return (this.dir * TAU) / (this.cycle * (1 + this.drift)); } // rad per beat
    angleAtBeat(B, motion) {
      const m = motion || this.motion;
      let seg = m[0];
      for (let i = m.length - 1; i >= 0; i--) { if (m[i].b0 <= B) { seg = m[i]; break; } }
      return seg.phi0 + seg.w * (B - seg.b0);
    }
    angleAt(t, playing) {
      if (!playing) return this.phiFrozen;
      return this.angleAtBeat(MR.engine.beatAt(t));
    }
    startMotion() { this.motion = [{ b0: 0, phi0: this.phase0, w: this.omega() }]; }
    stopMotion(B) { this.phiFrozen = mod(this.angleAtBeat(B), TAU); }
    pushSeg(Bs, phi) {
      this.motion = this.motion.filter((s) => s.b0 < Bs);
      this.motion.push({ b0: Bs, phi0: phi, w: this.omega() });
      while (this.motion.length > 2 && this.motion[1].b0 < Bs - 64) this.motion.shift();
    }
    /** From beat Bs, run as if these params had been running since bar 1:
     *  steps land on the grid and plates re-align at phrase starts. */
    align(Bs) { this.pushSeg(Bs, this.phase0 + this.omega() * Bs); }
    /** From beat Bs, change speed without a jump in angle (used by drift). */
    retimeContinuous(Bs) { this.pushSeg(Bs, this.angleAtBeat(Bs)); }

    audible(anySolo) { return !this.mute && (!anySolo || this.solo); }

    /** Toggle a chip at a cell (manual edit). */
    toggleCell(track, sector) {
      const key = track * this.steps + sector;
      const isOn = this.chips.some((c) => c.key === key);
      this.overrides.set(key, !isOn);
      this.generate();
      return !isOn;
    }

    /** Alt-click: cycle a chip's FX through none → ratchet → stutter → reverse → throw. */
    cycleFx(chip) {
      const i = FX_ORDER.indexOf(chip.fx);
      const next = FX_ORDER[(i + 1) % FX_ORDER.length];
      this.fxOverrides.set(chip.key, next);
      this.assignFx();
      return next;
    }

    serialize() {
      const o = {};
      for (const k of SNAP_KEYS) o[k] = this[k];
      o.overrides = [...this.overrides];
      o.fxOverrides = [...this.fxOverrides];
      o.sourceIds = [...this.sourceIds];
      return o;
    }
    load(o) {
      for (const k of SNAP_KEYS) if (o[k] !== undefined) this[k] = o[k];
      this.overrides = new Map(o.overrides || []);
      this.fxOverrides = new Map(o.fxOverrides || []);
      const live = new Set(MR.sounds ? MR.sounds.list.map((s) => s.id) : []);
      this.sourceIds = new Set((o.sourceIds || []).filter((id) => live.has(id)));
      this.generate();
    }
  }

  // ------------------------------------------------------------------------
  // Default stack: small/far plates on the left, the big framed plate in front.
  const DEFAULT_STACK = [
    { name: 'LYR.0', x: -3.9, rIn: 0.80, rOut: 1.14, steps: 24, tracks: 3, density: 0.26, scatter: 0.7,
      cycle: 8, grainMs: 220, spread: 12, transpose: -12, heads: 2, level: 0.55, chance: 0.55, micro: 0.4,
      fadeIn: 0.3, fadeOut: 0.4, rest: 0.7, fxDensity: 0.1,
      sources: ['BREATH', 'WIRE', 'VOWEL'], style: { dashed: true, ticks: true, rings: [0.55], dust: true } },
    { name: 'LYR.1', x: -2.65, rIn: 0.24, rOut: 0.5, steps: 7, tracks: 2, density: 0.45, scatter: 0.1,
      cycle: 1.75, grainMs: 35, spread: 7, level: 0.7, chance: 0.9, micro: 0.08, rest: 0.8, fxDensity: 0.12,
      sources: ['TICK', 'WOOD'], style: { rings: [0.12, 0.62, 0.74], ticks: true, reticle: true } },
    { name: 'LYR.2', x: -2.05, rIn: 0.2, rOut: 0.44, steps: 5, tracks: 2, density: 0.5, scatter: 0,
      cycle: 1.25, dir: -1, grainMs: 110, spread: 0, level: 0.85, chance: 1, micro: 0, onBeat: 0.6,
      rest: 0.4, fxDensity: 0, choke: true, cut: 'transient',
      sources: ['SUB'], style: { rings: [0.1, 0.6, 0.72, 0.84] } },
    { name: 'LYR.3', x: -1.5, rIn: 0.38, rOut: 0.66, steps: 11, tracks: 2, density: 0.4, scatter: 0.2,
      cycle: 2.75, grainMs: 70, spread: 12, level: 0.6, chance: 0.85, micro: 0.12, rest: 0.6, fxDensity: 0.1,
      sources: ['GLASS', 'METAL'], style: { ticks: true, rings: [0.74] } },
    { name: 'LYR.4', x: -0.9, rIn: 0.52, rOut: 0.86, steps: 16, tracks: 3, density: 0.3, scatter: 0.25,
      cycle: 4, grainMs: 50, spread: 5, level: 0.7, chance: 0.85, micro: 0.15, swing: 0.12, rest: 0.5,
      fxDensity: 0.08, cut: 'transient',
      sources: ['WOOD', 'WIRE'], style: { ticks: true, dashed: true } },
    { name: 'LYR.5', x: -0.25, rIn: 0.62, rOut: 1.08, steps: 48, tracks: 6, density: 0.2, scatter: 0.6,
      cycle: 6, dir: -1, grainMs: 32, spread: 12, level: 0.5, chance: 0.6, micro: 0.5, rest: 0.5, fxDensity: 0.08,
      sources: ['TICK', 'METAL', 'GLASS'], style: { ticks: true, dust: true } },
    { name: 'LYR.6', x: 0.6, rIn: 0.88, rOut: 1.56, steps: 96, tracks: 10, density: 0.15, scatter: 0.85,
      cycle: 12, grainMs: 75, spread: 19, level: 0.42, chance: 0.5, micro: 0.6, rest: 0.3, fxDensity: 0.04,
      fadeOut: 0.35,
      sources: ['CLOUD', 'GLASS', 'VOWEL'], style: { dust: true, frame: true, innerTicks: true } },
  ];

  const STEP_CHOICES = [3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 16, 24, 32, 48, 64, 96];

  // ------------------------------------------------------------------ styles
  const R = Math.random;
  const rr = (a, b) => a + R() * (b - a);
  const pick = (arr) => arr[Math.floor(R() * arr.length)];
  /** steps/tracks/cycle keeping a sensible pulses-per-beat so plates share a grid. */
  function structure(p, steps, ppb) {
    p.steps = steps;
    p.tracks = clamp(Math.round((p.rOut - p.rIn) / 0.08), 1, 10);
    p.cycle = Math.max(0.75, Math.round((steps / ppb) * 4) / 4);
    p.drift = 0;
  }
  function base(p, big) {
    p.swing = 0; p.drift = 0; p.onBeat = 0; p.cut = 'overlap'; p.slices = 16;
    p.fadeIn = 0.05; p.fadeOut = big ? 0.3 : 0.2; p.choke = false; p.heads = 1;
    p.grainMs = Math.round(big ? rr(40, 140) : rr(30, 120));
    p.spread = Math.round(rr(0, big ? 19 : 12));
    p.micro = 0.1; p.rest = 0.5; p.fxDensity = 0.05;
  }
  const STYLES = {
    normal(p, big) {
      structure(p, big ? pick([32, 48, 64, 96]) : pick([3, 5, 7, 8, 9, 11, 12, 13, 16]),
        big ? pick([4, 8, 6]) : pick([2, 3, 4, 4, 4]));
      p.dir = R() < 0.35 ? -1 : 1;
      p.density = big ? rr(0.1, 0.3) : rr(0.25, 0.6);
      p.scatter = big ? rr(0.5, 1) : rr(0, 0.4);
      p.micro = R() * (big ? 0.7 : 0.25);
      p.onBeat = big ? 0 : rr(0, 0.4);
      p.heads = R() < 0.2 ? 2 : 1;
      p.fxDensity = rr(0, 0.12);
      p.chance = rr(0.5, 1);
      p.choke = false;
    },
    sparse(p, big) {
      STYLES.normal(p, big);
      p.density = big ? rr(0.04, 0.1) : rr(0.12, 0.25);
      p.chance = rr(0.4, 0.75);
      p.rest = rr(0.5, 1);
      p.grainMs = Math.round(rr(80, 320));
      p.fxDensity = rr(0, 0.06);
    },
    groove(p, big) {
      structure(p, big ? pick([32, 48, 64]) : pick([4, 5, 7, 8, 12, 16, 16]), big ? 8 : 4);
      p.dir = 1;
      p.density = big ? rr(0.12, 0.25) : rr(0.3, 0.6);
      p.scatter = rr(0, 0.25);
      p.onBeat = rr(0.5, 1);
      p.micro = rr(0, 0.08);
      p.swing = pick([0, 0.08, 0.15, 0.22]);
      p.chance = rr(0.8, 1);
      p.grainMs = Math.round(rr(30, 120));
      p.choke = R() < 0.6;
      p.cut = pick(['transient', 'divide']);
      p.fxDensity = rr(0.03, 0.12);
      p.heads = 1;
    },
    glitch(p, big) {
      structure(p, big ? pick([64, 96]) : pick([12, 16, 24, 32]), big ? 8 : pick([6, 8]));
      p.dir = R() < 0.5 ? -1 : 1;
      p.density = big ? rr(0.12, 0.25) : rr(0.3, 0.6);
      p.scatter = rr(0.4, 1);
      p.micro = rr(0.2, 0.6);
      p.grainMs = Math.round(rr(6, 30));
      p.fxDensity = rr(0.25, 0.6);
      p.choke = true;
      p.cut = pick(['transient', 'divide', 'random']);
      p.spread = Math.round(rr(0, 24));
      p.chance = rr(0.6, 0.95);
      p.fadeIn = 0.02; p.fadeOut = 0.1;
    },
    drift(p, big) {
      STYLES.normal(p, big);
      p.drift = (R() < 0.5 ? -1 : 1) * rr(0.002, 0.012);
      p.grainMs = Math.round(rr(150, 500));
      p.density = rr(0.1, 0.3);
      p.micro = rr(0.3, 0.8);
      p.fadeIn = rr(0.2, 0.5); p.fadeOut = rr(0.3, 0.6);
      p.fxDensity = rr(0.05, 0.2);
      p.heads = pick([1, 2]);
      p.choke = false;
    },
    raw(p, big) {
      structure(p, pick(STEP_CHOICES), pick([2, 3, 4, 6, 8]));
      p.dir = R() < 0.5 ? -1 : 1;
      p.density = rr(0.05, 0.7); p.scatter = R(); p.onBeat = R() * 0.5;
      p.micro = R(); p.swing = R() * 0.3; p.grainMs = Math.round(rr(5, 600));
      p.spread = Math.round(rr(0, 24)); p.chance = rr(0.3, 1); p.heads = pick([1, 1, 2, 3]);
      p.fxDensity = R() * 0.4; p.cut = pick(['overlap', 'divide', 'transient', 'random']);
      p.choke = R() < 0.4; p.fadeIn = R() * 0.4; p.fadeOut = R() * 0.6;
    },
    keep() { /* material only: reseed, params untouched */ },
  };

  const stack = {
    HEAD,
    plates: [],
    selected: 6,
    STEP_CHOICES,
    STYLE_NAMES: Object.keys(STYLES),
    style: 'normal',
    phraseBars: 8,
    breaks: 0,
    fxTypes: ['ratchet', 'stutter', 'reverse', 'throw'],

    createDefault() {
      this.plates = DEFAULT_STACK.map((d, i) => new Plate(d, i));
    },
    get sel() { return this.plates[this.selected]; },
    anySolo() { return this.plates.some((p) => p.solo); },
    unheld() { return this.plates.filter((p) => !p.hold); },

    /** New seed (and optionally new structure) for one plate. */
    draw(plate, style) {
      if (style && style !== 'keep') { base(plate, plate.rOut > 1.0); STYLES[style](plate, plate.rOut > 1.0); }
      plate.seed = randSeed();
      plate.overrides.clear();
      plate.fxOverrides.clear();
      plate.generate();
    },
    drawAll(style) { this.unheld().forEach((p) => this.draw(p, style)); },

    regenerate(plate) { this.draw(plate, 'keep'); },
    regenerateAll() { this.drawAll('keep'); },
    mutate(plate) { this.draw(plate, 'normal'); },
    mutateAll() { this.drawAll('normal'); },

    setFxType(type, on) {
      const set = new Set(this.fxTypes);
      if (on) set.add(type); else set.delete(type);
      this.fxTypes = FX_ORDER.slice(1).filter((t) => set.has(t));
      this.plates.forEach((p) => p.assignFx());
    },

    /** Does `plate` rest during the bar containing song beat B? Seeded per
     *  phrase, biased toward the end of the phrase so rests read as fills. */
    restAt(plate, B) {
      if (this.breaks <= 0 || plate.rest <= 0) return false;
      const bar = Math.floor(B / 4);
      const bars = this.phraseBars;
      const phrase = Math.floor(bar / bars);
      const inBar = bar - phrase * bars;
      const h = mulberry32((plate.seed ^ Math.imul(phrase + 1, 0x9E3779B1) ^ Math.imul(inBar + 1, 0x85EBCA77)) >>> 0)();
      const bias = 0.3 + 1.2 * Math.pow((inBar + 1) / bars, 2);
      return h < clamp(this.breaks * plate.rest * bias, 0, 0.92);
    },

    snapshot() { return this.plates.map((p) => p.serialize()); },
    restore(snap) { snap.forEach((o, i) => { if (this.plates[i]) this.plates[i].load(o); }); },

    /** Small generative change applied each bar when EVOLVE is on. */
    evolve(amount) {
      const anySolo = this.anySolo();
      const cand = this.plates.filter((p) => p.audible(anySolo) && !p.hold);
      if (!cand.length || Math.random() > amount) return null;
      const p = cand[Math.floor(Math.random() * cand.length)];
      const flips = 1 + Math.floor(Math.random() * (1 + amount * 4));
      for (let f = 0; f < flips; f++) {
        const t = Math.floor(Math.random() * p.tracks);
        const s = Math.floor(Math.random() * p.steps);
        const key = t * p.steps + s;
        const isOn = p.chips.some((c) => c.key === key);
        p.overrides.set(key, !isOn);
      }
      p.generate();
      p.evolveFlash = performance.now();
      return p;
    },
  };

  MR.Plate = Plate;
  MR.stack = stack;
})(window.MR);
