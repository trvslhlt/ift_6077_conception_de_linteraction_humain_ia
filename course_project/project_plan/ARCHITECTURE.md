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

## Still open

These are for the detailed design, whatever the shape:

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
