import type Anthropic from "@anthropic-ai/sdk"
import {type Actor, type Plan, type Snapshot, type Status, target, type When} from "../../shared/protocol.ts"
import type {Catalog} from "./catalog.ts"
import type {Coordinator} from "./coordinator.ts"
import type {Hints} from "./router.ts"

// Team members (FEATURES.md, "The team"). Each turns a task (the producer's message, maybe the Team Lead's piece of it,
// maybe Jev's hints) into steps: plans with a landing, carried out through the bus with claims, in parallel. The mix
// engineer's common case runs on Jev's hints alone (code turns them into a ramp); everything else goes through one
// Claude call whose strict tool calls are the plan (as in poc/llm_bench). Each member gets only its own tools, and
// the coordinator refuses plans outside its area (`may`). Members are the fast lane, not the limit: whatever a member's
// tools don't cover it hands off, and the Team Lead's hands (the utility) do it with code (STRATEGY.md, "Keep the open
// path").

// What the team won't do, decided for now; everything else openDAW supports is fair game.
export const Limits = "use only openDAW's built-in devices that the catalog allows (nothing installed or loaded from outside: no plugins, no scriptable or neural devices, no external MIDI); leave the transport, playback and settings to the producer; delete tracks only when asked."


export type Task = { message: string, piece: string | null, hints: Hints | null }
export type Member = {
    readonly agent: Actor, readonly role: string, readonly name: string
    readonly area: string                           // what the role covers
    readonly can: string                            // its fast operations: what it does quickly and cheaply
    readonly wantsHints: boolean                    // whether a message addressed to it is worth a Jev call first
    may(plan: Plan): boolean
    handle(context: Coordinator, task: Task, snapshot: Snapshot): Promise<void>
}

export type Step = { plan: Plan, when: When, says: string }   // says: what it did, for the reply ("Keys muted")

const MinDb = -60, MaxDb = 6
const db = (value: number): string => value <= MinDb ? "-inf dB" : `${value > 0 ? "+" : ""}${value.toFixed(1)} dB`
const barOf = (pos: string): number => Number(pos.split(".")[0])

// Planning takes seconds (a bar or two), so a plan whose first bar has passed by the time it's carried out slides later
// as a whole, keeping its spacing ("mute at the next bar, back two bars later"). Not in a loop, where a passed bar
// comes round again. Returns the bars it slid by.
const slide = (steps: Step[], now: Snapshot): number => {
    if (now.playback.loop.on || !now.playback.playing) {return 0}
    const bars = steps.flatMap(step => step.when.at === "bar" ? [step.when.bar] : [])
    if (bars.length === 0) {return 0}
    // In the bar's last beat the next downbeat is too close to land on (the adapter keeps a lead), so aim one later.
    const beat = Number(now.playback.pos.split(".")[1] ?? 1)
    const first = now.playback.bar + (beat >= now.timeline.signature[0] ? 2 : 1)
    const by = first - Math.min(...bars)
    if (by <= 0) {return 0}
    steps.forEach(step => {if (step.when.at === "bar") {step.when = {at: "bar", bar: step.when.bar + by}}})
    return by
}

// Claims every target, sends every step at once, waits for all, releases, and replies with what happened.
const carryOut = async (context: Coordinator, member: Member, steps: Step[], snapshot: Snapshot,
                        reason: string): Promise<void> => {
    const now = await context.snapshot()
    const slid = now === null ? 0 : slide(steps, now)
    const targets = [...new Set(steps.map(step => target(step.plan)))]
    const claimed = context.claim(member.agent, targets, reason)
    if (!claimed.ok) {
        context.card({agent: member.agent, name: member.name, doing: "waiting"})
        return context.say(member.agent, `${claimed.holder.replace("agent:", "").replace(/_/g, " ")} is working on that right now.`)
    }
    context.card({agent: member.agent, name: member.name, doing: steps.map(step => step.says).join("; ")})
    try {
        const results = await Promise.all(steps.map(async step => {
            let landsAt = ""
            const status = await context.request(member.agent, step.plan, step.when, snapshot.at.seq, reason,
                update => {landsAt = update.landsAt ?? landsAt})
            return describe(step, status, landsAt)
        }))
        context.card({agent: member.agent, name: member.name, doing: `${results.join("; ")} (done)`})
        context.say(member.agent, `${results.join("; ")}.${slid > 0 ? ` (${slid} bar${slid > 1 ? "s" : ""} later than planned: the playhead moved on while I planned.)` : ""}`)
    } finally {
        context.release(member.agent, targets)
    }
}

