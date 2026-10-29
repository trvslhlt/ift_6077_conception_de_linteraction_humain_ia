# IFT 6077 course project

Course project: AI agents that turn a producer's spoken/text notes into edits in openDAW, during playback.
The proposal is `course_project/project_proposal/final_proposal/main.tex`; the runnable openDAW baseline is `course_project/poc/hello_world/`.

## LaTeX

- Verification builds: `latexmk -outdir=<scratch dir>`, never the proposal's `build/`. VS Code LaTeX Workshop and `latexmkrc` both build into `build/` on save, and concurrent builds corrupted `build/main.bbl`. If it keeps erroring, delete `build/` and rebuild once.

## openDAW facts

- Fully client-side: no backend. Projects live in the browser's OPFS and preferences in `localStorage` (key `preferences`), both scoped to the origin `http://localhost:8080`. Changing the host (`127.0.0.1` vs `localhost`) or port shows an empty studio. Docker volumes cannot hold this data; `.odb` bundle export/import is the portable format.
- Needs a secure context plus cross-origin isolation (COOP `same-origin`, COEP `require-corp`) for `SharedArrayBuffer`/AudioWorklet. `http://localhost` counts as secure; any other host needs HTTPS.
- Scriptable from the page: `window.opendaw.engine.play()/stop()/position()/isPlaying()`. The smoke test uses these.
- Building from source needs Node >= 23, Rust stable, and Rust nightly with `rust-src` and `wasm32-unknown-unknown` (WASM engine). `build-wasm.sh` reads `DEVICE_TOOLCHAIN` for the nightly name.
- Turbo strips unknown env vars from package builds; run it with `--env-mode=loose` so `NODE_OPTIONS`/`DEVICE_TOOLCHAIN` reach them. The studio's Vite build needs about 3 GB of Node heap (`--max-old-space-size=3072`).

## Docker conventions

- Host is Apple Silicon (arm64), Docker Desktop with 8 GB of memory and a 32 GB virtual disk (tight: one openDAW build plus the Playwright image needs ~15 GB). Shared with other course projects: never run global `docker system/builder/volume prune`.
- Each POC folder is its own compose project; its `make clean` removes exactly that project's containers, network and images, and nothing else. Pattern: `course_project/poc/hello_world/Makefile`.
- All builds share one buildx builder, `opendaw-poc`, defined in `docker/builder.mk` (each POC Makefile includes it). One cache means POCs that share build steps get cache hits; a POC's `make clean` never removes it, `make -C docker clean` does. A POC that builds openDAW should keep hello_world's build stage instruction-for-instruction so it stays a cache hit.
- `.dockerignore` files are allowlists (`*` then `!file`), so `.env` and secrets never enter a build context.
- Pin everything: base images by digest, toolchains by exact version, apt packages that affect output, openDAW by commit. Bump pins together and re-run `make test`.
- Run browser tests with Playwright's image (multi-arch). Puppeteer's image is amd64-only, and Chrome won't start under emulation.
- Publish ports on `127.0.0.1` only.
- Gotcha: a buildx builder container started while the Docker disk was full comes up with no network (builds fail on DNS). `docker buildx rm --keep-state <name>` then `make builder` recreates it and keeps the cache.
- Gotcha: a `types {}` block in an nginx `server` replaces the whole MIME map; nginx already serves `.wasm` as `application/wasm`.
