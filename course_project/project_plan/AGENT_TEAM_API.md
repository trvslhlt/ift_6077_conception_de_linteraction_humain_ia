# agentTeamAPI (draft)

The contracts between the agents and the open openDAW project: what agents can ask for, what they can read, what
they are told, and what the session keeps. Draft of 2026-10-31, written before the interaction design. It specifies
the structures and protocols, not the list of operations, which waits for that design. Why things are this way is in
[STRATEGY.md](STRATEGY.md); openDAW facts are in [OPENDAW.md](OPENDAW.md).

## Overview

```
 agents (slow: LLM, fast: System One)      team view (chat, controls, overview)      producer in openDAW
              │  requests, queries                     │  same API                          │ edits, gestures
              ▼                                        ▼                                    ▼
 ┌──────────────────────────────────── the bus (in the studio page) ────────────────────────────────────┐
 │ Requests · Options · State · Changes · Listening · Controls                    Session record ──────────┼─▶ local proxy ─▶ disk
 └──────────────────────────────────────────────── openDAW project ──────────────────────────────────────┘
```

- **The bus is the only thing that touches openDAW.** It runs in the studio page, since it needs the project's
  objects. Agents, the team view and the session record all go through it, so all three see the same thing.
- **The team view is a client like the agents.** The producer's moves on team-view controls, and chat messages,
  go through the API too, so they're logged and seen by agents the same way.
- **Messages are JSON.** Every structure below is plain data, so it can cross a process boundary unchanged. The
  first transport is open (see "Open questions"); nothing here depends on it.
- **Seven parts.** STRATEGY.md's five (Requests, Options, State, Changes, Listening), plus **Controls** (the macros
  and intent controls set up in the prep conversation; FEATURES.md) and **Team** (agents talking to each other).
  The **Session record** is built from all seven.

## Conventions

Types are written in TypeScript notation; `?` is optional.

### Who

```ts
type Actor = "user" | `agent:${string}` | "bus"     // "bus": the bus's own housekeeping (e.g. wrapping an instrument)
type Via = "edit" | "gesture" | "undo" | "redo" | "recording" | "control" | "load"
```

Every change and message carries an `Actor`. `Via` says how a change came about. The user's knob drag is
`user`/`gesture`; their undo is `user`/`undo`, even if it undid an agent's edit. Agents' edits are tagged by the flag
the bus sets around its own `modify()` (OPENDAW.md, "Telling our changes from the user's"). Undo and redo are
recognized by wrapping `project.editing.undo()`/`redo()` in our layer; no openDAW patch is needed.

### Refs: what agents call things

Agents never see openDAW's UUID addresses. The bus issues **refs**: short ids, stable for the session, never
reused.

| Ref | Names | Example |
|---|---|---|
| `t<n>` | a track (an audio unit) | `t3` |
| `t<n>.i` | its instrument; `t<n>.i.L<k>` a layer in its composite | `t3.i.L1` |
| `t<n>.fx<k>` | an audio effect; `t<n>.mfx<k>` a MIDI effect | `t3.fx2` |
| `master`, `master.fx<k>` | the master channel and its effects | `master.fx1` |
| `<device>.<param path>` | a parameter, by its catalog path | `t3.fx2.bits`, `t3.i.L1.operators/1/coarse` |
| `t<n>.mix.<volume|pan|mute|solo>` | channel controls | `t3.mix.volume` |
| `r<n>` | a region | `r12` |
| `c:<name>` | a control (macro or intent) | `c:dust` |

- **The bus keeps the map from refs to openDAW addresses**, and the session record logs both. If a device moves in
  its chain, its ref stays the same and its `index` changes.
- **Refs in replies and events come with a label** where a person or model will read them: `{ref: "t3.fx2.bits",
  label: "Lofi Keys › Crusher › Bits"}`.
- **A track swapped for a new one** (STRATEGY.md's fallback when an instrument can't be crossfaded) keeps its ref:
  the bus remaps it, and the reply says so.

### Time, pitch, values

