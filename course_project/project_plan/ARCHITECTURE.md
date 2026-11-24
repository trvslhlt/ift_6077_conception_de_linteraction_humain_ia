# TakeDo architecture: sketches

Three high-level shapes for TakeDo, to pick one before the detailed design. Sketch of 2026-11-05; B was chosen on
2026-11-06. The fixed
inputs are in [STRATEGY.md](STRATEGY.md) and [TAKEDO_API.md](TAKEDO_API.md):

- the agents run in a local backend process (Node for now), and openDAW stays in the page;
- agents only make requests; the producer's holds and gestures come first;
- claims are locks;
- there are three tiers (instant code, fast Jev, slow language model), and a message takes the slow path only when
  it needs to;
- the agents degrade gracefully when resources run short;
- the page's main thread is the scarce resource (EXPERIMENTS.md, F).

All three sketches share these parts:

| Part | Where | Does |
|---|---|---|
| openDAW | page | the project, engine, the producer's own editing |
| Hold patch | page | reports the producer's holds and gestures |
| Applier | page | applies plans with one `modify()` each; landing times; read-back; origin tagging; change events |
| Listening worker | page (Web Worker) | offline renders of `project.copy()` and their analysis, off the main thread |
| Team view | page (overlay) | chat, direction cards, member cards, controls |
| Model gateway | backend | every model call, with API keys, per-call logging and the budget; the only part that knows which provider and model answer |
| Session writer | backend | writes `log.jsonl`, `updates.bin` and the checkpoint to disk |

**The model is a setting, not part of the architecture** (2026-11-06). Members call the gateway by job (for
example `route`, `fill`, `plan`, `chat`), using one shared format for messages and tool calls. A config file maps
each job to a provider and model: Claude, a cheaper model like DeepSeek, or Jev for the fast tier. One small
adapter per provider translates the shared format to that provider's API. Switching a job's model is a config
change. Some things still vary from model to model:

- how well it calls tools;
- how it handles prompt caching;
- what it costs.

So llm_bench should be rerun on a model before it is used. Each `model` log line names the provider and model, so
sessions run with different models can be compared.

The channel between them is one local WebSocket carrying the JSON messages from TAKEDO_API.md. Locally a
round trip is ~1 ms, so it doesn't matter where along the path a check happens.

