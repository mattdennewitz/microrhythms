/* The machine's state lives in the core singletons and is mutated in place.
 * React subscribes to a single revision counter: every action that changes
 * state calls `notify()`, and components re-read what they show. */
import { useSyncExternalStore } from 'react';

let revision = 0;
const listeners = new Set<() => void>();

export function notify() {
  revision++;
  listeners.forEach((fn) => fn());
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Re-render whenever any action has changed the machine. */
export function useRevision(): number {
  return useSyncExternalStore(subscribe, () => revision);
}

// ---------------------------------------------------------------- frame loop
/** Per-frame work outside React (HUD readouts, meters, the fragment map). */
type FrameFn = (tv: number) => void;
const frameFns = new Set<FrameFn>();
export function onFrame(fn: FrameFn) {
  frameFns.add(fn);
  return () => { frameFns.delete(fn); };
}
export function runFrameFns(tv: number) {
  frameFns.forEach((fn) => fn(tv));
}
