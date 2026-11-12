import {existsSync} from "node:fs"
import {createSdkMcpServer, query, type Query, type SDKUserMessage, tool} from "@anthropic-ai/claude-agent-sdk"
import type Anthropic from "@anthropic-ai/sdk"
import type {CallToolResult} from "@modelcontextprotocol/sdk/types.js"
import {z} from "zod"
import type {Actor, Plan, Snapshot, Status, When} from "../../shared/protocol.ts"
import type {Coordinator} from "./coordinator.ts"
import type {Catalog} from "./catalog.ts"
import {Kinds, type Kind} from "./notebook.ts"
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

// One task's edits: what landed (for the card and the reply), what's still landing, and failures nobody's heard yet.
type Work = { done: string[], pending: Promise<string>[], late: string[] }
// The message being worked on, for the tools' handlers (one at a time: they share the session).
type Current = { context: Coordinator, task: Task, work: Work, calls: number }
type Session = { inbox: Inbox, query: Query }

const System = `You are the utility on an AI music production team (the producer sees you as the Team Lead: speak as "I", and never call yourself the utility) working live in openDAW (a web DAW) with a producer, usually while the track plays. You can do anything openDAW supports, working on the project directly with JavaScript. Your conversation carries on across the producer's messages (each brings a fresh project summary), but its older parts are summarized when it grows long: keep what you'll need later in your notebook. You get the producer's message, the chat before you joined, if any (\`conversation\`); "go on", "do the rest" or "all of it" refer to what came before, and your task when the work was split (do only that part).

A direction toward a style, genre or feel ("make it lofi", "evolve this into dub") asks for the whole transformation, not a first step. Work out what that style needs here: tempo and feel, drums (pattern, swing, ghost notes, velocities), harmony (chords, voicings, extensions), each part's sound (instrument choice and settings, a new track when a part's instrument can't get there), effects and mix. Do all of it. When it should happen gradually, stage it: changes timed across the bars it names (or 8 to 16 bars), each stage small, all scheduled before you finish.

Tools:
- The team's fixed operations (volume, pan, mute, add_effect, effect_params, set_param, remove_effect): use them for anything they cover. They land on the bar you choose, ramp over time (a script can't: it changes things at one instant), and are checked against the producer's controls before they run. Targets are refs from the project summary or snapshot(); a track or effect your script just made has one once that edit has landed. To ramp an effect you're adding, use add_effect's then.
- look: run read-only JavaScript to inspect the project. Writes fail here.
- run: change the project with a short script, for what no fixed operation does. It runs inside one edit: one undo step for the producer, rolled back entirely if it throws. It lands on the bar you choose (0: as soon as possible).
- An edit for a later bar (fixed operation or script) answers "Scheduled" at once and lands on its own: carry on with the next one, so a staged plan is all timed from the same playhead. Failures come back in a later round ("Since then, failed: …"). A look sees only what has landed.
- When you've finished, end with one or two sentences for the producer on what you did (or why you couldn't). Your last message is all they see: keep anything you write between tool calls to a few words.
- Read, Grep, Glob: openDAW's own source, the version that's running; your working directory is its root (packages/…). Read it for what the notes below don't say: a device's fields and their ranges (box schemas in packages/studio/forge-boxes/src/schema/devices/), step tables (adapters in packages/studio/adapters/src/devices/), how an API call works, the user manual (packages/app/manual/public/). Look before writing fields you haven't used.
- remember, recall, forget: your notebook, kept on disk per project and listed with every message (\`notebook\`: key, kind, summary). Your conversation may be summarized between messages; the notebook isn't. Keep in it what you'll want later: the producer's wishes and taste (note), a staged plan and where it stands (plan), parts you wrote as notes (clip), sounds you designed with their settings (sound), scripts worth reusing (script). "start" (state) is the whole project before the agents' first edit this session, kept for you.

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
- When the loop is on (\`playback.loop\`), a bar inside it lands the next time the playhead reaches it, and a bar past the loop's end counts bars of playing from the playhead, as if the loop were unrolled (playhead in bar 2 of a 4-bar loop, at_bar 10: after 8 bars of playing, at the loop's bar 2), so the steps of a gradual change keep their spacing. Results then say "at 1.1.1 (after 8 bars of playing)": that is the bar you asked for, landed on time.
- A region's notes play on every pass of its loop: a script that rewrites them changes every repeat from when it lands, which is how a staged change evolves the part over time.
- Do the whole task before you finish: never stop after a first part to offer the next, or ask whether to do a part that was asked for. Make several calls per round when they don't depend on each other.
- If something fails twice the same way, stop and say what's in the way.`

