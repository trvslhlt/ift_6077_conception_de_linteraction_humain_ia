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

.PHONY: help builder build up down restart logs status open shell test check types usage clean

help: ## List targets
	@grep -hE '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-10s %s\n", $$1, $$2}'

include $(REPO_ROOT)/docker/builder.mk

build: builder ## Build the studio, backend and test images (openDAW itself comes from the shared cache)
	$(COMPOSE) build
	@docker image prune -f --filter label=com.docker.compose.project=$(PROJECT) >/dev/null

up: build ## Start the studio and the backend (page/, shared/, backend/src/ live) and wait until healthy
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

test: build ## Run the smoke test in headless Chromium (starts the studio and backend if needed)
	mkdir -p sessions
	$(COMPOSE) run --rm smoke

check: ## Type-check the backend and shared code (needs `npm ci` in backend/ once)
	cd backend && npx tsc --noEmit

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