| Kind | Format | Notes |
|---|---|---|
| Position | `"5.1.1"`, `"5.3.2:120"` | bars.beats.sixteenths[:ticks], 1-based, as openDAW shows it |
| Duration | `{bars?, beats?, sixteenths?}` | e.g. `{bars: 2}`, `{beats: 3}`; summed. Not the dotted form, which reads as a position |
| Wall time | ms since session start | in every event, as `t` |
| Pitch | MIDI number; `name` alongside in output | openDAW naming: 60 = `"C3"` |
| Velocity | 0–127 | openDAW stores 0–1; the bus converts |
| Parameter value | display value: a number in the catalog's unit (`-6` for dB, `2000` for Hz), or a label for stepped parameters (`"Sawtooth"`) | the bus converts, writes, reads back; the reply carries the value as applied |

## Requests

An agent asks for a change by sending a request; the bus validates it, schedules it, applies it and reports each
step. Agents never edit the project directly.

### Request

```ts
type Request = {
    id: string                 // from the sender, unique per sender
    from: Actor
    op: string                 // an operation name from the library
    args: object               // checked against the operation's schema
    when?: When                // default {at: "asap"}
    reason?: string            // one line, for the producer and the log ("darker for the breakdown")
    prepareOnly?: boolean      // prepare now, apply on a cue (see below)
}

type When =
    | {at: "asap"}                                   // as soon as safe: at least 200 ms ahead of the playhead
    | {at: "next", unit: "beat" | "bar" | {bars: number}}  // next beat, bar, or multiple of n bars (phrase)
    | {at: string}                                   // a position, e.g. "9.1.1"
    | {on: "cue", cue: string}                       // when the cue fires
    | {after: string}                                // when another request (by id) has applied
```

- **A landing time that's already passed** fails with `too_late`, unless it's `next`, which rolls forward to the
  next one.
- **While stopped, every edit applies at once.** Musical landing times only matter during playback.

### Status: the reply stream

Each request gets a series of status messages, ending with one terminal status:

```ts
type Status = {
    request: string, t: number, pos: string
    state: "scheduled" | "prepared" | "queued" | "applied" | "dropped" | "failed" | "cancelled" | "superseded"
    landsAt?: string           // scheduled: where it will land
    undoSteps?: number[]       // applied: positions in the undo history (a crossfade makes 3)
    result?: object            // applied: what the operation returns (see below)
    reason?: FailReason        // dropped, failed
    detail?: string
}

type FailReason = "invalid_args" | "unknown_ref" | "not_allowed" | "held" | "out_of_range"
    | "value_not_taken" | "too_late" | "too_large" | "conflict" | "opendaw_error"
```

| State | Meaning | Terminal |
|---|---|---|
| `scheduled` | accepted; will land at `landsAt` | no |
| `prepared` | ready; waiting for its cue | no |
| `queued` | the user is mid-gesture; applies when it ends | no |
| `applied` | done | yes, though it can later become `superseded` |
| `dropped` | the user holds a parameter it writes (`held`) | yes |
| `failed` | not done; `reason` says why | yes |
| `cancelled` | withdrawn by its sender, or replaced by a newer request on the same target from the same agent | yes |
| `superseded` | after `applied`: the user changed the same target, or undid the step | follows `applied` |

- **`applied` results carry what the agent needs next.**
  - An added device: its ref and its parameters' refs.
  - A swap: the lanes it removed, and any ref remaps.
  - A write: the values as read back.
  - A note edit: the notes' new state.
- **`superseded` is how an agent learns the user overrode it.** The bus emits it when, within the session, a
  `user` change touches a target the request wrote, or a `user`/`undo` removes its undo step. It cites the change
  event's `seq`. This is a demonstration signal in itself (STRATEGY.md).
- **One request is one `modify()` and one undo step**, except operations that state otherwise in their definition
  (the crossfade).
- **Limits:** at most ~100 note changes per request (`too_large`); writes to held parameters are dropped; requests
  wait while the user is mid-gesture (STRATEGY.md, "Human priority", "Timing").

### Cancelling and cues

```ts
type Cancel = {cancel: string, from: Actor}            // a request id; only before it applies
type Cue = {cue: string, from: Actor}                  // fires every request prepared on that cue
```

- **A cue is a name an agent chooses** (`"drop"`, `"verse-2"`). The producer fires it from the team view (a button
  the agent offered), or an agent fires it.
- **Prepared requests can be inspected** (`state.prepared()`), so the team view can show what's waiting
  (FEATURES.md, "Visible presence").

### Operations

The operation library is the Requests part's vocabulary: the tools agents call. Which operations exist waits for
the interaction design. This is the format each one is defined in, so the bus can validate, schedule, log and
expose them uniformly.

