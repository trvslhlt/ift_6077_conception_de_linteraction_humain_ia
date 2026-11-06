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
  - `TakeDoPanel.tsx`: the team view's content; for now the connection status and a ping
  - `Connection.ts`: the page's end of the socket: hello, ping, reconnects with backoff. `window.takedo.connection`
- `shared/protocol.ts`: the messages between the page and the backend; mounted at `src/takedo_shared/` in the studio
- `backend/src/main.ts`: the socket server and `/health`
- `test/smoke.mjs`: page loads cross-origin isolated, the team view opens, the backend welcomes the page, ping round
  trip, reconnecting after a dropped socket, playback still works
- `Dockerfile` (studio; its build stage is hello_world's, so openDAW comes from the shared cache), `backend/Dockerfile`,
  `compose.yaml`, `Makefile`, `tsconfig.json` (editor types for `page/`), `backend/tsconfig.json`

## Status

- 2026-11-06: page and backend talk over the socket. Smoke test passes: median round trip 0.7 ms through the proxy,
  headless. In a real browser during playback of a simple project, the worst of ~10 pings was 11.8 ms.
- Next: the "kick is too loud" path (`../project_plan/ARCHITECTURE.md`, "One message through B").
