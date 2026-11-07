import type Anthropic from "@anthropic-ai/sdk"
import type {Actor, Plan, Snapshot, When} from "../../shared/protocol.ts"
import type {Coordinator} from "./coordinator.ts"
import type {Catalog} from "./catalog.ts"
import {Limits, type LlmMember, type Member, performStep, projectFor, type Task} from "./members.ts"

// The utility (STRATEGY.md, "Keep the open path"): anything openDAW can do that the members' fast operations don't
// cover, done in openDAW directly with code, the way the first live experiment did it (poc/edit_bench/live/eval.mjs). It looks around with read-only
// JavaScript, edits with scripts (each one edit, one undo step, attributed to it, refused for controls the producer
// holds), sees the result or the error, and tries again, for a few rounds. It also has every member's fixed
// operations as tools, borrowed from them, for whatever they cover: those land on bars, ramp over time and are
// checked before they run. Tools are rebuilt from a fresh snapshot each round, so a track or effect a script made
// can be targeted next round. Slow-tier work, seconds to tens of seconds; the Team Lead hands it out so its own
// reply isn't held up.

const MaxRounds = 8

const System = `You are the utility on an AI music production team (the producer sees you as the Team Lead: speak as "I", and never call yourself the utility) working live in openDAW (a web DAW) with a producer, usually while the track plays. You can do anything openDAW supports, working on the project directly with JavaScript. You get the producer's message, and your task when the work was split (do only that part).

Tools:
- The team's fixed operations (volume, pan, mute, add_effect, effect_params, set_param, remove_effect): use them for anything they cover. They land on the bar you choose, ramp over time (a script can't: it changes things at one instant), and are checked against the producer's controls before they run. Targets are refs from the project summary; a track or effect your script just made appears in them the round after. To ramp an effect you're adding, use add_effect's then.
- look: run read-only JavaScript to inspect the project. Writes fail here.
- run: change the project with a short script, for what no fixed operation does. It runs inside one edit: one undo step for the producer, rolled back entirely if it throws. It lands on the bar you choose (0: as soon as possible).
- done: finish, with one or two sentences for the producer on what you did (or why you couldn't).

Both run a function body with \`takedo\` in scope (its parts are also plain names: project, api, lib, ref, bar, ppqn, pos, snapshot); \`return\` a value to see it (JSON; openDAW objects show as their class name, so return plain data). look's body may await; run's is synchronous.

\`takedo\`:
- project: openDAW's Project. project.rootBoxAdapter.audioUnits.adapters(): the tracks (AudioUnitBoxAdapter; .label, .isOutput for the master, .box, .namedParameter.{volume,panning,mute,solo}, .tracks.values(): its timeline tracks (an array), each with .box (a TrackBox) and .regions.collection.asArray()).
- Regions (NoteRegionBoxAdapter, AudioRegionBoxAdapter): .position, .duration, .loopOffset, .loopDuration, .complete (end), .label, .mute, .box. A region whose loopDuration is shorter than its duration repeats its content. Change one through its box: region.box.duration.setValue(pulses), region.box.position.setValue(...), region.box.loopDuration.setValue(...). Note regions: .optCollection.unwrap().events.asArray() gives notes (.position relative to the region, .duration, .pitch, .velocity 0..1, .box).
- api: project.api. createNoteRegion({trackBox, position, duration, name, loopDuration}), createNoteEvent({owner: regionBox, position, duration, pitch, velocity}), createInstrument(factory) → {audioUnitBox, trackBox, instrumentBox}, insertEffect(audioUnitBox.audioEffects, factory), deleteAudioUnit(audioUnitBox), duplicateNotes(noteAdapters).
- lib: {std, dsp: {PPQN}, adapters, core}: openDAW's libraries (lib.adapters.InstrumentFactories.Named, lib.core.EffectFactories.AudioNamed, lib.dsp.PPQN.Quarter = 960).
- ref("t1") → that track's AudioUnitBoxAdapter, ref("t1.fx1") → an effect's adapter, ref("r3") → a region's adapter: the refs in the project summary.
- bar: pulses per bar; ppqn("5.1.1") → pulses; pos(pulses) → "5.1.1". Positions are 1-based bars.beats.sixteenths.
- snapshot(): the project summary, fresh; snapshot().playback has the playhead and loop. Nothing else is in scope (no \`playback\`, \`tracks\` or \`project_summary\` variables).

Recipes that work (inside run):
- A new named track with a bar of notes: const {audioUnitBox, trackBox, instrumentBox} = api.createInstrument(lib.adapters.InstrumentFactories.Vaporisateur); instrumentBox.label.setValue("Lead"); const region = api.createNoteRegion({trackBox, position: 0, duration: bar, name: "Lead"}); api.createNoteEvent({owner: region, position: 0, duration: lib.dsp.PPQN.Quarter, pitch: 60, velocity: 0.8});
- A track's name is its instrument's label: ref("t1").inputAdapter.unwrap().labelField.setValue("Bass").
- A level at once: ref("t1").namedParameter.volume.setValue(-12) (dB); for a fade over time, use the volume tool instead. Always set parameter values through openDAW's parameter objects like this (namedParameter, or an effect's parameter adapters), never a box's field directly: when the producer records, only those writes become automation. Structural edits (regions, notes, devices) are unaffected.
- Lengthen a region and loop its content: r.box.loopDuration.setValue(r.loopDuration); r.box.duration.setValue(16 * bar).

Rules:
- Set up anything you create in the same script that creates it (its name, level, mute, notes), so it's never heard half-made; use the fixed tools for changes over time, after.
- Look before you change anything you haven't seen; keep scripts small and do one job each; check the result with a look when it matters.
- Change only what the task asks. Decided limits, for now: ${Limits} \`devices\` lists the devices you may add, by kind, as named in openDAW's factories.
- Anything else openDAW can do, you can: never answer that it can't be done or wasn't built; look up how and do it.
- Land changes ahead of the playhead (\`playback.bar\`) when timing matters; structural changes (lengths, new regions) can land as soon as possible.
- When the loop is on (\`playback.loop\`), a bar inside it lands the next time the playhead reaches it, and a bar past the loop's end counts bars of playing from the playhead, as if the loop were unrolled (playhead in bar 2 of a 4-bar loop, at_bar 10: after 8 bars of playing, at the loop's bar 2), so the steps of a gradual change keep their spacing. Results then say "at 1.1.1 (after 8 bars of playing)": that is the bar you asked for, landed on time.
- Do the whole task before calling done: never stop to ask whether to do a part that was asked for.
- If something fails twice the same way, stop and say what's in the way.`