```ts
type Operation<Args, Plan, Result> = {
    name: string                          // tool name, e.g. "ramp"
    summary: string                       // tool description for the model; one or two sentences
    args: JSONSchema                      // tool input schema; refs, positions and values in the formats above
    targets(args): Ref[]                  // what it writes: for hold checks, superseding and conflicts
    landing: "any" | "musical" | "stopped" // "musical": must land on a time; "stopped": only when not playing
    undoSteps: number                     // usually 1
    plan(args, state): Plan | Failure     // pure: validate and compute everything ahead (notes, points, values)
    apply(plan, landsAt): Result          // inside one modify(); fast: no lookups, no model calls
}
```

- **`plan` and `apply` are split** so slow work happens before the landing time. Preparing for a cue is `plan`
  run early.
- **Shared building blocks**, needed whatever the list turns out to be:
  - **the scheduler:** lands a plan at a musical time, at least 200 ms ahead, rolling `next` forward;
  - **ramp:** a parameter from one value to another over a duration, as automation points (STRATEGY.md,
    "Changes over time");
  - **layer crossfade:** equal-power, over one bar, three steps (STRATEGY.md, "Agents change devices");
  - **note batches:** split into requests of ≤100 changes;
  - **wrap:** each instrument into a one-layer composite while silent;
  - **read-back:** for every value write.
- **Candidate operations** from the POCs, to confirm in the design:
  - `set` (a ramp of zero length), `ramp`;
  - `add_effect`, `remove_effect`, `move_effect`;
  - `change_instrument`;
  - `write_notes`, `edit_notes`;
  - `add_track`;
  - `place_sample`;
  - `set_tempo`, `ramp_tempo`.

## Options

What openDAW offers, generated from openDAW (check 8) and filtered to the allowed devices. Changes only when the
openDAW pin does.

```ts
type Device = {
    key: string, kind: "instrument" | "audio-effect" | "midi-effect", name: string
    brief: string, description: string             // openDAW's own
    character?: string, typicalUse?: string        // ours, hand-written (one line each)
    parameters: Array<{path: string, name: string, unit: string, min: string, max: string, default: string,
        stepped: boolean, values?: string[]}>
    needsContent?: "sample" | "samples" | "impulse-response" | "layers"
}
type Sample = { id: string, kind: string, category: string, tags: string[], description: string,
    suits: string[], note?: number, bpm?: number, bars?: number, key?: string, measured: object }
```

| Query | Returns | Where agents get it |
|---|---|---|
| `devices()` | every allowed device's `key`, `name`, `brief`, `character` (~1.2k tokens) | system prompt |
| `describe_device(key)` | one `Device` | tool |
| `read_manual(key)` | its openDAW manual page (markdown) | tool |
| `find_samples({kind?, category?, tags?, suits?})` | matching `Sample`s from `sample_library/library.json` | tool |

## State

What the project is now. Always queried, never cached in a prompt: it changes with every edit.

### Snapshot

```ts
type Snapshot = {
    at: {t: number, pos: string, seq: number}       // the change sequence number it reflects
    timeline: {bpm: number, signature: [number, number], length: string}
    tracks: Track[]
    master: {effects: DeviceRef[], volume: number}
    analysis?: Analysis                             // computed in code, on request
}
type Track = {
    ref: string, name: string, kind: "notes" | "audio" | "bus"
    mix: {volume: number, pan: number, mute: boolean, solo: boolean}
    instrument?: DeviceRef & {layers?: DeviceRef[], content?: Content}
    midiEffects: DeviceRef[], effects: DeviceRef[]
    regions: Region[]
    lanes: Array<{param: string, regions: Array<{from: string, to: string}>, activeThisPass: boolean}>
}
type DeviceRef = {ref: string, key: string, name: string, label?: string, allowed: boolean}
type Content =                                       // what a note triggers
    | {pads: Array<{note: number, name: string, sample: string}>}          // Playfield
    | {sample: string, rootNote?: number}                                  // Nano, audio regions
    | {script: string}                                                     // Apparat etc.: named, not described
type Region = {ref: string, name: string, from: string, to: string, loop: {bars: number, beats: number} | null,
    notes?: Array<[pos: string, pitch: number, length: Duration, velocity: number]>}  // pos relative to the region
type Analysis = {key?: {tonic: string, mode: string, confidence: number}, register?: object,
    drumMap?: object, grid?: {onGrid: number, swing?: number}, velocity?: {min: number, max: number}}
```

