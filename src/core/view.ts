/* Renderer: perspective camera + Canvas2D line-art of the orbital stack.
 * Plates live in the world YZ plane at x = plate.x * separation; the stack
 * axis is world X. A point on a plate at radius r and angle a is
 *   (x, r·sin a, −r·cos a)
 * so a = 0 points to screen-right when viewed from the default camera.
 */
import { TAU, clamp, lerp, mod, pad } from './util';
import { stack, type Plate } from './stack';
import { engine } from './engine';
import { flight } from './flight';
import { ui } from './bridge';
import type { Chip } from './types';

const DEG = Math.PI / 180;

type Vec = number[];
/** [sx, sy, depth, pxPerUnit] */
type Projected = number[];

const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec, b: Vec): Vec => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec): Vec => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

const HOME = { yaw: 44 * DEG, pitch: 2.5 * DEG, dist: 7.0, target: [-1.55, 0, 0] };

export type ViewMode = 'ORBIT' | 'SPLIT';

/** Camera basis + eye position. */
export interface CameraPose { pos: Vec; fwd: Vec; right: Vec; up: Vec }

/** What pick() found under a screen point. */
export interface PickHit {
  plate: Plate;
  t: number;
  r: number;
  track: number;
  sector: number;
  chip: Chip | null;
  inAnnulus: boolean;
}

export interface ViewHover { plate: Plate; chip: Chip }
export interface CursorCell { plate: Plate; track: number; sector: number }

/** Chip paths batched by brightness (indices 0..4) plus two extra layers. */
type Buckets = Path2D[] & { outline: Path2D; dots: Path2D };
interface Flash { x: number; y: number; s: number; k: number }
type Glyph = (ch: string, r: number, a: number, flip: boolean) => void;

