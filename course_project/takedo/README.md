# TakeDo

The integrated prototype: AI team members that turn a producer's directions into openDAW edits during playback.
Architecture B of [`../project_plan/ARCHITECTURE.md`](../project_plan/ARCHITECTURE.md): the page is an adapter, and
coordination lives in a backend process. The contracts between them are the TakeDoAPI
([`../project_plan/TAKEDO_API.md`](../project_plan/TAKEDO_API.md)).

The POCs in `../poc/` are frozen references and benches. Code is copied from them, never imported.

## Usage

```sh
make up       # build and start the studio and the backend (page/, shared/, backend/src/ live)
make open     # open http://localhost:8080, then New Project, then the floating robot button
make test     # smoke test in headless Chromium
make logs     # follow the studio's and the backend's output
make check    # type-check the backend and shared code (run `npm ci` in backend/ once first)
make types    # editor types for page/ (copies openDAW's tree into .opendaw/)
make down     # stop and remove the containers and network
make clean    # remove everything TakeDo created in Docker (not the shared builder)
```

The port is part of the origin that owns openDAW's saved projects (see the repo's CLAUDE.md), so TakeDo uses 8080
like the POCs. Stop any POC holding 8080 first, or run `PORT=8081 make up` (an empty studio on that origin).

API keys go in `.env` (git-ignored, and never in a build context). The backend reads it at run time.

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
  - `TakeDoPanel.tsx`: the team view's content: connection line, member cards, chat. Owns one `Adapter` per open
    project. `window.takedo` = `{connection, adapter, service, debug}`; `debug.addSynth(name)` makes a named track
  - `Adapter.ts`: the page half of the bus: the ref map (`t1`, `t1.mix.volume`, `master`), snapshot queries, the
    hold signal, applying plans (stale and hold checks, landing on the next beat or bar ≥ 200 ms ahead, read-back,
    status replies), and change events (a gesture folded into one, tagged user or agent)
  - `Connection.ts`: the page's end of the socket: hello, ping, reconnects with backoff
- `shared/protocol.ts`: the messages between the page and the backend, and the TakeDoAPI types built so far;
  mounted at `src/takedo_shared/` in the studio
- `backend/src/`
  - `main.ts`: the socket server and `/health`; one session (coordinator + log) per page connection
  - `coordinator.ts`: the backend half of the bus: chat, routing, claims (locks), requests to the adapter, snapshot
    queries, member cards
  - `router.ts`: the fast path: one Jev request scores the roster and judges the hints (part, change, amount, when);
    `@member` skips the scores
  - `members.ts`: the mix engineer (volume up or down on a track or the master; Jev's hints become a ramp in code)
  - `gateway.ts`: every model call, by job, per `config/models.json`; logs each one
  - `sessionLog.ts`: `sessions/<time>_<id>/log.jsonl` and `session.json`
- `config/models.json`: which provider and model does each job (mounted into the backend)
- `test/smoke.mjs`: page loads cross-origin isolated, the team view opens, the backend welcomes the page, ping round
  trip, reconnecting after a dropped socket; then, during playback: `@mix_engineer the drums are too loud`, one undo
  restoring it, an unaddressed message routed to the mix engineer, and a held fader dropping the request. Calls Jev
  for real (3 requests), so it needs `TYPESAFE_API_KEY` in `.env`
- `Dockerfile` (studio; its build stage is hello_world's, so openDAW comes from the shared cache), `backend/Dockerfile`,
  `compose.yaml`, `Makefile`, `tsconfig.json` (editor types for `page/`), `backend/tsconfig.json`

## Status

- 2026-11-06: page and backend talk over the socket. Smoke test passes: median round trip 0.7 ms through the proxy,
  headless. In a real browser during playback of a simple project, the worst of ~10 pings was 11.8 ms.
- 2026-11-06: one message through B works end to end, headless. Chat → Jev (0.1–0.25 s) → mix engineer → claim →
  plan → adapter → ramp on the next beat → reply, about 1–1.5 s in all at 120 BPM, most of it the wait for the beat
  and the one-beat ramp. No language model involved.

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
- **Only volume** (tracks and the master), and only the mix engineer. Anything else gets a reply saying who would
  handle it, or that the Team Lead's language model isn't connected yet.
- **Changes reach the backend and the log, but no member reacts to them yet** (triggers, `diff`).
