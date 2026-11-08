/* Project save / open: the whole machine as one downloadable JSON file.
 *
 * Includes global, view, flight and export settings, every plate (and holds),
 * the keep slots, the chance seed (so a reopened project exports the same hits)
 * and your own sounds, embedded as 16-bit PCM. Sound ids are remapped on open.
 */
(function (MR) {
  'use strict';
  const FORMAT = 'orbital-stack';
  const VERSION = 1;

  // ---- base64 <-> Int16 PCM
  function encodePcm(f32) {
    const i16 = new Int16Array(f32.length);
    for (let i = 0; i < f32.length; i++) i16[i] = Math.max(-32768, Math.min(32767, Math.round(f32[i] * 32767)));
    const bytes = new Uint8Array(i16.buffer);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  function decodePcm(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const i16 = new Int16Array(bytes.buffer, 0, bytes.length >> 1);
    const f32 = new Float32Array(i16.length);
    for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32767;
    return f32;
  }
  const remapSnap = (snap, idMap) => snap.map((o) => Object.assign({}, o, { sourceIds: (o.sourceIds || []).map((id) => idMap.get(id)).filter((id) => id != null) }));

  const project = {
    serialize() {
      const E = MR.engine, S = MR.stack, V = MR.view, F = MR.flight, X = MR.exporter, U = MR.ui;
      const sounds = MR.sounds.list;
      return {
        format: FORMAT,
        version: VERSION,
        global: {
          bpm: E.bpm, masterLevel: E.masterLevel, spaceLevel: E.spaceLevel, panModel: E.panModel, earMode: E.earMode,
          evolveAmount: E.evolveAmount, fxOn: E.fxOn, fxWet: E.fxWet, rollSeed: E.rollSeed,
          fxTypes: S.fxTypes.slice(), phraseBars: S.phraseBars, breaks: S.breaks, style: S.style, selected: S.selected,
        },
        view: { sepTarget: V.sepTarget, mode: V.mode, autoOrbit: V.autoOrbit, dragYaw: V.dragYaw, dragPitch: V.dragPitch, zoom: V.zoom },
        plates: S.snapshot(),
        holds: S.plates.map((p) => p.hold),
        keep: { slots: U.slots.map((s) => (s ? JSON.parse(JSON.stringify(s)) : null)), active: U.activeSlot },
        sounds: {
          builtins: Object.fromEntries(sounds.filter((s) => s.builtin).map((s) => [s.name, s.enabled])),
          user: sounds.filter((s) => !s.builtin).map((s) => ({
            id: s.id, name: s.name, enabled: s.enabled, sampleRate: s.buffer.sampleRate, pcm16: encodePcm(s.buffer.getChannelData(0)),
          })),
        },
        flight: {
          on: F.on, R: F.R, sensorGain: F.sensorGain, headMix: F.headMix, falloff: F.falloff, thrust: F.thrust, useChance: F.useChance,
          state: F.on ? F.flightState() : F.saved,
        },
        exporter: { phrases: X.phrases, mode: X.mode },
      };
    },

    fileName() {
      return `orbital-stack-${Math.round(MR.engine.bpm)}bpm.json`;
    },

    save() {
      const json = JSON.stringify(this.serialize());
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = this.fileName();
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      return { name: this.fileName(), bytes: json.length };
    },

    async open(file) {
      const text = await file.text();
      let obj;
      try { obj = JSON.parse(text); } catch (e) { throw new Error('not a JSON file'); }
      this.apply(obj);
      return obj;
    },

    /** Replace the current machine with a saved one. Playback stops first. */
    apply(obj) {
      if (!obj || obj.format !== FORMAT) throw new Error('not an Orbital Stack project');
      if (obj.version > VERSION) throw new Error(`project is from a newer version (${obj.version})`);
      const E = MR.engine, S = MR.stack, V = MR.view, F = MR.flight, X = MR.exporter, U = MR.ui;
      if (E.playing) U.togglePlay();
      E.pending = [];

      // sounds: drop your current sounds, add the saved ones, map old ids to new
      const idMap = new Map();
      MR.sounds.list.filter((s) => !s.builtin).forEach((s) => MR.sounds.remove(s.id));
      const builtinByName = new Map(MR.sounds.list.filter((s) => s.builtin).map((s) => [s.name, s]));
      // builtin ids in the file → builtin ids now, matched by name (plates reference them)
      const savedBuiltinIds = new Map();
      (obj.sounds && obj.sounds.builtinIds ? obj.sounds.builtinIds : []).forEach(([id, name]) => savedBuiltinIds.set(id, name));
      for (const s of builtinByName.values()) idMap.set(s.id, s.id);
      for (const [id, name] of savedBuiltinIds) { const b = builtinByName.get(name); if (b) idMap.set(id, b.id); }
      for (const [name, on] of Object.entries((obj.sounds && obj.sounds.builtins) || {})) { const b = builtinByName.get(name); if (b) b.enabled = !!on; }
      for (const u of (obj.sounds && obj.sounds.user) || []) {
        const buf = MR.sounds.makeBuffer(decodePcm(u.pcm16), u.sampleRate);
        const snd = MR.sounds.add(u.name, buf, false, false);
        snd.enabled = u.enabled !== false;
        idMap.set(u.id, snd.id);
      }

      // globals
      const g = obj.global || {};
      if (g.bpm) E.setBpm(g.bpm);
      if (g.masterLevel != null) E.setMaster(g.masterLevel);
      if (g.spaceLevel != null) E.setSpace(g.spaceLevel);
      if (g.panModel) E.panModel = g.panModel;
      if (g.earMode) E.earMode = g.earMode;
      if (g.evolveAmount != null) E.evolveAmount = g.evolveAmount;
      if (g.fxOn != null) E.fxOn = g.fxOn;
      if (g.fxWet != null) E.setFxWet(g.fxWet);
      if (g.rollSeed != null) E.rollSeed = g.rollSeed >>> 0;
      if (g.phraseBars) S.phraseBars = g.phraseBars;
      if (g.breaks != null) S.breaks = g.breaks;
      if (g.style) S.style = g.style;
      if (Array.isArray(g.fxTypes)) S.fxTypes = ['ratchet', 'stutter', 'reverse', 'throw'].filter((t) => g.fxTypes.includes(t));

      // plates, holds, keep slots (sound ids remapped)
      if (Array.isArray(obj.plates)) S.restore(remapSnap(obj.plates, idMap));
      (obj.holds || []).forEach((h, i) => { if (S.plates[i]) S.plates[i].hold = !!h; });
      S.plates.forEach((p) => p.assignFx());
      if (g.selected != null) S.selected = Math.max(0, Math.min(S.plates.length - 1, g.selected));
      const k = obj.keep || {};
      U.slots = [0, 1, 2, 3].map((i) => (k.slots && k.slots[i] ? remapSnap(k.slots[i], idMap) : null));
      U.activeSlot = k.active != null ? k.active : null;

      // view
      const v = obj.view || {};
      if (v.sepTarget != null) { V.sepTarget = v.sepTarget; V.sep = v.sepTarget; } // exact, not animated: plate positions shape the mix
      if (v.mode) V.mode = v.mode;
      if (v.autoOrbit != null) V.autoOrbit = v.autoOrbit;
      if (v.dragYaw != null) V.dragYaw = v.dragYaw;
      if (v.dragPitch != null) V.dragPitch = v.dragPitch;
      if (v.zoom != null) V.zoom = v.zoom;

      // flight
      const f = obj.flight || {};
      for (const key of ['R', 'sensorGain', 'headMix', 'falloff', 'thrust', 'useChance']) if (f[key] != null) F[key] = f[key];
      F.saved = f.state || null;
      if (f.on && !F.on) U.toggleFlight();
      else if (!f.on && F.on) { U.toggleFlight(); F.saved = f.state || null; }
      else if (f.on && F.on) { F.enter(); U.syncAutopilot(); }

      // export
      const x = obj.exporter || {};
      if (x.phrases) X.phrases = x.phrases;
      if (x.mode) X.mode = x.mode;

      // undo history belonged to the old machine
      MR.history.past = []; MR.history.future = [];
      MR.sounds.emit();
      U.syncAll();
    },
  };

  // builtin ids are stable per load order, but store name pairs so old files keep working
  const baseSerialize = project.serialize;
  project.serialize = function () {
    const o = baseSerialize.call(this);
    o.sounds.builtinIds = MR.sounds.list.filter((s) => s.builtin).map((s) => [s.id, s.name]);
    return o;
  };

  MR.project = project;
})(window.MR);
