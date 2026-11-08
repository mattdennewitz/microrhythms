/* Panel, HUD, pointer + keyboard handling. */
(function (MR) {
  'use strict';
  const { clamp, pad, signed, TAU, mod } = MR.util;
  const $ = (id) => document.getElementById(id);
  const FX_TYPES = ['ratchet', 'stutter', 'reverse', 'throw'];

  function slider(parent, o) {
    const wrap = document.createElement('div');
    wrap.className = 'slider';
    const id = 'sl-' + o.key;
    wrap.innerHTML = `<label for="${id}">${o.label}</label><input type="range" id="${id}" min="${o.min}" max="${o.max}" step="${o.step}"><output></output>`;
    const input = wrap.querySelector('input'), out = wrap.querySelector('output');
    const toSlider = o.toSlider || ((v) => v), fromSlider = o.fromSlider || ((v) => v);
    const set = (v, mixed) => {
      wrap.classList.toggle('mixed', !!mixed);
      input.value = toSlider(v);
      out.textContent = mixed ? 'MIXED' : o.fmt(v);
    };
    const start = () => { if (o.onStart) o.onStart(); };
    input.addEventListener('pointerdown', start);
    input.addEventListener('keydown', (e) => { if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End') start(); });
    input.addEventListener('input', () => {
      const v = fromSlider(parseFloat(input.value));
      wrap.classList.remove('mixed');
      out.textContent = o.fmt(v);
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
    return { set: (v) => btns.forEach((x) => x.b.classList.toggle('on', x.value === v)) };
  }

  /** Tap vs long-press (≥450 ms). Keyboard activation counts as a tap. */
  function pressable(btn, onTap, onLong) {
    let timer = null, longFired = false;
    btn.addEventListener('pointerdown', () => {
      longFired = false;
      clearTimeout(timer);
      timer = setTimeout(() => { longFired = true; onLong(); }, 450);
    });
    const clear = () => clearTimeout(timer);
    btn.addEventListener('pointerup', clear);
    btn.addEventListener('pointerleave', clear);
    btn.addEventListener('click', (e) => {
      clearTimeout(timer);
      if (longFired) { longFired = false; return; }
      onTap(e);
    });
  }

  const ui = {
    sliders: {},
    toastTimer: null,
    slots: [null, null, null, null],
    activeSlot: null,

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
      this.buildTransport();
      this.buildCompose();
      this.buildLayer();
      this.buildOutput();
      this.buildMeters();
      this.bindButtons();
      this.bindSounds();
      this.bindPointer();
      this.bindKeys();
      MR.sounds.onChange(() => { this.renderSounds(); this.renderPool(); });
      MR.history.onChange(() => this.syncHistory());
      this.renderSounds();
      this.renderKeep();
      this.syncHistory();
      this.select(MR.stack.selected);
      MR.engine.onEvolve = () => this.syncLayer();
      MR.engine.onSwitch = (sw) => this.afterSwitch(sw);
      if (window.innerWidth <= 760) document.body.classList.add('panel-hidden');
    },

    /** Every generative / edit action: record undo, change state, re-sync. */
    act(label, fn, align = true) {
      MR.history.push(label);
      MR.engine.applyNow(fn, align);
      this.activeSlot = null;
      this.syncLayer();
      this.syncKeep();
    },

    // ------------------------------------------------------------ transport
    buildTransport() {
      const c = $('transport-sliders'), E = MR.engine;
      this.sliders.bpm = slider(c, { key: 'bpm', label: 'TEMPO', min: 40, max: 200, step: 1, reset: 112,
        fmt: (v) => `${Math.round(v)} BPM`, onInput: (v) => { E.setBpm(v); if (this.lenSeg) this.syncExport(); } });
      this.sliders.master = slider(c, { key: 'master', label: 'MASTER', min: 0, max: 1.5, step: 0.01, reset: 0.9,
        fmt: (v) => `${Math.round(v * 100)}%`, onInput: (v) => E.setMaster(v) });
      this.sliders.space = slider(c, { key: 'space', label: 'SPACE', min: 0, max: 1, step: 0.01, reset: 0.28,
        fmt: (v) => `${Math.round(v * 100)}%`, onInput: (v) => E.setSpace(v) });
      this.sliders.sep = slider(c, { key: 'sep', label: 'SEPARATION', min: 0.3, max: 2.4, step: 0.01, reset: 1.25,
        fmt: (v) => `${Math.round(v * 100)}%`, onInput: (v) => { MR.view.sepTarget = v; } });
      this.sliders.evolve = slider(c, { key: 'evolve', label: 'EVOLVE', min: 0, max: 1, step: 0.01, reset: 0,
        fmt: (v) => (v === 0 ? 'OFF' : `${Math.round(v * 100)}%/BAR`), onInput: (v) => { E.evolveAmount = v; } });
      this.sliders.bpm.set(E.bpm);
      this.sliders.master.set(E.masterLevel);
      this.sliders.space.set(E.spaceLevel);
      this.sliders.sep.set(MR.view.sepTarget);
      this.sliders.evolve.set(E.evolveAmount);
    },

    // ------------------------------------------------------------ compose
    buildCompose() {
      const S = MR.stack, E = MR.engine;
      const sel = $('style-select');
      S.STYLE_NAMES.forEach((n) => {
        const o = document.createElement('option');
        o.value = n; o.textContent = n;
        sel.appendChild(o);
      });
      sel.value = S.style;
      sel.addEventListener('change', () => { S.style = sel.value; sel.blur(); });

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
        fmt: pct, onStart: () => MR.history.push('onbeat-all', true),
        onInput: (v) => { S.plates.forEach((p) => { p.onBeat = v; p.generate(); }); this.syncLayer(); } });
      this.sliders.fxWet = slider(c, { key: 'fxwet', label: 'THROW WET', min: 0, max: 1, step: 0.01, reset: 0.5,
        fmt: pct, onInput: (v) => E.setFxWet(v) });
      this.sliders.phrase.set(S.phraseBars);
      this.sliders.breaks.set(S.breaks);
      this.sliders.fxWet.set(E.fxWet);

      const fxRow = $('fx-row');
      $('btn-fx').addEventListener('click', (e) => {
        E.fxOn = !E.fxOn;
        e.target.classList.toggle('on', E.fxOn);
        e.target.textContent = E.fxOn ? 'FX ON' : 'FX OFF';
      });
      this.fxBtns = FX_TYPES.map((t) => {
        const b = document.createElement('button');
        b.textContent = t;
        b.className = 'on';
        b.title = { ratchet: 'repeats that subdivide the step', stutter: 'repeats that climb or fall in pitch',
          reverse: 'fragment plays backwards', throw: 'sent into the tempo-synced delay' }[t];
        b.addEventListener('click', () => {
          const on = !b.classList.contains('on');
          b.classList.toggle('on', on);
          S.setFxType(t, on);
        });
        fxRow.appendChild(b);
        return b;
      });
      $('btn-undo').addEventListener('click', () => this.undo());
      $('btn-redo').addEventListener('click', () => this.redo());
    },

    newPhrase() {
      const S = MR.stack;
      this.act(`new phrase · ${S.style}`, () => S.drawAll(S.style));
      this.toast(`new phrase · ${S.style}${S.plates.some((p) => p.hold) ? ' · held plates kept' : ''}`);
    },

    queuePhrase() {
      const S = MR.stack, E = MR.engine;
      if (E.pendingOf('phrase')) { E.cancel('phrase'); this.syncQueued(); this.toast('queued phrase cancelled'); return; }
      const style = S.style;
      const sw = E.queue('phrase', 'phrase', () => { MR.history.push(`new phrase · ${style}`); S.drawAll(style); this.activeSlot = null; }, 'NEW');
      if (!sw) { this.afterSwitch(); return; }
      this.syncQueued();
      this.toast(`new phrase (${style}) at the next phrase line`);
    },

    keep(slot) {
      const i = slot != null ? slot : this.slots.indexOf(null);
      if (i < 0) { this.toast('all four slots full — release one with ×'); return; }
      this.slots[i] = MR.stack.snapshot();
      this.activeSlot = i;
      this.renderKeep();
      this.toast(`kept → slot ${i + 1}`);
    },

    recall(i, quant) {
      const E = MR.engine;
      const snap = this.slots[i];
      if (!snap) return;
      const pend = E.pendingOf('scene');
      if (pend && pend.slot === i && pend.quant === quant) { E.cancel('scene'); this.syncQueued(); return; }
      const sw = E.queue('scene', quant, () => {
        MR.history.push(`recall ${i + 1}`);
        MR.stack.restore(snap);
        this.activeSlot = i;
      }, `K${i + 1}`);
      if (!sw) { this.afterSwitch(); return; }
      sw.slot = i;
      this.syncQueued();
    },

    release(i) {
      const pend = MR.engine.pendingOf('scene');
      if (pend && pend.slot === i) MR.engine.cancel('scene');
      this.slots[i] = null;
      if (this.activeSlot === i) this.activeSlot = null;
      this.renderKeep();
    },

    renderKeep() {
      if (!this.slotEls) {
        const row = $('keep-row');
        this.slotEls = this.slots.map((s, i) => {
          const b = document.createElement('button');
          b.innerHTML = `${i + 1}<span class="x" role="button" aria-label="Release slot ${i + 1}">×</span>`;
          pressable(b, (e) => {
            if (e.target.classList.contains('x')) { this.release(i); return; }
            if (!this.slots[i]) this.keep(i); else this.recall(i, 'bar');
          }, () => { if (this.slots[i]) this.recall(i, 'phrase'); });
          row.appendChild(b);
          return b;
        });
      }
      this.syncKeep();
    },
    syncKeep() {
      (this.slotEls || []).forEach((b, i) => {
        const s = this.slots[i];
        b.className = 'slot' + (s ? '' : ' empty') + (this.activeSlot === i ? ' active' : '');
        b.title = s ? `Slot ${i + 1}: tap = next bar · hold = next phrase` : 'Empty: tap to keep here';
      });
      this.syncQueued();
    },

    syncQueued() {
      const E = MR.engine;
      const pend = E.pendingOf('scene');
      (this.slotEls || []).forEach((b, i) => b.classList.toggle('queued', !!pend && pend.slot === i));
      $('btn-new-phrase').classList.toggle('queued', !!E.pendingOf('phrase'));
    },

    afterSwitch() {
      this.syncLayer();
      this.syncKeep();
      this.renderPool();
    },

    cancelQueued() {
      const E = MR.engine;
      if (!E.pending.length) return;
      E.pending = [];
      this.syncQueued();
    },
    undo() {
      this.cancelQueued();
      const l = MR.history.undo();
      if (l) { this.activeSlot = null; this.afterSwitch(); this.toast(`undo · ${l.replace(/^L_/, '')}`); }
    },
    redo() {
      this.cancelQueued();
      const l = MR.history.redo();
      if (l) { this.activeSlot = null; this.afterSwitch(); this.toast(`redo · ${l.replace(/^L_/, '')}`); }
    },
    syncHistory() {
      const H = MR.history;
      $('btn-undo').disabled = !H.past.length;
      $('btn-redo').disabled = !H.future.length;
      $('btn-undo').textContent = `↶ UNDO${H.past.length ? ' ' + H.past.length : ''}`;
    },

    // ------------------------------------------------------------ layer
    buildLayer() {
      const S = MR.stack;
      const P = () => S.sel;
      const E = MR.engine;
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
          onStart: () => { MR.history.push(`L_${d.key}·${P().name}`, true); this.activeSlot = null; this.syncKeep(); },
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
      ], (v) => { MR.history.push('cut'); P().cut = v; this.syncLayerButtons(); });
    },

    select(i) {
      const S = MR.stack;
      S.selected = mod(i, S.plates.length);
      this.syncLayer();
      this.renderPool();
    },

    syncLayer() {
      const p = MR.stack.sel;
      for (const d of this.layerDefs) this.sliders['L_' + d.key].set(p[d.key]);
      this.syncOnBeatAll();
      this.syncLayerButtons();
    },

    syncOnBeatAll() {
      const vals = MR.stack.plates.map((p) => p.onBeat);
      const same = vals.every((v) => Math.abs(v - vals[0]) < 1e-6);
      this.sliders.onBeatAll.set(vals[0], !same);
    },

    syncLayerButtons() {
      const p = MR.stack.sel;
      $('btn-mute').classList.toggle('on', p.mute);
      $('btn-solo').classList.toggle('on', p.solo);
      $('btn-hold').classList.toggle('on', p.hold);
      $('btn-hold').textContent = p.hold ? '● HOLD' : '○ HOLD';
      $('btn-choke').classList.toggle('on', p.choke);
      $('btn-dir').textContent = p.dir > 0 ? 'DIR ↻' : 'DIR ↺';
      const nfx = p.chips.filter((c) => c.fx).length;
      $('sel-name').textContent = `${p.name} · ${p.chips.length} CHIPS${nfx ? ` · ${nfx} FX` : ''}`;
      this.cutSeg.set(p.cut);
    },

    // ------------------------------------------------------------ output
    buildOutput() {
      const X = MR.exporter;
      this.lenSeg = seg($('len-row'), [1, 2, 4].map((n) => ({ label: `${n} PHRASE${n > 1 ? 'S' : ''}`, value: n })),
        (v) => { X.phrases = v; this.lenSeg.set(v); this.syncExport(); });
      this.loopSeg = seg($('loop-row'), [
        { label: 'LOOP', value: 'loop', title: 'exact length, tail folded back onto the start' },
        { label: 'WITH TAIL', value: 'tail', title: 'exact length plus 4 s of reverb/delay tail' },
      ], (v) => { X.mode = v; this.loopSeg.set(v); });
      this.lenSeg.set(X.phrases);
      this.loopSeg.set(X.mode);
      this.syncExport();
      const status = $('export-status');
      $('btn-export-wav').addEventListener('click', async () => {
        status.textContent = 'rendering mix…';
        try {
          const r = await X.exportWav();
          if (r) status.textContent = `saved ${r.name}`;
        } catch (err) { status.textContent = `render failed: ${err.message}`; console.error(err); }
      });
      $('btn-export-stems').addEventListener('click', async () => {
        try {
          const r = await X.exportStems({ onProgress: (i, n, name) => { status.textContent = `rendering stem ${i + 1}/${n} · ${name}…`; } });
          if (r) status.textContent = `saved ${r.name} · ${r.files.length} stems`;
        } catch (err) { status.textContent = `render failed: ${err.message}`; console.error(err); }
      });
    },
    syncExport() {
      const X = MR.exporter;
      $('export-status').textContent = `${X.phrases * MR.stack.phraseBars} bars · ${X.seconds().toFixed(1)} s from bar 1 · 24-bit 48 kHz`;
    },

    // ------------------------------------------------------------ meters
    buildMeters() {
      const m = $('meters');
      m.innerHTML = '';
      this.meterEls = MR.stack.plates.map((p, i) => {
        const b = document.createElement('button');
        b.className = 'meter';
        b.innerHTML = `<span>${p.name}</span><span class="bar"><i></i><s></s></span><span class="v">00.0</span>`;
        b.addEventListener('click', () => this.select(i));
        m.appendChild(b);
        return { root: b, bar: b.querySelector('i'), peak: b.querySelector('s'), v: b.querySelector('.v'), hold: 0 };
      });
    },

    // ------------------------------------------------------------ buttons
    bindButtons() {
      const E = MR.engine, S = MR.stack;
      $('btn-play').addEventListener('click', () => this.togglePlay());
      $('btn-mode').addEventListener('click', () => this.toggleMode());
      $('btn-orbit').addEventListener('click', () => this.toggleOrbit());
      $('btn-ear').addEventListener('click', (e) => {
        E.earMode = E.earMode === 'camera' ? 'fixed' : 'camera';
        e.target.textContent = `EAR: ${E.earMode.toUpperCase()}`;
        e.target.classList.toggle('on', E.earMode === 'camera');
        this.toast(E.earMode === 'camera' ? 'listener rides the camera' : 'listener fixed at home view');
      });
      $('btn-pan').addEventListener('click', (e) => {
        E.panModel = E.panModel === 'HRTF' ? 'equalpower' : 'HRTF';
        e.target.textContent = `PAN: ${E.panModel === 'HRTF' ? 'HRTF' : 'EQUAL'}`;
      });
      $('btn-regen-all').addEventListener('click', () => { this.act('regen all', () => S.regenerateAll()); this.toast('regenerated plates not on hold'); });
      $('btn-hold').addEventListener('click', () => this.toggleHold());
      $('btn-mute').addEventListener('click', () => { MR.history.push('mute'); S.sel.mute = !S.sel.mute; this.syncLayerButtons(); });
      $('btn-solo').addEventListener('click', () => { MR.history.push('solo'); S.sel.solo = !S.sel.solo; this.syncLayerButtons(); });
      $('btn-choke').addEventListener('click', () => { MR.history.push('choke'); S.sel.choke = !S.sel.choke; this.syncLayerButtons(); });
      $('btn-dir').addEventListener('click', () => { MR.history.push('dir'); S.sel.dir *= -1; S.sel.refresh(); E.retime(S.sel, 'align'); this.syncLayerButtons(); });
      $('btn-regen').addEventListener('click', () => this.act(`regen ${S.sel.name}`, () => S.regenerate(S.sel)));
      $('btn-mutate').addEventListener('click', () => this.act(`draw ${S.sel.name} · ${S.style}`, () => S.draw(S.sel, S.style)));
      $('sel-prev').addEventListener('click', () => this.select(S.selected - 1));
      $('sel-next').addEventListener('click', () => this.select(S.selected + 1));
      $('panel-toggle').addEventListener('click', () => document.body.classList.toggle('panel-hidden'));
      $('btn-builtins').addEventListener('click', (e) => {
        const on = !e.target.classList.contains('on');
        e.target.classList.toggle('on', on);
        MR.sounds.setAllBuiltins(on);
      });
    },

    toggleHold() {
      const p = MR.stack.sel;
      p.hold = !p.hold;
      this.syncLayerButtons();
      this.toast(`${p.name} ${p.hold ? 'on hold — kept through new phrases' : 'released'}`);
    },

    async togglePlay() {
      const E = MR.engine;
      if (E.playing) E.stop(); else await E.start();
      $('btn-play').textContent = E.playing ? '■ STOP' : '▶ PLAY';
      $('btn-play').classList.toggle('on', E.playing);
      if (E.playing) $('hud-hint').classList.add('gone');
      this.afterSwitch();
    },

    toggleMode() {
      const V = MR.view;
      V.mode = V.mode === 'ORBIT' ? 'SPLIT' : 'ORBIT';
      V.sepTarget = V.mode === 'SPLIT' ? 1.85 : 1.25;
      this.sliders.sep.set(V.sepTarget);
      $('btn-mode').textContent = V.mode === 'ORBIT' ? 'SPLIT' : 'ORBIT';
      $('hud-mode').textContent = V.mode;
    },

    toggleOrbit() {
      const V = MR.view;
      V.autoOrbit = !V.autoOrbit;
      $('btn-orbit').classList.toggle('on', V.autoOrbit);
    },

    // ------------------------------------------------------------ sounds
    bindSounds() {
      const input = $('file-input'), dz = $('dropzone');
      input.addEventListener('change', () => { this.addFiles(input.files); input.value = ''; });
      dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });

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
          rec = await MR.engine.recordMic(20, (buf) => {
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
      rs.addEventListener('click', () => {
        if (!MR.engine.playing) { this.toast('press play first — resample captures the output'); return; }
        rs.classList.add('rec');
        rs.textContent = '⟲ CAPTURING…';
        MR.engine.resample(4, (buf) => {
          rs.classList.remove('rec');
          rs.textContent = '⟲ RESAMPLE 4s';
          this.addBuffer('RESAMPLE', buf);
        });
      });
    },

    addBuffer(name, buf) {
      try {
        const snd = MR.sounds.addUser(name, buf);
        this.toast(`${snd.name} added → all plates`);
      } catch (err) {
        this.toast(`could not use recording: ${err.message}`);
      }
    },

    async addFiles(files) {
      for (const f of Array.from(files || [])) {
        try {
          const snd = await MR.sounds.addFile(f);
          this.toast(`${snd.name} (${snd.buffer.duration.toFixed(1)}s · ${snd.onsets.length} onsets) → all plates`);
        } catch (err) {
          this.toast(`could not decode ${f.name}`);
          console.warn('decode failed', f.name, err);
        }
      }
    },

    renderSounds() {
      const ul = $('sound-list');
      ul.innerHTML = '';
      const list = MR.sounds.list;
      $('snd-count').textContent = `${list.length} · ${list.filter((s) => !s.builtin).length} YOURS`;
      const sorted = list.slice().sort((a, b) => (a.builtin === b.builtin ? b.id - a.id : a.builtin ? 1 : -1));
      for (const s of sorted) {
        const li = document.createElement('li');
        li.className = (s.enabled ? '' : 'off ') + (s.builtin ? 'builtin' : 'user');
        li.innerHTML = `<button class="chk ${s.enabled ? 'on' : ''}" title="Enable / disable" aria-label="Enable ${s.name}"></button>
          <span class="nm" title="${s.name}">${s.name}<small>${s.buffer.duration.toFixed(1)}s</small></span>
          <canvas width="128" height="32"></canvas>
          <span class="acts"><button class="pv" title="Preview">▷</button>${s.builtin ? '' : '<button class="rm" title="Remove">×</button>'}</span>`;
        li.querySelector('.chk').addEventListener('click', () => MR.sounds.setEnabled(s.id, !s.enabled));
        li.querySelector('.pv').addEventListener('click', () => this.preview(s));
        const rm = li.querySelector('.rm');
        if (rm) rm.addEventListener('click', () => MR.sounds.remove(s.id));
        drawWave(li.querySelector('canvas'), s.peaks);
        ul.appendChild(li);
      }
    },

    preview(s) {
      const ctx = MR.engine.ensureCtx();
      ctx.resume();
      const src = ctx.createBufferSource();
      src.buffer = s.buffer;
      const g = ctx.createGain();
      g.gain.value = 0.6;
      src.connect(g).connect(MR.engine.master);
      src.start();
      src.stop(ctx.currentTime + Math.min(4, s.buffer.duration));
    },

    renderPool() {
      const box = $('pool');
      if (!box) return;
      box.innerHTML = '';
      const p = MR.stack.sel;
      for (const s of MR.sounds.list) {
        const b = document.createElement('button');
        const inPool = p.sourceIds.has(s.id);
        b.textContent = (s.builtin ? '' : '◆ ') + s.name;
        b.className = inPool ? 'on' : '';
        if (!s.enabled) b.style.opacity = 0.35;
        b.title = inPool ? 'Remove from this plate' : 'Sample this sound on this plate';
        b.addEventListener('click', () => { MR.history.push('pool'); MR.sounds.togglePlateSource(p, s.id); });
        box.appendChild(b);
      }
    },

    // ------------------------------------------------------------ pointer
    bindPointer() {
      const cv = $('stage'), V = MR.view;
      let down = null;
      cv.addEventListener('pointerdown', (e) => {
        down = { x: e.clientX, y: e.clientY, yaw: V.dragYaw, pitch: V.dragPitch, moved: false };
        cv.setPointerCapture(e.pointerId);
      });
      cv.addEventListener('pointermove', (e) => {
        if (down) {
          const dx = e.clientX - down.x, dy = e.clientY - down.y;
          if (Math.abs(dx) + Math.abs(dy) > 4) { down.moved = true; cv.classList.add('dragging'); }
          V.dragYaw = down.yaw - dx * 0.005;
          V.dragPitch = down.pitch + dy * 0.004;
          return;
        }
        const hit = V.pick(e.clientX, e.clientY, MR.engine.visualTime(), MR.engine.playing);
        V.hover = hit && hit.chip ? { plate: hit.plate, chip: hit.chip } : null;
        V.hoverHit = hit;
        cv.classList.toggle('pointing', !!hit);
      });
      const up = (e) => {
        if (!down) return;
        cv.classList.remove('dragging');
        if (!down.moved) {
          const hit = V.pick(e.clientX, e.clientY, MR.engine.visualTime(), MR.engine.playing);
          if (hit) {
            if (e.altKey && hit.chip) {
              MR.history.push('chip fx');
              const fx = hit.plate.cycleFx(hit.chip);
              this.toast(`${hit.plate.name} · T${hit.track} S${hit.sector} → ${fx || 'no fx'}`);
            } else if (e.shiftKey && hit.inAnnulus) {
              MR.history.push('chip');
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
        V.zoom = clamp(V.zoom * Math.exp(e.deltaY * 0.001), 0.45, 2.2);
      }, { passive: false });
      cv.addEventListener('dblclick', () => { V.dragYaw = 0; V.dragPitch = 0; V.zoom = 1; });
    },

    bindKeys() {
      const S = MR.stack;
      window.addEventListener('keydown', (e) => {
        const tag = e.target.tagName;
        if ((tag === 'INPUT' && e.target.type !== 'range') || tag === 'SELECT' || tag === 'TEXTAREA') return;
        const k = e.key;
        if ((e.metaKey || e.ctrlKey) && (k === 'z' || k === 'Z')) {
          e.preventDefault();
          if (e.shiftKey) this.redo(); else this.undo();
          return;
        }
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        if (k === ' ') {
          e.preventDefault();
          if (e.target.blur && e.target !== document.body) e.target.blur(); // don't also "click" a focused button
          this.togglePlay();
        }
        else if (k === 'n') this.newPhrase();
        else if (k === 'N') this.queuePhrase();
        else if (k === 'k' || k === 'K') this.keep();
        else if (k === 'h' || k === 'H') this.toggleHold();
        else if (k === 's' || k === 'S') this.toggleMode();
        else if (k === 'o' || k === 'O') this.toggleOrbit();
        else if (k === 'p' || k === 'P') document.body.classList.toggle('panel-hidden');
        else if (k === 'R') { this.act('regen all', () => S.regenerateAll()); this.toast('regenerated plates not on hold'); }
        else if (k === 'r') this.act(`regen ${S.sel.name}`, () => S.regenerate(S.sel));
        else if (k === 'M') { this.act('mutate all', () => S.mutateAll()); this.toast('new generation'); }
        else if (k === 'm') { MR.history.push('mute'); S.sel.mute = !S.sel.mute; this.syncLayerButtons(); }
        else if (k === 'ArrowLeft' && e.target.type !== 'range') this.select(S.selected - 1);
        else if (k === 'ArrowRight' && e.target.type !== 'range') this.select(S.selected + 1);
        else if (/^[1-9]$/.test(k) && +k <= S.plates.length) this.select(+k - 1);
      });
    },

    // ------------------------------------------------------------ per-frame HUD
    updateHud(tv) {
      const V = MR.view, E = MR.engine, S = MR.stack;
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
      E.pending.forEach((sw) => {
        rows.push(`<span class="k">QUEUED</span> <span class="big">${sw.label}</span> @ BAR ${(Math.floor(sw.beat / 4) % S.phraseBars) + 1}`);
      });
      const h = V.hover;
      if (h) {
        const c = h.chip, pl = h.plate;
        const pool = MR.sounds.poolFor(pl);
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
        m.root.classList.toggle('muted', !pl.audible(anySolo));
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
      const p = MR.stack.sel, E = MR.engine;
      const pool = MR.sounds.poolFor(p);
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
        const hover = MR.view.hover && MR.view.hover.chip === c;
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

  MR.ui = ui;
})(window.MR);