// One step on its own, for a member that reports back to its model rather than the chat (the utility): claim, slide if
// late, request, release. Returns what happened, as the reply would say it.
export const performStep = async (context: Coordinator, agent: Actor, step: Step, reason: string): Promise<string> => {
    const now = await context.snapshot()
    const slid = now === null ? 0 : slide([step], now)
    const claimed = context.claim(agent, [target(step.plan)], reason)
    if (!claimed.ok) {return `${step.says}: not done, ${claimed.holder.replace("agent:", "")} is working on it`}
    try {
        let landsAt = ""
        const status = await context.request(agent, step.plan, step.when, now?.at.seq ?? 0, reason,
            update => {landsAt = update.landsAt ?? landsAt})
        return `${describe(step, status, landsAt)}${slid > 0 ? ` (${slid} bar${slid > 1 ? "s" : ""} later than planned)` : ""}`
    } finally {
        context.release(agent, [target(step.plan)])
    }
}

const describe = (step: Step, status: Status, landsAt: string): string => {
    if (status.state === "applied") {return `${step.says}${landsAt ? ` from ${landsAt}` : ""}`}
    if (status.state === "dropped") {return `${step.says}: not done, you're holding it`}
    return `${step.says}: not done (${status.reason ?? status.state}${status.detail ? `: ${status.detail}` : ""})`
}

// ---------- the language-model half ----------

const tool = (name: string, description: string, properties: Record<string, unknown>): Anthropic.Tool => ({
    name, description, strict: true,
    input_schema: {type: "object", properties, required: Object.keys(properties), additionalProperties: false}
})
const AtBar = {type: "integer", description: "The bar the edit lands on (its downbeat); 0 for the next bar"}
const OverBeats = {type: "integer", enum: [0, 1, 2, 4, 8, 16, 32], description: "How long the change takes; 0 is instant"}
const whenFor = (bar: number): When => bar > 0 ? {at: "bar", bar} : {at: "next", unit: "bar"}
const HandOff = tool("hand_off", "Hand the part of the request your tools don't cover to the Team Lead, who does it in openDAW directly.", {
    rest: {type: "string", description: "What's left to do, as an instruction specific to this project"}})

const memberSystem = (name: string, area: string, can: string): string => `You are the ${name} on an AI music production team working live in openDAW with a producer, usually while the track plays. Your area: ${area}. Your fast operations (the tools): ${can}.

You get the producer's message, and your piece of it when the Team Lead split it among the team. Plan your edits as tool calls.
- Each call is one edit that lands on the downbeat of the bar you choose (at_bar), or the next bar (0). The playhead is at \`playback.bar\`: land at playback.bar + 1 or later. When the loop is on, only bars inside it are ever reached; a bar before the playhead in the loop lands on the next pass.
- Make 1 to 6 calls, only in your own area, and only what was asked.
- Values are in each parameter's own units, within its range.
- Your job is your piece when you have one (the rest of the producer's message is other members' work: leave it to them), else the whole message. Anything in it that your tools don't cover, hand off with one hand_off call (the rest, said as an instruction specific to this project), rather than leaving it out or saying it can't be done: the Team Lead does it directly in openDAW.
- Don't explain your plan; the calls are the plan.`

const loopBars = (snapshot: Snapshot) => {
    const {loop} = snapshot.playback
    return {on: loop.on, from_bar: barOf(loop.from), to_bar: barOf(loop.to) - 1}
}

// The project as members read it: the tracks, their mix and effects, where the playhead is.
export const projectFor = (snapshot: Snapshot, withParams: boolean) => ({
    tempo: snapshot.timeline.bpm, meter: snapshot.timeline.signature.join("/"),
    playback: {playing: snapshot.playback.playing, bar: snapshot.playback.bar, loop: loopBars(snapshot)},
    tracks: snapshot.tracks.map(track => ({
        ref: track.ref, name: track.name, instrument: track.instrument, bars: track.bars,
        volume_db: Number(track.mix.volume.toFixed(1)), pan: Number(track.mix.pan.toFixed(2)), muted: track.mix.mute,
        effects: track.effects.map(effect => ({ref: effect.ref, device: effect.key, name: effect.name,
            ...(withParams ? {params: effect.params?.map(param => ({ref: param.ref, name: param.name, value: param.value,
                    shows: param.display, range: [param.min, param.max], ...(param.stepped ? {stepped: true} : {})}))} : {})}))
    })),
    master: {volume_db: Number(snapshot.master.volume.toFixed(1)),
        effects: snapshot.master.effects.map(effect => ({ref: effect.ref, device: effect.key, name: effect.name}))}
})

