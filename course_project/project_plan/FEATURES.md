# Features

Features we intend to build but haven't designed in detail. How we build things is in [STRATEGY.md](STRATEGY.md);
openDAW facts are in [OPENDAW.md](OPENDAW.md); the agents' interface is in [AGENT_TEAM_API.md](AGENT_TEAM_API.md).

**Decided (2026-10-31), ahead of the interaction design:**

- **Inputs: text, controls and demonstration.** Speech is a stretch goal, added outside the DAW (speech-to-text
  feeding the same text channel).
- **A prep conversation comes first.** Before playing, the producer and the team talk through the session in the
  team chat; it sets up the agents, the project and the controls each agent will be steered with.
- **For both producing and performing.** A performance is captured on the timeline (see "Timeline-first"), so all,
  or at least most, of what happens in it can be edited afterwards.
- **Two kinds of control** (see "Intent controls"): macros, which drive parameters and appear both in openDAW and
  in the team view, one to one; and intent controls, only in the team view, which change the direction given to the
  agents rather than any parameter. Intent controls are a core part of the idea.
- **Team members and roles** (see "The team"). Every role is ready each session, and a
  member is shown only while it's doing work. Roles can be made and retired during a performance. The orchestrator
  is only the front door. "Team member" is the producer's view; "agent" is the implementation.

## The team: members and their roles

**Terms.** A **team member** is what the producer experiences: someone with a role, shown in the team view, whom
they talk to and steer. An **agent** is how a member is built: a model, a prompt, tools, a connection to the bus.
One agent per member; an agent may hold more than one role (which policy is better isn't known yet, so
neither is required). Design and study materials talk about team members; "agent" is for the
implementation (STRATEGY.md, AGENT_TEAM_API.md).

**What.** There is a set of roles. Producers aren't asked to choose members, since they may not know what each
role does, and they don't get a view crowded with members who have nothing to do. Every role in the set is ready
in every session; a member appears in the team view only while it's doing work.

**Roles** (a starting set; it grows, and new roles can be made during a session):

