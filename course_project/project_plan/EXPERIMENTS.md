# Experiments for the remaining openDAW questions

Experiments for the questions about openDAW left open by checks 1–10 ([OPENDAW.md](OPENDAW.md), "Checks"). Each
gives its hypotheses, a method that tells them apart, the decision it informs, and its cost. A–D run headless in
`poc/edit_bench`; E needs a real browser and a listener.

**Rule (2026-10-31):** an experiment that wouldn't change the design significantly is deferred indefinitely, until
the problem it's about shows up in use. Each deferred one names what would bring it back.

| | Question | Where | Cost | Informs | Status |
|---|---|---|---|---|---|
| A | Why one `modify()` costs 24+ ms whatever its size | headless | half a day | edit budgets; batching in the bus | Deferred |
| B | Why deleting an instrument layer costs 30–320 ms | headless | 2 hours, with A's tooling | the crossfade's last step | Deferred |
| C | Why check 2 occasionally misses a note inserted into a looping region | headless | 2 hours | the 200 ms lead; the lead-time check itself | Done: not loop-specific; rest deferred |
| D | Whether Convolver applies its impulse response at once | headless | 1 hour | when the bus may insert a Convolver | Done: yes |
| E | Real-browser listening and timing | real browser, a listener | 1 hour of yours, ~half a day to prepare | STRATEGY's timing numbers; equal-power ramps | Deferred |
| F | What the bus can hear: live readings, offline renders during playback, and whether the summaries catch real problems | headless | ~a day, plus the openDAW rebuild (~15 min, ~10 GB of Docker disk) | the Listening part of the TakeDoAPI | Done: renders work during playback |
| G | Where the utility falls short of Claude Code working live in openDAW, and why | real browser, the producer listening | ~3 hours; ~$4 of Opus | what the open path needs next (STRATEGY.md, "Keep the open path") | Done: model, then setup |

C, D and F run with `make experiment EXPERIMENT=C|D|F` (`src/Experiments.ts`, `src/Listening.ts`; results in `results/experiment-*.json`).

## Deferred, and what would bring each back

- **A.** Agents' edits will touch phrase-sized regions (timeline-first: a bar or a phrase at a time), far below
  the 4096-note region where a `modify()` costs 24+ ms, and the 200 ms lead absorbs it. Back if an operation in the
  library takes more than ~50 ms, or edits cause dropouts.
- **B.** The slow delete comes after the crossfade, when the old layer is already silent; the live POC's crossfade
  (change set 7) sounded smooth. Back if other timed changes stutter when a layer is deleted, or a click is heard
  then. Cheap workaround meanwhile: delete when no ramp is running.
- **C, the rest.** Misses at 50 ms or more happen about once in 400–800 inserts, only in the full test run, after
  the other checks have loaded the project. At the bus's 200 ms lead that is a rare dropped note, not a design
  question. Back if a producer notices an agent's note missing, or the miss rate in `make test` grows.
- **E.** The live POC already ran in a real browser with a person listening: a 200 ms lead, equal-power ramps,
  gradual changes, all heard as intended. Back before the study's timing numbers are reported, or if a producer
  hears clicks or dropouts.

## A. The fixed cost of a `modify()`

**Known.** One `modify()` changing note velocities cost 24 ms for 10 notes, 49 for 100, 71 for 1000, in a region
of 4096 notes (check 1); single value writes cost 1–2.5 ms. So the cost depends on the region's size, not on the
number of notes changed.

**Hypotheses.** Inside `modify()`, the transaction's updates go synchronously to every subscriber:
1. **UI observers:** the timeline's region painters and any open note editor redraw or re-scan the region's notes.
2. **Adapters:** the region's note collection adapter re-sorts or rebuilds its event list on each change.
3. **Engine sync:** the updates are serialized and sent to the audio worklet, which may resend the whole
   collection.
4. **Undo bookkeeping:** `optimizeUpdates` and the pending list scale with the region.

**Method.**
1. **Profile.** Through Playwright's CDP session, `Profiler.start` with a 100 µs sampling interval, run 50
   identical `modify()` calls (10 velocity changes in the 4096-note region), then `Profiler.stop`. Save the
   `.cpuprofile` to `results/` and sum self time by package (`lib-box`, `studio-adapters`, `studio-core`,
   `app-studio` UI, engine sync). One run tells which hypothesis carries the cost.
