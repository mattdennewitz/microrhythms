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

const htmlCache = new Map<string, string>();
/** Set an element's HTML only when it changed (per-frame readouts). */
function setHTML(id: string, html: string) {
  if (htmlCache.get(id) === html) return;
  const el = document.getElementById(id);
  if (!el) return;
  htmlCache.set(id, html);
  el.innerHTML = html;
}

function hudFrame(tv: number) {
  const V = view, E = engine, S = stack;
  const B = E.songBeat(tv);
  const bar = Math.floor(B / 4), beat = Math.floor(B % 4) + 1;
  const inPh = (bar % S.phraseBars) + 1, phrase = Math.floor(bar / S.phraseBars) + 1;
  const pos = `BAR <b>${pad(inPh, 2)}.${beat}</b>/${pad(S.phraseBars, 2)} &nbsp;PHR <b>${pad(phrase, 2)}</b>`;
  setHTML('hud-stats', `SEP <b>${Math.round(V.sep * 100)}%</b> &nbsp;${pos} &nbsp;VOX <b>${pad(E.voices, 2)}</b>`);
  setHTML('pos-readout', `${pad(inPh, 2)}.${beat} / ${pad(S.phraseBars, 2)} · PHR ${pad(phrase, 2)}`);
  const p = S.sel;
  const phi = mod(p.angleAt(tv, E.playing), TAU) * 180 / Math.PI;
  const rps = E.playing ? p.omega() * (E.bpm / 60) / TAU : 0;
  let rows = [
    `<span class="k">TARGET LOCK</span> <span class="big">${p.name}</span>${p.hold ? ' · HOLD' : ''}`,
    `<span class="k">X</span> ${signed(V.plateX(p), 3)} <span class="k">θ</span> ${phi.toFixed(1)}°`,
    `<span class="k">ω</span> ${signed(rps, 3)} REV/S <span class="k">CYC</span> ${p.cycle}`,
    `<span class="k">STEPS</span> ${p.steps}×${p.tracks} <span class="k">CHIPS</span> ${p.chips.length}`,
    `<span class="k">CUT</span> ${p.cut}${p.choke ? ' · CHOKE' : ''} <span class="k">STYLE</span> ${S.style}`,
    `<span class="k">TRIG</span> ${pad(E.stats.triggers, 6)}`,
  ];
  const F = flight;
  if (F.on) {
    const n = F.near;
    const P = F.polar(F.pos, 0);
    rows = [
      `<span class="k">FLIGHT</span> <span class="big">${!F.autopilot ? 'MANUAL' : F.paused() ? 'AUTOPILOT · PAUSED' : 'AUTOPILOT'}</span>`,
      `<span class="k">SPD</span> ${F.speed().toFixed(2)} U/S <span class="k">SENSOR</span> ${F.R.toFixed(2)} U`,
      `<span class="k">X</span> ${signed(F.pos[0], 2)} <span class="k">R</span> ${P.r.toFixed(2)} <span class="k">θ</span> ${(mod(P.th, TAU) * 180 / Math.PI).toFixed(1)}°`,
      n ? `<span class="k">NEAR</span> <span class="big">${n.plate.name}</span> <span class="k">ΔX</span> ${signed(n.dx, 2)}${n.inside ? ' · IN FIELD' : ''}` : `<span class="k">NEAR</span> —`,
      n ? `<span class="k">FLAM</span> <span class="big">${signed(n.flamMs, 1)} MS</span> <span class="k">=</span> ${signed(n.steps, 2)} STEP` : '',
      n ? `<span class="k">STEP</span> ${n.stepMs.toFixed(1)} MS` : '',
      `<span class="k">SENSOR HITS</span> ${pad(F.stats.sensor, 6)}`,
    ];
    setHTML('flight-readout', n ? `${n.plate.name} · FLAM ${signed(n.flamMs, 1)} MS` : 'OPEN SPACE');
  } else {
    setHTML('flight-readout', '');
  }
  E.pending.forEach((sw) => {
    rows.push(`<span class="k">QUEUED</span> <span class="big">${sw.label}</span> @ BAR ${(Math.floor(sw.beat / 4) % S.phraseBars) + 1}`);
  });
  const h = V.hover;
  if (h) {
    const c = h.chip, pl = h.plate;
    const pool = sounds.poolFor(pl);
    const snd = pool.length ? pool[c.srcPick % pool.length] : null;
    const f = snd ? pl.fragmentFor(c, snd) : null;
    rows = rows.concat([
      '&nbsp;',
      `<span class="k">FRAGMENT</span> <span class="big">${snd ? snd.name : '—'}</span>`,
      f ? `<span class="k">@</span> ${(f.offset * 1000).toFixed(0)} MS <span class="k">LEN</span> ${(f.dur * 1000).toFixed(0)} MS <span class="k">CUT</span> ${f.mode}` : '',
      f ? `<span class="k">RATE</span> ${f.rate.toFixed(3)} <span class="k">P</span> ${Math.round(pl.probFor(c) * 100)}%` : '',
      `<span class="k">CELL</span> T${c.track} S${c.sector}${c.accent ? ' · ACCENT' : ''}${c.isBeat ? ' · BEAT' : ''}`,
      c.fx ? `<span class="k">FX</span> ${c.fx}${c.fx === 'ratchet' || c.fx === 'stutter' ? ' ×' + c.fxN : ''}` : '',
    ]);
  }
  setHTML('hud-tr', rows.filter(Boolean).join('<br>'));
}

export function Hud() {
  useRevision();
  useEffect(() => {
    // Cached strings belong to the current DOM, not a previous HUD mount.
    htmlCache.clear();
    return onFrame(hudFrame);
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
