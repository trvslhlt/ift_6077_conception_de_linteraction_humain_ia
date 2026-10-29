# Everything Docker creates for this POC is one of:
#   - compose project "opendaw-poc": containers, network, images (compose.yaml)
#   - buildx builder "opendaw-poc": its own build cache, capped by buildkitd.toml
# `make clean` removes all of it and nothing else.

PROJECT := opendaw-poc
BUILDKIT_IMAGE := moby/buildkit:v0.34.1@sha256:99368f3e46177c6405b9740e4461d91cee004128daeecca78d4ceac50ec1da5c
PORT ?= 8080
URL := http://localhost:$(PORT)

export PORT
export BUILDX_BUILDER := $(PROJECT)
COMPOSE := docker compose --profile test

.PHONY: help builder build up down restart logs status open shell test usage clean

help: ## List targets
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-10s %s\n", $$1, $$2}'

builder: ## Create the dedicated buildx builder if missing
	@docker buildx inspect $(PROJECT) >/dev/null 2>&1 || docker buildx create --name $(PROJECT) \
		--driver docker-container --driver-opt image=$(BUILDKIT_IMAGE) \
		--buildkitd-config buildkitd.toml --bootstrap

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

usage: ## Show disk used by this POC's images and build cache
	@docker image ls --filter label=com.docker.compose.project=$(PROJECT)
	@docker buildx du --builder $(PROJECT) 2>/dev/null | tail -1 || echo "no builder"

clean: ## Remove all containers, images, network and build cache of this POC
	$(COMPOSE) down --remove-orphans --rmi local
	-docker image prune -f --filter label=com.docker.compose.project=$(PROJECT)
	-docker buildx rm --force $(PROJECT)
	-docker rmi $(BUILDKIT_IMAGE)
