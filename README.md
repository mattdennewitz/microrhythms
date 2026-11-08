# Orbital Stack — a micro-rhythm machine

Layers of sound in space. Seven annular plates spin on a shared axis; every white
chip on a plate is a fragment of a sound. When a chip's rotating angle crosses the
plate's fixed **read head** (the shaded wedge at ~3 o'clock), its fragment plays,
from where it sits in the stack.

Open `index.html` directly in a browser (no build, no server, no network needed —
the IBM Plex Mono webfont is optional). Press **space** or **▶ PLAY**.

## How it works

| In the picture | In the machine |
| --- | --- |
| Plate (annulus) | A rhythm layer: `steps` sectors × `tracks` rows, one revolution = `cycle` beats |
| Plate rotation | Time. Angle is a piecewise-linear function of `AudioContext.currentTime` |
| White chip | A grain: source sound, offset into it, length, pitch, gain, probability |
| Chip size along the ring | Grain length |
| Chip brightness | Gain × firing probability; flashes when it sounds |
| Shaded wedge / spokes | Read heads (static; the plate turns under them) |
| Depth along the axis | Distance from the listener (HRTF panner + darker tone further away) |

Different step counts per cycle (7, 5, 11, 16, 48, 96…) give interlocking
polymeters. **Micro** jitters each chip off the grid, **swing** delays odd steps,
**drift** detunes a plate's revolution so it phases against the others.

Timing is sample-accurate: a 25 ms worker-clocked scheduler computes each
head crossing analytically within a 120 ms lookahead and schedules a windowed
`AudioBufferSourceNode` → `PannerNode` (HRTF) → plate bus → compressor. The
drawn rotation reads the same audio clock, so picture and sound stay locked.

## Composing

