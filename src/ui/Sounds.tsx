/* Sound library list, the selected plate's sample pool, and the fragment map. */
import { useEffect, useRef } from 'react';
import { stack, type Plate, type Fragment } from '../core/stack';
import { sounds } from '../core/sounds';
import { engine } from '../core/engine';
import { view } from '../core/view';
import type { Chip, Sound } from '../core/types';
import { app } from '../app/controller';
import { onFrame } from '../app/store';

function drawWave(cv: HTMLCanvasElement, peaks: Array<[number, number]>) {
  const g = cv.getContext('2d');
  if (!g) return;
  const W = cv.width, H = cv.height;
  g.clearRect(0, 0, W, H);
  g.fillStyle = 'rgba(232,236,238,0.75)';
  const bw = W / peaks.length;
  peaks.forEach(([mn, mx], i) => {
    const y0 = H / 2 - mx * H / 2, y1 = H / 2 - mn * H / 2;
    g.fillRect(i * bw, y0, Math.max(1, bw - 0.4), Math.max(1, y1 - y0));
  });
}

function Wave({ peaks }: { peaks: Array<[number, number]> }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => { if (ref.current) drawWave(ref.current, peaks); }, [peaks]);
  return <canvas ref={ref} width={128} height={32} aria-hidden="true" />;
}

function SoundRow({ s }: { s: Sound }) {
  return (
    <li className={(s.enabled ? '' : 'off ') + (s.builtin ? 'builtin' : 'user')}>
      <button className={'chk' + (s.enabled ? ' on' : '')} role="checkbox" aria-checked={s.enabled ? 'true' : 'false'}
        aria-label={s.name} title="Enable / disable" onClick={() => sounds.setEnabled(s.id, !s.enabled)} />
      <span className="nm" title={s.name}>{s.name}<small>{`${s.buffer.duration.toFixed(1)}s`}</small></span>
      <Wave peaks={s.peaks} />
      <span className="acts">
        <button className="pv" title="Preview" aria-label={`Preview ${s.name}`} onClick={() => app.preview(s.id)}>▷</button>
        {!s.builtin && <button className="rm" title="Remove" aria-label={`Remove ${s.name}`} onClick={() => sounds.remove(s.id)}>×</button>}
      </span>
    </li>
  );
}

export function SoundList() {
  // yours first (newest first), then the built-ins
  const sorted = sounds.list.slice().sort((a, b) => (a.builtin === b.builtin ? b.id - a.id : a.builtin ? 1 : -1));
  return <ul id="sound-list" className="sound-list">{sorted.map((s) => <SoundRow key={s.id} s={s} />)}</ul>;
}

