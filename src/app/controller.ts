/* App actions and UI state: everything the panel, keys and pointer can do.
 * Components render from the core singletons plus this state, and call these
 * actions; every action that changes something ends with `notify()`. */
import { clamp, mod } from '../core/util';
import { stack, type StackSnapshot, type StyleName } from '../core/stack';
import { sounds } from '../core/sounds';
import { engine, type Capture, type Switch } from '../core/engine';
import { history } from '../core/history';
import { exporter } from '../core/exporter';
import { project } from '../core/project';
import { flight } from '../core/flight';
import { view } from '../core/view';
import { registerUi } from '../core/bridge';
import type { FxType } from '../core/types';
import { notify } from './store';
import { sharing } from './sharing';

const NARROW = 760;

export const app = {
  // ---------------------------------------------------------------- UI state
  slots: [null, null, null, null] as Array<StackSnapshot | null>,
  activeSlot: null as number | null,
  shortcuts: true,               // single-key shortcuts (WCAG 2.1.4: can be turned off)
  panelHidden: false,
  hintGone: false,
  dragover: false,
  cell: { track: 0, sector: 0 }, // keyboard cell cursor on the selected plate
  /** Toast and live-region messages carry a counter so an identical message re-shows. */
  toastMsg: { text: '', n: 0 },
  announceMsg: { text: '', n: 0 },
  exportStatus: null as string | null, // null = the default summary line
  exportBusy: false,
  shareBusy: false,
  mic: { state: 'idle' as 'idle' | 'starting' | 'recording', elapsed: 0 },
  resampling: false,
  panelEl: null as HTMLElement | null,

  /** Visually hidden live region for state changes (play/stop, switches). */
  announce(msg: string) { this.announceMsg = { text: msg, n: this.announceMsg.n + 1 }; notify(); },
  toast(msg: string) { this.toastMsg = { text: msg, n: this.toastMsg.n + 1 }; notify(); },

  setPanelHidden(h: boolean) { this.panelHidden = h; notify(); },
  togglePanel() { this.setPanelHidden(!this.panelHidden); },
  panelWidth() {
    if (this.panelHidden || window.innerWidth <= NARROW) return 0;
    return this.panelEl ? this.panelEl.offsetWidth : 0;
  },

  init() {
    history.onChange((type) => {
      // any new edit means the stack no longer equals the active keep slot
      if (type === 'push' && this.activeSlot != null) this.activeSlot = null;
      notify();
    });
    sounds.onChange(() => notify());
    try { this.shortcuts = localStorage.getItem('orbital.shortcuts') !== 'off'; } catch { /* storage blocked */ }
    engine.onEvolve = () => notify();
    engine.onSwitch = (sw) => this.afterSwitch(sw);
    this.panelHidden = window.innerWidth <= NARROW;
    registerUi(this);
  },

  /** Every generative / edit action: record undo, change state, re-sync. */
  act(label: string, fn: () => void, align = true) {
    history.push(label);
    engine.applyNow(fn, align);
    this.activeSlot = null;
    notify();
  },

  // ---------------------------------------------------------------- transport
  async togglePlay() {
    if (engine.playing) engine.stop(); else await engine.start();
    this.announce(engine.playing ? 'playing from bar 1' : 'stopped');
    if (engine.playing) this.hintGone = true;
    this.afterSwitch(); // autopilot pauses/resumes with playback
  },

  toggleMode() {
    view.mode = view.mode === 'ORBIT' ? 'SPLIT' : 'ORBIT';
    view.sepTarget = view.mode === 'SPLIT' ? 1.85 : 1.25;
    notify();
  },

  toggleOrbit() { view.autoOrbit = !view.autoOrbit; notify(); },

  toggleEar() {
    engine.earMode = engine.earMode === 'camera' ? 'fixed' : 'camera';
    this.toast(engine.earMode === 'camera' ? 'listener rides the camera' : 'listener fixed at home view');
  },

  togglePan() { engine.panModel = engine.panModel === 'HRTF' ? 'equalpower' : 'HRTF'; notify(); },

  // ---------------------------------------------------------------- flight
  toggleFlight() {
    if (flight.on) flight.exit(); else flight.enter();
    if (flight.on) this.hintGone = true;
    const resumed = flight.on && flight.saved;
    const msg = !flight.on ? 'landed — take off again to resume from here' : resumed ? 'flight resumed where you landed' : engine.playing ? 'flight — autopilot cruising · W/A/S/D to take the stick'
      : 'flight — autopilot cruises when you press play · W/A/S/D to fly now';
    this.toast(msg);
    this.announce(msg);
  },
  toggleAutopilot() {
    if (!flight.on) return;
    if (flight.autopilot) flight.takeManual(); else flight.engageAutopilot();
    notify();
  },
  syncAutopilot() { notify(); },
  restartFlightPath() {
    flight.saved = null;
    if (flight.on) flight.enter(true);
    this.toast('flight path restarts at the first plate');
  },
  toggleSensorChance() { flight.useChance = !flight.useChance; notify(); },
  /** Hold-to-thrust from the on-canvas dock (touch / mouse). */
  holdKey(key: string, down: boolean) {
    if (down) {
      if (!flight.on) return false;
      if (flight.autopilot) { flight.takeManual(); notify(); }
      flight.keys.add(key);
      return true;
    }
    flight.keys.delete(key);
    return false;
  },

  // ---------------------------------------------------------------- compose
  setStyle(s: StyleName) { stack.style = s; notify(); },

  newPhrase() {
    this.act(`new phrase · ${stack.style}`, () => stack.drawAll(stack.style));
    this.toast(`new phrase · ${stack.style}${stack.plates.some((p) => p.hold) ? ' · held plates kept' : ''}`);
  },

  queuePhrase() {
    if (engine.pendingOf('phrase')) { engine.cancel('phrase'); this.toast('queued phrase cancelled'); return; }
    const style = stack.style;
    const sw = engine.queue('phrase', 'phrase', () => { history.push(`new phrase · ${style}`); stack.drawAll(style); this.activeSlot = null; }, 'NEW');
    if (!sw) { this.afterSwitch(); return; }
    this.toast(`new phrase (${style}) at the next phrase line`);
  },

  keep(slot?: number) {
    const i = slot != null ? slot : this.slots.indexOf(null);
    if (i < 0) { this.toast('all four slots full — release one with ×'); return; }
    this.slots[i] = stack.snapshot();
    this.activeSlot = i;
    this.toast(`kept → slot ${i + 1}`);
  },

  recall(i: number, quant: 'bar' | 'phrase') {
    const snap = this.slots[i];
    if (!snap) return;
    const pend = engine.pendingOf('scene');
    if (pend && pend.slot === i && pend.quant === quant) {
      engine.cancel('scene');
      this.toast(`slot ${i + 1} recall cancelled`); this.announce(`slot ${i + 1} recall cancelled`);
      return;
    }
    const sw = engine.queue('scene', quant, () => {
      history.push(`recall ${i + 1}`);
      stack.restore(snap);
      this.activeSlot = i;
    }, `K${i + 1}`);
    if (!sw) { this.afterSwitch(); this.announce(`slot ${i + 1} recalled`); return; }
    sw.slot = i;
    this.toast(`slot ${i + 1} queued for the next ${quant}`);
    this.announce(`slot ${i + 1} queued for the next ${quant}`);
  },

  release(i: number) {
    const pend = engine.pendingOf('scene');
    if (pend && pend.slot === i) engine.cancel('scene');
    this.slots[i] = null;
    if (this.activeSlot === i) this.activeSlot = null;
    notify();
  },

  afterSwitch(sw?: Switch) {
    notify();
    if (sw && sw.label) this.announce(sw.label === 'NEW' ? 'new phrase now playing' : `slot ${sw.label.slice(1)} now playing`);
  },

  cancelQueued() {
    if (!engine.pending.length) return;
    engine.pending = [];
    notify();
  },
  undo() {
    this.cancelQueued();
    const l = history.undo();
    if (l) { this.activeSlot = null; this.afterSwitch(); this.toast(`undo · ${l.replace(/^L_/, '')}`); }
  },
  redo() {
    this.cancelQueued();
    const l = history.redo();
    if (l) { this.activeSlot = null; this.afterSwitch(); this.toast(`redo · ${l.replace(/^L_/, '')}`); }
  },

  regenAll() { this.act('regen all', () => stack.regenerateAll()); this.toast('regenerated plates not on hold'); },
  mutateAll() { this.act('mutate all', () => stack.mutateAll()); this.toast('new generation'); },
  toggleFx() { engine.fxOn = !engine.fxOn; notify(); },
  setFxType(t: FxType, on: boolean) { stack.setFxType(t, on); notify(); },
  setOnBeatAll(v: number) { stack.plates.forEach((p) => { p.onBeat = v; p.generate(); }); notify(); },

  // ---------------------------------------------------------------- layer
  select(i: number) {
    stack.selected = mod(i, stack.plates.length);
    notify();
  },
  toggleHold() {
    const p = stack.sel;
    p.hold = !p.hold;
    this.toast(`${p.name} ${p.hold ? 'on hold — kept through new phrases' : 'released'}`);
  },
  toggleMute() { history.push('mute'); stack.sel.mute = !stack.sel.mute; notify(); },
  toggleSolo() { history.push('solo'); stack.sel.solo = !stack.sel.solo; notify(); },
  toggleChoke() { history.push('choke'); stack.sel.choke = !stack.sel.choke; notify(); },
  flipDir() { history.push('dir'); stack.sel.dir *= -1; stack.sel.refresh(); engine.retime(stack.sel, 'align'); notify(); },
  regen() { this.act(`regen ${stack.sel.name}`, () => stack.regenerate(stack.sel)); },
  drawSel() { this.act(`draw ${stack.sel.name} · ${stack.style}`, () => stack.draw(stack.sel, stack.style)); },
  /** A layer slider gesture starts: one undo step per gesture, and the stack leaves its keep slot. */
  startLayerGesture(key: string) { history.push(`L_${key}·${stack.sel.name}`, true); this.activeSlot = null; notify(); },
  setCut(v: typeof stack.sel.cut) { history.push('cut'); stack.sel.cut = v; notify(); },
  /** Meter-row mute button: click mutes, shift-click solos. */
  meterMute(i: number, solo: boolean) {
    const pl = stack.plates[i];
    if (solo) { history.push('solo'); pl.solo = !pl.solo; this.toast(`${pl.name} ${pl.solo ? 'solo' : 'solo off'}`); }
    else { history.push('mute'); pl.mute = !pl.mute; }
    this.announce(`${pl.name} ${solo ? (pl.solo ? 'solo on' : 'solo off') : (pl.mute ? 'muted' : 'unmuted')}`);
  },
  togglePoolSource(id: number) { history.push('pool'); sounds.togglePlateSource(stack.sel, id); },

  // ---------------------------------------------------------------- output
  setExportPhrases(n: number) { exporter.phrases = n; this.exportStatus = null; notify(); },
  setExportMode(m: typeof exporter.mode) { exporter.mode = m; notify(); },
  exportSummary() {
    return `${exporter.phrases * stack.phraseBars} bars · ${exporter.seconds().toFixed(1)} s · what PLAY plays, from bar 1 · 24-bit 48 kHz`;
  },
  async runExport(kind: 'wav' | 'stems') {
    if (exporter.busy) { this.toast('an export is already rendering'); this.announce('an export is already rendering'); return; }
    this.exportBusy = true;
    let lastPct = -1;
    const status = (s: string) => { this.exportStatus = s; notify(); };
    const progress = (i: number, n: number, name: string, f?: number) => {
      const pct = Math.floor(((i + (f || 0)) / n) * 100);
      if (pct === lastPct) return;
      lastPct = pct;
      status(kind === 'wav' ? `rendering mix… ${pct}%` : `rendering stem ${i + 1}/${n} · ${name}… ${pct}%`);
    };
    try {
      status(kind === 'wav' ? 'rendering mix…' : 'rendering stems…');
      if (kind === 'wav') {
        const r = await exporter.exportWav({ onProgress: progress });
        if (r) status(`saved ${r.name} · ${r.from}`);
      } else {
        const r = await exporter.exportStems({ onProgress: progress });
        if (r) status(`saved ${r.name} · ${r.files.length} stems · ${r.from}`);
      }
    } catch (err) {
      status(`render failed: ${(err as Error).message}`);
      console.error(err);
    } finally {
      this.exportBusy = false;
      notify();
    }
  },
  saveProject() {
    try {
      const r = project.save();
      const msg = `saved ${r.name} · ${(r.bytes / 1024 / 1024).toFixed(1)} MB`;
      this.exportStatus = msg;
      this.toast(msg);
    } catch (err) { this.toast(`could not save: ${(err as Error).message}`); console.error(err); }
  },
  async share() {
    if (this.shareBusy) return;
    this.shareBusy = true;
    notify();
    try {
      await sharing.copy();
      this.toast('share link copied');
      this.announce('share link copied');
    } catch (err) {
      const message = `could not share: ${(err as Error).message}`;
      this.toast(message);
      this.announce(message);
    } finally {
      this.shareBusy = false;
      notify();
    }
  },
  async openProject(f: File) {
    try {
      await project.open(f);
      this.toast(`opened ${f.name} — press play`);
      this.announce(`opened ${f.name}`);
    } catch (err) { this.toast(`could not open ${f.name}: ${(err as Error).message}`); console.warn(err); }
  },
  /** After a project is opened every control re-reads state. */
  syncAll() { this.exportStatus = null; notify(); },

  toggleShortcuts() {
    this.shortcuts = !this.shortcuts;
    try { localStorage.setItem('orbital.shortcuts', this.shortcuts ? 'on' : 'off'); } catch { /* storage blocked */ }
    this.toast(this.shortcuts ? 'single-key shortcuts on' : 'single-key shortcuts off — they still work while the stack has focus');
  },

  // ---------------------------------------------------------------- sounds
  addBuffer(name: string, buf: AudioBuffer) {
    try {
      const snd = sounds.addUser(name, buf);
      this.toast(`${snd.name} added → all plates`);
    } catch (err) {
      this.toast(`could not use recording: ${(err as Error).message}`);
    }
  },

  async addFiles(files: FileList | File[] | null) {
    for (const f of Array.from(files || [])) {
      try {
        const snd = await sounds.addFile(f);
        this.toast(`${snd.name} (${snd.buffer.duration.toFixed(1)}s · ${snd.onsets.length} onsets) → all plates`);
      } catch (err) {
        const silent = /silent/.test((err as Error | null)?.message || '');
        this.toast(silent ? `${f.name} is silent or too short — not added` : `could not decode ${f.name}`);
        console.warn('add sound failed', f.name, err);
      }
    }
  },

  rec: null as Capture | null,
  recTimer: undefined as ReturnType<typeof setInterval> | undefined,
  async toggleMic() {
    if (this.mic.state === 'starting') return; // permission prompt / device still opening
    if (this.rec) { this.rec.stop(); return; }
    this.mic = { state: 'starting', elapsed: 0 }; notify();
    try {
      this.rec = await engine.recordMic(20, (buf: AudioBuffer) => {
        clearInterval(this.recTimer);
        this.rec = null;
        this.mic = { state: 'idle', elapsed: 0 }; notify();
        this.addBuffer('MIC', buf);
      });
      this.mic = { state: 'recording', elapsed: 0 }; notify();
      this.recTimer = setInterval(() => { if (this.rec) { this.mic = { state: 'recording', elapsed: this.rec.elapsed() }; notify(); } }, 100);
    } catch (err) {
      this.rec = null;
      this.mic = { state: 'idle', elapsed: 0 }; notify();
      this.toast(`mic unavailable: ${(err as Error).message || (err as Error).name}`);
    }
  },

  resample() {
    if (this.resampling) return; // one capture at a time
    if (!engine.playing) { this.toast('press play first — resample captures the output'); return; }
    this.resampling = true; notify();
    engine.resample(4, (buf: AudioBuffer) => {
      this.resampling = false; notify();
      this.addBuffer('RESAMPLE', buf);
    });
  },

  preview(id: number) {
    const s = sounds.get(id);
    if (!s) return;
    const ctx = engine.ensureCtx();
    ctx.resume();
    const src = ctx.createBufferSource();
    src.buffer = s.buffer;
    const g = ctx.createGain();
    g.gain.value = 0.6;
    src.connect(g).connect(engine.master);
    src.start();
    src.stop(ctx.currentTime + Math.min(4, s.buffer.duration));
  },

  toggleBuiltins() {
    // the button reflects the list: on if any built-in is enabled
    const on = !sounds.list.some((s) => s.builtin && s.enabled);
    sounds.setAllBuiltins(on);
  },

  // ---------------------------------------------------------------- stage
  /** Keep the keyboard cell cursor on the selected plate; optionally announce it. */
  syncCell(say: boolean) {
    const p = stack.sel, c = this.cell;
    c.track = clamp(c.track, 0, p.tracks - 1);
    c.sector = mod(c.sector, p.steps);
    view.cursorCell = { plate: p, track: c.track, sector: c.sector };
    const chip = p.chips.find((x) => x.key === c.track * p.steps + c.sector) || null;
    view.hover = chip ? { plate: p, chip } : null;
    if (say) this.announce(`${p.name}, track ${c.track + 1} of ${p.tracks}, step ${c.sector + 1} of ${p.steps}: ${chip ? `chip${chip.fx ? ', ' + chip.fx : ''}` : 'empty'}`);
  },
  clearCell() { view.cursorCell = null; view.hover = null; },
};
