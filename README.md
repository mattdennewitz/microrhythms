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
- Exports render what the ship hears from bar 1; LOOP uses current project BPM,
  while AS PLAYED preserves this PLAY's tempo changes (see Output).

## Fragments

- **CUT**: `overlap` (start anywhere), `divide` (equal `SLICES`), `transient` (start
  on detected attacks; onsets are found when a sound is added) or `random` (a mode per
  sound). **FADE IN / OUT** shape every grain; **CHOKE** makes a plate monophonic, so
  each grain cuts the previous one.
- **MAP** shows each source the selected plate samples from, with its cut markers and
  a box for every chip's fragment, flashing as it plays. Hover a chip on the stack to
  highlight its box.

## Output

**EXPORT WAV** renders the song from bar 1 (1, 2 or 4 phrases). **LOOP** uses the
current project BPM captured when export starts, regardless of earlier playback
tempos. Its length is exactly the selected bar count at that BPM, rounded to the
nearest audio frame. The rendered reverb/delay tail folds onto the start for seamless
looping, so bar 1 already carries the previous pass's tail. Fractional BPM is preserved
in LOOP filenames.

**AS PLAYED** (default) replays this PLAY's recorded tempo changes while playing;
when stopped it uses current project BPM. It appends four seconds of reverb/delay
tail and is not an exact-length loop. Chance rolls are deterministic per beat. Both
modes preserve beat-based plate motion and the ship/listener snapshot: in flight,
exports render sensor hits, proximity mix and the listener at the ship.

**STEMS .ZIP** renders one WAV per audible plate from the same timing plan. BPM,
bar count and mode stay fixed throughout an in-flight mix or stem export; changes
to those settings apply to the next export. This does not freeze every sound or
plate/mix edit. Mixes and stems are 24-bit / 48 kHz; tempo is stored in projects and
export filenames, not a WAV tempo field.

## Projects

**⤓ SAVE .JSON** downloads the whole machine: global, view and export settings, every
plate (patterns, edits, FX, holds), the keep slots, flight settings and the ship's
position, the chance seed (so a reopened project exports the same hits) and your own
sounds, embedded as 16-bit audio. **⤒ OPEN .JSON** replaces the current machine with a
saved one (playback stops; undo history starts fresh).

**SHARE** copies a self-contained URL that restores the same project state,
including patterns and edits, keep slots, custom sounds (the same 16-bit PCM as
JSON files), flight settings, export settings and the deterministic chance seed.
Playback does not start automatically. Links and project files use the same
validated payload: `format: "orbital-stack"` and a **required integer `version: 1`**.
Existing version-1 project exports remain supported within the safety budgets below;
missing, malformed or unsupported versions are rejected before changing the machine.
Inert out-of-range cells in older files are discarded on import. Custom sound IDs
are preserved so random cut modes and exported fragments do not change on reopen.

The URL hash updates at most every 500 ms using `history.replaceState`, without
adding browser history entries. Share captures the setup at the click, including
edits not yet written to the address bar. Hashes use
`#mr2.<sha256-checksum>.<gzip-project>` with unpadded base64url components;
no backend, R2, D1 or upload is involved. The checksum is checked before
decompression. Broken, unsupported, oversized or schema-invalid links are rejected:
the invalid hash is removed, an error is shown, and the current setup and playback
are left unchanged. On initial load this leaves the untouched default setup.
Older `#mr1.` share envelopes are not accepted; version-1 JSON files still import.

The **entire URL** is limited to 16 KiB, with at most 1 MiB of decompressed JSON.
Project imports and native sound additions are limited to 64 user sounds and
8,640,000 total mono sample frames (180 seconds at 48 kHz), at most 90 seconds per
sound. Names are bounded to 128 characters without invisible control characters.
JSON project files have a 24 MiB input limit. Larger or less-compressible audio
setups need **SAVE .JSON / OPEN .JSON** rather than a link. Sounds are never silently
omitted, and messaging apps may impose shorter URL limits.

