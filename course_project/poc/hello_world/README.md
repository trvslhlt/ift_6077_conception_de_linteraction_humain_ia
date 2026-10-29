# openDAW proof of concept

Runs [openDAW](https://github.com/andremichelle/openDAW) (a web-based DAW, AGPL-3.0) locally in Docker.
Later project phases build on this setup.

The studio image builds openDAW from source at a pinned commit, then serves the static build with nginx.
nginx adds the cross-origin-isolation headers (COOP/COEP) that openDAW needs for `SharedArrayBuffer`.
`http://localhost` counts as a secure context, so no TLS certificate is needed.

## Usage

Requires Docker (8 GB of memory recommended, at least 4 GB) and about 20 GB of free disk for the first build.

```sh
make up       # build (first time: ~15 min) and start the studio
make open     # open http://localhost:8080
make test     # smoke-test the studio in headless Chromium
make status   # container state + HTTP check
make logs     # follow nginx logs
make down     # stop and remove the containers and network
make usage    # disk used by this POC's images and build cache
make clean    # remove everything this POC created in Docker
```

Use a Chromium-based browser or Firefox. The app needs a click on the page before audio can start.

## Saving work

openDAW has no server-side storage. Projects are saved in the browser's private file storage (OPFS) and
preferences in `localStorage`, both tied to the exact origin `http://localhost:8080`. So:

- Saved projects survive `make down`, `make clean` and rebuilds; the container holds no user data and needs no volume.
- Always open the studio at `http://localhost:8080`. `127.0.0.1:8080`, another port (`PORT=`) or another browser profile
  each have their own, empty storage.
- Clearing site data for localhost in the browser deletes the projects. For a copy on disk, export a project bundle
  (`.odb`) from the studio and load it back with **Open Bundle**.
- openDAW offers to make its storage persistent so the browser never evicts it; accept that prompt.

## Docker footprint

Everything Docker creates for this POC belongs to compose project `opendaw-poc` (`compose.yaml`), and `make clean`
removes all of it: the `studio` and `smoke` containers, the `opendaw-poc_default` network and the
`opendaw-poc-studio` / `opendaw-poc-smoke` images. No volumes.

Builds use the repo's shared buildx builder (`../../../docker/builder.mk`; also named `opendaw-poc`). Its cache holds the base
images, Rust toolchains and compiled openDAW, which other POCs reuse. `make clean` leaves it alone;
`make -C docker clean` from the repo root removes it.

Containers, networks and the studio image never outlive `make down`/`make clean`, rebuilds prune the project's
dangling images, and the smoke test container is removed after each run.

## Versions

All pinned, verified working together on 2026-10-29:

| Component | Pin | Where |
|---|---|---|
| openDAW | commit `652e6caf759b06e8171f49fb71257884e7cae66e` (`main`, 2026-10-29) | `Dockerfile` |
| Node.js (build image) | `node:26.13.0-trixie` by digest (npm 11.20.0, Debian 13.7) | `Dockerfile` |
| Rust stable | 1.99.1 | `Dockerfile` |
| Rust nightly | `nightly-2026-10-29` (rustc 1.101.0-nightly `92ffebece`) | `Dockerfile` |
| rustup | 1.29.2 | `Dockerfile` |
| binaryen (`wasm-opt`) | Debian package `120-4` | `Dockerfile` |
| nginx (runtime image) | `nginx:1.31.8-alpine` by digest | `Dockerfile` |
| Playwright (test image) | `mcr.microsoft.com/playwright:v1.64.1-noble` by digest; `playwright` 1.64.1 | `test/Dockerfile`, `test/package-lock.json` |
| BuildKit (builder) | `moby/buildkit:v0.34.1` by digest | `docker/builder.mk` (repo root) |

npm and cargo dependencies are fixed by openDAW's own `package-lock.json` and `Cargo.lock` at that commit.
`git`, `curl` and `build-essential` are installed unpinned from Debian; they don't affect the output.

To upgrade, change the pins together, then `make test`: a newer openDAW commit may need a newer Rust nightly.
To try another openDAW commit without editing: `make up OPENDAW_REF=<commit-sha>` (or set it in `.env`).
If the Debian mirror drops `binaryen 120-4` (after a point release), the build fails at `apt-get`;
bump `BINARYEN_VERSION` to the version `apt-cache policy binaryen` reports.

## Smoke test

`make test` runs `test/smoke.mjs` in a Playwright container that shares the studio container's network,
so the page is served from `localhost` (a secure context). It starts the studio if needed and checks that
the page loads with COOP/COEP headers, that the page is cross-origin isolated, that **New Project** opens the studio,
that the engine plays and the playhead advances, and that no page errors or failed requests occur.
It exits non-zero on any failure.

## Files

- `compose.yaml`: the `studio` service and the `smoke` test service (profile `test`)
- `Makefile`: the entry point; wraps compose and includes the shared builder
- `Dockerfile`: stage 1 installs Node and Rust and runs `turbo build` for `@opendaw/app-studio`; stage 2 is nginx serving `dist/`
- `nginx.conf`: COOP/COEP/CORP headers, gzip, SPA fallback
- `.dockerignore`, `test/.dockerignore`: allowlists, so only the files the Dockerfiles copy enter a build
- `test/`: `smoke.mjs` and its Playwright runner image

## Not included

The dev server, the `/manuals` proxy, cloud sync (Dropbox, Drive, Nextcloud) and the collaboration (yjs) server.
