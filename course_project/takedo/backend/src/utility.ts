import {existsSync} from "node:fs"
import {createSdkMcpServer, getSessionInfo, query, type Query, type SDKUserMessage, tool} from "@anthropic-ai/claude-agent-sdk"
import type Anthropic from "@anthropic-ai/sdk"
import type {CallToolResult} from "@modelcontextprotocol/sdk/types.js"
import {z} from "zod"
import type {Actor, Plan, Snapshot, Status, When} from "../../shared/protocol.ts"
import {type Action, type Anchor, commitAnchor, type Direction, MaxPerBar, planSlide, type Step as BoardStep} from "./board.ts"
import type {Coordinator} from "./coordinator.ts"
import type {Catalog} from "./catalog.ts"
import {Kinds as KnowledgeKinds, type Knowledge} from "./knowledge.ts"
import {analyse} from "./analysis.ts"
import {type AgentState, Kinds, type Kind} from "./notebook.ts"
import {Limits, type LlmMember, type Member, performStep, projectFor, type Task} from "./members.ts"

// The utility (STRATEGY.md, "Keep the open path"): anything openDAW can do that the members' fast operations don't
// cover, done in openDAW directly with code, the way the first live experiment did it (poc/edit_bench/live/eval.mjs). It looks around with read-only
// JavaScript, edits with scripts (each one edit, one undo step, attributed to it, refused for controls the producer
// holds), sees the result or the error, and tries again. It also has every member's fixed operations as tools,
// borrowed from them, for whatever they cover: those land on bars, ramp over time and are checked before they run.
// Slow-tier work, seconds to tens of seconds; the Team Lead hands it out so its own reply isn't held up.
//
// It runs as a Claude Agent SDK session (decided 2026-11-11, STRATEGY.md): Claude Code's loop as a library, kept open
// across the producer's messages (streaming input) and summarized by the SDK when it grows long. Our tools are an
// in-process MCP server ("takedo"); openDAW's source is read with Claude Code's own Read, Grep and Glob, from the
// pinned tree `make types` copies out (the session's working directory).

// Tool calls per message: a whole transformation takes looks, scripts and fixed operations (the hand-written loop
// allowed 30 rounds of several calls; running out made it stop halfway and offer the rest).
const MaxCalls = 80
const MaxRecall = 40000
const SourceTools = ["Read", "Grep", "Glob"]
// A message TakeDo was restarted in the middle of is picked back up if it's this recent; older, the model is only told.
const RecoverMs = 10 * 60000

// One task's edits: what landed (for the card and the reply), what's still landing, and failures nobody's heard yet.
type Work = { done: string[], pending: Promise<string>[], late: string[] }
// The message being worked on, for the tools' handlers (one at a time: they share the session). direction: its entry
// on the board, which holds its timed edits until the turn ends; applying: a knowledge entry's edits are being staged
// (its own steps may share a bar beyond the per-bar limit, which it was checked against as a whole).
type Current = { context: Coordinator, task: Task, work: Work, calls: number, said?: string, direction: Direction,
    anchor: Anchor | null, applying?: boolean, applied?: string[], appliedBars?: number, job?: string }   // job: a worker's piece   // applied: what a knowledge entry's steps said they'd do (the fast route's reply)
// Where the playhead was when the producer's message arrived: the plan's bars count from it (When's from).
const anchorOf = (snapshot: Snapshot): Anchor | null => snapshot.playback.position === undefined ? null
    : {position: snapshot.playback.position, played: snapshot.playback.played, bar: snapshot.playback.bar}
const anchored = (when: When, anchor: Anchor | null): When =>
    when.at === "bar" && anchor !== null ? {...when, from: {position: anchor.position, played: anchor.played}} : when