export const view = {
  canvas: null as HTMLCanvasElement | null, g: null as CanvasRenderingContext2D | null, w: 0, h: 0, dpr: 1,
  yaw: HOME.yaw, pitch: HOME.pitch, dist: HOME.dist, target: HOME.target.slice(),
  dragYaw: 0, dragPitch: 0, zoom: 1,
  autoOrbit: true,
  sep: 1.25, sepTarget: 1.25,
  mode: 'ORBIT' as ViewMode,
  pos: [0, 0, 0] as Vec, fwd: [0, 0, -1] as Vec, right: [1, 0, 0] as Vec, up: [0, 1, 0] as Vec, F: 800, cx: 0, cy: 0,
  frame: 0,
  hover: null as ViewHover | null,          // {plate, chip}
  glow: null as HTMLCanvasElement | null, small: null as HTMLCanvasElement | null, sg: null as CanvasRenderingContext2D | null, grain: null as HTMLCanvasElement | null, vignette: null as HTMLCanvasElement | null,
  // assigned later (init / updateCamera / draw / the UI); declared here for the type only
  canBlur: undefined as boolean | undefined,
  orbitPhase: undefined as number | undefined,
  near: undefined as unknown as number,
  lim: undefined as unknown as number,
  beat: undefined as unknown as number,
  cursorCell: undefined as CursorCell | null | undefined,
  hoverHit: undefined as PickHit | null | undefined,

  init(canvas: HTMLCanvasElement): void {
    this.canvas = canvas;
    this.g = canvas.getContext('2d');
    this.small = document.createElement('canvas');
    this.sg = this.small.getContext('2d');
    this.canBlur = 'filter' in this.sg!;
    this.resize();
    window.addEventListener('resize', () => this.resize());
  },

  resize(): void {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = Math.floor(window.innerWidth * this.dpr);
    this.h = Math.floor(window.innerHeight * this.dpr);
    this.canvas!.width = this.w;
    this.canvas!.height = this.h;
    this.small!.width = Math.max(1, Math.floor(this.w / 4));
    this.small!.height = Math.max(1, Math.floor(this.h / 4));
    this.buildTextures();
  },

  buildTextures(): void {
    // vignette
    const v = document.createElement('canvas');
    v.width = this.w; v.height = this.h;
    const vg = v.getContext('2d')!;
    const grd = vg.createRadialGradient(this.w * 0.55, this.h * 0.5, this.h * 0.2, this.w * 0.55, this.h * 0.5, Math.max(this.w, this.h) * 0.75);
    grd.addColorStop(0, 'rgba(0,0,0,0)');
    grd.addColorStop(1, 'rgba(0,0,0,0.78)');
    vg.fillStyle = grd;
    vg.fillRect(0, 0, this.w, this.h);
    this.vignette = v;
    // film grain tile
    const n = document.createElement('canvas');
    n.width = n.height = 256;
    const ng = n.getContext('2d')!;
    const img = ng.createImageData(256, 256);
    for (let i = 0; i < img.data.length; i += 4) {
      const c = Math.random() * 255;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = c;
      img.data[i + 3] = 255;
    }
    ng.putImageData(img, 0, 0);
    this.grain = n;
    // glow sprite
    const s = document.createElement('canvas');
    s.width = s.height = 64;
    const sg = s.getContext('2d')!;
    const rg = sg.createRadialGradient(32, 32, 0, 32, 32, 32);
    rg.addColorStop(0, 'rgba(255,255,255,1)');
    rg.addColorStop(0.18, 'rgba(255,255,255,0.55)');
    rg.addColorStop(0.5, 'rgba(255,255,255,0.12)');
    rg.addColorStop(1, 'rgba(255,255,255,0)');
    sg.fillStyle = rg;
    sg.fillRect(0, 0, 64, 64);
    this.glow = s;
  },

  // ------------------------------------------------------------ camera
  plateX(p: Plate): number { return p.x * this.sep; },

  poseFor(yaw: number, pitch: number, dist: number, target: Vec): CameraPose {
    const pos = [
      target[0] + dist * Math.cos(pitch) * Math.sin(yaw),
      target[1] + dist * Math.sin(pitch),
      target[2] + dist * Math.cos(pitch) * Math.cos(yaw),
    ];
    const fwd = norm(sub(target, pos));
    const right = norm(cross(fwd, [0, 1, 0]));
    const up = cross(right, fwd);
    return { pos, fwd, right, up };
  },
  homePose(): CameraPose { return this.poseFor(HOME.yaw, HOME.pitch, HOME.dist, HOME.target); },

  updateCamera(sec: number): void {
    this.sep = lerp(this.sep, this.sepTarget, 0.06);
    const orbit = this.autoOrbit ? 1 : 0;
    this.orbitPhase = (this.orbitPhase || 0) + orbit * 0.0028;
    const ay = Math.sin(this.orbitPhase) * 9 * DEG;
    const ap = Math.sin(this.orbitPhase * 0.61 + 1) * 2.5 * DEG;
    const ar = Math.sin(this.orbitPhase * 0.37) * 0.8 * DEG;
    this.yaw = HOME.yaw + this.dragYaw + ay;
    this.pitch = clamp(HOME.pitch + this.dragPitch + ap, -70 * DEG, 70 * DEG);
    this.dist = HOME.dist * this.zoom * (this.mode === 'SPLIT' ? 1.12 : 1);
    this.target = [HOME.target[0] * this.sep, 0, 0];
    const pose = this.poseFor(this.yaw, this.pitch, this.dist, this.target);
    // slight camera roll, like a handheld orbit
    const c = Math.cos(ar), s = Math.sin(ar);
    const right = [pose.right[0] * c + pose.up[0] * s, pose.right[1] * c + pose.up[1] * s, pose.right[2] * c + pose.up[2] * s];
    const up = [pose.up[0] * c - pose.right[0] * s, pose.up[1] * c - pose.right[1] * s, pose.up[2] * c - pose.right[2] * s];
    this.pos = pose.pos; this.fwd = pose.fwd; this.right = right; this.up = up;
    const F = flight;
    this.near = F && F.on ? 0.03 : 0.2;
    if (F && F.on) {
      const sp = F.pose();
      this.pos = sp.pos; this.fwd = sp.fwd; this.right = sp.right; this.up = sp.up;
    }
    const narrow = this.w < this.h;
    this.F = (narrow ? this.w * 0.78 : this.h * (F && F.on ? 0.8 : 1.05));
    const panelW = ui.panelWidth() * this.dpr || 0;
    this.cx = (this.w - panelW) * 0.5;
    const panelOpen = !document.body.classList.contains('panel-hidden');
    this.cy = this.h * (narrow ? (panelOpen ? 0.27 : 0.46) : 0.5);
  },

  // returns [sx, sy, depth, pxPerUnit] or null
  project(x: number, y: number, z: number): Projected | null {
    const dx = x - this.pos[0], dy = y - this.pos[1], dz = z - this.pos[2];
    const zc = dx * this.fwd[0] + dy * this.fwd[1] + dz * this.fwd[2];
    if (zc < (this.near || 0.2)) return null;
    const xc = dx * this.right[0] + dy * this.right[1] + dz * this.right[2];
    const yc = dx * this.up[0] + dy * this.up[1] + dz * this.up[2];
    const s = this.F / zc;
    return [this.cx + xc * s, this.cy - yc * s, zc, s];
  },
  pp(x: number, r: number, a: number): Projected | null { return this.project(x, r * Math.sin(a), -r * Math.cos(a)); },

  ray(sx: number, sy: number): Vec {
    const u = (sx - this.cx) / this.F, v = -(sy - this.cy) / this.F;
    return norm([
      this.fwd[0] + this.right[0] * u + this.up[0] * v,
      this.fwd[1] + this.right[1] * u + this.up[1] * v,
      this.fwd[2] + this.right[2] * u + this.up[2] * v,
    ]);
  },

  /** Which plate (and cell) is under a screen point (css px)? */
  pick(cssX: number, cssY: number, tv: number, playing: boolean): PickHit | null {
    const sx = cssX * this.dpr, sy = cssY * this.dpr;
    const d = this.ray(sx, sy);
    let best: PickHit | null = null;
    for (const p of stack.plates) {
      const X = this.plateX(p);
      if (Math.abs(d[0]) < 1e-6) continue;
      const t = (X - this.pos[0]) / d[0];
      if (t <= 0) continue;
      const y = this.pos[1] + t * d[1], z = this.pos[2] + t * d[2];
      const r = Math.hypot(y, z);
      if (r < p.rIn - 0.1 || r > p.rOut + 0.12) continue;
      if (best && best.t < t) continue;
      const a = Math.atan2(y, -z);
      const local = mod(a - p.angleAt(tv, playing), TAU);
      const track = clamp(Math.floor((r - p.rIn) / p.trackW), 0, p.tracks - 1);
      const sector = mod(Math.round(local / (TAU / p.steps)), p.steps);
      const key = track * p.steps + sector;
      const chip = p.chips.find((c) => c.key === key) || null;
      best = { plate: p, t, r, track, sector, chip, inAnnulus: r >= p.rIn && r <= p.rOut };
    }
    return best;
  },

  // ------------------------------------------------------------ drawing
  draw(tv: number, playing: boolean, wallSec: number): void {
    const g = this.g!, W = this.w, H = this.h, dpr = this.dpr;
    this.frame++;
    this.lim = Math.max(W, H) * 3;
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;
    g.fillStyle = '#050607';
    g.fillRect(0, 0, W, H);

    g.globalCompositeOperation = 'lighter';
    this.drawBackdrop(g);

    const plates = stack.plates.slice().sort((a, b) => {
      const pa = this.project(this.plateX(a), 0, 0), pb = this.project(this.plateX(b), 0, 0);
      return (pb ? pb[2] : 0) - (pa ? pa[2] : 0);
    });
    const anySolo = stack.anySolo();
    this.drawAxis(g);
    const buckets = [new Path2D(), new Path2D(), new Path2D(), new Path2D(), new Path2D()] as Buckets;
    buckets.outline = new Path2D();   // reverse-FX chips: hollow
    buckets.dots = new Path2D();      // throw-FX chips: trailing echo dot
    const flashes: Flash[] = [];
    this.beat = engine.songBeat(tv);
    for (const p of plates) this.drawPlate(g, p, tv, playing, anySolo, buckets, flashes);

    // chips: batched by brightness
    const alphas = [0.22, 0.4, 0.58, 0.78, 0.97];
    buckets.forEach((path, i) => { g.fillStyle = `rgba(236,240,242,${alphas[i]})`; g.fill(path); });
    g.lineWidth = 1 * dpr;
    g.strokeStyle = 'rgba(240,244,246,0.85)';
    g.stroke(buckets.outline);
    g.fillStyle = 'rgba(240,244,246,0.7)';
    g.fill(buckets.dots);
    for (const f of flashes) {
      const sz = (10 + 30 * f.k) * Math.min(2.5, f.s / 260) * dpr;
      g.globalAlpha = 0.85 * f.k;
      g.drawImage(this.glow!, f.x - sz / 2, f.y - sz / 2, sz, sz);
    }
    g.globalAlpha = 1;

    for (const p of plates) this.drawLabel(g, p, tv, playing, anySolo);

    // bloom: blurred quarter-res copy added on top
    const sg = this.sg!, sw = this.small!.width, sh = this.small!.height;
    sg.globalCompositeOperation = 'source-over';
    sg.filter = this.canBlur ? 'blur(3px)' : 'none';
    sg.clearRect(0, 0, sw, sh);
    sg.drawImage(this.canvas!, 0, 0, sw, sh);
    sg.filter = 'none';
    g.globalCompositeOperation = 'lighter';
    g.globalAlpha = 0.75;
    g.drawImage(this.small!, 0, 0, W, H);
    g.globalAlpha = 1;

    // film: vignette + grain
    g.globalCompositeOperation = 'source-over';
    g.drawImage(this.vignette!, 0, 0);
    g.globalAlpha = 0.045;
    g.globalCompositeOperation = 'overlay';
    const ox = Math.floor(Math.random() * 256), oy = Math.floor(Math.random() * 256);
    g.fillStyle = g.createPattern(this.grain!, 'repeat')!;
    g.save(); g.translate(-ox, -oy); g.fillRect(0, 0, W + 256, H + 256); g.restore();
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
    if (flight && flight.on) this.drawFlightHud(g, tv);
  },

  drawBackdrop(g: CanvasRenderingContext2D): void {
    const H = this.h, dpr = this.dpr;
    // left-edge ruler
    g.strokeStyle = 'rgba(200,205,210,0.18)';
    g.lineWidth = 1 * dpr;
    g.beginPath();
    for (let i = 0; i < 40; i++) {
      const y = H * 0.24 + i * H * 0.014;
      const len = (i % 5 === 0 ? 9 : 4) * dpr;
      g.moveTo(10 * dpr, y); g.lineTo(10 * dpr + len, y);
    }
    g.stroke();
    // big faint numerals (mirrored, like a reversed overlay)
    const yawDeg = Math.round(mod(this.yaw / DEG, 360));
    g.font = `300 ${Math.round(34 * dpr)}px "IBM Plex Mono", ui-monospace, Menlo, monospace`;
    g.fillStyle = 'rgba(200,205,210,0.13)';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const top = pad(Math.round(yawDeg / 10) * 10 + 100, 3);
    const bot = pad(Math.round(yawDeg / 10) * 10 + 200, 3);
    g.save(); g.translate(this.cx, H * 0.17); g.scale(-1, -1); g.fillText(top, 0, 0); g.restore();
    g.fillText(bot, this.cx, H * 0.9);
  },

  drawAxis(g: CanvasRenderingContext2D): void {
    const plates = stack.plates;
    const xs = plates.map((p) => this.plateX(p));
    const a = this.project(Math.min(...xs) - 3, 0, 0), b = this.project(Math.max(...xs) + 1.2, 0, 0);
    if (!a || !b) return;
    g.strokeStyle = 'rgba(220,225,230,0.16)';
    g.lineWidth = 1 * this.dpr;
    g.beginPath();
    // extend the axis to the screen edges
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const L = Math.hypot(dx, dy) || 1;
    const ext = Math.max(this.w, this.h) * 2;
    g.moveTo(a[0] - dx / L * ext, a[1] - dy / L * ext);
    g.lineTo(b[0] + dx / L * ext, b[1] + dy / L * ext);
    g.stroke();
  },

  // circle (or arc) on a plate plane as a projected polyline
  ring(path: Path2D, X: number, r: number, a0: number, a1: number, segs: number): void {
    let started = false;
    for (let i = 0; i <= segs; i++) {
      const a = a0 + (a1 - a0) * (i / segs);
      const q = this.pp(X, r, a);
      if (!q || Math.abs(q[0]) > this.lim || Math.abs(q[1]) > this.lim) { started = false; continue; }
      if (!started) { path.moveTo(q[0], q[1]); started = true; } else path.lineTo(q[0], q[1]);
    }
  },

  drawPlate(g: CanvasRenderingContext2D, p: Plate, tv: number, playing: boolean, anySolo: boolean, buckets: Buckets, flashes: Flash[]): void {
    const dpr = this.dpr;
    const X = this.plateX(p);
    const phi = p.angleAt(tv, playing);
    const center = this.project(X, 0, 0);
    const flyingNow = flight && flight.on;
    // in first person a plate's centre can be behind you while its chips are in front
    if (!center && !flyingNow) return;
    const s = center ? center[3] : this.F / 0.6;
    const audible = p.audible(anySolo);
    const sel = stack.selected === p.index;
    const resting = playing && stack.restAt(p, this.beat);
    const dim = (audible ? 1 : 0.35) * (resting ? 0.4 : 1);
    const fireK = resting ? 0 : Math.exp(-Math.max(0, tv - p.lastFire) / 0.09);
    const segs = clamp(Math.round(p.rOut * s / 6), 48, 220);
    const lw = clamp(s / 420, 0.6, 1.6) * dpr;

    // --- structure lines
    const rims = new Path2D();
    this.ring(rims, X, p.rIn, 0, TAU, segs);
    this.ring(rims, X, p.rOut, 0, TAU, segs);
    g.lineWidth = lw * (sel ? 1.4 : 1);
    g.strokeStyle = `rgba(230,235,238,${(sel ? 0.85 : 0.5) * dim})`;
    g.stroke(rims);
    if (p.hold) {
      const hr = new Path2D();
      this.ring(hr, X, p.rIn - 0.022, 0, TAU, segs);
      this.ring(hr, X, p.rOut + 0.022, 0, TAU, segs);
      g.lineWidth = lw * 0.8;
      g.strokeStyle = `rgba(230,235,238,${0.45 * dim})`;
      g.stroke(hr);
    }

    const guides = new Path2D();
    for (let t = 1; t < p.tracks; t++) this.ring(guides, X, p.rIn + t * p.trackW, 0, TAU, segs);
    g.lineWidth = lw * 0.8;
    g.strokeStyle = `rgba(220,225,230,${0.1 * dim})`;
    g.stroke(guides);
    if (p.style.rings) {
      // decorative concentric rings, absolute radii in world units
      const deco = new Path2D();
      p.style.rings.forEach((r) => this.ring(deco, X, r, 0, TAU, segs));
      g.strokeStyle = `rgba(225,230,235,${0.35 * dim})`;
      g.stroke(deco);
    }

    if (p.style.dashed) {
      const dash = new Path2D();
      const n = 90, r = p.rOut + 0.07;
      for (let i = 0; i < n; i++) {
        const a0 = phi * 0.5 + (i / n) * TAU;
        this.ring(dash, X, r, a0, a0 + TAU / n * 0.55, 2);
      }
      g.lineWidth = lw * 1.6;
      g.strokeStyle = `rgba(230,235,238,${0.55 * dim})`;
      g.stroke(dash);
    }

    if (p.style.ticks) {
      const ticks = new Path2D();
      for (let i = 0; i < p.steps; i++) {
        const a = phi + (i / p.steps) * TAU;
        const len = i % 4 === 0 ? 0.06 : 0.03;
        const q0 = this.pp(X, p.rOut + 0.012, a), q1 = this.pp(X, p.rOut + 0.012 + len, a);
        if (q0 && q1) { ticks.moveTo(q0[0], q0[1]); ticks.lineTo(q1[0], q1[1]); }
      }
      g.lineWidth = lw;
      g.strokeStyle = `rgba(230,235,238,${0.4 * dim})`;
      g.stroke(ticks);
    }

    if (p.style.innerTicks) {
      const it = new Path2D();
      const r0 = p.rIn * 0.86;
      this.ring(it, X, r0 - 0.012, 0, TAU, segs);
      for (let i = 0; i < 120; i++) {
        const a = (i / 120) * TAU;
        const len = i % 10 === 0 ? 0.07 : 0.03;
        const q0 = this.pp(X, r0, a), q1 = this.pp(X, r0 - len, a);
        if (q0 && q1) { it.moveTo(q0[0], q0[1]); it.lineTo(q1[0], q1[1]); }
      }
      g.lineWidth = lw * 0.8;
      g.strokeStyle = `rgba(220,225,230,${0.28 * dim})`;
      g.stroke(it);
    }

    if (p.style.reticle && center) {
      const q = center;
      const r = 7 * dpr;
      g.strokeStyle = `rgba(235,240,242,${0.7 * dim})`;
      g.lineWidth = 1 * dpr;
      g.strokeRect(q[0] - r, q[1] - r, r * 2, r * 2);
      g.beginPath(); g.arc(q[0], q[1], 2 * dpr, 0, TAU); g.stroke();
    }

    if (p.style.frame) this.drawFrame(g, p, X, tv, lw, dim, fireK);

    // --- read heads (static: they do not rotate with the plate)
    const heads = p.headAngles();
    const headPath = new Path2D(), wedge = new Path2D();
    const hw = Math.min(3.2 * DEG, Math.PI / p.steps);
    for (const h of heads) {
      const q0 = this.pp(X, p.rIn - 0.03, h), q1 = this.pp(X, p.rOut + 0.1, h);
      if (q0 && q1) { headPath.moveTo(q0[0], q0[1]); headPath.lineTo(q1[0], q1[1]); }
      const c0 = this.pp(X, p.rIn, h - hw), c1 = this.pp(X, p.rOut, h - hw);
      const c2 = this.pp(X, p.rOut, h + hw), c3 = this.pp(X, p.rIn, h + hw);
      if (c0 && c1 && c2 && c3) {
        wedge.moveTo(c0[0], c0[1]); wedge.lineTo(c1[0], c1[1]); wedge.lineTo(c2[0], c2[1]); wedge.lineTo(c3[0], c3[1]); wedge.closePath();
      }
    }
    g.lineWidth = lw;
    const flying = flight && flight.on ? 0.35 : 1; // heads would streak across the cockpit
    g.strokeStyle = `rgba(240,244,246,${resting ? 0.06 : (0.3 + 0.6 * fireK) * dim * flying})`;
    g.stroke(headPath);
    g.fillStyle = `rgba(230,236,240,${(0.05 + 0.22 * fireK) * dim})`;
    g.fill(wedge);

    // --- dust: inactive cells
    const stepA = TAU / p.steps;
    const th = Math.min(p.trackW * 0.5, 0.045);
    if (p.style.dust && p.dust.length) {
      // empty cells drawn as faint bars: the dense "data" texture of the plate
      const dust = new Path2D();
      const dth = th * 0.55;
      for (const c of p.dust) {
        if ((c.srcPick & 3) === 0) continue; // leave some cells truly empty
        const a = c.angle + phi;
        const hwA = Math.min(stepA * 0.3, 0.012 / c.radius + c.uDur * 0.02 / c.radius);
        const q0 = this.pp(X, c.radius - dth / 2, a - hwA), q1 = this.pp(X, c.radius + dth / 2, a - hwA);
        const q2 = this.pp(X, c.radius + dth / 2, a + hwA), q3 = this.pp(X, c.radius - dth / 2, a + hwA);
        if (!q0 || !q1 || !q2 || !q3) continue;
        if (q0[2] < 0.4 || Math.abs(q0[0]) > this.lim || Math.abs(q0[1]) > this.lim) continue;
        dust.moveTo(q0[0], q0[1]); dust.lineTo(q1[0], q1[1]); dust.lineTo(q2[0], q2[1]); dust.lineTo(q3[0], q3[1]); dust.closePath();
      }
      g.fillStyle = `rgba(220,225,230,${0.2 * dim})`;
      g.fill(dust);
    }

    // --- chips: projected quads (tangential length ~ grain length)
    for (const c of p.chips) {
      const a = c.angle + phi;
      const dur = p.durFor(c);
      const hwA = Math.min(stepA * 0.42, Math.max(0.006, (0.012 + dur * 0.35) / c.radius) * 0.5);
      const r0 = c.radius - th / 2, r1 = c.radius + th / 2;
      const q0 = this.pp(X, r0, a - hwA), q1 = this.pp(X, r1, a - hwA);
      const q2 = this.pp(X, r1, a + hwA), q3 = this.pp(X, r0, a + hwA);
      if (!q0 || !q1 || !q2 || !q3) continue;
      if (q0[2] < 0.08 || Math.abs(q0[0]) > this.lim || Math.abs(q0[1]) > this.lim || Math.abs(q2[0]) > this.lim || Math.abs(q2[1]) > this.lim) continue;
      const k = playing && c.lastFire <= tv ? Math.exp(-(tv - c.lastFire) / 0.12) : 0;
      // asteroids right in front of the cockpit fade out unless they're sounding
      const nearK = this.near < 0.1 ? clamp((q0[2] - 0.08) / 0.7, 0, 1) : 1;
      let b = (0.25 + 0.55 * p.gainFor(c) * (0.4 + 0.6 * p.probFor(c))) * dim * nearK + k;
      const hover = this.hover && this.hover.chip === c;
      if (hover) b = 1.2;
      const bi = clamp(Math.floor(b * 5), 0, 4);
      const path = buckets[bi];
      const fx = c.fx;
      if (fx === 'ratchet' || fx === 'stutter') {
        // n thin bars across the step: the repeats
        const n = c.fxN, span = Math.max(hwA, stepA * 0.36) * 2;
        for (let k = 0; k < n; k++) {
          const a0 = a - span / 2 + span * (k / n), a1 = a0 + (span / n) * 0.55;
          const rr1 = fx === 'stutter' ? r0 + (r1 - r0) * (k / n) * 0.6 : r1;
          const e0 = this.pp(X, r0, a0), e1 = this.pp(X, rr1 + (fx === 'stutter' ? th * 0.4 : 0), a0);
          const e2 = this.pp(X, rr1 + (fx === 'stutter' ? th * 0.4 : 0), a1), e3 = this.pp(X, r0, a1);
          if (e0 && e1 && e2 && e3) { path.moveTo(e0[0], e0[1]); path.lineTo(e1[0], e1[1]); path.lineTo(e2[0], e2[1]); path.lineTo(e3[0], e3[1]); path.closePath(); }
        }
      } else if (fx === 'reverse') {
        const o = buckets.outline;
        o.moveTo(q0[0], q0[1]); o.lineTo(q1[0], q1[1]); o.lineTo(q2[0], q2[1]); o.lineTo(q3[0], q3[1]); o.closePath();
        if (k > 0.1) { path.moveTo(q0[0], q0[1]); path.lineTo(q1[0], q1[1]); path.lineTo(q2[0], q2[1]); path.lineTo(q3[0], q3[1]); path.closePath(); }
      } else {
        path.moveTo(q0[0], q0[1]); path.lineTo(q1[0], q1[1]); path.lineTo(q2[0], q2[1]); path.lineTo(q3[0], q3[1]); path.closePath();
        if (fx === 'throw') {
          const dq = this.pp(X, c.radius, a - p.dir * (hwA * 2 + 0.03));
          if (dq) { const ds = Math.max(1.2 * dpr, th * dq[3] * 0.35); buckets.dots.rect(dq[0] - ds / 2, dq[1] - ds / 2, ds, ds); }
        }
      }
      if (k > 0.04 || hover) {
        const m = this.pp(X, c.radius, a);
        if (m) flashes.push({ x: m[0], y: m[1], s: m[3], k: hover ? 0.6 : k });
      }
    }

    if (flight && flight.on) this.drawSensorGate(g, p, X, tv, lw);

    // keyboard cell cursor (canvas focused)
    const cc = this.cursorCell;
    if (cc && cc.plate === p && cc.track < p.tracks && cc.sector < p.steps) {
      const a = (cc.sector * TAU) / p.steps + phi;
      const r = p.rIn + (cc.track + 0.5) * p.trackW;
      const hw = (TAU / p.steps) * 0.5, hr = p.trackW * 0.5;
      const q0 = this.pp(X, r - hr, a - hw), q1 = this.pp(X, r + hr, a - hw), q2 = this.pp(X, r + hr, a + hw), q3 = this.pp(X, r - hr, a + hw);
      if (q0 && q1 && q2 && q3) {
        g.save();
        g.globalCompositeOperation = 'source-over';
        g.strokeStyle = 'rgba(255,255,255,0.95)';
        g.lineWidth = 1.5 * dpr;
        g.beginPath(); g.moveTo(q0[0], q0[1]); g.lineTo(q1[0], q1[1]); g.lineTo(q2[0], q2[1]); g.lineTo(q3[0], q3[1]); g.closePath(); g.stroke();
        g.restore();
      }
    }

    // selection brackets
    if (sel) {
      const top = this.pp(X, p.rOut + 0.18, Math.PI / 2), bot = this.pp(X, p.rOut + 0.18, -Math.PI / 2);
      if (top && bot) {
        const L = 8 * dpr;
        g.strokeStyle = 'rgba(245,248,250,0.8)';
        g.lineWidth = 1 * dpr;
        g.beginPath();
        g.moveTo(top[0] - L, top[1] + L * 0.6); g.lineTo(top[0] - L, top[1]); g.lineTo(top[0] + L, top[1]); g.lineTo(top[0] + L, top[1] + L * 0.6);
        g.moveTo(bot[0] - L, bot[1] - L * 0.6); g.lineTo(bot[0] - L, bot[1]); g.lineTo(bot[0] + L, bot[1]); g.lineTo(bot[0] + L, bot[1] - L * 0.6);
        g.stroke();
      }
    }
  },

  /** Where the ship reads this plate: a gate at (r_s, θ_s), brighter as you close in. */
  drawSensorGate(g: CanvasRenderingContext2D, p: Plate, X: number, tv: number, lw: number): void {
    const Fl = flight;
    const P = Fl.polar(Fl.pos, X);
    const R = Fl.R;
    const reach = R * 4;
    if (Math.abs(P.dx) > reach || P.r < Math.max(0.05, p.rIn - R) || P.r > p.rOut + R) return;
    const prox = 1 - Math.abs(P.dx) / reach;
    const band = Math.sqrt(Math.max(0, R * R - P.dx * P.dx));
    const live = band > 0;
    const k = live ? Math.exp(-Math.max(0, tv - (p.lastSensor || -1e9)) / 0.1) : 0;
    const path = new Path2D();
    const r0 = Math.max(0.02, P.r - Math.max(band, 0.015)), r1 = P.r + Math.max(band, 0.015);
    const q0 = this.pp(X, r0, P.th), q1 = this.pp(X, r1, P.th);
    if (q0 && q1) { path.moveTo(q0[0], q0[1]); path.lineTo(q1[0], q1[1]); }
    const span = Math.max(0.05, (band || R * 0.3) / Math.max(0.1, P.r));
    this.ring(path, X, r0, P.th - span, P.th + span, 10);
    this.ring(path, X, r1, P.th - span, P.th + span, 10);
    g.lineWidth = lw * (live ? 1.8 : 1);
    g.strokeStyle = `rgba(255,255,255,${(live ? 0.55 + 0.45 * k : 0.25) * prox})`;
    if (!live) g.setLineDash([3 * this.dpr, 4 * this.dpr]);
    g.stroke(path);
    g.setLineDash([]);
  },

  /** Cockpit overlay: reticle, velocity marker, side-view minimap. */
  drawFlightHud(g: CanvasRenderingContext2D, tv: number): void {
    const Fl = flight, dpr = this.dpr;
    const cx = this.cx, cy = this.cy;
    g.save();
    g.globalCompositeOperation = 'source-over';
    g.strokeStyle = 'rgba(240,244,246,0.75)';
    g.lineWidth = 1 * dpr;
    // reticle
    const rr = 14 * dpr;
    g.beginPath(); g.arc(cx, cy, rr, 0, TAU); g.stroke();
    g.beginPath();
    [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(([dx, dy]) => { g.moveTo(cx + dx * rr * 1.4, cy + dy * rr * 1.4); g.lineTo(cx + dx * rr * 2.2, cy + dy * rr * 2.2); });
    g.stroke();
    // velocity marker: where we're actually heading
    const v = Fl.autopilot ? null : Fl.vel;
    const sp = Fl.speed();
    if (sp > 0.01) {
      const dir = v ? v : (() => { const a = Fl.apPos(Fl.clock()), b = Fl.apPos(Fl.clock() + 0.2); return [b[0] - a[0], b[1] - a[1], b[2] - a[2]]; })();
      const q = this.project(this.pos[0] + dir[0] * 50, this.pos[1] + dir[1] * 50, this.pos[2] + dir[2] * 50);
      if (q && Math.abs(q[0] - cx) < this.w && Math.abs(q[1] - cy) < this.h) {
        g.beginPath(); g.arc(q[0], q[1], 4 * dpr, 0, TAU);
        g.moveTo(q[0] - 9 * dpr, q[1]); g.lineTo(q[0] - 5 * dpr, q[1]);
        g.moveTo(q[0] + 5 * dpr, q[1]); g.lineTo(q[0] + 9 * dpr, q[1]);
        g.moveTo(q[0], q[1] - 5 * dpr); g.lineTo(q[0], q[1] - 9 * dpr);
        g.stroke();
      }
    }
    // minimap: side view, axis horizontal, radius vertical
    const S = stack;
    const mw = Math.min(300 * dpr, (this.w - ui.panelWidth() * dpr) * 0.36), mh = 96 * dpr;
    const mx = (this.w - ui.panelWidth() * dpr) - mw - 22 * dpr, my = this.h - mh - 92 * dpr; // clear of the fly dock
    const xs = S.plates.map((p) => this.plateX(p));
    const x0 = Math.min(...xs) - 1.2, x1 = Math.max(...xs) + 1, rMax = 2.1;
    const toX = (x: number) => mx + ((x - x0) / (x1 - x0)) * mw;
    const toY = (r: number) => my + mh - (r / rMax) * mh;
    g.fillStyle = 'rgba(5,6,7,0.55)';
    g.fillRect(mx - 6 * dpr, my - 14 * dpr, mw + 12 * dpr, mh + 20 * dpr);
    g.strokeStyle = 'rgba(232,236,238,0.18)';
    g.strokeRect(mx - 6 * dpr, my - 14 * dpr, mw + 12 * dpr, mh + 20 * dpr);
    g.beginPath(); g.moveTo(mx, toY(0)); g.lineTo(mx + mw, toY(0)); g.stroke();
    const anySolo = S.anySolo();
    S.plates.forEach((p) => {
      const X = toX(this.plateX(p));
      const near = Fl.near && Fl.near.plate === p;
      g.strokeStyle = `rgba(240,244,246,${near ? 0.95 : p.audible(anySolo) ? 0.5 : 0.2})`;
      g.lineWidth = (near ? 3 : 2) * dpr;
      g.beginPath(); g.moveTo(X, toY(p.rIn)); g.lineTo(X, toY(p.rOut)); g.stroke();
    });
    const P = Fl.polar(Fl.pos, 0);
    const sx = toX(Fl.pos[0]), sy = toY(Math.min(rMax, P.r));
    const sr = (Fl.R / (x1 - x0)) * mw;
    g.lineWidth = 1 * dpr;
    g.strokeStyle = 'rgba(255,255,255,0.8)';
    g.beginPath(); g.arc(sx, sy, Math.max(2 * dpr, sr), 0, TAU); g.stroke();
    g.fillStyle = 'rgba(255,255,255,1)';
    g.beginPath(); g.arc(sx, sy, 2.2 * dpr, 0, TAU); g.fill();
    const hd = Fl.heading();
    const dr = P.r > 1e-3 ? (hd[1] * Fl.pos[1] + hd[2] * Fl.pos[2]) / P.r : 0; // radial part of the heading
    g.beginPath(); g.moveTo(sx, sy); g.lineTo(sx + hd[0] * 14 * dpr, sy - dr * 14 * dpr); g.stroke();
    g.font = `${Math.round(8 * dpr)}px "IBM Plex Mono", ui-monospace, monospace`;
    g.fillStyle = 'rgba(232,236,238,0.6)';
    g.textBaseline = 'top';
    g.fillText(`SIDE VIEW · AXIS × RADIUS · ${Fl.autopilot ? 'AUTOPILOT' : 'MANUAL'}`, mx, my - 12 * dpr);
    g.restore();
  },

  /** Static outer scale ring with spokes, numbering and arc text. */
  drawFrame(g: CanvasRenderingContext2D, p: Plate, X: number, tv: number, lw: number, dim: number, fireK: number): void {
    const dpr = this.dpr;
    const rF = p.rOut + 0.2, rF2 = rF + 0.035, rText = rF + 0.11;
    const path = new Path2D();
    this.ring(path, X, rF, 0, TAU, 200);
    this.ring(path, X, rF2, 0, TAU, 200);
    this.ring(path, X, rText + 0.07, 0, TAU, 200);
    // spokes across the right side
    for (let d = -70; d <= 70; d += 10) {
      const a = d * DEG;
      const q0 = this.pp(X, p.rOut + 0.02, a), q1 = this.pp(X, rF, a);
      if (q0 && q1) { path.moveTo(q0[0], q0[1]); path.lineTo(q1[0], q1[1]); }
    }
    // fine scale ticks
    for (let i = 0; i < 180; i++) {
      const a = (i / 180) * TAU;
      const q0 = this.pp(X, rF, a), q1 = this.pp(X, rF + (i % 5 === 0 ? 0.035 : 0.018), a);
      if (q0 && q1) { path.moveTo(q0[0], q0[1]); path.lineTo(q1[0], q1[1]); }
    }
    g.lineWidth = lw;
    g.strokeStyle = `rgba(230,235,238,${0.5 * dim})`;
    g.stroke(path);

    // shaded read-head wedge between two spokes
    const h = stack.HEAD;
    const w = new Path2D();
    const c0 = this.pp(X, p.rOut + 0.02, h - 5 * DEG), c1 = this.pp(X, rF, h - 5 * DEG);
    const steps = 8;
    if (c0 && c1) {
      w.moveTo(c0[0], c0[1]);
      for (let i = 0; i <= steps; i++) { const q = this.pp(X, rF, h - 5 * DEG + (10 * DEG) * (i / steps)); if (q) w.lineTo(q[0], q[1]); }
      for (let i = steps; i >= 0; i--) { const q = this.pp(X, p.rOut + 0.02, h - 5 * DEG + (10 * DEG) * (i / steps)); if (q) w.lineTo(q[0], q[1]); }
      w.closePath();
      g.fillStyle = `rgba(225,232,236,${(0.1 + 0.18 * fireK) * dim})`;
      g.fill(w);
    }

    // numbering and arc text
    const fs = clamp(this.F / 900, 0.6, 1.4) * 8.5 * dpr;
    g.font = `400 ${fs}px "IBM Plex Mono", ui-monospace, Menlo, monospace`;
    g.fillStyle = `rgba(230,235,238,${0.6 * dim})`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const glyph: Glyph = (ch, r, a, flip) => {
      const q = this.pp(X, r, a), q2 = this.pp(X, r, a - 0.01);
      if (!q || !q2) return;
      let ang = Math.atan2(q2[1] - q[1], q2[0] - q[0]);
      if (flip) ang += Math.PI;
      g.save(); g.translate(q[0], q[1]); g.rotate(ang); g.fillText(ch, 0, 0); g.restore();
    };
    for (let d = -60; d <= 60; d += 20) glyph(pad(mod(d, 360), 3), rF + 0.075, d * DEG, false);
    const text = 'MICRO·RHYTHM  —  ORBITAL STACK  —  ' + pad(Math.round(engine.bpm), 3) + ' BPM';
    const step = 2.5 * DEG;
    const start = 150 * DEG;
    for (let i = 0; i < text.length; i++) glyph(text[i], rText, start - i * step, false);

    this.drawPhraseRing(g, p, X, rText + 0.2, lw, dim, glyph);
  },

  /** Static ring of bar segments: where we are in the phrase, and what's queued. */
  drawPhraseRing(g: CanvasRenderingContext2D, p: Plate, X: number, rP: number, lw: number, dim: number, glyph: Glyph): void {
    const S = stack, E = engine;
    const bars = S.phraseBars;
    const B = this.beat;
    const phraseBeats = bars * 4;
    const inPhrase = ((B % phraseBeats) + phraseBeats) % phraseBeats;
    const curBar = Math.floor(inPhrase / 4);
    const down = E.playing ? Math.exp(-inPhrase / 0.6) : 0;
    const angOf = (f: number) => Math.PI / 2 - f * TAU;   // bar 1 at the top, clockwise
    const gap = Math.min(0.03, TAU / bars * 0.12);
    const segs = new Path2D(), cur = new Path2D();
    for (let i = 0; i < bars; i++) {
      const a0 = angOf(i / bars) - gap, a1 = angOf((i + 1) / bars) + gap;
      this.ring(i === curBar && E.playing ? cur : segs, X, rP, a0, a1, Math.max(4, Math.round(64 / bars)));
    }
    g.lineWidth = lw * 1.2;
    g.strokeStyle = `rgba(230,235,238,${(0.32 + 0.4 * down) * dim})`;
    g.stroke(segs);
    g.lineWidth = lw * 3;
    g.strokeStyle = `rgba(245,248,250,${0.9 * dim})`;
    g.stroke(cur);
    // hand
    if (E.playing) {
      const ah = angOf(inPhrase / phraseBeats);
      const h0 = this.pp(X, rP - 0.06, ah), h1 = this.pp(X, rP + 0.07, ah);
      if (h0 && h1) {
        g.lineWidth = lw * 1.4;
        g.strokeStyle = `rgba(250,252,253,${0.95 * dim})`;
        g.beginPath(); g.moveTo(h0[0], h0[1]); g.lineTo(h1[0], h1[1]); g.stroke();
      }
    }
    // bar numbers
    for (let i = 0; i < bars; i += bars > 16 ? 4 : bars > 8 ? 2 : 1) glyph(String(i + 1), rP + 0.075, angOf((i + 0.5) / bars), false);
    // queued switches: blinking marker on the target bar line
    const blink = 0.5 + 0.5 * Math.sin(performance.now() / 90);
    E.pending.forEach((sw) => {
      const f = (((sw.beat % phraseBeats) + phraseBeats) % phraseBeats) / phraseBeats;
      const a = angOf(f);
      const m0 = this.pp(X, rP - 0.1, a), m1 = this.pp(X, rP + 0.13, a);
      if (m0 && m1) {
        g.lineWidth = lw * 2.2;
        g.strokeStyle = `rgba(255,255,255,${0.35 + 0.6 * blink})`;
        g.beginPath(); g.moveTo(m0[0], m0[1]); g.lineTo(m1[0], m1[1]); g.stroke();
        glyph(sw.label, rP + 0.2, a, false);
      }
    });
  },

  drawLabel(g: CanvasRenderingContext2D, p: Plate, tv: number, playing: boolean, anySolo: boolean): void {
    const dpr = this.dpr;
    const X = this.plateX(p);
    // alternate labels below / above so neighbouring small plates don't collide
    const above = p.index % 2 === 1 && !p.style.frame;
    const a = (above ? 112 : -112) * DEG;
    const q = this.pp(X, p.rOut + (p.style.frame ? 0.45 : 0.08), a);
    if (!q) return;
    const sel = stack.selected === p.index;
    const phi = mod(p.angleAt(tv, playing), TAU) / DEG;
    const ev = performance.now() - p.evolveFlash < 900;
    const txt = `${p.name}  Z=${pad(Math.round(X * 100 + 400), 3)}  ${pad(Math.round(phi), 3)}°${p.hold ? '  HOLD' : ''}${p.mute ? '  MUTE' : ''}${p.solo ? '  SOLO' : ''}${playing && stack.restAt(p, this.beat) ? '  REST' : ''}${ev ? '  ⟳' : ''}`;
    const lx = q[0] - 14 * dpr, ly = q[1] + (above ? -18 : 18) * dpr;
    g.strokeStyle = `rgba(220,225,230,${sel ? 0.7 : 0.3})`;
    g.lineWidth = 1 * dpr;
    g.beginPath(); g.moveTo(q[0], q[1]); g.lineTo(lx, ly + (above ? 6 : -6) * dpr); g.stroke();
    g.font = `400 ${Math.round(9 * dpr)}px "IBM Plex Mono", ui-monospace, Menlo, monospace`;
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    g.fillStyle = sel ? 'rgba(250,252,253,0.95)' : `rgba(220,225,230,${p.audible(anySolo) ? 0.55 : 0.28})`;
    g.fillText(txt, lx - 40 * dpr, ly);
  },
};
