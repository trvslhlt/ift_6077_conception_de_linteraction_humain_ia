import type {Activity} from "./ledger.ts"
import type Anthropic from "@anthropic-ai/sdk"
import {type Actor, type Device, type Plan, type Snapshot, type Status, target, type When} from "../../shared/protocol.ts"
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

// What the team won't do, decided for now; everything else openDAW supports is fair game, tempo, transport and
// settings included (nothing is the producer's by default, decided 2026-11-07).
export const Limits = "use only openDAW's built-in devices that the catalog allows (nothing installed or loaded from outside: no plugins, no scriptable or neural devices, no external MIDI)."


// history: the chat before this message, oldest first, for a message that refers back ("do the rest").
export type Task = { message: string, piece: string | null, hints: Hints | null,
    history?: ReadonlyArray<{ from: string, text: string }>,
    // Knowledge entries Jev judged likely for the message but wasn't sure enough to apply (router.ts, pickKnowledge)
    candidates?: ReadonlyArray<{ key: string, summary: string }>,
    // The producer addressed this member (@member): it answers in the chat itself (Coordinator.report).
    direct?: boolean,
    // The message is the producer's move of a control (Coordinator.#control), not something they typed.
    control?: boolean }
export type Member = {
    readonly agent: Actor, readonly role: string, readonly name: string
    readonly area: string                           // what the role covers
    readonly can: string                            // its fast operations: what it does quickly and cheaply
    may(plan: Plan): boolean
}

// says: what it did, for the reply ("Keys muted"). then: steps on the effect an add_effect made, once it's on (its
// parameters have no refs before), from the effect and a fresh snapshot.
// board: the board's step it carries out (board.ts), linked to its request.
// activity: the direction (and piece) it belongs to, for the ledger (ledger.ts).
export type Step = { plan: Plan, when: When, says: string, then?: (added: Device, now: Snapshot, anchored: boolean) => Step[], board?: string,
    activity?: Activity }

const MinDb = -60, MaxDb = 6
const db = (value: number): string => value <= MinDb ? "-inf dB" : `${value > 0 ? "+" : ""}${value.toFixed(1)} dB`
const barOf = (pos: string): number => Number(pos.split(".")[0])

// Planning takes seconds (a bar or two), so a plan whose first bar has passed by the time it's carried out slides later
// as a whole, keeping its spacing ("mute at the next bar, back two bars later"). Not in a loop, where a passed bar
// comes round again. Returns the bars it slid by.
const slide = (steps: Step[], now: Snapshot): number => {
    if (now.playback.loop.on || !now.playback.playing) {return 0}
    // Anchored bars count bars of playing from the message (the page lands a late one on the next bar line).
    const bars = steps.flatMap(step => step.when.at === "bar" && step.when.from === undefined ? [step.when.bar] : [])
    if (bars.length === 0) {return 0}
    // In the bar's last beat the next downbeat is too close to land on (the adapter keeps a lead), so aim one later.
    const beat = Number(now.playback.pos.split(".")[1] ?? 1)
    const first = now.playback.bar + (beat >= now.timeline.signature[0] ? 2 : 1)
    const by = first - Math.min(...bars)
    if (by <= 0) {return 0}
    steps.forEach(step => {if (step.when.at === "bar" && step.when.from === undefined) {step.when = {at: "bar", bar: step.when.bar + by}}})
    return by
}

// One step on its own, for a member that reports back to its model rather than the chat (the utility): claim, slide if
// late, request, release. Returns what happened, as the reply would say it; onStatus sees the step's progress.
export const performStep = async (context: Coordinator, agent: Actor, step: Step, reason: string,
                                  onStatus: (status: Status) => void = () => {}): Promise<string> => {
    const now = await context.snapshot()
    const slid = now === null ? 0 : slide([step], now)
    const claimed = context.claim(agent, [target(step.plan)], reason)
    if (!claimed.ok) {return `${step.says}: not done, ${claimed.holder.replace("agent:", "")} is working on it`}
    try {
        let landsAt = ""
        const status = await context.request(agent, step.plan, step.when, now?.at.seq ?? 0, reason,
            update => {
                landsAt = update.landsAt ?? landsAt
                onStatus(update)
            }, step.board, step.activity)
        return [`${describe(step, status, landsAt)}${slid > 0 ? ` (${slid} bar${slid > 1 ? "s" : ""} later than planned)` : ""}`,
            ...await followUp(context, agent, step, status, reason)].join("; ")
    } finally {
        context.release(agent, [target(step.plan)])
    }
}

// A step's follow-ups (ramps on the effect it just added), each carried out on its own once the step has applied.
const followUp = async (context: Coordinator, agent: Actor, step: Step, status: Status, reason: string): Promise<string[]> => {
    const added = status.result?.device
    if (status.state !== "applied" || step.then === undefined || added === undefined) {return []}
    const now = await context.snapshot()
    if (now === null) {return []}
    // A ramp's bar counts like the step that added the effect: from its anchor (bars of playing), else the timeline.
    const from = step.when.at === "bar" ? step.when.from : undefined
    return Promise.all(step.then(added, now, from !== undefined).map(next => performStep(context, agent,
        {...(from !== undefined && next.when.at === "bar" ? {...next, when: {...next.when, from}} : next), activity: step.activity}, reason)))
}

