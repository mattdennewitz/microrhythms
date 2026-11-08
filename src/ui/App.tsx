/* The whole page: stage + HUD, panel, flight dock, drop veil, toast, live region. */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { flight } from '../core/flight';
import { app } from '../app/controller';
import { useRevision } from '../app/store';
import { Stage } from './Stage';
import { Hud } from './Hud';
import { Panel } from './Panel';
import { Toggle } from './controls';
import { useGlobalKeys } from './keys';

export function App() {
  useRevision();
  useGlobalKeys();
  useFileDrop();

  // body classes drive the layout CSS (panel slide, flight dock, drop veil)
  useLayoutEffect(() => {
    const b = document.body.classList;
    b.toggle('panel-hidden', app.panelHidden);
    b.toggle('flying', flight.on);
    b.toggle('dragover', app.dragover);
  });

  return (
    <>
      <main>
        <h1 className="sr-only">Orbital Stack — micro-rhythm machine</h1>
        <Stage />
        <Hud />
        <button id="panel-toggle" className="ghost" title="Toggle panel (P)" aria-controls="panel"
          aria-expanded={app.panelHidden ? 'false' : 'true'} onClick={() => app.togglePanel()}>≡ PANEL</button>
        <FlyDock />
      </main>
      <Panel />
      <div id="drop-veil"><div>DROP AUDIO TO SAMPLE</div></div>
      <Toast />
      <LiveRegion />
    </>
  );
}

/** On-canvas dock: FLY/LAND always reachable (mobile panel is hidden), plus
 *  hold-to-thrust buttons so flight works with touch or mouse alone. */
function FlyDock() {
  const autopilot = !flight.autopilot ? 'MANUAL' : flight.paused() ? 'AUTOPILOT ❚❚' : 'AUTOPILOT';
  return (
    <div id="fly-dock" role="toolbar" aria-label="Flight controls" className={flight.on ? 'flying' : undefined}>
      <button id="dock-fly" className="ghost" title="Fly / land (F)" onClick={() => app.toggleFlight()}>{flight.on ? '✈ LAND' : '✈ FLY'}</button>
      <span className="dock-flight">
        <Toggle id="dock-auto" className="ghost" on={flight.autopilot} title="Autopilot / manual (C)" onClick={() => app.toggleAutopilot()}>{autopilot}</Toggle>
        <HoldButton id="dock-fwd" k="w" title="Hold: thrust forward (W)">▲ THRUST</HoldButton>
        <HoldButton id="dock-back" k="s" title="Hold: reverse (S)">▼</HoldButton>
        <HoldButton id="dock-brake" k="x" title="Hold: brake (X)">■ BRAKE</HoldButton>
      </span>
    </div>
  );
}

function HoldButton({ id, k, title, children }: { id: string; k: string; title: string; children: string }) {
  const [held, setHeld] = useState(false);
  const off = () => { app.holdKey(k, false); setHeld(false); };
  return (
    <button id={id} className={'ghost' + (held ? ' on' : '')} title={title}
      onPointerDown={(e) => { e.preventDefault(); if (app.holdKey(k, true)) setHeld(true); }}
      onPointerUp={off} onPointerLeave={off} onPointerCancel={off}>{children}</button>
  );
}

function Toast() {
  const { text, n } = app.toastMsg;
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (!n) return;
    setShow(true);
    const t = setTimeout(() => setShow(false), 2400);
    return () => clearTimeout(t);
  }, [n]);
  return <div id="toast" role="status" aria-live="polite" className={show ? 'show' : undefined}>{text}</div>;
}

/** Visually hidden live region: cleared, then filled a beat later so a repeat is re-announced. */
function LiveRegion() {
  const { text, n } = app.announceMsg;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const r = ref.current;
    if (!n || !r) return;
    r.textContent = '';
    const t = setTimeout(() => { r.textContent = text; }, 30);
    return () => clearTimeout(t);
  }, [n, text]);
  return <div id="sr-live" className="sr-only" role="status" aria-live="polite" ref={ref}></div>;
}

/** Drop audio files anywhere on the page to sample them. */
function useFileDrop() {
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
    const set = (on: boolean) => { if (app.dragover !== on) { app.dragover = on; document.body.classList.toggle('dragover', on); } };
    const ac = new AbortController();
    const o = { signal: ac.signal };
    window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; set(true); }, o);
    window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); }, o);
    window.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) set(false); }, o);
    window.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      set(false);
      app.addFiles(e.dataTransfer!.files);
    }, o);
    return () => ac.abort();
  }, []);
}