The sketches differ on two things: **where coordination lives** (refs, claims, the plan step, the team's messages)
and **what a team member is** at runtime.

---

## A. The bus in the page (the API draft as written)

```
 backend (Node)                                  page (openDAW studio)
 ┌───────────────────────────────┐   WebSocket   ┌──────────────────────────────────────────────┐
 │ member agents (one loop each) │ ◀────────────▶│ BUS: refs · claims · plan · schedule · apply │
 │ router (Jev) · Team Lead      │  requests,    │      state · changes · listening · controls  │
 │ model gateway · session writer│  queries,     │ team view          openDAW + hold patch      │
 └───────────────────────────────┘  events       └──────────────────────────────────────────────┘
```

The backend is agents and nothing else; everything that touches the project, including claims and every
operation's `plan`, runs in the page.

- **For:** it matches the draft API. There's one authority over project state and locks, right next to openDAW,
  so a claim and the hold check happen in the same place.
- **Against:**
  - Planning (computing notes and automation points), snapshots, the claim table and team messages all compete
    with the audio UI on the main thread, which F says is the thing to protect.
  - Agents can only be tested with a browser running.
  - The session record still has to be streamed out to the backend.

## B. The page as an adapter, coordination in the backend (chosen 2026-11-06)

```
 backend (Node)                                                page (openDAW studio)
 ┌──────────────────────────────────────────────────┐  WS   ┌─────────────────────────────────────────┐
 │ TEAM RUNTIME                                     │       │ ADAPTER                                 │
 │  router (Jev) ─▶ members (actors, one inbox each)│       │  applier: schedule · apply · read-back  │
 │  Team Lead      │  prepare options for controls  │◀─────▶│  holds & gestures (hold patch)          │
 │                 ▼                                │ plans │  state reader: snapshot · describe      │
 │  coordinator: refs · claims (locks) · plan()     │ ─────▶│  change events (with origin)            │
 │               team messages · controls · cues    │       │  meters → readings                      │
 │  governor: budget · tier per call · load         │◀───── │  listening worker (renders, analysis)   │
 │  model gateway · session writer                  │ events│  team view (client of the backend)      │
 └──────────────────────────────────────────────────┘       └─────────────────────────────────────────┘
```

The page does only what needs openDAW's objects: read, apply, report. Everything else lives in the backend.

- **The coordinator** owns the ref map's agent side, the claim table, `plan()` for each operation, team messages,
  controls and cues. Node is single-threaded, so granting claims one at a time is free. A request reaches the
  page only as a finished plan from an agent that holds the claim.
- **The page keeps the producer's priority.** An arriving plan still passes the hold check and the gesture queue
  in the applier, since holds live there. So the page can reply `dropped` or `queued` as before; claims never
  reach the page.
- **Members are actors.** Each has an inbox fed by subscriptions: its directions, `@` messages, moves on its
  controls, changes on its claimed refs, and transport. Each wake, the member picks the cheapest tier that fits:
  - a prepared option for a control move is instant;
  - one clear operation goes to Jev;
  - anything else gets a language-model call with the operations and queries as tools.

  While playback runs and nothing is asked of it, a member prepares options a phrase or two ahead.
- **The governor is where graceful degradation lives.** Every model call and render asks it first, and it answers
  `full`, `reduced` or `no`. It answers from the spend rate, how many calls are in flight, and page load (overruns
  and long tasks, reported by the adapter). Members get `reduced` as:
  - Jev instead of a language model;
  - live meters instead of a render;
  - fewer prepared options.

  The member card says when it's working from less.
- **For:**
  - The page does the least work.
  - The team runtime runs and tests without a browser, against a fake adapter that replays a recorded session.
  - The session record and model log are written where the disk is.
  - Claims sit beside the agents they lock.
- **Against:**
  - `plan()` needs state, so the coordinator reads snapshots over the socket. Reads are cheap locally, but a plan
    can go stale between the read and the landing. The applier rejects a plan whose `seq` is behind a change to
    its targets (`failed` with `stale`), and the coordinator re-plans once (TAKEDO_API.md, "Operations").
  - The API's "bus" becomes two halves, and the draft's overview needs redrawing.

## C. One planner, many faces

```
 backend (Node)                                       page
 ┌────────────────────────────────────────────┐  WS   ┌───────────────────────────────┐
 │  router (Jev) ─▶ fast path: one op, filled │◀────▶ │ adapter (as in B)             │
 │            └──▶ PLANNER: one model call per│       │ team view: members as cards,  │
 │                event, plans for all members│       │ voices written by the planner │
 │ queue (no claims needed) · governor · log  │       └───────────────────────────────┘
 └────────────────────────────────────────────┘
```

Members are prompts and cards, not running agents. A single planner loop takes each event, decides which members
act, and writes their requests and their lines in the chat in one call. The fast path is as in B.

- **For:**
  - It's the fewest moving parts and the cheapest.
  - Conflicts can't happen, since one loop writes every request, so no locks are needed.
  - It's easy to log and replay.
  - For an interaction study the producer sees the same team.
- **Against:**
  - Nothing runs in parallel: a long plan delays the next message (the slow tier is 2–5 s or more).
  - Members can't prepare ahead independently.
  - The decision to use claims as locks, and members working things out among themselves (TAKEDO_API.md,
    Team), become moot. That's fine for the study, but it changes what "team" means under the hood.

---

## Recommendation

B, chosen 2026-11-06; TAKEDO_API.md's overview now follows it. It is A with the work moved off the page's main thread, and the backend was already the decided home for the
agents. Two things to keep from the others:

- **From A:** the page keeps the last word on holds and gestures, so the producer's priority never depends on the
  socket.
- **From C:** C is what B looks like with every member down to `reduced`. If the governor has to, it can run the
  members one at a time through a single queue, so B degrades toward C rather than failing.

## One message through B

"@mix_engineer the kick is too loud", during playback:

1. The team view sends the chat message over the socket, and it is logged.
2. The router (Jev, ~0.1 s) finds one member clearly needed and fills its judgments: the target is `t1`, the
   amount small, the timing soon.
3. The mix engineer's job is one operation, so Jev fills `ramp t1.mix.volume −3 dB over 1 beat` in the same
   request (~0.2 s in total).
4. The coordinator grants the claim on `t1.mix.volume`, then plans the ramp (two automation points) and sends it
   with the `seq` it was planned at.
5. The applier checks holds and gestures, lands the ramp at least 200 ms ahead, reads it back and replies
   `applied`. The change event goes back to the backend.
6. The claim is released, the card shows "kick −3 dB", and every step is in the log.

Total: ~0.3 s plus the landing margin, without a language-model call.

## The team's structure (decided 2026-11-22)

Until now one agent, the utility, did everything (understood the message, planned, edited, replied), and "Team Lead"
named three unrelated things: a one-off call that split directions (`lead()`, the `ROSTER=team` path), the overview
writer, and how the utility appears in the UI. The scenario runs showed what one agent doing everything costs: it
can't be steered while it works (a control move waits behind a 40 s turn); its plans land in the order it finishes
writing them, not in the order of their bars; and the plan exists only in its context and notebook, where code can't
check or show it, and a fast path can't act on it.

The structure from here on. The names are working names; "Team Lead" may stay as what the producer sees.

| Role | What | Owns |
|---|---|---|
| **Board** | code, in the backend | the shared state as data: directions, their pieces and who has them, staged steps with bars, claims, facts, controls, and the status of each. Agents read and write it through tools; code enforces it (order, per-bar limits, claims). |
| **Captain** | one long-lived agent | what a message means for the work: a new direction, a change to one, a one-off edit, a question. Writes the plan to the board, hands out pieces, watches status. Makes no edits itself, so it can always respond. |
| **Workers** | the utility and the specialists | turn a piece into edits. The utility catches whatever no specialist covers. Pieces can run in parallel. |
| **Voice** | the captain's reply for now | turns the team's events into short lines for the producer. The producer's words go to the captain as they are, with no model rewriting them first (it would add delay mid-performance and lose nuance). |

Issues taken on at the same time, because the board carries them:

1. **The team hears the producer's DAW changes.** The page sends every change, but until now it was only logged. The
   board keeps the change stream; the captain gets "changed since you last looked" with each turn, so it doesn't
   undo the producer's hand, can take a demonstration, and doesn't plan from a project that changed under it.
2. **One scheduler.** When an edit lands was worked out twice, predicted in the backend (`barsFromAnchor`) and
   decided in the page (`Adapter.#landing`); most timing bugs were the two disagreeing. Staged steps are data, the
   page's scheduler (which has the clock) is the only one that times them, and the backend reads where they sit.
3. **Waiting steps outlive a restart.** They lived only in the page's memory, so a backend restart had to drop them.
   The board keeps them with the project and re-sends what hasn't landed.
4. **Every step belongs to a direction**, so cancelling a direction, steering it with a control and "what's left of
   it" have something to act on.
5. **One team path.** The `ROSTER=team` path (one-off splitter, Jev routing, specialists handing leftovers on)
   predates the Agent SDK, and the smoke test runs on it while `make scenario` runs the utility. It is retired as the
   captain arrives; the specialists' fixed operations stay as tools, and the smoke test moves to the real setup.

Order, one piece at a time (each judged by `make scenario`): (1) the board: directions and staged steps as data, each
step tied to its direction, timed by one scheduler, kept with the project; (2) the captain split from the utility,
with the DAW changes since its last turn; (3) the old team path retired and the specialists brought back as workers,
one at a time. The coordinator, which today does all of the backend's work, shrinks as the board takes its state.

Built (2026-11-22), step 1's first piece: `takedo/backend/src/board.ts`. Directions (one per message or control move
for now) and their timed steps, as data (an operation and its input, or a script). A timed edit is staged, not sent;
when the turn ends the direction's steps go out together in bar order, from the message's anchor moved past the
playhead by whole loop passes. The backend's landing predictions are gone (only the page times edits), and the
per-bar limit is a count of a plan's steps, knowledge entries included. Lofi scenario: every check green, 0 steps out
of bar order (1–5 pairs in the runs before). Trade: a plan's timed steps now wait for the reply (edits for now still
land at once).