const describe = (step: Step, status: Status, landsAt: string): string => {
    if (status.state === "applied") {return `${step.says}${landsAt ? ` from ${landsAt}` : ""}`}
    if (status.state === "dropped") {return status.reason === "cancelled" ? `${step.says}: cancelled` : `${step.says}: not done, you're holding it`}
    return `${step.says}: not done (${status.detail ?? status.reason ?? status.state})`
}

// ---------- the language-model half ----------

const tool = (name: string, description: string, properties: Record<string, unknown>): Anthropic.Tool => ({
    name, description, strict: true,
    input_schema: {type: "object", properties, required: Object.keys(properties), additionalProperties: false}
})
const AtBar = {type: "integer", description: "Bars of playing after the producer's message it lands on (1: the next bar line, 2: the one after), whatever the loop; 0 for the next bar"}
const OverBeats = {type: "integer", enum: [0, 1, 2, 4, 8, 16, 32], description: "How long the change takes; 0 is instant"}
const whenFor = (bar: number): When => bar > 0 ? {at: "bar", bar} : {at: "next", unit: "bar"}
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

    abstract may(plan: Plan): boolean
    abstract tools(snapshot: Snapshot): Anthropic.Tool[]
    // A tool call → a step, or why it can't be one.
    abstract step(name: string, input: Record<string, unknown>, snapshot: Snapshot): Step | string
    context(_snapshot: Snapshot): object {return {}}
    // Answers a lookup tool (information, not an edit); null for the plan's own tools.
    lookup(_name: string, _input: Record<string, unknown>): string | null {return null}
    protected withParams = false
}

const trackName = (snapshot: Snapshot, ref: string): string =>
    ref === "master" ? "the master" : snapshot.tracks.find(track => track.ref === ref)?.name ?? ref

// ---------- the mix engineer ----------

export class MixEngineer extends LlmMember {
    readonly agent: Actor = "agent:mix_engineer"
    readonly role = "mix_engineer"
    readonly name = "Mix engineer"
    readonly area = "balance between parts: levels, panning, EQ, compression, sidechain"
    readonly can = "set or ramp each track's and the master's volume, and each track's pan"

    may(plan: Plan): boolean {return (plan.op === "ramp" || plan.op === "set") && /\.mix\.(volume|pan)$/.test(plan.ref)}

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
            tool("add_effect", "Add an audio effect at the end of a track's chain, with its settings, from a bar on, then optionally ramp its parameters. Settings and ramps name parameter paths from effect_params, with values in their ranges; unset parameters keep their defaults.", {
            track: {type: "string", enum: tracks}, effect: {type: "string", enum: choices},
            settings: {type: "array", items: {type: "object", additionalProperties: false, required: ["param", "value"],
                properties: {param: {type: "string"}, value: {type: "number"}}}},
            at_bar: AtBar,
            then: {type: "array", description: "Changes to this effect's parameters once it's on (a filter closing over 16 bars); [] for none. A ramp whose at_bar is no later than the effect's starts as soon as the effect is on.",
                items: {type: "object", additionalProperties: false, required: ["param", "to", "over_beats", "at_bar"],
                    properties: {param: {type: "string"}, to: {type: "number"}, over_beats: OverBeats, at_bar: AtBar}}}})]
        if (params.length > 0) {
            tools.push(tool("set_param", "Set or ramp a parameter of an effect already on a track (for one you're adding, use add_effect's then).", {
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
            const ramps = (input.then as Array<{ param: string, to: number, over_beats: number, at_bar: number }> | undefined ?? [])
                .filter(ramp => device.parameters.some(param => param.path === ramp.param))
            // Ramps keep their spacing from the effect's bar, counted from where it actually landed.
            const lands = bar > 0 ? bar : snapshot.playback.bar + 1
            const then = (added: Device, now: Snapshot, anchored: boolean): Step[] => ramps.flatMap(ramp => {
                const param = added.params?.find(param => param.ref === `${added.ref}.${ramp.param}`)
                if (param === undefined) {return []}
                const to = Math.min(param.max, Math.max(param.min, ramp.to)), after = ramp.at_bar - lands
                return [{plan: {op: "ramp", ref: param.ref, to, beats: ramp.over_beats},
                    when: after > 0 ? {at: "bar", bar: anchored ? ramp.at_bar : now.playback.bar + after} : {at: "next", unit: "beat"},
                    says: `${added.name} ${param.name} → ${to}${ramp.over_beats > 0 ? ` over ${ramp.over_beats} beats` : ""}`}]
            })
            return {plan: {op: "add_effect", track: String(input.track), device: device.key, factory: device.factory,
                    settings}, when: whenFor(bar),
                says: `${device.name} on ${trackName(snapshot, String(input.track))}`, ...(ramps.length > 0 ? {then} : {})}
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