// The fast route's chat line: an entry's steps in the producer's words ("boombap-1 on TR-808, bars 5–6" → "a boombap
// beat on TR-808"; "add_effect (production/lofi)" → "the lofi treatment"), within a chat line's limits.
export const routeReply = (name: string, steps: ReadonlyArray<string>, bars: number): string => {
    const phrases = [...new Set(steps.map(says => {
        const pattern = /^([\w-]+?)(?:-\d+)? on (.+?), bars/.exec(says)
        if (pattern !== null) {return `${pattern[1].replace(/-/g, " ")} on ${pattern[2]}`}
        const treatment = /\((?:production|chain)\/([\w-]+)\)/.exec(says)
        if (treatment !== null) {return `the ${treatment[1].replace(/-/g, " ")} treatment`}
        return says.replace(/\s*\([^)]*\)$/, "")
    }))]
    const listed = phrases.length < 2 ? phrases.join("") : `${phrases.slice(0, -1).join(", ")} and ${phrases.at(-1)}`
    const full = `Putting in ${name} over the next ${bars} bars: ${listed}.`
    return phrases.length > 0 && replyProblem(full) === null ? full : `Putting in ${name} over the next ${bars} bars.`
}

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
const KnowledgeTools = `- knowledge, apply_knowledge, learn: the team's knowledge base, shared across projects (\`knowledge\` with your first message lists every entry as "key: summary", with a family of similar entries on one line of keys; later messages add new ones). Kinds: genre (what's played: tempo, groove, harmony, parts) and production (how it's treated: sound, effects, mix; lofi is a production style, hip hop a genre); sound (an instrument set up: openDAW's ~1,200 bundled DX7 voices for Tubular among them); chain (effects with settings); pattern (drum grooves by role, chord progressions as numerals); note (openDAW facts: step tables, units, fields). Check it before reading source, researching or writing a sound, chain or pattern from scratch: read several entries in one knowledge call; apply_knowledge runs an entry's edits (fixed operations and scripts, timed from the bar you give, like your own); entries without apply are for reading. Adapt freely: an entry is a starting point, not a rule. Entries marked draft, and anything checked only "written" or "imported", haven't been heard: listen-worthy, not proven. learn keeps something that worked (a sound, a chain, a pattern you wrote) as a draft entry for later sessions and other projects. A message may carry knowledge_candidates: entries a fast judge thought likely for it, best first; look at them before searching, but it is often wrong. When it is sure, the fast route applies an entry without you, and since_your_last_reply says what it did.
`
const KnowledgeKey = "- A chord pattern needs the project's key: pass the one in your notebook's facts.\n"
const KnowledgeSlot = "\u0000knowledge-tools", KeySlot = "\u0000knowledge-key"
export const System = `You are the utility on an AI music production team (the producer sees you as the Team Lead: speak as "I", and never call yourself the utility) working live in openDAW (a web DAW) with a producer, usually while the track plays. You can do anything openDAW supports, working on the project directly with JavaScript. Your conversation carries on across the producer's messages (each brings a fresh project summary), but its older parts are summarized when it grows long: keep what you'll need later in your notebook. You get the producer's message, the chat before you joined, if any (\`conversation\`); "go on", "do the rest" or "all of it" refer to what came before, and your task when the work was split (do only that part).

A direction toward a style, genre or feel ("make it lofi", "evolve this into dub") asks for the whole transformation, not a first step. Work out what that style needs here: tempo and feel, drums (pattern, swing, ghost notes, velocities), harmony (chords, voicings, extensions), each part's sound (instrument choice and settings, a new track when a part's instrument can't get there), effects and mix. Do all of it. When it should happen gradually, stage it: changes timed across the bars it names (or 8 to 16 bars), each stage small, all scheduled before you finish.

Tools:
- The team's fixed operations (volume, pan, mute, add_effect, effect_params, set_param, remove_effect): use them for anything they cover. They land on the bar you choose, ramp over time (a script can't: it changes things at one instant), and are checked against the producer's controls before they run. Targets are refs from the project summary or snapshot(); a track or effect your script just made has one once that edit has landed. To ramp an effect you're adding, use add_effect's then.
- look: run read-only JavaScript to inspect the project. Writes fail here.
- run: change the project with a short script, for what no fixed operation does. It runs inside one edit: one undo step for the producer, rolled back entirely if it throws. It lands on the bar you choose (0: as soon as possible).
- An edit for a later bar (fixed operation or script, at_bar above 0) is staged: it answers at once, and the whole plan goes out together when you reply, timed from where the playhead was when the message arrived, so its steps land in their bars' order however long you take. Edits for now (at_bar 0) land at once. Failures of staged edits reach you with the next message. A look sees only what has landed.
- reply: when you've finished, call it once with what the producer reads, as in a chat with a bandmate mid-session: one or two short, plain sentences on what you changed and how it will sound (or why you couldn't). No lists or markdown; no bar numbers, refs, dB values, device settings or tempo steps unless they asked (the team view shows every edit and when it lands); no caveats about not having heard or checked it. Ask at most one short question, only when you need the answer. It checks the form and tells you what to fix. Nothing else you write is shown: keep text between tool calls to a few words, and after reply end your turn.
- offer_control, remove_control: dials on your card in the team view, for the producer to steer what you're doing without typing. When you take on a direction that keeps going or that the producer may want more or less of (a gradual change, a style, how busy or how wet), offer one dial for it: its ends in the producer's words, meaning what you'll change as it moves. Offer it as you finish the task and say so in your reply in a few words. Keep the ones that still apply (at most 3); remove one that no longer does. Their positions are in the notebook's "controls" entry. A move reaches you as control_moved instead of producer_message: act on it as a direction (move what's still to come toward the new position, and what's playing now if the move is large), in proportion to how far it moved, then reply in a sentence.
- cancel: take back timed edits that haven't landed (coming_steps, with each message, lists them by the message they're for). Use it when the producer says stop, less, or changes their mind about something still coming, or when a step would undo what they just did by hand. What has landed stays; to undo it, change it back.
- producer_changed (with a message) and "Meanwhile the producer changed by hand" (in a tool result): what the producer did in openDAW themselves since you last heard (levels, pans, effect settings). That's their call: keep it and build on it, and don't move those settings back or plan over them unless they ask; mention it in your reply only when it changes what you do.
- Read, Grep, Glob: openDAW's own source, the version that's running; your working directory is its root (packages/…). Read it for what the notes below don't say: a device's fields and their ranges (box schemas in packages/studio/forge-boxes/src/schema/devices/), step tables (adapters in packages/studio/adapters/src/devices/), how an API call works, the user manual (packages/app/manual/public/). Look before writing fields you haven't used.
${KnowledgeSlot}- remember, recall, forget: your notebook, kept on disk per project and listed with every message (\`notebook\`: key, kind, summary). Your conversation may be summarized between messages; the notebook isn't. Keep in it what you'll want later: the producer's wishes and taste (note), a staged plan and where it stands (plan), parts you wrote as notes (clip), sounds you designed with their settings (sound), scripts worth reusing (script). "start" (state) is the whole project before the agents' first edit this session, kept for you. "facts" (state) is what's established about this project: its key, tempo, meter, each part's register, and the overview; its summary comes with every message. Write anything pitched (chords, melodies, bass lines) in that key, and keep each part in its role (a part in the bass register stays the bass). If the producer says otherwise, remember the correction under "facts".

Both run a function body with \`takedo\` in scope (its parts are also plain names: project, api, lib, ref, bar, ppqn, pos, snapshot); \`return\` a value to see it (JSON; openDAW objects show as their class name, so return plain data). look's body may await; run's is synchronous.

\`takedo\`:
- project: openDAW's Project. project.rootBoxAdapter.audioUnits.adapters(): the tracks (AudioUnitBoxAdapter; .label, .isOutput for the master, .box, .namedParameter.{volume,panning,mute,solo}, .tracks.values(): its timeline tracks (an array), each with .box (a TrackBox) and .regions.collection.asArray()).
- Regions (NoteRegionBoxAdapter, AudioRegionBoxAdapter): .position, .duration, .loopOffset, .loopDuration, .complete (end), .label, .mute, .box. A region whose loopDuration is shorter than its duration repeats its content. Change one through its box: region.box.duration.setValue(pulses), region.box.position.setValue(...), region.box.loopDuration.setValue(...). Note regions: .optCollection.unwrap().events.asArray() gives notes (.position relative to the region, .duration, .pitch, .velocity 0..1, .box).
- api: project.api. createNoteRegion({trackBox, position, duration, name, loopDuration}), createNoteEvent({owner: regionBox, position, duration, pitch, velocity}), createInstrument(factory) → {audioUnitBox, trackBox, instrumentBox}, insertEffect(audioUnitBox.audioEffects, factory), deleteAudioUnit(audioUnitBox), duplicateNotes(noteAdapters).
- lib: {std, dsp: {PPQN}, adapters, core}: openDAW's libraries (lib.adapters.InstrumentFactories.Named, lib.core.EffectFactories.AudioNamed, lib.dsp.PPQN.Quarter = 960).
- ref("t1") → that track's AudioUnitBoxAdapter, ref("t1.fx1") → an effect's adapter, ref("r3") → a region's adapter: the refs in the project summary.
- bar: pulses per bar; ppqn("5.1.1") → pulses; pos(pulses) → "5.1.1". Positions are 1-based bars.beats.sixteenths.
- snapshot(): the project, fresh, in the adapter's shape (not quite the summary's): playback (playhead, loop), timeline, tracks[] with ref, name, mix.{volume (dB), pan, mute}, effects[] (key, name, ref, params[] with ref, name, value, display), regions; master.{volume, effects}. Nothing else is in scope (no \`playback\`, \`tracks\` or \`project_summary\` variables).

Recipes that work (inside run):
- A new named track with a bar of notes: const {audioUnitBox, trackBox, instrumentBox} = api.createInstrument(lib.adapters.InstrumentFactories.Vaporisateur); instrumentBox.label.setValue("Lead"); const region = api.createNoteRegion({trackBox, position: 0, duration: bar, name: "Lead"}); api.createNoteEvent({owner: region, position: 0, duration: lib.dsp.PPQN.Quarter, pitch: 60, velocity: 0.8});
- A track's name is its instrument's label: ref("t1").inputAdapter.unwrap().labelField.setValue("Bass").
- An instrument's settings: ref("t2").inputAdapter.unwrap().namedParameter (e.g. Cubed: cutoff, resonance, envMod, decay, accent; Vaporisateur: cutoff, resonance, attack, decay, sustain, release, …); set them with .setValue(v). A drum machine (Playfield) has none: its sounds are samples by pad.
- A track made in this script has no adapter yet (ref and audioUnits.adapters() don't find it until the edit ends): set its level with audioUnitBox.volume.setValue(dB) and its instrument's settings on instrumentBox's fields (instrumentBox.cutoff.setValue(2200)), with the names namedParameter shows on a track of that instrument. Every field has a range (the box schema's constraints; a parameter's valueMapping); a value outside it can crash the audio engine, so TakeDo brings it back in and the result lists what it corrected.
- A level at once: ref("t1").namedParameter.volume.setValue(-12) (dB); for a fade over time, use the volume tool instead. Always set parameter values through openDAW's parameter objects like this (namedParameter, or an effect's parameter adapters), never a box's field directly: when the producer records, only those writes become automation. Structural edits (regions, notes, devices) are unaffected.
- Lengthen a region and loop its content: r.box.loopDuration.setValue(r.loopDuration); r.box.duration.setValue(16 * bar).

Rules:
- Set up anything you create in the same script that creates it (its name, level, mute, notes), so it's never heard half-made; use the fixed tools for changes over time, after.
- Look before you change anything you haven't seen; keep scripts small and do one job each; check the result with a look when it matters.
- Change only what the task asks. Decided limits, for now: ${Limits} \`devices\` lists the devices you may add, by kind, as named in openDAW's factories.
- Anything else openDAW can do, you can: never answer that it can't be done or wasn't built; look up how and do it.
- Land changes ahead of the playhead (\`playback.bar\`) when timing matters; structural changes (lengths, new regions) can land as soon as possible.
- When the loop is on (\`playback.loop\`), every bar counts from where the playhead was when the producer's message arrived (the summary's playback.bar), however long you take to plan it: a bar inside the loop is its next pass after that, a bar past the loop's end counts bars of playing as if the loop were unrolled (playhead in bar 2 of a 4-bar loop: at_bar 2 lands on the next bar line, at_bar 3 after 1 bar, at_bar 1 after 3, at_bar 10 after 8 bars, at the loop's bar 2), so the steps of a gradual change keep their order and spacing.
- Staging a gradual change: one or two edits per bar (a fourth on one bar is refused: other pieces of the plan share its bars), the steps a few bars apart. A steady glide (tempo, a level, a filter) is one edit that ramps (a fixed operation's ramp, or a script writing tempo automation), not a step per bar. Every edit you stage lands: never stage a placeholder or a test. Bring an effect in gently (dry, or its mix low) and raise it with add_effect's then, not at full strength. A knowledge chain's effects all land on one bar: give it a bar of its own.
- A region's notes play on every pass of its loop: a script that rewrites them changes every repeat from when it lands, which is how a staged change evolves the part over time.
${KeySlot}- Do the whole task before you finish: never stop after a first part to offer the next, or ask whether to do a part that was asked for. Make several calls per round when they don't depend on each other.
- If something fails twice the same way, stop and say what's in the way.`

