# Judging what the audio measures

Agents can't hear: Claude and Jev take text and images, not audio. The bus would turn the sound into short
summaries per track and for the master (EXPERIMENTS.md, F). This tests the other half: whether models make the
right calls from such summaries, and whether they need them as numbers or in words. The summaries are constructed
from the interaction prototype's project, not measured; measuring is experiment F, which needs openDAW.

| Part | The job | Model |
|---|---|---|
| `selfcheck` | a member made an edit to carry out an intent; given how the audio changed before → after: did it do what was intended, and would a producer notice on laptop speakers? | Jev, 2 yes/no |
| `problems` | given a section's summary and style: what's the main problem, if any, and in which part? | Jev, 2 choices |
| `explain` | answer the producer's question ("why can't I hear the bass?") from the summary | Haiku 5.5, low effort |

Each part runs twice: `raw` gives the summary as JSON numbers, `words` as sentences code writes from them
(`wordSummary`, `wordDiff` in cases.mjs).

## Usage

```sh
make run                          # all parts, both forms; ~50 requests, under $0.05
make run PARTS="selfcheck"        # some parts
```

Keys (`TYPESAFE_API_KEY`, `ANTHROPIC_API_KEY`) are read from `.env` here or `../jev_bench/.env`. Needs Node >= 22;
`make run` installs the pinned SDKs.

## Findings (2026-11-05, `jev-1.14.0`, `claude-haiku-5-5`)

| Part | Raw numbers | In words | Latency |
|---|---|---|---|
| `selfcheck` | 7 / 10 | 9 / 10 (two runs) | ~0.1 s |
| `problems` | 2 / 7 | 4 / 7 | ~0.1 s |
| `explain` | 5 / 5 | 5 / 5 | 1.6–3.4 s |

The cases are few and I wrote them; treat the numbers as direction, not measurement.

1. **Members can check their own edits, if code describes the change in words.** "The keys' highs went 6 dB
   quieter" after "make the keys darker" → yes; nothing changed → no (0.08); the keys still playing after "strip
   to drums and bass" → no; drums down 0.2 dB when 2 were asked → no; the bass up an octave so laptops play it →
   yes, noticed (0.93). The words have to say what matters: the bass made 4 dB louder but still all below
   150 Hz was misjudged until the diff said "still 92% below 150 Hz, which laptop speakers barely play"; then it
   was right (0.20). The remaining miss moves between runs ("whole track darker" at 0.41–0.54): a whole-track
   intent needs the master's change in the diff too, not only each part's.
2. **Spotting problems is code's job, not Jev's.** Asked for "the main problem", Jev answered "crowding" for a
   healthy mix and for a too-loud vinyl, in both forms. What it got right (clipping, a silent part, crowding when
   the summary named it, the inaudible bass in words) are exactly what code rules detect with thresholds anyway.
   So: code flags candidates (clipping, silent, mostly below 150 Hz, two parts in one band); a model judges only
   what a threshold can't, such as whether a loud vinyl is a problem *in this style*. Not tested yet.
3. **Haiku explains well from the summary, in either form.** All ten answers were right and grounded in the
   numbers: "your bass is almost all sub: 92% of its energy sits below 150 Hz... small speakers can't reproduce
   that"; "no, nothing is clipping: the master peaks at -1.5 dBFS". Its fixes, though, used tools the team doesn't
   have (saturation, EQ, a limiter); the explaining member should get the roster too (llm_bench, round two).
4. **Words beat raw numbers for Jev**, as with the dials (jev_bench, finding 5): 13 of 17 against 9 of 17. For
   Haiku the form didn't matter here.
