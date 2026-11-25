import {existsSync} from "node:fs"
import {createSdkMcpServer, query, type Query, type SDKUserMessage, tool} from "@anthropic-ai/claude-agent-sdk"
import type Anthropic from "@anthropic-ai/sdk"
import type {CallToolResult} from "@modelcontextprotocol/sdk/types.js"
import {z} from "zod"
import type {Actor, Note, Plan, Snapshot, Status, When} from "../../shared/protocol.ts"
import {type Action, type Anchor, commitAnchor, type Direction, type Piece, type PieceKind, PieceKinds, type Step as BoardStep} from "./board.ts"
import type {Coordinator} from "./coordinator.ts"
import type {Catalog} from "./catalog.ts"
import {drumMap, type Knowledge, shortlist} from "./knowledge.ts"
import {analyse} from "./analysis.ts"
import {hitOf, morphNotes, targetHitOf, tile} from "./generate.ts"
import {chordHits, type ChordSpec, drumHits, melodyHits, type MelodySpec, type MiniSpec, rangeOf} from "./compose.ts"
import {Kinds, type Kind} from "./notebook.ts"
import {Limits, type LlmMember, type Member, performStep, projectFor, type Task} from "./members.ts"

// The utility (STRATEGY.md, "Keep the open path"): anything openDAW can do that the members' fast operations don't
// cover, done in openDAW directly with code, the way the first live experiment did it (poc/edit_bench/live/eval.mjs). It looks around with read-only
// JavaScript, edits with scripts (each one edit, one undo step, attributed to it, refused for controls the producer
// holds), sees the result or the error, and tries again. It also has every member's fixed operations as tools,
// borrowed from them, for whatever they cover: those land on bars, ramp over time and are checked before they run.
// Slow-tier work, seconds to tens of seconds. Each instance is a worker: the captain (captain.ts) hands it one piece,
// it plans it in a fresh session, and reports back; its timed steps go out when it's done (Coordinator).
//
// It runs as a Claude Agent SDK session (decided 2026-11-11, STRATEGY.md): Claude Code's loop as a library. Our tools are an
// in-process MCP server ("takedo"); openDAW's source is read with Claude Code's own Read, Grep and Glob, from the
// pinned tree `make types` copies out (the session's working directory).

// Tool calls per message: a whole transformation takes looks, scripts and fixed operations (the hand-written loop
// allowed 30 rounds of several calls; running out made it stop halfway and offer the rest).
const MaxCalls = 80
// What a worker starts with follows its piece's kind (2026-11-23: a third of its context was the whole knowledge index,
// and every tool came with every piece). Not a gate: run and look reach anything openDAW supports, knowledge searches.
const EffectKinds: PieceKind[] = ["effects", "sound"]
const ToolKinds: Record<string, PieceKind[]> = {
    evolve_notes: ["drums", "notes", "arrange"],
    add_effect: EffectKinds, remove_effect: EffectKinds
}
// The project with effect settings only on the piece's own tracks; the rest by name.
const focus = (project: ReturnType<typeof projectFor>, tracks: string[]) => ({...project,
    tracks: project.tracks.map(track => tracks.includes(track.ref) ? track
        : {...track, effects: track.effects.map(({ref, device, name}) => ({ref, device, name}))})})
const MaxRecall = 40000
const SourceTools = ["Read", "Grep", "Glob"]

// One task's edits: what landed (for the card and the reply), what's still landing, and failures nobody's heard yet.
type Work = { done: string[], pending: Promise<string>[], late: string[] }
// The message being worked on, for the tools' handlers (one at a time: they share the session). direction: its entry
// on the board, which holds its timed edits until the turn ends.
type Current = { context: Coordinator, task: Task, work: Work, calls: number, said?: string, direction: Direction,
    anchor: Anchor | null, applied?: string[], appliedBars?: number, job?: string }   // job: a worker's piece   // applied: what a knowledge entry's steps said they'd do (the fast route's reply)
const anchored = (when: When, anchor: Anchor | null): When =>
    when.at === "bar" && anchor !== null ? {...when, from: {position: anchor.position, played: anchor.played}} : when

