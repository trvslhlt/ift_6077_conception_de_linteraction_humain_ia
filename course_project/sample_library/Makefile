# Builds samples/ and library.json from sources.json. Both are checked in, so the study never needs the network;
# rebuild only after changing sources.json or a script. Needs Node >= 22 and ffmpeg.

.PHONY: all synth fetch analyze clean

all: synth fetch analyze ## Rebuild every sample, then measure and check them

synth: ## Synthesize the Circuit kit, synth one-shots, loops and impulse responses
	node scripts/synth.mjs

fetch: ## Download the VCSL sounds at the pinned commit (cached in .cache/) and prepare them
	node scripts/fetch.mjs

analyze: ## Measure every sample, check notes, loop lengths and tags, write library.json
	node scripts/analyze.mjs

clean: ## Remove the download cache (not the samples)
	rm -rf .cache
