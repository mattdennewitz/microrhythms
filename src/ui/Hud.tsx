/* HUD overlay: brand + stats, the target-lock readout, per-plate meters.
 * Readouts that change every frame are written straight to the DOM from the
 * frame loop (cached, so unchanged text costs nothing); React owns structure. */
import { useEffect, useRef } from 'react';
import { stack } from '../core/stack';
import { sounds } from '../core/sounds';
import { engine } from '../core/engine';
import { flight } from '../core/flight';
import { view } from '../core/view';
import { TAU, mod, pad, signed } from '../core/util';
import { app } from '../app/controller';
import { onFrame, useRevision } from '../app/store';

type ReadoutPart = string | { kind: 'k' | 'big' | 'bold'; text: string };
type ReadoutRow = ReadoutPart[];
type ReadoutKind = 'text' | 'break' | 'k' | 'big' | 'bold';
type ReadoutCell = { kind: ReadoutKind; text: string; node: Node };
type ReadoutCache = Map<string, { element: HTMLElement; cells: ReadoutCell[] }>;

const k = (text: string): ReadoutPart => ({ kind: 'k', text });
const big = (text: string): ReadoutPart => ({ kind: 'big', text });
const bold = (text: string): ReadoutPart => ({ kind: 'bold', text });

/** Reuse fixed formatting nodes and write changed values only as literal text. */
function writeReadout(cache: ReadoutCache, id: string, rows: ReadoutRow[]) {
  const element = document.getElementById(id);
  if (!element) return;
  let entry = cache.get(id);
  if (!entry || entry.element !== element) {
    element.replaceChildren();
    entry = { element, cells: [] };
    cache.set(id, entry);
  }
  const cells = entry.cells;
  let index = 0;
  const write = (kind: ReadoutKind, text: string) => {
    let cell = cells[index];
    if (!cell || cell.kind !== kind) {
      const node = kind === 'text' ? document.createTextNode('')
        : kind === 'break' ? document.createElement('br')
        : kind === 'bold' ? document.createElement('b')
        : document.createElement('span');
      if (kind === 'k' || kind === 'big') (node as HTMLElement).className = kind;
      if (cell) element.replaceChild(node, cell.node);
      else element.appendChild(node);
      cell = cells[index] = { kind, text: '', node };
    }
    if (cell.text !== text) {
      cell.node.textContent = text;
      cell.text = text;
    }
    index++;
  };
  rows.forEach((row, i) => {
    if (i) write('break', '');
    row.forEach((part) => {
      if (typeof part === 'string') write('text', part);
      else write(part.kind, part.text);
    });
  });
  while (cells.length > index) element.removeChild(cells.pop()!.node);
}

function hudFrame(tv: number, cache: ReadoutCache) {
  const V = view, E = engine, S = stack;
  const B = E.songBeat(tv);
  const bar = Math.floor(B / 4), beat = Math.floor(B % 4) + 1;
  const inPh = (bar % S.phraseBars) + 1, phrase = Math.floor(bar / S.phraseBars) + 1;
  writeReadout(cache, 'hud-stats', [[
    'SEP ', bold(`${Math.round(V.sep * 100)}%`),
    ' \u00a0BAR ', bold(`${pad(inPh, 2)}.${beat}`), `/${pad(S.phraseBars, 2)} \u00a0PHR `,
    bold(pad(phrase, 2)), ' \u00a0VOX ', bold(pad(E.voices, 2)),
  ]]);
  writeReadout(cache, 'pos-readout', [[`${pad(inPh, 2)}.${beat} / ${pad(S.phraseBars, 2)} · PHR ${pad(phrase, 2)}`]]);
  const p = S.sel;
  const phi = mod(p.angleAt(tv, E.playing), TAU) * 180 / Math.PI;
  const rps = E.playing ? p.omega() * (E.bpm / 60) / TAU : 0;
  let rows: ReadoutRow[] = [
    [k('TARGET LOCK'), ' ', big(p.name), p.hold ? ' · HOLD' : ''],
    [k('X'), ` ${signed(V.plateX(p), 3)} `, k('θ'), ` ${phi.toFixed(1)}°`],
    [k('ω'), ` ${signed(rps, 3)} REV/S `, k('CYC'), ` ${p.cycle}`],
    [k('STEPS'), ` ${p.steps}×${p.tracks} `, k('CHIPS'), ` ${p.chips.length}`],
    [k('CUT'), ` ${p.cut}${p.choke ? ' · CHOKE' : ''} `, k('STYLE'), ` ${S.style}`],
    [k('TRIG'), ` ${pad(E.stats.triggers, 6)}`],
  ];
  const F = flight;
  if (F.on) {
    const n = F.near;
    const P = F.polar(F.pos, 0);
    rows = [
      [k('FLIGHT'), ' ', big(!F.autopilot ? 'MANUAL' : F.paused() ? 'AUTOPILOT · PAUSED' : 'AUTOPILOT')],
      [k('SPD'), ` ${F.speed().toFixed(2)} U/S `, k('SENSOR'), ` ${F.R.toFixed(2)} U`],
      [k('X'), ` ${signed(F.pos[0], 2)} `, k('R'), ` ${P.r.toFixed(2)} `, k('θ'), ` ${(mod(P.th, TAU) * 180 / Math.PI).toFixed(1)}°`],
      n ? [k('NEAR'), ' ', big(n.plate.name), ' ', k('ΔX'), ` ${signed(n.dx, 2)}${n.inside ? ' · IN FIELD' : ''}`] : [k('NEAR'), ' —'],
      ...(n ? [
        [k('FLAM'), ' ', big(`${signed(n.flamMs, 1)} MS`), ' ', k('='), ` ${signed(n.steps, 2)} STEP`],
        [k('STEP'), ` ${n.stepMs.toFixed(1)} MS`],
      ] : []),
      [k('SENSOR HITS'), ` ${pad(F.stats.sensor, 6)}`],
    ];
    writeReadout(cache, 'flight-readout', [[n ? `${n.plate.name} · FLAM ${signed(n.flamMs, 1)} MS` : 'OPEN SPACE']]);
  } else {
    writeReadout(cache, 'flight-readout', []);
  }
  E.pending.forEach((sw) => {
    rows.push([k('QUEUED'), ' ', big(sw.label), ` @ BAR ${(Math.floor(sw.beat / 4) % S.phraseBars) + 1}`]);
  });
  const h = V.hover;
  if (h) {
    const c = h.chip, pl = h.plate;
    const pool = sounds.poolFor(pl);
    const snd = pool.length ? pool[c.srcPick % pool.length] : null;
    const f = snd ? pl.fragmentFor(c, snd) : null;
    rows.push(
      ['\u00a0'],
      [k('FRAGMENT'), ' ', big(snd ? snd.name : '—')],
    );
    if (f) {
      rows.push(
        [k('@'), ` ${(f.offset * 1000).toFixed(0)} MS `, k('LEN'), ` ${(f.dur * 1000).toFixed(0)} MS `, k('CUT'), ` ${f.mode}`],
        [k('RATE'), ` ${f.rate.toFixed(3)} `, k('P'), ` ${Math.round(pl.probFor(c) * 100)}%`],
      );
    }
    rows.push([k('CELL'), ` T${c.track} S${c.sector}${c.accent ? ' · ACCENT' : ''}${c.isBeat ? ' · BEAT' : ''}`]);
    if (c.fx) rows.push([k('FX'), ` ${c.fx}${c.fx === 'ratchet' || c.fx === 'stutter' ? ' ×' + c.fxN : ''}`]);
  }
  writeReadout(cache, 'hud-tr', rows);
}