Built (2026-11-22), step 1's second piece: waiting steps outlive a backend restart. The board is saved beside the
notebook (`<project>.board.json`), each sent step linked to its request. The page no longer drops waiting edits when
it loses the backend; it keeps statuses and changes made meanwhile and delivers them on reconnect, then says which
requests are still waiting, and the board reconciles: still coming, landed, or lost (sent but gone from the page, or
staged when the turn was cut off and never sent). The resumed agent is told which are still coming, so it doesn't plan
them again. Nothing is re-sent: the page kept them. `make scenario SCENARIO=restart-waiting` (killed after the reply):
4 of 4 waiting edits landed, and "keep going" left them alone; `SCENARIO=restart` (killed mid-turn): all checks green.
Step 1 left: nothing; next is step 2, the captain split from the utility.

Built (2026-11-22), step 2's first piece (issue 1): the team hears the producer's DAW changes. The coordinator keeps the
producer's value changes (the page already reported them, tagged by actor); the utility gets them, folded per
parameter, as `producer_changed` with each message and as "Meanwhile the producer changed by hand" in tool results
mid-turn, with the rule to build on them rather than undo them. `make scenario SCENARIO=hand` (the producer pulls the
drums to −20 dB, then asks for more relaxed drums): the level stayed at −20 with no agent edits on it, and the reply
said so, twice. Not yet: structural changes (tracks, regions, notes) aren't reported as changes; a waiting step on a
parameter the producer then moves still lands (no cancel yet).

