/* Project save / open: the whole machine as one downloadable JSON file.
 *
 * Includes global, view, flight and export settings, every plate (and holds),
 * the keep slots, the chance seed (so a reopened project exports the same hits)
 * and your own sounds, embedded as 16-bit PCM. Sound ids are remapped on open.
 */
import { stack, type StackSnapshot, type StyleName } from './stack';
import { engine } from './engine';
import { view, type ViewMode } from './view';
import { flight, type FlightState } from './flight';
import { exporter, type ExportMode } from './exporter';
import { sounds } from './sounds';
import { history } from './history';
import { ui } from './bridge';
import type { FxType, Sound } from './types';
import { PROJECT_FORMAT, PROJECT_VERSION, validateProject } from './project-format';

export { validateProject } from './project-format';

/** A user sound embedded in a project file. */
export interface ProjectUserSound { id: number; name: string; enabled: boolean; sampleRate: number; pcm16: string }

/** The project file format, as written by `project.serialize()`. */
export interface ProjectFile {
  format: 'orbital-stack';
  version: 1;
  global: {
    bpm: number; masterLevel: number; spaceLevel: number; panModel: typeof engine.panModel; earMode: typeof engine.earMode;
    evolveAmount: number; fxOn: boolean; fxWet: number; rollSeed: number;
    fxTypes: FxType[]; phraseBars: number; breaks: number; style: StyleName; selected: number;
  };
  view: { sepTarget: number; mode: ViewMode; autoOrbit: boolean; dragYaw: number; dragPitch: number; zoom: number };
  plates: StackSnapshot;
  holds: boolean[];
  keep: { slots: Array<StackSnapshot | null>; active: number | null };
  sounds: {
    builtins: Record<string, boolean>;
    user: ProjectUserSound[];
    /** [id, name] of every builtin, so ids in plates/slots remap by name. */
    builtinIds?: Array<[number, string]>;
  };
  flight: {
    on: boolean; R: number; sensorGain: number; headMix: number; falloff: number; thrust: number; useChance: boolean;
    state: FlightState | null;
  };
  exporter: { phrases: number; mode: ExportMode };
}

// ---- base64 <-> Int16 PCM
const pcmCache = new WeakMap<AudioBuffer, string>();
function encodePcm(f32: Float32Array): string {
  const i16 = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) i16[i] = Math.max(-32768, Math.min(32767, Math.round(f32[i] * 32767)));
  const bytes = new Uint8Array(i16.buffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000) as unknown as number[]); // apply takes any array-like
  return btoa(bin);
}
function soundPcm(buffer: AudioBuffer): string {
  let pcm = pcmCache.get(buffer);
  if (pcm === undefined) {
    pcm = encodePcm(buffer.getChannelData(0));
    pcmCache.set(buffer, pcm);
  }
  return pcm;
}
function decodePcm(b64: string): Float32Array<ArrayBuffer> {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const i16 = new Int16Array(bytes.buffer, 0, bytes.length >> 1);
  const f32 = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32767;
  return f32;
}
const remapSnap = (snap: StackSnapshot, idMap: Map<number, number>): StackSnapshot => snap.map((o) => Object.assign({}, o, { sourceIds: (o.sourceIds || []).map((id) => idMap.get(id)).filter((id) => id != null) }));