const tool = (name: string, description: string, properties: Record<string, unknown>): Anthropic.Tool => ({
    name, description, strict: true,
    input_schema: {type: "object", properties, required: Object.keys(properties), additionalProperties: false}
})
const OwnTools: Anthropic.Tool[] = [
    tool("look", "Run read-only JavaScript (an async function body, `takedo` in scope) and see what it returns.", {
        code: {type: "string"}}),
    tool("run", "Change the project with a script (a function body, `takedo` in scope), as one undoable edit.", {
        description: {type: "string", description: "What it does, for the producer, a few words"},
        code: {type: "string"},
        at_bar: {type: "integer", description: "The bar it lands on; 0 for as soon as possible"}}),
    tool("done", "Finish, telling the producer what you did.", {summary: {type: "string"}})
]

export class Utility implements Member {
    readonly agent: Actor = "agent:utility"
    readonly role = "utility"
    readonly name = "Utility"
    readonly area = "anything openDAW can do"
    readonly can = "read the project and change it directly with short openDAW scripts (extend or duplicate clips, add tracks or regions, write or rework notes, anything openDAW supports); slower and costlier, seconds to tens of seconds"
    readonly wantsHints = false

    readonly #team: ReadonlyArray<LlmMember>
    readonly #devices: Record<string, string[]>

