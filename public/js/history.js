/* Undo / redo: a ring of whole-stack snapshots. */
(function (MR) {
  'use strict';

  const history = {
    past: [],
    future: [],
    max: 50,
    lastPush: { label: null, at: 0 },
    listeners: new Set(),
    onChange(fn) { this.listeners.add(fn); },
    emit(type) { this.listeners.forEach((fn) => fn(type)); },

    /** Record the state *before* an action. With `coalesce` (slider gestures),
     *  rapid repeats of the same label collapse into one step; discrete actions
     *  (new phrase, regen, chip edits) always get their own step. */
    push(label, coalesce = false) {
      const now = performance.now();
      if (coalesce && label === this.lastPush.label && now - this.lastPush.at < 700) { this.lastPush.at = now; return; }
      this.lastPush = { label, at: now };
      this.past.push({ label, snap: MR.stack.snapshot() });
      if (this.past.length > this.max) this.past.shift();
      this.future = [];
      this.emit('push');
    },

    undo() {
      const step = this.past.pop();
      if (!step) return null;
      this.future.push({ label: step.label, snap: MR.stack.snapshot() });
      MR.engine.applyNow(() => MR.stack.restore(step.snap));
      this.lastPush = { label: null, at: 0 };
      this.emit('undo');
      return step.label;
    },

    redo() {
      const step = this.future.pop();
      if (!step) return null;
      this.past.push({ label: step.label, snap: MR.stack.snapshot() });
      MR.engine.applyNow(() => MR.stack.restore(step.snap));
      this.lastPush = { label: null, at: 0 };
      this.emit('redo');
      return step.label;
    },
  };

  MR.history = history;
})(window.MR);
