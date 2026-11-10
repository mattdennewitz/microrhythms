/* The side panel: transport, flight, compose, layer, sounds, output, handling. */
import { useEffect, useRef } from 'react';
import { stack } from '../core/stack';
import { sounds } from '../core/sounds';
import { engine } from '../core/engine';
import { history } from '../core/history';
import { exporter } from '../core/exporter';
import { flight } from '../core/flight';
import { view } from '../core/view';
import { signed } from '../core/util';
import type { FxType, PlateCut } from '../core/types';
import { app } from '../app/controller';
import { notify, useRevision } from '../app/store';
import { Seg, Slider, Toggle, usePressable } from './controls';
import { SoundList, Pool, FragmentMap } from './Sounds';

const pct = (v: number) => `${Math.round(v * 100)}%`;
function nearestIndex(arr: number[], v: number) {
  let bi = 0, bd = Infinity;
  arr.forEach((x, i) => { const d = Math.abs(x - v); if (d < bd) { bd = d; bi = i; } });
  return bi;
}
const FX_TYPES: FxType[] = ['ratchet', 'stutter', 'reverse', 'throw'];
const FX_TITLES: Record<FxType, string> = {
  ratchet: 'repeats that subdivide the step', stutter: 'repeats that climb or fall in pitch',
  reverse: 'fragment plays backwards', throw: 'sent into the tempo-synced delay',
};
const PHRASES = [4, 8, 16, 32];

export function Panel() {
  useRevision();
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    app.panelEl = ref.current;
    return () => { app.panelEl = null; };
  }, []);
  return (
    // a hidden panel leaves the tab order
    <aside id="panel" aria-label="Controls" ref={ref} inert={app.panelHidden}>
      <Transport />
      <Flight />
      <Compose />
      <Layer />
      <SoundsBlock />
      <Output />
      <Handling />
    </aside>
  );
}

function Transport() {
  const set = (fn: () => void) => { fn(); notify(); };
  return (
    <section className="block">
      <header><h2>TRANSPORT</h2></header>
      <div className="row">
        <Toggle id="btn-play" className="primary" on={engine.playing} onClick={() => app.togglePlay()}>{engine.playing ? '■ STOP' : '▶ PLAY'}</Toggle>
        <button id="btn-mode" title="Toggle ORBIT / SPLIT (S)" onClick={() => app.toggleMode()}>{view.mode === 'ORBIT' ? 'SPLIT' : 'ORBIT'}</button>
        <Toggle id="btn-orbit" on={view.autoOrbit} title="Auto-orbit the camera (O)" onClick={() => app.toggleOrbit()}>AUTO-ORBIT</Toggle>
      </div>
      <div id="transport-sliders">
        <Slider id="bpm" label="TEMPO" min={40} max={200} step={1} reset={112} value={engine.bpm}
          fmt={(v) => `${Math.round(v)} BPM`} onInput={(v) => set(() => engine.setBpm(v))} />
        <Slider id="master" label="MASTER" min={0} max={1.5} step={0.01} reset={0.9} value={engine.masterLevel}
          fmt={pct} onInput={(v) => set(() => engine.setMaster(v))} />
        <Slider id="space" label="SPACE" min={0} max={1} step={0.01} reset={0.28} value={engine.spaceLevel}
          fmt={pct} onInput={(v) => set(() => engine.setSpace(v))} />
        <Slider id="sep" label="SEPARATION" min={0.3} max={2.4} step={0.01} reset={1.25} value={view.sepTarget}
          fmt={pct} onInput={(v) => set(() => { view.sepTarget = v; })} />
        <Slider id="evolve" label="EVOLVE" min={0} max={1} step={0.01} reset={0} value={engine.evolveAmount}
          fmt={(v) => (v === 0 ? 'OFF' : `${Math.round(v * 100)}%/BAR`)} onInput={(v) => set(() => { engine.evolveAmount = v; })} />
      </div>
      <div className="row">
        <Toggle id="btn-ear" on={engine.earMode === 'camera'} title="Where you listen from" onClick={() => app.toggleEar()}>EAR: {engine.earMode.toUpperCase()}</Toggle>
        <button id="btn-pan" title="Spatialisation model" onClick={() => app.togglePan()}>PAN: {engine.panModel === 'HRTF' ? 'HRTF' : 'EQUAL'}</button>
      </div>
    </section>
  );
}

