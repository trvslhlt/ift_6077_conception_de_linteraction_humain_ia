# Edit bench proof of concept

Runs the checks in `../../project_plan/OPENDAW.md` ("Checks") against openDAW: how much programmatic editing
playback can take, how far ahead of the playhead an edit must land, whether automation written during playback is
heard, what happens to undo when an agent edits during a knob drag, a "held" signal for knobs and faders, and what
adding effects and swapping instruments during playback sounds like, and a catalog of every device as agents would get
it.

Copied from `../team_view` and changed: the robot button opens the **edit bench** instead of the team view.

## Usage

```sh
make up       # build and start the studio (Vite dev server, src/ live)
make open     # open http://localhost:8080, then New Project, then the floating robot button
make test     # run every check in headless Chromium; prints PASS/FAIL and measurements, saves results/*.json
make down     # stop and remove the containers and network
make clean    # remove everything this POC created in Docker (not the shared builder)
```

`EDIT_RATE_SECONDS=30 make test` runs the edit rate cases for 30 s each (default 3). Port: as in team_view, use
`PORT=8081 make up` if another POC holds 8080.

**Headless numbers are indicative only** (Docker, no audio device). For figures we report, run the bench from its
buttons in a real browser, in a scratch project: each check adds its own instruments.

## The checks

| # | Button / `window.editBench` | What it does |
|---|---|---|
| 1 | Edit rate / `editRate(seconds)` | velocity changes to 10, 100, 1000 notes once per bar; a volume written at 30, 60, 120 Hz; automation points at the same rates. Reports time in `modify()`, audio blocks over budget (openDAW's DSP load measurement), long tasks, heap |
| 2 | Lead time / `leadTime()` | inserts a note, changes an existing note's pitch, or inserts into a looping region, at 0–300 ms ahead of `engine.position`; a note counts as heard when the engine reports it sounding |
| 3 | Automation / `automation()` | writes one-bar ramps ahead of the playhead (linear, curve, on a parameter touched this pass with and without an existing lane, tempo) and samples the value the engine applies |
| 4 | Start/Stop agent / `startAgent(strategy)`, `stopAgent()` | relabels a region every 250 ms (`direct`: `modify`, `append`: `editing.append`, `queue`: wait while anything is held). Drag a knob meanwhile; Stop classifies the undo steps as agent only, user only or mixed |
| 5 | Held line / `holds()` | shows the parameters held right now, from the patch below; `holds()` lists each hold and whether its address matched the updates it caused |
| 7 | Devices / `devices()` | inserts then removes each effect agents may add (`src/Allowed.ts`) on a held note, then swaps a pulsing synth through each allowed instrument, then compares three ways to change an instrument (swap, crossfading layers with and without wrapping first, new track), measuring gaps, level dips and timing from the engine's output (`OutputTap`); then checks whether an automation lane survives its device being replaced or deleted, and whether undo restores it |
| 8 | Catalog / `catalog()` | creates, reads and deletes every instrument and effect (stopped), listing each one's descriptions, automatable parameters (name, range, default, stepped values) and other settings; `make test` saves it to `results/catalog.json` |
| 10 | Open questions / `questions()` | while openDAW records: an agent's adapter writes, field writes, and writes over an agent's lane; playback past the timeline's end; notes crossing a loop's end; time until Nano, Playfield and Convolver sound after a sample (generated, imported through openDAW's sample service) is assigned |

Check 6 (the study draft offline) waits for the draft.

## Live sessions

`live/eval.mjs` runs JavaScript in an open bench tab over the Chrome DevTools Protocol, so someone at the terminal
(or an agent) can edit the project while a person works in it. Start a separate Chrome with remote debugging (its
own profile; close it afterwards, since any local program can drive it meanwhile):

```sh
open -na "Google Chrome" --args --remote-debugging-port=9222 --user-data-dir="$HOME/.chrome-opendaw-live" http://localhost:8080
node live/eval.mjs 'return bench.project.timelineBox.bpm.getValue()'   # or: node live/eval.mjs -f script.js
```

Open a project and the bench panel first. The script runs as an async function body with `bench` in scope
(`window.editBench`: the checks, plus `project` and `lib`, openDAW's factories and `PPQN`), and prints its return
value. No dependencies.

## What the patch touches (4 files)

| File | Change |
|---|---|
| `ui/App.tsx`, `vite.config.ts` | as in team_view: mounts `@/team_view/TeamHost`; pre-bundles `markdown-it` |
| `ui/wrapper/RelativeUnitValueDragging.tsx` (knobs), `ui/components/VolumeSlider.tsx` (faders) | dispatch a bubbling `parameter-hold` DOM event with `{parameter, held}` on pointer-down and when the drag ends (+9 lines) |

`src/` is mounted at `src/team_view/` in the studio tree, the path the patch imports from, so the patch's App.tsx
hunk is team_view's unchanged.

## Files

- `src/BenchPanel.tsx`: the bench's buttons and output; defines `window.editBench`
- `src/Bench.ts`: shared helpers: a synth rig, transport, automation writing, `PerfProbe`
- `src/EditRate.ts`, `src/LeadTime.ts`, `src/Automation.ts`, `src/DragUndo.ts`, `src/Holds.ts`, `src/DeviceChanges.ts`,
  `src/Catalog.ts`, `src/OpenQuestions.ts`: checks 1–5, 7, 8 and 10 (`src/InstrumentChange.ts`: check 7's instrument change comparison)
- `src/Allowed.ts`: the instruments and effects agents may add (project_plan/STRATEGY.md)
- `src/OutputTap.ts`: reads the engine's output through an AnalyserNode. openDAW keeps the engine node private, so
  it wraps `AudioNode.prototype.connect` to catch the node connecting to the speakers
- `src/TeamHost.tsx`, `src/TeamOverlay.tsx`: from team_view (the overlay shows `BenchPanel`)
- `test/smoke.mjs`: runs the checks headless; `results/`: its JSON output (git-ignored)
- `Dockerfile`, `compose.yaml`, `Makefile`, `tsconfig.json`: as in team_view. `make types` gives editor types; a
  symlink `.opendaw -> ../team_view/.opendaw` also works, since `src/` doesn't use the patched files
