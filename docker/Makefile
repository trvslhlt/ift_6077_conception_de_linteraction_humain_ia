# Manages the repo's shared buildx builder (builder.mk). POCs create it on demand; this is for inspecting or removing it.

.PHONY: help usage clean

help: ## List targets
	@grep -hE '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-10s %s\n", $$1, $$2}'

include builder.mk

usage: ## Show the shared build cache's size
	@docker buildx du --builder $(BUILDER) 2>/dev/null | tail -1 || echo "no builder"

clean: ## Remove the shared builder and its whole cache (every POC's next build starts from scratch)
	-docker buildx rm --force $(BUILDER)
	-docker rmi $(BUILDKIT_IMAGE)
