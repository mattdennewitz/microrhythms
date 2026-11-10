/* The frame loop: visual events → flashes, flight, camera, listener, meters, draw, HUD. */
import { engine } from '../core/engine';
import { flight } from '../core/flight';
import { view } from '../core/view';
import { runFrameFns } from './store';

/** Attach the renderer and run one loop for the lifetime of the stage effect.
 * Cleanup lets StrictMode replay the effect, or a new stage mount, start fresh. */
export function startLoop(canvas: HTMLCanvasElement) {
  const disposeView = view.init(canvas);
  let last = performance.now(), frames = 0, acc = 0;
  function frame(now: number) {
    const E = engine, V = view;
    const tv = E.playing ? E.visualTime() : 0;

    E.consumeEvents(tv);

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
    raf = requestAnimationFrame(frame);
  }
  let raf = requestAnimationFrame(frame);
  return () => {
    cancelAnimationFrame(raf);
    disposeView();
  };
}
