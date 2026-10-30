# Implementation strategy

Decisions about how we build the system, and why. openDAW facts they rely on are in [OPENDAW.md](OPENDAW.md).
Markers refer to OPENDAW.md's "Checks" (run with `poc/edit_bench`): *(check N)* means the check confirmed the
decision; *(check N, headless)* means it rests on headless numbers still to be repeated in a real browser.

## Where things run

- **Speech stays outside openDAW.** Capture and speech-to-text belong to the team/AI layer, not openDAW. openDAW
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
- **Devices that load files are left out for now** (Soundfont, Nano, Playfield, Convolver, NeuralAmp): their
  delay until sound is unmeasured.

## Timing

- **Agent edits land at least 200 ms ahead of the playhead.** Edits were heard from 30–50 ms ahead
  *(check 2, headless)*; 200 ms leaves margin for a slower real browser and a busy main thread. To revisit with
  real-browser numbers.
- **Each agent request is one `modify()`, with at most ~100 note changes.** A `modify()` on a large region costs
  24–71 ms whatever the number of notes changed, so one call per request beats many small ones, but 1000 note
  changes in one call caused audio overruns *(check 1, headless)*.
