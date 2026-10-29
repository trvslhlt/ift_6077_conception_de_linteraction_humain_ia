# Everything Docker creates for this POC is in compose project "opendaw-poc" (compose.yaml):
# containers, network, images. `make clean` removes all of it and nothing else.
# Builds use the repo's shared buildx builder (docker/builder.mk), which `make clean` leaves alone.

PROJECT := opendaw-poc
REPO_ROOT := $(abspath $(dir $(lastword $(MAKEFILE_LIST)))../../..)
PORT ?= 8080
URL := http://localhost:$(PORT)

export PORT
COMPOSE := docker compose --profile test

.PHONY: help builder build up down restart logs status open shell test usage clean

help: ## List targets
	@grep -hE '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-10s %s\n", $$1, $$2}'

include $(REPO_ROOT)/docker/builder.mk

build: builder ## Build the studio and test images (first build compiles openDAW, ~15 min)
	$(COMPOSE) build
	@docker image prune -f --filter label=com.docker.compose.project=$(PROJECT) >/dev/null

up: build ## Build if needed, then start the studio and wait until it is healthy
	$(COMPOSE) up -d --wait studio
	@echo "openDAW running at $(URL)"

down: ## Stop and remove the containers and network
	$(COMPOSE) down --remove-orphans

restart: down up ## Recreate the studio container

logs: ## Follow the studio's nginx logs
	$(COMPOSE) logs -f studio

status: ## Show container state and check the page responds
	@$(COMPOSE) ps
	@curl -fsS -o /dev/null -w 'HTTP %{http_code}\n' $(URL) || echo "not responding at $(URL)"

open: ## Open the studio in the default browser
	open $(URL)

shell: ## Shell into the running studio container
	$(COMPOSE) exec studio sh

test: build ## Smoke-test the studio in headless Chromium (starts it if needed)
	$(COMPOSE) run --rm smoke

usage: ## Show disk used by this POC's images (shared build cache: `make -C docker usage` from the repo root)
	@docker image ls --filter label=com.docker.compose.project=$(PROJECT)

clean: ## Remove all containers, images and network of this POC (not the shared builder)
	$(COMPOSE) down --remove-orphans --rmi local
	-docker image prune -f --filter label=com.docker.compose.project=$(PROJECT)