Project files and links are validated with [Zod 4](https://zod.dev/): strict object,
array, tuple, literal, enum, numeric and base64 schemas, without coercion or defaults.
Zod refinements enforce sound identities, PCM frame budgets and cell bounds; a
JSON-data preflight rejects accessors, inherited/decorated containers and prototype
keys before parsing. Unknown fields and invalid values are rejected, not silently
stripped, before state changes or native audio allocation. Imported labels are rendered only
as text, never interpreted as HTML. Production assets also carry a Content Security
Policy that blocks inline scripts, event handlers, objects and framing.

**Integrity is not authenticity.** The checksum detects corruption, but anyone can
construct another valid project and recompute it. A backend-free link cannot prove
its author or prevent valid edits. It is not encrypted: anyone with the link can
read the settings and embedded audio, which also appear in browser URL/history
surfaces during automatic synchronization. If clipboard access is unavailable or
denied, copy the address-bar URL after it updates.

## Your own sounds

- **＋ ADD SOUNDS** or drop audio files anywhere (wav/mp3/ogg/flac/m4a/aif).
  Files are mono-ised, silence-trimmed, normalised and capped at 90 s.
- **● REC MIC** records up to 20 s from the microphone.
- **⟲ RESAMPLE 4s** captures the machine's own output as a new source.
- **CLEAR ALL** removes all imported/recorded/resampled sounds and turns every
  **BUILT-IN** off in one click, without changing patterns or layer settings.
  Clearing cancels pending sound additions and stops captures; you can add new
  sounds afterward.
  Removed user sounds are not undoable; add them again to restore them.
  Built-ins stay in the library and can be re-enabled with **BUILT-INS**.

New sounds feed every plate immediately; the rhythms stay as they are and only the
fragments change. Use the **SAMPLES FROM** chips in the layer section to choose which
sounds each plate pulls from, toggle sounds globally in the list, or switch
**BUILT-INS** off to hear only your material.

## Handling

- Drag to orbit, wheel to zoom, double-click to reset the view.
- Click a plate to select it; **shift-click** a cell to add or remove a chip.
- The level meters (bottom left) each have an **M** toggle: click to mute that plate,
  shift-click to solo it. Click the level itself to select the plate.
- On touchscreens, drag with one finger to orbit (or look in flight); pinch with two
  fingers to magnify the page and pinch back out to recover. Pinching cancels camera
  dragging rather than moving the view. Rapid mute/control taps do not zoom the page.
  The meter overlay scrolls when it cannot fit, and the panel scrolls independently.
- Long-press actions cancel when you move off the button, start a second touch, or
  leave the app. Flight holds release on lift, cancellation or leaving the app;
  separate fingers can hold thrust and brake independently.
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
  least 24 px (44 px on coarse-pointer touchscreens); the page has headings and
  landmarks. Checked with axe-core (0 violations).

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
src/core/project.ts       versioned save / open the whole machine as JSON
src/core/project-format.ts strict Zod schemas for project files and share links
src/core/project-limits.ts shared sound budgets and Zod label schema
src/core/share-codec.ts   bounded gzip / base64url state links
src/app/sharing.ts       hash restoration, throttled synchronization and clipboard
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
npx playwright install chromium # once; Linux CI uses --with-deps chromium
npm run test:audio  # real Chromium offline audio and output-control downloads
npm run build      # typecheck + production build into .cloudflare/output/v0
npm run preview    # serve the last production build locally (build first)
```

The core tests cover deterministic helpers and plates, JSON snapshots,
stopped-engine undo/redo, WAV/ZIP encoding, required project versions, project
validation, bounded share-link roundtrips and canvas picking after viewport pan/scale.
The Node suite does not exercise React DOM or Web Audio. `test:audio` uses the real
development app and OfflineAudioContext in Chromium: the complete supported LOOP
length/tempo matrix for mix and stems, PCM onset timing, tempo history, in-flight
snapshots and delay, project/share restoration, rounding/tails, mute/solo/silence,
and UI downloads. It runs sequentially in isolated contexts without retries.
Measurements and UI screenshots are written under `test-results/`.

GitHub Actions runs independent `Tests` and `Audio` jobs on every push and pull
request to `main`, using Node.js 24 and `npm ci`. `Tests` runs `npm test` and the
typechecked production build; `Audio` installs Chromium with Linux dependencies
and runs `npm run test:audio`.
Merging to `main` requires a pull request with the `Tests` check passing against the
latest `main`; the requirement also applies to administrators. Branch protection
is configured in GitHub repository settings, not in the workflow file.

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