| Query | Returns |
|---|---|
| `snapshot({detail: "outline" \| "full", tracks?: Ref[], analysis?: boolean})` | `Snapshot`; `outline` leaves out notes |
| `describe(ref)` | a device or channel's parameters with ref, label, display value, range, whether it has a lane, and whether the user holds it |
| `playback()` | `Playback` |
| `holds()` | the refs the user holds now, and whether a gesture is in progress |
| `prepared()` | requests waiting for a cue, with their `reason` |

- **The snapshot walks the whole project each time**, so a track added meanwhile is never missed (STRATEGY.md,
  "What the state query must return").

### Playback is its own query

```ts
type Playback = { playing: boolean, recording: boolean, pos: string, bpm: number,
    loop: {on: boolean, from: string, to: string}, metronome: boolean }
```

Decided here: playback is not part of the project snapshot or the change stream. The position changes every frame,
and play/stop isn't project data. Instead every message the bus sends carries `t` and `pos`, and `playback()` is
attached to the context of every model call that can produce a request, so the agent always knows where the
playhead was when it decided. Play, stop and record starting or stopping are sent as `transport` events (below).
Loop range and tempo are project data, so they arrive as ordinary changes.

## Changes

What happened, as it happens. One event per openDAW transaction, so a user's gesture or an agent's request is one
event, not dozens of field updates.

```ts
type ChangeEvent = {
    seq: number, t: number, pos: string, playing: boolean
    actor: Actor, via: Via
    request?: string                    // the request it applied, for agent changes
    undoStep?: number
    changes: Change[]
}
type Change =
    | {kind: "value", ref: string, label: string, from: number | string, to: number | string}  // display values
    | {kind: "added" | "removed", ref: string, label: string, what: "track" | "device" | "region" | "lane"}
    | {kind: "moved", ref: string, label: string, from: number, to: number}                     // chain index
    | {kind: "notes", region: string, added: Note[], removed: Note[], changed: Array<{from: Note, to: Note}>}
    | {kind: "region", ref: string, from: object, to: object}                                    // position, length, loop
type Note = [pos: string, pitch: number, length: Duration, velocity: number]

type TransportEvent = {seq: number, t: number, pos: string, transport: "play" | "stop" | "record" | "record-stop"}
type HoldEvent = {seq: number, t: number, pos: string, hold: string, held: boolean}   // from the hold patch
```

- **Subscribing:** `subscribe({actors?, refs?, kinds?}, fn)`. An agent can watch only its own tracks, or only the
  user's moves.
- **The stream is also what demonstration detection reads** (FEATURES.md, "Requests by demonstration"): a burst
  of `user` `value` changes on one ref, then a pause.
- **Values are display values**, so a logged gesture reads as music ("Bits 12 → 5 → 1"), not stored numbers.
- **The raw openDAW updates are also kept, in the session record only**, for exact replay (below).

## Listening

What is actually heard. To be designed with the mixing agent; the shape so far (STRATEGY.md, "Agents can listen"):

```ts
type Reading = { ref: string, window: {from: string, to: string}, peakDb: number, lufs: number,
    bandsDb: {sub: number, low: number, lowMid: number, mid: number, high: number},
    flags: Array<"mostly-below-laptop-range" | "mostly-below-phone-range" | "clipping" | "silent">}
```

| Query | How |
|---|---|
| `listen(ref, {bars?})` | live: openDAW's meters per channel, the engine output through an analyser for the master |
| `render(ref, {from, to})` | offline: openDAW's renderer, soloed, without disturbing playback; returns a `Reading` per bar |

## Controls

Macros and intent controls, set up in the prep conversation, steered by the producer during the session.

```ts
type Control = {
    ref: `c:${string}`, label: string, owner: Actor      // the agent that proposed it
    kind: "macro" | "intent"
    widget: "dial" | "button" | "switch"
    range?: {min: number, max: number, minLabel?: string, maxLabel?: string}   // dials; intent dials name their ends
    value: number | boolean
    // macro only: what it drives, as an openDAW Macro modulator with these targets
    targets?: Array<{param: string, depth: number}>
    // intent only: what it means, in words the owning agent reads every time it plans
    meaning?: string
}
```

**Every control in the team view is a direction to the agents, not a change to the project** (decided 2026-10-31).
Moving one tells the agents something new; the agents make the changes. So the team view never writes openDAW
itself, and its controls are never holds.

