# openDAW: observing and changing a project

Notes from building `poc/team_view` against openDAW commit `652e6caf`. Source paths are relative to openDAW's
`packages/` (in the POC, after `make types`: `poc/team_view/.opendaw/packages/`).

## Making changes

- Every edit goes through `project.editing.modify(() => { ... })`. It runs the change as one transaction and records
  one undo step. With `false` as the second argument the change is left pending instead (see "Undo steps" below);
  openDAW's tap-tempo and knob drags do this.
- Values are fields on boxes, e.g. `project.timelineBox.bpm.setValue(125)`.
- The scripting API (`studio/scripting/src/Api.ts`) has a typed vocabulary of edits, useful as reference. But scripts
  edit a copy of the project and reload it, which stops playback, so they can't make edits during playback.

- Creating content: `project.api` (`studio/core/src/project/ProjectApi.ts`) has the same helpers openDAW's UI uses,
  e.g. `createInstrument(InstrumentFactories.Vaporisateur)` → `{trackBox, ...}`, `createNoteRegion({trackBox,
  position, duration})`, `createNoteEvent({owner: region, position, duration, pitch, velocity})`. Call them inside
  `editing.modify`. Adding one instrument with a region of 4 notes produced 24 box updates.

## Undo steps

Source: `lib/box/src/editing.ts` (`BoxEditing`).

- A transaction is synchronous: it opens and closes inside one `modify()` call. The unit that undo works with is the
  *undo step* (a history entry): a group of changes closed by `editing.mark()`.
