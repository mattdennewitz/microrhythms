/* Bootstrap: build the machine, mount the UI, run the frame loop. */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
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
import { app } from './app/controller';
import { App } from './ui/App';
import { sharing } from './app/sharing';

declare global {
  interface Window {
    /** Debug / test hook (documented in the README). */
    MR_DEBUG: Record<string, unknown> & { fps: number; drawMs: number };
    /** Every core module, in development builds only. */
    MR?: Record<string, unknown>;
  }
}

// The machine exists before (and independently of) the UI. Module scope runs
// once, so StrictMode's double-invoked effects can't build a second machine.
stack.createDefault();
sounds.initBuiltins();
app.init();

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
if (import.meta.env.DEV) window.MR = { util, stack, sounds, engine, history, exporter, project, flight, view, app };

void sharing.init((message) => app.toast(message)).then((dispose) => {
  import.meta.hot?.dispose(dispose);
  createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
});