export abstract class LlmMember implements Member {
    abstract readonly agent: Actor
    abstract readonly role: string
    abstract readonly name: string
    abstract readonly area: string
    abstract readonly can: string
    readonly wantsHints: boolean = false

    abstract may(plan: Plan): boolean
    abstract tools(snapshot: Snapshot): Anthropic.Tool[]
    // A tool call → a step, or why it can't be one.
    abstract step(name: string, input: Record<string, unknown>, snapshot: Snapshot): Step | string
    context(_snapshot: Snapshot): object {return {}}
    // Answers a lookup tool (information, not an edit); null for the plan's own tools.
    lookup(_name: string, _input: Record<string, unknown>): string | null {return null}
    protected withParams = false

    async handle(context: Coordinator, task: Task, snapshot: Snapshot): Promise<void> {
        context.card({agent: this.agent, name: this.name, doing: "planning…"})
        const input = JSON.stringify({
            producer_message: task.message, ...(task.piece !== null ? {your_piece: task.piece} : {}),
            project: projectFor(snapshot, this.withParams), ...this.context(snapshot)
        })
        const tools = [...this.tools(snapshot), HandOff]
        const {calls, text} = await context.gateway.calls("member", memberSystem(this.name, this.area, this.can), input, tools,
            context.modelLog(), this.agent, (name, input) => this.lookup(name, input as Record<string, unknown>))
        const steps: Step[] = []
        const problems: string[] = []
        const rest: string[] = []
        for (const call of calls) {
            const input = call.input as Record<string, unknown>
            if (call.name === HandOff.name) {rest.push(String(input.rest)); continue}
            const step = this.step(call.name, input, snapshot)
            if (typeof step === "string") {problems.push(step)} else {steps.push(step)}
        }
        // A hand-off runs alongside this member's own steps.
        const handedOff = rest.length > 0 ? context.handOff(this, task, rest.join("; ")) : Promise.resolve()
        if (steps.length === 0) {
            context.card({agent: this.agent, name: this.name, doing: "idle"})
            if (rest.length > 0) {return handedOff}
            return context.say(this.agent, [text.trim(), ...problems].filter(line => line !== "").join(" ")
                || "I couldn't find anything to do there.")
        }
        await carryOut(context, this, steps, snapshot, task.piece ?? task.message)
        if (problems.length > 0) {context.say(this.agent, `Left out: ${problems.join("; ")}.`)}
        await handedOff
    }
}

const trackName = (snapshot: Snapshot, ref: string): string =>
    ref === "master" ? "the master" : snapshot.tracks.find(track => track.ref === ref)?.name ?? ref

// ---------- the mix engineer ----------

// Amount (0..3 on the router's scale) to a step in dB: subtle 1.5, moderate 3, big 6, extreme 12.
const stepDb = (amount: number): number => Math.min(18, Math.max(1, 1.5 * 2 ** amount))

export class MixEngineer extends LlmMember {
    readonly agent: Actor = "agent:mix_engineer"
    readonly role = "mix_engineer"
    readonly name = "Mix engineer"
    readonly area = "balance between parts: levels, panning, EQ, compression, sidechain"
    readonly can = "set or ramp each track's and the master's volume, and each track's pan"
    readonly wantsHints = true

    may(plan: Plan): boolean {return (plan.op === "ramp" || plan.op === "set") && /\.mix\.(volume|pan)$/.test(plan.ref)}

    // "Quieter" or "louder" with Jev's hints and no piece from the Team Lead: code alone, no language model.
    async handle(context: Coordinator, task: Task, snapshot: Snapshot): Promise<void> {
        const {hints} = task
        if (task.piece !== null || hints === null || (hints.change !== "quieter" && hints.change !== "louder")) {
            return super.handle(context, task, snapshot)
        }
        const track = snapshot.tracks.find(track => track.ref === hints.part)
        const ref = track === undefined ? "master" : track.ref
        const from = track?.mix.volume ?? snapshot.master.volume
        const to = Math.min(MaxDb, Math.max(MinDb, from + (hints.change === "quieter" ? -1 : 1) * stepDb(hints.amount)))
        const beatsPerBar = snapshot.timeline.signature[0]
        const [when, beats]: [When, number] = hints.when === "gradual" ? [{at: "next", unit: "bar"}, 2 * beatsPerBar]
            : hints.when === "later" ? [{at: "next", unit: "bar"}, 1] : [{at: "next", unit: "beat"}, 1]
        const label = track?.name ?? "The mix"
        await carryOut(context, this, [{plan: {op: "ramp", ref: `${ref}.mix.volume`, to, beats}, when,
            says: `${label} ${hints.change}: ${db(from)} → ${db(to)}`}], snapshot, `${hints.change} ${label}`)
    }