2. **Ablations**, each timing 50 calls, to confirm the profile:

   | Variant | Isolates |
   |---|---|
   | region scrolled out of view, then visible | 1, timeline painting |
   | note editor open on the region, then closed | 1, the editor |
   | engine stopped, then playing | 3, engine sync |
   | region of 10, 100, 1000, 4096 notes, same 10 changes | how it scales |
   | one primitive write on an unrelated box inside the same `modify()` | the per-call floor |
   | `modify(fn, false)` (no undo step) | 4, undo bookkeeping |

**Outcome.** The dominant cost, and whether the bus can avoid it (e.g. split large regions, keep editors closed,
batch differently), or must budget for it. If the cost is in openDAW's UI, the fix would be a patch, which the
rules in STRATEGY.md ("Changing openDAW") would need to allow.

## B. Deleting an instrument layer

**Known.** In check 7's crossfade, deleting layer 1 and its fade lanes cost 30–320 ms in `modify()`, with up to 4
audio blocks over budget in one run; deleting a whole audio unit cost ~20 ms.

**Hypotheses.** (1) The engine rebuilds the composite's processor graph and the main thread waits on, or floods,
the sync; (2) deleting the lanes and their regions triggers a timeline relayout; (3) the device panel (if shown)
rebuilds the composite's editor; (4) variance from garbage collection after the fade's many writes.

**Method.**
1. A's profiler around the delete, 10 repetitions, each on a fresh 2-layer composite after a 2-bar crossfade.
2. Ablations: delete the layer alone vs. with its lanes; with the device panel showing the composite vs. hidden;
   composites of 2 vs. 4 layers; right after the fade vs. 5 s later (garbage collection).
3. `PerfProbe` for audio blocks over budget in each case.

**Outcome.** Whether the cost is the main thread, the audio thread, or both, and the cheapest delete order (e.g.
lanes first, then the layer in a later `modify()`; or wait before deleting).

## C. The occasional missed loop note

**Known.** Check 2's loop case once heard 2 of 3 inserts at 300 ms after hearing all of them from 30 ms. Notes
crossing the loop's end are heard (check 10), which rules that out.

**Hypotheses.**
1. **Accumulation.** Every loop trial adds a note to the same 1-bar region and never removes it. By the 300 ms
   trials (the last lead tested) the bar holds ~27 sixteenths, each with Vaporisateur's 0.5 s release, so many
   voices overlap. A voice limit, or stealing, drops a note.
2. **Reporting.** The note plays but the note-state stream (`NoteStreamReceiver`, sampled per broadcast) misses a
   short note-on, e.g. when two notes overlap at the same moment.
3. **Phase.** Inserts whose local position lands just after the playhead's current loop position are scheduled
   for the next pass, and the listen window ends before it.

**Method.** 100 loop trials at a fixed 300 ms lead in each of three conditions, the rig soloed:

| Condition | Tests |
|---|---|
| as check 2: notes accumulate in one region (up to 100, all distinct pitches) | baseline miss rate |
| each trial's note deleted after its listen window; the output (`OutputTap`) also checked | 1; and 2, since with one note in the region the output shows whether it played |
| accumulate, with release set to 10 ms | 1 (overlap, not count) |

For each trial, log: the playhead's position in the loop at insert, the target's, whether the target is in the
next pass, `modify()` time, the remaining lead after it, whether the note stream reported it, the output peak, and
the number of notes in the region. Classify misses by phase (for 3).

**Outcome.** If 1: check 2 is fixed (clear notes between trials) and the 30–50 ms lead stands as measured; the bus
should know the instruments' voice limits. If 2: our note-heard measurement needs the output tap. If 3: the
check's listen window grows.

**Result (2026-10-31, headless).** No misses: 300 of 300 reported; in the "clear" condition all 100 also sounded
(output peak ≥ 0.024), so the note stream reports what plays. 42 trials landed in the loop's next pass; up to 100
notes in the region. `modify()` took 0.1–29 ms. All three hypotheses are ruled out. Across the 15 saved `make test`
runs, 2 of ~800 inserts at 50 ms or more were missed: one loop insert at 300 ms and one plain insert at 50 ms, so
the miss isn't loop-specific; it shows only after the other checks have run. Deferred (see above).

## D. Convolver's impulse response

**Known.** Inserting a Convolver with an impulse response changed the level within 3–5 ms (check 10), but a dry/wet
change would do the same before the response loads.