// The worker's prompt (the captain roster, ARCHITECTURE.md "The team's structure"): the same, but it does one piece
// the captain handed it, in a fresh session, reports to the captain, and leaves controls and cancelling to the captain.
export const WorkerSystem = System
    .replace(`You are the utility on an AI music production team (the producer sees you as the Team Lead: speak as "I", and never call yourself the utility) working live in openDAW (a web DAW) with a producer, usually while the track plays. You can do anything openDAW supports, working on the project directly with JavaScript. Your conversation carries on across the producer's messages (each brings a fresh project summary), but its older parts are summarized when it grows long: keep what you'll need later in your notebook. You get the producer's message, the chat before you joined, if any (\`conversation\`); "go on", "do the rest" or "all of it" refer to what came before, and your task when the work was split (do only that part).`, `You are a worker on an AI music production team working live in openDAW (a web DAW) with a producer, usually while the track plays. The Team Lead hands you one piece of a direction (your_task, with the producer_message it is for); other workers may be doing other pieces at the same time, so do only yours and change only what it names. You can do anything openDAW supports, working on the project directly with JavaScript. You start fresh for each piece: your notebook holds what earlier work kept.`)
    .replace(`A direction toward a style, genre or feel ("make it lofi", "evolve this into dub") asks for the whole transformation, not a first step. Work out what that style needs here: tempo and feel, drums (pattern, swing, ghost notes, velocities), harmony (chords, voicings, extensions), each part's sound (instrument choice and settings, a new track when a part's instrument can't get there), effects and mix. Do all of it. When it should happen gradually, stage it: changes timed across the bars it names (or 8 to 16 bars), each stage small, all scheduled before you finish.`, `Do the whole piece. When it should happen gradually, stage it: changes timed across the bars it names (or 8 to 16 bars), each stage small, all scheduled before you finish.`)
    .replace(`- reply: when you've finished, call it once with what the producer reads, as in a chat with a bandmate mid-session: one or two short, plain sentences on what you changed and how it will sound (or why you couldn't). No lists or markdown; no bar numbers, refs, dB values, device settings or tempo steps unless they asked (the team view shows every edit and when it lands); no caveats about not having heard or checked it. Ask at most one short question, only when you need the answer. It checks the form and tells you what to fix. Nothing else you write is shown: keep text between tool calls to a few words, and after reply end your turn.`, `- reply: when you've finished, call it once with your report to the Team Lead: one or two plain sentences on what you changed or staged and anything you couldn't do (and why). No lists or markdown. After reply end your turn.`)
    .replace(`- offer_control, remove_control: dials on your card in the team view, for the producer to steer what you're doing without typing. When you take on a direction that keeps going or that the producer may want more or less of (a gradual change, a style, how busy or how wet), offer one dial for it: its ends in the producer's words, meaning what you'll change as it moves. Offer it as you finish the task and say so in your reply in a few words. Keep the ones that still apply (at most 3); remove one that no longer does. Their positions are in the notebook's "controls" entry. A move reaches you as control_moved instead of producer_message: act on it as a direction (move what's still to come toward the new position, and what's playing now if the move is large), in proportion to how far it moved, then reply in a sentence.` + "\n", "")
    .replace(`- cancel: take back timed edits that haven't landed (coming_steps, with each message, lists them by the message they're for). Use it when the producer says stop, less, or changes their mind about something still coming, or when a step would undo what they just did by hand. What has landed stays; to undo it, change it back.` + "\n", "")
    .replace(`every bar counts from where the playhead was when the producer's message arrived (the summary's playback.bar)`, `every bar counts from where the playhead was when the producer's message arrived (playback_at_message.bar)`)

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