function autopilotLabel() {
  return !flight.autopilot ? 'MANUAL' : flight.paused() ? 'AUTOPILOT ❚❚' : 'AUTOPILOT';
}

function Flight() {
  const set = (fn: () => void) => { fn(); notify(); };
  return (
    <section className="block" id="flight-block">
      <header><h2>FLIGHT</h2> <span className="dim" id="flight-readout"></span></header>
      <div className="row">
        <Toggle id="btn-fly" className="primary" on={flight.on} title="Fly through the plates (F) — your position becomes a read head" onClick={() => app.toggleFlight()}>{flight.on ? '✈ LAND' : '✈ FLY'}</Toggle>
        <Toggle id="btn-autopilot" on={flight.autopilot} title="Cruise the field on a fixed path (C)" onClick={() => app.toggleAutopilot()}>{autopilotLabel()}</Toggle>
        <Toggle id="btn-sensor-chance" on={flight.useChance} title="Sensor hits: every chip you pass, or roll each plate's CHANCE" onClick={() => app.toggleSensorChance()}>{flight.useChance ? 'PASS: CHANCE' : 'PASS: ALL'}</Toggle>
        <button id="btn-flight-restart" title="Start the flight path again at the first plate (take-off otherwise resumes where you landed)" onClick={() => app.restartFlightPath()}>↺ RESTART PATH</button>
      </div>
      <div id="flight-sliders">
        <Slider id="sensorr" label="SENSOR" min={0.06} max={0.8} step={0.01} reset={0.38} value={flight.R}
          fmt={(v) => `${v.toFixed(2)} U`} onInput={(v) => set(() => { flight.R = v; })} />
        <Slider id="sensorgain" label="SENSOR LVL" min={0} max={1.5} step={0.01} reset={1} value={flight.sensorGain}
          fmt={pct} onInput={(v) => set(() => { flight.sensorGain = v; })} />
        <Slider id="headmix" label="HEADS MIX" min={0} max={1} step={0.01} reset={0.3} value={flight.headMix}
          fmt={(v) => (v === 0 ? 'SENSOR ONLY' : pct(v))} onInput={(v) => set(() => { flight.headMix = v; })} />
        {/* log scale for the slider position */}
        <Slider id="falloff" label="PROXIMITY" min={Math.log(0.15)} max={Math.log(3)} step={0.01} reset={0.32} value={flight.falloff}
          toSlider={(v) => Math.log(v)} fromSlider={(s) => Math.round(Math.exp(s) * 100) / 100}
          fmt={(v) => (v < 0.35 ? `TIGHT ${v.toFixed(2)} U` : v > 1.5 ? `WIDE ${v.toFixed(2)} U` : `${v.toFixed(2)} U`)}
          onInput={(v) => set(() => { flight.falloff = v; })} />
        <Slider id="thrust" label="SPEED" min={0.25} max={3} step={0.05} reset={1} value={flight.thrust}
          fmt={(v) => `×${v.toFixed(2)}`} onInput={(v) => set(() => flight.setThrust(v))} />
      </div>
      <p className="hint">W/S thrust · A/D strafe · Q/E down/up · ⇧ boost · X brake · drag to look · wheel = sensor size · C autopilot · Esc lands · with the stack focused, arrows look around. PROXIMITY sets how fast plates fade with distance from the ship. Chips that pass within the sensor sound; each sounds again Δθ/ω after the plate's head — fly toward the head to tighten the flam.</p>
    </section>
  );
}

