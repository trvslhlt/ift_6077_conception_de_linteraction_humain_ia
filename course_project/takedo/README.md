# TakeDo

The integrated prototype: AI team members that turn a producer's directions into openDAW edits during playback.
Architecture B of [`../project_plan/ARCHITECTURE.md`](../project_plan/ARCHITECTURE.md): the page is an adapter, and
coordination lives in a backend process. The contracts between them are the TakeDoAPI
([`../project_plan/TAKEDO_API.md`](../project_plan/TAKEDO_API.md)).

The POCs in `../poc/` are frozen references and benches. Code is copied from them, never imported.

## Usage

```sh
make up       # build and start the studio and the backend (page/, shared/, backend/src/ live); the utility alone
make up ROSTER=team  # the same with the full team
make open     # open http://localhost:8080, then New Project, then the floating robot button
make test     # smoke test in headless Chromium, against the full team (leaves the backend on it)
make logs     # follow the studio's and the backend's output
make catalog  # regenerate catalog/generated.json from openDAW (after bumping the openDAW pin)
make check    # type-check the backend and shared code (run `npm ci` in backend/ once first)
make types    # editor types for page/ (copies openDAW's tree into .opendaw/)
make down     # stop and remove the containers and network
make clean    # remove everything TakeDo created in Docker (not the shared builder)
```

The port is part of the origin that owns openDAW's saved projects (see the repo's CLAUDE.md), so TakeDo uses 8080
like the POCs. Stop any POC holding 8080 first, or run `PORT=8081 make up` (an empty studio on that origin).

API keys go in `.env` (git-ignored, and never in a build context): `TYPESAFE_API_KEY` (Jev, the fast path) and
`ANTHROPIC_API_KEY` (Claude, the Team Lead). The backend reads it at run time.

## How it fits together

```
 browser: http://localhost:8080                          compose project "takedo"
 ┌──────────────────────────────┐   /takedo (WebSocket)   ┌───────────────┐            ┌───────────────┐
 │ openDAW studio + page/       │ ──────────────────────▶ │ studio (Vite) │ ── proxy ─▶│ backend (Node)│
 │ (overlay, connection, ...)   │      same origin        │ :8080         │            │ :8787         │
 └──────────────────────────────┘                         └───────────────┘            └───────────────┘
```

- **The page reaches the backend through Vite's proxy at `/takedo`**, so the socket is same-origin and the
  studio's cross-origin isolation doesn't get in the way. The backend isn't published to the host.
- **Code is live.** `page/` and `shared/` are mounted into the studio's source tree, and Vite hot-swaps the
  overlay without reloading the page. `backend/src/` is mounted into the backend, which restarts on change
  (`node --watch`). The page reconnects on its own.