| Role | Does |
|---|---|
| **Orchestrator** | The front door, and only that. The producer's default partner in the chat: understands the request, passes it to the right members, and reports back. Does no musical work and doesn't manage the others' work (members coordinate among themselves; agentTeamAPI, Team), so it stays quick to answer. Always shown. |
| *Writing* | |
| Composer | Music-theoretical decisions and note choice: harmony, melody, voicing. |
| Bass programmer | The bass line: its notes, rhythm against the kick, and its sound. |
| Drum programmer | Like the composer, specialized in digital percussion: patterns, groove, fills, kits. |
| Arranger | The song's structure over time: sections, what plays when, builds and drops, transitions. |
| Transcriber | Turns demonstrations (a hummed line, a tapped rhythm, a played sketch) into notes for the others to use. |
| *Sound* | |
| Instrument designer | Builds and tweaks instruments: patches (Vaporisateur's oscillators, filters, envelopes, modulation), layered instruments, a Playfield kit from samples. |
| Effect designer | Effects as part of a sound: a track's own chain (Crusher, Delay, a filter sweep), and effect sounds of their own (risers, impacts). |
| Sampler | Picks samples from the library, chops them, and sequences the pieces. |
| Mix engineer | Balance between parts: levels, EQ, dynamics, sidechain; listens to the output (see "Agents listen"). |
| Spatialization engineer | Where parts sit in space: panning, stereo width, depth, the shared reverbs and delays that parts are sent to. |
| Mastering engineer | The whole: overall tonal balance and loudness, the master chain (Maximizer), consistency between sections. |
| *Performing* | |
| Performer | Plays the project live: mutes and drops, filter sweeps, riding macros, firing cues, in time with the producer. |
| Groove | Timing and feel across all parts: swing, humanizing, push and pull against the grid. |
| *Around the music* | |
| Researcher | Searches the web for a reference ("a song like X", an artist, a genre, a technique) and sums it up for the other roles: tempo, key and harmony for the composer, instruments and sounds for the instrument designer, structure for the arranger, mix and space for the engineers. Its summary also tells what the team lacks (see "the team's wishlist"). |
| Critic | Listens to the whole and says what works and what doesn't, against the goal or a reference style. Gives notes; makes no edits. |
| Assistant engineer | Housekeeping: naming and coloring tracks, routing and buses, cleaning up unused parts, keeping the wishlist tidy. |
| Tutor | When the producer asks *how* to do something, guides them through doing it themselves, in words and by naming the controls to use. Teaches rather than edits. |

**How it works.**

1. **Prep conversation.** The producer tells the orchestrator the goal ("finish this lofi beat", "jam on a techno
   loop", "learn to sidechain"); the members it concerns pick it up and set their intent controls.
2. **Members appear when they work** and fade from view when idle: a pending change, a claim, a message to the
   producer, or being addressed brings one into view. The producer can address any role by name ("ask the
   critic"), shown or not.
3. **Roles are made and retired during the session, performance included.** When a need has no role ("a string
   arranger for the bridge", "someone to handle the vocal chops' pitch"), the orchestrator makes one from a short
   description, and retires it when the need passes. The set's roles are never retired, only hidden.
4. **Each member is shown on its own:** its role, what it's doing, its intent controls, and its pending changes
   (see "Visible presence").

**The researcher searches the web** through the proxy, which holds the model calls (STRATEGY.md, "Where things
run"). Its searches and the pages it used are logged with the model call, so a session's research can be checked
later even after the pages change. The studio itself stays local (OPENDAW.md, check 6); only agents reach out.

**The tutor starts in the team view.** It names the control and where to find it ("the Cutoff knob on
Vaporisateur, in the device panel at the bottom"). Pointing at controls inside openDAW waits until the tutor shows
it's useful.

**For the study.** Every role in the set starts every session, so the team is the same for all participants;
what varies is who shows up. Logged: when each member appears and leaves the view, and which roles were made
during sessions (what producers needed that the set lacked). Choosing a subset of roles per goal stays possible
after the study.

**Open.**
- Cost: ready members spend nothing until reached through the orchestrator, but members that volunteer (the critic
  after a change, the mix engineer when a part clips) watch the change stream. Which roles may volunteer, and how
  often.
- How long an idle member stays in view, and whether the producer can see the whole team on request.
- Whether made-up roles keep across sessions, like the wishlist.
- Whether an agent should hold one role or several, and if several, which roles go together and whether the
  producer sees one member per role or per agent.
- Where neighboring roles' territory ends (a delay on one track vs. a shared one; EQ in a sound's chain vs. in the
  mix): left to the members to settle as conflicts, or written into each role's brief.

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
"dust" moving several Crusher and filter settings at once) and **intent controls**, dials (or buttons, switches)
whose meaning only the agent can carry out. A macro is a true macro: it appears in openDAW and in the team view,
mapped one to one. An intent control appears only in the team view and maps to no parameter: it changes the
direction given to the agents, at the level of intent, not of implementation. Example: the composer agent's "impressionistic" dial changes which notes it chooses (more
extended and suspended chords, parallel motion, fewer resolutions), which no parameter mapping can do. During the
performance the producer steers by moving dials instead of typing requests; agents act within those bounds.

**How it relates.** Macros are value writes every frame (STRATEGY.md, "Changes over time"); intent controls are
read by the agent when it prepares its next move, so they work at the speed of the slow or fast tier (STRATEGY.md,
"Responsiveness"). Both kinds are in the agentTeamAPI's Controls part (AGENT_TEAM_API.md).

## Agents listen

**What.** Agents hear the result, not only the project data: levels and spectrum per track and on the master, and
whether a part is audible on common speakers. A mixing agent needs it to work at all, and every agent can check
its own edit ("the bass I added is inaudible below 150 Hz on laptop speakers"). In the live POC a bass line that
was present, unmuted and at -5 dB was inaudible to the producer: notes at 49–82 Hz. Design notes are in
STRATEGY.md ("What agents know", the Listening part). Likely high impact on how capable the team feels.

## Timeline-first: keep the whole performance

**What.** Instead of a loop that overwrites itself, the performance is captured on the timeline so it can be
edited afterwards: notes and automation at the place they happened. Decided (2026-10-30): work in openDAW's
timeline, not clips. The performance needs automation recorded, not only parts placed, and the timeline holds
both.

**How.** The loop is off and the playhead runs forward. Agents write ahead of the playhead: each part is extended
bar by bar (or phrase by phrase) with that bar's version, changes included, and their parameter changes go in as
automation lanes (STRATEGY.md, "Changes over time"). The producer records: openDAW's own recording turns every
parameter move into automation while it records (`core/src/capture/RecordAutomation.ts`: it listens to
`parameterFieldAdapters.subscribeWrites`, and a pause over 100 ms holds the value). Checked (check 10): agents'
writes through parameter adapters are recorded the same way (writes straight to a box field aren't), recording
over an agent's lane replaces only the span it recorded, and playback runs on past the timeline's end.

**Clips, for reference.** openDAW has clips and clip sequencing, but doesn't record clip playback into the
arrangement: MIDI recording captures only the MIDI input (a controller or the on-screen keyboard), so recording
while a clip plays makes an empty "Take" (checked 2026-10-30). Clip launches are observable
(`engine.subscribeClipNotification`), should we come back to clips.

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

## Naming what's missing: the team's wishlist

**What.** When a request needs something the team doesn't have, the agent says so instead of quietly substituting.
Example: "in the style of Boards of Canada" calls for detuned, warbling tape and old analog synths. The agent says
which of those it can get close to and with what (Vaporisateur with slow pitch drift from an LFO, Crusher, the
library's vinyl crackle), which it can't (real tape saturation and wow; there is no tape-emulation effect among the
allowed devices), and what would close the gap (a tape plugin, or a sample pack of tape-processed chords). The
limitation becomes useful information: the producer learns what the setup can and can't do, and decides whether to
accept the substitute, change direction, or add the missing piece.

**How it works.**

1. **Notice.** Agents plan from the catalog and the sample library (agentTeamAPI, Options), so a gap shows up when
   a plan needs a device, sound or kind of processing that has no entry, or only an off-limits one (WebCLAP plugins,
   Tone3000 amp models, soundfonts, which have no .sf2 files yet). The model's knowledge of the reference supplies
   what the style needs; the catalog says what's there.
2. **Say it once, briefly.** What's missing, the closest substitute and how close it gets, and what would add the
   real thing. Not repeated on every request: the gap goes on the **wishlist** (below), and is raised again only
   when it's what stands in the way.
3. **Suggest adding it.** Within this project, adding means the producer imports samples or a soundfont, or
   installs a plugin themselves; agents only suggest. A device added this way stays off limits to agents unless it
   comes with documentation they can use (STRATEGY.md, "Agents change devices"); a sample becomes usable once it's
   in the library with metadata.

**The wishlist.** The team keeps a running list of what it's missing, kept across sessions with the project. Each
entry: what's missing, which requests needed it, the substitute used meanwhile, and what would add it (a plugin, a
sample pack, a soundfont). Agents add to it and check it before naming a gap again; the producer can open it any
time, strike entries ("don't need tape"), or add one. An entry is crossed off when the missing piece arrives, and
the agents say what it changes ("tape plugin installed: I can redo the chords' wobble properly").

**After this project.** The agent fetches what it needs itself: finds and installs a plugin, downloads a CC0 sample
pack, generates the missing sound, and adds what it learned about it to the catalog. Out of scope here, to keep the
project small and its moving parts few. (A rigorous study would also want every participant to have the same
tools; this project is shaped like a study but isn't held to that.) The wishlist is then the agent's shopping list.

**For the study.** The wishlist is data on what producers wanted that the system couldn't give, and on
whether naming a limitation (rather than substituting silently) changes how much they trust the team.

**Open.** How confident the agent should be before calling something a gap (a style's "specific instrument" is
often a habit, not a requirement), and where the wishlist lives in the team view.