- Changes not yet closed into a step wait in a private `#pending` list. `modify(fn)` adds its changes to pending and
  then closes the step, so **pending changes left by someone else end up in the caller's undo step**. `modify(fn,
  false)` adds to pending without closing. `append(fn)` adds to the last closed step.
- Pending also holds UI state (selection, which region is open in the editors), so pending changes don't always mean
  a gesture is in progress.
- There is one undo stack for the whole project. Ctrl+Z undoes the most recent step, whoever made it.
- `modify()` and `append()` fail an assert while a `beginModification()` process is open. Only MIDI import
  (`app/studio/src/ui/timeline/MidiImport.ts`) uses one.
- Measured (edit bench, check 4), an agent relabeling a region every 250 ms during a 2 s knob drag:
  - with `modify()`: 7 of 18 undo steps mixed an agent edit with part of the drag, and the drag got no step of its own;
  - with `append()`: the drag and all 14 agent edits became **one** undo step;
  - holding agent edits while anything is held and applying each with `modify()` after release: 0 mixed steps, the
    drag is one step of its own.

## Knob and slider gestures

Source: `app/studio/src/ui/wrapper/RelativeUnitValueDragging.tsx` (knobs), `app/studio/src/ui/components/VolumeSlider.tsx`.

- A drag calls `editing.mark()` on pointer-down and adds the CSS class `modifying` to the element. Each movement is
  `editing.modify(() => parameter.setUnitValue(value), false)`, so the drag's changes stay pending. Release calls
  `editing.mark()`, closing the drag as one undo step, and removes the class. Escape writes the previous value back.
- The parameter model has no gesture event. `AutomatableParameterFieldAdapter` only reports value writes
  (`setValue` → `parameterFieldAdapters.notifyWrite`). Grabbing a control without moving it is visible only in the
  UI: the `modifying` class, or a patch to those two files.
- An agent `modify()` during a drag folds the drag's pending changes into the agent's undo step (measured above).
- **Held signal** (`poc/edit_bench/opendaw.patch`, +9 lines in those two files): each drag's `start` and `finally`
  dispatch a bubbling `parameter-hold` DOM event, `detail: {parameter, held}`. `start` runs on pointer-down, so a
  grab without movement is reported. `parameter` is the `AutomatableParameterFieldAdapter`; its `address` equals the
  `update.address` of the changes the drag makes. Release runs `finalise` (`mark()`) before `finally`, so the drag's
  undo step is closed when `held: false` arrives.
- Wheel changes on a knob (`modifying-controls-wheel` preference) and double-click text entry are not gestures and
  send no hold events.

## Automation

- A lane is a track of type `Value`: `project.api.createAutomationTrack(audioUnitBox, parameterField)`.
- `project.api.createTrackRegion(trackBox, position, duration)` creates a `ValueRegionBox` on it. It seeds the
  region with one point (the value held on the left, else the parameter's current value) and resolves overlaps with
  existing regions per the user's setting (clip, push or keep), never stacking two regions.
- Points are `ValueEventBox`es in the region's `ValueEventCollectionBox`, with `position` (ticks, relative to the
  region), `value` and an interpolation to the next point: `Interpolation.None`, `.Linear` or `.Curve(slope)`
  (`lib/dsp/src/value.ts`; write it with `InterpolationFieldAdapter.write`). A ramp with a duration and a curve is
  two points.
- A curve is its own box (`ValueEventCurveBox`, created by `InterpolationFieldAdapter.write`). Write the interpolation
  after `ValueEventBox.create(...)` returns: creating a box inside another box's constructor callback throws
  "Cannot construct box while other box is constructing".
- Tempo automation: points (values in BPM) go in the `ValueEventCollectionBox` that `timelineBox.tempoTrack.events`
  points to, and `tempoTrack.enabled` must be true.
- The value the engine applies is readable on the main thread: `parameter.getControlledUnitValue()` (the engine
  reports automated values back for parameters that have a lane), `engine.bpm` for tempo.
- **Writing a parameter's value during playback turns off its automation until playback stops**
  (`studio/core/src/project/AutomationSuspension.ts`), but only if the parameter already has a lane at the time of
  the write. Any write through the parameter adapter counts, from the user, MIDI or our code.
- Measured (check 3, headless): ramps written 500 ms ahead of the playhead during playback are followed on the same
  pass, linear (0.229 → 0.499 → 0.768 at 5/50/95 %), curve, and tempo (121 → 135 → 148 BPM). On a parameter written
  this pass while it had a lane, a new ramp is not followed (value stays at the written 0.5). Written this pass
  before any lane existed, a new lane's ramp is followed.

## Effects and instruments

- Effects: `project.api.insertEffect(audioUnitBox.audioEffects | .midiEffects, factory, index)`, with factories in
  `EffectFactories` (`studio/core/src/EffectFactories.ts`: `AudioNamed`, `MidiNamed`, about 30 in all). Remove one
  with `Devices.deleteEffectDevices([adapter])` (`studio-adapters`), which also renumbers the chain; reorder or copy
  with `api.moveEffects` / `api.copyEffects`. Set a new effect's parameters in the same `modify()` (e.g. Stereo Tool's
  `volume` in dB).
- Instruments: `project.api.replaceMIDIInstrument(instrumentBox, factory)` swaps the instrument of a note track, as
  the device browser does. It keeps the track, regions, notes and effect chain, fails (`Attempt`) for audio tracks,
  and the new instrument starts from its defaults. Instrument factories are in `InstrumentFactories.Named`. Layers:
  `createCompositeLayer`, `setLayerInstrument`. New unit: `api.createInstrument(factory)`.
- **A device's automation lanes are deleted with it.** A lane's `target` pointer is mandatory, so replacing an
  instrument or deleting an effect deletes every lane on its parameters, with their regions. One undo brings back the
  device and its lanes together.
- Measured (check 7, headless), on a soloed synth, from the engine's output:
  - Inserting or removing an effect is heard within one audio callback (Stereo Tool at -24 dB: level drop after
    5 ms, back after 3 ms), with no gaps in a held note, for the allowed effects (STRATEGY.md, "Agents change
    devices"). Exceptions: inserting Autotune made one 35 ms gap and Maximizer one 2.7 ms gap; inserting or
    removing Fold put 5–7 blocks over budget. Sink and Vocoder had no destination or second input. `modify()` cost
    6–17 ms.
  - Replacing an instrument cuts the old one within 5–11 ms, with no release tail, which may click. Notes already
    sounding are not handed over: the new instrument is heard from the first note that starts at least ~30 ms after
    the swap (the lead time). Tubular, swapped 21 ms before a note, was heard from the note after (507 ms). Tubular,
    Neon, Cubed, Korpus, Apparat and Vaporisateur all sounded; `modify()` cost 6–13 ms; 0–2 blocks over budget per
    swap.
  - Three ways to change the instrument of a track playing a short note every beat with a 2 s release (so its tails
    fill the time between notes), each edit landing during a note, two runs:

    | Method | Steps | Gap | Deepest dip (normal: ~-4 dB) |
    |---|---|---|---|
    | swap: `replaceMIDIInstrument` | 1 | 290–430 ms, until the next note | silence |
    | layers: wrap during playback, add a layer at -inf, crossfade the layers' `gain` over a bar, delete layer 1 | 3 | 420–430 ms, at the wrap | silence |
    | layers on a track wrapped before it sounded | 3 | none | -8 dB (linear ramps in the gain's unit range) |
    | new track: new unit with the old one's mixer settings and effects, regions moved onto it, old unit's volume faded over a bar, old unit deleted | 3 | none | -2 dB |

    `wrapInstrumentIntoComposite` cuts the sound like a swap: the engine rebuilds the instrument. Adding and deleting
    a layer, the gain ramps, creating a unit and deleting the faded one are all gapless. Moving a region off a unit
    releases the note it was sounding (the old unit reports no note 50 ms later), so nothing hangs and the old
    instrument's release rings out. Deleting a layer is the costliest step: 30–320 ms in `modify()`, with up to 4
    audio blocks over budget in one run; the others cost 3–60 ms.
  - Layers: `wrapInstrumentIntoComposite` moves the unit's effects onto layer 1; move them back with
    `api.moveEffects` to keep them on the whole track. Each layer (`InstrumentCompositeCellBox`) has automatable
    `gain`, `pan`, `mute`, `solo`. There is no unwrap: a track with one layer left stays a composite.
  - Not measured: instruments that need content to sound (Nano, Playfield, Soundfont, Audio Track, layer
    racks), and how long a sample takes to load until it is heard.

- **Stored values aren't display values** (live POC, 2026-10-30). Stepped parameters are often stored offset:
  Tubular's algorithm 0-based (stored 4 = algorithm 5), its operator detune 0–14 for -7..+7, Vaporisateur's
  `filterOrder` 1–4 for 12/24/36/48 dB. `adapter.setPrintValue("24")` on the filter slope did nothing, without an
  error. Write through `valueMapping` (or the raw value, knowing the offset), then read `getPrintValue()` back.
- **Note names: openDAW calls MIDI 60 "C3"** (its piano roll shows MIDI 64 as E3), one octave below scientific naming
  (C4 = 60). Our sample library follows openDAW's.

### What devices exist, read from openDAW (check 8)

openDAW describes its own devices well enough to generate a catalog for agents, with no hand-written list:

- Each factory (`DeviceFactory`) has `defaultName`, `briefDescription` ("Acid bassline synthesizer"), `description`
  and `manualPage`; effect factories add `type` (`audio`/`midi`). The lists: `InstrumentFactories.Named` (13),
  `EffectFactories.MidiNamed` (6) and `AudioNamed` (22).
- A device's automatable parameters are registered in `project.parameterFieldAdapters` when its adapter is made
  (`project.boxAdapters.adapterFor(box, Devices.isAny)`). That registry can't be listed, but it can be looked up by
  address: walk the box's primitive fields (`field.accept({visitPrimitiveField, visitArrayField, visitObjectField})`,
  skipping `field.deprecated`) and call `parameterFieldAdapters.opt(field.address)`. Each adapter gives `name`, the
  range through `valueMapping.y(0)`/`y(1)`, display text with units through `stringMapping.x(value)` ("8000 Hz",
  "-6.0 db", "3/16"), and `valueMapping.floating()` for stepped parameters, whose values can all be printed (Delay's
  note lengths, Tubular's 32 algorithms, Neon's modulation modes).
- Fields without a parameter adapter are settings: settable in a `modify()` but not automatable (Vocoder's
  `bandCount`, Cubed's pattern steps, a script's `code`).
- Measured (headless): all 41 devices can be created, read and deleted while stopped, giving 395 parameters (210
  stepped), every one with a name and a printable range.
- Size: names and descriptions are ~1.5k tokens; with every parameter ~12.5k; with settings ~22k. The 21 devices
  allowed for agents: ~0.7k and ~10.5k. Tubular's 156
  operator parameters are ~5.5k alone, Cubed has ~1000 pattern settings.
- Every device has a manual page in openDAW's source: `packages/app/manual/public/<manualPage>.md` (the manual is
  its own app, served at `/manuals/`; the studio's dev server proxies it). 200–2400 words each, 28k in all; written
  for users, so they describe controls by their place in the UI. `ai.md`, `automation.md`, `mixer.md`,
  `modulation.md` and `presets.md` cover the rest of the studio.
- Shows no parameters: devices whose parameters live in other boxes (composites' layers, Playfield's pads,
  Zeitgeist's groove), scriptable devices (Apparat, Spielwerk, Werkstatt: the script declares them) and WebCLAP
  (the plugin declares them). Read those from the project once the device has content, not from the catalog.
- Creating WebCLAP, Soundfont and some other devices makes openDAW fetch indexes from `assets.opendaw.studio` (see
  "Remote services").

## Recording, playback range, listening, saving

Answered 2026-10-31 from the source and check 10 (headless, two runs).

- **Automation recording catches agents' writes.** While openDAW records (`project.startRecording(countIn)`),
  every write through a parameter adapter (`setValue`/`setUnitValue`, which call `parameterFieldAdapters.notifyWrite`)
  becomes automation: an agent writing a volume 15 times made one region with 32 points. A write straight to the
  box field isn't recorded. Automation recording is a preference, `engine.preferences.settings.recording
  .automationEnabled`, on by default. MIDI recording takes only MIDI input; clip playback isn't recorded.
- **Recording over an agent's lane replaces only the recorded span.** A lane over bars 1–8, written over in bar 2,
  became three regions: 1–2, the take (2.1–2.4.2), and 2.4.2–9.
- **Playback doesn't stop at the end of the timeline.** With the loop off, the playhead ran on past bar 129 (the
  timeline's 128-bar length), so playing forward needs no timeline management.
- **Notes crossing a looping region's end are heard** (3 of 3, with mid-loop controls also 3 of 3). That rules it
  out as the cause of check 2's occasional loop miss. So are accumulated notes, inserts into the loop's next pass,
  and the note-state stream missing played notes (experiment C, [EXPERIMENTS.md](EXPERIMENTS.md)): 300 of 300 loop
  inserts at 300 ms were heard. Misses at 50 ms or more happen about once in 400–800 inserts, of any kind, and only
  in the full test run; unexplained, deferred.
- **Samplers.** After a sample is assigned during playback (imported through `project.env.sampleService`):
  Nano sounded 150 ms later when its sample wasn't loaded yet (decode and transfer to the engine), Playfield 24–37 ms
  later with a sample already loaded. A Convolver applies its impulse response from the first note after it is
  inserted (within ~200 ms, the resolution measured), whether or not the response was already loaded, and the dry
  signal continues without a gap (experiment D). Assign samples a beat or more ahead of when they must sound;
  a Convolver can be inserted like any effect.
- **Listening is built in.** Per channel: `project.liveStreamReceiver.subscribeFloats(audioUnitAddress, ...)`
  gives peaks (the mixer's meters). Master: `EngineAddresses.PEAKS`, `LOUDNESS`, `SPECTRUM`, `GONIO`, `WAVEFORM`
  (openDAW's analysis cards). Offline: `OfflineEngineRenderer.start/renderSection` renders the mix or stems (per
  track, `ExportConfiguration`) without touching playback; `AudioBounce` bounces regions pre- or post-fader;
  `AutoEq` derives a corrective EQ from a rendered mix.
- **Saving.** `project.toArrayBuffer()` encodes the whole project (`ProjectSkeleton.encode`); `Project.load(env,
  buffer)` restores it; `ProjectProfile.save()` writes to OPFS. Samples stay in OPFS by uuid. No autosave found in
  the source: a checkpoint is ours to take.
- **Macros and modulation exist.** Project-wide modulators (LFO, Steps, Random, Macro fader), each driving any
  number of parameters with a depth per target (`ModulationBox`, manual: `modulation.md`). Any parameter, including a
  depth, can be MIDI-learned (`MIDILearning.ts`). Our macros can be openDAW Macro modulators.
- **openDAW's scripting API** (`packages/studio/scripting/src/Api.ts`, 2700 lines, typed and documented) is a
  high-level facade over the whole project: `addRegion`, `addEvents`, Playfield `slot(note)`/`addSample`, sends,
  modulators, `mixdown`. It doesn't edit the open project live: a script runs in a worker on a copy and
  `openInStudio()` replaces the project. Its vocabulary is a model for our operation library.
- **openDAW's own tests run in our container.** The studio app's suite (34 files, 222 tests) passed with our patch
  applied, in ~90 s (`npm test` in `packages/app/studio`).

## Timing and load

Measured with `poc/edit_bench` in headless Chromium in Docker (`make test`, 3 s per edit-rate case). Indicative
only; to be repeated from the bench's buttons in a real browser.

- **Lead time.** An edit is heard on the current pass when it lands at least ~30–50 ms ahead of `engine.position`
  as the main thread reads it: inserted notes from 50 ms, a changed note's pitch and notes inserted into a looping
  region from 30 ms; nothing at 0–10 ms.
- **Edit rate.**
  - One `modify()` changing note velocities cost 24 ms for 10 notes, 49 ms for 100, 71 ms for 1000, in a region of
    4096 notes (a later run: 30, 94, 85 ms). The cost is mostly fixed per call rather than per note; the cause isn't
    isolated yet. 1000 notes caused 1–5 audio blocks over budget per run (12 in an early one).
  - Single value writes and automation points with `modify(fn, false)` cost ~1–2.5 ms on average up to ~100 per
    second, with rare outliers of 50–70 ms, and no sustained audio overruns.
- Audio-thread cost is readable from the page: set `engine.preferences.settings.debug.dspLoadMeasurement = true`,
  then `engine.perfBuffer` (ring buffer, ms per 128-frame block) and `engine.perfIndex`. The block budget is
  128 / sample rate (2.67 ms at 48 kHz).

## Remote services

openDAW's source calls `api.opendaw.studio` (shared music, user count, SoundCloud), `package.opendaw.studio`
(ffmpeg) and `logs.opendaw.studio`. Creating devices fetches `assets.opendaw.studio` indexes: `wclaps/`,
`presets/` and `soundfonts/index.json` (check 8). The study draft must not depend on any of them.

## Reading state on demand

Agents need to query the project, not only receive pushed changes. Everything is readable synchronously at any time:

- Raw: `project.boxGraph.boxes()` (filter with `instanceof`, e.g. `NoteRegionBox`, `NoteClipBox`), then read fields
  with `getValue()`.
- Through adapters (easier, the read-only views openDAW's UI uses): `project.boxAdapters.adapterFor(box,
  NoteRegionBoxAdapter)`. A note region or clip adapter's `optCollection` gives its notes:
  `collection.events.asArray()` → `NoteEventBoxAdapter` with `pitch` (0–127), `position`, `duration` (ticks,
  relative to the region start), `velocity` (0–1). `region.trackBoxAdapter` leads to the track and its instrument.
- Time is in ticks ("ppqn", 960 per quarter note). `PPQN.toString(ticks)` (`@opendaw/lib-dsp`) prints
  bars.beats.sixteenths:ticks.

The team view's **Read notes** button does this (`readNotes` in `poc/team_view/src/TeamPanel.tsx`).

## Telling our changes from the user's

Updates are delivered synchronously inside the edit. The team view sets a flag around its own `modify()` call, so
any update that arrives while the flag is set is ours (`team`); everything else is the user's (`daw`). Undo/redo
counts as `daw`: it's a user action.

## Event subscriptions

Every subscription returns something with `terminate()`. In our code, hand it to the lifecycle that owns it:
`lifecycle.own(...)`.

### Project data (`project.boxGraph`)

A project is a graph of boxes (records such as the timeline, a track or a note) with typed fields. Every change shows
up here, whatever made it: the user, undo/redo, our code, or a live-collaboration peer.

| API | Fires on | Notes |
|---|---|---|
| `boxGraph.subscribeToAllUpdates({onUpdate})` | every change: box created or deleted, field value changed, pointer (link between boxes) changed | Used by the team view. Update types: `NewUpdate`, `DeleteUpdate`, `PrimitiveUpdate` (field: old → new), `PointerUpdate` |
| `boxGraph.subscribeToAllUpdatesImmediate(...)` | the same, delivered at a different point during an edit | Not needed yet |
| `boxGraph.subscribeVertexUpdates(propagation, address, fn)` | changes at one address. `Propagation.This` = that field or box, `.Children` = everything under it, `.Parent` | Lets an agent watch only its own part of the project, e.g. one track |
| `box.subscribe(propagation, fn)` | the same, on a box object | |
| `boxGraph.subscribeDeletion(uuid, fn)`, `box.subscribeDeletion(fn)` | that box is deleted | |
| `field.subscribe(fn)`, `field.catchupAndSubscribe(fn)` | one field's value changes; `catchup…` also calls once immediately with the current value | e.g. `project.timelineBox.bpm` |
| `field.pointerHub.subscribe({onAdded, onRemoved})` | things attached to or removed from a box | e.g. regions on a track, tracks in the project |

Readable labels for updates: `boxGraph.findVertex(update.address)` gives the field; `field.debugPath` prints e.g.
`TimelineBox:bpm`.

Source: `lib/box/src/graph.ts`, `box.ts`, `field.ts`, `primitive.ts`, `pointer-hub.ts`, `updates.ts`, `dispatchers.ts`.

### Transactions and undo history

| API | Fires on |
|---|---|
| `boxGraph.subscribeTransaction({onBeginTransaction, onEndTransaction(rolledBack)})` | the start and end of each edit. One user gesture produces many updates; this groups them into one "move" |
| `boxGraph.subscribeEndTransaction(fn)` | once, at the end of the current transaction |
| `project.editing.subscribe(fn)` | the undo history changed (edit recorded, undo, redo) |

Source: `lib/box/src/graph.ts`, `lib/box/src/editing.ts`.

### Live state (not stored in the project)

**Engine** (`project.engine` or `service.engine`). Observable values (`getValue()`, `subscribe`, `catchupAndSubscribe`):

- Transport: `position` (playhead, in musical ticks, "ppqn"), `isPlaying`, `isRecording`, `isCountingIn`, `bpm`
  (actual tempo, including tempo automation), `markerState` (current marker), `cpuLoad`.
- Event streams: `subscribeClipNotification` (clips starting and stopping), `subscribeDeviceMessage(uuid)`
  (messages from one device).
- **`subscribeNotes` never fires** at this commit: its notifier is never called (`studio/core/src/EngineWorklet.ts`).
  Notes the engine plays reach the main thread as the set of notes sounding right now, per audio unit, read once per
  animation frame: `new NoteStreamReceiver(project.liveStreamReceiver, audioUnitBox.address)`, then `isNoteOn(pitch)`
  in its `subscribe`. Pitch only, no velocity.

Source: `studio/core/src/Engine.ts`, `studio/adapters/src/NoteStreamReceiver.ts`.

**Higher-level views of the project** (`project.rootBoxAdapter`, `project.timelineBoxAdapter`), which openDAW's UI uses:

- `rootBoxAdapter.audioUnits.catchupAndSubscribe({onAdd, onRemove, onReorder})`: tracks/instruments added, removed or
  reordered. Easier than reading raw box updates.
- `region.subscribeChange(fn)` and a track's regions `subscribeChanges(fn)`: a clip or its contents changed.

Source: `studio/adapters/src/` (`IndexedBoxAdapterCollection.ts`, `timeline/RegionBoxAdapter.ts`, `timeline/TrackRegions.ts`).

**What the user is looking at**

- `project.selection.catchupAndSubscribe({onSelected, onDeselected})`: what the user has selected (regions, notes,
  devices…). Source: `studio/adapters/src/selection/VertexSelection.ts`.
- `project.userEditingManager`: which instrument or region is open in the editors.

**Studio service** (`service`, the `StudioService` our code receives)

- `service.projectProfileService.catchupAndSubscribe(fn)`: a project was opened or closed. The team view uses this to
  re-attach to the new project.
- `service.layout.screen`: which screen is showing.
- `service.subscribeSignal(fn, type)`: app-level signals, e.g. sample or soundfont imports.

## Which subscriptions serve which part of the proposal

| Need | Subscriptions |
|---|---|
| User edits as demonstrations for the agents | `subscribeToAllUpdates` plus `subscribeTransaction`, so each gesture arrives as one unit; tag our own edits |
| Edits ahead of the playhead | `engine.position`, `engine.isPlaying` |
| Resolving "this" in a note ("make this busier") | `selection`, `userEditingManager` |
| Human priority over agent edits | a held signal from the gesture code (see "Knob and slider gestures"), plus `subscribeVertexUpdates` on the parameter an agent wants to change |

## Checks

Implemented in `poc/edit_bench` (see its README); results are in the sections above. `make test` there runs all but 6 and 9
headless. The experiments designed to answer what these checks left open are in [EXPERIMENTS.md](EXPERIMENTS.md).

| # | Check | Status |
|---|---|---|
| 1 | Edit rate: velocity changes to 10/100/1000 notes per bar; one parameter at 30/60/120 Hz; automation points at the same rates | Done headless (3 s per case). **To do:** repeat in a real browser for 30 s per case, listening for dropouts; find what makes a single `modify()` on a large region cost 24+ ms |
| 2 | Lead time: insert, change an existing note, insert into a looping region, at 0–300 ms ahead | Done headless: 30–50 ms. Rare misses (about 1 in 400–800 inserts at 50 ms or more, any kind) fail `make test` when they happen; experiment C ruled out the loop-specific causes and the miss doesn't reproduce in isolation; deferred. Pitch change stands in for velocity change, since the engine doesn't report velocity |
| 3 | Automation added during playback: linear, curve, tempo, and on a parameter touched this pass | Done: all as expected. Checked through the value the engine applies, not by listening. Confirmed by hand in a real browser (live POC): grabbing a knob that has a lane turns the lane off until stop |
| 4 | Agent edits during a drag: direct, `append()`, queue while held | Done: queue is the only one that keeps the drag its own undo step |
| 5 | Held signal patch | Done: +9 lines in 2 files; fires on a grab without movement; address matches the updates |
| 6 | Study draft loads and sounds with the network blocked (Playwright `route` abort for non-localhost requests) | **Blocked:** no study draft yet |
| 7 | Effects and instruments changed during playback: insert/remove the 16 allowed effects, swap through the 5 allowed instruments, swap vs. layer crossfade vs. new track, lanes on a replaced or deleted device | Done headless: effects heard within one callback, no gaps (Maximizer: one 2.7 ms gap); a swap or a wrap into layers cuts the sound until the next note; a crossfade on an already-wrapped track and a new track are gapless; lanes are deleted with their device, undo restores both. **To do:** listen in a real browser (click on a cut, the crossfade's dip); instruments that need samples; why deleting a layer costs up to 320 ms |
| 8 | Device catalog: every instrument and effect, with its descriptions, parameters (name, range, default, values when stepped) and settings, read from openDAW | Done headless: 41 devices, 395 parameters, none failed; 33 allowed for agents, with 392 parameters; saved to `results/catalog.json`. **To do:** decide the hand-written notes per device (character, typical use) |
| 9 | Library samples in openDAW: import `sample_library/` into the browser's sample storage, load sounds into Playfield pads, Nano, an audio track and Convolver during playback; time until heard, gaps | Partly done by hand in a real browser (live POC): the vinyl crackle imported with `project.env.sampleService.importFile({name, bpm: 0, arrayBuffer})` (no uuid: openDAW derives it from the file's SHA-256, so re-imports reuse it), an `AudioFileBox` with that uuid (its class taken from a box already in the project), and `api.createNotStretchedRegion` on a new Audio Track (`InstrumentFactories.Tape`), seconds time base, looped by setting `duration` beyond `loopDuration`. Heard; survived save and page reload with the project's automation and arrangement. Headless (check 10): Nano 150 ms until heard with a sample not yet loaded, Playfield 24–37 ms with it loaded, Convolver: its response applies from the first note after the insert, loaded or not (experiment D). **To do:** the library's own sounds in each, automated |
| 10 | Open behaviour questions: automation recording of agents' writes and over agents' lanes, the timeline's end, notes crossing a loop's end, samplers' time until heard | Done headless: see "Recording, playback range, listening, saving" |