- **The backend runs TypeScript directly** (Node's type stripping), so `backend/` and `shared/` use only erasable
  syntax: no enums, no parameter properties, imports with `.ts`.
- **Session records** will go to `sessions/` (git-ignored, mounted into the backend).

## What the patch touches (4 files)

| File | Change |
|---|---|
| `ui/App.tsx` | mounts `@/takedo/TakeDoHost` |
| `vite.config.ts` | pre-bundles `markdown-it` (as in team_view); proxies `/takedo` to the backend, WebSocket included (`TAKEDO_BACKEND`, default `http://localhost:8787`) |
| `ui/wrapper/RelativeUnitValueDragging.tsx` (knobs), `ui/components/VolumeSlider.tsx` (faders) | the hold signal from edit_bench: a bubbling `parameter-hold` DOM event with `{parameter, held}` on pointer-down and when the drag ends (+9 lines) |

## Files

- `page/`: the page's code, mounted at `src/takedo/` in the studio tree
  - `TakeDoHost.tsx`, `TakeDoOverlay.tsx`: the floating robot button and the view beside it (from team_view)
  - `TakeDoPanel.tsx`: the team view's content: connection line, the Team Lead's overview (with a live playback line
    and a refresh button once the project has changed), member cards, chat. Tells the backend when the view opens.
    Owns one `Adapter` per open project. `window.takedo` = `{connection, adapter, service, debug}`;
    `debug.addSynth(name, notes?)` makes a named track, with a bar of notes if given
  - `Adapter.ts`: the page half of the bus: the ref map (`t1`, `t1.mix.volume`, `t1.fx1`, `t1.fx1.decay`, `r1`,
    `master`), applying ramps, sets, added and removed effects, landing on a beat, bar or given bar (in a loop, a
    passed bar waits for the next pass; one outside the loop is refused), snapshot queries
    (`outline`: tracks, devices, effects, regions, mix, playback; `full` adds notes; Playfield pads by name), the
    hold signal, applying plans (stale and hold checks, landing on the next beat or bar ≥ 200 ms ahead, read-back,
    status replies), and change events (a gesture folded into one, tagged user or agent)
  - `Catalog.ts`: generates the catalog's openDAW half by creating, reading and deleting every device in the open
    project (from poc/edit_bench); `window.takedo.debug.catalog()`
  - `Scripting.ts`: the open path's environment: what a script or look gets as `takedo` (the project, openDAW's
    libraries, refs, bar arithmetic, the snapshot), also as plain names; results serialized for the model
  - `Mentions.tsx`: @mentions: the autocomplete list (opens on "@", from the backend's team roster; arrows, Tab or
    Enter, Escape), and mentions styled in chat lines and in the input while typing (a mirror under transparent text)
  - `Connection.ts`: the page's end of the socket: hello, ping, reconnects with backoff
- `shared/protocol.ts`: the messages between the page and the backend, and the TakeDoAPI types built so far;
  mounted at `src/takedo_shared/` in the studio
- `backend/src/`
  - `main.ts`: the socket server and `/health`; one session (coordinator + log) per page connection
  - `coordinator.ts`: the backend half of the bus: chat and routing (`@member` straight to it, `@team_lead` to the
    split, otherwise Jev: one clear member or the Team Lead), claims (locks), requests to the adapter (refused outside
    the member's area), snapshot queries, member cards, the team roster for the page; asks for the overview when the
    view is open on a project that has none
  - `router.ts`: the fast path: one Jev request scores the roster and judges the hints (part, change, amount, when);
    `@member` skips the scores
  - `members.ts`: the team. Each member turns a task into steps (plan + landing) carried out in parallel under its
    claims; a plan whose first bar passed while it was planned slides later as a whole. The mix engineer (volume and
    pan; "quieter"/"louder" with Jev's hints is code alone), the arranger (mutes at bars) and the effect designer
    (adds, removes, sets and ramps audio effects, chosen from the catalog) plan with one Claude call each, strict
    tools limited to their area (as in `poc/llm_bench`)
  - `utility.ts`: the utility, the open path (STRATEGY.md, "Keep the open path"): whatever no member has an operation
    for, done with JavaScript in the page in a look-and-try loop (read-only looks, scripts as one undoable edit each,
    results or errors fed back, up to 8 rounds). The producer never sees it by name: the page shows its lines and card
    as the Team Lead's (the backend's team roster sends the alias and leaves it out of @mentions). Has every member's fixed operations as tools (for timing, ramps
    and checks), rebuilt from a fresh snapshot each round
  - `teamLead.ts`: the Team Lead's language-model work: the overview (one Claude call on the full snapshot plus the
    analysis and catalog), and splitting a direction among the members (structured output, with the roster and
    what nobody on the team can do)
  - `catalog.ts`: loads both halves of `catalog/` and gives a model each device in a project as openDAW's
    name and descriptions plus the hand-written notes; parameters by lookup
  - `analysis.ts`: what models are bad at, in code: key (Krumhansl–Kessler, durations as weights), each part's
    register, velocities and off-grid notes, drum hits by pad name
  - `gateway.ts`: every model call, by job, per `config/models.json` (TypeSafe for judgments, Anthropic for text);
    logs each one with its latency and tokens
  - `sessionLog.ts`: `sessions/<time>_<id>/log.jsonl` and `session.json`