function KeepSlot({ i }: { i: number }) {
  const s = app.slots[i];
  const pend = engine.pendingOf('scene');
  const active = app.activeSlot === i, queued = !!pend && pend.slot === i;
  const btn = useRef<HTMLButtonElement>(null);
  // click/Enter = next bar; Shift (or long press) = next phrase; Delete releases
  const press = usePressable(
    (e) => { if (!app.slots[i]) app.keep(i); else app.recall(i, e.shiftKey ? 'phrase' : 'bar'); },
    () => { if (app.slots[i]) app.recall(i, 'phrase'); },
  );
  return (
    <span className="slot-wrap">
      <button ref={btn} {...press}
        className={'slot' + (s ? '' : ' empty') + (active ? ' active' : '') + (queued ? ' queued' : '')}
        title={s ? `Slot ${i + 1}: click = next bar · shift-click or hold = next phrase · Delete releases` : 'Empty: click to keep here'}
        aria-label={`Slot ${i + 1}, ${s ? 'kept' : 'empty'}${active ? ', playing' : ''}${queued ? ', queued' : ''}`}
        aria-pressed={active ? 'true' : 'false'}
        onKeyDown={(e) => {
          if ((e.key === 'Delete' || e.key === 'Backspace') && app.slots[i]) { e.preventDefault(); app.release(i); }
        }}
      >{String(i + 1)}</button>
      <button className="x" aria-label={`Release slot ${i + 1}`} hidden={!s}
        onClick={() => { app.release(i); btn.current?.focus(); }}>×</button>
    </span>
  );
}