**Method.** Use an impulse response that is silent except for one click at 80 ms. Its only audible effect is a
distinct echo 80 ms after each sound. Play 30 ms notes on an eighth-note grid (one per 250 ms, 5 ms release) on a
soloed rig, insert the Convolver with that response, and find, through `OutputTap`, the first onset off the notes'
grid. Control: the same insert with no response assigned (no echo expected). Repeat with the response already
loaded (assigned 2 s earlier to a Convolver on another track) and not yet loaded (a new response each run).

**Outcome.** The real time until a response applies, loaded and not loaded, so the bus knows how far ahead to
insert a Convolver; and whether it passes the dry signal meanwhile (no gap).

**Result (2026-10-31, headless).** The response applies from the first note after the insert, whether or not it
was already loaded: the first echo came 291 ms after the insert (not loaded) and 283 ms (loaded), each 80 ms after
a note that started ~200 ms after the insert, the first note after it. So it applied within ~200 ms, possibly at
once; the note grid (one note per 250 ms) sets the resolution. The control without a response made no echo. The dry
signal never dropped (12 of 12 notes in each case). A Convolver can be inserted like any other effect. Not covered:
a library sample not yet imported in this session, which adds the import (check 9).

## E. Real-browser listening and timing

What headless numbers can't tell: clicks, the crossfade's dip by ear, and timing with a real audio device.

**Setup.** The debugging Chrome (`poc/edit_bench` README, "Live sessions"), a new scratch project, headphones, the
bench panel open. Record `AudioContext.baseLatency` and `outputLatency` with the results.

**Recordings.** Each step also records the engine's output to a WAV in the page (a `MediaRecorder` on the engine
node, as `OutputTap` taps it), so results can be listened to again and analysed later.

**Steps** (about an hour):
1. **Timing (checks 1 and 2).** Press "1. Edit rate" with 30 s per case and "2. Lead time". Listen for dropouts
   during the 1000-note case. Compare against the headless numbers (30–50 ms lead; overruns).
2. **Instrument changes (check 7).** Press "7. Devices". Listen, and note per step: a click when an instrument is
   swapped or wrapped into layers; the gap until the next note; any dip in the layer crossfade.
3. **Equal-power vs. linear crossfade.** A new step: the same layer crossfade twice, with linear ramps and with
   equal-power ramps (STRATEGY.md says equal-power should remove the -8 dB dip). Rate which is smoother, without
   being told which is which.
4. **Effect inserts.** Insert Autotune and Maximizer on a held note (35 ms and 2.7 ms gaps headless): audible?

**Outcome.** Real-browser figures to replace the "headless" marks in STRATEGY.md, and a decision on the ramps'
curve.

**To build first:** the in-page WAV recorder, the blind A/B order for step 3, and a "listening" mode of check 7
that pauses between steps so each can be heard on its own.

## F. What the bus can hear

**Why.** Agents can't hear: Claude and Jev take text and images, not audio. The bus would turn the sound into
short per-bar summaries per track and for the master: peak, loudness, energy in five bands, the share below what
laptop speakers (~150 Hz) and phones (~300 Hz) play, clipping, silence, and pairs of tracks crowding the same
band. Code rules on them wake a member (a part clips, goes silent, or becomes inaudible on laptops); members check
their own edits by comparing the bars before and after one landed. Whether models judge such summaries well is
tested without openDAW in `poc/listen_bench`. Design: STRATEGY.md, "What agents know" (the Listening part).

**Known.** openDAW computes the master's loudness, spectrum and peaks for its analysis cards
(`EngineAddresses.LOUDNESS`, `SPECTRUM`, `PEAKS`), and each channel's peaks for the mixer's meters
(`liveStreamReceiver.subscribeFloats`); no live spectrum per channel. `OfflineEngineRenderer` renders the mix or
single tracks over a section without touching playback (OPENDAW.md, "Listening is built in"). `OutputTap` already
taps the engine's output in `poc/edit_bench`, and `PerfProbe` counts audio blocks over budget.

**Questions.**
1. **Live readings.** Can the page subscribe to the master's loudness and spectrum and every channel's peaks
   during playback? At what rate, at what main-thread cost, and how far behind the audio?
2. **Offline renders during playback.** How long does one track over 8 bars take to render (at 96 BPM, 8 bars
   last 20 s), how does it scale with tracks and length, and does it cause audio blocks over budget? Does it run
   on its own thread or compete with the live engine?
