# Runs on the host (Node >= 22), no Docker: it only makes HTTPS calls to the Claude API.
# The key is read from .env here, or else from ../jev_bench/.env.

.PHONY: help install run clean

help: ## List targets
	@grep -hE '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-10s %s\n", $$1, $$2}'

install: ## Install the pinned SDK and zod from package-lock.json
	npm ci

run: ## Run every part, or some: make run PARTS="lead member"; MODEL=..., EFFORT=..., ROSTER=0, BUDGET=5 (dollars)
	@test -d node_modules || npm ci
	node --env-file-if-exists=../jev_bench/.env --env-file-if-exists=.env bench.mjs $(PARTS)

clean: ## Remove node_modules and results
	rm -rf node_modules results
