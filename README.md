# Orbital Stack — a micro-rhythm machine

Layers of sound in space. Seven annular plates spin on a shared axis; every white
chip on a plate is a fragment of a sound. When a chip's rotating angle crosses the
plate's fixed **read head** (the shaded wedge at ~3 o'clock), its fragment plays,
from where it sits in the stack.

Live at <https://microrhythms.dennewitz.computer>, or run it locally with
`npm install && npm run dev` (see [Developing](#developing)). It needs no network
once loaded — the IBM Plex Mono webfont is optional. Press **space** or **▶ PLAY**.

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
- The autopilot cruises only while the music plays: stop and the ship holds its
  place (❚❚), press play and it carries on from there.
- Landing remembers where you were: take off again and the flight resumes from the same
  position, heading and mode (and autopilot phase). **↺ RESTART PATH** starts over at the
  first plate.
- Exports render what the ship hears from bar 1, exactly as PLAY plays it (see Output).

## Fragments

- **CUT**: `overlap` (start anywhere), `divide` (equal `SLICES`), `transient` (start
  on detected attacks; onsets are found when a sound is added) or `random` (a mode per
  sound). **FADE IN / OUT** shape every grain; **CHOKE** makes a plate monophonic, so
  each grain cuts the previous one.
- **MAP** shows each source the selected plate samples from, with its cut markers and
  a box for every chip's fragment, flashing as it plays. Hover a chip on the stack to
  highlight its box.

## Output

**EXPORT WAV** renders **what PLAY plays**: the song from bar 1 (1, 2 or 4 phrases).
Every PLAY starts the song at bar 1, so when stopped the export is exactly what your
next PLAY will produce; while playing it's this PLAY from bar 1. Chance rolls are
deterministic per beat, so the export has the same hits you hear. In flight it renders
the ship's sensor hits, the proximity mix and the listener at the ship: parked or flying
by hand, from where you are; on autopilot, with the paused path carrying on exactly as
it does after PLAY. **AS PLAYED** (default) keeps the reverb/delay tail at the end;
**LOOP** folds it onto the start for seamless looping (so bar 1 then carries the tail).
**STEMS .ZIP** renders one WAV per audible plate from the same plan. The files are
24-bit / 48 kHz.

## Projects

**⤓ SAVE .JSON** downloads the whole machine: global, view and export settings, every
plate (patterns, edits, FX, holds), the keep slots, flight settings and the ship's
position, the chance seed (so a reopened project exports the same hits) and your own
sounds, embedded as 16-bit audio. **⤒ OPEN .JSON** replaces the current machine with a
saved one (playback stops; undo history starts fresh).

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
- The level meters (bottom left) each have an **M** toggle: click to mute that plate,
  shift-click to solo it. Click the level itself to select the plate.
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

## Keyboard & accessibility

- Everything works from the keyboard. **Tab** to the stack canvas, then **arrows** move a
  cell cursor on the selected plate (**PgUp/PgDn** change plate), **Enter** adds/removes a
  chip, **⇧Enter** cycles its FX, **[ ]** orbit, **− =** zoom, **0** resets the view; in
  flight the arrows look around. Keep slots: **Enter** = next bar, **⇧Enter** = next
  phrase, **Delete** releases.
- **Space** plays from the page or the stack; on a focused control it activates that control.
- Single-letter shortcuts follow physical keys (Caps Lock and other layouts are safe) and
  can be switched off under HANDLING; they then work only while the stack has focus.
- Toggles expose their pressed state, sliders announce the value shown (not the raw
  position), and play/stop, queued and fired switches and export progress are announced.
- The hidden panel leaves the tab order; dim text meets 4.5:1 contrast; targets are at
  least 24 px; the page has headings and landmarks. Checked with axe-core (0 violations).

## Files

TypeScript, built with Vite. The machine (`src/core`) is plain TypeScript with no UI
dependency; the panel, HUD and input handling (`src/ui`) are React.

```
index.html                Vite entry
src/main.tsx              boot: build the machine, mount React (exposes window.MR_DEBUG)
src/styles.css            HUD + panel styling
src/core/util.ts          PRNG, euclidean rhythm, scale quantiser
src/core/types.ts         shared shapes: Sound, Chip, FX, motion, pose
src/core/stack.ts         plates, chips, styles, breaks, FX, cut modes, snapshots
src/core/sounds.ts        synthesized built-ins, sample library, decoding, onsets
src/core/engine.ts        beat clock, scheduler + queued switches, grains/FX, spatial graph, offline render
src/core/history.ts       undo / redo snapshots
src/core/exporter.ts      WAV encoder, ZIP writer, loop folding, export actions
src/core/project.ts       save / open the whole machine as JSON
src/core/flight.ts        flight mode: ship, autopilot path, sensor read head
src/core/view.ts          perspective camera + Canvas2D line-art, picking
src/core/bridge.ts        the few things the core asks of the UI (panel width, keep slots, sync)
src/app/controller.ts     every UI action and the UI's own state (keep slots, toasts, shortcuts)
src/app/store.ts          change notifications for React + per-frame callbacks
src/app/loop.ts           the frame loop: events → flashes, camera, listener, draw, HUD
src/ui/App.tsx            page layout, flight dock, toast, live region, file drop
src/ui/Panel.tsx          the side panel: transport, flight, compose, layer, output, handling
src/ui/Sounds.tsx         sound list, sample pool, fragment map
src/ui/Hud.tsx            HUD readouts and meters (written per frame, outside React renders)
src/ui/Stage.tsx          stack canvas: orbit, zoom, picking, keyboard cell cursor
src/ui/keys.ts            window shortcuts and flight keys
src/ui/controls.tsx       slider, segmented row, toggle, tap / long-press
```

The core keeps its state in mutable singletons. UI actions change that state and call
`notify()`; components re-read what they show. Anything that changes every frame
(HUD text, meters, the fragment map) is drawn from the frame loop through refs, so
React never re-renders at 60 fps. In development builds every core module is also on
`window.MR` for poking at from the console.

React effects own their canvas animation loop, resize/input listeners and frame
subscriptions, and release them on unmount. Pending long-press timers, held flight
keys and panel references are cleared too. Remounting (including StrictMode effect
replay) rebinds the current canvas and refreshes HUD text; core singleton state
persists across UI remounts.

## Developing

Use **Node.js 22.18 or later** and npm; **Node.js 24 LTS** is recommended.
Cloudflare loads `cloudflare.config.ts` using Node's TypeScript support; Bun is
not a supported runtime for the `cf` CLI.
The committed lockfile pins the CLI, Vite and the Cloudflare plugin v2 beta.

```
npm ci
npm run dev        # dev server (Vite + the Cloudflare Workers runtime)
npm run typecheck  # tsc, including Vite and Cloudflare configuration
npm test           # dependency-free core regression tests using Node's TS support
npm run build      # typecheck + production build into .cloudflare/output/v0
npm run preview    # serve the last production build locally (build first)
```

The core tests cover deterministic helpers and plates, JSON snapshots,
stopped-engine undo/redo, and WAV/ZIP encoding. They do not exercise React DOM,
browser audio playback or offline audio rendering; check those in a browser.

The production HTML and hashed JS/CSS live in
`.cloudflare/output/v0/workers/default/assets/`, alongside Cloudflare deployment
metadata. `preview` uses this Build Output in the local Workers runtime; it does
not rebuild or publish a remote preview. Rebuild after changing source files.
For Vite server flags, invoke Vite directly, for example
`npx --no-install vite --host 127.0.0.1 --port 5173`; `cf dev` only forwards `--mode`.

Because the code is ES modules, the page has to be served — opening `index.html`
from disk (`file://`) no longer works.

## Deploying

The production build is static files served by a Cloudflare Worker (static assets
only, no Worker script) on the custom domain `microrhythms.dennewitz.computer`.
`cloudflare.config.ts` holds the Worker name, account and domain; the Cloudflare
Vite plugin (v2) reads it, and Cloudflare's `cf` CLI builds and deploys:

```
npm run deploy -- --dry-run  # typecheck, build and validate; no upload or credentials
npm run deploy              # typecheck, build and deploy to production
```

`cf deploy` builds through Vite rather than invoking the npm `build` script, so
both `build` and `deploy` explicitly run the TypeScript check first. A dry run
does not verify account permissions, domain ownership or remote availability.
To validate an existing production build without rebuilding, use
`npx --no-install cf deploy --prebuilt --mode production --dry-run`.

For an actual deployment, sign in with `npx --no-install cf auth login`, then
inspect `npx --no-install cf auth whoami`, or supply `CLOUDFLARE_API_TOKEN` in CI
with access to the configured account and zone. `cf` has its own credentials and
does not reuse a Wrangler login. Keep credentials out of source control; an
environment `CLOUDFLARE_ACCOUNT_ID` overrides the account in configuration.

See Cloudflare's [CLI requirements and authentication](https://developers.cloudflare.com/cf/get-started/),
[build and deployment commands](https://developers.cloudflare.com/cf/projects/),
and [Vite plugin v2 beta behavior](https://developers.cloudflare.com/workers/vite-plugin/v2-beta/).