3. **Do the summaries catch real problems?** In a test project: the live POC's bass at 49–82 Hz flagged as
   inaudible on laptops; a kick and a bass in the same band flagged as crowding; a filter closed on the keys showing
   as lost highs between the bars before and after; a clipping master; a muted part as silent.

**Outcome.** Whether per-track summaries can come from renders during playback, or only from live peaks plus the
master (and if so, what the Listening part can promise); the render's budget per bar, which sets how often a
member can check its edits.

**Result (2026-11-05, headless Chromium in Docker on the M-series laptop, 48 kHz, 120 BPM so 8 bars = 16 s;
`src/Listening.ts`, `make experiment EXPERIMENT=F`).** Per-track summaries can come from renders during playback.
1. **Live readings: yes, at 60 per second each, ~22 ms behind the output.** Master peaks (peak and RMS per side),
   loudness (5 values: momentary, short-term, integrated, ..., true peak), the 512-bin spectrum and every channel's
   peaks all arrive once per animation frame. Subscribing to all seven cost nothing measurable: no audio blocks over
   budget (max 0.36 ms of 2.67), 26 ms of handler time over 5 s. A channel's meter shows a part 13–29 ms (mean 22)
   after the output does. Limit: the spectrum's bins are 47 Hz wide, so 3 bins cover everything below 150 Hz; the
   live spectrum can't tell sub from low, which is where the laptop question lives.
2. **Offline renders: ~0.8 s for a track over 8 bars, without disturbing playback.** Totals (3 each): one track, 8
   bars 0.84 s (19× real time); four tracks, 8 bars 1.2 s; one track, 32 bars 2.6 s; master mix, 8 bars 1.05 s.
   About 0.35 s of each is fixed: copying the project and starting the renderer's worker. The render runs in its own
   worker. Over 12 renders, 2 audio blocks went over budget (one with a 115 ms main-thread task, likely the copy) and
   no output gaps; the 5 s baseline had 1. The renderer must get `project.copy()`, as openDAW's freeze does: given
   the live project it fails ("Already connected") because it attaches the project's meter receiver. With the copy,
   live meters are untouched (60 readings/s during a render, none silent). Mutes are honoured in stems.
3. **The summaries catch the planted problems: 5 of 6 cases.** Code computes level, peak, five bands and the share
   below 150 Hz from each stem (4096-point FFT); code rules flag. Bass at 49–82 Hz: 97% below 150 Hz, flagged. Kick
   and bass in the same band within 3 dB: flagged as crowding. Keys' filter from 6 kHz to 600 Hz: highs −23 dB, mids
   −20 dB, level −15 dB between before and after. Every part +12 dB: master peak +3.7 dB, flagged as clipping (and
   so was a +0.2 dB master in the crowding case). Keys muted: silent, flagged. The miss: the bass up an octave with
   its filter at 1 kHz still had 72% below 150 Hz (fundamentals 98–165 Hz) and stayed flagged; that is a fair
   reading of a borderline bass, so the threshold is a judgment call, and the before/after (97% → 72%, low mids
   +22 dB) is what a member checking its edit would use. The test kick (a synth note at 65 Hz) was flagged in
   every case, correctly for that sound.
   Analysis took ~300 ms of main-thread JS per case (four stems and the master, 8 bars): in a worker, it should be.

**What this means for the Listening part.** Live meters for instant facts (clipping, silence, levels, every
frame); renders for anything about bands or before/after, at ~1 s per 8 bars plus analysis in a worker. A member
checking its edit waits for the bars to play, then about a second. Renders are also the first thing to drop when
the laptop is busy (STRATEGY.md, "Agents don't assume every resource is there"): live meters are nearly free.

## G. The utility against Claude Code, working live (2026-11-07)

**Why.** The first live experiment (Claude Code in the studio tab over DevTools, `poc/edit_bench/live/eval.mjs`) felt
"magically flexible"; the utility, given the same kind of direction, didn't get there. Was the gap the model or the
setup around it?

