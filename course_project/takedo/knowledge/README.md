# The knowledge base

What the agents would otherwise look up or work out again every session, as small named entries, some of which code
can apply. The design and the reasons for it are in `project_plan/KNOWLEDGE.md`; the loader, validation and
expansion are in `backend/src/knowledge.ts`. Mounted into the backend read-write (drafts are written here).

```sh
make knowledge          # check every entry offline (against the catalog), the music helpers and expansion
make knowledge-import   # rewrite the imported entries (DATASETS=<dir> with groove/ and chordonomicon/, see below)
make knowledge-bench    # which producer messages the entries serve (offline); PICKERS="jev claude" asks the models too
```

## Layout

| Path | What |
|---|---|
| `<kind>/<name>.json` | one entry; its key is `<kind>/<name>`. Kinds: `genre`, `production`, `sound`, `chain`, `pattern`, `note` |
| `drafts/<kind>/<name>.json` | entries an agent kept with `learn`, not yet reviewed (created on first use) |
| `scripts/kb.js` | the page-side helpers every entry's scripts run with (new instruments, DX7 voices, writing notes, tempo) |
| `dx7/*.syx`, `dx7/index.json` | the 38 DX7 cartridges openDAW bundles for Tubular (~1,200 voices), copied from openDAW 652e6ca's `packages/app/studio/public/tubular` |
| `import/*.mjs` | the imports that write the generated entries (deterministic: same input, same files) |
| `bench/messages.mjs` | producer messages (observed in the session logs, from jev_bench, simulated), each labelled with the entries that would serve it; read by `backend/src/knowledge.bench.ts`. Results go to `bench/results/` (git-ignored) |

A reviewed entry that doesn't validate stops the backend at startup, like the catalog; a draft that doesn't is
skipped with a warning.

## What's here (2026-11-12)

| Source | Entries | How checked |
|---|---|---|
| Hand-written (`claude (knowledge seed)`, from experiment G and openDAW's source) | `production/lofi`, `genre/boom-bap`, 5 chains, 2 Vaporisateur sounds, 12 patterns (drums and chords), 4 notes | `written`: no one has listened |
| Hand-written genre write-ups (`claude (genre write-ups)`, 2026-11-12) | 22 genres (house, deep house, techno, trap, drum & bass, UK garage, trip hop, ambient, synthwave, synth-pop, disco, funk, neo soul, gospel, jazz, bossa nova, reggae, dub, afrobeat, rock, pop, lofi hip hop), each with a plan: its drum pattern on the drums, then its chord loop on the keys four bars later (steps skipped for parts the project lacks, `"when"`); `production/dub`, `production/synthwave` and `production/clean-modern` (the last two read-only, no chains yet); 3 drum patterns they needed (`dnb-two-step`, `uk-garage-2step`, `one-drop`) | `written` |
| `import/dx7.mjs`: openDAW's Tubular Classics | 32 sounds, `sound/dx7-voice` (any bundled voice by name), `note/dx7-library` (every voice name) | `imported` |
| `import/groove.mjs`: Groove MIDI Dataset | 117 drum patterns: two 2-bar beats per style and sub-style, one fill per style, human timing kept | `imported` |
| `import/chordonomicon.mjs`: Chordonomicon | 226 chord loops: per genre (34 of our list), the 4 most common and 3 most characteristic | `imported` |

Nothing has been heard in the studio yet. Promote an entry by listening, then setting `checked.how` to `heard`.

## Datasets (for `make knowledge-import`)

Download into `DATASETS` (default `takedo/.datasets/`, git-ignored), each in its own folder:

| Folder | Download | Pin |
|---|---|---|
| `groove/` | `https://storage.googleapis.com/magentadata/datasets/groove/groove-v1.0.0-midionly.zip`, unzipped (gives `groove/groove/info.csv`; pass the outer folder) | sha256 `651cbc524ffb891be1a3e46d89dc82a1cecb09a57c748c7b45b844c4841dcc1e` |
| `chordonomicon/` | `https://huggingface.co/datasets/ailsntua/Chordonomicon/resolve/f3a8b678bd65639c01caa342921733f1db01be23/chordonomicon_v2.csv` (264 MB) | sha256 `9d2f4ccdc876a4e816712f128e4772b2af558c2a2923cce5be3a0364fbad9a8d` |

The Chordonomicon import reads 680k songs in about 75 s.

## Known limits

- **Groove MIDI bar lines.** The recordings follow a click, so the beat grid is right, but whether every
  recording's first beat is a downbeat hasn't been checked: a groove may start mid-bar until someone listens.
- **Chordonomicon is user-written chord charts** with each song's key estimated from its chords. Common loops are
  dominated by the same few (I V IV, I V vi IV) in every genre; the characteristic ones are where a genre shows.
  Jazz charts there are mostly simplified triads.
- **`kb.js` has never run in the studio** (written against openDAW 652e6ca's source). In particular it assumes
  `lib.adapters.TubularPreset` and `lib.core.RegionClipResolver` are exported, and says so if they aren't.
