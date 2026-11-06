# Jev on the fast tier

Tests whether TypeSafe's Jev, a System One model, can do the fast tier's jobs (STRATEGY.md, "Responsiveness":
about a second, picking and filling in an operation, reading a gesture or a dial), and how long it takes. No
openDAW: each case is a JSON snapshot of the interaction prototype's project and a known right answer.

Jev returns typed judgments (one option from a list, a yes/no probability, a position on a described scale), never
text or numbers it makes up. So every answer here is a choice from candidates that code supplies, or a Score that
code maps to a number.

## Usage

```sh
echo 'TYPESAFE_API_KEY=...' > .env   # git-ignored
make run                              # all families, one request per case (~60 requests)
make run FAMILIES="routing amend"     # some families
REPEATS=3 make run                    # each case 3 times, for steadier latency
```

Needs Node >= 22 on the host; `make run` installs the pinned SDK (`@typesafe-ai/sdk` 0.7.0) on first use. Each run
prints a line per case and a summary per family, and writes everything (answers, probabilities, latency, tokens) to
`results/` (git-ignored). Latency is measured from this machine, one request at a time, after an untimed warm-up.

## Families

| Family | The job | Questions per request |
|---|---|---|
| `routing` | a message to the Team Lead → which member handles it (13 roles, plus "the whole team") | 1 choice |
| `amend` | a `#direction` message → up / down / cancel / reword / keep / unrelated | 1 choice |
| `operation` | a request → one of 8 operations, plus its arguments: parameter, up/down, amount (Score), length, track, pattern, preset, start bar (bars 10–32 offered as candidates) | 9, asked together; code reads the chosen operation's |
| `reading` | a knob log (value per eighth of a bar) → shape and likely intent | 2 choices |
| `dial` | an intent dial's value → which candidate sound, voicing or mix move fits | 1 choice |
| `operation_v2` | as `operation`, with the pattern question reworded and up/down asked in a second request, worded for the chosen parameter ("cleaner, less crunchy") | 9, then 1 |
| `dial_v2` | as `dial`, with code giving the value in words ("all the way toward dusty", "the late 1980s") | 1 choice |
| `fanout` | a Team Lead direction → which members it needs: one yes/no per member, given the roster from `../llm_bench` | 9 nouls |

A case counts as right only if every answer it grades is acceptable; some cases accept several answers ("more
swing": groove or drum programmer). Confidence for a multi-answer case is the least confident of its answers.

## Findings (2026-11-05, `jev-1.14.0`, one run per case)

| Family | Right | Confidence when right / wrong | Latency p50 / p90 | Input tokens |
|---|---|---|---|---|
| `routing` | 14 / 16 | 0.92 / 0.67 | 116 / 124 ms | ~1,040 |
| `amend` | 14 / 14 | 0.81 / – | 104 / 128 ms | ~590 |
| `operation` | 10 / 12 | 0.77 / 0.67 | 123 / 144 ms | ~2,550 |
| `operation_v2` | 12 / 12 | 0.84 / – | 221 / 259 ms (2 requests) | ~3,150 |
| `reading` | 5 / 9 (shape 9 / 9) | 0.70 / 0.46 | 98 / 121 ms | ~1,150 |
| `dial` | 8 / 10 | 0.66 / 0.43 | 101 / 119 ms | ~510 |
| `dial_v2` | 8 / 10 (all non-era right) | 0.72 / 0.38 | 103 / 153 ms | ~460 |

The cases are few and I wrote them; treat the numbers as direction, not measurement.

1. **The fast tier fits, with room to spare.** About 100 ms per request, including the nine-question operation
   request, so a chain of two or three requests still lands well inside STRATEGY.md's "about a second".
2. **Judging meaning is strong.** Routing and direction changes: 28 of 30, including "the kick is too loud" → mix
   engineer, not drum programmer. The two misses were sensible: "how do I set up sidechain myself?" → mix engineer
   (tutor second, 0.36), "find me something like Burial's drums" → drum programmer (researcher second, 0.24). These
   can replace the prototype's keyword matching.
3. **Choosing and filling an operation works when code owns the numbers.** Bars offered as candidates worked
   ("at bar 17" → `bar_17`), and amounts on a Score came out sensibly ("a little" 0.4, "kill" 2.9 of 3). What
   failed was relating a sound to a value: "less crunchy" → bits *down* (wrong; fewer bits is crunchier). Asking
   up/down in a second request, worded for the chosen parameter ("cleaner, less crunchy"), fixed it, and rewording
   the pattern question ("which pattern did they ask for", not "which pattern") fixed "offbeat hats". 12 of 12.
   So: one request picks the operation and its candidates, a second asks anything that depends on the first.
4. **Gesture shape yes, intent no.** Shapes 9 of 9, including the noisy FEATURES.md Crusher example (dip, 0.87).
   Intent leaned to "build" whatever the gesture. Use Jev for the shape; leave intent to the language model, or
   to the producer.
5. **Give dials in words, and facts in data.** A raw value on a range is unreliable (10 on dusty..clean → "clean").
   Worded by code ("all the way toward dusty"), the Harmony and Character dials were 5 of 5. The era dial stayed
   weak (1989 → DX7, 1999 → M1) because it asks Jev to know when gear came out: that belongs in the catalog as
   data, and Jev picks among sounds already filtered to the era.
7. **Routing a direction to members: a fast path for narrow ones only** (`fanout`, 4 of 7, ~105 ms). Narrow
   directions came out clean: "the kick is too loud" → mix engineer 0.95, everyone else ≤ 0.11; "jazzier chords"
   → composer 0.97, everyone else ≤ 0.20. Broad ones put nearly everyone above 0.5 (the house direction: 7
   members; Burial: 8), and a vague one ("make it darker") put everyone near 0.5. Jev also can't write each
   member's piece. So: when one member is far above the rest, route at once with the direction as its piece;
   otherwise hand it to the Team Lead (Claude, 2–5 s).
6. **Confidence alone won't decide when to escalate.** Wrong answers were below 0.75, but so were many right ones
   ("let's not rush this" → down at 0.44; "the kick is too loud" → unrelated at 0.20). A cut-off at 0.5 would send
   a few right answers to the language model, which is cheap insurance when its cost is a second or two. Set it on
   real session logs, not these cases.
