# Sample library

52 sounds for the agents to put in openDAW's samplers (Nano, Playfield), on audio tracks, and in Convolver, each
with metadata an agent can choose by: what it is, how it sounds, what it suits, and measurements that back those
claims. Everything is CC0. The study ships this library instead of using openDAW's cloud samples, so it works
offline (project_plan/STRATEGY.md, "Agents change devices").

| Kind | Count | For | What |
|---|---|---|---|
| drum hit | 27 | Playfield | Circuit kit (12, synthesized: 808 and punch kicks, snare, clap, rim, hats, toms, cowbell, crash); Hall Percussion kit (15, recorded: concert bass drum, snare, hats, tom, cymbal, claps, conga, bongos, shaker, tambourine, cowbell, claves, woodblock) |
| one-shot | 16 | Nano | recorded: upright piano, FM electric piano, clavisynth, pipe organ, vibraphone, marimba, glockenspiel, kalimba, harp, tenor sax (held and staccato); synthesized: sub bass, saw bass, string pluck, warm pad, minor 7 stab |
| loop | 5 | Audio Track | house beat and percussion at 120 BPM, boom bap at 90, bassline and chords in A minor at 120 |
| impulse response | 4 | Convolver | small room, bright plate, large hall, speaker cabinet |

## Files

- `library.json`: what agents read. Per sample: `id`, `file`, `name`, `kind`, `category`, `tags`, `description`,
  `devices`; `kit` and `gmNote` (the General MIDI drum note, i.e. the Playfield pad) for drum hits; `note` and
  `midiNote` (sounding pitch, in openDAW's naming: C3 = MIDI 60 = middle C; Nano's root key) for pitched sounds; `bpm`, `bars`, `timeSignature`,
  `key`, `chords` for loops; `source` (origin, licence, link); `measured`: duration, channels, peak and RMS level,
  attack, decay, brightness (spectral centroid, labelled dark/warm/balanced/bright) and, for pitched sounds, the
  detected pitch. About 10k tokens; 5k without sources and the finer measurements.
- `sources.json`: the hand-written half, which the scripts read. Edit this, then `make`.
- `samples/`: 48 kHz 16-bit WAV, peak at -1 dBFS (-0.1 for impulse responses), 16 MB.
- `scripts/synth.mjs`: the synthesized sounds, one seeded recipe each, so a rebuild writes the same files. Loops
  wrap their tails to the start, so they repeat seamlessly.
- `scripts/fetch.mjs`: downloads the recorded sounds from the [Versilian Community Sample
  Library](https://github.com/sgossner/VCSL) (CC0) at a pinned commit, then trims leading silence (so hits land on
  the beat), cuts to a maximum length with a fade-out and normalizes.
- `scripts/analyze.mjs`: measures every file, writes `library.json`, and fails if a claim doesn't hold: a note
  more than 50 cents off, a loop not exactly `bars` long at `bpm`, or a "bright"/"dark" tag against the measured
  brightness.
- `scripts/audio.mjs`: WAV I/O and the DSP the others share (no dependencies).

## Usage

```sh
make            # synthesize, fetch, analyze: rebuilds samples/ and library.json (Node >= 22, ffmpeg)
make analyze    # only re-measure and rewrite library.json, e.g. after editing descriptions
make clean      # remove the download cache
```

Built with Node 26.8 and ffmpeg 9.0.1. ffmpeg only resamples the recorded sounds, so another version may change
their samples slightly, not their metadata.

## Notes

- **Note names follow openDAW: C3 = MIDI 60 = middle C** (its piano roll), one octave below scientific naming
  (C4 = 60). `midiNote` is the unambiguous reference.
- **VCSL's note names aren't consistent.** Most instruments happen to use openDAW's naming; the harp and FM piano
  use scientific naming, so they sound an octave below their file names, and the Clavisynth sounds an octave
  above. `note` is always the measured sounding pitch, and `source.path` keeps VCSL's file name.
- Descriptions and tags are ours, written from what each VCSL file is (instrument, articulation, dynamic) and our synthesis recipes and checked
  against the measurements, not by listening. Treat them as a first draft to refine by ear and in pilot sessions.
- The brightness labels are relative to all sounds, not within a category: every kick is "dark", every hi-hat
  "bright". A tag like "bright" on a tom compares it with other toms, and the check only rejects outright
  contradictions.