export function Hud() {
  useRevision();
  useEffect(() => {
    // Each subscription owns its DOM cache, including StrictMode remounts.
    const cache: ReadoutCache = new Map();
    return onFrame((tv) => hudFrame(tv, cache));
  }, []);
  return (
    <div id="hud">
      <div className="hud-tl">
        <div className="hud-brand">MICRO <span className="sep">·</span> RHYTHM</div>
        <div className="hud-sub">◦ GEN <span className="sep">·</span> ORBITAL STACK <span className="sep">·</span> VIEW <span id="hud-view">07</span></div>
        <div className="hud-mode" id="hud-mode">{flight.on ? 'FLIGHT' : view.mode}</div>
        <div className="hud-stats" id="hud-stats">SEP 100% LYR 07 FRM 000000</div>
      </div>
      <div className="hud-tr" id="hud-tr"></div>
      <Meters />
      <div className={'hud-hint' + (app.hintGone ? ' gone' : '')} id="hud-hint">SPACE / ▶ TO SPIN THE STACK · F TO FLY THROUGH IT · DROP AUDIO ANYWHERE TO SAMPLE IT</div>
    </div>
  );
}

/** One row per plate: its mute toggle (shift: solo) and its level (click = select). */
function Meters() {
  const bars = useRef<Array<{ bar: HTMLElement | null; peak: HTMLElement | null; v: HTMLElement | null; hold: number }>>([]);
  useEffect(() => onFrame(() => {
    stack.plates.forEach((pl, i) => {
      const m = bars.current[i];
      if (!m || !m.bar || !m.peak || !m.v) return;
      const v = pl.meter;
      m.hold = Math.max(v, m.hold - 0.004);
      m.bar.style.width = `${(v * 100).toFixed(1)}%`;
      m.peak.style.left = `${(m.hold * 100).toFixed(1)}%`;
      m.v.textContent = (v * 99.9).toFixed(1).padStart(4, '0');
    });
  }), []);
  const anySolo = stack.anySolo();
  return (
    <div className="hud-bl" id="meters">
      {stack.plates.map((p, i) => {
        const m = (bars.current[i] = bars.current[i] || { bar: null, peak: null, v: null, hold: 0 });
        const muted = !p.audible(anySolo);
        return (
          <div className="meter-row" key={i}>
            <button className={'mbtn' + (p.mute ? ' on' : '') + (p.solo ? ' solo' : '')} aria-pressed={p.mute ? 'true' : 'false'}
              title={`Mute ${p.name} (shift-click: solo)`} aria-label={`Mute ${p.name}`}
              onClick={(e) => app.meterMute(i, e.shiftKey)}>{p.solo ? 'S' : 'M'}</button>
            <button className={'meter' + (i === stack.selected ? ' sel' : '') + (muted ? ' muted' : '')}
              aria-label={`Select ${p.name}${muted ? ', muted' : ''}`} onClick={() => app.select(i)}>
              <span>{p.name}</span>
              <span className="bar" aria-hidden="true"><i ref={(el) => { m.bar = el; }}></i><s ref={(el) => { m.peak = el; }}></s></span>
              <span className="v" aria-hidden="true" ref={(el) => { m.v = el; }}>00.0</span>
            </button>
          </div>
        );
      })}
    </div>
  );
}