export class Utility implements Member {
    readonly agent: Actor = "agent:utility"
    readonly role = "utility"
    readonly name = "Utility"
    readonly area = "anything openDAW can do"
    readonly can = "read the project and change it directly with short openDAW scripts (extend or duplicate clips, add tracks or regions, write or rework notes, anything openDAW supports); slower and costlier, seconds to tens of seconds"
    readonly wantsHints = false

    readonly #team: ReadonlyArray<LlmMember>
    readonly #devices: Record<string, string[]>
    readonly #source: string
    readonly #knowledge: Knowledge | null
    readonly #owners = new Map<string, LlmMember>()   // who owns each borrowed fixed operation
    readonly #indexed = new Set<string>()              // knowledge keys this session has been shown
    #session: Session | null = null
    // The open session's id (the SDK's), once it has said; whether it was resumed; and turns it has finished since,
    // so a resume that fails at once is dropped rather than retried forever.
    #sessionId: string | null = null
    #resumed = false
    #okTurns = 0
    #current: Current | null = null
    #queue: Promise<void> = Promise.resolve()
    #unheard: string[] = []   // failures after a reply, for the model with the next message
    // The board's steps after a restart (Coordinator, "waiting"): still coming, and lost; told with the next turn.
    #reconciled: { coming: BoardStep[], lost: BoardStep[] } | null = null
    #handSeen = 0             // the producer's changes told so far (Coordinator.handChanges)

    // team: the members whose fixed operations it borrows; catalog: which devices it may add; source: the root of
    // openDAW's source tree, the session's working directory; knowledge: the knowledge base (knowledge.ts), if loaded.
    // mode: "session", one long-lived session for every message (the ROSTER=team path, until it's retired); "job", a
    // worker for one piece the captain hands out, in a fresh session (job()).
    readonly #mode: "session" | "job"

