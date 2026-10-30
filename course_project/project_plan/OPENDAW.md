# openDAW: observing and changing a project

Notes from building `poc/team_view` against openDAW commit `652e6caf`. Source paths are relative to openDAW's
`packages/` (in the POC, after `make types`: `poc/team_view/.opendaw/packages/`).

## Making changes

- Every edit goes through `project.editing.modify(() => { ... })`. It runs the change as one transaction and records
  one undo step. Pass `false` as the second argument to skip the undo step (openDAW's tap-tempo does this).
- Values are fields on boxes, e.g. `project.timelineBox.bpm.setValue(125)`.
- The scripting API (`studio/scripting/src/Api.ts`) has a typed vocabulary of edits, useful as reference. But scripts
  edit a copy of the project and reload it, which stops playback, so they can't make edits during playback.

- Creating content: `project.api` (`studio/core/src/project/ProjectApi.ts`) has the same helpers openDAW's UI uses,
  e.g. `createInstrument(InstrumentFactories.Vaporisateur)` → `{trackBox, ...}`, `createNoteRegion({trackBox,
  position, duration})`, `createNoteEvent({owner: region, position, duration, pitch, velocity})`. Call them inside
  `editing.modify`. Adding one instrument with a region of 4 notes produced 24 box updates.

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
- Event streams: `subscribeNotes` (notes being played, live input and playback), `subscribeClipNotification` (clips
  starting and stopping), `subscribeDeviceMessage(uuid)` (messages from one device).

Source: `studio/core/src/Engine.ts`.

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
| Human priority over agent edits | transaction listeners, plus `subscribeVertexUpdates` on the parameter an agent wants to change |

## Open questions

- Does grabbing a control without moving it produce any event? Human priority ("touch" mode) needs to know when
  the user starts holding a control, not only when its value changes.