Decided (2026-11-22, the producer): every agent on Haiku 5.5 for this stage of development (predictable and cheap
over fast), worker sessions fresh per piece so jobs run in parallel, and waiting steps can be cancelled. Haiku
baseline, lofi scenario: every check green, $0.03 for the utility (Sonnet: $0.23), 78 s to the first reply (Sonnet:
~30 s). One judgment slip: on "keep going" it took the landed tempo steps for one jump and asked instead of going on.

Built (2026-11-22): cancelling. The page takes back a request still waiting for its bar (BackendToPage `cancel`;
status dropped, reason cancelled, not a failure); the board cancels steps by id (a staged step at once, a sent one on
the page). The agent sees the steps not landed yet with each message (`coming_steps`, short ids, by the message
they're for) and has a `cancel` tool. `make scenario SCENARIO=cancel` (the producer changes their mind about the
tempo while the lofi plan waits): the 7 waiting tempo steps were cancelled, none landed, the rest of the plan landed.

Built (2026-11-22), step 2's second piece: the captain split from the utility (`takedo/backend/src/captain.ts`).
- **Captain**: the Team Lead the producer talks with, one long-lived Haiku session per project (resumed after a
  restart; the crash recovery moved here from the utility). It never edits. Tools: `assign` (a self-contained piece
  to a fresh worker), `cancel`, `offer_control`/`remove_control`, `look`, notebook, `reply`. Each turn is a
  producer_message, control_moved, job_finished/job_failed/job_failed_later, or restarted, with the project summary,
  producer_changed, coming_steps and jobs_running. Reply is required for the producer's turns and optional for the
  team's own news. Control moves and job reports are coalesced into one turn when several arrive while it's busy.
- **Workers**: the utility in job mode (`Utility.job`), a fresh SDK session per piece, run in parallel, never
  resumed. Its prompt is the utility's with the first paragraph, the reply line and the timing anchor changed, and
  without controls or cancel. Its timed steps stay staged on the board under the captain's direction; when the
  direction's last running job is done, all its steps go out together from one anchor (`Utility.send`), so pieces
  planned at different speeds still land in their bars' order (sending each worker's steps as it finished put a
  slow worker's bar 2 after a fast one's bar 4: 331 pairs out of order in one run).
- **Board**: also records jobs; a restart marks running jobs lost and the captain gets a `restarted` turn to hand
  them out again. The captain's `cancel` takes job ids too: a job still planning is stopped (what it stages after is
  refused, and its tool calls are refused), and the steps it already staged are cancelled.
- The `ROSTER=team` path keeps the one long-lived utility session until step 3 retires it (the smoke test runs it).
- `make scenario` waits while the Team Lead's card says jobs are running (they plan after the captain replies), and
  its settle limit is 300 s. The report adds up agent cost per SDK session.
- Battery on 2026-11-23, all on Haiku 5.5 ($0.06–0.18 per scenario):
  - The controls run offers a dial, and each move gets a reply and edits.
  - The cancel run stopped the tempo job 6 s into its planning.
  - The restart runs handed the cut-off jobs out again, and every edit landed.
  - The hand run kept the producer's level.
  - Engine "stalls" (playhead at 1–8% of the clock) in four of six runs. I first put them down to another course
    project's container using 2–9 cores; that was wrong (see "The stalls' cause" below).