export const project = {
  serialize(): ProjectFile {
    const E = engine, S = stack, V = view, F = flight, X = exporter, U = ui;
    const soundList = sounds.list;
    return {
      format: PROJECT_FORMAT,
      version: PROJECT_VERSION,
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
        builtins: Object.fromEntries(soundList.filter((s) => s.builtin).map((s) => [s.name, s.enabled])),
        builtinIds: soundList.filter((s) => s.builtin).map((s) => [s.id, s.name]),
        user: soundList.filter((s) => !s.builtin).map((s) => ({
          id: s.id, name: s.name, enabled: s.enabled, sampleRate: s.buffer.sampleRate, pcm16: soundPcm(s.buffer),
        })),
      },
      flight: {
        on: F.on, R: F.R, sensorGain: F.sensorGain, headMix: F.headMix, falloff: F.falloff, thrust: F.thrust, useChance: F.useChance,
        state: F.on ? F.flightState() : F.saved,
      },
      exporter: { phrases: X.phrases, mode: X.mode },
    };
  },

  fileName(): string {
    return `orbital-stack-${Math.round(engine.bpm)}bpm.json`;
  },

  save(): { name: string; bytes: number } {
    const json = JSON.stringify(this.serialize());
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = this.fileName();
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    return { name: this.fileName(), bytes: json.length };
  },

  async open(file: File): Promise<ProjectFile> {
    const text = await file.text();
    let obj: unknown;
    try { obj = JSON.parse(text); } catch { throw new Error('not a JSON file'); }
    this.apply(obj);
    return obj as ProjectFile; // apply has validated the complete payload.
  },

  /** Validate completely before replacing the current machine or stopping playback. */
  apply(obj: unknown) {
    validateProject(obj);
    // Native buffer creation can reject rates unsupported by a particular browser.
    // Stage it before stopping playback, removing sounds or changing any state.
    const userSounds = obj.sounds.user.map((u) => ({
      sound: u, buffer: sounds.makeBuffer(decodePcm(u.pcm16), u.sampleRate),
    }));
    const E = engine, S = stack, V = view, F = flight, X = exporter, U = ui;
    if (E.playing) U.togglePlay();
    E.pending = [];

    // sounds: drop your current sounds, add the saved ones, map old ids to new
    const idMap = new Map<number, number>();
    sounds.list.filter((s) => !s.builtin).forEach((s) => sounds.remove(s.id));
    const builtinByName = new Map<string, Sound>(sounds.list.filter((s) => s.builtin).map((s) => [s.name, s]));
    // builtin ids in the file → builtin ids now, matched by name (plates reference them)
    const savedBuiltinIds = new Map<number, string>();
    (obj.sounds.builtinIds || []).forEach(([id, name]) => savedBuiltinIds.set(id, name));
    for (const s of builtinByName.values()) idMap.set(s.id, s.id);
    for (const [id, name] of savedBuiltinIds) { const b = builtinByName.get(name); if (b) idMap.set(id, b.id); }
    for (const [name, on] of Object.entries(obj.sounds.builtins)) { const b = builtinByName.get(name); if (b) b.enabled = on; }
    for (const { sound: u, buffer } of userSounds) {
      const snd = sounds.add(u.name, buffer, false, false);
      snd.enabled = u.enabled;
      idMap.set(u.id, snd.id);
    }

    // globals
    const g = obj.global;
    E.setBpm(g.bpm);
    E.setMaster(g.masterLevel);
    E.setSpace(g.spaceLevel);
    E.panModel = g.panModel;
    E.earMode = g.earMode;
    E.evolveAmount = g.evolveAmount;
    E.fxOn = g.fxOn;
    E.setFxWet(g.fxWet);
    E.rollSeed = g.rollSeed;
    S.phraseBars = g.phraseBars;
    S.breaks = g.breaks;
    S.style = g.style;
    S.fxTypes = g.fxTypes.slice();

    // plates, holds, keep slots (sound ids remapped)
    S.restore(remapSnap(obj.plates, idMap));
    obj.holds.forEach((h, i) => { S.plates[i].hold = h; });
    S.plates.forEach((p) => p.assignFx());
    S.selected = g.selected;
    U.slots = obj.keep.slots.map((slot) => slot === null ? null : remapSnap(slot, idMap));
    U.activeSlot = obj.keep.active;

    // view
    const v = obj.view;
    V.sepTarget = v.sepTarget; V.sep = v.sepTarget; // exact, not animated: plate positions shape the mix
    V.mode = v.mode;
    V.autoOrbit = v.autoOrbit;
    V.dragYaw = v.dragYaw;
    V.dragPitch = v.dragPitch;
    V.zoom = v.zoom;

    // flight
    const f = obj.flight;
    F.R = f.R; F.sensorGain = f.sensorGain; F.headMix = f.headMix;
    F.falloff = f.falloff; F.thrust = f.thrust; F.useChance = f.useChance;
    F.saved = f.state;
    if (f.on && !F.on) U.toggleFlight();
    else if (!f.on && F.on) { U.toggleFlight(); F.saved = f.state; }
    else if (f.on && F.on) { F.enter(); U.syncAutopilot(); }

    // export
    X.phrases = obj.exporter.phrases;
    X.mode = obj.exporter.mode;

    // undo history belonged to the old machine
    history.clear();
    sounds.emit();
    U.syncAll();
  },
};
