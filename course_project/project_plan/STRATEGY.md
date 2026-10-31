# Implementation strategy

Decisions about how we build the system, and why. openDAW facts they rely on are in [OPENDAW.md](OPENDAW.md).
Markers refer to OPENDAW.md's "Checks" (run with `poc/edit_bench`): *(check N)* means the check confirmed the
decision; *(check N, headless)* means it rests on headless numbers still to be repeated in a real browser.

## Changing openDAW

openDAW is pinned to one commit for the life of the project, so a patch never has to follow upstream changes. The
remaining risk is breaking what already works, and that is testable: openDAW's own test suite runs in our build
(the studio app's 222 tests passed with our patch, ~90 s), and our smoke test exercises the paths we rely on.
So changes to openDAW are allowed, under rules, rather than off limits:

- **Our layer first.** The team view and the bus reach the open project's objects directly (`project`,
  `project.api`, adapters, `liveStreamReceiver`, `engine`), and so far that has covered everything except the
  hold signal: devices, notes, automation, samples, recording, meters, offline renders. A patch is for what has no
  path at all.
- **Patches add hooks; they don't change behaviour.** An event, a data attribute, an exported handle (as the hold
  signal's +9 lines). No changes to existing behaviour, to the box schema (`forge-boxes`: the saved project
  format) or to the engine (Rust/WASM, `core-processors`: the audio thread, where breakage is audible and slow to
  rebuild).
- **Every hunk is listed with its reason** in the POC's README ("What the patch touches"), including why no API
  path existed.
- **Tests gate it.** The build runs openDAW's tests for every package a patch touches, plus our smoke test; a
  failure blocks it. To add: a `make test-opendaw` target.
- **Kept small.** Today: 4 files, about 15 lines. A need that would take more than ~100 lines is a sign to rethink
  the design first.

Likely next candidate: marking controls with their parameter address (a data attribute on knobs and faders), so
the team view can point at a control for visible presence (FEATURES.md).

## Where things run

- **Speech stays outside openDAW, and is a stretch goal** (inputs are text, controls and demonstration; FEATURES.md).
  Capture and speech-to-text belong to the team/AI layer, not openDAW. openDAW
  only ever receives edits. This keeps speech-to-text free of the studio page's cross-origin isolation (COOP/COEP)
  rules.
- **Model calls go through a local proxy, not straight from the browser.** The proxy holds the API key and is where
  we log study data.

## Agent edits are requests

Agents never edit the project directly. They send requests to the change bus, and the bus replies to each one:

| Reply | Meaning |
|---|---|
| `applied` | done, as one undo step; carries the step's position in the undo history |
| `dropped` | the user is holding that parameter |
| `queued` | the user is mid-gesture elsewhere; applied when the gesture ends |
| `failed` | openDAW raised an error |
| `superseded` | the user changed the same thing afterward |

The position in the undo history lets an agent see later whether the user undid its edit, which is a
demonstration signal in itself.

## What agents know

The contracts are specified in [AGENT_TEAM_API.md](AGENT_TEAM_API.md). Agents never see openDAW's API. What they know comes from the bus's agent-facing interface, the **agentTeamAPI**
(tentative name), in five parts that change at different rates:

| Part | Content | Changes | How agents get it |
|---|---|---|---|
| Requests | the library of predefined operations (ramp, add effect, change instrument, edit notes, ...; see "Responsiveness") | when we change the bus | tool definitions |
| Options | the devices openDAW offers, their parameters and what they do | when we bump the openDAW pin | generated catalog |
| State | the project now: tracks, devices, parameter addresses and values, lanes, what the user holds | every edit | live queries |
| Changes | who changed what, as it happens | every edit | subscription |
| Listening | what is actually heard: levels and spectrum per track and on the master | continuously | live readings, offline renders |

- **The catalog is generated from openDAW, not written by hand.** openDAW's factories and parameter adapters give
  every device's name, descriptions, parameters, ranges, units and stepped values. The build creates each device
  in a scratch project, reads it, and writes the catalog to a checked-in file, regenerated when the openDAW pin
  changes. *(check 8, headless)*