- `config/models.json`: which provider and model does each job (mounted into the backend)
- `catalog/`: the device catalog, two files keyed alike by device type as the snapshot names it, mounted into the
  backend, which refuses to start if they disagree about which devices exist
  - `generated.json`: from openDAW itself (`make catalog`, `page/Catalog.ts` via `test/catalog.mjs`): each of the 41
    device types' name, descriptions, manual page, whether agents may add it (33 may), its automatable parameters
    (path, name, range, default, steps) and other settings. Stamped with the openDAW commit; don't edit by hand
  - `devices.json`: hand-written notes for choosing and describing them: sound, roles, genres, the classic gear it
    evokes, the words producers use for it, its limits; `opaque` for scripts and plugins, whose sound we can't know
- `test/smoke.mjs`: page loads cross-origin isolated, two parts with notes, the team view opens, the backend
  welcomes the page, the overview (three labelled lines naming both tracks, Keys described from the catalog, the live playback line, refresh after a
  third track is added), ping round trip, reconnecting after a dropped socket; then, during playback: `@mix_engineer the drums are too loud`, one undo
  restoring it, an unaddressed message routed to the mix engineer, and a held fader dropping the request. Calls the
  models for real (3 Jev requests, 3 Claude Haiku overviews: a fraction of a cent), so it needs both keys in `.env`.
  Failed requests to other origins (openDAW's own `api.opendaw.studio`) are ignored
- `Dockerfile` (studio; its build stage is hello_world's, so openDAW comes from the shared cache), `backend/Dockerfile`,
  `compose.yaml`, `Makefile`, `tsconfig.json` (editor types for `page/`), `backend/tsconfig.json`

## Status

- 2026-11-06: page and backend talk over the socket. Smoke test passes: median round trip 0.7 ms through the proxy,
  headless. In a real browser during playback of a simple project, the worst of ~10 pings was 11.8 ms.
- 2026-11-06: one message through B works end to end, headless. Chat → Jev (0.1–0.25 s) → mix engineer → claim →
  plan → adapter → ramp on the next beat → reply, about 1–1.5 s in all at 120 BPM, most of it the wait for the beat
  and the one-beat ramp. No language model involved.

- 2026-11-06: the overview. Opening the team view on a project gets the Team Lead's three lines (Music, Style,
  Tracks) from Claude Haiku 5.5 at low effort in 5–8 s, about 1,500 tokens in and 1,000 out (most of it thinking).
  On the test's one-bar sketch it read A minor, Am → F, four on the floor, "house sketch", and named every track.

- 2026-11-06: three members and the Team Lead, during playback, in the smoke test: `@arranger drop the keys out at
  the next bar and bring them back two bars later` (mute, then unmute two bars on), `@effect_designer give the keys
  a big lush reverb` (Dattorro Reverb), and `@team_lead bring the drums down a bit and put an echo on the keys`
  (split to the mix engineer and the effect designer: drums -3 dB, a Delay on the keys). Each Claude call is Haiku,
  1–3 s; the effect designer reads ~8k tokens (the catalog's effects with their parameters), the others ~1–1.5k.
  Direction to edit is 4–7 s, so "the next bar" usually lands a bar or two later than the model chose.

- 2026-11-06: the open path. `@team_lead extend all the clips so they run for 16 bars` went to the utility (and was
  logged as work done by hand); on Haiku it looked at the regions, set their lengths in one script, checked and
  reported, in 9 s. A script that set the volume of a fader the producer was holding was undone, and it said why.
  Script plus fixed operation: "add a track called Lead at -30 dB, then fade it up over 8 beats" made the track in
  a script and faded it with the volume tool the next round, in about 20 s.

Known gaps in what's built:

- **Ramps are value writes every 10 ms, not automation**, applied the way a knob drag is (one undo step). So a
  parameter that already has an automation lane is refused (writing it would switch the lane off until stop), and
  landing is accurate to about 10 ms. Whether this or automation is right depends on looping vs. non-looping
  sessions, which is deferred.
- **Landing and ramps are timed by a Web Worker clock (`page/Clock.ts`), not animation frames** (2026-11-06).
  Chrome stops animation frames for a hidden page (another tab, a minimized window, on macOS a fully covered
  window) while playback continues, so edits used to freeze mid-ramp or never land. A dedicated worker's timers
  aren't throttled that way. Headless Chrome never hides a tab, so the smoke test reports this check as SKIP.
  Verified in a real browser (2026-11-06): the drums were heard getting quieter while another tab was in front, and
  the reply appeared in the chat on switching back (the page doesn't repaint while hidden).
- **Undo shows as the producer's gesture**, not `user`/`undo`: wrapping undo and redo isn't built.
- **Three members' fast lanes.** Volume, pan, mutes and audio effects are fast operations; everything else (notes,
  chords, drum patterns, instruments, MIDI effects, clip lengths) is done by the Team Lead's hands (the utility),
  with scripts, in seconds to tens of seconds. Jev still scores all nine roles; a message for an unfilled one goes
  to the Team Lead. How well Haiku writes musical scripts (reharmonizing, swing) isn't measured yet.
- **The utility alone, for now** (2026-11-07): the full team got complex before the basics of an agent working in
  openDAW were solid, so by default (`ROSTER=utility`) every message goes straight to the utility, shown as the Team
  Lead: no Jev routing, no split, no members. It keeps the members' fixed operations as tools (ramps, bar-timed
  edits). Roles come back one at a time with `ROSTER=team`, which the smoke test uses. It sees the last 12 chat
  lines, so "go on" or "do all of it" refers back. An edit for a later bar answers "scheduled" at once and lands on
  its own, so a staged plan is timed from one playhead instead of waiting out each ramp; a later failure is fed back
  to it, or said to the producer after its reply. On Opus 5.5 (an experiment, config/models.json) it did a real
  lofi transformation but stopped after each 8 rounds; now 30 rounds per message, one conversation with the model
  across the session (cached, so a round pays full price only for what's new), one message at a time.
- **Landing in a loop** (2026-11-07): a bar inside the loop lands the next time the playhead reaches it (the loop's
  start included: it used to wait forever, since the playhead only reaches it by wrapping); a bar past the loop's end
  counts bars of playing, as if the loop were unrolled, so a plan's later steps keep their spacing. Each card lists
  its edits live (waits for a bar, under way, done, not done and why), so a wait or a refusal isn't silent.
- **Planning delay shows as lateness:** a plan made for "the next bar" slides by the bars that passed while it was
  planned, and the reply says so. Preparing ahead (STRATEGY.md) isn't built.
- **Scripts are reported as one opaque edit:** the change stream carries their value changes, not regions or notes
  they add or move. They're only as safe as their checks: rolled back if they throw, undone if they touched a held
  control; nothing stops a script from deleting a track if the model decides to (the prompt forbids it).
- **Added and removed effects aren't change events yet** (only value changes are), and their undo is per step.
- **Changes reach the backend and the log, but no member reacts to them yet** (triggers, `diff`).
- **The overview describes a device by its catalog notes, not by its settings:** it says what a Tubular typically
  is (FM, DX7-style), not what this patch sounds like, and it can lean on a typical role (it called a Tubular
  playing chords "an FM electric piano"). Presets aren't read yet. Nothing reads the overview back yet: members work
  from the snapshot.
- **The refresh button appears after any box graph update,** UI state such as selection included, not only edits.