Inspired by the phrase tooling in [phrz](https://nokbeats.com/tools/phrz), adapted to the stack.

- **Phrase clock.** Song position runs in bars from PLAY (`PHRASE` = 4/8/16/32 bars).
  Every plate's phase is quantised to the beat grid and anchored to bar 1, so a plate
  whose cycle divides the phrase re-aligns at every phrase line (others, like a
  1.75-beat cycle, keep phasing across phrases by design). The ring outside the big plate's frame shows the bars,
  the playhead, and any queued switch.
- **NEW PHRASE** (`N`) draws new material for every plate not on hold, in the chosen
  **style**: `normal`, `sparse`, `groove`, `glitch`, `drift`, `raw`, or `keep`
  (reseed only, params untouched). Shift-click / long-press / `⇧N` queues it for the
  next phrase line; do it again to cancel.
- **HOLD** (`H`) keeps a plate through new phrases, REGEN ALL, mutate and EVOLVE.
- **KEEP** (`K`) stores the whole stack in slots 1–4. Tap a slot to switch on the next
  bar, long-press for the next phrase, `×` to release. Switches are applied by the
  scheduler at the exact beat, so they land sample-accurately on the bar line.
- **Undo / redo** (`⌘Z` / `⇧⌘Z`): 50 steps, covering every generative action, chip
  edit, slider gesture and recall.
- **BREAKS** (global) × **REST** (per plate): seeded per phrase, plates drop out for
  whole bars, more often toward the end of the phrase, so it reads like fills.
  Resting plates dim and their head goes dark.
- **ON BEAT** pulls a plate's chips onto beats and calms their micro-timing
  (`BEAT·ALL` sets every plate).
- **Chip FX** are a sequence, not inserts: each chip may carry **ratchet** (2–4
  sub-step repeats), **stutter** (repeats that climb or fall in pitch), **reverse**
  or **throw** (into a tempo-synced delay). `FX` sets density per plate, the type
  toggles choose what's drawn, and alt-click a chip to cycle its FX. Ratchets show as
  split bars, reverse as hollow outlines, throws with an echo dot.

## Flight

Press **F** (or **✈ FLY**) to pilot a ship through the plates as if they were asteroid
fields. The ship is a **moving read head**:

- For each plate within the **SENSOR** radius, your position in that plate's plane
  gives a radius and an angle. Chips sound as they rotate past that angle, if their
  track is within the sensor in 3D. They're louder the closer they pass and are
  spatialised around you (the listener is the ship).
- **Micro-micro rhythms come from where you are.** Every chip already sounds at the
  plate's fixed head; parked at an angle Δθ from it, you hear the same chip again
  Δθ/ω later. Fly toward the head and the flam tightens to a few milliseconds; pull
  away and it opens into its own counter-rhythm. The HUD shows the live **FLAM** in ms
  and in steps. Radius chooses which tracks you hear, depth chooses which plates, and
  the sensor size (mouse wheel) chooses how many.
- **Autopilot** (default, `C`) cruises a closed-form path that threads the annuli up
  and down the stack. **W/S** thrust, **A/D** strafe, **Q/E** down/up, **⇧** boost,
  **X** brake, drag to look; any thrust key takes the stick. **Esc** lands. Flight keys
  match physical keys, so they work on any keyboard layout. The on-canvas dock (FLY/LAND,
  AUTOPILOT, hold-to-THRUST, reverse, BRAKE) makes flight work with a mouse or touch alone.
- **Proximity is the mix.** While flying, every grain from a plate's fixed head is
  scaled by 1 / (1 + (d / PROXIMITY)²), where d is the distance from the ship to where
  the grain sounds. Each plate's tone also darkens with its distance along the axis.
  Parked beside a plate you hear that plate; neighbours sit ~25 dB down and far
  plates vanish. Turn **PROXIMITY** up (WIDE) to hear more of the field at once.
- **HEADS MIX** sets the plates' fixed heads underneath (0 = sensor only).
  **PASS: ALL** makes every chip you pass sound; **PASS: CHANCE** rolls each plate's
  CHANCE instead. A side-view minimap (axis × radius) shows the fields and your sensor.
- Sensor hits are live only: exports render the plates' fixed heads.

## Fragments

- **CUT**: `overlap` (start anywhere), `divide` (equal `SLICES`), `transient` (start
  on detected attacks; onsets are found when a sound is added) or `random` (a mode per
  sound). **FADE IN / OUT** shape every grain; **CHOKE** makes a plate monophonic, so
  each grain cuts the previous one.
- **MAP** shows each source the selected plate samples from, with its cut markers and
  a box for every chip's fragment, flashing as it plays. Hover a chip on the stack to
  highlight its box.

## Output

**EXPORT WAV** renders the mix offline from bar 1 (1, 2 or 4 phrases), either as an
exact **LOOP** (the tail is folded onto the start) or **WITH TAIL**. **STEMS .ZIP**
renders one WAV per audible plate. The files are 24-bit / 48 kHz, and chance is seeded
so the same stack renders the same.

## Your own sounds

- **＋ ADD SOUNDS** or drop audio files anywhere (wav/mp3/ogg/flac/m4a/aif).
  Files are mono-ised, silence-trimmed, normalised and capped at 90 s.
- **● REC MIC** records up to 20 s from the microphone.
- **⟲ RESAMPLE 4s** captures the machine's own output as a new source.

New sounds feed every plate immediately; the rhythms stay as they are and only the
fragments change. Use the **SAMPLES FROM** chips in the layer section to choose which
sounds each plate pulls from, toggle sounds globally in the list, or switch
**BUILT-INS** off to hear only your material.

## Handling

- Drag to orbit, wheel to zoom, double-click to reset the view.
- Click a plate to select it; **shift-click** a cell to add or remove a chip.
- Hover a chip to see which fragment it holds (sound, offset, length, rate).
- **ORBIT / SPLIT** (`S`) changes separation; **AUTO-ORBIT** (`O`) drifts the camera.
- **EAR: CAMERA** makes the listener ride the camera, so orbiting moves the sound
  field; **EAR: FIXED** keeps it at the home view.
- **EVOLVE** applies a small generative change each bar; **REGENERATE** re-rolls
  patterns and fragments; **MUTATE** re-rolls structure (steps, cycles, direction).
- Keys: `space` play · `N`/`⇧N` new phrase now/at phrase end · `K` keep ·
  `⌘Z`/`⇧⌘Z` undo/redo · `H` hold · `S` split · `O` orbit · `r`/`R` regen layer/all ·
  `m`/`M` mute/mutate all · `1–7` or arrows select · `P` panel.
- Shift-click a cell to add/remove a chip; alt-click a chip to cycle its FX.

## Files

```
index.html        layout
css/style.css     HUD + panel styling
js/util.js        PRNG, euclidean rhythm, scale quantiser
js/stack.js       plates, chips, styles, breaks, FX, cut modes, snapshots
js/sounds.js      synthesized built-ins, sample library, decoding, onsets
js/engine.js      beat clock, scheduler + queued switches, grains/FX, spatial graph, offline render
js/history.js     undo / redo snapshots
js/export.js      WAV encoder, ZIP writer, loop folding, export actions
js/render.js      perspective camera + Canvas2D line-art, picking
js/ui.js          panel, HUD readouts, meters, pointer/keyboard
js/main.js        boot + frame loop (exposes window.MR_DEBUG)
```