// The producer's messages, fed to the session as they come (streaming input), so it stays open between them.
class Inbox implements AsyncIterable<SDKUserMessage> {
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
    #session: Session | null = null
    #current: Current | null = null
    #queue: Promise<void> = Promise.resolve()
    #unheard: string[] = []   // failures after a reply, for the model with the next message

    // team: the members whose fixed operations it borrows; catalog: which devices it may add; source: the root of
    // openDAW's source tree, the session's working directory.
    constructor(team: ReadonlyArray<LlmMember>, catalog: Catalog, source: string) {
        this.#team = team
        this.#source = source
        this.#devices = {}
        catalog.devices().filter(device => device.allowed)
            .forEach(device => (this.#devices[device.kind] ??= []).push(device.factory))
    }

    // The generalist: every operation, scripts included.
    may(_plan: Plan): boolean {return true}

    // Something the model should know with the next message (an engine crash and what was undone).
    notice(text: string): void {this.#unheard.push(text)}

    // Ends the session (the page went away, or a turn failed); the next message starts a new one.
    close(): void {
        this.#session?.inbox.close()
        this.#session?.query.close()
        this.#session = null
    }

    // One task at a time: they share the session.
    handle(context: Coordinator, task: Task, snapshot: Snapshot): Promise<void> {
        const next = this.#queue.then(() => this.#work(context, task, snapshot))
        this.#queue = next.catch(() => {})
        return next
    }

    async #work(context: Coordinator, task: Task, snapshot: Snapshot): Promise<void> {
        context.card({agent: this.agent, name: this.name, doing: "looking…"})
        const fresh = this.#session === null
        const session = this.#session ?? (this.#session = this.#open(context, snapshot))
        const work: Work = {done: [], pending: [], late: []}
        this.#current = {context, task, work, calls: 0}
        session.inbox.push(JSON.stringify({
            ...(fresh && task.history !== undefined && task.history.length > 0 ? {conversation: task.history} : {}),
            ...(this.#unheard.length > 0 ? {since_your_last_reply: this.#unheard.splice(0)} : {}),
            producer_message: task.message, ...(task.piece !== null ? {your_task: task.piece} : {}),
            project: {...projectFor(snapshot, true), regions: snapshot.tracks.map(track => ({track: track.ref,
                regions: track.regions.map(({ref, name, from, to, loop}) => ({ref, name, from, to, loop}))}))},
            notebook: context.notebook?.list() ?? [],
            ...(fresh ? {devices: this.#devices, ...Object.assign({}, ...this.#team.map(member => member.context(snapshot)))} : {})
        }))
        try {
            const summary = await this.#reply(context, session)
            await this.#finish(context, summary, work)
        } catch (error) {
            this.close()   // a turn left half-answered can't be continued
            throw error
        } finally {
            this.#current = null
        }
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
            context.modelLog()({job: "utility", provider: "anthropic", model, ms: message.duration_ms,
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

    // A new session, with our tools: the members' (from the first snapshot, opened to any ref, so the list never
    // changes) and the utility's own.
    #open(context: Coordinator, snapshot: Snapshot): Session {
        const {model, effort} = context.gateway.agent("utility")
        const handler = (run: (current: Current, input: Record<string, unknown>) => Promise<string> | string) =>
            async (input: Record<string, unknown>): Promise<CallToolResult> => {
                const current = this.#current
                if (current === null) {return reply("No message is being worked on.")}
                if (++current.calls > MaxCalls) {
                    return reply(`Not run: that's ${MaxCalls} calls for this message. Finish now, saying what you changed and what's left undone.`)
                }
                const result = await run(current, input)
                const late = current.work.late.splice(0)
                return reply(late.length > 0 ? `${result}\nSince then, failed: ${late.join("; ")}.` : result)
            }
        const borrowed = new Map<string, Anthropic.Tool>()
        const owners = new Map<string, LlmMember>()
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
                handler((current, input) => this.#notebook(current.context, "forget", input)))
        ]
        const inbox = new Inbox()
        return {inbox, query: query({prompt: inbox, options: {
            model, ...(effort !== undefined ? {effort} : {}),
            systemPrompt: System,
            cwd: existsSync(this.#source) ? this.#source : process.cwd(),
            tools: SourceTools,
            allowedTools: [...SourceTools, "mcp__takedo__*"],
            permissionMode: "dontAsk",
            mcpServers: {takedo: createSdkMcpServer({name: "takedo", tools, alwaysLoad: true})},
            settingSources: [],
            persistSession: false,
            env: {...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "takedo"},
            stderr: data => console.error(`[utility] ${data.trimEnd()}`)
        }})}
    }

    // Starts an edit that may land bars from now without waiting for it, so the next one is planned from about the same
    // playhead and the edits keep their spacing. Resolves with the edit's result if it ends at once, else as soon as it's
    // scheduled or under way; a later failure goes to work.late, for the model's next tool result or the producer.
    #start(work: Work, edit: (onStatus: (status: Status) => void) => Promise<string>): Promise<string> {
        let waiting = true, failed = false
        let started: (text: string) => void = () => {}
        const early = new Promise<string>(resolve => {started = resolve})
        const finished = edit(status => {
            if (status.state === "failed" || status.state === "dropped") {failed = true}
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
    async #operate(current: Current, owner: LlmMember, name: string, input: Record<string, unknown>): Promise<string> {
        const found = owner.lookup(name, input)
        if (found !== null) {return found}
        const {context, task, work} = current
        const snapshot = await context.snapshot()
        if (snapshot === null) {return "Not done: no project is open."}
        const step = owner.step(name, input, snapshot)
        if (typeof step === "string") {return `Not done: ${step}.`}
        context.card({agent: this.agent, name: this.name, doing: step.says})
        return this.#start(work, onStatus => performStep(context, this.agent, step, task.piece ?? task.message, onStatus)
            .then(result => {
                work.done.push(result)
                return result
            }))
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

    async #run(current: Current, description: string, code: string, bar: number): Promise<string> {
        const {context, work} = current
        context.card({agent: this.agent, name: this.name, doing: description})
        const claimed = context.claim(this.agent, ["project.script"], description)
        if (!claimed.ok) {return "Another script is running; try again in a moment."}
        const when: When = bar > 0 ? {at: "bar", bar} : {at: "asap"}
        const fresh = await context.snapshot()
        return this.#start(work, async onStatus => {
            try {
                let landsAt = ""
                const status = await context.request(this.agent, {op: "script", code, description}, when,
                    fresh?.at.seq ?? 0, description, update => {
                        landsAt = update.landsAt ?? landsAt
                        onStatus(update)
                    })
                if (status.state === "applied") {
                    work.done.push(`${description}${landsAt ? ` (from ${landsAt})` : ""}`)
                    const corrected = status.result?.corrected ?? []
                    return `Applied${landsAt ? ` at ${landsAt}` : ""}: ${status.result?.updates ?? 0} changes. Returned: ${status.result?.value ?? "undefined"}${corrected.length > 0 ? `. Corrected, outside openDAW's ranges (look up a field's range before writing it): ${corrected.join("; ")}` : ""}`
                }
                if (status.state === "dropped") {return `${description}: undone, it changed a control the producer is holding. Leave that control alone.`}
                return `${description}: failed (${status.reason}): ${status.detail ?? ""}. Nothing was changed.`
            } finally {
                context.release(this.agent, ["project.script"])
            }
        })
    }

    // Says the summary at once and frees the utility for the next message; the card follows the edits still landing,
    // and anything that fails after is said too, and told to the model with the next message.
    async #finish(context: Coordinator, summary: string, work: Work): Promise<void> {
        context.say(this.agent, summary.trim() || (work.done.length > 0 ? `${work.done.join("; ")}.` : "I didn't change anything."))
        void Promise.all(work.pending).then(() => {
            context.card({agent: this.agent, name: this.name, doing: work.done.length > 0 ? `${work.done.join("; ")} (done)` : "idle"})
            if (work.late.length === 0) {return}
            const late = work.late.map(line => line.replace(/\.+$/, "")).join("; ")
            context.say(this.agent, `Not done after all: ${late}.`)
            this.#unheard.push(`Failed: ${late}`)
        })
    }
}
