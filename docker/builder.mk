# The one buildx builder for every Docker build in this repo. Each POC's Makefile includes this file.
#
# One BuildKit cache for all POCs, so POCs that share build steps (the openDAW build) get cache hits, and the
# cache never mixes with other projects' builds in Docker Desktop's default builder.
# A POC's `make clean` never removes the builder; `make -C docker clean` (from the repo root) does.
#
# The name predates sharing; renaming would start an empty cache (a full openDAW rebuild).

BUILDER := opendaw-poc
BUILDKIT_IMAGE := moby/buildkit:v0.34.1@sha256:99368f3e46177c6405b9740e4461d91cee004128daeecca78d4ceac50ec1da5c
BUILDKITD_CONFIG := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))/buildkitd.toml

export BUILDX_BUILDER := $(BUILDER)

.PHONY: builder
builder: ## Create the repo's shared buildx builder if missing
	@docker buildx inspect $(BUILDER) >/dev/null 2>&1 || docker buildx create --name $(BUILDER) \
		--driver docker-container --driver-opt image=$(BUILDKIT_IMAGE) \
		--buildkitd-config $(BUILDKITD_CONFIG) --bootstrap
