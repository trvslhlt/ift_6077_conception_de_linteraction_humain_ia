# The knowledge base: design (2026-11-12)

The schema and interface for the idea in STRATEGY.md ("Idea: a local knowledge base"). The utility's side is built
(see "Built" below) but has never run live: Docker was down. Values in the examples are illustrative: no one has
listened to them.

The aim is fewer round trips per reply. The utility should read one entry in place of a web search and a few
source reads. Later, Jev should apply an entry by itself, with no language model.

## Built (2026-11-12, not yet run in the studio)

- **`takedo/knowledge/`** (its README lists sources, pins and limits), about 400 entries:
  - hand-written: `production/lofi`, `genre/boom-bap`, 5 effect chains, 2 Vaporisateur sounds, 12 patterns, 4
    openDAW notes
  - openDAW's 32 Tubular Classics as sounds, plus `sound/dx7-voice` and `note/dx7-library` for all ~1,200 DX7
    voices openDAW bundles (its 38 cartridges, copied in)
  - 117 drum patterns from Groove MIDI
  - 226 chord loops from Chordonomicon, for 34 genres
- **`backend/src/knowledge.ts`:** loading, validation against the catalog (a bad reviewed entry stops startup;
  a bad draft is skipped), the compact index, expansion and drafts.
  - Offline tests: `backend/src/knowledge.test.ts`, run with `make knowledge`.
  - Type-checked.
- **The utility's tools** `knowledge`, `apply_knowledge` and `learn`. The index is sent with the session's first
  message (about 4.6k tokens), and new drafts with later ones.

How the build differs from the design below:
- **Page-side helpers instead of one script per op.** `knowledge/scripts/kb.js` is prepended to every script an
  entry makes. The music is worked out in the backend, where it can be tested, and the page gets pitches, bytes and
  field values.
