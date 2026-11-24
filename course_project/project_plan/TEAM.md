# The team: roles and members (draft, 2026-11-23)

A draft for discussion, not a spec. It separates two things today's piece *kinds* mix together:

- **Roles** are cut by openDAW: a slice of the DAW with its tools, the context it needs, recipes, limits and guards.
  They are mechanical and checkable in code (a role's recipes and guards can each have a smoke check).
- **Members** are cut by music: a way of hearing and judging the work. A member turns the producer's words ("lazier",
  "warmer", "less busy") into changes, reached through one or more roles. Members are who the producer sees and
  addresses (`@performer`); roles stay internal.

A worker would be a pair, member × role: the role's section of the prompt says how to do it in openDAW, the
member's says what to listen for and what to protect. No extra agents or hops: one worker, two prompt sections.
Members don't talk to each other yet; if two pieces conflict, the Team Lead sorts it out (later, and only if needed:
it makes troubleshooting harder).

## Roles (openDAW surfaces)

| Role | What it changes | Tools and recipes it carries |
|---|---|---|
| Notes | the notes in note regions: pitch, timing, length, velocity | evolve_notes, writing notes, pitch ranges and the key, a kit's pads |
| Device settings | an instrument's or effect's parameters | set_param, effect_params, ranges and units, presets (DX7 voices) |
| Device chain | which instruments and effects there are, in what order | add/remove effect, new instrument tracks, the catalog's limits |
| Mix | level, pan, mute over time | volume, pan, mute ramps; held controls; automation lanes |
| Routing | how tracks feed each other: sidechain inputs, sends, buses | the sidechain recipe (kb.sidechain), no loops between tracks |
| Tempo | the tempo map | tempo automation (the recipe), the BPM range guard |
| Arrangement | where composed material plays: regions placed, copied, moved, lengthened, muted, by section | region and timeline recipes |

Arrangement here is the producer's sense: sequencing parts that already exist into a fuller piece (a few ideas in
the project, put in order), not writing notes. Whether it also needs a member is open (below).

Routing was added after asking how "sidechain the drums and bass" would be handled: wiring one track into another's
device crossed every other role, and its tools and guards (pointers between tracks, no loops) are its own.

Today's kinds map onto these: drums and notes → Notes; sound → Device settings (+ chain); effects → Device chain
(+ settings); mix → Mix; tempo → Tempo; arrange → Arrangement.

## Members (draft)

Cut by what a member does to the music, not by instrument, so they hold across genres: an orchestral piece, a techno
track and a jazz trio all have parts that are written, played, voiced, mixed and paced. What a part *is* (rhythm, the
low end, harmony, a melody, a texture) is a fact about the part, kept in the notebook's facts with its register, not a
member: the composer writes a bass line, a string pad or a hi-hat pattern with the same judgment, guided by what that
part is for.

Each has: what they hear, the words they take, the roles they reach through, what they protect, and where they
border others (the cases a router must learn).

### Composer (`@composer`)
- **Hears:** which notes there are: rhythm patterns, chords and voicings, lines and their contour, how the parts fit
  (the low end under the harmony, a counter-line answering the lead), density.
- **Takes:** busier, sparser, simpler, darker or brighter harmony, add a line, answer the melody, a fill, change the
  chords, more movement.
- **Reaches through:** Notes; Device chain for a new part's track.
- **Protects:** the key, each part's function and register (MIDI numbers in facts), the loop's length.
- **Borders:** "busier" is the composer (more notes); "more energy" may be the performer (harder, pushed), the
  conductor (more parts) or the composer.

### Performer (`@performer`)
- **Hears:** how the notes are played: time feel (straight, swung, behind or ahead of the beat), dynamics and accents,
  articulation (short, long, legato), human variation.
