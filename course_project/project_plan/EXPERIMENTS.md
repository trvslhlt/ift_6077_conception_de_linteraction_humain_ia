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

C and D run with `make experiment EXPERIMENT=C|D` (`src/Experiments.ts`; results in `results/experiment-*.json`).

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
