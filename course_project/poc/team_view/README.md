# Team view proof of concept

Shows that our own application logic can run inside [openDAW](https://github.com/andremichelle/openDAW) with a
small patch: a **Team** screen (robot icon in the header) puts openDAW's Timeline next to our panel, which

- logs every change to the open project, tagged `team` (made by the panel) or `daw` (made anywhere else in openDAW,
  including undo), and
- makes one change itself: **Tempo +5 BPM**, an ordinary undoable openDAW edit, applied during playback.

Discovery-stage code, copied from `../hello_world` and changed. Not meant for deployment.

## Usage

```sh
make up       # build (first time a few minutes) and start the studio with Vite's dev server
make open     # open http://localhost:8080, then New Project, then the robot icon
make test     # check both directions in headless Chromium
make logs     # follow Vite's output
make down     # stop and remove the containers and network
make clean    # remove everything this POC created in Docker (not the shared builder)
```

hello_world uses the same port. Run `make down` there first, or use `PORT=8081 make up` here. Saved projects belong to
the exact origin, so a different port shows an empty studio (see `../hello_world/README.md`, "Saving work").

## Changing things

- **`src/` (our code):** bind-mounted into the studio's source tree at `src/team_view/`. Save a file and Vite updates the
  page within about a second. Changes to `TeamPanel.tsx` (and anything it imports) are swapped in place by
  `TeamHost.tsx`: no page reload, so the open project and playback keep going. Editing `TeamHost.tsx` itself reloads the page.
- **`opendaw.patch` (openDAW's code):** `make up` rebuilds in seconds. Only the patched files are rebuilt, never the openDAW tree.
  To change it, apply it to a checkout of openDAW at the pinned commit, edit, and save `git diff` back here.

What the patch touches (5 files, +35/-2):

| File | Change |
|---|---|
| `ui/workspace/PanelType.ts` | adds `PanelType.Team` |
| `ui/workspace/PanelFactory.tsx` | renders `@/team_view/TeamHost` for it |
| `ui/workspace/Default.ts` | adds the `team` screen: Timeline plus the Team panel |
| `ui/header/Header.tsx` | gives the screen a shortcut entry (reuses the default screen's, as `code` does) |
| `vite.config.ts` | pre-bundles `markdown-it`, otherwise found late, which made Vite reload the page mid-boot |

## How it works

Every openDAW edit goes through `project.editing.modify(...)`, which records the undo step, and every change to the
project reaches `project.boxGraph.subscribeToAllUpdates(...)`. Updates fire synchronously inside the edit, so the panel
sets a flag around its own `modify()` call to tag them `team`. All other updates are tagged `daw`.

## Docker footprint

- **Compose project `opendaw-team-view`:** the `studio` and `smoke` containers, the `opendaw-team-view_default` network,
  and the `opendaw-team-view-studio` / `opendaw-team-view-smoke` images. No volumes. `make clean` removes them.
- **Builder:** the repo's shared buildx builder (`../../../docker/builder.mk`). The Dockerfile's `build` stage matches hello_world's
  instruction for instruction, so the openDAW build is a cache hit. Keep it that way: a cache miss costs ~15 min and
  ~8.5 GB of a tight disk. `make clean` here never removes the builder.

## Files

- `src/TeamHost.tsx`: the module openDAW imports; mounts the panel and hot-swaps it
- `src/TeamPanel.tsx`: the panel: change log, tempo button
- `opendaw.patch`: the changes to openDAW (table above)
- `Dockerfile`: `build` (same as hello_world), `patched` (applies the patch, outputs only the changed files), `dev` (Node plus the
  built tree, running Vite)
- `compose.yaml`, `Makefile`, `.dockerignore`: as in hello_world, adapted
- `test/smoke.mjs`: the browser test