function Compose() {
  const phrase = usePressable((e) => (e.shiftKey ? app.queuePhrase() : app.newPhrase()), () => app.queuePhrase());
  const onBeats = stack.plates.map((p) => p.onBeat);
  const same = onBeats.every((v) => Math.abs(v - onBeats[0]) < 1e-6);
  return (
    <section className="block">
      <header><h2>COMPOSE</h2> <span className="dim" id="pos-readout"></span></header>
      <div className="row">
        <button id="btn-new-phrase" className={'primary' + (engine.pendingOf('phrase') ? ' queued' : '')} {...phrase}
          title="Draw a new phrase for every plate not on hold (N). Shift-click or hold: at the next phrase line.">NEW PHRASE</button>
      </div>
      {/* style picker as buttons: a focused <select> would swallow every shortcut key (type-ahead) */}
      <Seg id="style-row" className="styles" title="Direction of the next draw" value={stack.style}
        items={stack.STYLE_NAMES.map((n) => ({ label: n, value: n }))} onPick={(v) => app.setStyle(v)} />
      <div className="row keeps" id="keep-row">
        <button id="btn-keep" title="Keep the phrase you hear in the next free slot (K)" onClick={() => app.keep()}>KEEP</button>
        {app.slots.map((_, i) => <KeepSlot key={i} i={i} />)}
      </div>
      <p className="hint">slot: click / Enter = switch at the next bar · shift-click, Shift+Enter or hold = next phrase · × or Delete releases</p>
      <div id="compose-sliders">
        <Slider id="phrase" label="PHRASE" min={0} max={3} step={1} value={stack.phraseBars}
          toSlider={(v) => PHRASES.indexOf(v)} fromSlider={(i) => PHRASES[i]} fmt={(v) => `${v} BARS`}
          onInput={(v) => { stack.phraseBars = v; notify(); }} />
        <Slider id="breaks" label="BREAKS" min={0} max={1} step={0.01} reset={0} value={stack.breaks}
          fmt={(v) => (v === 0 ? 'OFF' : pct(v))} onInput={(v) => { stack.breaks = v; notify(); }} />
        <Slider id="onbeatall" label="BEAT·ALL" min={0} max={1} step={0.01} reset={0} value={onBeats[0]} mixed={!same}
          fmt={pct} onStart={() => history.push('onbeat-all', true)} onInput={(v) => app.setOnBeatAll(v)} />
        <Slider id="fxwet" label="THROW WET" min={0} max={1} step={0.01} reset={0.5} value={engine.fxWet}
          fmt={pct} onInput={(v) => { engine.setFxWet(v); notify(); }} />
      </div>
      <div className="row">
        <button id="btn-undo" title="Undo (⌘/Ctrl-Z)" disabled={!history.past.length} onClick={() => app.undo()}>
          {`↶ UNDO${history.past.length ? ' ' + history.past.length : ''}`}
        </button>
        <button id="btn-redo" title="Redo (⇧⌘/Ctrl-Z)" disabled={!history.future.length} onClick={() => app.redo()}>↷ REDO</button>
        <button id="btn-regen-all" title="New patterns and fragments for every plate not on hold (Shift+R)" onClick={() => app.regenAll()}>REGEN ALL</button>
      </div>
      <div className="sub-head">CHIP FX</div>
      <div className="row" id="fx-row">
        <Toggle id="btn-fx" on={engine.fxOn} title="All chip FX on/off" onClick={() => app.toggleFx()}>{engine.fxOn ? 'FX ON' : 'FX OFF'}</Toggle>
        {FX_TYPES.map((t) => {
          const on = stack.fxTypes.includes(t);
          return <Toggle key={t} on={on} title={FX_TITLES[t]} onClick={() => app.setFxType(t, !on)}>{t}</Toggle>;
        })}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- layer
interface LayerDef {
  key: string; label: string; min: number; max: number; step: number; reset?: number;
  toSlider?: (v: number) => number; fromSlider?: (s: number) => number;
  fmt: (v: number) => string; apply: (v: number) => void;
}
const P = () => stack.sel;
const restructure = () => { const p = P(); p.overrides.clear(); p.fxOverrides.clear(); p.generate(); engine.retime(p, 'align'); };
const RHYTHM: LayerDef[] = [
  { key: 'steps', label: 'STEPS', min: 0, max: stack.STEP_CHOICES.length - 1, step: 1,
    toSlider: (v) => nearestIndex(stack.STEP_CHOICES, v), fromSlider: (i) => stack.STEP_CHOICES[i],
    fmt: (v) => String(v), apply: (v) => { P().steps = v; restructure(); } },
  { key: 'tracks', label: 'TRACKS', min: 1, max: 10, step: 1, fmt: (v) => String(v),
    apply: (v) => { P().tracks = v; P().overrides.clear(); P().fxOverrides.clear(); P().generate(); } },
  { key: 'cycle', label: 'CYCLE', min: 0.25, max: 32, step: 0.25,
    fmt: (v) => `${v} BEAT${v === 1 ? '' : 'S'}`, apply: (v) => { P().cycle = v; P().generate(); engine.retime(P(), 'align'); } },
  { key: 'density', label: 'DENSITY', min: 0, max: 1, step: 0.01, fmt: pct, apply: (v) => { P().density = v; P().generate(); } },
  { key: 'scatter', label: 'PATTERN', min: 0, max: 1, step: 0.01, fmt: (v) => (v < 0.5 ? `EVEN ${pct(v)}` : `SCATTER ${pct(v)}`),
    apply: (v) => { P().scatter = v; P().generate(); } },
  { key: 'onBeat', label: 'ON BEAT', min: 0, max: 1, step: 0.01, fmt: pct, apply: (v) => { P().onBeat = v; P().generate(); } },
  { key: 'chance', label: 'CHANCE', min: 0, max: 1, step: 0.01, fmt: pct, apply: (v) => { P().chance = v; } },
  { key: 'rest', label: 'REST', min: 0, max: 1, step: 0.01, fmt: pct, apply: (v) => { P().rest = v; } },
  { key: 'drift', label: 'DRIFT', min: -0.03, max: 0.03, step: 0.0005, reset: 0,
    fmt: (v) => `${signed(v * 100, 2)}%`, apply: (v) => { P().drift = v; engine.retime(P(), 'continuous'); } },
  { key: 'micro', label: 'MICRO', min: 0, max: 1, step: 0.01, fmt: (v) => `${pct(v)} STEP`, apply: (v) => { P().micro = v; P().refresh(); } },
  { key: 'swing', label: 'SWING', min: 0, max: 0.5, step: 0.01, reset: 0, fmt: pct, apply: (v) => { P().swing = v; P().refresh(); } },
  { key: 'heads', label: 'HEADS', min: 1, max: 4, step: 1, fmt: (v) => String(v), apply: (v) => { P().heads = v; P().generate(); } },
  { key: 'fxDensity', label: 'FX', min: 0, max: 1, step: 0.01, fmt: pct, apply: (v) => { P().fxDensity = v; P().assignFx(); } },
  { key: 'level', label: 'LEVEL', min: 0, max: 1.2, step: 0.01, fmt: pct, apply: (v) => { P().level = v; } },
];
const FRAG: LayerDef[] = [
  { key: 'grainMs', label: 'SIZE', min: 5, max: 600, step: 1,
    toSlider: (v) => Math.round(Math.log(v / 5) / Math.log(120) * 1000) / 1000 * 595 + 5,
    fromSlider: (s) => Math.round(5 * Math.pow(120, (s - 5) / 595)),
    fmt: (v) => `${v} MS`, apply: (v) => { P().grainMs = v; } },
  { key: 'slices', label: 'SLICES', min: 2, max: 64, step: 1, fmt: (v) => String(v), apply: (v) => { P().slices = v; } },
  { key: 'fadeIn', label: 'FADE IN', min: 0, max: 0.5, step: 0.01, fmt: pct, apply: (v) => { P().fadeIn = v; } },
  { key: 'fadeOut', label: 'FADE OUT', min: 0, max: 0.9, step: 0.01, fmt: pct, apply: (v) => { P().fadeOut = v; } },
  { key: 'spread', label: 'PITCH ±', min: 0, max: 24, step: 1, fmt: (v) => `${v} ST`, apply: (v) => { P().spread = v; } },
  { key: 'transpose', label: 'TRANSPOSE', min: -24, max: 24, step: 1, reset: 0, fmt: (v) => `${v > 0 ? '+' : ''}${v} ST`, apply: (v) => { P().transpose = v; } },
];
const CUTS: Array<{ label: string; value: PlateCut; title: string }> = [
  { label: 'OVERLAP', value: 'overlap', title: 'fragments start anywhere' },
  { label: 'DIVIDE', value: 'divide', title: 'equal slices (see SLICES)' },
  { label: 'TRANSIENT', value: 'transient', title: 'fragments start at detected attacks' },
  { label: 'RANDOM', value: 'random', title: 'a cut mode picked per sound' },
];

function LayerSlider({ d }: { d: LayerDef }) {
  const p = stack.sel;
  return (
    // keyed by plate: a different plate is a fresh control (no leftover thumb position)
    <Slider key={p.index} id={d.key} label={d.label} min={d.min} max={d.max} step={d.step} reset={d.reset}
      toSlider={d.toSlider} fromSlider={d.fromSlider} fmt={d.fmt}
      value={(p as unknown as Record<string, number>)[d.key]}
      onStart={() => app.startLayerGesture(d.key)}
      onInput={(v) => { d.apply(v); notify(); }} />
  );
}

function Layer() {
  const p = stack.sel;
  const nfx = p.chips.filter((c) => c.fx).length;
  return (
    <section className="block" id="layer-block">
      <header>
        <button className="ghost tiny" id="sel-prev" aria-label="Previous layer" onClick={() => app.select(stack.selected - 1)}>◀</button>
        <h2 id="sel-name">{`${p.name} · ${p.chips.length} CHIPS${nfx ? ` · ${nfx} FX` : ''}`}</h2>
        <button className="ghost tiny" id="sel-next" aria-label="Next layer" onClick={() => app.select(stack.selected + 1)}>▶</button>
      </header>
      <div className="row">
        <Toggle id="btn-hold" on={p.hold} title="Keep this plate through new phrases and regeneration (H)" onClick={() => app.toggleHold()}>{p.hold ? '● HOLD' : '○ HOLD'}</Toggle>
        <Toggle id="btn-mute" on={p.mute} title="Mute (M)" onClick={() => app.toggleMute()}>MUTE</Toggle>
        <Toggle id="btn-solo" on={p.solo} title="Solo" onClick={() => app.toggleSolo()}>SOLO</Toggle>
        <button id="btn-dir" title="Spin direction" onClick={() => app.flipDir()}>{p.dir > 0 ? 'DIR ↻' : 'DIR ↺'}</button>
        <button id="btn-regen" title="New pattern & fragments for this plate (R)" onClick={() => app.regen()}>REGEN</button>
        <button id="btn-mutate" title="New structure for this plate in the current style" onClick={() => app.drawSel()}>DRAW</button>
      </div>
      <div className="sub-head">RHYTHM</div>
      <div id="layer-sliders">{RHYTHM.map((d) => <LayerSlider key={d.key} d={d} />)}</div>
      <div className="sub-head">FRAGMENTS</div>
      <Seg id="cut-row" items={CUTS} value={p.cut} onPick={(v) => app.setCut(v)} />
      <div id="frag-sliders">{FRAG.map((d) => <LayerSlider key={d.key} d={d} />)}</div>
      <div className="row"><Toggle id="btn-choke" on={p.choke} title="Each new grain cuts the previous one on this plate" onClick={() => app.toggleChoke()}>CHOKE</Toggle></div>
      <div className="sub-head">MAP <span className="dim">— every chip's fragment, flashing as it plays</span></div>
      <FragmentMap />
      <div className="pool-head">SAMPLES FROM <span className="dim">(none selected = all)</span></div>
      <Pool />
    </section>
  );
}

function SoundsBlock() {
  const fileInput = useRef<HTMLInputElement>(null);
  const list = sounds.list;
  const mic = app.mic;
  return (
    <section className="block">
      <header><h2>SOUNDS</h2> <span className="dim" id="snd-count">{`${list.length} · ${list.filter((s) => !s.builtin).length} YOURS`}</span></header>
      {/* a real button opens the picker; clicking anywhere on the drop area does too */}
      <div id="dropzone" className="dropzone" onClick={() => fileInput.current?.click()}>
        <button id="btn-add-sounds" className="add" type="button">＋ ADD SOUNDS</button>
        <small>click or drop audio files · they feed every plate</small>
      </div>
      <input type="file" id="file-input" hidden accept="audio/*,.wav,.mp3,.ogg,.flac,.m4a,.aac,.aif,.aiff" multiple ref={fileInput}
        onChange={(e) => { const files = Array.from(e.target.files || []); e.target.value = ''; app.addFiles(files); }} />
      <div className="row">
        <button id="btn-mic" className={mic.state === 'recording' ? 'rec' : undefined} title="Record from microphone (max 20 s)" onClick={() => app.toggleMic()}>
          {mic.state === 'starting' ? '… ALLOW MIC' : mic.state === 'recording' ? `■ STOP ${mic.elapsed.toFixed(1)}s` : '● REC MIC'}
        </button>
        <button id="btn-resample" className={app.resampling ? 'rec' : undefined} aria-busy={app.resampling ? 'true' : undefined}
          title="Capture 4 s of the machine itself as a new sound" onClick={() => app.resample()}>
          {app.resampling ? '⟲ CAPTURING…' : '⟲ RESAMPLE 4s'}
        </button>
        <Toggle id="btn-builtins" on={list.some((s) => s.builtin && s.enabled)} title="Enable / disable synthesized sources" onClick={() => app.toggleBuiltins()}>BUILT-INS</Toggle>
        <button id="btn-clear-sounds" disabled={!list.some((s) => !s.builtin || s.enabled) && app.importsPending === 0 && mic.state === 'idle' && !app.resampling}
          title="Remove all added sounds and turn off built-ins; keep patterns and layer settings"
          onClick={() => app.clearSounds()}>CLEAR ALL</button>
      </div>
      <SoundList />
    </section>
  );
}

function Output() {
  const projectInput = useRef<HTMLInputElement>(null);
  return (
    <section className="block" id="output-block" aria-busy={app.exportBusy ? 'true' : undefined}>
      <header><h2>OUTPUT</h2></header>
      <Seg id="len-row" value={exporter.phrases} onPick={(v) => app.setExportPhrases(v)}
        items={[1, 2, 4].map((n) => ({ label: `${n} PHRASE${n > 1 ? 'S' : ''}`, value: n }))} />
      <Seg id="loop-row" value={exporter.mode} onPick={(v) => app.setExportMode(v)} items={[
        { label: 'AS PLAYED', value: 'tail', title: 'exactly what PLAY plays, plus 4 s of reverb/delay tail' },
        { label: 'LOOP', value: 'loop', title: 'exact length at the current project BPM, with the tail folded onto the start' },
      ] as Array<{ label: string; value: typeof exporter.mode; title: string }>} />
      <div className="row">
        <button id="btn-export-wav" title="Render the mix from bar 1 (offline, seeded)" disabled={app.exportBusy} onClick={() => app.runExport('wav')}>⤓ EXPORT WAV</button>
        <button id="btn-export-stems" title="One WAV per audible plate, zipped" disabled={app.exportBusy} onClick={() => app.runExport('stems')}>⤓ STEMS .ZIP</button>
      </div>
      <p className="hint" id="export-status" role="status">{app.exportStatus ?? app.exportSummary()}</p>
      <div className="sub-head">PROJECT</div>
      <div className="row">
        <button id="btn-save-project" title="Download the whole machine as a .json file: settings, plates, keep slots, flight and your sounds" onClick={() => app.saveProject()}>⤓ SAVE .JSON</button>
        <button id="btn-open-project" title="Open a saved .json project (replaces the current machine)" onClick={() => projectInput.current?.click()}>⤒ OPEN .JSON</button>
        <button id="btn-share" title="Copy a link to this setup, including settings and sounds" disabled={app.shareBusy} onClick={() => app.share()}>{app.shareBusy ? 'SHARING…' : 'SHARE'}</button>
      </div>
      <input type="file" id="project-input" hidden accept=".json,application/json" ref={projectInput}
        onChange={(e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) app.openProject(f); }} />
      <p className="hint" id="export-flight-note" hidden={!flight.on}>in flight, exports render what the ship hears from bar 1: sensor hits, proximity and your position — on autopilot, the path carries on exactly as it will after PLAY</p>
    </section>
  );
}

function Handling() {
  return (
    <section className="block help">
      <header><h2>HANDLING</h2></header>
      <p>Drag to orbit · wheel to zoom · click a plate to select · <b>shift-click</b> a cell to add/remove a chip · <b>alt-click</b> a chip to cycle its FX · hover a chip to inspect its fragment.</p>
      <p>Keyboard: <b>Tab</b> to the stack, then <b>arrows</b> move a cell cursor (<b>PgUp/PgDn</b> change plate), <b>Enter</b> adds/removes a chip, <b>⇧Enter</b> cycles its FX, <b>[ ]</b> orbit, <b>− =</b> zoom, <b>0</b> resets the view.</p>
      <p>Keys: <b>F</b> fly · <b>space</b> play · <b>N</b> new phrase (<b>⇧N</b> at phrase end) · <b>K</b> keep · <b>⌘Z</b> undo · <b>H</b> hold · <b>S</b> split · <b>O</b> orbit · <b>R</b> regen (<b>⇧R</b> all) · <b>M</b> mute (<b>⇧M</b> mutate all) · <b>1–7</b> select · <b>P</b> panel</p>
      <div className="row"><Toggle id="btn-shortcuts" on={app.shortcuts} title="Turn single-letter shortcuts off (they then work only while the stack has focus)" onClick={() => app.toggleShortcuts()}>{`SINGLE-KEY SHORTCUTS: ${app.shortcuts ? 'ON' : 'OFF'}`}</Toggle></div>
    </section>
  );
}
