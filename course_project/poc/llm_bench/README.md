# Claude on the slow tier

Tests the slow tier's two jobs (STRATEGY.md, "Responsiveness") with Claude, and how long they take. No openDAW:
each case is a JSON snapshot of the interaction prototype's project.

1. **Team Lead:** split a producer's direction among the members whose areas it touches (structured output: a
   short reply and one piece per member), or ask one question when the direction is too vague.
2. **Member:** turn its piece into edits, as calls to an operation library (strict tools: `ramp_param`,
   `set_param`, `swap_preset`, `set_pattern`, `set_mute`, `add_part`, `write_notes`). The calls aren't executed.
3. **End to end:** the Team Lead, then its members in parallel: how long from a direction to every member's edits.

## Usage

```sh
make run                      # all three parts, claude-haiku-5-5 at effort low, with the roster: ~25 calls, ~$0.02
make run PARTS="lead member"  # some parts
MODEL=claude-opus-5-5 EFFORT=medium make run   # other models and efforts (a model needs its price in PRICE, bench.mjs)
ROSTER=0 make run             # round one: no roster, every member gets every operation
```

The key (`ANTHROPIC_API_KEY`, a Claude Console key) is read from `.env` here or `../jev_bench/.env`, both
git-ignored. Requests stop once a run's spending reaches `BUDGET` (default $5). Requests use the server-side
`fallbacks: "default"` option, so a request a safety classifier declines is retried on a fallback model. Results
land in `results/` (git-ignored). Needs Node >= 22; `make run` installs the pinned SDK (`@anthropic-ai/sdk`
1.1.0) and zod (4.6.7).

The checks are automatic and coarse (right members brought in, an expected operation used, landing bars ahead of
the playhead, values in range, notes in key and in the bars asked for); the printed plans are the real result,
for reading.

## Round one (2026-11-05, `claude-opus-5-5`, one run per effort, $1.90 in all)

| | Medium effort | Low effort |
|---|---|---|
| Team Lead: checks passed | 7 / 8 | 7 / 8 |
| Team Lead: latency p50 / max | 5.2 / 10.7 s | 3.7 / 6.3 s |
| Member: checks passed | 9 / 9 | 9 / 9 |
| Member, operations only: latency | 3–13 s | 2–7 s |
| Member writing notes: latency | 19–41 s | 11–33 s |
| Direction to all members' edits | 20–43 s | 15–36 s |
| Cost of a direction, end to end | $0.12–0.22 | $0.10–0.22 |

The cases are few and I wrote them; treat the numbers as direction, not measurement.

1. **The Team Lead splits well.** Pieces are specific to the project ("lower the Filter cutoff from 35% to around
   20–25%"), a narrow request goes to one member ("the kick is too loud" → mix engineer only), and "make it
   better" got a question instead of a team. The one failed check is my rubric's: for the house direction it gave
   the keys to the effect designer, not the instrument designer.
2. **Members plan edits well.** Every case passed at both efforts: staged pattern changes (four-on-the-floor at
   13, hats at 17, full house at 21), a riser whose ramp ends exactly on bar 17 (13 + 4 bars), mutes at 17 and back
   at 25, everything ahead of the playhead, values in range, basslines in key with the octave bounce asked for. An
   impossible piece ("re-harmonize the vocal") got no calls and a one-line reason.
3. **The Team Lead promises what the team can't do.** It hands out tempo ramps, sidechain, reverb, a rain layer,
   impacts and swing, none of which the operations offer. Members then either say what's missing (groove: "no
   swing, quantize or timing control") or quietly do part of it (the mix engineer faded the vinyl and dropped the
   sidechain without a word). The Team Lead should be given what the operations can do, and a member's "missing"
   should reach the producer (the wishlist, FEATURES.md).
4. **Members step on each other.** In the house direction the arranger also changed the drum pattern and swapped
   the bass preset, and three members ramped the keys' parameters at bar 10; for "make it darker" the composer
   also rewrote the bass. The bus should refuse operations outside a member's role (TAKEDO_API.md, "Team") and
   claims should cover targets, as planned; this confirms it's needed, not optional.
5. **Writing notes is the slow part, and it's output-bound.** 30–110 notes as JSON is 2,000–5,000 output tokens:
   15–40 s, and low effort barely helps. At 96 BPM an 8-bar phrase lasts 20 s, so new material has to be prepared
   one or two phrases ahead ("prepare, then fire on cue", STRATEGY.md), or the output shrunk: higher-level
   operations such as a one-bar pattern that code repeats and transposes per chord, instead of every note.
6. **Low effort looks good enough for everything but writing notes.** It roughly halved the Team Lead's and the
   operation-only members' latency with no loss visible in these cases. Faster models (Sonnet 5.5, Haiku 5.5) are
   untested here.
7. **Cost is small.** A full run (25 calls) is about $1; one direction end to end is $0.10–0.22, most of it
   the note writers' output.

## Round two: a roster and owned operations (Opus 5.5, low effort, $0.76)

Findings 3 and 4 suggested two changes, both now the default (`ROSTER=0` turns them off):

- **A roster for the Team Lead,** the way members get the operations: each member's area and what its
  operations can do (`ROSTER` in cases.mjs), plus what the team can't do at all (`TEAM_CANNOT`).
- **Each member gets only its own operations,** narrowed to its targets: the mix engineer can ramp volumes but
  not the filter, the effect designer the reverse. With the first member to touch a target owning it, the run
  counts any second member touching it as a conflict.

| Round one → round two (Opus, low effort) | Before | After |
|---|---|---|
| Team Lead checks passed | 7 / 8 | 8 / 8 |
| Pieces asking for something no operation offers (keyword count) | 7 | 2 |
| Conflicts over a target, 4 directions | 7 | 0 |
| Edits outside a member's role, 4 directions | 11 | 0 |
| Member input tokens (fewer tools) | ~3,600 | 1,100–1,900 |

The Team Lead now says what it's leaving out: "the kick is too loud" → "we can't adjust the kick alone or EQ it,
so the whole kit comes down"; Burial → "reverb, swing and vocal samples are beyond what we can do". So the
registry the members keep can mostly be static (role → operations → targets); claims are left for targets two
roles share.

## Round three: cheaper models (roster on, low effort)

| | Opus 5.5 | Sonnet 5.5 | Haiku 5.5 |
|---|---|---|---|
| Team Lead checks passed | 8 / 8 | 6 / 8 | 6 / 8 |
| Member checks passed | 9 / 9 | 6 / 9 | 8 / 9 |
| Team Lead latency, p50 / max | 3.4 / 6.8 s | 2.8 / 6.5 s | 3.5 / 4.7 s |
| Member writing notes | 15–42 s | (wrote none) | 10–18 s |
| Direction to all members' edits | 10–49 s | 6–8 s (no notes) | 9–21 s |
| Whole run (~25 calls) | $0.76 | $0.24 | $0.02 |

- **Haiku 5.5 is the pick.** About as good as Opus on these cases, faster at writing notes, and a fortieth of
  the cost. Its misses: the Team Lead brought one member for "make it darker" (the rubric wants two) and left out
  the instrument designer for the house direction, as every model did; one member landed an edit on the playhead's
  bar, which the bus refuses anyway; and it chose a Juno pad (1980s) for "90s", the same era-knowledge gap Jev
  has, which belongs in the catalog as data.
- **Sonnet 5.5 at low effort is not usable here:** it called `write_notes` with no notes at all, landed a riser
  on the playhead's bar, and brought three members to "strip it back". Higher effort might fix it; not tried.
- Opus stays the reference for quality, at about 40 times Haiku's price.
