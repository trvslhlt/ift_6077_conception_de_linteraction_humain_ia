# Runs on the host (Node >= 22), no Docker: it only makes HTTPS calls to TypeSafe's API.

.PHONY: help install run clean

help: ## List targets
	@grep -hE '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-10s %s\n", $$1, $$2}'

install: ## Install the pinned SDK from package-lock.json
	npm ci

run: ## Run every family, or some: make run FAMILIES="routing amend"; REPEATS=3 for steadier latency
	@test -d node_modules || npm ci
	node --env-file=.env bench.mjs $(FAMILIES)

clean: ## Remove node_modules and results
	rm -rf node_modules results