- Rerun on a quiet host (2026-11-23), and two fixes:
  - **Corrections join their plan.** Told "keep the tempo", the captain cancelled the tempo job, then gave the
    master half of it to a new direction. That gave two plans sent 50 s apart from different anchors: 36 pairs out
    of order. Now a piece assigned in the same turn as a running job's cancel joins that job's plan (its direction
    and anchor). `assign` also takes `with: <job id>` to join a plan explicitly. Relying on the prompt alone didn't
    work: the captain ignored a prompt rule asking it to use `with`.
  - **Per-bar refusals name bars with room.** The captain gave tempo, bass and master a step on every bar 1–16, so the
    drum worker was refused on every bar. It staged no-op "probe" scripts to find room, and the first stage of the
    drums never happened. A refusal now lists the nearest bars with room. The worker prompt says a steady glide is
    one ramp, not a step per bar, and never to stage a placeholder. The next hand run had no refusals and no probes.
  - Still open:
    - Up to 5 edits landed in one bar (the limit is per plan; immediate edits and other plans aren't counted).
    - In one controls run, the session log lost lines (4 cut mid-line, nothing after 4.5 min while the backend kept
      replying), so its slow second dial reply (240 s) couldn't be traced.
- **The ROSTER=team path is retired (2026-11-23).** Gone: Jev's fast-path routing, the Team Lead's split (`lead`),
  `handOff`, members acting on their own, and the `ROSTER`/`KNOWLEDGE_ROUTE` settings. Every message goes to the
  captain. The members' fixed operations stay as the workers' tools. The smoke test runs on the captain: one message
  end to end, and the page's guarantees with edits sent straight to it. Then the utility's
  session mode went too (utility.ts 866 → 630 lines): each instance is a worker for one piece.
- **Each part goes out when its worker finishes (2026-11-23, the producer's choice).** Waiting for a direction's
  slowest worker held a whole plan back: in a manual session the drum worker took 113 s, so nothing landed until
  122 s, while the reply said "over the next 16 bars". Now each job's steps go out as it finishes, from the
  direction's anchor moved past the playhead by whole loop passes, so a late part keeps its own order and spacing;
  parts aren't in lockstep. The report checks order within a part. First runs: first edit at 21–29 s (was ~120 s),
  parts sent at 28/51/55/150 s and 52/52/109 s, 0 of a part's steps out of order, at most 3 edits in one bar.
  Where the time goes now: the drum worker wrote 25.7k tokens of notes (7 stages, each a whole pattern) over 23 round
  trips. Next speed lever: generators in code (the model picks style and parameters, code writes the notes), then
  knowledge entries, then Jev.
- **The stalls' cause (2026-11-23): a tempo near 0, written by a worker's script.** The runner now samples, every 2 s,
  the playhead, the audio clock, the engine's CPU load and main-thread lag (`run.samples`). In a stalled hand run the
  audio clock ran at 1.0 s/s, the main thread never lagged over 0.1 s and the CPU load was 0, but the playhead moved
  5 pulses/s: a tempo of about 0.3 BPM. The tempo worker had written tempo automation with a raw adapter, guessing
  values were normalized (`(bpm - 60) / 180`); openDAW's tempo events are plain BPM (`TempoRange`, 30 to 1000), and only
  its scripting API clamps them. The page's guard checked declared field ranges, and a tempo event's value has none.
  Fix: after every script, inside its edit, the page checks the project tempo and every tempo event against
  `TempoRange`; outside it, the script throws, openDAW rolls it all back, and the worker reads "tempo events are in BPM".
  `make test` sends the exact script from that run and checks it's refused and the playhead keeps its speed.
- **A second kind of stall, still unexplained (2026-11-23).**
  - What it looks like: the playhead stops completely (0 pulses/s), often 10–20 s into a run, sometimes before any
    agent edit has landed. The audio clock runs at 1.0 s/s, the main thread isn't lagging, and there are no page
    errors and no engine-crash event.
  - Ruled out:
    - The engine alone: two runs with no agents (`scenarios/idle.json`) played at full speed.
    - The sampler's own animation-frame loop: four runs with `COUNT_FRAMES=0` were clean.
  - When it happened: in clusters (04:29–06:03 UTC, 15:50, 18:03–18:26), then 14 clean runs in a row. That points
    to something about the host at those times, not a fixed TakeDo action.
  - Next: the next stall's samples say whether animation frames stopped (openDAW reads the engine's position only on
    them), whether the engine's own position froze, and whether it reports loading incomplete.
  - A real browser (the producer's manual test, 2026-11-23, about 3 minutes with the lofi and cancel messages) didn't
    freeze, and the README already recorded one headless freeze in the smoke test on 2026-11-07, "not seen in a real
    browser". Treated as headless-only for now; the smoke test fails cleanly on it instead of hanging.
  - Again on 2026-11-24 03:08 UTC (lofi, per-kind prompts): the engine's own position froze at 4.2.3 of a 4-bar loop
    about 85 s in, audio clock running, frames at 120 per 2 s, no lag, no page errors; no edit had landed in the 10 s
    before (a tempo script landed 2 s after, on the frozen position). Tempo automation was on (a glide over bars
    1-16 inside the 4-bar loop). The rerun was clean. If it recurs, check whether a tempo glide inside a loop is the
    common factor.
  - Seen on the way: openDAW's `AnimationFrame` loop skips clearing its queue when a callback throws, so one throw
    would freeze every later callback (the engine-position read among them) for good. No run threw, so it isn't this
    stall.
- **A part's notes change in stages written by code (2026-11-23).** A worker's `evolve_notes` names a notes region, a
  target (a knowledge pattern, tiled to the region's loop, or notes written once) and the pacing (stages, first bar,
  bars between). `generate.ts` (`morphNotes`) works out each stage: notes both share glide (timing, length, velocity),
  new ones come in loudest first, old ones go quietest first, the last stage is the target. Each stage is one script,
  `kb.replaceNotes`, rewriting the region's notes in place (a looping region never reaches a new region at later bars;
  a mirrored region changes with it). Before it, workers rewrote regions by hand and got openDAW's API wrong (7 of 53
  edits failed in one lofi run: the region adapter passed as `createNoteEvent`'s owner). First lofi run with it: both
  parts' grooves went through it (4 and 8 stages, all applied), 1 of 49 edits failed, the slowest worker took 63–66 s
  and 13–14k tokens out (was 80–89 s, 18–21k). One bar took 4 edits from two plans: the per-bar limit is per plan.
- **The per-bar limit is gone (2026-11-23).** It began as a fix for one run (a tempo step and three effects on bar 12)
  and grew into a gate the producer never decided: it refused edits openDAW applies fine, workers spent turns finding
  bars with room, and being per plan it never guaranteed spacing. A ramp, `evolve_notes`'s stages and the prompt's
  "a few bars apart" now carry the spacing, and the report counts the busiest bar instead of failing on it. Lofi
  without it: 91 of 91 edits applied, no refusals, at most 5 in one bar, all other checks green.
- **Where workers' time went, and framed pieces (2026-11-23).** From the workers' transcripts (one lofi run): about
  85% of their output tokens were thinking; tool calls, the code they wrote and the time tools took were a small share,
  and the knowledge base was read once by seven workers. Each started with ~27k tokens of context: ~16k of tool
  definitions, ~5k the whole knowledge index, ~3k a system prompt written for the old do-everything utility, and the
  task as one free-text paragraph mixing a pattern, a sound and an effect. Two changes so far: workers at low effort
  (median 41 s to 31 s), then pieces framed as fields: kind (drums, notes, sound, effects, mix, tempo, arrange; one
  kind per piece), tracks, goal (the end state, as a listener would check it), from_bar/to_bar, steps, keep. Lofi with
  framing: per worker median 31 s to 19 s, slowest 46 s to 36 s, output tokens median 6.3k to 3.5k; 81 of 81 edits
  applied, all checks green. The kinds are what Jev will classify, to pick each worker's prompt and context.
  Then trimmed to the piece: the dozen knowledge entries that match it (the knowledge tool searches for the rest),
  effect settings only on its tracks, the effects that can be added and add/remove_effect only for effects and sound
  pieces, evolve_notes only for drums, notes and arrange; learn and forget gone. Not a gate: run and look reach
  anything. Lofi: first-turn context 27k to 12-15k tokens, per worker median 19 s to 15 s, workers' cost $0.08 to
  $0.04, all checks green. Busiest bar: 7 edits (workers made 135 edits, up from 81); watch it in prompt tuning.
  Then a prompt written for a worker (9.6k characters, from the old utility's 12.6k patched by string replacement):
  the piece's fields and what each means, an order of work (read, check knowledge, stage, report), steps as the most
  stages a piece takes and a glide as one ramp, and a tempo-automation recipe (workers had searched openDAW's source
  for it every run, and one wrote a class that isn't in scope). Lofi, first run without the recipe: 69 edits (was
  135), median 13 s; with it: 36 of 36 applied, per worker median 10 s, slowest 26 s, workers $0.03, all checks green.
  Regression after it: hand, cancel, controls and restart scenarios and the smoke test all green. One change in
  behaviour: a tempo glide is now automation written at once, so "keep the tempo where it is" is a revision, not a
  cancel (the cancel run: the Team Lead had a worker remove the glide's end point; tempo stayed at 119). Caveat: mid-
  glide, removing the end point would jump back to the start tempo; holding "where it is now" needs a point at the
  current tempo. Not seen yet; watch for it.
  Then per-kind prompt sections: lines only one kind needs (the tempo recipe, pitch rules, evolve_notes, track and
  instrument recipes, the parameter-object rule) moved from the shared prompt to its kind's; shared part 10.2k to 6.8k
  characters plus 0.4-1.5k for the kind. Hand green; lofi twice: median 1.9k and 2.1k output tokens per worker (was
  2.5k), times 9 s and 20 s (time varies run to run; tokens are the steadier measure). The first lofi run stalled
  (below).

- **Each opening of a project starts fresh (2026-11-24).** A producer's session reopened 01_good_base from its file
  and the Team Lead resumed the last session's conversation, notebook and board (kept per project name): its plans
  said the drums and bass were done and the tempo was to stay, so it handed out only keys and master pieces, on a
  project that had none of that work. Now the page sends an id for each opening of a project (again on reconnect); a
  new one moves the old notebook, board and agent state to sessions/notebooks/archive/ and starts empty, while a
  reconnect or a backend restart carries on (restart scenario: one conversation across the restart). Carrying
  something over becomes an explicit feature later (project preferences the producer chooses to keep).

- **Work that can be heard inside the loop (2026-11-24).** In the same session the project looped bars 1-4 and a new
  keys part went to bars 4-17 (one chord a pass), and tempo automation for bars 2-18 replayed each pass. Now the Team
  Lead knows only the loop's bars are heard (parts change in place, pass by pass; new parts inside the loop) and may
  change anything, the loop included, without asking (the producer's call); workers write inside the loop, stage
  changes on later passes, and may change the loop (loopArea) and say so; under a loop, tempo steps per pass
  (api.setBpm, automation off), since automation would jump back at each loop start. The report flags new regions
  mostly outside the loop. Lofi: drums, bass, tempo (119 to 72 in steps) and master all reached, all checks green;
  cancel: "keep the tempo" cancels the waiting steps again (tempo stays 119). Busiest bar 9 edits in lofi (tempo
  steps share bars with drum stages); watch it.

- **A fuller loop, and the Team Lead's own mistakes (2026-11-24).** The producer's next session sounded "mostly empty":
  the Team Lead put a chord bed on the bass track, and when that worker refused, cancelled the steps waiting on that
  track, which were the bass's own (it got 1 of 8 stages); every other piece thinned and softened (drums 17 to 12
  notes); the chords started at bar 8 of the loop, fading in from -36 dB; and the dial started at 0 ("clean") while
  everything headed to lofi. Fixes: coming_steps say whose each step is, and a piece is cancelled by its own; a new
  part gets a new track (tracks ["new"], the worker makes it as it writes the part); a style direction adds what
  the style needs across the whole loop, not only thinning; a dial starts where the direction takes the project. And
  on the page, a ref naming a track by name ("Chord Bed.mix.volume") resolves when the edit lands (a new part's
  fade-in had failed for want of a ref, leaving it at -60 dB). Controls and lofi, twice each: new chord tracks heard
  from bar 1 (-9 to -14 dB), drums 24-26 notes, dial at 0.9, all checks green.

- **Drums that faded out (2026-11-24).** The producer's next session went "much better" (lofi then drum and bass, every
  edit landed), but in drum and bass a worker wrote evolve_notes' target velocities as 0..1 where the tool takes the
  snapshot's 0..127: all 44 drum hits came out at 0.002-0.007 and the drums faded out stage by stage. A target
  velocity at most 1 is now read as 0..1 (1 of 127 is silent anyway); the report fails a part whose notes end up
  near-silent; scenarios/dnb.json replays that session (lush lofi, then drum and bass): drums 43 notes at median
  velocity 70, tempo 174, all checks green.

## Still open

These are for the detailed design, whatever the shape:

- **Takes: create rather than mutate, held until a problem calls for it** (2026-11-23). For content (notes, patterns,
  new sounds), a worker would write a new region or track beside the old one and switch at a bar (mute/unmute or a
  crossfade), keeping the old take. Settings (effect parameters, mix, tempo, master) stay mutations.
  - Gains: each job owns what it creates, so writers don't collide; a switch is one small edit at one bar; cancel or
    undo is switching back; the producer's hand edits are never touched; the session leaves takes to pick from.
  - Costs: a gradual morph becomes a sequence of takes or a crossfade, which sounds different; new instruments cost
    CPU (muted ones may too); the project fills with tracks and regions that need clear names.
  - Why held: the failures seen so far are scheduling, ordering and rejected values, not writers colliding on content,
    so it doesn't fix a pressing problem. Take it up if collisions, messy cancels, or producers wanting earlier
    versions show up. First piece then: note rewrites as a take on the same track, judged on the lofi, cancel and hand
    scenarios against current runs.
- **How much members prepare ahead follows how much the producer plans** (2026-11-06). As with vibe coding, the
  more the producer plans, the better the result. For a planned performance, the prep conversation gives members
  what to prepare: the sections, the cues, and the range each control should cover. For an exploration, members
  prepare little and work on demand, accepting the slow tier. So members don't have to guess what the producer
  will ask next, and the hit-rate test is dropped. What's left is to watch, in use, how much planning producers
  actually do and whether on-demand is fast enough for exploring.
- Macros moved by both the producer and the member: deferred until TakeDo is in use. Known issues: a producer
  move turns the member's automation lane off until stop, and the hand-off isn't defined.
- How a member's inbox is filtered, so a busy change stream doesn't wake everyone.
- The governor's thresholds: which signals and limits, and how they're set.

- 2026-11-24, the transport is the producer's. Agents never play, stop, record or move the playhead, even when asked in
  chat: the Team Lead says what to press instead. Scripts and looks get the project with those calls refused
  (`withoutTransport` in page/Scripting.ts; looks too, since the transport isn't a project edit openDAW would refuse).
  A script whose new loop leaves out the playhead, while playing, is rolled back (`#loopProblem` in page/Adapter.ts),
  since the playhead would jump at the next wrap. Smoke checks all three; the loop itself stays the agents' to change.

- 2026-11-24, a fast path for one mix control. The Team Lead's `adjust` tool sets or ramps a track's volume, pan or
  mute (or the master's volume) itself, with no worker, through the same performStep as fixed operations (claims, held
  faders, activity). Only those refs (Captain.may). scenarios/small.json: first edit 0.9 to 3.5 s after the message
  (was 8 to 23 s through a worker), no worker sessions. Anything more is still a piece. A classifier ahead of the Team
  Lead (Jev) would save its ~1 to 3 s decision on these too; not needed yet.

- 2026-11-24, takes: dial moves recall instead of rebuilding (backend/src/takes.ts). A take is a full snapshot kept
  under a dial's position: the project before its direction when the dial is first offered (at `before`, which the
  Team Lead gives), and the direction's landed work when the dial next moves with nothing coming or running (at the
  position it had). The Team Lead sees them (takes) and, for a move to within ~0.1 of one, calls recall_take: one
  script (notes, tempo, region mutes, effects switched on or off) and the page's set for values, on the next bar line.
  Parts and effects added since are muted or switched off, never deleted, so a later take can bring them back; the
  loop is left alone (a recalled loop could leave out the playhead, and the guard would roll the whole recall back).
  scenarios/takes.json: both moves recalled, 2 edits each, sent 1.2 and 2.5 s after the move (the session's move back
  was ~32 edits over 47 s of workers). Takes live per opening, archived with the notebook.

- 2026-11-24, a plan's bars are bars of playing after its message. The producer's session (lush lofi) had a tempo plan
  land 108 → 80 then 119, 113, and the bass's stages 3–8 before 1–2: the workers timed steps in the 4-bar loop's own
  bars (bar 1: its next wrap), then an arrange piece widened the loop to 16 and "the next wrap" came after the rest.
  Now at_bar counts like the Team Lead's from_bar/to_bar (1: the next bar line after the message), the page waits that
  many bars of playing (anchored `when` in Adapter #landing), and commitAnchor moves a late plan by whole bars;
  planSlide went. Also: a step back of the playhead counts as the loop's wrap only from its last bar to its first; a
  headless run's engine jittered as the loop was widened, counted ~13 bars, and a whole tempo plan fired at once.
  Smoke: a plan's steps land in order a bar apart while the loop is widened under them.

- 2026-11-24, the loop is the Team Lead's to set, first. In the producer's session an arrange piece widened the loop
  4 → 16 bars while the other workers planned for 4: the keys came out a 4-bar part, then stretched without repeating,
  silent in bars 5–16 of each pass. The Team Lead now calls set_loop (a script as its own edit) before assigning
  pieces, so every worker sees the loop it will play in; workers leave the loop alone. The report adds "new parts
  silent for part of each pass" (where a new track's notes sound, repeats and lengths counted), and its order check no
  longer unrolls anchored bars (they count bars of playing now). scenarios/dnb.json: set_loop 1–16 before the pieces,
  58/58 applied, the new chords heard through the loop, every part's steps in order.

- 2026-11-24, recall glides. The producer heard a dial moved to an end change the track at once (a take recalled on one
  bar line) where a move between was smooth (a rebuild). Recall now glides over RecallBars (4): notes in morphNotes
  stages and the tempo a step a bar (one script a bar), values ramped across the span, parts leaving faded out and
  muted a bar after it, parts coming back unmuted at silence then faded in, effects on at the start and off at the end.
  The report's order check groups the Team Lead's own edits (no job) by their anchor. Known: takes are whole-project,
  so recalling one undoes later unrelated work; per-activity ownership is the next step (dials and rollback both).