    tools(snapshot: Snapshot): Anthropic.Tool[] {
        const tracks = ["master", ...snapshot.tracks.map(track => track.ref)]
        return [
            tool("volume", "Set or ramp a track's (or the master's) volume.", {
                track: {type: "string", enum: tracks}, to_db: {type: "number", description: `-60 to +6 dB`},
                over_beats: OverBeats, at_bar: AtBar}),
            tool("pan", "Set or ramp a track's pan position.", {
                track: {type: "string", enum: snapshot.tracks.map(track => track.ref)},
                to: {type: "number", description: "-1 hard left, 0 centre, +1 hard right"}, over_beats: OverBeats, at_bar: AtBar})
        ]
    }

    step(name: string, input: Record<string, unknown>, snapshot: Snapshot): Step | string {
        const track = String(input.track), beats = Number(input.over_beats), bar = Number(input.at_bar)
        if (name === "volume") {
            const to = Math.min(MaxDb, Math.max(MinDb, Number(input.to_db)))
            return {plan: {op: "ramp", ref: `${track}.mix.volume`, to, beats}, when: whenFor(bar),
                says: `${trackName(snapshot, track)} to ${db(to)}${beats > 0 ? ` over ${beats} beats` : ""}`}
        }
        if (name === "pan") {
            const to = Math.min(1, Math.max(-1, Number(input.to)))
            return {plan: {op: "ramp", ref: `${track}.mix.pan`, to, beats}, when: whenFor(bar),
                says: `${trackName(snapshot, track)} panned to ${to === 0 ? "centre" : `${Math.round(Math.abs(to) * 100)}% ${to < 0 ? "left" : "right"}`}`}
        }
        return `unknown tool ${name}`
    }
}

// ---------- the arranger ----------

export class Arranger extends LlmMember {
    readonly agent: Actor = "agent:arranger"
    readonly role = "arranger"
    readonly name = "Arranger"
    readonly area = "song structure over time: sections, what plays when, length, builds and drops"
    readonly can = "mute and unmute tracks at chosen bars"

    may(plan: Plan): boolean {return plan.op === "set" && /^t\d+\.mix\.mute$/.test(plan.ref)}

    tools(snapshot: Snapshot): Anthropic.Tool[] {
        return [tool("mute", "Mute or unmute a track from a bar on. To drop a part for a while, mute it at one bar and unmute it at a later one.", {
            track: {type: "string", enum: snapshot.tracks.map(track => track.ref)}, muted: {type: "boolean"}, at_bar: AtBar})]
    }

    step(name: string, input: Record<string, unknown>, snapshot: Snapshot): Step | string {
        if (name !== "mute") {return `unknown tool ${name}`}
        const track = String(input.track), muted = input.muted === true
        return {plan: {op: "set", ref: `${track}.mix.mute`, to: muted ? 1 : 0}, when: whenFor(Number(input.at_bar)),
            says: `${trackName(snapshot, track)} ${muted ? "muted" : "back in"}`}
    }
}

// ---------- the effect designer ----------

// Audio effects the effect designer chooses from: allowed, describable, and a sound change on their own (no routing,
// containers, or effects that need a second signal or a voice).
const NotForEffectDesigner = new Set(["AudioSink", "AudioEffectComposite", "StereoComposite", "FrequencySplit", "Vocoder",
    "Autotune"])

export class EffectDesigner extends LlmMember {
    readonly agent: Actor = "agent:effect_designer"
    readonly role = "effect_designer"
    readonly name = "Effect designer"
    readonly area = "effects on a sound, and effect sounds such as risers, sweeps and impacts"
    readonly can = "add audio effects (reverb, delay, EQ, filter, distortion, bit crushing, compression, tremolo, stereo width) at the end of a track's or the master's chain with settings, remove them, and set or ramp parameters of effects already there"
    protected withParams = true
    readonly #catalog: Catalog

    constructor(catalog: Catalog) {
        super()
        this.#catalog = catalog
    }

    may(plan: Plan): boolean {
        return plan.op === "add_effect" || plan.op === "remove_effect"
            || ((plan.op === "ramp" || plan.op === "set") && /\.fx\d+\./.test(plan.ref))
    }