    // team: the members whose fixed operations it borrows; catalog: which devices it may add.
    constructor(team: ReadonlyArray<LlmMember>, catalog: Catalog) {
        this.#team = team
        this.#devices = {}
        catalog.devices().filter(device => device.allowed)
            .forEach(device => (this.#devices[device.kind] ??= []).push(device.factory))
    }

    // The generalist: every operation, scripts included.
    may(_plan: Plan): boolean {return true}

    // The members' tools for this snapshot, each with the member that owns it (first owner wins on a name clash).
    #borrowed(snapshot: Snapshot): Map<string, { tool: Anthropic.Tool, owner: LlmMember }> {
        const tools = new Map<string, { tool: Anthropic.Tool, owner: LlmMember }>()
        this.#team.forEach(owner => owner.tools(snapshot).forEach(tool => {
            if (!tools.has(tool.name)) {tools.set(tool.name, {tool, owner})}
        }))
        return tools
    }

    async handle(context: Coordinator, task: Task, snapshot: Snapshot): Promise<void> {
        context.card({agent: this.agent, name: this.name, doing: "looking…"})
        const messages: Anthropic.MessageParam[] = [{role: "user", content: JSON.stringify({
            producer_message: task.message, ...(task.piece !== null ? {your_task: task.piece} : {}),
            project: {...projectFor(snapshot, true), regions: snapshot.tracks.map(track => ({track: track.ref,
                regions: track.regions.map(({ref, name, from, to, loop}) => ({ref, name, from, to, loop}))}))},
            devices: this.#devices,
            ...Object.assign({}, ...this.#team.map(member => member.context(snapshot)))
        })}]
        const done: string[] = []
        let current = snapshot
        for (let round = 0; round < MaxRounds; round++) {
            if (round > 0) {current = (await context.snapshot()) ?? current}
            const borrowed = this.#borrowed(current)
            const tools = [...[...borrowed.values()].map(entry => entry.tool), ...OwnTools]
            const response = await context.gateway.turn("utility", System, messages, tools, context.modelLog(), this.agent)
            messages.push({role: "assistant", content: response.content})
            const uses = response.content.flatMap(block => block.type === "tool_use" ? [block] : [])
            if (uses.length === 0) {
                const text = response.content.flatMap(block => block.type === "text" ? [block.text] : []).join(" ")
                return this.#finish(context, text, done)
            }
            const results: Anthropic.ToolResultBlockParam[] = []
            for (const use of uses) {
                const input = use.input as Record<string, unknown>
                if (use.name === "done") {return this.#finish(context, String(input.summary), done)}
                const content = use.name === "look" ? await this.#look(context, String(input.code))
                    : use.name === "run" ? await this.#run(context, String(input.description), String(input.code), Number(input.at_bar), done)
                    : await this.#operate(context, use.name, input, current, borrowed, task, done)
                results.push({type: "tool_result", tool_use_id: use.id, content})
            }
            const last = round === MaxRounds - 2
            messages.push({role: "user", content: [...results, ...(last ? [{type: "text" as const,
                text: "Last round: call done now, saying what you changed and what's left undone."}] : [])]})
        }
        this.#finish(context, done.length > 0 ? `${done.join("; ")}. I stopped there, before finishing.`
            : "I stopped before changing anything: I couldn't work out how.", done)
    }

    // A fixed operation, borrowed: a lookup answers at once; anything else becomes the owner's step, run as the utility's.
    async #operate(context: Coordinator, name: string, input: Record<string, unknown>, snapshot: Snapshot,
                   borrowed: Map<string, { tool: Anthropic.Tool, owner: LlmMember }>, task: Task,
                   done: string[]): Promise<string> {
        const entry = borrowed.get(name)
        if (entry === undefined) {return `No tool ${name}.`}
        const found = entry.owner.lookup(name, input)
        if (found !== null) {return found}
        const step = entry.owner.step(name, input, snapshot)
        if (typeof step === "string") {return `Not done: ${step}.`}
        context.card({agent: this.agent, name: this.name, doing: step.says})
        const result = await performStep(context, this.agent, step, task.piece ?? task.message)
        done.push(result)
        return result
    }

    async #look(context: Coordinator, code: string): Promise<string> {
        context.card({agent: this.agent, name: this.name, doing: "looking…"})
        const {ok, value} = await context.look(this.agent, code)
        return ok ? value : `Error: ${value}`
    }

    async #run(context: Coordinator, description: string, code: string, bar: number, done: string[]): Promise<string> {
        context.card({agent: this.agent, name: this.name, doing: description})
        const claimed = context.claim(this.agent, ["project.script"], description)
        if (!claimed.ok) {return "Another script is running; try again in a moment."}
        try {
            const when: When = bar > 0 ? {at: "bar", bar} : {at: "asap"}
            const fresh = await context.snapshot()
            let landsAt = ""
            const status = await context.request(this.agent, {op: "script", code, description}, when,
                fresh?.at.seq ?? 0, description, update => {landsAt = update.landsAt ?? landsAt})
            if (status.state === "applied") {
                done.push(`${description}${landsAt ? ` (from ${landsAt})` : ""}`)
                return `Applied${landsAt ? ` at ${landsAt}` : ""}: ${status.result?.updates ?? 0} changes. Returned: ${status.result?.value ?? "undefined"}`
            }
            if (status.state === "dropped") {return "Undone: it changed a control the producer is holding. Leave that control alone."}
            return `Failed (${status.reason}): ${status.detail ?? ""}. Nothing was changed.`
        } finally {
            context.release(this.agent, ["project.script"])
        }
    }

    #finish(context: Coordinator, summary: string, done: string[]): void {
        context.card({agent: this.agent, name: this.name, doing: done.length > 0 ? `${done.join("; ")} (done)` : "idle"})
        context.say(this.agent, summary.trim() || (done.length > 0 ? `${done.join("; ")}.` : "I didn't change anything."))
    }
}
