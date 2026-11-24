# The team: roles and members (draft, 2026-11-23)

A draft for discussion, not a spec. It separates two things today's piece *kinds* mix together:

- **Roles** are cut by openDAW: a slice of the DAW with its tools, the context it needs, recipes, limits and guards.
  They are mechanical and checkable in code (a role's recipes and guards can each have a smoke check).
- **Members** are cut by music: a way of hearing and judging the work. A member turns the producer's words ("lazier",
  "warmer", "less busy") into changes, reached through one or more roles. Members are who the producer sees and
  addresses (`@drummer`); roles stay internal.

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
| Tempo | the tempo map | tempo automation (the recipe), the BPM range guard |
| Arrangement | where composed material plays: regions placed, copied, moved, lengthened, muted, by section | region and timeline recipes |

Arrangement here is the producer's sense: sequencing parts that already exist into a fuller piece (a few ideas in
the project, put in order), not writing notes. Whether it also needs a member is open (below).

Today's kinds map onto these: drums and notes → Notes; sound → Device settings (+ chain); effects → Device chain
(+ settings); mix → Mix; tempo → Tempo; arrange → Arrangement.

## Members (draft)

Each has: what they hear, the words they take, the roles they reach through, what they protect, and where they
border others (the cases a router must learn).

### Drummer (`@drummer`)
- **Hears:** the groove: time feel (straight, swung, behind or ahead of the beat), dynamics and accents, ghost notes,
  density, fills, how the kick sits with the bass.
- **Takes:** looser, tighter, lazy, laid back, pushing, busier, sparser, half-time, more ghost notes, softer hats.
- **Reaches through:** Notes (mostly), Device settings (a kit's decay or tune), Mix (the kit's inner balance).
- **Protects:** the backbeat and the downbeat unless asked; the kick's lock with the bass; the loop's length.
- **Borders:** "the snare's too loud" is the drummer (velocity) or the mix engineer (level). A drummer's answer
  changes how it's played, the mix engineer's how it's heard.

### Bass player (`@bass`)
- **Hears:** the low end as a part: root motion, register, note length, how it locks with the kick, space.
- **Takes:** simpler, walking, rounder, longer notes, follow the kick, lower, more movement.
- **Reaches through:** Notes, Device settings (the bass sound's filter and envelope), Mix (shared with the mix
  engineer for level).
- **Protects:** the key and the bass register (MIDI numbers in facts); the root under chord changes.
- **Borders:** "warmer bass" is the bass player (longer, lower notes), the sound designer (filter, tone) or the mix
  engineer (EQ). Most often the sound designer.

### Keys (`@keys`)
- **Hears:** harmony and the parts above the bass: chords, voicings and extensions, comping rhythm, melodic lines.
- **Takes:** jazzier, darker, brighter chords, sevenths, sparser comping, a melody, answer the bass.
- **Reaches through:** Notes, Device settings, sometimes Device chain (a new keys track).
- **Protects:** the key, voice ranges, the bass's register (keys stay above it).
- **Borders:** "make it jazzier" spans keys (extensions), drummer (swing) and bass (walking): a direction the Team
  Lead splits, not one member's.

### Sound designer (`@sound_designer`; the prototype called it the instrument designer)
- **Hears:** timbre: warm, bright, dusty, glassy, thin, fat; instrument choice; effects that are part of a sound
  (a crusher on the drums, a chorus on the keys).
- **Takes:** warmer, darker, lofi, vintage, cleaner, a different instrument, more character.
- **Reaches through:** Device settings, Device chain.
- **Protects:** the part's role and register; levels (a sound change shouldn't jump in loudness).
- **Borders:** effects for space (reverb, delay as depth) are the mix engineer's; effects for character are the sound
  designer's. The same device can be either.

### Mix engineer (`@mix_engineer`)
- **Hears:** the whole: balance, space and depth, the low end shared by kick and bass, stereo width, loudness, the
  master's colour.
- **Takes:** louder, quieter, further back, more room, wider, glue, bass under the kick, the master warmer.
- **Reaches through:** Mix, Device settings and Device chain on the master and for space.
- **Protects:** the producer's held and hand-set controls; headroom.
- **Borders:** see the drummer and the sound designer.

### Conductor (`@conductor`; from the proposal)
- **Hears:** time and form: tempo and its changes, which parts play in each section, energy over the piece.
- **Takes:** slower, faster, ease into it, drop the drums for 8 bars, build, a breakdown, bring everything back.
- **Reaches through:** Tempo, Arrangement, Mix (mutes).
- **Protects:** the downbeat and the loop; changes that land on phrase boundaries.
- **Borders:** "make the chorus lift" is the conductor (more parts) or the mix engineer (level and width) or the
  players (busier parts): usually a direction for the Team Lead to split.

## Open

- **Arranger.** In the producer's sense (sequencing composed ideas into a fuller piece) it's the Arrangement role.
  Whether it also needs a member: the conductor covers form and energy; a separate arranger member would only earn
  its place when projects have several ideas to sequence, which no scenario has yet. Proposal: role now, member
  later if a scenario needs it.
- **The proposal's agents.** The proposal names performance, arrangement (writing notes), mix and conductor agents.
  This draft folds performance and note-writing into the players (drummer, bass, keys: each performs and writes its
  own part), keeps mix and conductor, and adds the sound designer. The final report should say so.
- **Melody and other parts.** A lead or vocal-like part has no member yet; keys covers melodic lines for now.
- **Routing.** A note can name a member (`@drummer`), a track ("the hats"), or neither ("warmer"). The bench
  (next) labels each note with its members, roles and tracks; the borders above are its hard cases.
- **Names and voice.** Plain role names for now; personalities only if the producer study needs them.
