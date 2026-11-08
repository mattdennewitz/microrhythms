/* Bootstrap + frame loop. */
import './styles.css';
import * as util from './core/util';
import { stack } from './core/stack';
import { sounds } from './core/sounds';
import { engine } from './core/engine';
import { history } from './core/history';
import { exporter } from './core/exporter';
import { project } from './core/project';
import { flight } from './core/flight';
import { view } from './core/view';
// plain-JS legacy UI (phase 1 only), replaced by React in the next phase
import { ui } from './legacy-ui.js';

declare global {
  interface Window {
    MR_DEBUG: Record<string, unknown> & { fps: number; drawMs: number };
    MR?: Record<string, unknown>;
  }
}

function boot() {
  stack.createDefault();
  sounds.initBuiltins();
  view.init(document.getElementById('stage') as HTMLCanvasElement);
  ui.init();

  // Debug / test hook.
  window.MR_DEBUG = {
    get triggers() { return engine.stats.triggers; },
    get scheduled() { return engine.stats.scheduled; },
    get sensor() { return flight.stats.sensor; },
    get dropped() { return engine.stats.dropped; },
    get voices() { return engine.voices; },
    get playing() { return engine.playing; },
    get sounds() { return sounds.list.map((s) => ({ id: s.id, name: s.name, builtin: s.builtin, dur: s.buffer.duration })); },
    plates: () => stack.plates.map((p) => ({ name: p.name, chips: p.chips.length, sources: [...p.sourceIds], fires: p.fireCount })),
    fps: 0,
    drawMs: 0,
  };
  if (import.meta.env.DEV) window.MR = { util, stack, sounds, engine, history, exporter, project, flight, view, ui };

  let last = performance.now(), frames = 0, acc = 0;
  function frame(now: number) {
    const E = engine, V = view;
    const tv = E.playing ? E.visualTime() : 0;

    // consume due visual events → flashes + per-plate counters
    // (events are grouped per plate per tick, so not globally sorted)
    if (E.events.length) {
      const pending = [];
      for (const ev of E.events) {
        if (ev.t <= tv) {
          if (ev.t > ev.chip.lastFire) ev.chip.lastFire = ev.t;
          if (ev.t > ev.plate.lastFire) ev.plate.lastFire = ev.t;
          if (ev.sensor && !(ev.plate.lastSensor > ev.t)) ev.plate.lastSensor = ev.t;
          ev.plate.fireCount++;
        } else pending.push(ev);
      }
      E.events = pending;
    }

    if (flight.on) flight.update(tv);
    V.updateCamera(now / 1000);
    E.updateSpace(V);
    E.readMeters();
    const d0 = performance.now();
    V.draw(tv, E.playing, now / 1000);
    window.MR_DEBUG.drawMs = window.MR_DEBUG.drawMs * 0.9 + (performance.now() - d0) * 0.1;
    ui.updateHud(tv);

    frames++; acc += now - last; last = now;
    if (acc > 1000) { window.MR_DEBUG.fps = Math.round(frames * 1000 / acc); frames = 0; acc = 0; }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