| Kind | Where it appears | What moving it does |
|---|---|---|
| `macro` | openDAW (as a Macro modulator) and the team view, one to one | in openDAW: drives its parameters directly, in the engine, instant (the producer's own hand on the project). In the team view: a direction; the owning agent moves the macro |
| `intent` | the team view only | nothing in openDAW; agents read its value when they plan, so it acts at the slow or fast tier |

- **Defining:** `define_control(Control)` by an agent during the prep conversation, accepted by the producer.
  `remove_control(ref)`.
- **Moving:** a `value` change with `via: "control"` in the change stream, logged like any other.
- **Agents get every intent control's current value and meaning in the context of each plan.** Example:
  `{ref: "c:impressionistic", value: 0.7, meaning: "more extended and suspended chords, parallel motion, fewer
  resolutions"}`.
- **A macro writes through openDAW's own modulation**, not through per-frame writes from the bus, so a macro on a
  parameter with an agent's lane doesn't turn the lane off. That modulation and lanes combine as expected is to
  check.

## Team

Agents talk to each other, not only to the producer: to work out who does what, to resolve conflicts, and to
coordinate actions (the composer adds more chromatic notes as the mix engineer fades a part out). The bus carries
these messages and logs them; what agents say to each other is up to them and the interaction design.

```ts
type TeamMessage = {
    seq: number, t: number, pos: string
    from: Actor, to: Actor[] | "team"     // one agent, several, or everyone
    text: string
    re?: string                           // a request id or message seq it refers to
}
type Claim = {from: Actor, refs: Ref[], until?: string | "released", reason?: string}  // "I'm working on t3's mix"
```

- **Claims say who is working on what.** An agent claims refs before working on them; others see the claims in
  `state.claims()` and in the change stream. A request on a ref another agent has claimed fails with `conflict`,
  naming the claimant, so the two can talk it out. Claims are a convention the agents agree on; the bus only
  enforces them.
- **Coordinated actions use the request timing already there.** A shared cue (`{on: "cue", cue: "fade-out"}`)
  fires several agents' prepared requests together, and `{after: id}` chains one agent's request after another's.
  The composer and the mix engineer each prepare their part on the same cue, and agree on it by message.
- **The producer sees the team's conversation** in the team view (whether all of it or a summary is a design
  question), and can join it like any agent.

## Session record

What the session keeps, for restoring, comparing and replaying it, and as the study's data.

```
sessions/<session id>/
  session.json        id, start time, openDAW commit, project name, agents and their setup, controls defined
  checkpoint.bin      the project when the team view opened (project.toArrayBuffer())
  log.jsonl           every event, in order
  updates.bin         openDAW's raw updates per transaction (Update.write), keyed by seq
```

- **`log.jsonl` has one JSON object per line**, each with `seq`, `t` and `type`, one of:
  - `request`, `status`, `cancel`, `cue`;
  - `change`, `transport`, `hold`;
  - `chat`: messages between the producer and agents; `team`: messages between agents; `claim`;
  - `control`;
  - `model`: a model call's id, agent, tier, latency and token counts; the full call is in the proxy's own log.
- **`seq` is shared by the log and `updates.bin`**, so any logged change can be tied to its exact openDAW updates.
- **Replay:** load the checkpoint, then apply `updates.bin` in order. Exact, because openDAW's updates
  serialize. Compare: any two points in the log.
- **Where it goes:** the page can't write files, so the bus streams the record to the local proxy, which writes it
  to disk next to its model-call log (STRATEGY.md, "Where things run").
- **Samples aren't copied:** the checkpoint references library samples by their uuid, and the library is in the
  repo.

## Open questions

- **Transport between agents and the bus:** agents in the page (simplest; the browser makes the model calls through
  the proxy) or in a separate process talking to the page over a WebSocket through the proxy. The JSON contracts
  are the same either way.
- **Conflicts between agents:** decided that agents work them out between themselves (Team); claims are the
  draft's mechanism. Open: what happens when an agent ignores a claim, or two claim at once.
- **Cost of the full snapshot** on a large project: to measure, to decide whether `full` needs paging by track.
- **Superseding window:** how long after an agent's change a user change on the same target still counts as
  overriding it.

To check in openDAW, before building on them:
- Macro modulators combined with automation lanes on the same parameter.
- Ref stability through undo of a delete (the restored box keeps its UUID, so its ref can come back).
- `Update.write` covering every update the record needs.
