/* Panel, HUD, pointer + keyboard handling.
 * TEMPORARY (phase 1 of the React migration): the old DOM UI as an ES module,
 * so the TypeScript core can be checked against the old build before the React UI replaces this file. */
import { clamp, pad, signed, TAU, mod } from './core/util';
import { stack } from './core/stack';
import { sounds } from './core/sounds';
import { engine } from './core/engine';
import { history } from './core/history';
import { exporter } from './core/exporter';
import { project } from './core/project';
import { flight } from './core/flight';
import { view } from './core/view';
import { registerUi } from './core/bridge';

  const $ = (id) => document.getElementById(id);
  const FX_TYPES = ['ratchet', 'stutter', 'reverse', 'throw'];

  function slider(parent, o) {
    const wrap = document.createElement('div');
    wrap.className = 'slider';
    const id = 'sl-' + o.key;
    wrap.innerHTML = `<label for="${id}">${o.label}</label><input type="range" id="${id}" min="${o.min}" max="${o.max}" step="${o.step}"><output for="${id}"></output>`;
    const input = wrap.querySelector('input'), out = wrap.querySelector('output');
    const toSlider = o.toSlider || ((v) => v), fromSlider = o.fromSlider || ((v) => v);
    // what's shown is also what assistive tech announces (not the raw index / log value)
    const show = (txt) => { out.textContent = txt; input.setAttribute('aria-valuetext', txt); };
    const set = (v, mixed) => {
      wrap.classList.toggle('mixed', !!mixed);
      input.value = toSlider(v);
      show(mixed ? 'MIXED' : o.fmt(v));
    };
    // one undo step per gesture, whatever the input method (drag, arrows, PageUp, AT)
    let gesture = false;
    const start = () => { if (o.onStart) o.onStart(); };
    input.addEventListener('pointerdown', () => { gesture = true; start(); });
    input.addEventListener('change', () => { gesture = false; });
    input.addEventListener('input', () => {
      if (!gesture) { gesture = true; start(); }
      const v = fromSlider(parseFloat(input.value));
      wrap.classList.remove('mixed');
      show(o.fmt(v));
      o.onInput(v);
    });
    input.addEventListener('dblclick', () => { if (o.reset != null) { start(); set(o.reset); o.onInput(o.reset); } });
    parent.appendChild(wrap);
    return { set, input };
  }

  /** Segmented buttons. */
  function seg(parent, items, onPick) {
    parent.innerHTML = '';
    const btns = items.map((it) => {
      const b = document.createElement('button');
      b.textContent = it.label;
      if (it.title) b.title = it.title;
      b.addEventListener('click', () => onPick(it.value));
      parent.appendChild(b);
      return { b, value: it.value };
    });
    return { set: (v) => btns.forEach((x) => setOn(x.b, x.value === v)) };
  }

  /** Toggle look + state for assistive tech. */
  function setOn(el, on) {
    el.classList.toggle('on', !!on);
    el.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  /** Tap vs long-press (≥450 ms). Keyboard activation counts as a tap. */
  function pressable(btn, onTap, onLong) {
    let timer = null, longFired = false;
    btn.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      longFired = false;
      clearTimeout(timer);
      timer = setTimeout(() => { longFired = true; onLong(); }, 450);
    });
    const clear = () => clearTimeout(timer);
    btn.addEventListener('pointerup', clear);
    btn.addEventListener('pointerleave', clear);
    btn.addEventListener('pointercancel', () => { clear(); longFired = false; });
    btn.addEventListener('click', (e) => {
      clearTimeout(timer);
      if (e.detail === 0) { longFired = false; onTap(e); return; } // keyboard activation
      if (longFired) { longFired = false; return; }
      onTap(e);
    });
  }

  const ui = {
    sliders: {},
    toastTimer: null,
    slots: [null, null, null, null],
    activeSlot: null,
    shortcuts: true,          // single-key shortcuts (WCAG 2.1.4: can be turned off)
    cell: { track: 0, sector: 0 }, // keyboard cell cursor on the selected plate

    /** Visually hidden live region for state changes (play/stop, switches). */
    announce(msg) {
      const r = $('sr-live');
      if (!r) return;
      r.textContent = '';
      setTimeout(() => { r.textContent = msg; }, 30);
    },

    setPanelHidden(h) {
      document.body.classList.toggle('panel-hidden', h);
      $('panel').inert = h; // hidden panel leaves the tab order
      $('panel-toggle').setAttribute('aria-expanded', h ? 'false' : 'true');
    },

    panelWidth() {
      if (document.body.classList.contains('panel-hidden') || window.innerWidth <= 760) return 0;
      return $('panel').offsetWidth;
    },

    toast(msg) {
      const t = $('toast');
      t.textContent = msg;
      t.classList.add('show');
      clearTimeout(this.toastTimer);
      this.toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
    },

    init() {
      this.bindKeys();
      this.bindFlightKeys();
      this.buildTransport();
      this.buildFlight();
      this.buildCompose();
      this.buildLayer();
      this.buildOutput();
      this.buildMeters();
      this.bindButtons();
      this.bindSounds();
      this.bindPointer();
      sounds.onChange(() => { this.renderSounds(); this.renderPool(); });
      history.onChange((type) => {
        // any new edit means the stack no longer equals the active keep slot
        if (type === 'push' && this.activeSlot != null) { this.activeSlot = null; this.syncKeep(); }
        this.syncHistory();
      });
      try { this.shortcuts = localStorage.getItem('orbital.shortcuts') !== 'off'; } catch (e) { /* storage blocked */ }
      this.syncShortcuts();
      this.bindStageKeys();
      this.renderSounds();
      this.renderKeep();
      this.syncHistory();
      this.select(stack.selected);
      engine.onEvolve = () => this.syncLayer();
      engine.onSwitch = (sw) => this.afterSwitch(sw);
      this.setPanelHidden(window.innerWidth <= 760);
      // keep the hidden panel out of the tab order however the class changes
      new MutationObserver(() => {
        const h = document.body.classList.contains('panel-hidden');
        if ($('panel').inert !== h) this.setPanelHidden(h);
      }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    },

    /** Every generative / edit action: record undo, change state, re-sync. */
    act(label, fn, align = true) {
      history.push(label);
      engine.applyNow(fn, align);
      this.activeSlot = null;
      this.syncLayer();
      this.syncKeep();
    },

    // ------------------------------------------------------------ transport
    buildTransport() {
      const c = $('transport-sliders'), E = engine;
      this.sliders.bpm = slider(c, { key: 'bpm', label: 'TEMPO', min: 40, max: 200, step: 1, reset: 112,
        fmt: (v) => `${Math.round(v)} BPM`, onInput: (v) => { E.setBpm(v); if (this.lenSeg) this.syncExport(); } });
      this.sliders.master = slider(c, { key: 'master', label: 'MASTER', min: 0, max: 1.5, step: 0.01, reset: 0.9,
        fmt: (v) => `${Math.round(v * 100)}%`, onInput: (v) => E.setMaster(v) });
      this.sliders.space = slider(c, { key: 'space', label: 'SPACE', min: 0, max: 1, step: 0.01, reset: 0.28,
        fmt: (v) => `${Math.round(v * 100)}%`, onInput: (v) => E.setSpace(v) });
      this.sliders.sep = slider(c, { key: 'sep', label: 'SEPARATION', min: 0.3, max: 2.4, step: 0.01, reset: 1.25,
        fmt: (v) => `${Math.round(v * 100)}%`, onInput: (v) => { view.sepTarget = v; } });
      this.sliders.evolve = slider(c, { key: 'evolve', label: 'EVOLVE', min: 0, max: 1, step: 0.01, reset: 0,
        fmt: (v) => (v === 0 ? 'OFF' : `${Math.round(v * 100)}%/BAR`), onInput: (v) => { E.evolveAmount = v; } });
      this.sliders.bpm.set(E.bpm);
      this.sliders.master.set(E.masterLevel);
      this.sliders.space.set(E.spaceLevel);
      this.sliders.sep.set(view.sepTarget);
      this.sliders.evolve.set(E.evolveAmount);
    },

    // ------------------------------------------------------------ flight
    buildFlight() {
      const F = flight;
      const c = $('flight-sliders');
      this.sliders.sensorR = slider(c, { key: 'sensorr', label: 'SENSOR', min: 0.06, max: 0.8, step: 0.01, reset: 0.38,
        fmt: (v) => `${v.toFixed(2)} U`, onInput: (v) => { F.R = v; } });
      this.sliders.sensorGain = slider(c, { key: 'sensorgain', label: 'SENSOR LVL', min: 0, max: 1.5, step: 0.01, reset: 1,
        fmt: pct, onInput: (v) => { F.sensorGain = v; } });
      this.sliders.headMix = slider(c, { key: 'headmix', label: 'HEADS MIX', min: 0, max: 1, step: 0.01, reset: 0.3,
        fmt: (v) => (v === 0 ? 'SENSOR ONLY' : pct(v)), onInput: (v) => { F.headMix = v; } });
      this.sliders.falloff = slider(c, { key: 'falloff', label: 'PROXIMITY', min: 0.15, max: 3, step: 0.01, reset: 0.32,
        toSlider: (v) => Math.log(v), fromSlider: (s) => Math.round(Math.exp(s) * 100) / 100,
        fmt: (v) => (v < 0.35 ? `TIGHT ${v.toFixed(2)} U` : v > 1.5 ? `WIDE ${v.toFixed(2)} U` : `${v.toFixed(2)} U`),
        onInput: (v) => { F.falloff = v; } });
      // log scale for the slider position
      this.sliders.falloff.input.min = Math.log(0.15); this.sliders.falloff.input.max = Math.log(3); this.sliders.falloff.input.step = 0.01;
      this.sliders.thrust = slider(c, { key: 'thrust', label: 'SPEED', min: 0.25, max: 3, step: 0.05, reset: 1,
        fmt: (v) => `×${v.toFixed(2)}`, onInput: (v) => F.setThrust(v) });
      this.sliders.sensorR.set(F.R);
      this.sliders.sensorGain.set(F.sensorGain);
      this.sliders.headMix.set(F.headMix);
      this.sliders.thrust.set(F.thrust);
      this.sliders.falloff.set(F.falloff);
      $('btn-fly').addEventListener('click', () => this.toggleFlight());
      this.bindDock();
      $('btn-autopilot').addEventListener('click', () => this.toggleAutopilot());
      $('btn-flight-restart').addEventListener('click', () => {
        F.saved = null;
        if (F.on) { F.enter(true); this.syncAutopilot(); }
        this.toast('flight path restarts at the first plate');
      });
      $('btn-sensor-chance').addEventListener('click', (e) => {
        F.useChance = !F.useChance;
        e.target.textContent = F.useChance ? 'PASS: CHANCE' : 'PASS: ALL';
        setOn(e.target, F.useChance);
      });
    },

    toggleFlight() {
      const F = flight;
      if (F.on) F.exit(); else F.enter();
      setOn($('btn-fly'), F.on);
      $('btn-fly').textContent = F.on ? '✈ LAND' : '✈ FLY';
      document.body.classList.toggle('flying', F.on);
      $('hud-mode').textContent = F.on ? 'FLIGHT' : view.mode;
      $('export-flight-note').hidden = !F.on;
      if (!F.on) setHTML('flight-readout', '');
      $('fly-dock').classList.toggle('flying', F.on);
      $('dock-fly').textContent = F.on ? '✈ LAND' : '✈ FLY';
      this.syncAutopilot();
      if (F.on) $('hud-hint').classList.add('gone');
      const resumed = F.on && F.saved;
      const msg = !F.on ? 'landed — take off again to resume from here' : resumed ? 'flight resumed where you landed' : engine.playing ? 'flight — autopilot cruising · W/A/S/D to take the stick'
        : 'flight — autopilot cruises when you press play · W/A/S/D to fly now';
      this.toast(msg);
      this.announce(msg);
    },
    toggleAutopilot() {
      const F = flight;
      if (!F.on) return;
      if (F.autopilot) F.takeManual(); else F.engageAutopilot();
      this.syncAutopilot();
    },
    syncAutopilot() {
      for (const id of ['btn-autopilot', 'dock-auto']) {
        const b = $(id);
        setOn(b, flight.autopilot);
        b.textContent = !flight.autopilot ? 'MANUAL' : flight.paused() ? 'AUTOPILOT ❚❚' : 'AUTOPILOT';
      }
    },

    /** On-canvas dock: FLY/LAND always reachable (mobile panel is hidden), plus
     *  hold-to-thrust buttons so flight works with touch or mouse alone. */
    bindDock() {
      const F = flight;
      $('dock-fly').addEventListener('click', () => this.toggleFlight());
      $('dock-auto').addEventListener('click', () => this.toggleAutopilot());
      const hold = (id, key) => {
        const b = $(id);
        const on = (e) => {
          e.preventDefault();
          if (!F.on) return;
          if (F.autopilot) { F.takeManual(); this.syncAutopilot(); }
          F.keys.add(key);
          b.classList.add('on');
        };
        const off = () => { F.keys.delete(key); b.classList.remove('on'); };
        b.addEventListener('pointerdown', on);
        b.addEventListener('pointerup', off);
        b.addEventListener('pointerleave', off);
        b.addEventListener('pointercancel', off);
      };
      hold('dock-fwd', 'w');
      hold('dock-back', 's');
      hold('dock-brake', 'x');
    },

    // ------------------------------------------------------------ compose
    buildCompose() {
      const S = stack, E = engine;
      // style picker as buttons: a focused <select> would swallow every shortcut key (type-ahead)
      this.styleSeg = seg($('style-row'), S.STYLE_NAMES.map((n) => ({ label: n, value: n })),
        (v) => { S.style = v; this.styleSeg.set(v); });
      this.styleSeg.set(S.style);

      pressable($('btn-new-phrase'), (e) => (e.shiftKey ? this.queuePhrase() : this.newPhrase()), () => this.queuePhrase());
      $('btn-keep').addEventListener('click', () => this.keep());

      const c = $('compose-sliders');
      const PH = [4, 8, 16, 32];
      this.sliders.phrase = slider(c, { key: 'phrase', label: 'PHRASE', min: 0, max: 3, step: 1,
        toSlider: (v) => PH.indexOf(v), fromSlider: (i) => PH[i], fmt: (v) => `${v} BARS`,
        onInput: (v) => { S.phraseBars = v; this.syncExport(); } });
      this.sliders.breaks = slider(c, { key: 'breaks', label: 'BREAKS', min: 0, max: 1, step: 0.01, reset: 0,
        fmt: (v) => (v === 0 ? 'OFF' : pct(v)), onInput: (v) => { S.breaks = v; } });
      this.sliders.onBeatAll = slider(c, { key: 'onbeatall', label: 'BEAT·ALL', min: 0, max: 1, step: 0.01, reset: 0,
        fmt: pct, onStart: () => history.push('onbeat-all', true),
        onInput: (v) => { S.plates.forEach((p) => { p.onBeat = v; p.generate(); }); this.syncLayer(); } });
      this.sliders.fxWet = slider(c, { key: 'fxwet', label: 'THROW WET', min: 0, max: 1, step: 0.01, reset: 0.5,
        fmt: pct, onInput: (v) => E.setFxWet(v) });
      this.sliders.phrase.set(S.phraseBars);
      this.sliders.breaks.set(S.breaks);
      this.sliders.fxWet.set(E.fxWet);

      const fxRow = $('fx-row');
      $('btn-fx').addEventListener('click', (e) => {
        E.fxOn = !E.fxOn;
        setOn(e.target, E.fxOn);
        e.target.textContent = E.fxOn ? 'FX ON' : 'FX OFF';
      });
      setOn($('btn-fx'), E.fxOn);
      this.fxBtns = FX_TYPES.map((t) => {
        const b = document.createElement('button');
        b.textContent = t;
        setOn(b, true);
        b.title = { ratchet: 'repeats that subdivide the step', stutter: 'repeats that climb or fall in pitch',
          reverse: 'fragment plays backwards', throw: 'sent into the tempo-synced delay' }[t];
        b.addEventListener('click', () => {
          const on = !b.classList.contains('on');
          setOn(b, on);
          S.setFxType(t, on);
        });
        fxRow.appendChild(b);
        return b;
      });
      $('btn-undo').addEventListener('click', () => this.undo());
      $('btn-redo').addEventListener('click', () => this.redo());
    },

    newPhrase() {
      const S = stack;
      this.act(`new phrase · ${S.style}`, () => S.drawAll(S.style));
      this.toast(`new phrase · ${S.style}${S.plates.some((p) => p.hold) ? ' · held plates kept' : ''}`);
    },

    queuePhrase() {
      const S = stack, E = engine;
      if (E.pendingOf('phrase')) { E.cancel('phrase'); this.syncQueued(); this.toast('queued phrase cancelled'); return; }
      const style = S.style;
      const sw = E.queue('phrase', 'phrase', () => { history.push(`new phrase · ${style}`); S.drawAll(style); this.activeSlot = null; }, 'NEW');
      if (!sw) { this.afterSwitch(); return; }
      this.syncQueued();
      this.toast(`new phrase (${style}) at the next phrase line`);
    },

    keep(slot) {
      const i = slot != null ? slot : this.slots.indexOf(null);
      if (i < 0) { this.toast('all four slots full — release one with ×'); return; }
      this.slots[i] = stack.snapshot();
      this.activeSlot = i;
      this.renderKeep();
      this.toast(`kept → slot ${i + 1}`);
    },

    recall(i, quant) {
      const E = engine;
      const snap = this.slots[i];
      if (!snap) return;
      const pend = E.pendingOf('scene');
      if (pend && pend.slot === i && pend.quant === quant) { E.cancel('scene'); this.syncQueued(); this.toast(`slot ${i + 1} recall cancelled`); this.announce(`slot ${i + 1} recall cancelled`); return; }
      const sw = E.queue('scene', quant, () => {
        history.push(`recall ${i + 1}`);
        stack.restore(snap);
        this.activeSlot = i;
      }, `K${i + 1}`);
      if (!sw) { this.afterSwitch(); this.announce(`slot ${i + 1} recalled`); return; }
      sw.slot = i;
      this.syncQueued();
      this.toast(`slot ${i + 1} queued for the next ${quant}`);
      this.announce(`slot ${i + 1} queued for the next ${quant}`);
    },

    release(i) {
      const pend = engine.pendingOf('scene');
      if (pend && pend.slot === i) engine.cancel('scene');
      this.slots[i] = null;
      if (this.activeSlot === i) this.activeSlot = null;
      this.renderKeep();
    },

    renderKeep() {
      if (!this.slotEls) {
        const row = $('keep-row');
        this.slotX = [];
        this.slotEls = this.slots.map((s, i) => {
          const wrap = document.createElement('span');
          wrap.className = 'slot-wrap';
          const b = document.createElement('button');
          b.textContent = String(i + 1);
          // click/Enter = next bar; Shift (or long press) = next phrase; Delete releases
          pressable(b, (e) => {
            if (!this.slots[i]) this.keep(i); else this.recall(i, e.shiftKey ? 'phrase' : 'bar');
          }, () => { if (this.slots[i]) this.recall(i, 'phrase'); });
          b.addEventListener('keydown', (e) => {
            if ((e.key === 'Delete' || e.key === 'Backspace') && this.slots[i]) { e.preventDefault(); this.release(i); }
          });
          const x = document.createElement('button');
          x.className = 'x';
          x.textContent = '×';
          x.setAttribute('aria-label', `Release slot ${i + 1}`);
          x.addEventListener('click', () => { this.release(i); b.focus(); });
          wrap.appendChild(b);
          wrap.appendChild(x);
          row.appendChild(wrap);
          this.slotX.push(x);
          return b;
        });
      }
      this.syncKeep();
    },
    syncKeep() {
      const pend = engine.pendingOf('scene');
      (this.slotEls || []).forEach((b, i) => {
        const s = this.slots[i];
        const active = this.activeSlot === i, queued = !!pend && pend.slot === i;
        b.className = 'slot' + (s ? '' : ' empty') + (active ? ' active' : '');
        b.title = s ? `Slot ${i + 1}: click = next bar · shift-click or hold = next phrase · Delete releases` : 'Empty: click to keep here';
        b.setAttribute('aria-label', `Slot ${i + 1}, ${s ? 'kept' : 'empty'}${active ? ', playing' : ''}${queued ? ', queued' : ''}`);
        b.setAttribute('aria-pressed', active ? 'true' : 'false');
        if (this.slotX) this.slotX[i].hidden = !s;
      });
      this.syncQueued();
    },

    syncQueued() {
      const E = engine;
      const pend = E.pendingOf('scene');
      (this.slotEls || []).forEach((b, i) => b.classList.toggle('queued', !!pend && pend.slot === i));
      $('btn-new-phrase').classList.toggle('queued', !!E.pendingOf('phrase'));
    },

    afterSwitch(sw) {
      this.syncLayer();
      this.syncKeep();
      this.renderPool();
      if (sw && sw.label) this.announce(sw.label === 'NEW' ? 'new phrase now playing' : `slot ${sw.label.slice(1)} now playing`);
    },

    cancelQueued() {
      const E = engine;
      if (!E.pending.length) return;
      E.pending = [];
      this.syncQueued();
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
    syncHistory() {
      const H = history;
      $('btn-undo').disabled = !H.past.length;
      $('btn-redo').disabled = !H.future.length;
      $('btn-undo').textContent = `↶ UNDO${H.past.length ? ' ' + H.past.length : ''}`;
    },

    // ------------------------------------------------------------ layer
    buildLayer() {
      const S = stack;
      const P = () => S.sel;
      const E = engine;
      const restructure = () => { const p = P(); p.overrides.clear(); p.fxOverrides.clear(); p.generate(); E.retime(p, 'align'); };
      const rhythm = [
        { key: 'steps', label: 'STEPS', min: 0, max: S.STEP_CHOICES.length - 1, step: 1,
          toSlider: (v) => nearestIndex(S.STEP_CHOICES, v), fromSlider: (i) => S.STEP_CHOICES[i],
          fmt: (v) => String(v), apply: (v) => { P().steps = v; restructure(); } },
        { key: 'tracks', label: 'TRACKS', min: 1, max: 10, step: 1, fmt: (v) => String(v),
          apply: (v) => { P().tracks = v; P().overrides.clear(); P().fxOverrides.clear(); P().generate(); } },
        { key: 'cycle', label: 'CYCLE', min: 0.25, max: 32, step: 0.25,
          fmt: (v) => `${v} BEAT${v === 1 ? '' : 'S'}`, apply: (v) => { P().cycle = v; P().generate(); E.retime(P(), 'align'); } },
        { key: 'density', label: 'DENSITY', min: 0, max: 1, step: 0.01, fmt: pct, apply: (v) => { P().density = v; P().generate(); } },
        { key: 'scatter', label: 'PATTERN', min: 0, max: 1, step: 0.01, fmt: (v) => (v < 0.5 ? `EVEN ${pct(v)}` : `SCATTER ${pct(v)}`),
          apply: (v) => { P().scatter = v; P().generate(); } },
        { key: 'onBeat', label: 'ON BEAT', min: 0, max: 1, step: 0.01, fmt: pct, apply: (v) => { P().onBeat = v; P().generate(); this.syncOnBeatAll(); } },
        { key: 'chance', label: 'CHANCE', min: 0, max: 1, step: 0.01, fmt: pct, apply: (v) => { P().chance = v; } },
        { key: 'rest', label: 'REST', min: 0, max: 1, step: 0.01, fmt: pct, apply: (v) => { P().rest = v; } },
        { key: 'drift', label: 'DRIFT', min: -0.03, max: 0.03, step: 0.0005, reset: 0,
          fmt: (v) => `${signed(v * 100, 2)}%`, apply: (v) => { P().drift = v; E.retime(P(), 'continuous'); } },
        { key: 'micro', label: 'MICRO', min: 0, max: 1, step: 0.01, fmt: (v) => `${pct(v)} STEP`, apply: (v) => { P().micro = v; P().refresh(); } },
        { key: 'swing', label: 'SWING', min: 0, max: 0.5, step: 0.01, reset: 0, fmt: pct, apply: (v) => { P().swing = v; P().refresh(); } },
        { key: 'heads', label: 'HEADS', min: 1, max: 4, step: 1, fmt: (v) => String(v), apply: (v) => { P().heads = v; P().generate(); } },
        { key: 'fxDensity', label: 'FX', min: 0, max: 1, step: 0.01, fmt: pct, apply: (v) => { P().fxDensity = v; P().assignFx(); } },
        { key: 'level', label: 'LEVEL', min: 0, max: 1.2, step: 0.01, fmt: pct, apply: (v) => { P().level = v; } },
      ];
      const frag = [
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
      this.layerDefs = rhythm.concat(frag);
      const mk = (parent, d) => {
        this.sliders['L_' + d.key] = slider(parent, Object.assign({}, d, {
          onStart: () => { history.push(`L_${d.key}·${P().name}`, true); this.activeSlot = null; this.syncKeep(); },
          onInput: (v) => { d.apply(v); this.syncLayerButtons(); },
        }));
      };
      rhythm.forEach((d) => mk($('layer-sliders'), d));
      frag.forEach((d) => mk($('frag-sliders'), d));
      this.cutSeg = seg($('cut-row'), [
        { label: 'OVERLAP', value: 'overlap', title: 'fragments start anywhere' },
        { label: 'DIVIDE', value: 'divide', title: 'equal slices (see SLICES)' },
        { label: 'TRANSIENT', value: 'transient', title: 'fragments start at detected attacks' },
        { label: 'RANDOM', value: 'random', title: 'a cut mode picked per sound' },
      ], (v) => { history.push('cut'); P().cut = v; this.syncLayerButtons(); });
    },

    select(i) {
      const S = stack;
      S.selected = mod(i, S.plates.length);
      this.syncLayer();
      this.renderPool();
    },

    syncLayer() {
      const p = stack.sel;
      for (const d of this.layerDefs) this.sliders['L_' + d.key].set(p[d.key]);
      this.syncOnBeatAll();
      this.syncLayerButtons();
    },

    syncOnBeatAll() {
      const vals = stack.plates.map((p) => p.onBeat);
      const same = vals.every((v) => Math.abs(v - vals[0]) < 1e-6);
      this.sliders.onBeatAll.set(vals[0], !same);
    },

    syncLayerButtons() {
      const p = stack.sel;
      setOn($('btn-mute'), p.mute);
      setOn($('btn-solo'), p.solo);
      setOn($('btn-hold'), p.hold);
      $('btn-hold').textContent = p.hold ? '● HOLD' : '○ HOLD';
      setOn($('btn-choke'), p.choke);
      $('btn-dir').textContent = p.dir > 0 ? 'DIR ↻' : 'DIR ↺';
      const nfx = p.chips.filter((c) => c.fx).length;
      $('sel-name').textContent = `${p.name} · ${p.chips.length} CHIPS${nfx ? ` · ${nfx} FX` : ''}`;
      this.cutSeg.set(p.cut);
    },

    // ------------------------------------------------------------ output
    buildOutput() {
      const X = exporter;
      this.lenSeg = seg($('len-row'), [1, 2, 4].map((n) => ({ label: `${n} PHRASE${n > 1 ? 'S' : ''}`, value: n })),
        (v) => { X.phrases = v; this.lenSeg.set(v); this.syncExport(); });
      this.loopSeg = seg($('loop-row'), [
        { label: 'AS PLAYED', value: 'tail', title: 'exactly what PLAY plays, plus 4 s of reverb/delay tail' },
        { label: 'LOOP', value: 'loop', title: 'exact length with the tail folded onto the start (for looping; bar 1 then carries the tail)' },
      ], (v) => { X.mode = v; this.loopSeg.set(v); });
      this.lenSeg.set(X.phrases);
      this.loopSeg.set(X.mode);
      this.syncExport();
      const status = $('export-status');
      const btns = [$('btn-export-wav'), $('btn-export-stems')];
      const run = async (kind) => {
        if (X.busy) { this.toast('an export is already rendering'); this.announce('an export is already rendering'); return; }
        btns.forEach((b) => { b.disabled = true; });
        $('output-block').setAttribute('aria-busy', 'true');
        let lastPct = -1;
        const progress = (i, n, name, f) => {
          const pct = Math.floor(((i + (f || 0)) / n) * 100);
          if (pct === lastPct) return;
          lastPct = pct;
          status.textContent = kind === 'wav' ? `rendering mix… ${pct}%` : `rendering stem ${i + 1}/${n} · ${name}… ${pct}%`;
        };
        try {
          status.textContent = kind === 'wav' ? 'rendering mix…' : 'rendering stems…';
          const r = kind === 'wav' ? await X.exportWav({ onProgress: progress }) : await X.exportStems({ onProgress: progress });
          if (r) status.textContent = kind === 'wav' ? `saved ${r.name} · ${r.from}` : `saved ${r.name} · ${r.files.length} stems · ${r.from}`;
        } catch (err) {
          status.textContent = `render failed: ${err.message}`;
          console.error(err);
        } finally {
          btns.forEach((b) => { b.disabled = false; });
          $('output-block').removeAttribute('aria-busy');
        }
      };
      btns[0].addEventListener('click', () => run('wav'));
      btns[1].addEventListener('click', () => run('stems'));
    },
    syncExport() {
      const X = exporter;
      $('export-status').textContent = `${X.phrases * stack.phraseBars} bars · ${X.seconds().toFixed(1)} s · what PLAY plays, from bar 1 · 24-bit 48 kHz`;
    },

    // ------------------------------------------------------------ meters
    buildMeters() {
      const m = $('meters');
      m.innerHTML = '';
      this.meterEls = stack.plates.map((p, i) => {
        // a row: the level (click = select the plate) and its own mute toggle
        const row = document.createElement('div');
        row.className = 'meter-row';
        const mb = document.createElement('button');
        mb.className = 'mbtn';
        mb.textContent = 'M';
        mb.title = `Mute ${p.name} (shift-click: solo)`;
        mb.setAttribute('aria-label', `Mute ${p.name}`);
        setOn(mb, p.mute);
        mb.addEventListener('click', (e) => {
          const pl = stack.plates[i];
          if (e.shiftKey) { history.push('solo'); pl.solo = !pl.solo; this.toast(`${pl.name} ${pl.solo ? 'solo' : 'solo off'}`); }
          else { history.push('mute'); pl.mute = !pl.mute; }
          this.syncLayerButtons();
          this.announce(`${pl.name} ${e.shiftKey ? (pl.solo ? 'solo on' : 'solo off') : (pl.mute ? 'muted' : 'unmuted')}`);
        });
        const b = document.createElement('button');
        b.className = 'meter';
        b.innerHTML = `<span>${p.name}</span><span class="bar" aria-hidden="true"><i></i><s></s></span><span class="v" aria-hidden="true">00.0</span>`;
        b.setAttribute('aria-label', `Select ${p.name}`);
        b.addEventListener('click', () => this.select(i));
        row.append(mb, b);
        m.appendChild(row);
        return { root: b, mbtn: mb, bar: b.querySelector('i'), peak: b.querySelector('s'), v: b.querySelector('.v'), hold: 0 };
      });
    },

    // ------------------------------------------------------------ buttons
    bindButtons() {
      const E = engine, S = stack;
      $('btn-play').addEventListener('click', () => this.togglePlay());
      $('btn-mode').addEventListener('click', () => this.toggleMode());
      $('btn-orbit').addEventListener('click', () => this.toggleOrbit());
      setOn($('btn-ear'), E.earMode === 'camera');
      setOn($('btn-orbit'), view.autoOrbit);
      setOn($('btn-sensor-chance'), flight.useChance);
      setOn($('btn-autopilot'), true); setOn($('dock-auto'), true);
      $('btn-ear').addEventListener('click', (e) => {
        E.earMode = E.earMode === 'camera' ? 'fixed' : 'camera';
        e.target.textContent = `EAR: ${E.earMode.toUpperCase()}`;
        setOn(e.target, E.earMode === 'camera');
        this.toast(E.earMode === 'camera' ? 'listener rides the camera' : 'listener fixed at home view');
      });
      $('btn-pan').addEventListener('click', (e) => {
        E.panModel = E.panModel === 'HRTF' ? 'equalpower' : 'HRTF';
        e.target.textContent = `PAN: ${E.panModel === 'HRTF' ? 'HRTF' : 'EQUAL'}`;
      });
      $('btn-regen-all').addEventListener('click', () => { this.act('regen all', () => S.regenerateAll()); this.toast('regenerated plates not on hold'); });
      $('btn-hold').addEventListener('click', () => this.toggleHold());
      $('btn-mute').addEventListener('click', () => { history.push('mute'); S.sel.mute = !S.sel.mute; this.syncLayerButtons(); });
      $('btn-solo').addEventListener('click', () => { history.push('solo'); S.sel.solo = !S.sel.solo; this.syncLayerButtons(); });
      $('btn-choke').addEventListener('click', () => { history.push('choke'); S.sel.choke = !S.sel.choke; this.syncLayerButtons(); });
      $('btn-dir').addEventListener('click', () => { history.push('dir'); S.sel.dir *= -1; S.sel.refresh(); E.retime(S.sel, 'align'); this.syncLayerButtons(); });
      $('btn-regen').addEventListener('click', () => this.act(`regen ${S.sel.name}`, () => S.regenerate(S.sel)));
      $('btn-mutate').addEventListener('click', () => this.act(`draw ${S.sel.name} · ${S.style}`, () => S.draw(S.sel, S.style)));
      $('sel-prev').addEventListener('click', () => this.select(S.selected - 1));
      $('sel-next').addEventListener('click', () => this.select(S.selected + 1));
      $('panel-toggle').addEventListener('click', () => this.setPanelHidden(!document.body.classList.contains('panel-hidden')));
      $('btn-builtins').addEventListener('click', () => {
        // the button reflects the list: on if any built-in is enabled
        const on = !sounds.list.some((s) => s.builtin && s.enabled);
        sounds.setAllBuiltins(on);
      });
      $('btn-save-project').addEventListener('click', () => {
        try {
          const r = project.save();
          const msg = `saved ${r.name} · ${(r.bytes / 1024 / 1024).toFixed(1)} MB`;
          $('export-status').textContent = msg;
          this.toast(msg);
        } catch (err) { this.toast(`could not save: ${err.message}`); console.error(err); }
      });
      const pin = $('project-input');
      $('btn-open-project').addEventListener('click', () => pin.click());
      pin.addEventListener('change', async () => {
        const f = pin.files && pin.files[0];
        pin.value = '';
        if (!f) return;
        try {
          await project.open(f);
          this.toast(`opened ${f.name} — press play`);
          this.announce(`opened ${f.name}`);
        } catch (err) { this.toast(`could not open ${f.name}: ${err.message}`); console.warn(err); }
      });
      $('btn-shortcuts').addEventListener('click', () => {
        this.shortcuts = !this.shortcuts;
        try { localStorage.setItem('orbital.shortcuts', this.shortcuts ? 'on' : 'off'); } catch (e) { /* storage blocked */ }
        this.syncShortcuts();
        this.toast(this.shortcuts ? 'single-key shortcuts on' : 'single-key shortcuts off — they still work while the stack has focus');
      });
    },

    toggleHold() {
      const p = stack.sel;
      p.hold = !p.hold;
      this.syncLayerButtons();
      this.toast(`${p.name} ${p.hold ? 'on hold — kept through new phrases' : 'released'}`);
    },

    /** Refresh every control from state (after opening a project). */
    syncAll() {
      const E = engine, S = stack, V = view, F = flight, X = exporter;
      this.sliders.bpm.set(E.bpm); this.sliders.master.set(E.masterLevel); this.sliders.space.set(E.spaceLevel);
      this.sliders.sep.set(V.sepTarget); this.sliders.evolve.set(E.evolveAmount);
      this.sliders.sensorR.set(F.R); this.sliders.sensorGain.set(F.sensorGain); this.sliders.headMix.set(F.headMix);
      this.sliders.falloff.set(F.falloff); this.sliders.thrust.set(F.thrust);
      this.sliders.phrase.set(S.phraseBars); this.sliders.breaks.set(S.breaks); this.sliders.fxWet.set(E.fxWet);
      this.styleSeg.set(S.style);
      setOn($('btn-fx'), E.fxOn); $('btn-fx').textContent = E.fxOn ? 'FX ON' : 'FX OFF';
      this.fxBtns.forEach((b) => setOn(b, S.fxTypes.includes(b.textContent)));
      setOn($('btn-ear'), E.earMode === 'camera'); $('btn-ear').textContent = `EAR: ${E.earMode.toUpperCase()}`;
      $('btn-pan').textContent = `PAN: ${E.panModel === 'HRTF' ? 'HRTF' : 'EQUAL'}`;
      setOn($('btn-orbit'), V.autoOrbit);
      $('btn-mode').textContent = V.mode === 'ORBIT' ? 'SPLIT' : 'ORBIT';
      $('hud-mode').textContent = F.on ? 'FLIGHT' : V.mode;
      setOn($('btn-sensor-chance'), F.useChance); $('btn-sensor-chance').textContent = F.useChance ? 'PASS: CHANCE' : 'PASS: ALL';
      this.lenSeg.set(X.phrases); this.loopSeg.set(X.mode); this.syncExport();
      this.renderSounds(); this.renderPool(); this.renderKeep();
      this.syncLayer(); this.syncHistory(); this.syncAutopilot();
    },

    syncShortcuts() {
      const b = $('btn-shortcuts');
      setOn(b, this.shortcuts);
      b.textContent = `SINGLE-KEY SHORTCUTS: ${this.shortcuts ? 'ON' : 'OFF'}`;
    },

    async togglePlay() {
      const E = engine;
      if (E.playing) E.stop(); else await E.start();
      $('btn-play').textContent = E.playing ? '■ STOP' : '▶ PLAY';
      setOn($('btn-play'), E.playing);
      this.announce(E.playing ? 'playing from bar 1' : 'stopped');
      if (E.playing) $('hud-hint').classList.add('gone');
      this.syncAutopilot(); // autopilot pauses/resumes with playback
      this.afterSwitch();
    },

    toggleMode() {
      const V = view;
      V.mode = V.mode === 'ORBIT' ? 'SPLIT' : 'ORBIT';
      V.sepTarget = V.mode === 'SPLIT' ? 1.85 : 1.25;
      this.sliders.sep.set(V.sepTarget);
      $('btn-mode').textContent = V.mode === 'ORBIT' ? 'SPLIT' : 'ORBIT';
      $('hud-mode').textContent = flight.on ? 'FLIGHT' : V.mode;
    },

    toggleOrbit() {
      const V = view;
      V.autoOrbit = !V.autoOrbit;
      setOn($('btn-orbit'), V.autoOrbit);
    },

    // ------------------------------------------------------------ sounds
    bindSounds() {
      const input = $('file-input'), dz = $('dropzone');
      input.addEventListener('change', () => { this.addFiles(input.files); input.value = ''; });
      // a real button opens the picker; clicking anywhere on the drop area does too
      dz.addEventListener('click', () => input.click());

      let depth = 0;
      const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
      window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; document.body.classList.add('dragover'); });
      window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
      window.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) document.body.classList.remove('dragover'); });
      window.addEventListener('drop', (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        depth = 0;
        document.body.classList.remove('dragover');
        this.addFiles(e.dataTransfer.files);
      });

      // microphone
      const mic = $('btn-mic');
      let rec = null, recTimer = null, starting = false;
      mic.addEventListener('click', async () => {
        if (starting) return; // permission prompt / device still opening
        if (rec) { rec.stop(); return; }
        starting = true;
        mic.textContent = '… ALLOW MIC';
        try {
          rec = await engine.recordMic(20, (buf) => {
            clearInterval(recTimer);
            rec = null;
            mic.classList.remove('rec');
            mic.textContent = '● REC MIC';
            this.addBuffer('MIC', buf);
          });
          mic.classList.add('rec');
          recTimer = setInterval(() => { if (rec) mic.textContent = `■ STOP ${rec.elapsed().toFixed(1)}s`; }, 100);
        } catch (err) {
          rec = null;
          mic.textContent = '● REC MIC';
          this.toast(`mic unavailable: ${err.message || err.name}`);
        } finally {
          starting = false;
        }
      });

      // resample the machine itself
      const rs = $('btn-resample');
      let capturing = false;
      rs.addEventListener('click', () => {
        if (capturing) return; // one capture at a time
        if (!engine.playing) { this.toast('press play first — resample captures the output'); return; }
        capturing = true;
        rs.classList.add('rec');
        rs.textContent = '⟲ CAPTURING…';
        rs.setAttribute('aria-busy', 'true');
        engine.resample(4, (buf) => {
          capturing = false;
          rs.classList.remove('rec');
          rs.textContent = '⟲ RESAMPLE 4s';
          rs.removeAttribute('aria-busy');
          this.addBuffer('RESAMPLE', buf);
        });
      });
    },

    addBuffer(name, buf) {
      try {
        const snd = sounds.addUser(name, buf);
        this.toast(`${snd.name} added → all plates`);
      } catch (err) {
        this.toast(`could not use recording: ${err.message}`);
      }
    },

    async addFiles(files) {
      for (const f of Array.from(files || [])) {
        try {
          const snd = await sounds.addFile(f);
          this.toast(`${snd.name} (${snd.buffer.duration.toFixed(1)}s · ${snd.onsets.length} onsets) → all plates`);
        } catch (err) {
          const silent = /silent/.test((err && err.message) || '');
          this.toast(silent ? `${f.name} is silent or too short — not added` : `could not decode ${f.name}`);
          console.warn('add sound failed', f.name, err);
        }
      }
    },

    renderSounds() {
      const ul = $('sound-list');
      ul.innerHTML = '';
      const list = sounds.list;
      $('snd-count').textContent = `${list.length} · ${list.filter((s) => !s.builtin).length} YOURS`;
      const sorted = list.slice().sort((a, b) => (a.builtin === b.builtin ? b.id - a.id : a.builtin ? 1 : -1));
      const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
      for (const s of sorted) {
        const li = el('li', (s.enabled ? '' : 'off ') + (s.builtin ? 'builtin' : 'user'));
        const chk = el('button', 'chk' + (s.enabled ? ' on' : ''));
        chk.setAttribute('role', 'checkbox');
        chk.setAttribute('aria-checked', s.enabled ? 'true' : 'false');
        chk.setAttribute('aria-label', s.name);
        chk.title = 'Enable / disable';
        chk.addEventListener('click', () => sounds.setEnabled(s.id, !s.enabled));
        const nm = el('span', 'nm', s.name);
        nm.title = s.name;
        nm.appendChild(el('small', null, `${s.buffer.duration.toFixed(1)}s`));
        const cv = el('canvas');
        cv.width = 128; cv.height = 32;
        cv.setAttribute('aria-hidden', 'true');
        const acts = el('span', 'acts');
        const pv = el('button', 'pv', '▷');
        pv.title = 'Preview';
        pv.setAttribute('aria-label', `Preview ${s.name}`);
        pv.addEventListener('click', () => this.preview(s));
        acts.appendChild(pv);
        if (!s.builtin) {
          const rm = el('button', 'rm', '×');
          rm.title = 'Remove';
          rm.setAttribute('aria-label', `Remove ${s.name}`);
          rm.addEventListener('click', () => sounds.remove(s.id));
          acts.appendChild(rm);
        }
        li.append(chk, nm, cv, acts);
        drawWave(cv, s.peaks);
        ul.appendChild(li);
      }
      setOn($('btn-builtins'), list.some((s) => s.builtin && s.enabled));
    },

    preview(s) {
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

    renderPool() {
      const box = $('pool');
      if (!box) return;
      box.innerHTML = '';
      const p = stack.sel;
      for (const s of sounds.list) {
        const b = document.createElement('button');
        const inPool = p.sourceIds.has(s.id);
        b.textContent = (s.builtin ? '' : '◆ ') + s.name;
        setOn(b, inPool);
        if (!s.enabled) { b.classList.add('off'); b.setAttribute('aria-description', 'sound disabled'); }
        b.title = inPool ? 'Remove from this plate' : 'Sample this sound on this plate';
        b.addEventListener('click', () => { history.push('pool'); sounds.togglePlateSource(p, s.id); });
        box.appendChild(b);
      }
    },

    // ------------------------------------------------------------ pointer
    bindPointer() {
      const cv = $('stage'), V = view;
      let down = null;
      cv.addEventListener('pointerdown', (e) => {
        down = { x: e.clientX, y: e.clientY, lx: e.clientX, ly: e.clientY, yaw: V.dragYaw, pitch: V.dragPitch, moved: false };
        cv.setPointerCapture(e.pointerId);
      });
      cv.addEventListener('pointermove', (e) => {
        if (down) {
          const dx = e.clientX - down.x, dy = e.clientY - down.y;
          if (Math.abs(dx) + Math.abs(dy) > 4) { down.moved = true; cv.classList.add('dragging'); }
          if (flight.on) {
            flight.look((e.clientX - down.lx) * 0.004, -(e.clientY - down.ly) * 0.004);
            down.lx = e.clientX; down.ly = e.clientY;
            return;
          }
          V.dragYaw = down.yaw - dx * 0.005;
          V.dragPitch = down.pitch + dy * 0.004;
          return;
        }
        const hit = V.pick(e.clientX, e.clientY, engine.visualTime(), engine.playing);
        V.hover = hit && hit.chip ? { plate: hit.plate, chip: hit.chip } : null;
        V.hoverHit = hit;
        cv.classList.toggle('pointing', !!hit);
      });
      const up = (e) => {
        if (!down) return;
        cv.classList.remove('dragging');
        if (!down.moved) {
          const hit = V.pick(e.clientX, e.clientY, engine.visualTime(), engine.playing);
          if (hit) {
            if (e.altKey && hit.chip) {
              history.push('chip fx');
              const fx = hit.plate.cycleFx(hit.chip);
              this.toast(`${hit.plate.name} · T${hit.track} S${hit.sector} → ${fx || 'no fx'}`);
            } else if (e.shiftKey && hit.inAnnulus) {
              history.push('chip');
              const on = hit.plate.toggleCell(hit.track, hit.sector);
              this.toast(`${hit.plate.name} · chip ${on ? 'added' : 'removed'} at T${hit.track} S${hit.sector}`);
            }
            this.select(hit.plate.index);
          }
        }
        down = null;
      };
      cv.addEventListener('pointerup', up);
      cv.addEventListener('pointercancel', () => { down = null; cv.classList.remove('dragging'); });
      cv.addEventListener('pointerleave', () => { if (!down) V.hover = null; });
      cv.addEventListener('wheel', (e) => {
        e.preventDefault();
        if (flight.on) {
          flight.R = clamp(flight.R * Math.exp(-e.deltaY * 0.001), 0.06, 0.8);
          this.sliders.sensorR.set(flight.R);
          return;
        }
        V.zoom = clamp(V.zoom * Math.exp(e.deltaY * 0.001), 0.45, 2.2);
      }, { passive: false });
      cv.addEventListener('dblclick', () => { if (!flight.on) { V.dragYaw = 0; V.dragPitch = 0; V.zoom = 1; } });
    },

    bindKeys() {
      const S = stack;
      window.addEventListener('keydown', (e) => {
        if (e.defaultPrevented) return; // a control already handled this key
        const tag = e.target.tagName;
        // only text entry swallows shortcuts (a focused file input / button must not)
        const TEXT = ['text', 'search', 'email', 'number', 'password', 'url', 'tel'];
        if ((tag === 'INPUT' && TEXT.includes(e.target.type)) || tag === 'SELECT' || tag === 'TEXTAREA' || e.target.isContentEditable) return;
        const k = e.key;
        const F = flight;
        const mod = e.metaKey || e.ctrlKey || e.altKey;
        if (mod) F.keys.clear(); // macOS drops letter keyups while ⌘ is held: never leave thrust stuck
        // flight controls match physical keys (e.code) so any keyboard layout works
        const code = e.code || '';
        const letter = code.startsWith('Key') ? code.slice(3).toLowerCase() : k.toLowerCase();
        // single-key shortcuts: on globally, or (when turned off) only while the stack has focus
        const onStage = e.target === $('stage');
        const keysLive = this.shortcuts || onStage;
        if (F.on && !mod && keysLive) {
          if (code.startsWith('Shift')) { F.keys.add('shift'); return; }
          if (letter.length === 1 && 'wasdqex'.includes(letter)) {
            e.preventDefault();
            if (letter !== 'x' && F.autopilot) { F.takeManual(); this.syncAutopilot(); this.toast('manual — C re-engages autopilot'); }
            F.keys.add(letter);
            return;
          }
          if (e.repeat) return;
          if (letter === 'c') { this.toggleAutopilot(); return; }
          if (k === 'Escape') { this.toggleFlight(); return; }
        }
        if (e.repeat && k !== 'ArrowLeft' && k !== 'ArrowRight') return; // held keys don't re-toggle
        if (letter === 'f' && !mod && keysLive) { this.toggleFlight(); return; }
        if ((e.metaKey || e.ctrlKey) && (k === 'z' || k === 'Z')) {
          e.preventDefault();
          if (e.shiftKey) this.redo(); else this.undo();
          return;
        }
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        if (k === ' ') {
          // Space plays from the page or the stack; on a focused control it does what that control does
          const t = e.target;
          if (t === document.body || t === document.documentElement || onStage || t.type === 'range') {
            e.preventDefault();
            this.togglePlay();
          }
          return;
        }
        if (!keysLive) return;
        const sh = e.shiftKey;
        // physical keys (e.code), so Caps Lock and other layouts can't flip n/N, r/R, m/M
        if (letter === 'n') sh ? this.queuePhrase() : this.newPhrase();
        else if (letter === 'k') this.keep();
        else if (letter === 'h') this.toggleHold();
        else if (letter === 's') this.toggleMode();
        else if (letter === 'o') this.toggleOrbit();
        else if (letter === 'p') this.setPanelHidden(!document.body.classList.contains('panel-hidden'));
        else if (letter === 'r') { if (sh) { this.act('regen all', () => S.regenerateAll()); this.toast('regenerated plates not on hold'); } else this.act(`regen ${S.sel.name}`, () => S.regenerate(S.sel)); }
        else if (letter === 'm') { if (sh) { this.act('mutate all', () => S.mutateAll()); this.toast('new generation'); } else { history.push('mute'); S.sel.mute = !S.sel.mute; this.syncLayerButtons(); } }
        else if (k === 'ArrowLeft' && e.target === document.body) this.select(S.selected - 1);
        else if (k === 'ArrowRight' && e.target === document.body) this.select(S.selected + 1);
        else if (/^Digit[1-9]$/.test(code) && +code.slice(5) <= S.plates.length) this.select(+code.slice(5) - 1);
      });
    },

    /** The stack canvas is focusable: arrows move a cell cursor on the selected plate
     *  (PageUp/PageDown change plate), Enter toggles a chip, Shift+Enter cycles its FX,
     *  [ ] orbit, - = zoom, 0 resets the view. In flight, arrows look around. */
    bindStageKeys() {
      const cv = $('stage'), V = view, S = stack;
      const sync = (say) => {
        const p = S.sel, c = this.cell;
        c.track = clamp(c.track, 0, p.tracks - 1);
        c.sector = mod(c.sector, p.steps);
        V.cursorCell = { plate: p, track: c.track, sector: c.sector };
        const chip = p.chips.find((x) => x.key === c.track * p.steps + c.sector) || null;
        V.hover = chip ? { plate: p, chip } : null;
        if (say) this.announce(`${p.name}, track ${c.track + 1} of ${p.tracks}, step ${c.sector + 1} of ${p.steps}: ${chip ? `chip${chip.fx ? ', ' + chip.fx : ''}` : 'empty'}`);
      };
      cv.addEventListener('focus', () => sync(true));
      cv.addEventListener('blur', () => { V.cursorCell = null; V.hover = null; });
      cv.addEventListener('keydown', (e) => {
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        const F = flight, c = this.cell;
        let handled = true;
        if (F.on && e.key.startsWith('Arrow')) {
          const d = 0.06;
          if (e.key === 'ArrowLeft') F.look(-d, 0); else if (e.key === 'ArrowRight') F.look(d, 0);
          else if (e.key === 'ArrowUp') F.look(0, d); else F.look(0, -d);
        }
        else if (e.key === 'ArrowLeft') { c.sector--; sync(true); }
        else if (e.key === 'ArrowRight') { c.sector++; sync(true); }
        else if (e.key === 'ArrowUp') { c.track++; sync(true); }
        else if (e.key === 'ArrowDown') { c.track--; sync(true); }
        else if (e.key === 'PageUp') { this.select(S.selected + 1); sync(true); }
        else if (e.key === 'PageDown') { this.select(S.selected - 1); sync(true); }
        else if (e.key === 'Enter') {
          const p = S.sel;
          const chip = p.chips.find((x) => x.key === c.track * p.steps + c.sector);
          if (e.shiftKey) {
            if (chip) { history.push('chip fx'); const fx = p.cycleFx(chip); this.announce(`FX ${fx || 'none'}`); this.toast(`${p.name} · T${c.track} S${c.sector} → ${fx || 'no fx'}`); }
          } else {
            history.push('chip');
            const on = p.toggleCell(c.track, c.sector);
            this.toast(`${p.name} · chip ${on ? 'added' : 'removed'} at T${c.track} S${c.sector}`);
            this.announce(`chip ${on ? 'added' : 'removed'}`);
            this.syncLayerButtons();
          }
          sync(false);
        }
        else if (e.key === '[') V.dragYaw -= 0.08;
        else if (e.key === ']') V.dragYaw += 0.08;
        else if (e.key === '-') V.zoom = clamp(V.zoom * 1.1, 0.45, 2.2);
        else if (e.key === '=' || e.key === '+') V.zoom = clamp(V.zoom / 1.1, 0.45, 2.2);
        else if (e.key === '0') { V.dragYaw = 0; V.dragPitch = 0; V.zoom = 1; }
        else handled = false;
        if (handled) { e.preventDefault(); e.stopPropagation(); }
      });
    },

    bindFlightKeys() {
      const F = flight;
      window.addEventListener('keyup', (e) => {
        const code = e.code || '';
        if (code.startsWith('Key')) F.keys.delete(code.slice(3).toLowerCase());
        else if (code.startsWith('Shift')) F.keys.delete('shift');
        else F.keys.delete(e.key.toLowerCase());
      });
      window.addEventListener('blur', () => F.keys.clear()); // no stuck thrust
    },

    // ------------------------------------------------------------ per-frame HUD
    updateHud(tv) {
      const V = view, E = engine, S = stack;
      const B = E.songBeat(tv);
      const bar = Math.floor(B / 4), beat = Math.floor(B % 4) + 1;
      const inPh = (bar % S.phraseBars) + 1, phrase = Math.floor(bar / S.phraseBars) + 1;
      const pos = `BAR <b>${pad(inPh, 2)}.${beat}</b>/${pad(S.phraseBars, 2)} &nbsp;PHR <b>${pad(phrase, 2)}</b>`;
      setHTML('hud-stats', `SEP <b>${Math.round(V.sep * 100)}%</b> &nbsp;${pos} &nbsp;VOX <b>${pad(E.voices, 2)}</b>`);
      setHTML('pos-readout', `${pad(inPh, 2)}.${beat} / ${pad(S.phraseBars, 2)} · PHR ${pad(phrase, 2)}`);
      const p = S.sel;
      const phi = mod(p.angleAt(tv, E.playing), TAU) * 180 / Math.PI;
      const rps = E.playing ? p.omega() * (E.bpm / 60) / TAU : 0;
      let rows = [
        `<span class="k">TARGET LOCK</span> <span class="big">${p.name}</span>${p.hold ? ' · HOLD' : ''}`,
        `<span class="k">X</span> ${signed(V.plateX(p), 3)} <span class="k">θ</span> ${phi.toFixed(1)}°`,
        `<span class="k">ω</span> ${signed(rps, 3)} REV/S <span class="k">CYC</span> ${p.cycle}`,
        `<span class="k">STEPS</span> ${p.steps}×${p.tracks} <span class="k">CHIPS</span> ${p.chips.length}`,
        `<span class="k">CUT</span> ${p.cut}${p.choke ? ' · CHOKE' : ''} <span class="k">STYLE</span> ${S.style}`,
        `<span class="k">TRIG</span> ${pad(E.stats.triggers, 6)}`,
      ];
      const F = flight;
      if (F.on) {
        const n = F.near;
        const P = F.polar(F.pos, 0);
        rows = [
          `<span class="k">FLIGHT</span> <span class="big">${!F.autopilot ? 'MANUAL' : F.paused() ? 'AUTOPILOT · PAUSED' : 'AUTOPILOT'}</span>`,
          `<span class="k">SPD</span> ${F.speed().toFixed(2)} U/S <span class="k">SENSOR</span> ${F.R.toFixed(2)} U`,
          `<span class="k">X</span> ${signed(F.pos[0], 2)} <span class="k">R</span> ${P.r.toFixed(2)} <span class="k">θ</span> ${(mod(P.th, TAU) * 180 / Math.PI).toFixed(1)}°`,
          n ? `<span class="k">NEAR</span> <span class="big">${n.plate.name}</span> <span class="k">ΔX</span> ${signed(n.dx, 2)}${n.inside ? ' · IN FIELD' : ''}` : `<span class="k">NEAR</span> —`,
          n ? `<span class="k">FLAM</span> <span class="big">${signed(n.flamMs, 1)} MS</span> <span class="k">=</span> ${signed(n.steps, 2)} STEP` : '',
          n ? `<span class="k">STEP</span> ${n.stepMs.toFixed(1)} MS` : '',
          `<span class="k">SENSOR HITS</span> ${pad(F.stats.sensor, 6)}`,
        ];
        setHTML('flight-readout', n ? `${n.plate.name} · FLAM ${signed(n.flamMs, 1)} MS` : 'OPEN SPACE');
      }
      E.pending.forEach((sw) => {
        rows.push(`<span class="k">QUEUED</span> <span class="big">${sw.label}</span> @ BAR ${(Math.floor(sw.beat / 4) % S.phraseBars) + 1}`);
      });
      const h = V.hover;
      if (h) {
        const c = h.chip, pl = h.plate;
        const pool = sounds.poolFor(pl);
        const snd = pool.length ? pool[c.srcPick % pool.length] : null;
        const f = snd ? pl.fragmentFor(c, snd) : null;
        rows = rows.concat([
          '&nbsp;',
          `<span class="k">FRAGMENT</span> <span class="big">${snd ? snd.name : '—'}</span>`,
          f ? `<span class="k">@</span> ${(f.offset * 1000).toFixed(0)} MS <span class="k">LEN</span> ${(f.dur * 1000).toFixed(0)} MS <span class="k">CUT</span> ${f.mode}` : '',
          f ? `<span class="k">RATE</span> ${f.rate.toFixed(3)} <span class="k">P</span> ${Math.round(pl.probFor(c) * 100)}%` : '',
          `<span class="k">CELL</span> T${c.track} S${c.sector}${c.accent ? ' · ACCENT' : ''}${c.isBeat ? ' · BEAT' : ''}`,
          c.fx ? `<span class="k">FX</span> ${c.fx}${c.fx === 'ratchet' || c.fx === 'stutter' ? ' ×' + c.fxN : ''}` : '',
        ]);
      }
      setHTML('hud-tr', rows.filter(Boolean).join('<br>'));

      const anySolo = S.anySolo();
      this.meterEls.forEach((m, i) => {
        const pl = S.plates[i];
        const v = pl.meter;
        m.hold = Math.max(v, m.hold - 0.004);
        m.bar.style.width = `${(v * 100).toFixed(1)}%`;
        m.peak.style.left = `${(m.hold * 100).toFixed(1)}%`;
        m.v.textContent = (v * 99.9).toFixed(1).padStart(4, '0');
        m.root.classList.toggle('sel', i === S.selected);
        if (m.mute !== pl.mute || m.solo !== pl.solo) {
          m.mute = pl.mute; m.solo = pl.solo;
          setOn(m.mbtn, pl.mute);
          m.mbtn.classList.toggle('solo', pl.solo);
          m.mbtn.textContent = pl.solo ? 'S' : 'M';
        }
        const muted = !pl.audible(anySolo);
        if (m.muted !== muted) {
          m.muted = muted;
          m.root.classList.toggle('muted', muted);
          m.root.setAttribute('aria-label', `Select ${pl.name}${muted ? ', muted' : ''}`);
        }
      });

      if (!document.body.classList.contains('panel-hidden')) this.drawMap(tv);
    },

    /** Fragment map: each pool sound's waveform, cut markers, and a box per chip. */
    drawMap(tv) {
      const cv = $('map');
      if (!cv) return;
      // layout reads are cached: width refreshed only every 30 frames
      this.mapFrame = (this.mapFrame || 0) + 1;
      if (!this.mapCssW || this.mapFrame % 30 === 0) this.mapCssW = cv.clientWidth;
      if (!this.mapCssW) return;
      const p = stack.sel, E = engine;
      const pool = sounds.poolFor(p);
      const rows = Math.min(pool.length, 6);
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const rowH = 24;
      const cssH = Math.max(1, rows) * rowH + 2;
      if (cv.style.height !== `${cssH}px`) cv.style.height = `${cssH}px`;
      const W = Math.round(this.mapCssW * dpr), H = Math.round(cssH * dpr);
      if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
      const g = cv.getContext('2d');
      const rh = rowH * dpr;
      const rowOf = new Map();
      pool.slice(0, rows).forEach((s, r) => rowOf.set(s.id, r));
      // static layer (waveforms, cut markers, labels) rebuilt only when it changes
      const sig = `${p.index}|${pool.slice(0, rows).map((s) => s.id + p.cutModeFor(s)).join(',')}|${p.slices}|${W}x${H}`;
      if (this.mapSig !== sig) {
        this.mapSig = sig;
        this.mapBg = this.mapBg || document.createElement('canvas');
        this.mapBg.width = W; this.mapBg.height = H;
        this.drawMapBg(this.mapBg.getContext('2d'), p, pool, rows, W, rh, dpr);
      }
      g.clearRect(0, 0, W, H);
      g.drawImage(this.mapBg, 0, 0);
      this.drawMapChips(g, p, pool, rowOf, W, rh, dpr, tv, E);
    },

    drawMapBg(g, p, pool, rows, W, rh, dpr) {
      g.clearRect(0, 0, g.canvas.width, g.canvas.height);
      for (let r = 0; r < rows; r++) {
        const s = pool[r];
        const y0 = r * rh + 1 * dpr, mid = y0 + rh / 2;
        // waveform
        g.fillStyle = 'rgba(232,236,238,0.16)';
        const bw = W / s.peaks.length;
        s.peaks.forEach(([mn, mx], i) => {
          const a = mid - mx * rh * 0.42, b = mid - mn * rh * 0.42;
          g.fillRect(i * bw, a, Math.max(1, bw - 0.3), Math.max(1, b - a));
        });
        // cut markers
        const mode = p.cutModeFor(s);
        g.fillStyle = 'rgba(232,236,238,0.3)';
        const len = s.buffer.duration;
        if (mode === 'divide') for (let i = 1; i < p.slices; i++) g.fillRect(Math.round(i / p.slices * W), y0, 1, rh * 0.28);
        else if (mode === 'transient') for (const o of s.onsets) g.fillRect(Math.round(o / len * W), y0, 1, rh * 0.28);
        g.font = `${Math.round(7 * dpr)}px "IBM Plex Mono", ui-monospace, monospace`;
        g.fillStyle = 'rgba(232,236,238,0.5)';
        g.textBaseline = 'bottom';
        g.fillText(`${s.name} · ${mode}`, 3 * dpr, y0 + rh - 1 * dpr);
      }
    },

    drawMapChips(g, p, pool, rowOf, W, rh, dpr, tv, E) {
      for (const c of p.chips) {
        const s = pool[c.srcPick % pool.length];
        if (!s || !rowOf.has(s.id)) continue;
        const r = rowOf.get(s.id);
        const f = p.fragmentFor(c, s);
        const len = s.buffer.duration;
        const x = f.offset / len * W, w = Math.max(1.5 * dpr, f.srcDur / len * W);
        const k = E.playing && c.lastFire <= tv ? Math.exp(-(tv - c.lastFire) / 0.15) : 0;
        const hover = view.hover && view.hover.chip === c;
        const y = r * rh + rh * 0.3, hh = rh * 0.42;
        g.fillStyle = `rgba(240,244,246,${hover ? 1 : 0.18 + 0.8 * k})`;
        g.fillRect(x, y, w, hh);
        if (hover) { g.strokeStyle = 'rgba(255,255,255,1)'; g.lineWidth = dpr; g.strokeRect(x - 2 * dpr, y - 2 * dpr, w + 4 * dpr, hh + 4 * dpr); }
      }
    },
  };

  const htmlCache = new Map();
  function setHTML(id, html) {
    if (htmlCache.get(id) === html) return;
    htmlCache.set(id, html);
    $(id).innerHTML = html;
  }
  function pct(v) { return `${Math.round(v * 100)}%`; }
  function nearestIndex(arr, v) {
    let bi = 0, bd = Infinity;
    arr.forEach((x, i) => { const d = Math.abs(x - v); if (d < bd) { bd = d; bi = i; } });
    return bi;
  }
  function drawWave(cv, peaks) {
    const g = cv.getContext('2d');
    const W = cv.width, H = cv.height;
    g.clearRect(0, 0, W, H);
    g.fillStyle = 'rgba(232,236,238,0.75)';
    const bw = W / peaks.length;
    peaks.forEach(([mn, mx], i) => {
      const y0 = H / 2 - mx * H / 2, y1 = H / 2 - mn * H / 2;
      g.fillRect(i * bw, y0, Math.max(1, bw - 0.4), Math.max(1, y1 - y0));
    });
  }

  registerUi(ui);
export { ui };