- **Named ops for what scripts did:** `instrument` (fields by catalog path, on a track or a new one), `dx7` (a
  voice by `cartridge/name`), `pattern` (writes the entry's notes into a new region over the chosen bars,
  clearing them first with openDAW's own clip resolver), `tempo`. `script` still runs a named file, and `entry`
  nests one entry in another.
  - `instrument` and `dx7` can write notes in the same edit, so a new part is never heard half-made.
- **The compact index:** the model sees "key: summary" per entry. A family (`group`) goes on one line of keys with
  short `label`s, such as `pattern/prog-pop-* = common-1 (I V IV), …`, so it can often apply without reading first.
  The full lines, with tags, remain for Jev.
- **Open questions settled:**
  - Key: a chord pattern applied without a key gets the project's, estimated by `analysis.ts`
    (Krumhansl–Kessler), and the result says which.
  - Drum roles: they find pads by name (kick, snare, closed hat…), with fallbacks (rim to snare, ride to closed
    hat), General MIDI notes on a kit with no pads, and a refusal naming the pads when a needed drum is missing.
  - DX7: all bundled banks, loaded by name.
- **Not built:** Jev's route (per the roadmap), and openDAW's own device presets.

## Will it make TakeDo faster? (2026-11-12)

The goal is a resource that speeds up the producer's experience where it can. Here is where the time goes today,
and which parts of this design save any.

**Where the time goes.** The Sonnet runs of experiment G (`takedo/sessions/2026-11-07T16-1*`):
- One utility reply was 8 to 12 model calls in a row, about 15 to 30 s.
- Each call cost about 1 s plus its output at about 180 tokens a second. A look or a small edit (about 100
  tokens) took 1.2 to 2.5 s. A call that wrote a long script or plan (900 to 1,600 tokens) took 5 to 9 s.
- No call was a web search: the utility has none. Searches and source reads add calls, but they weren't what
  made these replies slow.
- Jev's routing requests took about 0.1 s.

So a reply speeds up in three ways: fewer calls, less output per call, or no language model at all (Jev).

**What each part saves, by tier.** The utility already knows most music theory and genre lore. Jev knows only
what it's given and can only choose among options. So the same entry pays off differently in each tier:

| Part | For the utility (language model) | For Jev (fast tier) |
|---|---|---|
| Executable entries (sounds, chains, patterns, scripts) | **Faster.** `apply_knowledge(key, …)` is about 30 output tokens in place of a 500 to 1,500-token script: a 5 to 9 s call becomes 1 to 2 s, and the probing before it goes away. | **The base.** Jev's choice has to end in something code can run. |
| openDAW notes | **Faster and better.** They replace source reads and trial and error (about 2 s each). Source reads made Claude Code's sounds better in G. | Little: Jev doesn't write code. |
| Genre and production write-ups | **Barely faster:** reading lofi's habits is about as fast as recalling them. Their value is consistency, and linking to the executable entries. | **More messages caught.** Jev matches a message against the descriptions it's given. Richer ones ("rainy café study stream", "older", "in another room") catch more messages at about 0.1 s instead of 15 to 30 s. A genre's tempo range and parts are also the options for filling params. |
| Imported datasets | **Quality**, with one exception: grooves and progressions as patterns save the model writing note data, which is long output. | **New moves.** They turn writing into choosing. Jev can't write a progression but can pick one of a genre's ten most common (Chordonomicon), the next chord from Hooktheory's probabilities, or a groove or fill (Groove MIDI). Code writes the notes. "Jazzier chords" or "a fill into bar 8" become fast-tier edits. The data's counts rank the options: common for "keep it simple", rare for "surprise me". |
| The index with each message | A small cost: a few thousand input tokens, cached by the session. | A cost to measure: today's router sends about 1.5k tokens. |

**Conclusion.**
- For the utility alone, executable entries and openDAW notes speed things up. The rest is mostly quality. A
  realistic gain is fewer and shorter calls, maybe 30 to 50% off a reply that an entry covers. That's an
  estimate, not a measurement.
- For Jev, write-ups and datasets are most of what it decides with. Write-ups set how often it catches a
  message. Datasets set what it can do once it has, through patterns.
- The big gain (0.1 s against 15 to 30 s) comes with Jev, which the roadmap brings back after the utility.

**To measure, once Jev is back** (in `poc/jev_bench`):
- How much description per option Jev can take before it gets slower or picks worse.
- How accurately it picks among a few hundred entries after prefiltering by tags and devices.

## Which messages it serves: the bench (2026-11-12)

`make knowledge-bench` (`takedo/backend/src/knowledge.bench.ts`) runs 198 producer messages labelled with the
entries that should be applied, the entries worth reading, and the entry that would have served a miss
(`takedo/knowledge/bench/messages.mjs`). There are 27 observed messages (every distinct one in the session logs), 55 from
jev_bench and 116 simulated. The labels are one person's judgment, against one lofi project. First run, 402 entries:

- **Coverage.** 101 of 198 messages (51%) should have an entry applied: drums 93%, direction 82%, sound and chords
  75%, effects 38%. Levels, arrangement, tempo and chat are 0% by design. Only 4 of the 27 observed messages are hits,
  because experiment G's messages are mostly levels, clips and chat.
- **The shortlist** (`shortlist()` in knowledge.ts: word overlap weighted by rarity, at most 3 entries per family)
  puts a right entry in its top 12 for 97 of the 101 hits. Its misses need meaning, not words: "busier drums",
  "make it less jazzy".
- **36 gaps.** Mostly genre write-ups (house, techno, funk, jazz, reggae, disco, synthwave...), then chains (lush hall,
  sidechain pump, chorus, drum punch) and sounds (hoover, 808 bass, supersaw).

| Picker | Hits picked right | Right "none" (of 97) | Wrong or unwanted applies | p50 | p90 |
|---|---|---|---|---|---|
| Jev: `choice` over the shortlist plus "none" | 86/101 | 77 | 31 | 108 ms | 134 ms |
| Sonnet 5.5, medium effort, given the compact index | 86/101 | 95 | 4 | 1.3 s | 2.5 s |

- **Jev finds hits as well as Sonnet, about 12× faster, but applies too readily.** 20 of the messages where nothing
  should apply got an entry ("make it darker" → tape-dust at 0.98; "what instrument is the bass?" → the sub at 0.87).
  Its confidence doesn't separate these: applies at ≥ 0.7 were right 50 times out of 57. Applying Jev's pick
  without a check would make about one wrong edit in eight.
- **Sonnet is cautious.** Its 13 misses are mostly directions ("evolve this into a lofi girl beat", "make it
  funkier"). It declines to apply one entry for a whole style, which is arguably right. It named a labelled entry to
  read for 96 of the 101 hits. Cost was about 1.7M cached input tokens and 14k output for the run.
- **What follows for the Jev route:**
  - Don't auto-apply on the pick alone. Either gate it with a question first ("is the message asking for a new sound,
    pattern or effect?"), or use Jev's shortlist and pick as hints for the utility (step 3 above). The second option
    saves the search, not the call.
  - The genre write-ups in the gaps are where coverage grows most for directions.
  - Rerun the bench after each batch of entries, and add real messages as sessions produce them.

### Round two: genre write-ups and a stratified Jev (2026-11-12)

New since round one:
- 22 genre write-ups with plans, 3 production styles and 3 drum patterns (430 entries).
- Style-direction labels now count the genre entry, and 8 messages were added for the new genres (206 messages).
- The Jev pickers only see entries that can be applied.

Coverage went from 51% to 54%. Directions went from 82% to 92%, and gaps fell from 36 to 19. The shortlist finds
109 of the 112 hits.

| Picker | Hits right | Right "none" (of 94) | Wrong or unwanted applies | Applies ≥ 0.7 right | p50 |
|---|---|---|---|---|---|
| Jev, one pick over the shortlist | 100/112 | 71 | 32 | 63/75 | 135 ms |
| Jev staged: what kind of change, then a pick among that kind | 98/112 | 81 | 22 | 69/75 | 240 ms |
| **Jev joint: both questions in one request, applied when they agree** | **94/112** | **91** | **7** | **58/60** | **141 ms** |
| Sonnet 5.5, medium, the compact index | 97/112 | 90 | 6 | | 1.2 s |

(Jev joint is the run after limiting candidates to applicable entries, and after letting a "style" answer accept a
drum or chord pattern. The other rows are the run before that.)

- **The joint request is the one to build.** It is as safe as Sonnet (7 bad applies against 6), finds almost as many
  hits (94 against 97), and is 8× faster at Jev's single-request latency. Applies at ≥ 0.7 confidence were right 58
  times out of 60; at ≥ 0.9, 33 of 33. The kind question works as a gate because "none of these" catches levels,
  tempo, arrangement, chat and tweaks to something already there: those categories scored 100%.
- **Staged (two requests) is worse than joint.** Committing to the kind first loses the hits it gets wrong (151 of 182
  kinds right), and it costs a second round trip.
- **Where Jev still misses:**
  - Drums are at 70%, with messages like "busier", "more human", "more swing" and "breakbeat". Fixes would be more
    precise drum summaries, and a "groove" stratum for feel requests.
  - "drum and bass please" is judged "other" with low confidence.
  - The two wrong reverb applies (dub-echo) disappear once a plain hall chain exists (gap: chain/lush-hall).
- **Next for the route:** the joint request in the router (`router.ts`) as a third path. Apply at ≥ 0.8 when the kind
  and the pick agree; otherwise hand the top candidates to the utility.

## Where it sits

| | Notebook (built) | Knowledge base (this design) |
|---|---|---|
| Scope | one project, kept across its sessions | every project |
| Written by | the agent, during a session | us, or promoted from a notebook or from research |
| Holds | this project's plans, clips, sounds, starting state | genres, production styles, sounds, effect chains, patterns, openDAW notes |
| Trust | the agent's own | says how it was checked |

The notebook stays as it is. A notebook entry that worked becomes a knowledge entry by promotion (below).

## Storage

`takedo/knowledge/<kind>/<name>.json` holds one file per entry, hand-written like `catalog/devices.json` (and,
like it, with a `"//"` field for comments). One file per entry keeps diffs small and lets an entry be deleted
without touching the others. `takedo/knowledge/drafts/` holds entries the agents wrote, which no one has
reviewed yet.

The backend loads every entry at startup and validates each one against the catalog (see Validation). Like
`loadCatalog`, it throws on a bad entry, so a broken edit shows at startup and not in the middle of a session.

## Schema

Every entry has the same envelope. What differs by kind is the `body` (prose for the model) and the optional
`apply` (steps the backend can run).

```ts
type Kind = "genre" | "production" | "sound" | "chain" | "pattern" | "note"

type Entry = {
    key: string                 // "<kind>/<name>", the file's path: "sound/rhodes-tubular"
    kind: Kind
    summary: string             // one line, shown in the index with every message
    tags: string[]              // genres and producer words: "lofi", "warm", "dusty", "keys"
    devices: string[]           // catalog keys it uses; validated, and the index can be filtered on them
    links: string[]             // other entries' keys: a genre links its patterns and sounds
    checked: {
        how: "heard" | "measured" | "written" | "imported"   // listened to in the studio / checked with the listening
                                                // tools / written by hand or by an agent / derived from a dataset
                                                // (Existing sources, below)
        by: string, date: string                // "travis", "utility (session 2026-11-07T16:19)"
        opendaw: string                         // the commit it was checked at (catalog/generated.json's `opendaw`)
    }
    sources?: Array<{ title: string, url?: string }>   // for researched entries
    body: string[]              // paragraphs for the model: what it is, when to use it, what to watch out for
    apply?: Apply               // present only on executable entries
}
```

### What each kind carries

**sound**: settings for one instrument that give a known sound. `apply` creates the instrument or sets it up.

```json
{
  "key": "sound/dusty-keys-tubular",
  "kind": "sound",
  "summary": "Soft electric-piano keys on Tubular, a DX7 tine patch, darkened",
  "tags": ["keys", "rhodes", "electric piano", "lofi", "neo soul", "warm"],
  "devices": ["Tubular"],
  "links": ["chain/tape-dust"],
  "checked": {"how": "written", "by": "claude-code", "date": "2026-11-07", "opendaw": "652e6ca…"},
  "body": [
    "Algorithm 5 (three carrier/modulator pairs), as in the classic DX7 E.PIANO 1. Works for chords from C3 to C5. Below C3 it gets muddy, so for bass use a sound made for bass.",
    "To make it duller, lower each modulator's output level, not the cutoff."
  ],
  "apply": {
    "params": {"track": {"type": "track", "about": "the keys track to set; omit to add a new one"}},
    "steps": [{"op": "script", "script": "tubular-settings", "args": {"track": "$track", "settings": {"algorithm": 5, "feedback": 6, "operators/0/level4": 0}}}]
  }
}
```

`settings` map catalog parameter paths to values in the parameter's own units, which is what the existing tools
take. A sound can name a DX7 voice instead (`"dx7": "<base64 of the 155 bytes>"`). The step then calls
`TubularPreset.apply`.

**chain**: effects to add to a track or to the master, with their settings. Optionally it has a dial that the
fast tier can turn (see Amount).

```json
{
  "key": "chain/tape-dust",
  "kind": "chain",
  "summary": "Worn-tape character: bit-crushed, high end rolled off, a slow dark echo",
  "tags": ["lofi", "dusty", "vintage", "tape", "darker"],
  "devices": ["Crusher", "Revamp", "Delay"],
  "links": [],
  "checked": {"how": "written", "by": "travis", "date": "2026-11-12", "opendaw": "652e6ca…"},
  "body": ["Put it on keys or on the whole mix. On drums, ease the crusher back or the hats turn to fizz."],
  "apply": {
    "params": {"track": {"type": "track"}, "amount": {"type": "amount"}},
    "steps": [
      {"op": "add_effect", "input": {"track": "$track", "effect": "Crusher", "settings": [{"param": "bits", "value": {"dial": [14, 9]}}, {"param": "mix", "value": {"dial": [20, 60]}}]}},
      {"op": "add_effect", "input": {"track": "$track", "effect": "Revamp", "settings": [{"param": "lowPass/enabled", "value": 1}, {"param": "lowPass/frequency", "value": {"dial": [9000, 3500]}}]}},
      {"op": "add_effect", "input": {"track": "$track", "effect": "Delay", "settings": [{"param": "feedback", "value": 35}, {"param": "filter", "value": -60}, {"param": "wet", "value": {"dial": [-24, -12]}}]}}
    ]
  }
}
```

**Two kinds of style: genre and production.** A direction names one or both. A *genre* is what's played: tempo,
groove, harmony, form, which parts there are. A *production style* is how it's treated: the sounds, effects, mix
and artifacts. Hip hop is a genre; lofi is a production style. "Lofi hip hop" is the two together, and lofi house
or lofi jazz reuse the same production entry. They're kept apart because they change different things (notes and
parts against effects and the mix), so they combine freely and each can be applied alone ("make it lofi" leaves
the notes alone).

Some names are both (dub, vaporwave, synthwave). Those get one entry of each kind, linked to each other.

**genre**: links its patterns and its usual sounds. `apply`, if there is one, is a staged plan toward the genre
from a typical starting point.

```json
{
  "key": "genre/boom-bap",
  "kind": "genre",
  "summary": "Boom-bap hip hop: 80–95 BPM, swung, sampled-sounding keys or loops, punchy kick and snare",
  "tags": ["hip hop", "boom bap", "90s hip hop"],
  "devices": ["Playfield", "Tubular", "Vaporisateur"],
  "links": ["pattern/boombap-1", "pattern/minor-ii-v-vamp", "sound/dusty-keys-tubular", "sound/sine-sub-vaporisateur", "production/lofi"],
  "checked": {"how": "written", "by": "claude-code", "date": "2026-11-07", "opendaw": "652e6ca…"},
  "sources": [{"title": "Experiment G, Claude Code's run (EXPERIMENTS.md)"}],
  "tempo": [80, 95],
  "body": [
    "Drums: kick on 1 and the 'and' of 2-3, snare on 2 and 4, hats in swung 8ths, an occasional ghost kick.",
    "Harmony: 7th and 9th chords, ii–V–I or a two-chord vamp (Am7 → Fmaj7), voiced around C4.",
    "Bass: round and low, mostly roots on the downbeat."
  ],
  "apply": {
    "params": {"drums": {"type": "track"}, "keys": {"type": "track", "about": "a chordal part, if there is one"}},
    "steps": [
      {"op": "entry", "key": "pattern/boombap-1", "args": {"track": "$drums"}, "at": 0},
      {"op": "entry", "key": "pattern/minor-ii-v-vamp", "args": {"track": "$keys"}, "at": 4}
    ]
  }
}
```

A step can carry `"when": "<param>"`. It is skipped when that param has no value, so one plan serves projects with
or without a keys part (built 2026-11-12). The 22 genre write-ups follow this shape: their drum pattern at bar 0 and
their chord loop at bar 4, with tempo and sounds left to the agent, which the body says.

**production**: links its chains and sounds, says how the mix sits, and can carry `targets` for what the Listening
part measures (brightness, loudness, dynamics), so an agent can check it got there. `apply` is usually chains on
the master or on parts, plus mix moves.

```json
{
  "key": "production/lofi",
  "kind": "production",
  "summary": "Lofi: worn tape and a cheap sampler, dark and soft, slightly unsteady, nothing sharp",
  "tags": ["lofi", "dusty", "vintage", "chill", "study beats"],
  "devices": ["Crusher", "Revamp", "Delay"],
  "links": ["chain/tape-dust", "sound/dusty-keys-tubular", "genre/boom-bap"],
  "checked": {"how": "written", "by": "claude-code", "date": "2026-11-07", "opendaw": "652e6ca…"},
  "targets": {"high_band": "low", "dynamics": "soft"},
  "body": [
    "Everything rolled off above ~8 kHz, reduced bit depth, a little pitch wobble, hiss or crackle under it.",
    "Keys forward, drums back and soft. Slower is usually better: if the genre allows, ease the tempo down over several bars.",
    "Works on most genres: hip hop most often, also house, jazz, ambient."
  ],
  "apply": {
    "params": {"drums": {"type": "track"}, "amount": {"type": "amount"}},
    "steps": [
      {"op": "entry", "key": "chain/tape-dust", "args": {"track": "master", "amount": "$amount"}, "at": 0},
      {"op": "volume", "input": {"track": "$drums", "to_db": -4, "over_beats": 16}, "at": 0}
    ]
  }
}
```

**pattern**: notes with no sound attached: a drum groove, a chord progression or a bass figure. Drum hits are
named by role (kick, snare, closed hat), and chords are written as Roman numerals with durations, so one pattern
fits any kit and any key. `apply` writes it onto a track with a script that maps roles to the track's pads and
numerals to the project's key. Patterns are what the datasets below supply most of. Example (illustrative):

```json
{
  "key": "pattern/boombap-1",
  "kind": "pattern",
  "summary": "Lazy boom-bap, 1 bar: kick 1 and 3-and, snare 2 and 4, swung 8th hats at low velocity",
  "tags": ["hip hop", "boom bap", "drums", "beat"],
  "devices": [],
  "links": [],
  "checked": {"how": "imported", "by": "groove-midi import", "date": "…", "opendaw": "652e6ca…"},
  "sources": [{"title": "Groove MIDI Dataset (Magenta)", "url": "https://magenta.tensorflow.org/datasets/groove"}],
  "body": ["Taken from a human performance at 90 BPM, so the timing is loose on purpose. Quantizing it loses the feel."],
  "apply": {
    "params": {"track": {"type": "track"}, "from_bar": {"type": "number", "default": 0}},
    "steps": [{"op": "script", "script": "write-drum-pattern", "args": {"track": "$track", "from_bar": "$from_bar",
      "hits": [{"role": "kick", "beat": 0, "velocity": 0.9}, {"role": "snare", "beat": 1, "velocity": 0.8}]}}]
  }
}
```

**note**: openDAW knowledge with nothing to apply: the step tables, ranges and API calls that work, such as what
is now hand-written under "Recipes that work" in the utility's prompt, and what a source read found once. `body`
only, plus `fields` (catalog paths it mentions) so validation can tell when the pin moves.

```json
{
  "key": "note/delay-step-table",
  "kind": "note",
  "summary": "What Delay's delayMusical steps mean, and how to get a dotted 8th",
  "tags": ["delay", "sync", "dotted"],
  "devices": ["Delay"],
  "fields": ["Delay/delayMusical", "Delay/preSyncTimeLeft"],
  "links": [],
  "checked": {"how": "written", "by": "utility (source read)", "date": "…", "opendaw": "652e6ca…"},
  "body": ["…"]
}
```

### `apply`: what the backend can run

```ts
type Apply = {
    params: Record<string, Param>     // what the caller must fill in: Jev, the utility, or a parent entry
    steps: Step[]
}
type Param =
    | { type: "track", about?: string }                   // a track ref or "master"
    | { type: "amount" }                                  // 0..3, Jev's existing amount scale
    | { type: "number", default?: number, about?: string }
type Step = { at?: number } & (                           // at: bars after the start; omitted = 0
    | { op: "add_effect" | "set_param" | "remove_effect" | "volume" | "pan" | "mute", input: object }
    | { op: "script", script: string, args: object }      // a named script in knowledge/scripts/
    | { op: "entry", key: string, args: object })         // apply another entry (a production style applying its chain)
```

- **Values.** `"$name"` is replaced with a param. `{"dial": [a, b]}` is a value between `a` (subtle) and `b`
  (the most this entry should go), placed by `amount` (0 → a, 3 → b). This is how Jev's existing "how much" hint
  becomes a setting without a model.
- **Ops are the existing fixed operations,** run through the same path (`#operate`, the bus, the range guard), so
  an entry can do nothing a member couldn't. `script` covers what they don't (a new instrument, notes, tempo)
  with code reviewed once and kept in `knowledge/scripts/<name>.js`, the parameterized scripts of finding 7 in
  experiment G. The code runs as `run` does, with `args` in scope.
- **Timing.** The steps are scheduled together from one playhead (finding 4), at `start + at` bars.

## Interface for the utility (language model)

**The index, once per session.** The first message of an SDK session carries the index: `key`, `summary` and `tags`
for each entry, ~25 tokens per entry. Later messages carry only what changed (a new draft), since the session
keeps its context. Drafts are flagged as drafts. Fifty entries cost ~1.3k tokens. If the index grows past a few
hundred, filter it by the devices in the project and the genres in the conversation.

**Three tools,** next to `remember`, `recall` and `forget`:

| Tool | Input | Returns |
|---|---|---|
| `knowledge` | `keys: string[]` | The entries, in full. Linked entries come back as summaries only, so one call gives a genre or production style and the outline of everything it uses. Read-only. |
| `apply_knowledge` | `key`, `params`, `at_bar` | Expands the steps and schedules them like `run`: "scheduled" at once, with failures reported later. Refuses an entry whose params are missing or don't fit. |
| `learn` | an Entry (no `checked`) | Saves it to `knowledge/drafts/` with `checked.how: "written"`, `by` = this session. It appears in the index as a draft from the next message on. |

`knowledge` takes several keys because round trips are the cost. One call should be enough for a whole
direction.

The SDK's Read and Grep could also read `knowledge/` directly, with the directory added to the session. That
would need no code, but it can't batch, follow links or answer with summaries, so it's a fallback, not the
interface.

**Prompt changes.** Check the index before researching or reading source. When an entry fits, apply it (or
adapt it) rather than rebuilding it. After something the producer liked, `learn` it.

## Interface for Jev (when Jev returns)

A third route next to "fast member" and "slow". After the router's existing request:

1. **Pick.** One `choice` over the executable entries whose `checked.how` is `heard` or `measured`, plus imported
   `pattern`s (notes can't crash the engine, and a dataset's progressions and grooves are plausible by
   construction), each described by its summary and tags, plus "none of these". Sounds and chains only `written`
   or `imported` stay out. The candidates are prefiltered by tags against the message and by devices against the
   project, so the list stays short.
2. **Fill.** Track params come from the existing `part` hint, or from one more `choice` over the tracks with the
   param's `about` as the question. `amount` comes from the existing amount hint. Numbers take their defaults.
3. **Act or hand over.** If the pick's score clears a threshold (like `FastTop`, to be measured), the backend
   applies the entry and the card says which one ("applied tape-dust to the keys, moderate"). Otherwise the
   utility gets the message with Jev's top candidates and their scores, which saves it the search.

This puts the speed-up in content, not code. Each heard, executable entry is one more direction the fast tier
can take.

## Existing sources: content and structure (2026-11-12, to explore)

The knowledge base doesn't have to be written from nothing. Existing datasets and APIs can fill it, and the way
they're organized is worth copying. The sources were checked on the web on 2026-11-12, and none has been
downloaded yet.

### Content we could import

| Source | What it has | Gives us | Catches |
|---|---|---|---|
| [Groove MIDI Dataset](https://magenta.tensorflow.org/datasets/groove) (Magenta) | 1,150 MIDI files of drums played by humans, each labeled with a style (e.g. `funk/groove1`), BPM, time signature, and whether it's a beat or a fill | Drum `pattern`s by genre, with human timing, and fills | Its 18 styles are genres (rock, funk, jazz, hip hop, latin, afrobeat, reggae…). Lofi is a production style, so it wouldn't be there anyway. |
| [Chordonomicon](https://huggingface.co/datasets/ailsntua/Chordonomicon) | 666k songs' chord progressions, with genre, sub-genre, section labels (verse, chorus, bridge) and release year | Common progressions per genre and per section, as numerals with how often each is used | The chords are user-written, so they're noisy. |
| [Hooktheory Trends API](https://hooktheory.com/api/trends/docs) | Next-chord probabilities from a progression, and songs that contain one | A live "what usually comes next" tool, or a cached table | Bearer token from a login, throttled. No data dump. |
| [AcousticBrainz dumps](https://acousticbrainz.org/download) (2022, final) | BPM, key and genre-model outputs for millions of recordings, keyed by MusicBrainz ID | Tempo and key ranges for `genre` entries | The project ended in 2022, and MetaBrainz says the BPM, key and genre data are error-prone. Use it for ranges, not for exact values. Large: 30 archives. |
| DX7 voice banks (public archives) | Thousands of 155-byte voices with names ("E.PIANO 1") | `sound` entries for Tubular, through `TubularPreset.apply` | Named by patch, not by genre, so they need tagging. The names are the useful part for search. |
| openDAW's own presets | Factory presets for its devices | `sound` entries for allowed devices, at the pinned commit | Fetched from `assets.opendaw.studio`, so copy them in locally. Open question above. |
| Wikipedia genre articles | Prose on each genre, plus a structured infobox | `genre` and `production` text and structure (below) | Long. Summarize, so entries stay small. |

Not available: Spotify's audio features (tempo, energy, valence, danceability…). New apps lost access to them, along
with recommendations, on 2024-11-27
([Spotify](https://developer.spotify.com/blog/2024-11-27-changes-to-the-web-api)). Samples (Freesound and others)
stay out, per the earlier scope cut.

### Structure worth copying

- **Wikipedia's genre infobox** splits a genre into stylistic origins, typical instruments, derivative forms,
  subgenres and fusion genres. These could become optional fields on a `genre` (`instruments`, `origins`,
  `related`), so "make it more like its roots" or "push it toward trip-hop" has something to follow.
- **Discogs' two levels, genre then style (Electronic → Downtempo),** and **MusicBrainz's genre list with
  aliases** give a fixed tag vocabulary. Tags drawn from one list match more often, for Jev's prefilter and for
  the model. MusicBrainz's data is open, so its genre names and aliases can be copied in as the tag list.
- **Hooktheory and Chordonomicon** write harmony as scale degrees with probabilities. That's the right shape for
  a progression `pattern`, with a key-free form plus "how common" so the agent can choose between typical and
  unusual.
- **Groove MIDI** splits beat from fill and labels each with a style and tempo. A drum `pattern` should carry the
  same fields: `role: beat | fill`, `bpm`, `meter`.
- **Synth presets (Vital, Surge, and openDAW's own)** are organized by section (oscillators, filter, envelopes,
  LFO, effects) with **macros**: a few named knobs, each mapped to several parameters. Our `dial` is one unnamed
  macro. A `sound` or `chain` could declare named dials instead ("tone", "dirt", "space"), each with its own
  ranges. Then "dustier" and "less roomy" become two independent knob turns that Jev can pick between.
- **Spotify's audio features**, though closed, are a good list of what to measure: tempo, key, mode, energy,
  danceability, acousticness, valence. They split the same way as the styles: tempo, key and danceability describe the genre, while energy,
  acousticness and loudness describe the production. A `production` entry's `targets` use the ones the Listening
  part can measure.

### How importing would work

- An offline step, `make knowledge-import`, in its own container, never at runtime. It writes entries to
  `knowledge/drafts/` with `checked.how: "imported"` and `sources` set. Nothing imported reaches Jev until
  someone has listened to it (Jev only takes `heard` or `measured`).
- Keep derived content (patterns, statistics, ranges, summaries) rather than whole articles, so entries stay small.
  Every entry still names its `sources`, so we know where something came from.
- A good spread, not everything. A first list, about 25 genres and a dozen production styles:
  - **Genres:** boom-bap, trap, R&B / neo soul, funk, disco, house, deep house, techno, UK garage, drum and bass,
    dubstep, downtempo / trip-hop, ambient, jazz, bossa nova, latin, afrobeat, reggae, dub, pop, synth-pop, rock,
    indie, synthwave, vaporwave. Groove MIDI's 18 drum styles shape the list, since they're where the human
    grooves come from.
  - **Production styles:** lofi, vintage tape, 90s sampler (12-bit crunch), 80s (gated reverb, chorus), dub space
    (echo throws, spring reverb), wall of sound (shoegaze), vaporwave (slowed, chorused, washed), bedroom
    (close, dry, intimate), clean modern (bright, tight), club (sidechained, loud), ambient wash, radio or
    telephone, 8-bit.
  - For each genre: tempo range, a few drum patterns (beat and fill), the most common progressions, usual sounds.
    For each production style: a chain or two, mix habits, targets.
- The index has to stay small enough to send with each message: ~40 style entries plus their patterns, sounds
  and chains is a few hundred entries. Filter the index by kind if it gets too big, and let `knowledge` follow
  links to the rest.
- Datasets are pinned like everything else: a version or download date in the import script, and re-running it
  gives the same drafts.

## Validation

At startup, and in `make catalog` when the pin moves:

- `key` matches the file path. `links` and `entry` steps resolve, with no cycles.
- `devices` exist in `catalog/generated.json`. Executable entries use allowed devices only.
- Every parameter path in `apply` and `fields` exists. Every literal and dial end is within the parameter's range.
  This is the range guard applied ahead of time, since one value out of range once crashed the engine.
- `$params` used in steps are declared. Ops are known. Scripts exist.
- `checked.opendaw` differing from the current pin is a warning, not an error: the entry may still be right.

## Promotion

- **From a notebook:** a `sound` or `script` notebook entry that worked becomes a draft, through `learn` by the
  agent or by hand.
- **From research:** the researcher's findings become a `genre` or `production` draft with `sources`.
- **Draft to entry:** a person listens, sets `checked.how` to `heard`, and moves the file out of `drafts/`.
  `make knowledge` could list the drafts with their summaries to make this quick.

## Code shape

`backend/src/knowledge.ts`, beside `catalog.ts` and `notebook.ts`:

```ts
export type Knowledge = {
    index(filter?: { devices?: string[], tags?: string[] }): Array<{ key: string, summary: string, tags: string[], draft: boolean }>
    get(keys: string[]): Array<Entry | { missing: string }>        // linked entries' summaries included
    expand(key: string, args: Record<string, unknown>, snapshot: Snapshot): Array<Step & { at: number }> | string  // string: why not
    draft(entry: Omit<Entry, "checked">, by: string): string        // the new key
}
export const loadKnowledge = (dir: string, catalog: Catalog): Knowledge => { /* load, validate, throw on errors */ }
```

The utility's tools and Jev's route both go through `expand`, so the two tiers apply an entry the same way.

## Open questions

- **openDAW's own presets.** Whether to copy the allowed devices' presets in at the pinned commit, as `sound`
  entries. It's worth checking how many there are and in what format.
- **Groove MIDI bar lines.** Whether each recording's first beat is a downbeat hasn't been checked. A groove may
  start mid-bar until someone listens, which counts against letting Jev apply imported patterns unheard.
- **The index as it grows.** About 4.6k tokens at 400 entries. Past roughly twice that, filter it by the project's
  devices and the conversation's genres.
- **Genre plans against real projects.** A staged plan assumes a starting point ("a chordal part, if there is
  one"). How often the params can't be filled, and whether the utility should adapt a plan rather than apply it,
  is the first thing to watch.
- **How big an entry should be.** Small entries (a sound, a chain) are easy to check and combine. A genre or production style that
  only links to them may be enough, without an `apply` of its own.

## Order of work

Executable entries come first, because that's where the time is saved (see "Will it make TakeDo faster?").

1. **Before building:** run the SDK port once, so a knowledge-base failure isn't confused with a port failure.
   Record a baseline: G's lofi direction on the ported utility. *Waiting for Docker.*
2. **The utility's side.** *Built 2026-11-12, offline-tested only.*
3. **Seed with executable entries and notes.** *Written 2026-11-12, plus the DX7 import.* What's left: a first
   live run of each op (`kb.js` has never run), then listen and mark entries `heard`. The Rhodes is openDAW's own
   Tubular Classics voice, not the patch from experiment G.
4. **Rerun G** with and without the knowledge base. Compare the number of calls and output tokens per reply, not
   only seconds. To turn it off, point `KNOWLEDGE_DIR` at an empty folder.
5. **Imports.** *Groove MIDI and Chordonomicon built 2026-11-12.* What's left: genre and production write-ups for
   the rest of the genre list, which matter most once Jev is back.
6. **Jev's route**, when the roadmap brings Jev back, with the two measurements above.