- **We add one or two hand-written lines per device on its character and typical use** ("Dattorro: lush plate,
  good on pads"). openDAW can't supply these, and they're what turn "make it dreamier" into a device choice.
- **The catalog holds only the allowed devices.** Off-limits devices don't appear, so agents can't pick them.
- **Device names and descriptions go in the system prompt; parameters and manuals come from lookups.** For the
  allowed devices the list is ~1.2k tokens; with every parameter it is ~12k, Tubular alone ~5.5k.
  `describe_device(name)` returns one device's parameters, and `read_manual(name)` its manual page. openDAW's
  manual is markdown in its source (`packages/app/manual/public/<manualPage>.md`), one page per device,
  200–2400 words; the allowed devices' pages are ~20k words together, too much for a prompt. The
  `applied` reply for an added device carries its parameters with their addresses.
  *(check 8)*
- **No retrieval knowledge base for now.** The catalog fits in a prompt or a lookup by name, so embeddings would
  add a step that can miss without saving anything. Lookups by name cover the manual too.
- **Project state is always queried, never cached in a prompt.** A `describe(track)` query returns its device
  chain, and for each parameter its address, current display value, range, whether it has a lane and whether the
  user holds it. Devices whose parameters the catalog can't list (layers, scripts, WebCLAP) are read this way.
- **Changes carry who made them** (user, which agent, or undo), using the origin tagging in OPENDAW.md ("Telling
  our changes from the user's").
- **Playback state is its own query** (decided in AGENT_TEAM_API.md): not project data, not in the change stream.
  Every message carries the time and playhead position, and each model call that can produce a request gets the
  playback state in its context.

- **Agents can listen, not only read the project.** A mixing agent (and any agent checking its own edit) needs what
  is actually heard, which the project data can't tell: a bass line that is in the project, unmuted, at -5 dB, was
  inaudible on the producer's speakers because its notes were at 49–82 Hz (live POC). The Listening part gives,
  per track and for the master: peak and loudness (LUFS), and energy in a few bands (sub < 60 Hz, low, low-mid,
  mid, high), with a note when a part's energy sits mostly where common playback systems don't reach (laptop
  speakers below ~150 Hz, phones below ~300 Hz). Sources: openDAW's own meters per channel, the engine's output
  through an analyser (as `OutputTap` in `poc/edit_bench`), and openDAW's offline renderer for a soloed track over
  a whole loop without disturbing playback. To design with the mixing agent; a check to come.
- **Agents write parameters by display value, and the bus converts and reads back.** Stored values differ from what
  the UI shows (Tubular's algorithm is stored 0-based, its detune 0–14 for -7..+7, Vaporisateur's filter slope 1–4
  for 12–48 dB), and openDAW's text parsing (`setPrintValue`) silently ignores some values. The bus converts
  through each parameter's mappings, reads the value back, and replies `failed` when it didn't take.

### What the state query must return

Taken from describing `travis_demo` through the live POC (`poc/edit_bench/live/eval.mjs`, 2026-10-30): what it
took to describe a project musically, stylistically and technically (FEATURES.md, "Project overview").

| Scope | Information | Used for |
|---|---|---|
| Timeline | tempo, time signature, length | key facts, positions in bars |
| Each track | name; kind (instrument, audio, bus); mute, solo, volume, pan | the track list, the mix |
| Its devices | instrument's device type and name (and preset or kit, if loaded); audio and MIDI effect chains, in order, with names | the track list; style (an 808 kit says a lot) |
| Device content | what a note triggers: a sampler's pad-to-sample map (Playfield: note 60 = "TR-808 Bass Drum"); a sampler's sample; a script device's script name | reading drum notes as kick, snare, hat; without it, a drum part is only numbers |
| Its regions | position, length, loop length, name | the arrangement, how the loop repeats |
| Its notes | position, pitch, duration, velocity | rhythm, harmony, register, feel |
| Master | effect chain, volume | the track list, loudness |
| Playback | playing or stopped, position, loop on and range, metronome | the playback line |

- **Positions go out as bars.beats.sixteenths** (openDAW's `PPQN.toString`), pitches as MIDI numbers with note
  names, velocities as 0–127: what both models and producers read.
- **Analysis code does, not the model:** key (pitch classes weighted by duration), which notes land on which drum
  hits, velocity range, whether everything sits on the grid, register. The state query can return these alongside
  the raw data.
- **Gaps found:**
  - A script device's sound (Apparat's "Harmonic Synth") isn't readable: we can name it, not describe it.
  - Ad-hoc queries missed a track added meanwhile and the master's effect. The state query must walk the whole
    box graph each time, and the changes subscription must report added and removed tracks and devices.

## Human priority

- **Requests address parameters, not UI controls.** The ID is the parameter's address in the project (box UUID plus
  field), the same address that update events carry. UI controls need no IDs.
- **"Held" comes from the gesture code**, through a small patch to openDAW's knob and slider drag code that reports
  hold begin and end per parameter, from pointer-down. Watching the undo history can't do this: its pending list is
  private, mixes in UI state, and stays empty until the pointer moves. The patch is +9 lines in 2 files and reports
  a grab without movement. *(check 5)*
- **While the user holds a parameter, requests that write it are dropped.**
- **While any gesture is in progress, all agent edits wait** and are applied after release, each as its own undo
  step. Applying them during the drag folds the user's unfinished drag into agent undo steps, and `append()` is
  worse: it merged the drag and every agent edit into a single step. *(check 4)*

## Changes over time: write automation

- **Agents change parameters by writing automation, not by setting values.** Automation is project data the user
  can see and edit, the engine plays ramps exactly with no per-frame writes from us, and it avoids openDAW turning off
  a parameter's automation once its value is written during playback. Ramps written during playback are followed on
  the same pass, including curves and tempo. *(check 3)*
- **The bus offers a ramp command:** `{parameter, from, to, start, duration, curve}`. The bus turns it into two
  automation points, the first with `Linear` or `Curve(slope)` interpolation. Existing points inside the ramp's range
  are replaced.
- **When the user moves a parameter that has a lane during this pass, openDAW turns off that lane until stop.**
  The bus watches for this (a `daw` write to a parameter with a lane, during playback) and replies `applied` with a
  note that the change will be heard from the next pass. A parameter without a lane isn't affected: a lane created
  after the user's move is followed. *(check 3)*
- **Macro controls are the exception** and may write values every frame, since they follow the user's own fader.
  Single writes cost ~1–2.5 ms at up to ~100 per second without audio overruns *(check 1, headless)*. A macro
  writing a parameter that has a lane would turn that lane off until stop, so macros should drive parameters agents
  don't automate. Values vs. automation vs. modulation stays open until we design the macros.

## Agents change devices

- **Agents may add any device whose use they can learn from openDAW's manual and our catalog: 33 of 41.**
  Instruments: Vaporisateur, Neon, Cubed, Korpus, Tubular, Nano and Soundfont (sample players), Playfield (drum
  sampler), Audio Track, and layer racks. MIDI effects: Arpeggio, Pitch, Velocity, Zeitgeist. Audio effects: Stereo
  Tool, Delay, Free Reverb, Dattorro Reverb, Compressor, Crusher, Tidal, Autotune, Fold, Gate, Maximizer, Revamp,
  Waveshaper, Convolver, Vocoder, Sink, and the effect racks and splits. Off limits, since what they do depends on
  something undocumented: WebCLAP (third-party plugins), MIDI Output (external hardware), Apparat, Spielwerk and
  Werkstatt (user scripts; the manual documents the scripting API, not a given script) and Tone3000 (amp models
  from tone3000.com). Agents may still remove or move an off-limits device the user added. The list is
  `poc/edit_bench/src/Allowed.ts`. *(checks 7 and 8)*
- **Samplers, Convolver and audio tracks only use samples from an index agents can read**, with metadata for
  choosing them. openDAW's stock samples, soundfonts and impulse responses come from its cloud, which the study
  must not depend on, so the study ships its own: `sample_library/`, 52 CC0 sounds (two drum kits, pitched
  one-shots, loops, impulse responses). Each has hand-written kind, category, tags, description and suited
  devices; a drum hit's General MIDI note (its Playfield pad); a pitched sound's MIDI note (Nano's root key); a
  loop's tempo, bars, key and chords; and measurements (length, level, attack, decay, brightness, pitch) that its
  build checks the claims against. The index is ~5k tokens without sources and fine measurements, so agents get a
  `find_samples(kind, category, tags)` lookup rather than the whole list in the prompt. Soundfont needs .sf2 files,
  which the library doesn't have yet.
- **Agents may add, remove and move effects, and swap a note track's instrument.** Each is one request, one
  `modify()`, one undo step, with the usual replies. Effect changes are heard within one audio callback with no
  gaps in the sound, so the bus applies them on arrival. *(check 7, headless)*
- **Replying `applied` to an added device includes its parameters' addresses**, so the agent can automate them
  next (e.g. "bring the reverb in over 4 bars" is an add, then a ramp).
- **A swap or delete that removes automation lanes says so in its reply.** openDAW deletes a device's lanes with it;
  one undo restores both. The reply lists the lanes removed, so the agent can tell the user or put them back on the
  new device. *(check 7)*
- **Every instrument lives in a layer device (an instrument composite) from the start, as in Ableton's instrument
  racks.** The bus wraps each note track's instrument as a one-layer composite while it is silent: when the project
  loads stopped, or when the track is created. Wrapping during playback cuts the sound like a swap does.
  *(check 7, headless)*
- **Changing an instrument is a crossfade between layers.** The bus adds the new instrument as a layer at -inf,
  crossfades the two layers' gain over one bar from the next bar line (both layers play every note meanwhile, so
  the old one's notes ring out), then deletes the old layer. Gapless, and the track, mixer channel, effects,
  regions and their lanes keep their addresses. Only the old instrument's own lanes go, as with any swap. It is
  three undo steps, so the reply lists all three. The ramps should use an equal-power curve: linear ramps dipped to
  -8 dB against -4 dB between notes. *(check 7, headless)*
- **A plain swap is for when nothing is playing**, where its cut doesn't matter and it is one undo step. If a
  track somehow isn't wrapped during playback, the bus falls back to a new track (also gapless), and the reply maps
  the old unit's and effects' addresses to the new ones.
- **Removing a device the user is holding a control on is dropped**, as for any write to a held parameter.

## Responsiveness

The live POC (2026-10-30) worked well for producing a track but was too slow for a live performance. openDAW's
edits took milliseconds; the time went into the model writing a script per request (tens of seconds to minutes),
waiting for a safe landing point (up to a whole 8-bar loop, ~23 s) and deliberate 2-bar fades (~6 s).

- **Agents act through a library of predefined operations, not openDAW's whole surface.** Each operation is a
  tool call with parameters (ramp a parameter, swap an instrument, add a part, vary a pattern, ...) that the bus
  carries out with code already written and tested. This library is the Requests part of the agentTeamAPI; agents
  never write openDAW code.
- **Three speeds:**

  | Tier | What decides | Latency | For |
  |---|---|---|---|
  | slow | a language model | seconds to tens of seconds | new musical material, plans, conversation; prepared ahead |
  | fast | a System One model (e.g. TypeSafe's Jev) | about a second | picking and filling in an operation, reading a gesture or a dial |
  | instant | code | milliseconds | firing a prepared operation, macros, following the producer's controls |

- **Prepare, then fire on cue.** Slow work is prepared while the current section plays; it lands on the next beat
  or bar when the producer cues it (or when its condition is met), not at the next loop restart.

## Session record

- **A checkpoint when the team view opens, and a change log for the whole session.** The checkpoint is the project
  in openDAW's own format (`project.toArrayBuffer()`, restored with `Project.load`), saved alongside rather than as
  a second project; openDAW has no autosave. The log is every change with who made
  it (user, which agent, undo) and when. Together they restore, compare and replay a session, and are the study's
  data. Undo history alone loses things: in the live POC a click on the loop button cleared the redo stack.

## Timing

- **Agent edits land at least 200 ms ahead of the playhead.** Edits were heard from 30–50 ms ahead
  *(check 2, headless)*; 200 ms leaves margin for a slower real browser and a busy main thread. To revisit with
  real-browser numbers.
- **Each agent request is one `modify()`, with at most ~100 note changes.** A `modify()` on a large region costs
  24–71 ms whatever the number of notes changed, so one call per request beats many small ones, but 1000 note
  changes in one call caused audio overruns *(check 1, headless)*.