**Method.** One direction on the same project (`01_good_base`: G major, 119 BPM, a 2-bar TR-808 loop and a Cubed
acid line, the loop on bars 1–4, playing): "Slowly, and without sudden large changes, evolve this into a lofi girl
beat", then the producer's follow-ups ("keep going", "lower the tempo"). Run by the utility alone (`ROSTER=utility`)
on Haiku 5.5, then on Opus 5.5, then by Claude Code (Opus 5.5, this repo's session) through `takedo/live/eval.mjs`
with the utility's own environment: the same script names, and the same bus (`apply`) for timed edits and ramps.
Logs in `takedo/sessions/`; Claude Code's run is in its own transcript.

**Results.**

| Run | What it did | Model calls, cost | What stopped it |
|---|---|---|---|
| Utility, Haiku (07:18) | Effects and one level ride; no notes, no new parts | ~5 per message, cents | Stopped after a first step to offer the next; "do all the steps!" got "I don't have a list of steps" (no chat history) |
| Utility, Opus, 8 rounds (07:52) | New keys, drums in three stages, bass reworked, master darkened, a melody track | 35 calls, 552k in / 29k out, ~$2.80 | Every message used all 8 rounds; the 7th says "call done now", so it stopped halfway; it re-read the project each message |
| Utility, Opus, 30 rounds, one conversation, cached (08:20) | The whole transformation in one reply (49 timed edits over ~16 bars), then vinyl hiss, a 4-bar phrase, an 8-bar progression, tempo 119 → 84 on request | 26 calls, ~$1.42 for 3 messages | Nothing; 4 cache misses (tools changed when tracks were added) were 40% of the cost |
| Utility, Sonnet 5.5, with notebook and source tools (16:19) | Reply 1: filters closing, crushers, darker delay, lazier hats with a ghost kick; "keep going": a Keys track (Am7 → Fmaj7 → G) fading in, reverbs; "lower the tempo": 119 → 85 in five steps, keys eased back | 12 calls, ~$0.17 for 3 messages, 12–15 s per reply | Nothing, but timid: a first pass where Opus did the whole transformation; it left the tempo to the producer until asked; it never used the notebook or the source tools. 2 of 20 edits reported failed: two fades on the same filter overlapped (a bus gap, now fixed) |
| Claude Code, live | A Tubular programmed as a Rhodes (DX7 values), a sine bass, drums in three stages, the acid tamed in three steps; then the original melody kept as a throughline and doubled, vinyl crackle and hiss, tape wow, a 4-bar drum phrase with a fill, tempo 119 → 82 with a switch to full-time drums; then a staged revert to the exact starting state | ~6 source lookups before the first edit; 3 edit calls for the first direction (one script for both new tracks, one effect, one plan of 20 timed steps); 30 timed steps for the revert | One engine crash: a filter resonance of 0 (below openDAW's minimum) made a Vaporisateur write NaN |

**Findings.**
1. **First the model, then the setup.** Haiku didn't plan a whole transformation; Opus did, once the setup stopped
   cutting it off (rounds, memory across messages). The remaining gap to Claude Code is the setup.
2. **Reading openDAW's source made the musical difference.** Every sound decision came from it: Tubular takes DX7
   panel values (so a Rhodes patch is possible), Vaporisateur's ranges and noise generator, Delay's and Tidal's step
   tables. The utility, without it, used a subtractive synth for everything and spent rounds probing the API.
3. **openDAW declares ranges but doesn't enforce them** (OPENDAW.md). One value outside a range crashed the engine
   for everyone; only the schema shows the range. Now guarded (STRATEGY.md, "Never crash the engine").
4. **Read the whole state first, write the plan once, time it from one playhead.** One call scheduling every stage
   kept the spacing exact; separate calls drift. The utility now does this (edits answer "scheduled" at once).
5. **A starting snapshot makes "put it back" possible.** Reading everything before the first edit let the revert
   restore every value to the decimal, staged over 17 bars. The utility keeps no such record.
6. **Stopped playback collapses a staged plan:** with the transport stopped, every step applied at once (correct,
   but the plan's shape is lost, and nobody said so).
7. **Parameterized scripts** (one drum generator, three stages; one synth step, three settings) kept stages
   consistent and cheap to write.

8. **Sonnet is fast and cheap but does less per message** (~$0.06 a direction, 12–15 s, against Opus's ~$0.50 and
   ~2 min): it needed "keep going" twice to reach what Opus did in one reply, and it didn't reach for the new tools.
   Whether the prompt can make it bolder, or the study wants Opus's depth, is open.

**Outcome.** What the utility needs next: a source/schema lookup (or the catalog extended with instrument fields,
ranges and step tables), the range guard (built), a snapshot taken before an agent's first edit, and a word to the
producer when a staged plan collapses because playback is stopped. Open: whether Opus's cost is acceptable for the
study, or how far Sonnet or Haiku get with the improved setup (not measured).