- **Takes:** looser, tighter, laid back, pushing, softer, harder, more swing, more human, staccato, smoother.
- **Reaches through:** Notes (timing, velocity, length of existing notes; never which notes), sometimes Device
  settings that shape playing (an envelope's attack and release).
- **Protects:** the notes themselves: pitches and the pattern stay; the downbeat.
- **Borders:** "the snare's too loud" is the performer (velocity) or the mix engineer (level): the performer's answer
  changes how it's played, the mix engineer's how it's heard.

### Sound designer (`@sound_designer`; the prototype called it the instrument designer)
- **Hears:** timbre: warm, bright, dusty, glassy, thin, full; instrument choice; effects that are part of a sound (a
  crusher on a beat, a chorus on a pad).
- **Takes:** warmer, darker, vintage, cleaner, a different instrument, more character.
- **Reaches through:** Device settings, Device chain.
- **Protects:** the part's function and register; its loudness (a sound change shouldn't jump in level).
- **Borders:** effects for space (reverb and delay as depth) are the mix engineer's; effects for character are the
  sound designer's. The same device can be either. "Warmer" on one part is usually the sound designer; on the whole
  track, the mix engineer.

### Mix engineer (`@mix_engineer`)
- **Hears:** the whole: balance, space and depth, the low end shared by parts, stereo width, loudness, the master.
- **Takes:** louder, quieter, further back, more room, wider, glue, the low end cleaner, the master warmer.
- **Reaches through:** Mix; Routing (sidechains, sends); Device settings and Device chain on the master and for space.
- **Protects:** the producer's held and hand-set controls; headroom.
- **Borders:** see the performer and the sound designer.

### Conductor (`@conductor`; from the proposal)
- **Hears:** time and form: tempo and its changes, which parts play when, energy over the piece.
- **Takes:** slower, faster, ease into it, drop a part for 8 bars, build, a breakdown, bring everything back.
- **Reaches through:** Tempo, Arrangement, Mix (mutes).
- **Protects:** the downbeat and the loop; changes landing on phrase boundaries.
- **Borders:** "make it lift here" is the conductor (more parts), the mix engineer (level, width) or the composer
  (busier parts): usually a direction the Team Lead splits.

## A worked example: "sidechain the drums and bass"

- **Read as:** the bass ducks each time the drums hit, to make room in the low end (the drums are the trigger and stay
  as they are).
- **Member:** the mix engineer. "Sidechain" names a technique, so it routes by what it does (balance), not by the
  tracks it names. The sound designer only if the pumping is wanted as a sound (a pumping pad).
- **Roles:** Device chain (a compressor on the bass), Routing (its side-chain input from the drums), Device settings
  (threshold, ratio, fast attack, a release that recovers within a beat, auto makeup off), Mix (the bass's level after).
- **In code:** knowledge entry chain/sidechain-duck runs kb.sidechain; the smoke test checks the wiring in openDAW.
- **Caveat the member should say:** the source is the whole drum track, so snare and hats duck the bass too; a duck
  on the kick alone needs the kick on its own track.

## Open

- **Arranger.** In the producer's sense (sequencing composed ideas into a fuller piece) it's the Arrangement role.
  Whether it also needs a member: the conductor covers form and energy; a separate arranger member would only earn
  its place when projects have several ideas to sequence, which no scenario has yet. Proposal: role now, member
  later if a scenario needs it.
- **The proposal's agents.** The proposal names performance, arrangement (writing notes), mix and conductor agents.
  This draft keeps them (its arrangement agent is the composer here, since "arranger" now means sequencing), and adds
  the sound designer. Close enough that the final report only needs to note the renaming and the addition.
- **An earlier cut by instrument** (drummer, bass, keys) was too genre-specific; the part's function is a fact about
  the part instead.
- **Routing.** A note can name a member (`@performer`), a track ("the hats"), or neither ("warmer"). The bench
  (next) labels each note with its members, roles and tracks; the borders above are its hard cases.
- **Names and voice.** Plain role names for now; personalities only if the producer study needs them.
