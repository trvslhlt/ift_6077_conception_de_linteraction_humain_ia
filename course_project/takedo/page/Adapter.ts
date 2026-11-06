import {Terminable, Terminator} from "@opendaw/lib-std"
import {PPQN, ppqn} from "@opendaw/lib-dsp"
import {PrimitiveUpdate, Update} from "@opendaw/lib-box"
import {AudioUnitBoxAdapter, AutomatableParameterFieldAdapter} from "@opendaw/studio-adapters"
import type {Project} from "@opendaw/studio-core"
import type {Actor, Apply, BackendToPage, Change, Snapshot, Status, Track} from "@/takedo_shared/protocol"
import {Clock} from "./Clock"
import type {Connection} from "./Connection"

// The page half of the bus (TAKEDO_API.md, "Overview"): the only TakeDo code that touches openDAW. Holds the ref map,
// answers snapshot queries, applies plans and reports changes. No planning and no claims: those are the backend's.
// One Adapter per open project.
//
// Scope so far: tracks' and the master's volume. A ramp is applied the way a knob drag is (unmarked writes each
// clock tick, then one mark), so it is one undo step and needs no automation lane. A parameter that has a lane is refused:
// writing its value during playback would switch the lane off until stop (STRATEGY.md, "Changes over time").

const LeadMs = 200              // edits land at least this far ahead of the playhead (STRATEGY.md, "Timing")
const GestureFoldMs = 300       // value changes on a ref with no further change for this long form one change event

type Param = { ref: string, label: string, parameter: AutomatableParameterFieldAdapter<number> }
type Pending = { change: Change, actor: Actor, request?: string, timer: ReturnType<typeof setTimeout> }

export class Adapter implements Terminable {
    readonly #terminator = new Terminator()
    readonly #project: Project
    readonly #connection: Connection
    readonly #clock = new Clock()                               // keeps landings and ramps going in a hidden tab
    readonly #refs = new Map<string, string>()                 // audio unit uuid → track ref, never reused
    readonly #held = new Set<string>()                          // parameter addresses the producer holds
    readonly #lastTouched = new Map<string, number>()           // ref → seq of its last change by someone else
    readonly #pending = new Map<string, Pending>()              // ref → gesture being folded
    #nextTrack = 1
    #seq = 0
    #applying: { actor: Actor, request: string } | null = null  // set around our own writes (origin tagging)

    constructor(project: Project, connection: Connection) {
        this.#project = project
        this.#connection = connection
        this.#terminator.own(connection.subscribeMessages(message => this.#receive(message)))
        this.#terminator.own(project.boxGraph.subscribeToAllUpdates({onUpdate: update => this.#observe(update)}))
        const onHold = (event: Event): void => {
            if (!(event instanceof CustomEvent)) {return}
            const {parameter, held} = event.detail ?? {}
            if (!(parameter instanceof AutomatableParameterFieldAdapter)) {return}
            const address = parameter.address.toString()
            if (held) {this.#held.add(address)} else {this.#held.delete(address)}
        }
        document.addEventListener("parameter-hold", onHold)
        this.#terminator.own({terminate: () => document.removeEventListener("parameter-hold", onHold)})
    }

    terminate(): void {
        this.#pending.forEach(pending => clearTimeout(pending.timer))
        this.#clock.terminate()
        this.#terminator.terminate()
    }

    snapshot(): Snapshot {
        const {timelineBox, engine} = this.#project
        const [nominator, denominator] = this.#signature()
        const tracks: Track[] = this.#units().filter(unit => !unit.isOutput).map(unit => {
            const ref = this.#trackRef(unit)
            const volume = `${ref}.mix.volume`
            return {
                ref, name: unit.label, kind: unit.isBus ? "bus" : unit.isInstrument ? "notes" : "audio",
                instrument: unit.inputAdapter.mapOr(input => input.box.name.replace(/DeviceBox$/, ""), null),
                mix: {
                    volume: unit.namedParameter.volume.getValue(),
                    mute: unit.namedParameter.mute.getValue(), solo: unit.namedParameter.solo.getValue()
                },
                lanes: unit.namedParameter.volume.track.nonEmpty() ? [volume] : []
            }
        })
        const master = this.#units().find(unit => unit.isOutput)
        return {
            at: {t: Date.now(), pos: this.#pos(), seq: this.#seq},
            playing: engine.isPlaying.getValue(),
            timeline: {bpm: timelineBox.bpm.getValue(), signature: [nominator, denominator]},
            tracks,
            master: {volume: master?.namedParameter.volume.getValue() ?? 0}
        }
    }