    #choices() {
        return this.#catalog.devices().filter(device => device.kind === "audio effect" && device.allowed
            && !NotForEffectDesigner.has(device.key))
    }

    // What it can add and what each sounds like; parameters only for the effects it looks up (effect_params).
    context(_snapshot: Snapshot): object {
        return {effects_you_can_add: Object.fromEntries(this.#choices().map(device => {
            const notes = this.#catalog.summary(device.key)
            return [device.key, {name: device.name, brief: device.brief, sound: notes?.sound, words: notes?.words}]
        }))}
    }

    lookup(name: string, input: Record<string, unknown>): string | null {
        if (name !== "effect_params") {return null}
        const device = this.#catalog.device(String(input.effect))
        if (device === null) {return `No effect ${String(input.effect)}.`}
        return JSON.stringify(Object.fromEntries(device.parameters.map(param => [param.path,
            `${param.name}: ${param.range[0]} to ${param.range[1]} (shows ${param.min} to ${param.max}), default ${param.value}`])))
    }

    tools(snapshot: Snapshot): Anthropic.Tool[] {
        const tracks = ["master", ...snapshot.tracks.map(track => track.ref)]
        const effects = [...snapshot.tracks.flatMap(track => track.effects), ...snapshot.master.effects]
        const params = effects.flatMap(effect => effect.params ?? []).map(param => param.ref)
        const choices = this.#choices().map(device => device.key)
        const tools = [tool("effect_params", "Look up the parameters of an effect you're about to add: each one's path, range and default. Changes nothing. Look up only the effects you've chosen, before adding them with settings.", {
            effect: {type: "string", enum: choices}}),
            tool("add_effect", "Add an audio effect at the end of a track's chain, with its settings, from a bar on. Settings are parameter paths from effect_params with values in their ranges; unset parameters keep their defaults.", {
            track: {type: "string", enum: tracks}, effect: {type: "string", enum: choices},
            settings: {type: "array", items: {type: "object", additionalProperties: false, required: ["param", "value"],
                properties: {param: {type: "string"}, value: {type: "number"}}}},
            at_bar: AtBar})]
        if (params.length > 0) {
            tools.push(tool("set_param", "Set or ramp a parameter of an effect already on a track.", {
                param: {type: "string", enum: params}, to: {type: "number"}, over_beats: OverBeats, at_bar: AtBar}))
        }
        if (effects.length > 0) {
            tools.push(tool("remove_effect", "Remove an effect from a track, from a bar on.", {
                effect: {type: "string", enum: effects.map(effect => effect.ref ?? "")}, at_bar: AtBar}))
        }
        return tools
    }

    step(name: string, input: Record<string, unknown>, snapshot: Snapshot): Step | string {
        const bar = Number(input.at_bar)
        if (name === "add_effect") {
            const device = this.#catalog.device(String(input.effect))
            if (device === null) {return `no effect ${String(input.effect)}`}
            const settings = (input.settings as Array<{ param: string, value: number }>)
                .filter(setting => device.parameters.some(param => param.path === setting.param))
            return {plan: {op: "add_effect", track: String(input.track), device: device.key, factory: device.factory,
                    settings}, when: whenFor(bar),
                says: `${device.name} on ${trackName(snapshot, String(input.track))}`}
        }
        if (name === "set_param") {
            const ref = String(input.param), beats = Number(input.over_beats)
            const param = [...snapshot.tracks.flatMap(track => track.effects), ...snapshot.master.effects]
                .flatMap(effect => (effect.params ?? []).map(param => ({effect, param}))).find(entry => entry.param.ref === ref)
            if (param === undefined) {return `no parameter ${ref}`}
            const to = Math.min(param.param.max, Math.max(param.param.min, Number(input.to)))
            return {plan: {op: "ramp", ref, to, beats}, when: whenFor(bar),
                says: `${param.effect.name} ${param.param.name} ${param.param.display} → ${to}${beats > 0 ? ` over ${beats} beats` : ""}`}
        }
        if (name === "remove_effect") {
            const ref = String(input.effect)
            const effect = [...snapshot.tracks.flatMap(track => track.effects), ...snapshot.master.effects]
                .find(effect => effect.ref === ref)
            return {plan: {op: "remove_effect", ref}, when: whenFor(bar), says: `${effect?.name ?? ref} removed`}
        }
        return `unknown tool ${name}`
    }
}

export const createTeam = (catalog: Catalog): LlmMember[] => [new MixEngineer(), new Arranger(), new EffectDesigner(catalog)]
