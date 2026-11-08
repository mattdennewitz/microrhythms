/* Undo / redo: a ring of whole-stack snapshots. */
import { stack, type StackSnapshot } from './stack';
import { engine } from './engine';

export type HistoryEvent = 'push' | 'undo' | 'redo' | 'reset';
interface Step { label: string; snap: StackSnapshot }

export const history = {
  past: [] as Step[],
  future: [] as Step[],
  max: 50,
  lastPush: { label: null as string | null, at: 0 },
  listeners: new Set<(type: HistoryEvent) => void>(),
  /** Subscribe; returns an unsubscribe function. */
  onChange(fn: (type: HistoryEvent) => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; },
  emit(type: HistoryEvent) { this.listeners.forEach((fn) => fn(type)); },

  /** Record the state *before* an action. With `coalesce` (slider gestures),
   *  rapid repeats of the same label collapse into one step; discrete actions
   *  (new phrase, regen, chip edits) always get their own step. */
  push(label: string, coalesce = false) {
    const now = performance.now();
    if (coalesce && label === this.lastPush.label && now - this.lastPush.at < 700) { this.lastPush.at = now; return; }
    this.lastPush = { label, at: now };
    this.past.push({ label, snap: stack.snapshot() });
    if (this.past.length > this.max) this.past.shift();
    this.future = [];
    this.emit('push');
  },

  undo(): string | null {
    const step = this.past.pop();
    if (!step) return null;
    this.future.push({ label: step.label, snap: stack.snapshot() });
    engine.applyNow(() => stack.restore(step.snap));
    this.lastPush = { label: null, at: 0 };
    this.emit('undo');
    return step.label;
  },

  redo(): string | null {
    const step = this.future.pop();
    if (!step) return null;
    this.past.push({ label: step.label, snap: stack.snapshot() });
    engine.applyNow(() => stack.restore(step.snap));
    this.lastPush = { label: null, at: 0 };
    this.emit('redo');
    return step.label;
  },

  /** Forget everything (a newly opened project). */
  clear() {
    this.past = [];
    this.future = [];
    this.emit('reset');
  },
};
