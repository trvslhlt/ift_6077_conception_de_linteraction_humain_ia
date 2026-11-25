# Everything Docker creates for TakeDo is in compose project "takedo" (compose.yaml): containers, network, images.
# `make clean` removes all of it and nothing else.
# Builds use the repo's shared buildx builder (docker/builder.mk), which `make clean` leaves alone.

PROJECT := takedo
REPO_ROOT := $(abspath $(dir $(lastword $(MAKEFILE_LIST)))../..)
PORT ?= 8080
URL := http://localhost:$(PORT)
TYPES_DIR := .opendaw
export PORT
COMPOSE := docker compose --profile test

.PHONY: help builder build up down restart logs status open shell test scenario catalog check knowledge knowledge-bench triage-bench knowledge-import types usage clean

help: ## List targets
	@grep -hE '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-10s %s\n", $$1, $$2}'

include $(REPO_ROOT)/docker/builder.mk

build: builder samples ## Build the studio, backend and test images (openDAW itself comes from the shared cache)
	$(COMPOSE) build
	@docker image prune -f --filter label=com.docker.compose.project=$(PROJECT) >/dev/null

# The backend reads openDAW's source from here (compose.yaml); copied out of the image once, again after `make clean`.
$(TYPES_DIR)/packages:
	$(MAKE) types

up: build $(TYPES_DIR)/packages ## Start the studio and the backend (page/, shared/, backend/src/ live) and wait until healthy
	mkdir -p sessions
	$(COMPOSE) up -d --wait studio backend
	@echo "TakeDo running at $(URL) (New Project, then the floating robot button)"

down: ## Stop and remove the containers and network
	$(COMPOSE) down --remove-orphans

restart: down up ## Recreate the containers

logs: ## Follow the studio's and the backend's output
	$(COMPOSE) logs -f studio backend

status: ## Show container state and check the page responds
	@$(COMPOSE) ps
	@curl -fsS -o /dev/null -w 'HTTP %{http_code}\n' $(URL) || echo "not responding at $(URL)"

open: ## Open the studio in the default browser
	open $(URL)

shell: ## Shell into the running backend container
	$(COMPOSE) exec backend sh

# The test runs against the backend as `make up` starts it: the captain and its workers. Its new project is named
# "Untitled", and agents keep a notebook and session per project name, so the last test's are cleared first (a resumed
# captain session from old runs carried 590k tokens and refused the work, 2026-11-23).
test: build $(TYPES_DIR)/packages ## Run the smoke test in headless Chromium against the captain and its workers
	mkdir -p sessions
	rm -f sessions/notebooks/Untitled.json sessions/notebooks/Untitled.agent.json sessions/notebooks/Untitled.board.json
	$(COMPOSE) up -d --wait studio backend
	$(COMPOSE) run --rm smoke

# A scenario runs against a backend recreated for it, so a test or an earlier session can't leak into it. Costs a model session per run (keys from .env). A message with
# restart_after_ms kills the backend that long after it's sent: the runner drops scenarios/.restart, and the loop here
# kills the container (SIGKILL, as a crash would) and starts it again.
SCENARIO ?= lofi
scenario: build $(TYPES_DIR)/packages ## Play scenarios/$(SCENARIO).json to TakeDo headless and write its report (scenarios/runs/)
	mkdir -p sessions scenarios/runs
	rm -f sessions/notebooks/scenario-$(SCENARIO).json sessions/notebooks/scenario-$(SCENARIO).agent.json sessions/notebooks/scenario-$(SCENARIO).board.json scenarios/.restart
	$(COMPOSE) up -d --wait --force-recreate backend studio
	( while :; do if [ -f scenarios/.restart ]; then rm -f scenarios/.restart; $(COMPOSE) kill backend; \
		$(COMPOSE) up -d --wait backend; fi; sleep 0.5; done ) & watcher=$$!; \
		$(COMPOSE) run --rm -e COUNT_FRAMES=$(COUNT_FRAMES) -e QUERY_LOADING=$(QUERY_LOADING) -v $(CURDIR)/scenarios:/scenarios smoke node scenario.mjs /scenarios/$(SCENARIO).json; \
		status=$$?; kill $$watcher; exit $$status
	cd backend && node src/report.ts "$$(ls -td ../scenarios/runs/*_$(SCENARIO) | head -1)"

catalog: build ## Regenerate catalog/generated.json from openDAW (every device's descriptions and parameters)
	$(COMPOSE) run --rm -v $(CURDIR)/catalog:/out \
		-e OPENDAW_REF=$$(sed -n 's/^ARG OPENDAW_REF=//p' Dockerfile) smoke node catalog.mjs

check: ## Type-check the backend and shared code (needs `npm ci` in backend/ once)
	cd backend && npx tsc --noEmit

knowledge: ## Check the knowledge base offline: every entry against the catalog, the music helpers, expansion, the knowledge route (needs `npm ci` in backend/ once)
	cd backend && node --test src/knowledge.test.ts src/router.test.ts src/reply.test.ts src/staging.test.ts src/generate.test.ts src/notebook.test.ts src/takes.test.ts src/ledger.test.ts src/blend.test.ts src/fastpath.test.ts

