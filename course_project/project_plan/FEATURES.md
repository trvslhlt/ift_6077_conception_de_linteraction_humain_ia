# Features

Features we intend to build but haven't designed in detail. How we build things is in [STRATEGY.md](STRATEGY.md);
openDAW facts are in [OPENDAW.md](OPENDAW.md).

## Project overview when the team view opens

**What.** Opening the team view shows a short overview of the project: what it is musically, its style, what's in
it technically, and where playback is. It gives the user and the agents the same starting picture, and lets the
user correct the agents' reading before asking for anything ("it's not electro, it's meant to be trip-hop").

**Length.** Four labelled lines, about 60 words in all. Readable at a glance, beside the DAW.

**Example** (the `travis_demo` project, from the live POC, 2026-10-30):

> **Music:** a one-bar loop in C at 120 BPM, 4/4. The synth riff locks to the drums: root on the kicks, a
> half-step up (C♯, the Phrygian flat-2) on the snares.
> **Style:** dark, minimal 808 electro; machine-tight, no swing or dynamics. An early sketch: groove and hook only.
> **Tracks:** TR-808 (Playfield, 808 kit), Harmonic Synth (Apparat); Maximizer on the master.
> **Playback:** playing, looping bar 1.

**How it works.**

1. On opening, the bus builds a **snapshot** of the project in code: the agentTeamAPI's state query (STRATEGY.md,
   "What the state query must return"), from the box graph, not with ad-hoc queries
   (in the POC, hand-written queries missed a track added meanwhile and the master's effect). For each track: name,
   instrument (device type and preset or kit name), effects, mute, solo and level; each region's position, length,
   and loop length; its notes as `[position, pitch, duration, velocity]`, in bars.beats.sixteenths. Then the
   master's effects, tempo, time signature, and the playback state: playing or stopped, position, loop range,
   metronome.
2. **One model call** turns the snapshot into the overview, with the prompt below. Analysis the model is bad at
   is done in code first and added to the snapshot: the key (pitch classes weighted by duration), which notes fall
   on which drum hits, velocity range and whether everything is on the grid.
3. The overview shows when the view opens and stays as it is. When the project has changed since, a "refresh"
   button appears; the playback line updates live, since it needs no model.

**What it must not do.** Guess what a device sounds like when the catalog doesn't say (an Apparat or Werkstatt
script, a sampler without a library sound): name the device, not its timbre. Describe what isn't there ("no bass")
only where it helps the user decide what to ask for next.

**Open.** Whether agents read the overview text or only the snapshot (the snapshot is exact, the overview is what
the user saw and may have corrected). Note names: openDAW's piano roll calls MIDI 60 "C3" (checked live); our library
and anything shown to the producer use that naming, with MIDI numbers underneath.

**Suggested prompt.**

```text
You describe a music project in openDAW to the producer working on it, as the opening overview of their AI team's
view. They know music production; write as a fellow producer would.

Write exactly four lines, about 60 words in all:
**Music:** key, tempo, meter, length, and the musical idea: how the parts relate (rhythm, harmony, register).
**Style:** genre or reference in a few words, the feel (groove, dynamics, density), and how finished it sounds.
**Tracks:** each track's name and instrument, then any effects; no levels unless one stands out.
**Playback:** playing or stopped, and where (looping which bars, or the position).

Rules:
- Use only the snapshot. Name a device's sound only if its catalog description gives it; otherwise name the device.
- Prefer musical terms over technical ones ("snare on 2 and 4", not "note 61 at 1.2.1").
- One style label, the most specific you can defend from the notes, tempo and kit; no hedging lists.
- Mention something missing only if it is an obvious next step.

Snapshot (JSON):
{{snapshot}}

Catalog descriptions of the devices used:
{{device_descriptions}}
```

## Requests by demonstration

**What.** The producer shows an agent what they want instead of saying it: they say "watch this", make the move in
the project (turn a knob, edit some notes), say "done", and the agent works out the intent, refines it and applies
it more widely ("make it nice and apply it throughout"). Some ideas are easier to perform than to put into words,
especially movement over time.

**Example** (`travis_demo`, live POC, 2026-10-30). The producer moved the Lofi Keys Crusher's Bits knob 32 times
over one pass of the 8-bar loop. The agent read it as: a dive into heavy crush going into bar 5 (5 → 1 bits, back
to 8 within a sixteenth), a slow degradation through bars 5–8 (hovering at 2–3 bits through the turnaround), and a
snap back to clean on the loop restart; tension into the turnaround, released on the downbeat. It said so, then
wrote a smoothed version as an 8-bar automation lane (12 bits held, a dive to 3 at bar 5, a quick recovery to 8,
sinking to 2 by bar 8, back to 12 at the restart), applied in the gap before a loop restart so the switch was
inaudible. The producer's earlier, unrecorded tweaks to the same device (Mix, Crush) were kept.

**How it works.**

