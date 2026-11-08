/* The frame loop: visual events → flashes, flight, camera, listener, meters, draw, HUD. */
import { engine } from '../core/engine';
import { flight } from '../core/flight';
import { view } from '../core/view';
import { runFrameFns } from './store';

let started = false;

/** Attach the renderer to the stage canvas and start drawing. Idempotent
 *  (StrictMode runs effects twice; there must only ever be one loop). */
export function startLoop(canvas: HTMLCanvasElement) {
  if (started) return;
  started = true;
  view.init(canvas);
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
    runFrameFns(tv);

    frames++; acc += now - last; last = now;
    if (acc > 1000) { window.MR_DEBUG.fps = Math.round(frames * 1000 / acc); frames = 0; acc = 0; }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