export function Pool() {
  const p = stack.sel;
  return (
    <div id="pool" className="pool">
      {sounds.list.map((s) => {
        const inPool = p.sourceIds.has(s.id);
        return (
          <button key={s.id} className={(inPool ? 'on' : '') + (!s.enabled ? ' off' : '')} aria-pressed={inPool ? 'true' : 'false'}
            aria-description={!s.enabled ? 'sound disabled' : undefined}
            title={inPool ? 'Remove from this plate' : 'Sample this sound on this plate'}
            onClick={() => app.togglePoolSource(s.id)}>{(s.builtin ? '' : '◆ ') + s.name}</button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- fragment map
/** Each pool sound's waveform, cut markers, and a box per chip — redrawn every frame. */
export function FragmentMap() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    let frame = 0, cssW = 0, sig = '';
    let chips: Chip[] | null = null;
    const fragments = new Map<Chip, Fragment>();
    const bg = document.createElement('canvas');
    return onFrame((tv) => {
      if (app.panelHidden) return;
      // layout reads are cached: width refreshed only every 30 frames
      frame++;
      if (!cssW || frame % 30 === 0) cssW = cv.clientWidth;
      if (!cssW) return;
      const p = stack.sel;
      const pool = sounds.poolFor(p);
      const rows = Math.min(pool.length, 6);
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const rowH = 24;
      const cssH = Math.max(1, rows) * rowH + 2;
      if (cv.style.height !== `${cssH}px`) cv.style.height = `${cssH}px`;
      const W = Math.round(cssW * dpr), H = Math.round(cssH * dpr);
      if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
      const g = cv.getContext('2d');
      if (!g) return;
      const rh = rowH * dpr;
      const rowOf = new Map<number, number>();
      pool.slice(0, rows).forEach((s, r) => rowOf.set(s.id, r));
      // static layer (waveforms, cut markers, labels) rebuilt only when it changes
      const nextSig = `${p.index}|${pool.map((s) => s.id + p.cutModeFor(s)).join(',')}|${p.slices}|${p.grainMs}|${p.spread}|${p.transpose}|${W}x${H}`;
      if (chips !== p.chips) { chips = p.chips; sig = ''; }
      if (sig !== nextSig) {
        sig = nextSig;
        fragments.clear();
        for (const c of p.chips) {
          const s = pool[c.srcPick % pool.length];
          if (s && rowOf.has(s.id)) fragments.set(c, p.fragmentFor(c, s));
        }
        bg.width = W; bg.height = H;
        const bgc = bg.getContext('2d');
        if (bgc) drawMapBg(bgc, p, pool, rows, W, rh, dpr);
      }
      g.clearRect(0, 0, W, H);
      g.drawImage(bg, 0, 0);
      drawMapChips(g, p, pool, rowOf, fragments, W, rh, dpr, tv);
    });
  }, []);
  return <canvas id="map" className="map" height={150} aria-hidden="true" ref={ref} />;
}

function drawMapBg(g: CanvasRenderingContext2D, p: Plate, pool: Sound[], rows: number, W: number, rh: number, dpr: number) {
  g.clearRect(0, 0, g.canvas.width, g.canvas.height);
  for (let r = 0; r < rows; r++) {
    const s = pool[r];
    const y0 = r * rh + 1 * dpr, mid = y0 + rh / 2;
    // waveform
    g.fillStyle = 'rgba(232,236,238,0.16)';
    const bw = W / s.peaks.length;
    s.peaks.forEach(([mn, mx], i) => {
      const a = mid - mx * rh * 0.42, b = mid - mn * rh * 0.42;
      g.fillRect(i * bw, a, Math.max(1, bw - 0.3), Math.max(1, b - a));
    });
    // cut markers
    const mode = p.cutModeFor(s);
    g.fillStyle = 'rgba(232,236,238,0.3)';
    const len = s.buffer.duration;
    if (mode === 'divide') for (let i = 1; i < p.slices; i++) g.fillRect(Math.round(i / p.slices * W), y0, 1, rh * 0.28);
    else if (mode === 'transient') for (const o of s.onsets) g.fillRect(Math.round(o / len * W), y0, 1, rh * 0.28);
    g.font = `${Math.round(7 * dpr)}px "IBM Plex Mono", ui-monospace, monospace`;
    g.fillStyle = 'rgba(232,236,238,0.5)';
    g.textBaseline = 'bottom';
    g.fillText(`${s.name} · ${mode}`, 3 * dpr, y0 + rh - 1 * dpr);
  }
}

function drawMapChips(g: CanvasRenderingContext2D, p: Plate, pool: Sound[], rowOf: Map<number, number>, fragments: Map<Chip, Fragment>, W: number, rh: number, dpr: number, tv: number) {
  for (const c of p.chips) {
    const s = pool[c.srcPick % pool.length];
    if (!s || !rowOf.has(s.id)) continue;
    const r = rowOf.get(s.id)!;
    const f = fragments.get(c);
    if (!f) continue;
    const len = s.buffer.duration;
    const x = f.offset / len * W, w = Math.max(1.5 * dpr, f.srcDur / len * W);
    const k = engine.playing && c.lastFire <= tv ? Math.exp(-(tv - c.lastFire) / 0.15) : 0;
    const hover = view.hover && view.hover.chip === c;
    const y = r * rh + rh * 0.3, hh = rh * 0.42;
    g.fillStyle = `rgba(240,244,246,${hover ? 1 : 0.18 + 0.8 * k})`;
    g.fillRect(x, y, w, hh);
    if (hover) { g.strokeStyle = 'rgba(255,255,255,1)'; g.lineWidth = dpr; g.strokeRect(x - 2 * dpr, y - 2 * dpr, w + 4 * dpr, hh + 4 * dpr); }
  }
}