    constructor(team: ReadonlyArray<LlmMember>, catalog: Catalog, source: string, knowledge: Knowledge | null = null,
                mode: "session" | "job" = "session") {
        this.#mode = mode
        this.#team = team
        this.#source = source
        this.#knowledge = knowledge
        this.#devices = {}
        catalog.devices().filter(device => device.allowed)
            .forEach(device => (this.#devices[device.kind] ??= []).push(device.factory))
    }

    // The generalist: every operation, scripts included.
    may(_plan: Plan): boolean {return true}

    // Something the model should know with the next message (an engine crash and what was undone).
    notice(text: string): void {this.#unheard.push(text)}

    // The board after (re)connecting: steps still coming and steps lost, told with the next turn (recover, or #work).
    reconciled(coming: BoardStep[], lost: BoardStep[]): void {
        this.#reconciled = coming.length === 0 && lost.length === 0 ? null : {coming, lost}
    }

    // Timed edits not landed yet, by direction, with short ids for cancel (none: {}).
    #coming(context: Coordinator): Record<string, unknown> {
        const outstanding = context.board.outstanding()
        if (outstanding.length === 0) {return {}}
        return {coming_steps: outstanding.map(({direction, steps}) => ({for: direction?.text ?? "?",
            steps: steps.map(step => `${step.id.slice(0, 8)}: ${step.says} (bar ${step.bar}, ${step.state === "staged" ? "staged" : "waiting"})`)}))}
    }

    // The producer's changes in openDAW since the model last heard, under key (none: {}).
    #hand(context: Coordinator, key: string): Record<string, unknown> {
        const {lines, next} = context.handChanges(this.#handSeen)
        this.#handSeen = next
        return lines.length === 0 ? {} : {[key]: lines}
    }

    // The reconciled board in words, for the model: once.
    #boardNote(): string {
        const reconciled = this.#reconciled
        this.#reconciled = null
        if (reconciled === null) {return ""}
        const list = (steps: BoardStep[]) => steps.map(step => `${step.says} (bar ${step.bar}${step.detail !== undefined ? `, ${step.detail}` : ""})`).join("; ")
        return [reconciled.coming.length > 0 ? `Timed edits still coming as planned (they kept waiting; don't plan them again): ${list(reconciled.coming)}.` : "",
            reconciled.lost.length > 0 ? `Timed edits that won't land: ${list(reconciled.lost)}.` : ""].filter(text => text !== "").join(" ")
    }

    // Ends the session process (the page went away, the project changed, or a turn failed). The SDK keeps the
    // conversation on disk and the project's notebook says which it was, so the next message resumes it.
    close(): void {
        this.#session?.inbox.close()
        this.#session?.query.close()
        this.#session = null
        this.#sessionId = null
    }

    // The project just opened (also after a restart, when the page reconnects): a message the last session was in
    // the middle of is finished now, told to the model as such.
    async recover(context: Coordinator): Promise<void> {
        const notebook = context.notebook
        const state = notebook?.agentState() ?? null
        if (notebook === null || state?.pending == null) {return}
        const {message, t} = state.pending
        notebook.setAgentState({...state, pending: null})
        const recent = Date.now() - t < RecoverMs
        context.event("agent_session", {recover: message, recent})
        // A round trip to the page first: the page sends which edits are still waiting before it answers (the board).
        await context.snapshot()
        const board = this.#boardNote()
        this.#unheard.push(`TakeDo restarted while you were working on the producer's message ${JSON.stringify(message)}: your last tool call may not have finished; edits for now that had landed are in the project.${board === "" ? "" : ` ${board}`} ${recent
            ? "Finish that message now: check the project first, and don't redo what's already there."
            : "That was a while ago: don't pick it up unless the producer asks."}`)
        if (!recent) {return}
        context.say(this.agent, "I got restarted partway through that; picking it back up.")
        const snapshot = await context.snapshot()
        if (snapshot !== null) {await this.handle(context, {message, piece: null, hints: null}, snapshot)}
    }

    // One task at a time: they share the session.
    handle(context: Coordinator, task: Task, snapshot: Snapshot): Promise<void> {
        const next = this.#queue.then(() => this.#work(context, task, snapshot))
        this.#queue = next.catch(() => {})
        return next
    }

    // A control the producer moved (Coordinator.#control): built when its turn comes, so the latest position is the one
    // told; null when there's nothing left to tell.
    steer(context: Coordinator, build: () => Promise<{ task: Task, snapshot: Snapshot } | null>): Promise<void> {
        const next = this.#queue.then(async () => {
            const built = await build()
            if (built !== null) {await this.#work(context, built.task, built.snapshot)}
        })
        this.#queue = next.catch(() => {})
        return next
    }

    // The knowledge route (router.ts, pickKnowledge): an entry Jev was sure of, applied with no model turn, queued
    // like a message. The session hears about it with the next message, so the model knows what changed.
    applyEntry(context: Coordinator, task: Task, key: string, args: Record<string, unknown>, snapshot: Snapshot): Promise<void> {
        const next = this.#queue.then(async () => {
            if (this.#owners.size === 0) {
                this.#team.forEach(owner => owner.tools(withEveryTool(snapshot)).forEach(member => {
                    if (!this.#owners.has(member.name)) {this.#owners.set(member.name, owner)}
                }))
            }
            const work: Work = {done: [], pending: [], late: []}
            const current: Current = {context, task, work, calls: 0, direction: context.board.direction(task.message),
                anchor: anchorOf(snapshot)}
            this.#current = current
            try {
                const result = await this.#applyKnowledge(current, key, args, 0)
                await this.#commit(current)
                this.#unheard.push(`The fast route applied ${key} for the producer's message ${JSON.stringify(task.message)}, without you: ${result}`)
                const failed = result.startsWith("Not applied")
                await this.#finish(context, failed ? `I couldn't apply ${key}: ${result.replace(/^Not applied: /, "")}`
                    : routeReply(key.split("/")[1].replace(/-/g, " "), current.applied ?? [], current.appliedBars ?? 8), work)
            } finally {
                this.#current = null
            }
        })
        this.#queue = next.catch(() => {})
        return next
    }

    async #work(context: Coordinator, task: Task, snapshot: Snapshot): Promise<void> {
        context.card({agent: this.agent, name: this.name, doing: "looking…"})
        const opening = this.#session === null
        const stored = opening ? await this.#stored(context) : null
        const fresh = opening && stored === null
        const session = this.#session ?? (this.#session = this.#open(context, snapshot, stored?.session))
        if (opening) {
            this.#resumed = stored !== null
            this.#okTurns = 0
            this.#sessionId = stored?.session ?? null
            // It has seen the index already, in the conversation it resumes.
            if (stored !== null) {this.#knowledge?.index().forEach(line => this.#indexed.add(line.key))}
            context.event("agent_session", {session: this.#sessionId, resumed: stored !== null})
        }
        const pending = {message: task.message, t: Date.now()}
        if (this.#sessionId !== null) {context.notebook?.setAgentState({session: this.#sessionId, pending})}
        const boardNote = this.#boardNote()
        if (boardNote !== "") {this.#unheard.push(boardNote)}
        const work: Work = {done: [], pending: [], late: []}
        const direction = context.board.direction(task.message, task.control === true)
        this.#current = {context, task, work, calls: 0, direction, anchor: anchorOf(snapshot)}
        session.inbox.push(JSON.stringify({
            ...(fresh && task.history !== undefined && task.history.length > 0 ? {conversation: task.history} : {}),
            ...(this.#unheard.length > 0 ? {since_your_last_reply: this.#unheard.splice(0)} : {}),
            ...(task.control === true ? {control_moved: task.message} : {producer_message: task.message}), ...this.#hand(context, "producer_changed"), ...this.#coming(context), ...(task.piece !== null ? {your_task: task.piece} : {}),
            ...(task.candidates !== undefined && task.candidates.length > 0 ? {knowledge_candidates: task.candidates} : {}),
            project: {...projectFor(snapshot, true), regions: snapshot.tracks.map(track => ({track: track.ref,
                regions: track.regions.map(({ref, name, from, to, loop}) => ({ref, name, from, to, loop}))}))},
            notebook: context.notebook?.list() ?? [],
            ...this.#knowledgeLines(fresh),
            ...(fresh ? {devices: this.#devices, ...Object.assign({}, ...this.#team.map(member => member.context(snapshot)))} : {})
        }))
        try {
            const summary = await this.#reply(context, session, pending)
            this.#okTurns++
            if (this.#sessionId !== null) {context.notebook?.setAgentState({session: this.#sessionId, pending: null})}
            const said = this.#current?.said
            if (this.#current !== null) {await this.#commit(this.#current)}
            await this.#finish(context, said ?? asChatLine(summary), work)
        } catch (error) {
            // The producer hears of the failure. The next message resumes the conversation, unless resuming it is
            // what failed: then it starts a new one.
            context.board.drop(direction.id)
            const id = this.#sessionId
            if (id !== null) {context.notebook?.setAgentState(this.#resumed && this.#okTurns === 0 ? null : {session: id, pending: null})}
            this.close()
            throw error
        } finally {
            this.#current = null
        }
    }

    // Reads the session until this message's turn ends; its last text is what the producer reads. Each turn is
    // logged like a model call (tokens are the main loop's; the cost is the session's running total).
    async #reply(context: Coordinator, session: Session, pending: AgentState["pending"]): Promise<string> {
        const {model} = context.gateway.agent("utility")
        while (true) {
            const next = await session.query.next()
            if (next.done === true) {throw new Error("the agent's session ended")}
            const message = next.value
            // A new session's id comes with its first message: kept with the message it's working on.
            if (this.#sessionId === null && "session_id" in message && typeof message.session_id === "string") {
                this.#sessionId = message.session_id
                // A worker's session is never resumed: the captain's is the project's (captain.ts).
                if (this.#mode === "session") {
                    context.notebook?.setAgentState({session: message.session_id, pending})
                    context.event("agent_session", {session: message.session_id, resumed: false})
                }
            }
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

    // The project's stored session, if the SDK still has its transcript.
    async #stored(context: Coordinator): Promise<AgentState | null> {
        const state = context.notebook?.agentState() ?? null
        if (state === null) {return null}
        const found = await getSessionInfo(state.session, {dir: this.#cwd()}).catch(() => undefined)
        if (found === undefined) {context.notebook?.setAgentState(null)}
        return found === undefined ? null : state
    }

    #cwd(): string {return existsSync(this.#source) ? this.#source : process.cwd()}

    // A session with our tools: the members' (from the first snapshot, opened to any ref, so the list never changes)
    // and the utility's own. resume: a stored session's id, to carry on its conversation (the SDK keeps it on disk,
    // under CLAUDE_CONFIG_DIR; compose.yaml puts that in sessions/).
    #open(context: Coordinator, snapshot: Snapshot, resume?: string): Session {
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
        this.#indexed.clear()
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
            // The captain's in the captain roster (captain.ts): a worker leaves controls and cancelling to it.
            ...(this.#mode === "job" ? [] : [
            tool("offer_control", "Put a dial on your card in the team view (or change one you have: same name), for the producer to steer a direction that keeps going. It changes nothing by itself.", {
                name: z.string().regex(/^[a-z][a-z0-9_]{0,30}$/).describe("A short id, lower case (\"lofi_amount\")"),
                label: z.string().max(30).describe("What the producer reads on it, a word or two (\"Lofi\", \"Busy\")"),
                low: z.string().max(30).describe("Its 0 end, in the producer's words (\"clean\")"),
                high: z.string().max(30).describe("Its 1 end (\"dusty tape\")"),
                meaning: z.string().describe("What you'll do as it moves, for yourself later: what changes, between which settings"),
                value: z.number().min(0).max(1).describe("Where it starts: where the project stands or is headed now")},
                handler((current, input) => current.context.offerControl(this.agent, {ref: `c:${String(input.name)}`,
                    label: String(input.label), low: String(input.low), high: String(input.high), meaning: String(input.meaning),
                    value: Number(input.value)}))),
            tool("cancel", "Take back timed edits that haven't landed yet (coming_steps lists them with each message).", {
                steps: z.array(z.string()).describe("Step ids from coming_steps, or [\"all\"] for every one")},
                handler((current, input) => {
                    const ids = (input.steps as string[]).map(String)
                    return current.context.cancel(ids.includes("all") ? "all" : ids)
                })),
            tool("remove_control", "Take a dial off your card.", {name: z.string()},
                handler((current, input) => current.context.removeControl(this.agent, `c:${String(input.name).replace(/^c:/, "")}`)))
            ]),
            tool("look", "Run read-only JavaScript (an async function body, `takedo` in scope) and see what it returns.", {
                code: z.string()}, handler((current, input) => this.#look(current.context, String(input.code))),
                {annotations: {readOnlyHint: true}}),
            tool("run", "Change the project with a script (a function body, `takedo` in scope), as one undoable edit.", {
                description: z.string().describe("What it does, for the producer, a few words"),
                code: z.string(),
                at_bar: z.number().int().describe("The bar it lands on; 0 for as soon as possible")},
                handler((current, input) => this.#run(current, String(input.description), String(input.code), Number(input.at_bar)))),
            tool("remember", "Keep something in your notebook, outside your conversation (which may be summarized): replaces the entry with that key.", {
                key: z.string().describe("A short name you'll recognize (\"lofi-plan\", \"rhodes-patch\", \"bridge-chords\")"),
                kind: z.enum(Kinds),
                summary: z.string().describe("One line: what it is; shown with every message"),
                value: z.string().describe("The content: text, or JSON (notes, settings, a script)")},
                handler((current, input) => this.#notebook(current.context, "remember", input))),
            tool("recall", "Read a notebook entry's content.", {key: z.string()},
                handler((current, input) => this.#notebook(current.context, "recall", input)), {annotations: {readOnlyHint: true}}),
            tool("forget", "Delete a notebook entry.", {key: z.string()},
                handler((current, input) => this.#notebook(current.context, "forget", input))),
            ...(this.#knowledge === null ? [] : this.#knowledgeTools(handler))
        ]
        const inbox = new Inbox()
        return {inbox, query: query({prompt: inbox, options: {
            model, ...(effort !== undefined ? {effort} : {}),
            systemPrompt: (this.#mode === "job" ? WorkerSystem : System).replace(KnowledgeSlot, this.#knowledge === null ? "" : KnowledgeTools)
                .replace(KeySlot, this.#knowledge === null ? "" : KnowledgeKey),
            cwd: this.#cwd(),
            ...(resume !== undefined ? {resume} : {}),
            tools: SourceTools,
            allowedTools: [...SourceTools, "mcp__takedo__*"],
            permissionMode: "dontAsk",
            mcpServers: {takedo: createSdkMcpServer({name: "takedo", tools, alwaysLoad: true})},
            settingSources: [],
            env: {...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "takedo"},
            stderr: data => console.error(`[utility] ${data.trimEnd()}`)
        }})}
    }

    // The knowledge index for a message: all of it when the session is new, else only entries it hasn't seen (drafts).
    #knowledgeLines(fresh: boolean): Record<string, unknown> {
        if (this.#knowledge === null) {return {}}
        const lines = this.#knowledge.index().filter(line => fresh || !this.#indexed.has(line.key))
        lines.forEach(line => this.#indexed.add(line.key))
        if (lines.length === 0) {return {}}
        const compact = this.#knowledge.compact(lines)
        return fresh ? {knowledge: compact} : {knowledge_new: compact}
    }

    #knowledgeTools(handler: (run: (current: Current, input: Record<string, unknown>) => Promise<string> | string)
        => (input: Record<string, unknown>) => Promise<CallToolResult>) {
        const knowledge = this.#knowledge!
        const Value = z.union([z.string(), z.number(), z.null()])
        return [
            tool("knowledge", "Read knowledge base entries in full (several at once), with the summaries of the entries each links to.", {
                keys: z.array(z.string()).describe("Entry keys from the index, e.g. [\"production/lofi\", \"pattern/boombap-1\"]")},
                handler((current, input) => {
                    current.context.card({agent: this.agent, name: this.name, doing: "reading the knowledge base…"})
                    const entries = knowledge.get((input.keys as string[]).slice(0, 12))
                    const text = JSON.stringify(entries, null, 1)
                    return text.length > MaxRecall ? `${text.slice(0, MaxRecall)}\n… (cut at ${MaxRecall} characters: ask for fewer keys)` : text
                }), {annotations: {readOnlyHint: true}}),
            tool("apply_knowledge", "Apply an entry's edits (its apply): fixed operations and scripts, scheduled from the bar you give like your own. Its params are listed in the entry (read it first unless they're obvious: track, amount 0..3, key, from_bar, bars).", {
                key: z.string(),
                args: z.record(z.string(), Value).describe("The entry's params by name: {\"track\": \"t2\", \"amount\": 2}, {\"track\": \"t3\", \"key\": \"G major\"}; {} when it has none"),
                at_bar: z.number().int().describe("The bar its first edit lands on; 0 for as soon as possible. Its later edits keep their spacing from it.")},
                handler((current, input) => this.#applyKnowledge(current, String(input.key),
                    (input.args ?? {}) as Record<string, unknown>, Number(input.at_bar)))),
            tool("learn", "Keep something that worked as a draft knowledge entry, for later sessions and other projects (a person reviews drafts). For a sound, chain or pattern, include apply (and pattern) so it can be applied again; see existing entries for the shape.", {
                kind: z.enum(KnowledgeKinds),
                name: z.string().describe("Short, with dashes: \"dusty-rhodes\", \"dub-snare-throw\""),
                summary: z.string().describe("One line, shown in the index"),
                tags: z.array(z.string()).describe("Genres and the words a producer would use"),
                devices: z.array(z.string()).describe("Catalog device keys it uses"),
                links: z.array(z.string()).describe("Related entries' keys; [] for none"),
                body: z.array(z.string()).describe("What it is, when to use it, what to watch for"),
                apply: z.string().describe("JSON: {\"params\": {...}, \"steps\": [...]} as in existing entries; \"\" for none"),
                pattern: z.string().describe("JSON pattern for a pattern entry ({\"type\": \"drums\"|\"chords\", ...}); \"\" for none")},
                handler((current, input) => {
                    const parse = (text: unknown): unknown => {
                        if (typeof text !== "string" || text.trim() === "") {return undefined}
                        try {return JSON.parse(text)} catch {return null}
                    }
                    const apply = parse(input.apply), pattern = parse(input.pattern)
                    if (apply === null || pattern === null) {return "Not kept: apply and pattern must be JSON (or \"\")."}
                    return knowledge.draft({...input, apply, pattern}, `utility (${current.context.gateway.agent("utility").model}, ${new Date().toISOString().slice(0, 10)})`)
                }))
        ]
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
        // Checked as a whole: a bar it shares with the plan's other steps mustn't go over the limit (a chain's effects
        // all land on one bar); on a bar of its own it may.
        const crowded = [...new Set(bars.filter(bar => bar > 0))].find(bar => {
            const already = context.board.count(current.direction.id, bar)
            return already > 0 && already + bars.filter(other => other === bar).length > MaxPerBar
        })
        if (crowded !== undefined) {
            return `Not applied: bar ${crowded} already has ${context.board.count(current.direction.id, crowded)} edits in this plan, and this entry adds ${bars.filter(bar => bar === crowded).length} there (at most ${MaxPerBar} a bar). Give it a bar of its own.`
        }
        const results: string[] = []
        current.applying = true
        try {
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
        } finally {
            current.applying = false
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
        const staged = board.stage(current.direction.id, this.agent, bar, says, action, current.applying === true ? Infinity : MaxPerBar, current.job)
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
        const slide = planSlide(steps.map(step => step.bar), now)
        for (const step of steps) {
            if (context.board.step(step.id)?.state !== "sent") {continue}   // cancelled meanwhile
            const bar = step.bar + slide
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
                    }, sending?.id)
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
    async job(context: Coordinator, job: { id: string, piece: string, message: string, direction: Direction, anchor: Anchor | null },
              snapshot: Snapshot): Promise<string> {
        context.card({agent: this.agent, name: this.name, doing: `${job.id}: ${job.piece}`})
        const session = this.#session = this.#open(context, snapshot)
        const work: Work = {done: [], pending: [], late: []}
        const current: Current = {context, task: {message: job.message, piece: job.piece, hints: null}, work, calls: 0,
            direction: job.direction, anchor: job.anchor, job: job.id}
        this.#current = current
        this.#handSeen = 0
        session.inbox.push(JSON.stringify({
            your_task: job.piece, producer_message: job.message,
            ...(job.anchor !== null ? {playback_at_message: {bar: job.anchor.bar}} : {}),
            ...this.#hand(context, "producer_changed"),
            project: {...projectFor(snapshot, true), regions: snapshot.tracks.map(track => ({track: track.ref,
                regions: track.regions.map(({ref, name, from, to, loop}) => ({ref, name, from, to, loop}))}))},
            notebook: context.notebook?.list() ?? [],
            ...this.#knowledgeLines(true),
            devices: this.#devices, ...Object.assign({}, ...this.#team.map(member => member.context(snapshot)))
        }))
        try {
            const summary = await this.#reply(context, session, null)
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

    async #finish(context: Coordinator, summary: string, work: Work): Promise<void> {
        context.say(this.agent, summary.trim() || (work.done.length > 0 ? `${work.done.join("; ")}.` : "I didn't change anything."))
        void Promise.all(work.pending).then(() => {
            context.card({agent: this.agent, name: this.name, doing: work.done.length > 0 ? `${work.done.join("; ")} (done)` : "idle"})
            if (work.late.length === 0) {return}
            const late = work.late.map(line => line.replace(/\.+$/, "")).join("; ")
            // The lines are written for the model ("Leave that control alone"); the producer gets them reworded.
            const forProducer = work.late.map(line => line
                .replace(/: undone, it changed a control the producer is holding\. Leave that control alone\.?$/, ": undone, you're holding that control")
                .replace(/: failed \([^)]*\): (.*?)\.? Nothing was changed\.?$/, (_, detail: string) => `: didn't work${detail.trim() ? ` (${detail.trim()})` : ""}`)
                .replace(/\.+$/, "")).join("; ")
            context.say(this.agent, `Not done after all: ${forProducer}.`)
            this.#unheard.push(`Failed: ${late}`)
        })
    }
}