    #receive(message: BackendToPage): void {
        switch (message.type) {
            case "query":
                this.#connection.send({type: "result", id: message.id, snapshot: this.snapshot()})
                return
            case "apply":
                this.#apply(message.request).catch(error =>
                    this.#status(message.request, {state: "failed", reason: "opendaw_error", detail: String(error)}))
                return
        }
    }

    // ---------- applying ----------

    async #apply(request: Apply): Promise<void> {
        const {plan} = request
        const param = this.#param(plan.ref)
        if (param === null) {return this.#status(request, {state: "failed", reason: "unknown_ref", detail: plan.ref})}
        const {parameter} = param
        if (parameter.track.nonEmpty()) {
            return this.#status(request, {state: "failed", reason: "not_allowed",
                detail: "this parameter has an automation lane; writing it would switch the lane off until stop"})
        }
        const to = parameter.valueMapping.clamp(plan.to)
        if (Math.abs(to - plan.to) > 0.01) {
            return this.#status(request, {state: "failed", reason: "out_of_range", detail: `${plan.to} → ${to}`})
        }
        if ((this.#lastTouched.get(plan.ref) ?? 0) > request.seq) {
            return this.#status(request, {state: "failed", reason: "stale",
                detail: `${param.label} changed after seq ${request.seq}`})
        }
        if (this.#held.has(parameter.address.toString())) {
            return this.#status(request, {state: "dropped", reason: "held"})
        }
        if (this.#held.size > 0) {
            this.#status(request, {state: "queued"})
            while (this.#held.size > 0) {await this.#clock.tick()}
            if (this.#held.has(parameter.address.toString())) {return this.#status(request, {state: "dropped", reason: "held"})}
        }
        const {engine} = this.#project
        const playing = engine.isPlaying.getValue()
        const landsAt = playing ? this.#landing(request) : engine.position.getValue()
        const beats = playing ? plan.beats : 0
        this.#status(request, {state: "scheduled", landsAt: this.#pos(landsAt)})
        while (engine.isPlaying.getValue() && engine.position.getValue() < landsAt) {await this.#clock.tick()}
        if (this.#held.has(parameter.address.toString())) {return this.#status(request, {state: "dropped", reason: "held"})}
        const from = parameter.getValue()
        await this.#ramp(request, parameter, from, to, beats)
        const read = parameter.getValue()
        if (Math.abs(read - to) > 0.05) {
            return this.#status(request, {state: "failed", reason: "value_not_taken", detail: `read back ${read}`})
        }
        this.#status(request, {state: "applied", result: {ref: plan.ref, label: param.label, from, to: read}})
    }

    // Like a knob drag: one mark before, unmarked writes each clock tick, one mark after, so the ramp is one undo step.
    async #ramp(request: Apply, parameter: AutomatableParameterFieldAdapter<number>, from: number, to: number,
                beats: number): Promise<void> {
        const {editing, engine} = this.#project
        const write = (value: number): void => {
            this.#applying = {actor: request.from, request: request.id}
            try {
                editing.modify(() => parameter.setValue(value), false)
            } finally {
                this.#applying = null
            }
        }
        editing.mark()
        const startMs = performance.now()
        const durationMs = beats * 60000 / engine.bpm.getValue()
        while (durationMs > 0) {
            const progress = Math.min(1, (performance.now() - startMs) / durationMs)
            write(from + (to - from) * progress)
            if (progress >= 1 || this.#held.has(parameter.address.toString())) {break}
            await this.#clock.tick()
        }
        if (durationMs <= 0) {write(to)}
        editing.mark()
    }

    // The next beat or bar boundary at least LeadMs ahead of the playhead.
    #landing(request: Apply): ppqn {
        const {engine} = this.#project
        const earliest = engine.position.getValue() + PPQN.secondsToPulses(LeadMs / 1000, engine.bpm.getValue())
        if (request.when.at === "asap") {return earliest}
        const [nominator, denominator] = this.#signature()
        const unit = request.when.unit === "bar" ? PPQN.fromSignature(nominator, denominator) : PPQN.Quarter
        return Math.ceil(earliest / unit) * unit
    }

    #status(request: Apply, status: Omit<Status, "request" | "t" | "pos">): void {
        this.#connection.send({type: "status", status: {request: request.id, t: Date.now(), pos: this.#pos(), ...status}})
    }

    // ---------- observing changes ----------

    #observe(update: Update): void {
        if (!(update instanceof PrimitiveUpdate)) {return}
        const param = this.#params().find(param => param.parameter.address.equals(update.address))
        if (param === undefined) {return}
        this.#seq++
        const actor: Actor = this.#applying?.actor ?? "user"
        if (actor === "user") {this.#lastTouched.set(param.ref, this.#seq)}
        const value = Number(update.newValue)
        const pending = this.#pending.get(param.ref)
        if (pending !== undefined && pending.actor === actor) {
            clearTimeout(pending.timer)
            pending.change.to = value
            pending.timer = setTimeout(() => this.#flush(param.ref), GestureFoldMs)
            return
        }
        if (pending !== undefined) {this.#flush(param.ref)}
        this.#pending.set(param.ref, {
            change: {kind: "value", ref: param.ref, label: param.label, from: Number(update.oldValue), to: value},
            actor, request: this.#applying?.request,
            timer: setTimeout(() => this.#flush(param.ref), GestureFoldMs)
        })
    }

    #flush(ref: string): void {
        const pending = this.#pending.get(ref)
        if (pending === undefined) {return}
        clearTimeout(pending.timer)
        this.#pending.delete(ref)
        this.#connection.send({type: "change", event: {
            seq: this.#seq, t: Date.now(), pos: this.#pos(), playing: this.#project.engine.isPlaying.getValue(),
            actor: pending.actor, via: pending.actor === "user" ? "gesture" : "edit", request: pending.request,
            changes: [pending.change]
        }})
    }

    // ---------- refs ----------

    #units(): ReadonlyArray<AudioUnitBoxAdapter> {return this.#project.rootBoxAdapter.audioUnits.adapters()}

    #trackRef(unit: AudioUnitBoxAdapter): string {
        if (unit.isOutput) {return "master"}
        const key = unit.address.toString()
        let ref = this.#refs.get(key)
        if (ref === undefined) {
            ref = `t${this.#nextTrack++}`
            this.#refs.set(key, ref)
        }
        return ref
    }

    #params(): ReadonlyArray<Param> {
        return this.#units().map(unit => {
            const ref = this.#trackRef(unit)
            return {ref: `${ref}.mix.volume`, label: `${unit.isOutput ? "Master" : unit.label} › Volume`,
                parameter: unit.namedParameter.volume}
        })
    }

    #param(ref: string): Param | null {return this.#params().find(param => param.ref === ref) ?? null}

    #signature(): [number, number] {
        const {signature} = this.#project.timelineBox
        return [signature.nominator.getValue(), signature.denominator.getValue()]
    }

    #pos(position: ppqn = this.#project.engine.position.getValue()): string {
        const [nominator, denominator] = this.#signature()
        return PPQN.toString(position, nominator, denominator).replace(/:0$/, "")
    }
}