1. **Notice.** There is no "watch" and "done": the agentTeamAPI's change log already records everything the producer
   does (time, playhead position, playing or stopped, what changed, from and to as display values). When it sees a
   burst of moves on one control followed by a pause, the team view offers to turn it into something ("turn that
   into a pattern?"), so the producer never has to remember to start and stop an observation. Speech that points
   back ("like that", "do that there too") refers to the latest burst. In the POC the log was a
   `boxGraph.subscribeToAllUpdates` listener; nothing else was needed.
2. **Interpret.** The agent turns the log into a musical description: what was touched; the shape over time,
   anchored to the bar grid (where it moves, how fast, extremes, where it returns); and the likely intent. Raw
   knob logs are noisy (overshoots, hesitations, a sweep logged as a dozen steps), so the shape matters more than
   the exact values.
3. **Confirm, unless told to go ahead.** The agent states its reading and the refined version before applying it,
   in a few lines, so the producer can correct it ("no, only in bar 8"). In the example the producer had already
   said "make it nice and apply it", so the agent applied it and stated its reading alongside.
4. **Refine and apply.** "Make it nice" means: quantize the shape to the grid, smooth it into a few ramps, pull
   extremes back from unusable (1 bit is nearly noise), and keep the producer's gesture recognizable. "Throughout"
   is ambiguous (every pass of the loop, every track with the same device, the whole song); the agent picks the
   narrowest reading that fits and offers the wider ones. The result is written as automation (STRATEGY.md,
   "Changes over time: write automation"), landing where it is inaudible (a loop restart, or where the lane's value
   matches the knob's).

**Things to know.**

- The live POC used an explicit "done" and a recorder started on request; the offer replaces both (decided
  2026-10-30).
- Only changes to the project are seen. Notes played on a MIDI keyboard without recording, and audio, aren't; the
  producer records them into a region first.
- A lane on a parameter makes the knob follow it; if the producer grabs that knob during playback, openDAW turns
  the lane off until stop (OPENDAW.md, check 3). The agent should say so after writing one.
- Demonstrations are a strong signal for the study: they show what the producer couldn't or didn't want to put
  into words, and the agent's stated interpretation shows whether it understood.

**Open.** What counts as a burst (how many moves, how long a pause), and how the offer appears without
interrupting. Not for now: drawing the agent's reading as a ghost lane over the recorded gesture.

**Suggested prompt.**

```text
The producer demonstrated something in their openDAW project instead of describing it. Below is everything they
changed while demonstrating, in order, with the time, the playhead position (bars.beats.sixteenths) and whether
it was playing. They said: "{{instruction}}".

1. Describe what they did musically, in two or three sentences: what they touched, the shape over time anchored to
   bars and beats, and the likely intent (e.g. "builds tension into the turnaround, releases on the downbeat").
   Treat small reversals and step-by-step sweeps as one gesture.
2. Propose a refined version: the points of an automation lane (position, display value, ramp or step to the next),
   quantized to the grid, smoothed into a few ramps, extremes pulled back if unusable, the gesture still
   recognizable.
3. Say where it applies. If the instruction is ambiguous ("throughout"), choose the narrowest reading that fits
   and name the wider ones.
4. Say when it should land so the change is inaudible (e.g. just before a loop restart).

Project snapshot:
{{snapshot}}

Demonstration log:
{{log}}
```

## Intent controls, set up before a performance

**What.** Before a performance the producer and the team talk it through in the team chat, and each agent sets up
the controls it will be steered with during the performance: ordinary macros (a knob driving parameters, e.g.
"dust" moving several Crusher and filter settings at once) and **intent controls**, dials whose meaning only the
agent can carry out. Example: the composer agent's "impressionistic" dial changes which notes it chooses (more
extended and suspended chords, parallel motion, fewer resolutions), which no parameter mapping can do. During the
performance the producer steers by moving dials instead of typing requests; agents act within those bounds.

**How it relates.** Macros are value writes every frame (STRATEGY.md, "Changes over time"); intent controls are
read by the agent when it prepares its next move, so they work at the speed of the slow or fast tier (STRATEGY.md,
"Responsiveness"). Where the dials live (team view, or openDAW's own macro controls) is open, given the rule of
changing openDAW as little as possible.

## Agents listen

**What.** Agents hear the result, not only the project data: levels and spectrum per track and on the master, and
whether a part is audible on common speakers. A mixing agent needs it to work at all, and every agent can check
its own edit ("the bass I added is inaudible below 150 Hz on laptop speakers"). In the live POC a bass line that
was present, unmuted and at -5 dB was inaudible to the producer: notes at 49–82 Hz. Design notes are in
STRATEGY.md ("What agents know", the Listening part). Likely high impact on how capable the team feels.

## Session view: keep the whole performance

**What.** Instead of a loop that overwrites itself, the performance is captured so it can be edited afterwards,
as with Ableton's session view: parts are clips that can be launched and varied, and what was played (each clip
launch, each change, at its time) is recorded into the arrangement. Every change then lives at a place on the
timeline. openDAW has clips (`NoteClipBox`, `api.createNoteClip`) and clip sequencing in its engine; whether it
records launches into the arrangement is to be checked. A simpler first step: play forward with the loop off, the
agent extending each part ahead of the playhead and writing each bar's version, changes included, in place.

**The starting state.** When the team view opens, the bus saves a checkpoint of the project in openDAW's own
format (not a copy as a second project), and keeps the change log (who changed what, when) for the whole session.
Together they restore, compare and replay the session, and they are the study's record of it. Undo history isn't
enough: in the live POC one click on the loop button cleared the redo stack and lost two changes.

## Visible presence

**What.** The producer sees what the team is about to do before it lands: which agent, which track or control,
what change, and when (a countdown to the bar it lands on), with time to veto it by grabbing the control. Drawing
this in openDAW's own UI would need deeper changes to openDAW than we want for now, so the first version lives in
the team view: tracks the team is working on, each with the agent, the pending change and its countdown.

## Proposals you can hear

**What.** A larger change (a new part, a new instrument) arrives as something playable before it is accepted: a
muted alternate track, or an A/B switch the producer flips on the beat. Accepting becomes a musical act rather
than a "yes" in the chat. Possibly; to try after the operation library exists.