// What the producer reads must be a chat line (INTERACTION.md, "Who speaks in the chat"): the prompt alone didn't hold
// (a 9-sentence bulleted reply, 2026-11-21), so the reply tool refuses anything else and says what to fix.
export const MaxReplySentences = 2, MaxReplyChars = 240
const sentencesIn = (text: string): string[] => text.split(/(?<=[.!?])\s+/).filter(part => part.trim() !== "")
export const replyProblem = (text: string): string | null => {
    const trimmed = text.trim()
    if (trimmed === "") {return "it's empty"}
    if (/\n/.test(trimmed)) {return "it has line breaks: write one short paragraph"}
    if (/(^|\s)[-*•]\s|\*\*|^#|`/.test(trimmed)) {return "it has list marks or markdown: write plain sentences"}
    if (/\b(haven't|have not|didn't|did not|can't|cannot) (heard|hear|listened|confirmed|checked|verified)\b/i.test(trimmed)) {
        return "drop the caveat about not having heard or checked it"
    }
    const count = sentencesIn(trimmed).length
    if (count > MaxReplySentences) {return `it's ${count} sentences: at most ${MaxReplySentences}`}
    if (trimmed.length > MaxReplyChars) {return `it's ${trimmed.length} characters: at most ${MaxReplyChars}`}
    return null
}
// When the model ends without calling reply: its first plain sentences, list lines and markdown dropped.
export const asChatLine = (text: string): string => sentencesIn(text.split("\n")
    .filter(line => !/^\s*([-*•]|#)/.test(line)).join(" ").replace(/\*\*|`/g, "").trim())
    .slice(0, MaxReplySentences).join(" ")
type Session = { inbox: Inbox, query: Query }

// The knowledge base's part of the prompt, left out when there's none (an A/B run with KNOWLEDGE_DIR on an empty folder).
const KnowledgeTools = `- knowledge, apply_knowledge: the team's knowledge base, shared across projects. \`knowledge\` in your first message lists the entries that best match your piece ("key: summary"); knowledge with search finds others. Kinds: genre (what's played: tempo, groove, harmony, parts), production (how it's treated: sound, effects, mix), sound (an instrument set up, openDAW's ~1,200 DX7 voices for Tubular among them), chain (effects with settings), pattern (drum grooves by role, chord progressions as numerals), note (openDAW facts: step tables, units, fields). Check it before reading source or writing a sound, chain or pattern from scratch: read several entries in one call; apply_knowledge runs an entry's edits, timed from the bar you give. An entry is a starting point, not a rule; drafts and entries checked only "written" or "imported" haven't been heard.
`
const KnowledgeKey = "- A chord pattern needs the project's key: pass the one in your notebook's facts.\n"
const KnowledgeSlot = "\u0000knowledge-tools", KeySlot = "\u0000knowledge-key"
// The worker's prompt (2026-11-23, written for a worker): one piece, framed by the Team Lead (board.ts, Piece), in a
// fresh session. Replaced the old utility's prompt patched for workers, which still spoke of conversations, controls
// and the producer's chat.
export const WorkerSystem = `You are a worker on an AI music production team, editing openDAW (a web DAW) live while the producer's track plays. The Team Lead gives you one piece of the producer's request; other workers do the other pieces at the same time.

Your piece (your_task):
- kind: the sort of change it is (drums, notes, sound, effects, mix, tempo, arrange). Change only that sort of thing.
- tracks: the refs it changes. Change only those. "new": the piece is a new part: make its track yourself, in the same script that writes it.
- goal: where it ends up. Stop when it's there.
- from_bar, to_bar: the bars it spans, counted from playback_at_message (0 and 0: now).
- steps: the most stages it takes, each one edit on its own bar, spread evenly from from_bar to to_bar (1: a single edit). A steady glide (tempo, a level, a filter) is one ramping edit, whatever steps says.
- keep: what must stay as it is.

How to work:
1. Read the project in your first message; look only for what it doesn't show.
2. If a knowledge entry fits, read it and use or adapt it.
3. Stage the edits, no more than the piece needs.
4. Call reply once with your report, then end your turn.
Make calls that don't depend on each other in the same round.

Your first message also has: notebook (its "facts" entry: the key, tempo, meter, each part's register with MIDI numbers), producer_changed (what the producer changed by hand: keep it and build on it, don't move it back; a tool result saying "Meanwhile the producer changed by hand" means the same), knowledge (the entries that best match your piece), devices (what you may add), and for effects and sound pieces the effects you can add.

Tools:
- Fixed operations (volume, pan, mute, set_param, effect_params, and for some pieces add_effect, remove_effect, evolve_notes): use them for anything they cover. They land on the bar you choose, ramp over time (a script can't: it changes things at one instant), and are checked against the controls the producer is holding. Targets are refs from the project; a track or effect your script just made has one once that edit has landed. To ramp an effect you're adding, use add_effect's then.
- look: run read-only JavaScript to inspect the project. Writes fail here.
- run: change the project with a short script, for what no fixed operation does. It runs inside one edit: one undo step for the producer, rolled back entirely if it throws. It lands on the bar you choose (0: as soon as possible).
${KnowledgeSlot}- recall: read a notebook entry. remember: keep what a later piece will need (a part you wrote as notes, a sound's settings).
- Read, Grep, Glob: openDAW's own source, the version that's running; your working directory is its root (packages/…). Read it for what the notes below don't say: a device's fields and their ranges (box schemas in packages/studio/forge-boxes/src/schema/devices/), step tables (adapters in packages/studio/adapters/src/devices/), how an API call works, the user manual (packages/app/manual/public/).
- reply: your report to the Team Lead: one or two plain sentences on what you changed or staged and anything you couldn't do (and why). No lists or markdown.

Timing:
- at_bar counts bars of playing after the producer's message, like from_bar and to_bar: 1 is the next bar line, 2 the one after, through every pass of the loop, whatever the loop is or becomes. An edit for a later bar (at_bar above 0) is staged: it answers at once and goes out when you reply, so its steps land in their bars' order however long you take. at_bar 0 lands at once. Failures of staged edits reach you later. A look sees only what has landed.
- Land changes ahead of the playhead when timing matters; structural changes (lengths, new regions) can land as soon as possible.
- When the loop is on (playback.loop), only its bars are heard: put what you write inside them. A new part's region covers the loop (its pattern looping); a change over time is edits staged on later bars, each landing on a later pass, never content placed at later timeline bars, which the loop never reaches. Leave the loop as it is (project.timelineBox.loopArea): the Team Lead sets it before handing out pieces, and other workers are planning for it now. If your piece needs more room, say so in your report.
- When the loop is off, the song plays straight through and what has played is the producer's recording: never place or lengthen a region into bars already played. A new part's region starts at the next bar line after the playhead (Math.ceil(project.engine.position.getValue() / bar) * bar) its pattern looping (loopDuration shorter than duration); give it any length of a few bars or more: the page keeps each track's last region going as the song grows, and a part stops only when it's parked or muted. Your piece's bars count from the producer's message, not from the timeline's start. To bring back a part that stopped, add a new region from the next bar line. A new region placed in bars already played (your edit landed later than planned) is moved up by the page to start at the current bar, its loop in step; moving or lengthening an existing region into them is refused. Park the old part in the same edit as, or after, the new one comes in, never before: a part parked early leaves a gap. Rewriting a part's notes is fine: the page splits its region where the playhead is, so the bars played keep their notes in a new region and the ref you used goes on from there with yours. A tempo you set (api.setBpm) is written on the tempo track there too; snapshot().timeline.bpm is the tempo playing.
- The transport is the producer's: never play, stop, record or move the playhead (engine.play/stop/setPosition, recording); those calls are refused.

Both run a function body with \`takedo\` in scope (its parts are also plain names: project, api, lib, ref, bar, ppqn, pos, snapshot); \`return\` a value to see it (JSON; openDAW objects show as their class name, so return plain data). look's body may await; run's is synchronous.

\`takedo\`:
- project: openDAW's Project. project.rootBoxAdapter.audioUnits.adapters(): the tracks (AudioUnitBoxAdapter; .label, .isOutput for the master, .box, .namedParameter.{volume,panning,mute,solo}, .tracks.values(): its timeline tracks (an array), each with .box (a TrackBox) and .regions.collection.asArray()).
- Regions (NoteRegionBoxAdapter, AudioRegionBoxAdapter): .position, .duration, .loopOffset, .loopDuration, .complete (end), .label, .mute, .box. A region whose loopDuration is shorter than its duration repeats its content. Change one through its box: region.box.duration.setValue(pulses), region.box.position.setValue(...), region.box.loopDuration.setValue(...). Note regions: .optCollection.unwrap().events.asArray() gives notes (.position relative to the region, .duration, .pitch, .velocity 0..1, .box).
- api: project.api. createNoteRegion({trackBox, position, duration, name, loopDuration}), createNoteEvent({owner: regionBox, position, duration, pitch, velocity}), createInstrument(factory) → {audioUnitBox, trackBox, instrumentBox}, insertEffect(audioUnitBox.audioEffects, factory), duplicateNotes(noteAdapters). Parts and devices are never deleted: taking one out parks it (track muted, its instrument and effects switched off; remove_effect switches an effect off), so it can come back and a take keeps it; deleteAudioUnit is refused.
- lib: {std, dsp: {PPQN}, adapters, core}: openDAW's libraries (lib.adapters.InstrumentFactories.Named, lib.core.EffectFactories.AudioNamed, lib.dsp.PPQN.Quarter = 960).
- ref("t1") → that track's AudioUnitBoxAdapter, ref("t1.fx1") → an effect's adapter, ref("r3") → a region's adapter: the refs in the project summary.
- bar: pulses per bar; ppqn("5.1.1") → pulses; pos(pulses) → "5.1.1". Positions are 1-based bars.beats.sixteenths.
- snapshot(): the project, fresh, in the adapter's shape (not quite the summary's): playback (playhead, loop), timeline, tracks[] with ref, name, mix.{volume (dB), pan, mute}, effects[] (key, name, ref, params[] with ref, name, value, display), regions; master.{volume, effects}. Nothing else is in scope (no \`playback\`, \`tracks\` or \`project_summary\` variables).

Recipes that work (inside run):

Rules:
- Set up anything you create in the same script that creates it (its name, level, mute, notes), so it's never heard half-made; use the fixed operations for changes over time, after.
- Keep scripts small, one job each; check the result with a look when it matters.
- Decided limits, for now: ${Limits} \`devices\` lists the devices you may add, by kind, as named in openDAW's factories. Anything else openDAW can do, you can: never answer that it can't be done; look up how and do it.
- Every edit you stage lands: never stage a placeholder or a test.
- If something fails twice the same way, stop and say what's in the way.`

// What only one kind of piece needs (2026-11-23): moved out of the shared prompt, so a worker reads its kind's recipes
// and rules, not every kind's. The kinds are what Jev will classify (board.ts, PieceKinds).
const KindNotes: Record<PieceKind, string> = {
    drums: `- evolve_notes: a part's notes changing over several bars (a groove becoming another, a part thinning out or filling in), not a script per stage. Name where it's going (a knowledge pattern, or the notes written once) and how many stages; code works out each stage and rewrites the region's notes in place, so a looping region changes as it plays.
- A region's notes play on every pass of its loop: rewriting them changes every repeat from when it lands.
- Grooves as one line of mini-notation, code writes the hits: make_kit's drums, write_part's drums, evolve_notes's to_drums (\"[bd ~ ~ bd ~ ~ bd ~, ~ sd ~ sd, hh*8]\"; sd:0.4 a ghost note, <sd cp> a different one each bar with bars 2).
- A style's drum sound (trap, house, techno, boom-bap, 80s) is a new kit, not new notes on the old one: apply_knowledge a kit entry (sound/kit-trap-808, kit-house-909, kit-boombap-mpc60, kit-boombap-sp12, kit-synthpop-linndrum) with the style's pattern and from_bar, or make_kit with samples you pick (samples finds them across 70 drum machines); then park (mute) the old drums at the bar the kit starts, so the two never play together.`,
    notes: `- A new part's sound (2026-11-25, the producer: sounds outside the drums were grating and not genre appropriate): pick a sampled instrument first: the knowledge base's \"Sampled instruments\" entries name a genre's usual ones (bass, keys, guitar, strings, pads, brass, leads) with their registers; sounds finds the rest of 300 (GeneralUser GS and openDAW's). make_instrument makes the track with its notes. Set a synth (Vaporisateur, Tubular) by hand only for a sound no sample has or when the producer asks for a synth, and then start from a knowledge sound entry. Play a sampled instrument in its register.
- evolve_notes: a part's notes changing over several bars (a groove becoming another, a part thinning out or filling in), not a script per stage. Name where it's going (a knowledge pattern, or the notes written once) and how many stages; code works out each stage and rewrites the region's notes in place, so a looping region changes as it plays.
- A region's notes play on every pass of its loop: rewriting them changes every repeat from when it lands.
- An 808 bass (trap, drill, modern hip hop) is make_sampler: a long TR-808 kick played as notes (sound/808-bass), roots in the key around the kick, long notes with gaps.
- Chords (pads, keys, strings, comping): write the progression, not the notes: make_instrument's chords, write_part's chords (a part on a track that exists, e.g. one a sound entry made empty) and evolve_notes's to_chords take chord names or numerals, a voicing, a register and a rhythm, and code writes the notes in key, voice-led.
- Bass lines, riffs and melodies: one line of mini-notation in scale degrees (melody, to_melody: \"0 ~ 0 [2 4] ~ 4 _ 3\", 0 the key's tonic), and code writes the notes in key; notes by hand only for what it can't say.
- Pitches: write them in the key in facts, and keep each part in its role (a part in the bass register stays the bass). Note names here follow openDAW, where C3 is MIDI 60 (not C4): write pitches by the MIDI numbers facts gives.
${KeySlot}
- A new named track with a bar of notes: const {audioUnitBox, trackBox, instrumentBox} = api.createInstrument(lib.adapters.InstrumentFactories.Vaporisateur); instrumentBox.label.setValue("Lead"); const region = api.createNoteRegion({trackBox, position: 0, duration: bar, name: "Lead"}); api.createNoteEvent({owner: region, position: 0, duration: lib.dsp.PPQN.Quarter, pitch: 60, velocity: 0.8});
- A track made in this script has no adapter yet (ref and audioUnits.adapters() don't find it until the edit ends): set its level with audioUnitBox.volume.setValue(dB) and its instrument's settings on instrumentBox's fields (instrumentBox.cutoff.setValue(2200)), with the names namedParameter shows on a track of that instrument. Every field has a range (the box schema's constraints; a parameter's valueMapping); a value outside it can crash the audio engine, so TakeDo brings it back in and the result lists what it corrected.`,
    sound: `- A new part's sound (2026-11-25, the producer: sounds outside the drums were grating and not genre appropriate): pick a sampled instrument first: the knowledge base's \"Sampled instruments\" entries name a genre's usual ones (bass, keys, guitar, strings, pads, brass, leads) with their registers; sounds finds the rest of 300 (GeneralUser GS and openDAW's). make_instrument makes the track with its notes. Set a synth (Vaporisateur, Tubular) by hand only for a sound no sample has or when the producer asks for a synth, and then start from a knowledge sound entry. Play a sampled instrument in its register.
- An instrument's settings: ref("t2").inputAdapter.unwrap().namedParameter (e.g. Cubed: cutoff, resonance, envMod, decay, accent; Vaporisateur: cutoff, resonance, attack, decay, sustain, release, …); set them with .setValue(v). A drum machine (Playfield) has none: its sounds are samples by pad.
- A style's drum sound (trap, house, techno, boom-bap, 80s) is a new kit, not new notes on the old one: apply_knowledge a kit entry (sound/kit-trap-808, kit-house-909, kit-boombap-mpc60, kit-boombap-sp12, kit-synthpop-linndrum) with the style's pattern and from_bar, or make_kit with samples you pick (samples finds them across 70 drum machines); then park (mute) the old drums at the bar the kit starts, so the two never play together.
- An 808 bass (trap, drill, modern hip hop) is make_sampler: a long TR-808 kick played as notes (sound/808-bass), roots in the key around the kick, long notes with gaps.
- A track a sound entry made with no notes gets its part with write_part: chords (pads, keys, strings) as a progression, code writes the notes.
- Vaporisateur's namedParameter: oscillators[0] and oscillators[1], each {waveform (0 sine, 1 triangle, 2 saw, 3 square), volume (dB; -Infinity is off), octave (-3..3), tune (cents)}; unisonCount is 1, 3 or 5 only; unisonDetune in cents (1..1200); unisonStereo 0..1; cutoff (Hz), resonance, filterOrder (1..4), attack, decay, sustain, release. A supersaw: both oscillators saw at 0 dB, the second tuned +7 ct, unisonCount 5, unisonDetune 25, unisonStereo 0.8.
- A new named track with a bar of notes: const {audioUnitBox, trackBox, instrumentBox} = api.createInstrument(lib.adapters.InstrumentFactories.Vaporisateur); instrumentBox.label.setValue("Lead"); const region = api.createNoteRegion({trackBox, position: 0, duration: bar, name: "Lead"}); api.createNoteEvent({owner: region, position: 0, duration: lib.dsp.PPQN.Quarter, pitch: 60, velocity: 0.8});
- A track made in this script has no adapter yet (ref and audioUnits.adapters() don't find it until the edit ends): set its level with audioUnitBox.volume.setValue(dB) and its instrument's settings on instrumentBox's fields (instrumentBox.cutoff.setValue(2200)), with the names namedParameter shows on a track of that instrument. Every field has a range (the box schema's constraints; a parameter's valueMapping); a value outside it can crash the audio engine, so TakeDo brings it back in and the result lists what it corrected.
- Always set parameter values through openDAW's parameter objects like this (namedParameter, or an effect's parameter adapters), never a box's field directly: when the producer records, only those writes become automation. Structural edits (regions, notes, devices) are unaffected.`,
    effects: `- Bring an effect in gently (dry, or its mix low) and raise it with add_effect's then, not at full strength.
- Always set parameter values through openDAW's parameter objects like this (namedParameter, or an effect's parameter adapters), never a box's field directly: when the producer records, only those writes become automation. Structural edits (regions, notes, devices) are unaffected.`,
    mix: `- A level at once: ref("t1").namedParameter.volume.setValue(-12) (dB); for a fade over time, use the volume tool instead.
- Always set parameter values through openDAW's parameter objects like this (namedParameter, or an effect's parameter adapters), never a box's field directly: when the producer records, only those writes become automation. Structural edits (regions, notes, devices) are unaffected.`,
    tempo: `- While the loop is on, tempo automation replays every pass (the tempo jumps back at each loop start): step the tempo instead, one run per stage on its bar (steps), each: project.timelineBox.tempoTrack.enabled.setValue(false); api.setBpm(84).
- With the loop off, tempo over time (a glide is one run, at_bar 0: its points are on the timeline): const tt = project.timelineBox.tempoTrack; tt.enabled.setValue(true); const events = tt.events.targetVertex.unwrap().box.events; delete the points already in that span (events.pointerHub.incoming().map(pointer => pointer.box): each has .position.getValue() and .delete()); then each point: project.boxGraph.createBox("ValueEventBox", lib.std.UUID.generate(), box => {box.events.refer(events); box.position.setValue(ppqn("9.1.1")); box.value.setValue(80); box.index.setValue(0); box.slope.setValue(NaN); box.interpolation.setValue(1)}). Values are BPM (30 to 1000, never normalized); interpolation 1 glides to the next point, so a glide is two points.`,
    arrange: `- evolve_notes: a part's notes changing over several bars (a groove becoming another, a part thinning out or filling in), not a script per stage. Name where it's going (a knowledge pattern, or the notes written once) and how many stages; code works out each stage and rewrites the region's notes in place, so a looping region changes as it plays.
- A new named track with a bar of notes: const {audioUnitBox, trackBox, instrumentBox} = api.createInstrument(lib.adapters.InstrumentFactories.Vaporisateur); instrumentBox.label.setValue("Lead"); const region = api.createNoteRegion({trackBox, position: 0, duration: bar, name: "Lead"}); api.createNoteEvent({owner: region, position: 0, duration: lib.dsp.PPQN.Quarter, pitch: 60, velocity: 0.8});
- A track's name is its instrument's label: ref("t1").inputAdapter.unwrap().labelField.setValue("Bass").
- A track made in this script has no adapter yet (ref and audioUnits.adapters() don't find it until the edit ends): set its level with audioUnitBox.volume.setValue(dB) and its instrument's settings on instrumentBox's fields (instrumentBox.cutoff.setValue(2200)), with the names namedParameter shows on a track of that instrument. Every field has a range (the box schema's constraints; a parameter's valueMapping); a value outside it can crash the audio engine, so TakeDo brings it back in and the result lists what it corrected.
- Lengthen a region and loop its content: r.box.loopDuration.setValue(r.loopDuration); r.box.duration.setValue(16 * bar).`,
}

// The producer's messages, fed to the session as they come (streaming input), so it stays open between them.
export class Inbox implements AsyncIterable<SDKUserMessage> {
    readonly #waiting: SDKUserMessage[] = []
    #wake: (() => void) | null = null
    #closed = false

    push(text: string): void {
        this.#waiting.push({type: "user", message: {role: "user", content: text}, parent_tool_use_id: null})
        this.#wake?.()
    }

    close(): void {
        this.#closed = true
        this.#wake?.()
    }

    async* [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
        while (true) {
            const next = this.#waiting.shift()
            if (next !== undefined) {
                yield next
                continue
            }
            if (this.#closed) {return}
            await new Promise<void>(resolve => {this.#wake = resolve})
            this.#wake = null
        }
    }
}

const reply = (text: string): CallToolResult => ({content: [{type: "text", text}]})

// A member's tool with its lists of the project's refs (tracks, parameters, effects on it) opened to any ref.
const RefFields = new Set(["track", "param"])
const anyRef = (tool: Anthropic.Tool): Anthropic.Tool => {
    const properties = Object.fromEntries(Object.entries(tool.input_schema.properties as Record<string, Record<string, unknown>>)
        .map(([name, property]) => {
            if (!(RefFields.has(name) || (tool.name === "remove_effect" && name === "effect")) || property.enum === undefined) {
                return [name, property]
            }
            const {enum: _refs, ...rest} = property
            return [name, {...rest, description: "A ref from the project summary (t1, master, t1.fx1, t1.fx1.mix, …)"}]
        }))
    return {...tool, input_schema: {...tool.input_schema, properties}}
}

// The snapshot with an effect added on the master, so members offer every tool (set_param and remove_effect only
// appear once there's an effect); the refs it adds are opened up by anyRef.
const withEveryTool = (snapshot: Snapshot): Snapshot => ({...snapshot, master: {...snapshot.master, effects: [
    ...snapshot.master.effects, {key: "any", name: "any", enabled: true, ref: "master.fx0",
        params: [{ref: "master.fx0.any", name: "any", value: 0, display: "0", min: 0, max: 1, stepped: false}]}]}})

// Chords written by code (compose.ts, tonal): the worker names the progression, voicing, register and rhythm, code writes
// the notes, in key and voice-led (2026-11-25: a worker's job was ~3,000 output tokens, most of them note lists).
const ChordsArg = z.object({
    progression: z.string().describe("Chord names with their lengths in beats: \"Em9:4 Cmaj7:4 Am7:4 B7sus4:4\" (slash chords too: \"C/E:2\"), or Roman numerals in the key: \"i9:4 VImaj7:4 iv7:4 V7sus4:4\" (case is major or minor); \"\" for none"),
    voicing: z.enum(["close", "open", "spread", "shell"]).describe("close: tight; open: drop-2, wider; spread: the root low under the rest (pads, strings); shell: root, 3rd and 7th (jazz comping)"),
    register: z.enum(["low", "mid", "high"]).describe("Where the voices sit: low (MIDI 40–62), mid (52–76: keys), high (64–88)"),
    rhythm: z.string().describe("\"hold\" (each chord for its length), or one bar of sixteenths, x a hit, X an accent, . a rest, repeated over each chord: \"x...x...x...x...\" (quarters), \"..x...x...x...x.\" (offbeats), \"x..x..x.x...x...\"")
}).describe("Or the part as chords, notes written by code: in key, each chord led to the nearest voicing of the last. progression \"\" to give notes instead")

// Drums and melodies as one line of Strudel's mini-notation (compose.ts): one bar per cycle, code writes the hits.
const MiniBars = z.number().int().describe("How many bars it runs before repeating, 1 to 16 (more than 1 with <a b> alternation: one per bar)")
const DrumsArg = z.object({
    pattern: z.string().describe("One bar of drums in Strudel mini-notation, parts at once split by commas: \"[bd ~ ~ bd ~ ~ bd ~, ~ sd ~ sd, hh*8]\" (bd kick, sd snare, cp clap, rim, hh closed hat, oh open hat, ride, crash, lt/mt/ht toms, sh shaker, perc; ~ a rest, x*8 repeats, bd(3,8) Euclid, <sd cp> one per bar, sd:0.5 a velocity 0..1 for ghost notes); \"\" for none"),
    bars: MiniBars
}).describe("Or the groove as mini-notation, hits written by code")
const MelodyArg = z.object({
    pattern: z.string().describe("A line in Strudel mini-notation, one bar per cycle: scale degrees of the key (0 the tonic, 2 the third, 4 the fifth, 7 the octave, -3 below; \"0 ~ 0 [2 4] ~ 4 _ 3\"; _ holds the note before, ~ a rest, [..] splits a step, <a b> one per bar, 4:0.5 a velocity 0..1), or note names with octaves, openDAW's (C3 = MIDI 60: \"e1 ~ e1 g1\"); \"\" for none"),
    bars: MiniBars,
    register: z.enum(["low", "mid", "high"]).describe("Where degree 0 sits: low (a bass: the tonic from MIDI 36), mid (48), high (60)")
}).describe("Or a bass line, riff or melody as mini-notation, notes written by code in the key")

// A new track's name says its role and sound, as a producer labels a track (2026-11-25, the producer: "I don't know what
// 'Cubed' means, but I know what 'acid bass' is"); it's also what Jev reads to tell the parts apart.
const TrackName = "The track's name: its role and sound, as a producer labels a track (\"Acid Bass\", \"808 Bass\", \"Lofi Keys\", " +
    "\"Trap Kit\", \"Muted Guitar\"); not an instrument's or device's name (\"Cubed\", \"Vaporisateur\"), nor a song or reference (\"Halogalo Riff\")"

export class Utility implements Member {
    readonly agent: Actor = "agent:utility"
    readonly role = "utility"
    readonly name = "Utility"
    readonly area = "anything openDAW can do"
    readonly can = "read the project and change it directly with short openDAW scripts (extend or duplicate clips, add tracks or regions, write or rework notes, anything openDAW supports); slower and costlier, seconds to tens of seconds"

    readonly #team: ReadonlyArray<LlmMember>
    readonly #devices: Record<string, string[]>
    readonly #source: string
    readonly #knowledge: Knowledge | null
    readonly #owners = new Map<string, LlmMember>()   // who owns each borrowed fixed operation
    #session: Session | null = null
    #current: Current | null = null
    #handSeen = 0             // the producer's changes told so far (Coordinator.handChanges)

    // team: the members whose fixed operations it borrows; catalog: which devices it may add; source: the root of
    // openDAW's source tree, the session's working directory; knowledge: the knowledge base (knowledge.ts), if loaded.
    // Each instance is one worker: one piece the captain hands out, in a fresh session (job()). The long-lived session
    // mode (one session for every message) went with the ROSTER=team path (2026-11-23).
    constructor(team: ReadonlyArray<LlmMember>, catalog: Catalog, source: string, knowledge: Knowledge | null = null) {
        this.#team = team
        this.#source = source
        this.#knowledge = knowledge
        this.#devices = {}
        catalog.devices().filter(device => device.allowed)
            .forEach(device => (this.#devices[device.kind] ??= []).push(device.factory))
    }

    // The generalist: every operation, scripts included.
    may(_plan: Plan): boolean {return true}

    // The producer's changes in openDAW since the model last heard, under key (none: {}).
    #hand(context: Coordinator, key: string): Record<string, unknown> {
        const {lines, next} = context.handChanges(this.#handSeen)
        this.#handSeen = next
        return lines.length === 0 ? {} : {[key]: lines}
    }

    // Ends the session process (the piece is done, or the page went away).
    close(): void {
        this.#session?.inbox.close()
        this.#session?.query.close()
        this.#session = null
    }

    // Reads the session until this message's turn ends; its last text is what the producer reads. Each turn is
    // logged like a model call (tokens are the main loop's; the cost is the session's running total).
    async #reply(context: Coordinator, session: Session): Promise<string> {
        const {model} = context.gateway.agent("utility")
        while (true) {
            const next = await session.query.next()
            if (next.done === true) {throw new Error("the agent's session ended")}
            const message = next.value
            if (message.type === "assistant" && message.parent_tool_use_id === null
                && message.message.content.some(block => block.type === "tool_use" && SourceTools.includes(block.name))) {
                context.card({agent: this.agent, name: this.name, doing: "reading openDAW's source…"})
            }
            if (message.type !== "result") {continue}
            const {usage} = message
            context.modelLog()({job: "utility", provider: "anthropic", model, ms: message.duration_ms, session: message.session_id,
                inputTokens: usage.input_tokens, outputTokens: usage.output_tokens,
                cacheRead: usage.cache_read_input_tokens, cacheWrite: usage.cache_creation_input_tokens,
                turns: message.num_turns, costUsd: message.total_cost_usd, agent: this.agent,
                ...(message.subtype === "success" && !message.is_error ? {} : {error: message.subtype === "success"
                    ? message.result : `${message.subtype}: ${message.errors.join("; ")}`})})
            if (message.subtype !== "success") {throw new Error(`${message.subtype}: ${message.errors.join("; ")}`)}
            if (message.is_error) {throw new Error(message.result)}
            return message.result
        }
    }

    #cwd(): string {return existsSync(this.#source) ? this.#source : process.cwd()}

    // A session with our tools: the members' (from the snapshot, opened to any ref) and the utility's own.
    #open(context: Coordinator, snapshot: Snapshot, kind: PieceKind): Session {
        const {model, effort} = context.gateway.agent("utility")
        const handler = (run: (current: Current, input: Record<string, unknown>) => Promise<string> | string) =>
            async (input: Record<string, unknown>): Promise<CallToolResult> => {
                const current = this.#current
                if (current === null) {return reply("No message is being worked on.")}
                // A worker whose piece the Team Lead cancelled stops at its next call.
                if (current.job !== undefined && current.context.board.jobOf(current.job)?.state === "cancelled") {
                    return reply("Not run: the Team Lead cancelled this piece. Stop here: call reply saying so.")
                }
                if (++current.calls > MaxCalls) {
                    return reply(`Not run: that's ${MaxCalls} calls for this message. Finish now: call reply with what you changed and what's left undone.`)
                }
                let result = await run(current, input)
                const hand = this.#hand(current.context, "meanwhile").meanwhile
                if (hand !== undefined) {result += `\nMeanwhile the producer changed by hand: ${(hand as string[]).join("; ")}.`}
                const late = current.work.late.splice(0)
                return reply(late.length > 0 ? `${result}\nSince then, failed: ${late.join("; ")}.` : result)
            }
        const borrowed = new Map<string, Anthropic.Tool>()
        const owners = this.#owners
        owners.clear()
        this.#team.forEach(owner => owner.tools(withEveryTool(snapshot)).forEach(member => {
            if (borrowed.has(member.name)) {return}
            borrowed.set(member.name, anyRef(member))
            owners.set(member.name, owner)
        }))
        const tools = [
            ...[...borrowed.values()].map(member => tool(member.name, member.description ?? "",
                Object.fromEntries(Object.entries(member.input_schema.properties as Record<string, z.core.JSONSchema.JSONSchema>)
                    .map(([name, property]) => [name, z.fromJSONSchema(property)])) as z.ZodRawShape,
                handler((current, input) => this.#operate(current, owners.get(member.name)!, member.name, input)))),
            tool("reply", "What the producer reads in the chat, once you've finished: one or two short, plain sentences.", {
                text: z.string()}, async (input: Record<string, unknown>): Promise<CallToolResult> => {
                    const current = this.#current
                    if (current === null) {return reply("No message is being worked on.")}
                    const text = String(input.text).trim()
                    const problem = replyProblem(text)
                    if (problem !== null) {return reply(`Not sent: ${problem}. Call reply again.`)}
                    current.said = text
                    return reply("Sent. End your turn now.")
                }),
            tool("look", "Run read-only JavaScript (an async function body, `takedo` in scope) and see what it returns.", {
                code: z.string()}, handler((current, input) => this.#look(current.context, String(input.code))),
                {annotations: {readOnlyHint: true}}),
            tool("run", "Change the project with a script (a function body, `takedo` in scope), as one undoable edit.", {
                description: z.string().describe("What it does, for the producer, a few words"),
                code: z.string(),
                at_bar: z.number().int().describe("Bars of playing after the producer's message (1: the next bar line); 0 for as soon as possible")},
                handler((current, input) => this.#run(current, String(input.description), String(input.code), Number(input.at_bar)))),
            tool("remember", "Keep something in your notebook, outside your conversation (which may be summarized): replaces the entry with that key.", {
                key: z.string().describe("A short name you'll recognize (\"lofi-plan\", \"rhodes-patch\", \"bridge-chords\")"),
                kind: z.enum(Kinds),
                summary: z.string().describe("One line: what it is; shown with every message"),
                value: z.string().describe("The content: text, or JSON (notes, settings, a script)")},
                handler((current, input) => this.#notebook(current.context, "remember", input))),
            tool("recall", "Read a notebook entry's content.", {key: z.string()},
                handler((current, input) => this.#notebook(current.context, "recall", input)), {annotations: {readOnlyHint: true}}),
            ...(this.#knowledge === null ? [] : this.#knowledgeTools(handler))
        ].filter(candidate => (ToolKinds[candidate.name] ?? [kind]).includes(kind))
        const inbox = new Inbox()
        return {inbox, query: query({prompt: inbox, options: {
            model, ...(effort !== undefined ? {effort} : {}),
            systemPrompt: `${WorkerSystem}\n\nFor a ${kind} piece:\n${KindNotes[kind]}`.replace(KnowledgeSlot, this.#knowledge === null ? "" : KnowledgeTools)
                .replace(KeySlot, this.#knowledge === null ? "" : KnowledgeKey),
            cwd: this.#cwd(),
            tools: SourceTools,
            allowedTools: [...SourceTools, "mcp__takedo__*"],
            permissionMode: "dontAsk",
            mcpServers: {takedo: createSdkMcpServer({name: "takedo", tools, alwaysLoad: true})},
            settingSources: [],
            env: {...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "takedo"},
            stderr: data => console.error(`[utility] ${data.trimEnd()}`)
        }})}
    }

    // The knowledge entries that best match a piece (its kind, goal and the producer's words), not the whole index
    // (~20k characters, a third of a worker's context, read once by seven workers in one run).
    #knowledgeFor(piece: Piece, message: string): Record<string, unknown> {
        if (this.#knowledge === null) {return {}}
        const found = shortlist(this.#knowledge.index(), `${piece.kind} ${PieceKinds[piece.kind]} ${piece.goal} ${message}`, 12)
        return found.length === 0 ? {} : {knowledge: this.#knowledge.compact(found.map(({line}) => line))}
    }

    #knowledgeTools(handler: (run: (current: Current, input: Record<string, unknown>) => Promise<string> | string)
        => (input: Record<string, unknown>) => Promise<CallToolResult>) {
        const knowledge = this.#knowledge!
        const Value = z.union([z.string(), z.number(), z.null()])
        return [
            tool("knowledge", "Read knowledge base entries in full (several at once), with the summaries of the entries each links to; or search the index for others.", {
                keys: z.array(z.string()).describe("Entry keys, e.g. [\"production/lofi\", \"pattern/boombap-1\"]; [] to search"),
                search: z.string().describe("Words to find entries by (\"jazz brush groove\", \"tape saturation\"); \"\" to read keys")},
                handler((current, input) => {
                    const search = String(input.search ?? "").trim()
                    if (search !== "" && ((input.keys ?? []) as string[]).length === 0) {
                        const found = shortlist(knowledge.index(), search, 20).map(({line}) => line)
                        return found.length === 0 ? "Nothing matches; try other words." : knowledge.compact(found).join("\n")
                    }
                    current.context.card({agent: this.agent, name: this.name, doing: "reading the knowledge base…"})
                    const entries = knowledge.get((input.keys as string[]).slice(0, 12))
                    const text = JSON.stringify(entries, null, 1)
                    return text.length > MaxRecall ? `${text.slice(0, MaxRecall)}\n… (cut at ${MaxRecall} characters: ask for fewer keys)` : text
                }), {annotations: {readOnlyHint: true}}),
            tool("apply_knowledge", "Apply an entry's edits (its apply): fixed operations and scripts, scheduled from the bar you give like your own. Its params are listed in the entry (read it first unless they're obvious: track, amount 0..3, key, from_bar, bars).", {
                key: z.string(),
                args: z.record(z.string(), Value).describe("The entry's params by name: {\"track\": \"t2\", \"amount\": 2}, {\"track\": \"t3\", \"key\": \"G major\"}; {} when it has none"),
                at_bar: z.number().int().describe("Bars of playing after the producer's message its first edit lands on (1: the next bar line); 0 for as soon as possible. Its later edits keep their spacing from it.")},
                handler((current, input) => this.#applyKnowledge(current, String(input.key),
                    (input.args ?? {}) as Record<string, unknown>, Number(input.at_bar)))),
            tool("evolve_notes", "Change a notes region's notes, in place, over several stages toward a target: notes both share glide (timing, length, velocity), new ones come in loudest first, old ones go quietest first; the last stage is the target exactly. One edit per stage, each on its own bar.", {
                region: z.string().describe("The notes region's ref (r3), from the project's regions"),
                to_pattern: z.string().describe("A knowledge pattern entry to arrive at (\"pattern/boombap-1\"), repeated to fill the region's loop; \"\" to give to_notes"),
                to_notes: z.array(z.tuple([z.string(), z.number(), z.number(), z.number()])).describe("The notes to arrive at, as the project shows a region's: [position in the region \"1.1.1:0\", MIDI pitch, length in sixteenths, velocity 0..127]; [] with to_pattern or to_chords"),
                to_chords: ChordsArg,
                to_melody: MelodyArg,
                to_drums: DrumsArg,
                key: z.string().describe("For a chord pattern: the key (\"A minor\"); \"\" for the project's"),
                stages: z.number().int().describe("How many steps to get there, 1 to 16"),
                at_bar: z.number().int().describe("Bars of playing after the producer's message the first stage lands on (1: the next bar line); 0 for as soon as possible"),
                every_bars: z.number().int().describe("Bars between stages, 1 or more")},
                handler((current, input) => this.#evolve(current, input))),
            tool("write_part", "Write a part onto an existing notes track (one made with no notes, or one whose part you're replacing from a bar on): chords, a melody or drums by code, or notes as written, looping. Replaces what the track had in those bars; the track's sound stays.", {
                track: z.string().describe("The track's ref (t4)"),
                notes: z.array(z.tuple([z.number(), z.number(), z.number(), z.number()])).describe("[beat from 0, MIDI pitch, length in beats, velocity 0..1]; [] with chords"),
                chords: ChordsArg,
                melody: MelodyArg,
                drums: DrumsArg,
                loop_bars: z.number().int().describe("How many bars the notes loop over; 0 for 1 (with chords: the progression's length)"),
                from_bar: z.number().int().describe("The timeline bar the part's region starts on (with the loop off: the next bar line after the edit lands, never a bar already played); 0 to cover the bars the other parts cover"),
                bars: z.number().int().describe("How many bars the region runs (with the loop off: to the song's end); 0 for the default"),
                at_bar: z.number().int().describe("Bars of playing after the producer's message the edit lands on (1: the next bar line); 0 for as soon as possible")},
                handler((current, input) => this.#writePart(current, input))),
            ...(knowledge.samples === null || (knowledge.samples.size === 0 && knowledge.samples.sounds.length === 0) ? [] : this.#sampleTools(handler))
        ]
    }

    // TakeDo's sample collections (samples.ts): ~2,800 one-shots from 70 drum machines, found by machine and role, made
    // into a new kit track (Playfield) or a sampler track (Nano: one sample played across the keys, an 808 bass).
    #sampleTools(handler: (run: (current: Current, input: Record<string, unknown>) => Promise<string> | string)
        => (input: Record<string, unknown>) => Promise<CallToolResult>) {
        const knowledge = this.#knowledge!, samples = knowledge.samples!
        const Placement = {
            from_bar: z.number().int().describe("The timeline bar the part's region starts on (with the loop off: the next bar line after the edit lands, never a bar already played); 0 to cover the bars the other parts cover"),
            bars: z.number().int().describe("How many bars the region runs (with the loop off: to the song's end); 0 for the default"),
            at_bar: z.number().int().describe("Bars of playing after the producer's message the edit lands on (1: the next bar line); 0 for as soon as possible")}
        const placed = (input: Record<string, unknown>, notes: Record<string, unknown>): Record<string, unknown> =>
            ({...notes, from_bar: Number(input.from_bar) || 0, bars: Number(input.bars) || 0})
        // The tool's input as the kit and sampler ops take it (knowledge.ts).
        const shape = (kind: "kit" | "sampler" | "soundfont", input: Record<string, unknown>): Record<string, unknown> => {
            const common = {name: input.name, volume_db: Number(input.volume_db) || 0}
            if (kind === "soundfont") {
                const notes = (input.notes ?? []) as unknown[]
                return {...common, sound: input.sound, notes: notes.length > 0 ? placed(input, {notes, loop_bars: Number(input.loop_bars) || 1}) : undefined}
            }
            if (kind === "kit") {
                const pattern = String(input.pattern ?? ""), hits = (input.hits ?? []) as unknown[]
                return {...common, pads: input.pads,
                    notes: pattern !== "" ? placed(input, {of: pattern}) : hits.length > 0 ? placed(input, {hits, beats: Number(input.beats) || 4}) : undefined}
            }
            const notes = (input.notes ?? []) as unknown[]
            return {...common, sample: input.sample, root_key: input.root_key,
                ...(Number(input.tune) ? {tune: Number(input.tune)} : {}), ...(Number(input.release) > 0 ? {release: Number(input.release)} : {}),
                notes: notes.length > 0 ? placed(input, {notes, loop_bars: Number(input.loop_bars) || 1}) : undefined}
        }
        const make = (kind: "kit" | "sampler" | "soundfont") => async (current: Current, given: Record<string, unknown>): Promise<string> => {
            const snapshot = await current.context.snapshot()
            if (snapshot === null) {return "Not done: no project is open."}
            const input = this.#withComposed(current.context, given, snapshot.timeline.signature[0])
            if (typeof input === "string") {return `Not done: ${input}.`}
            const made = knowledge[kind](shape(kind, input), snapshot)
            if (typeof made === "string") {return `Not done: ${made}.`}
            current.context.card({agent: this.agent, name: this.name, doing: kind === "kit" ? "building a drum kit…" : kind === "soundfont" ? "bringing in an instrument…" : "setting up a sampler…"})
            return this.#run(current, made.says, made.code, Number(input.at_bar) || 0)
        }
        return [
            tool("samples", "Find drum and percussion samples in TakeDo's collections (~2,800 one-shots from 70 classic drum machines: TR-808, TR-909, LinnDrum, MPC60, SP-12, DMX, ...) by machine, role and words; all empty lists the machines.", {
                machine: z.string().describe("Part of a machine's name (\"808\", \"LinnDrum\", \"MPC\"); \"\" for any"),
                role: z.string().describe("kick, snare, clap, rim, closed hat, open hat, crash, ride, low tom, mid tom, high tom, cowbell, percussion, shaker, tambourine, misc, effect; \"\" for any"),
                words: z.string().describe("Words in the sample's id (\"BD0010\", \"Gated\"); \"\" for none")},
                handler((_current, input) => {
                    const machine = String(input.machine ?? ""), role = String(input.role ?? ""), words = String(input.words ?? "")
                    if (machine === "" && role === "" && words === "") {
                        return samples.machines().map(entry => `${entry.machine} (${entry.count}): ${entry.roles.join(", ")}`).join("\n")
                    }
                    const found = samples.search({machine, role, words}, 60)
                    return found.length === 0 ? "Nothing matches; leave a field empty or list the machines."
                        : found.map(sample => `${sample.id} (${sample.role ?? "?"}, ${sample.duration.toFixed(2)} s)`).join("\n")
                }), {annotations: {readOnlyHint: true}}),
            tool("make_kit", "A new drum track: a kit (openDAW's Playfield) of samples you pick, one per role, optionally playing a groove from the start. The pads get role names, so knowledge drum patterns and evolve_notes find them. The old drums stay: park them (mute) when the new kit comes in.", {
                name: z.string().describe(TrackName),
                pads: z.array(z.object({role: z.string().describe("kick, snare, clap, rim, closed_hat, open_hat, ride, crash, tom_low, tom_mid, tom_high, shaker, perc"),
                    sample: z.string().describe("A sample id from samples (\"RolandTR808/bd/BD0010\")")})),
                pattern: z.string().describe("A knowledge drum pattern to play (\"pattern/trap-halftime\"); \"\" for hits or none"),
                hits: z.array(z.tuple([z.number(), z.string(), z.number()])).describe("Or the groove written out: [beat from 0, role, velocity 0..1], 16ths are 0.25 beats; [] for none"),
                beats: z.number().describe("How many beats the hits loop over (4: one bar of 4/4); 0 with a pattern"),
                drums: DrumsArg,
                volume_db: z.number().describe("The track's volume, dB; 0 for unity"),
                ...Placement},
                handler(make("kit"))),
            tool("make_sampler", "A new sampler track (openDAW's Nano): one sample played across the keys at pitch, e.g. an 808 bass from a long TR-808 kick (RolandTR808/bd/BD0010 or BD5010: 3 s, sounding G1, root_key 31, tune -35), optionally with notes.", {
                name: z.string().describe(TrackName),
                sample: z.string().describe("A sample id from samples"),
                root_key: z.number().int().describe("The MIDI note the sample sounds at as recorded (60 if unknown or unpitched)"),
                tune: z.number().describe("Fine tuning, cents, -1200..1200; 0 for none"),
                release: z.number().describe("Release after a note ends, seconds (0.001..8); 0 for the default 0.1 (an 808 bass: 0.2–0.5)"),
                notes: z.array(z.tuple([z.number(), z.number(), z.number(), z.number()])).describe("[beat from 0, MIDI pitch, length in beats, velocity 0..1]; [] for none or with chords"),
                chords: ChordsArg,
                melody: MelodyArg,
                loop_bars: z.number().int().describe("How many bars the notes loop over; 0 for 1 (with chords: the progression's length)"),
                volume_db: z.number().describe("The track's volume, dB; 0 for unity"),
                ...Placement},
                handler(make("sampler"))),
            ...(samples.sounds.length === 0 ? [] : [
                tool("sounds", "Find instrument sounds by words in their names and descriptions: sampled instruments (soundfont presets: GeneralUser GS's 287 General MIDI sounds, and openDAW's upright piano, guitars, harp, organ, xylophone, TB-303) and openDAW's factory synth presets (\"openDAW/...\": FM Rhodes, organs, pads, house and square basses, brass, plucks, on Tubular, Neon, Vaporisateur). Usually a better start for a genre's bass, keys, strings, brass, guitar or pad than a synth set by hand.", {
                    words: z.string().describe("Words in the name (\"fingered bass\", \"electric piano\", \"strings\", \"pad\"); \"\" lists the soundfonts")},
                    handler((_current, input) => {
                        const words = String(input.words ?? "").trim()
                        if (words === "") {
                            return [...new Map(samples.sounds.map(sound => [sound.soundfont, samples.sounds.filter(other => other.soundfont === sound.soundfont).length])).entries()]
                                .map(([font, count]) => `${font}: ${count} sounds`).join("\n")
                        }
                        const found = samples.searchSounds(words, 40)
                        return found.length === 0 ? "Nothing matches; try fewer or other words."
                            : found.map(sound => sound.source === "preset" ? `${sound.id} (${sound.device}${sound.about ? `: ${sound.about}` : ""})` : sound.id).join("\n")
                    }), {annotations: {readOnlyHint: true}}),
                tool("make_instrument", "A new track playing a sound from sounds (a soundfont preset on openDAW's Soundfont device, or an openDAW factory preset on its synth), optionally with notes from the start. Set its sound once; its notes play as written (keep a bass in the bass register).", {
                    name: z.string().describe(TrackName),
                    sound: z.string().describe("A sound id from sounds (\"GeneralUser GS/Finger Bass\")"),
                    notes: z.array(z.tuple([z.number(), z.number(), z.number(), z.number()])).describe("[beat from 0, MIDI pitch, length in beats, velocity 0..1]; [] for none or with chords"),
                    chords: ChordsArg,
                    melody: MelodyArg,
                    loop_bars: z.number().int().describe("How many bars the notes loop over; 0 for 1 (with chords: the progression's length)"),
                    volume_db: z.number().describe("The track's volume, dB; 0 for unity"),
                    ...Placement},
                    handler(make("soundfont"))),
                ...(samples.effects.length === 0 ? [] : [tool("effect_preset", `Put one of openDAW's factory effect presets at the end of a track's effects (or the master's), already set: ${samples.effects.map(effect => `${effect.name} (${effect.device}${effect.about ? `, ${effect.about}` : ""})`).join("; ")}. Quicker and safer than setting an effect by hand; change its parameters after if the piece needs.`, {
                    track: z.string().describe("The track's ref (t2), or master"),
                    preset: z.string().describe("The preset's name (\"Large Plate\")"),
                    at_bar: Placement.at_bar},
                    handler(async (current, input) => {
                        const snapshot = await current.context.snapshot()
                        if (snapshot === null) {return "Not done: no project is open."}
                        const made = knowledge.effectPreset(input, snapshot)
                        if (typeof made === "string") {return `Not done: ${made}.`}
                        return this.#run(current, made.says, made.code, Number(input.at_bar) || 0)
                    }))])])
        ]
    }

    // A part's notes changed in stages by code (generate.ts): the model names the target and the pacing, not the notes of
    // every stage. Each stage is a script rewriting the region in place (kb.replaceNotes), staged on its bar like the
    // worker's own.
    // The project's key as the facts recorded it ("E minor"), or "".
    #factsKey(context: Coordinator): string {
        const facts = context.notebook?.get("facts") ?? null
        const recorded = facts === null ? null : (JSON.parse(facts.value)?.key?.said as string | undefined) ?? null
        return recorded !== null && !recorded.startsWith("unknown") ? recorded : ""
    }

    // A make_* tool's chords, written into its notes (and its loop, the progression's length) by code.
    // A tool's chords or melody written into its notes (and loop), its drums into its hits (and beats), by code.
    #withComposed(context: Coordinator, input: Record<string, unknown>, beatsPerBar: number): Record<string, unknown> | string {
        const chords = input.chords as ChordSpec | undefined
        if (chords !== undefined && chords.progression.trim() !== "") {
            const written = chordHits({...chords, key: this.#factsKey(context) || undefined}, beatsPerBar)
            if (typeof written === "string") {return written}
            context.card({agent: this.agent, name: this.name, doing: `chords by code: ${chords.progression}`})
            return {...input, notes: written.hits, loop_bars: Number(input.loop_bars) || written.beats / beatsPerBar}
        }
        const melody = input.melody as MelodySpec | undefined
        if (melody !== undefined && melody.pattern.trim() !== "") {
            const written = melodyHits({...melody, key: this.#factsKey(context) || undefined}, beatsPerBar)
            if (typeof written === "string") {return written}
            context.card({agent: this.agent, name: this.name, doing: `notes by code: ${melody.pattern}`})
            return {...input, notes: written.hits, loop_bars: written.beats / beatsPerBar}
        }
        const drums = input.drums as MiniSpec | undefined
        if (drums !== undefined && drums.pattern.trim() !== "") {
            const written = drumHits(drums, beatsPerBar)
            if (typeof written === "string") {return written}
            context.card({agent: this.agent, name: this.name, doing: `drums by code: ${drums.pattern}`})
            return {...input, pattern: "", hits: written.hits, beats: written.beats}
        }
        return input
    }

    // A part onto an existing track (knowledge.part, kb.pattern), its chords written by code.
    async #writePart(current: Current, given: Record<string, unknown>): Promise<string> {
        const snapshot = await current.context.snapshot("full")
        if (snapshot === null) {return "Not done: no project is open."}
        const beatsPerBar = snapshot.timeline.signature[0]
        const input = this.#withComposed(current.context, given, beatsPerBar)
        if (typeof input === "string") {return `Not done: ${input}.`}
        let notes = (input.notes ?? []) as unknown[]
        if (Array.isArray(input.hits)) {        // drums: each role on the track's pad for it
            const hits = input.hits as Array<[number, string, number]>
            const track = snapshot.tracks.find(candidate => candidate.ref === input.track || candidate.name === input.track)
            if (track === undefined) {return `Not done: no track ${String(input.track)}.`}
            const mapped = drumMap(new Set(hits.map(([, role]) => role)), track)
            if (typeof mapped === "string") {return `Not done: ${mapped}.`}
            notes = hits.map(([beat, role, velocity]) => [beat, mapped.notes[role], 0.25, velocity])
            input.loop_bars = Number(input.beats) / beatsPerBar
        }
        const made = this.#knowledge!.part({track: input.track, notes: {notes, loop_bars: Number(input.loop_bars) || 1,
            from_bar: Number(input.from_bar) || 0, bars: Number(input.bars) || 0}}, snapshot)
        if (typeof made === "string") {return `Not done: ${made}.`}
        return this.#run(current, made.says, made.code, Number(input.at_bar) || 0)
    }

    async #evolve(current: Current, input: Record<string, unknown>): Promise<string> {
        const {context} = current
        const knowledge = this.#knowledge!
        const full = await context.snapshot("full")
        if (full === null) {return "Not done: no project is open."}
        const ref = String(input.region)
        const track = full.tracks.find(candidate => candidate.regions.some(region => region.ref === ref))
        const region = track?.regions.find(candidate => candidate.ref === ref)
        if (track === undefined || region === undefined || region.kind !== "notes") {
            const refs = full.tracks.flatMap(candidate => candidate.regions.filter(r => r.kind === "notes").map(r => `${r.ref} (${candidate.name})`))
            return `Not done: ${ref} isn't a notes region; these are: ${refs.join(", ")}.`
        }
        const beatsPerBar = full.timeline.signature[0]
        const at = (pos: string): number => hitOf([pos, 0, 0, 0], beatsPerBar)[0]
        const loopBeats = region.loop !== null ? region.loop * beatsPerBar : at(region.to) - at(region.from)
        const from = (region.notes ?? []).map(note => hitOf(note, beatsPerBar))
        const toNotes = (input.to_notes ?? []) as Note[]
        let to = toNotes.map(note => targetHitOf(note, beatsPerBar)).filter(([beat]) => beat >= 0 && beat < loopBeats)
        const says: string[] = []
        const patternKey = String(input.to_pattern ?? "")
        if (patternKey !== "") {
            const key = String(input.key ?? "") || this.#factsKey(context)
            const pattern = knowledge.patternHits(patternKey, track, key === "" ? {} : {key}, beatsPerBar)
            if (typeof pattern === "string") {return `Not done: ${pattern}.`}
            to = tile(pattern.hits, pattern.beats, loopBeats)
            says.push(...pattern.says)
        }
        const chords = input.to_chords as ChordSpec | undefined
        if (chords !== undefined && chords.progression.trim() !== "") {
            const written = chordHits({...chords, key: chords.key || this.#factsKey(context) || undefined}, beatsPerBar)
            if (typeof written === "string") {return `Not done: ${written}.`}
            to = tile(written.hits, written.beats, loopBeats)
            says.push(`chords ${chords.progression}`)
            context.card({agent: this.agent, name: this.name, doing: `chords by code: ${chords.progression}`})
        }
        const melody = input.to_melody as MelodySpec | undefined
        if (melody !== undefined && melody.pattern.trim() !== "") {
            const written = melodyHits({...melody, key: this.#factsKey(context) || undefined,
                range: rangeOf(from.map(([, pitch]) => pitch))}, beatsPerBar)     // the part keeps to where it plays
            if (typeof written === "string") {return `Not done: ${written}.`}
            to = tile(written.hits, written.beats, loopBeats)
            says.push(`notes ${melody.pattern}`)
            context.card({agent: this.agent, name: this.name, doing: `notes by code: ${melody.pattern}`})
        }
        const drums = input.to_drums as MiniSpec | undefined
        if (drums !== undefined && drums.pattern.trim() !== "") {
            const written = drumHits(drums, beatsPerBar)
            if (typeof written === "string") {return `Not done: ${written}.`}
            const mapped = drumMap(new Set(written.hits.map(([, role]) => role)), track)
            if (typeof mapped === "string") {return `Not done: ${mapped}.`}
            to = tile(written.hits.map(([beat, role, velocity]) => [beat, mapped.notes[role], 0.25, velocity]), written.beats, loopBeats)
            says.push(`drums ${drums.pattern}`, ...mapped.says)
            context.card({agent: this.agent, name: this.name, doing: `drums by code: ${drums.pattern}`})
        }
        if (to.length === 0) {return "Not done: give the target, as to_pattern, to_notes, to_chords, to_melody or to_drums."}
        const count = Math.max(1, Math.min(16, Math.round(Number(input.stages) || 1)))
        const every = Math.max(1, Math.round(Number(input.every_bars) || 1))
        const atBar = Number(input.at_bar) || 0
        const start = atBar > 0 ? atBar : 1
        const stages = morphNotes(from, to, count)
        context.card({agent: this.agent, name: this.name, doing: `evolving ${region.name || ref} in ${count} stages`})
        const results: string[] = []
        for (const [index, notes] of stages.entries()) {
            const code = knowledge.script("replaceNotes", {region: ref, notes})
            if (code === null) {return "Not done: the knowledge base's page helpers (scripts/kb.js) are missing."}
            const bar = atBar <= 0 && index === 0 ? 0 : start + index * every
            const result = await this.#run(current, `${region.name || ref}: stage ${index + 1} of ${count} (${notes.length} notes)`, code, bar)
            results.push(`${index + 1}. ${bar === 0 ? "now" : `bar ${bar}`}: ${result}`)
            if (!/^(Staged|Scheduled|Under way|Applied)/.test(result)) {break}
        }
        return `${ref}: ${from.length} notes to ${to.length}, ${count} stages, every ${every} bar${every === 1 ? "" : "s"}.${says.length > 0 ? ` ${says.join("; ")}.` : ""}\n${results.join("\n")}`
    }

    // An entry's edits, each through the same path as the utility's own (fixed operation or script), timed from one bar.
    async #applyKnowledge(current: Current, key: string, args: Record<string, unknown>, atBar: number): Promise<string> {
        const {context} = current
        const snapshot = await context.snapshot()
        if (snapshot === null) {return "Not applied: no project is open."}
        let planned = this.#knowledge!.expand(key, args, snapshot)
        // A chord pattern without a key: the project's, estimated from its notes (analysis.ts), and said so.
        let estimated = ""
        if (typeof planned === "string" && /needs key|needs the project's key|chord pattern needs/.test(planned) && args.key === undefined) {
            // The recorded facts first (Coordinator, keepFacts): estimating from the notes now would count the agents' own.
            const facts = context.notebook?.get("facts") ?? null
            const recorded = facts === null ? null : (JSON.parse(facts.value)?.key?.said as string | undefined) ?? null
            if (recorded !== null && !recorded.startsWith("unknown")) {
                planned = this.#knowledge!.expand(key, {...args, key: recorded}, snapshot)
                estimated = ` Key: ${recorded}, from the project's facts.`
            }
        }
        if (typeof planned === "string" && /needs key|needs the project's key|chord pattern needs/.test(planned) && args.key === undefined) {
            const full = await context.snapshot("full")
            const found = full === null ? null : analyse(full).key
            if (found !== null) {
                planned = this.#knowledge!.expand(key, {...args, key: `${found.tonic} ${found.mode}`}, snapshot)
                estimated = ` Key: ${found.tonic} ${found.mode}, estimated from the notes (confidence ${found.confidence.toFixed(2)}, runner-up ${found.runnerUp}); pass key to choose another.`
            }
        }
        if (typeof planned === "string") {return `Not applied: ${planned}.`}
        current.applied = planned.map(step => step.says)
        current.appliedBars = Math.max(1, ...planned.map(step => step.at + 1))
        context.card({agent: this.agent, name: this.name, doing: `applying ${key}`})
        const start = atBar > 0 ? atBar : snapshot.playback.bar + 1
        const bars = planned.map(step => atBar <= 0 && step.at === 0 ? 0 : start + step.at)
        const results: string[] = []
        for (const [index, step] of planned.entries()) {
            const bar = bars[index]
            if (step.kind === "op") {
                const owner = this.#owners.get(step.name)
                results.push(owner === undefined ? `${step.says}: no member offers ${step.name}`
                    : await this.#operate(current, owner, step.name, {...step.input, at_bar: bar}))
            } else {
                results.push(await this.#run(current, step.says, step.code, bar))
            }
        }
        return `${key}: ${planned.length} edit${planned.length === 1 ? "" : "s"}.${estimated}\n${results.map((result, index) => `${index + 1}. ${planned[index].says}: ${result}`).join("\n")}`
    }

    // Starts an edit that may land bars from now without waiting for it, so the next one is planned from about the same
    // playhead and the edits keep their spacing. Resolves with the edit's result if it ends at once, else as soon as it's
    // scheduled or under way; a later failure goes to work.late, for the model's next tool result or the producer.
    #start(work: Work, edit: (onStatus: (status: Status) => void) => Promise<string>): Promise<string> {
        let waiting = true, failed = false
        let started: (text: string) => void = () => {}
        const early = new Promise<string>(resolve => {started = resolve})
        const finished = edit(status => {
            // A cancelled step isn't a failure: it was taken back on purpose.
            if (status.state === "failed" || (status.state === "dropped" && status.reason !== "cancelled")) {failed = true}
            if (status.state === "scheduled") {started(`Scheduled, lands at ${status.landsAt ?? "the bar you chose"}; you'll hear back only if it fails. Go on.`)}
            if (status.state === "running") {started("Under way; you'll hear back only if it fails. Go on.")}
        }).then(text => {
            if (failed && !waiting) {work.late.push(text)}
            return text
        })
        work.pending.push(finished)
        return Promise.race([early, finished]).then(text => {
            waiting = false
            return text
        })
    }

    // A fixed operation, borrowed: a lookup answers at once; anything else becomes the owner's step on a fresh
    // snapshot, run as the utility's.
    // A timed one is staged on the board (#stage) unless it's being sent (sending: the board's step, #commit).
    async #operate(current: Current, owner: LlmMember, name: string, input: Record<string, unknown>, sending?: BoardStep): Promise<string> {
        const found = owner.lookup(name, input)
        if (found !== null) {return found}
        const {context, task, work} = current
        const snapshot = await context.snapshot()
        if (snapshot === null) {return "Not done: no project is open."}
        const step = owner.step(name, input, snapshot)
        if (typeof step === "string") {return `Not done: ${step}.`}
        if (sending === undefined && step.when.at === "bar") {return this.#stage(current, step.when.bar, step.says, {op: name, input})}
        step.board = sending?.id
        step.activity = {direction: current.direction.id, ...(current.job !== undefined ? {job: current.job} : {})}
        context.card({agent: this.agent, name: this.name, doing: step.says})
        step.when = anchored(step.when, current.anchor)
        return this.#start(work, onStatus => performStep(context, this.agent, step, task.piece ?? task.message, onStatus)
            .then(result => {
                work.done.push(result)
                return result
            }))
    }

    // A timed edit, kept on the board until the turn ends (ARCHITECTURE.md, "The team's structure").
    #stage(current: Current, bar: number, says: string, action: Action): string {
        const {board} = current.context
        const staged = board.stage(current.direction.id, this.agent, bar, says, action, current.job)
        if (!staged.ok) {return `Not staged: ${staged.reason}.`}
        return `Staged for bar ${bar} (${board.count(current.direction.id, bar)} on that bar in this plan); it goes out with the rest when you reply.`
    }

    // The turn is over: its direction's staged steps go out together, in bar order, from the message's anchor moved
    // past the playhead (board.ts, commitAnchor), so none is late and they land in their bars' order. Failures are
    // said and told to the model with the next message (#finish).
    async #commit(current: Current): Promise<void> {
        const {context} = current
        const steps = context.board.take(current.direction.id, current.job)
        if (steps.length === 0) {return}
        const now = await context.snapshot()
        if (now === null) {
            current.work.late.push(`the plan's ${steps.length} timed edits: not sent, no project is open`)
            return
        }
        if (current.anchor !== null) {current.anchor = commitAnchor(current.anchor, now)}
        for (const step of steps) {
            if (context.board.step(step.id)?.state !== "sent") {continue}   // cancelled meanwhile
            const bar = step.bar
            const {action} = step
            const owner = "op" in action ? this.#owners.get(action.op) : undefined
            const result = "op" in action
                ? owner === undefined ? `no member offers ${action.op}` : await this.#operate(current, owner, action.op, {...action.input, at_bar: bar}, step)
                : await this.#run(current, action.description, action.script, bar, step)
            if (/^Not\b|failed|^no member|Another script/.test(result)) {current.work.late.push(`${step.says}: ${result}`)}
        }
    }

    #notebook(context: Coordinator, name: string, input: Record<string, unknown>): string {
        const notebook = context.notebook
        if (notebook === null) {return "No project is open, so there's no notebook."}
        const key = String(input.key)
        if (name === "remember") {
            notebook.set(key, String(input.kind) as Kind, String(input.summary), String(input.value))
            return `Kept as "${key}".`
        }
        if (name === "recall") {
            const entry = notebook.get(key)
            if (entry === null) {return `No entry "${key}".`}
            return entry.value.length > MaxRecall ? `${entry.value.slice(0, MaxRecall)}\n… (cut at ${MaxRecall} characters)` : entry.value
        }
        return notebook.delete(key) ? `Forgot "${key}".` : `No entry "${key}".`
    }

    async #look(context: Coordinator, code: string): Promise<string> {
        context.card({agent: this.agent, name: this.name, doing: "looking…"})
        const {ok, value} = await context.look(this.agent, code)
        return ok ? value : `Error: ${value}`
    }

    async #run(current: Current, description: string, code: string, bar: number, sending?: BoardStep): Promise<string> {
        const {context, work} = current
        if (sending === undefined && bar > 0) {return this.#stage(current, bar, description, {script: code, description})}
        context.card({agent: this.agent, name: this.name, doing: description})
        const claimed = context.claim(this.agent, ["project.script"], description)
        if (!claimed.ok) {return "Another script is running; try again in a moment."}
        const when: When = anchored(bar > 0 ? {at: "bar", bar} : {at: "asap"}, current.anchor)
        const fresh = await context.snapshot()
        return this.#start(work, async onStatus => {
            try {
                let landsAt = ""
                const status = await context.request(this.agent, {op: "script", code, description}, when,
                    fresh?.at.seq ?? 0, description, update => {
                        landsAt = update.landsAt ?? landsAt
                        onStatus(update)
                    }, sending?.id, {direction: current.direction.id, ...(current.job !== undefined ? {job: current.job} : {})})
                if (status.state === "applied") {
                    work.done.push(`${description}${landsAt ? ` (from ${landsAt})` : ""}`)
                    const corrected = status.result?.corrected ?? []
                    return `Applied${landsAt ? ` at ${landsAt}` : ""}: ${status.result?.updates ?? 0} changes. Returned: ${status.result?.value ?? "undefined"}${corrected.length > 0 ? `. Corrected, outside openDAW's ranges (look up a field's range before writing it): ${corrected.join("; ")}` : ""}`
                }
                if (status.state === "dropped" && status.reason === "cancelled") {return `${description}: cancelled before it landed.`}
                if (status.state === "dropped") {return `${description}: undone, it changed a control the producer is holding. Leave that control alone.`}
                return `${description}: failed (${status.reason}): ${status.detail ?? ""}. Nothing was changed.`
            } finally {
                context.release(this.agent, ["project.script"])
            }
        })
    }

    // Says the summary at once and frees the utility for the next message; the card follows the edits still landing,
    // and anything that fails after is said too, and told to the model with the next message.
    // A worker's piece (mode "job"): a fresh session, the captain's direction and anchor, so its timed steps join the
    // plan's other pieces on one timeline. Resolves with its report to the captain; its timed steps stay staged on the
    // board until the direction's last job is done, then go out together (send), so pieces planned at different
    // speeds still land in their bars' order.
    async job(context: Coordinator, job: { id: string, piece: string, task: Piece, message: string, direction: Direction, anchor: Anchor | null },
              snapshot: Snapshot): Promise<string> {
        context.card({agent: this.agent, name: this.name, doing: `${job.id}: ${job.piece}`})
        const session = this.#session = this.#open(context, snapshot, job.task.kind)
        const work: Work = {done: [], pending: [], late: []}
        const current: Current = {context, task: {message: job.message, piece: job.piece, hints: null}, work, calls: 0,
            direction: job.direction, anchor: job.anchor, job: job.id}
        this.#current = current
        this.#handSeen = 0
        session.inbox.push(JSON.stringify({
            your_task: job.task, producer_message: job.message,
            ...(job.anchor !== null ? {playback_at_message: {bar: job.anchor.bar}} : {}),
            ...this.#hand(context, "producer_changed"),
            project: {...focus(projectFor(snapshot, true), job.task.tracks), regions: snapshot.tracks.map(track => ({track: track.ref,
                regions: track.regions.map(({ref, name, from, to, loop}) => ({ref, name, from, to, loop}))}))},
            notebook: context.notebook?.list() ?? [],
            ...this.#knowledgeFor(job.task, job.message),
            devices: this.#devices,
            ...(EffectKinds.includes(job.task.kind) ? Object.assign({}, ...this.#team.map(member => member.context(snapshot))) : {})
        }))
        try {
            const summary = await this.#reply(context, session)
            const report = current.said ?? asChatLine(summary)
            context.card({agent: this.agent, name: this.name, doing: `${job.id} planned`})
            if (work.late.length > 0) {context.jobLate(job.id, work.late.map(line => line.replace(/\.+$/, "")).join("; "))}
            return report || (work.done.length > 0 ? `${work.done.join("; ")}.` : "Changed nothing.")
        } catch (error) {
            context.board.drop(job.direction.id)
            throw error
        } finally {
            this.#current = null
            this.close()
        }
    }

    // Sends a direction's staged steps, all its workers' (Coordinator, when its last job is done): any worker can, since
    // steps are data. Failures go to the captain (Coordinator.jobLate) once everything has landed.
    // job: send only that job's steps (each worker's part goes out when it's planned, 2026-11-23).
    async send(context: Coordinator, direction: Direction, anchor: Anchor | null, job?: string): Promise<void> {
        const work: Work = {done: [], pending: [], late: []}
        await this.#commit({context, task: {message: direction.text, piece: null, hints: null}, work, calls: 0, direction, anchor,
            ...(job !== undefined ? {job} : {})})
        void Promise.all(work.pending).then(() => {
            context.card({agent: this.agent, name: this.name, doing: "idle"})
            if (work.late.length > 0) {context.jobLate(null, work.late.map(line => line.replace(/\.+$/, "")).join("; "), direction)}
        })
    }


}