# PICKERS=jev and/or claude also asks the models which entry each message needs (costs money; keys from .env).
knowledge-bench: ## Which producer messages the knowledge base serves (knowledge/bench/; PICKERS="route claude" to run the pickers)
	cd backend && node $(if $(PICKERS),--env-file=../.env) src/knowledge.bench.ts $(PICKERS)

triage-bench: ## Jev in front of the Team Lead: path, part and move on knowledge/bench/triage.mjs's labelled messages (costs Jev cents)
	cd backend && node --env-file=../.env src/triage.bench.ts

# The datasets are downloaded by hand into DATASETS (pins and URLs in knowledge/README.md); the DX7 import needs none.
DATASETS ?= $(CURDIR)/.datasets
knowledge-import: ## Rewrite the imported knowledge entries (DX7 always; Groove MIDI and Chordonomicon from DATASETS=<dir>)
	node knowledge/import/dx7.mjs
	@if [ -d "$(DATASETS)/groove" ]; then node knowledge/import/groove.mjs "$(DATASETS)/groove"; else echo "no $(DATASETS)/groove: Groove MIDI skipped"; fi
	@if [ -f "$(DATASETS)/chordonomicon/chordonomicon_v2.csv" ]; then node knowledge/import/chordonomicon.mjs "$(DATASETS)/chordonomicon/chordonomicon_v2.csv"; else echo "no $(DATASETS)/chordonomicon: Chordonomicon skipped"; fi
	$(MAKE) knowledge

types: build ## Copy openDAW's source and types out of the image into .opendaw/, for the editor (see tsconfig.json)
	rm -rf $(TYPES_DIR) && mkdir -p $(TYPES_DIR)
	docker run --rm --entrypoint tar $(PROJECT)-studio -C /src -c \
		--exclude=./.git --exclude=./crates --exclude=./packages/app/studio/dist --exclude='*.wasm' . \
		| tar -x -C $(TYPES_DIR)
	ln -sfn $(TYPES_DIR)/node_modules node_modules
	@du -sh $(TYPES_DIR)

usage: ## Show disk used by TakeDo's images (shared build cache: `make -C docker usage` from the repo root)
	@docker image ls --filter label=com.docker.compose.project=$(PROJECT)

clean: ## Remove all containers, images and network of TakeDo (not the shared builder), and .opendaw/
	$(COMPOSE) down --remove-orphans --rmi local
	rm -rf $(TYPES_DIR) node_modules
	-docker image prune -f --filter label=com.docker.compose.project=$(PROJECT)

park-bench: build $(TYPES_DIR)/packages ## What a parked part costs the audio engine: playing vs muted vs disabled (TRACKS=8)
	$(COMPOSE) up -d --wait studio backend
	$(COMPOSE) build smoke
	$(COMPOSE) run --rm -e TRACKS=$(or $(TRACKS),8) smoke node park-bench.mjs

loop-probe: build $(TYPES_DIR)/packages ## Does widening the loop while playing freeze the engine headless? (no models)
	$(COMPOSE) up -d --wait studio backend
	$(COMPOSE) build smoke
	$(COMPOSE) run --rm -e TRACKS=$(or $(TRACKS),3) smoke node loop-probe.mjs

jam-probe: build $(TYPES_DIR)/packages ## Does a recorded loop-off jam keep going past the song's end? (no models)
	$(COMPOSE) up -d --wait studio backend
	$(COMPOSE) build smoke
	$(COMPOSE) run --rm -e SECONDS=$(or $(SECONDS),40) -e PROJECT=$(PROJECT) -e PANEL=$(PANEL) -e EDITS=$(EDITS) -e LOOP=$(LOOP) -e RAMP_MS=$(or $(RAMP_MS),20) -e NOREC=$(NOREC) -e DRAGS=$(DRAGS) -v $(CURDIR)/scenarios:/scenarios smoke node jam-probe.mjs

# Drum machine samples (geikha/tidal-drum-machines, 73 machines, ~170 MB), pinned by commit. Refetched at any time:
# the studio serves samples/ and openDAW reloads a sample from there whenever the browser has lost its copy.
DRUM_MACHINES_COMMIT := 6577395a4d05031728ced2ec3e5637fa89d8be48
# Soundfonts (knowledge/import/soundfonts.json: GeneralUser GS by commit, openDAW's own by asset UUID), the same way.
.PHONY: samples
samples: samples/tidal-drum-machines/.commit-$(DRUM_MACHINES_COMMIT) ## Fetch the sample collections, soundfonts and openDAW's presets (pinned) into samples/
	node knowledge/import/soundfonts.mjs samples
	node knowledge/import/presets.mjs samples
	node knowledge/import/samples.mjs samples
samples/tidal-drum-machines/.commit-$(DRUM_MACHINES_COMMIT):
	rm -rf samples/tidal-drum-machines && mkdir -p samples/tidal-drum-machines
	curl -fsSL https://codeload.github.com/geikha/tidal-drum-machines/tar.gz/$(DRUM_MACHINES_COMMIT) \
		| tar -xz -C samples/tidal-drum-machines --strip-components=2 tidal-drum-machines-$(DRUM_MACHINES_COMMIT)/machines
	touch $@
