import {Terminable, Terminator} from "@opendaw/lib-std"
import {PPQN, ppqn} from "@opendaw/lib-dsp"
import {Box, PrimitiveUpdate, Update} from "@opendaw/lib-box"
import {
    AudioRegionBoxAdapter, AudioUnitBoxAdapter, AutomatableParameterFieldAdapter, DeviceBoxAdapter, Devices,
    EffectDeviceBoxAdapter, NoteRegionBoxAdapter, PlayfieldDeviceBoxAdapter, TrackBoxAdapter
} from "@opendaw/studio-adapters"
import {EffectFactories, type EffectFactory, type Project} from "@opendaw/studio-core"
import type {
    Actor, AddEffectPlan, Apply, BackendToPage, Change, Content, Detail, Device, FailReason, Note, ParamState, Playback, Region,
    RemoveEffectPlan, ScriptPlan, Snapshot, Status, Track
} from "@/takedo_shared/protocol"
import {numeric, primitives} from "./Catalog"
import {Clock} from "./Clock"
import {runLook, runScript, type ScriptEnv, scriptEnv, serialize} from "./Scripting"
import type {Connection} from "./Connection"

// The page half of the bus (TAKEDO_API.md, "Overview"): the only TakeDo code that touches openDAW. Holds the ref map,
// answers snapshot queries, applies plans and reports changes. No planning and no claims: those are the backend's.
// One Adapter per open project.
//
// Scope so far: snapshots read tracks, devices (effects with their parameters), regions and notes. Edits: set or ramp
// a track's or the master's mix controls and any audio effect parameter; add or remove an audio effect. A ramp is
// applied the way a knob drag is (unmarked writes each clock tick, then one mark), so it is one undo step and needs no
// automation lane. While the producer records, openDAW records these writes as automation by itself, so a take keeps
// the agents' changes (STRATEGY.md, "Changes over time"). A parameter that has a lane is refused outside recording:
// writing its value during playback would switch the lane off until stop. Value changes are reported; added and
// removed effects aren't yet.

const LeadMs = 200              // edits land at least this far ahead of the playhead (STRATEGY.md, "Timing")
const GestureFoldMs = 300       // value changes on a ref with no further change for this long form one change event

type Param = { ref: string, label: string, parameter: AutomatableParameterFieldAdapter }
type Effect = { ref: string, label: string, adapter: EffectDeviceBoxAdapter }
type AnyRegionBoxAdapter = ReturnType<TrackBoxAdapter["regions"]["collection"]["asArray"]>[number]
// after: in a loop, a landing past its end waits for this much playing (pulses) rather than a position.
type Landing = { at: ppqn, after?: number } | { error: FailReason, detail: string }
// Every request's progress, for the team view's cards: its agent, what it does in words, and its latest status.
export type Activity = { request: Apply, label: string, status: Status }

// The device type: the box name without "DeviceBox" ("Vaporisateur") or "Box" (composites: "InstrumentComposite").
export const deviceKey = (box: Box): string => box.name.replace(/(Device)?Box$/, "")
const describe = (device: DeviceBoxAdapter): Device =>
    ({key: deviceKey(device.box), name: device.labelField.getValue(), enabled: device.enabledField.getValue()})
// What a note triggers, where openDAW says: a Playfield's pads (the slot index is the MIDI note).
const content = (device: DeviceBoxAdapter): { content?: Content } =>
    device instanceof PlayfieldDeviceBoxAdapter
        ? {content: {pads: device.samples.adapters().map(pad => ({note: pad.indexField.getValue(), name: pad.fileLabel}))}}
        : {}
const isSwitch = (parameter: AutomatableParameterFieldAdapter): boolean => typeof parameter.getValue() === "boolean"
const isStepped = (parameter: AutomatableParameterFieldAdapter): boolean =>
    isSwitch(parameter) || !parameter.valueMapping.floating()
const print = (parameter: AutomatableParameterFieldAdapter): string => {
    const {value, unit} = parameter.stringMapping.x(parameter.getValue())
    return unit === "" ? value : `${value} ${unit}`
}
const effectFactory = (name: string): EffectFactory | null =>
    (EffectFactories.AudioNamed as Record<string, EffectFactory>)[name] ?? null
const errorText = (error: unknown): string =>
    error instanceof Error ? `${error.name}: ${error.message}` : String(error)
type Pending = { change: Change, actor: Actor, request?: string, timer: ReturnType<typeof setTimeout> }

export class Adapter implements Terminable {
    readonly #terminator = new Terminator()
    readonly #project: Project
    readonly #connection: Connection
    readonly #clock = new Clock()                               // keeps landings and ramps going in a hidden tab
    readonly #refs = new Map<string, string>()                 // audio unit address → track ref, never reused
    readonly #effectRefs = new Map<string, string>()           // effect address → effect ref (t1.fx1), never reused
    readonly #nextEffect = new Map<string, number>()           // track ref → its next effect number
    readonly #regionRefs = new Map<string, string>()           // region address → region ref, never reused
    readonly #held = new Set<string>()                          // parameter addresses the producer holds
    readonly #lastTouched = new Map<string, number>()           // ref → seq of its last change by someone else
    readonly #pending = new Map<string, Pending>()              // ref → gesture being folded
    #params: ReadonlyArray<Param> | null = null                 // cached until the project's structure changes
    #nextTrack = 1
    #nextRegion = 1
    #seq = 0
    #revision = 0                                               // every box graph update (UI state included)
    #applying: { actor: Actor, request: string } | null = null  // set around our own writes (origin tagging)
    #touched: Set<string> | null = null                         // addresses a running script changed
    #updates = 0                                                // updates a running script made
    readonly #env: ScriptEnv
    readonly #activity = new Set<(activity: Activity) => void>()
    readonly #labels = new Map<string, string>()                // request id → what it does, while it's open

    constructor(project: Project, connection: Connection) {
        this.#project = project
        this.#connection = connection
        this.#env = scriptEnv(project, ref => this.#resolve(ref), () => this.snapshot(), () => this.#bar(),
            position => this.#pos(position))
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

    get revision(): number {return this.#revision}

    subscribeActivity(listener: (activity: Activity) => void): Terminable {
        this.#activity.add(listener)
        return {terminate: () => this.#activity.delete(listener)}
    }

    // A request in the producer's words: track and control names, not refs.
    #label(request: Apply): string {
        const {plan} = request
        const track = (ref: string): string => {
            const unit = this.#units().find(unit => this.#trackRef(unit) === ref)
            return unit === undefined ? ref : unit.label
        }
        switch (plan.op) {
            case "ramp": case "set": {
                const label = this.#param(plan.ref)?.label ?? plan.ref
                const to = Number.isInteger(plan.to) ? plan.to : plan.to.toFixed(2)
                return plan.op === "ramp" && plan.beats > 0 ? `${label} → ${to} over ${plan.beats} beats` : `${label} → ${to}`
            }
            case "add_effect": return `${plan.device} on ${track(plan.track)}`
            case "remove_effect": return `remove ${this.#units().flatMap(unit => this.#effects(unit))
                .find(effect => effect.ref === plan.ref)?.label ?? plan.ref}`
            case "script": return plan.description
        }
    }

    playback(): Playback {
        const {timelineBox: {loopArea}, engine} = this.#project
        const position = engine.position.getValue()
        return {
            playing: engine.isPlaying.getValue(), pos: this.#pos(), bar: Math.floor(position / this.#bar()) + 1,
            loop: {on: loopArea.enabled.getValue(), from: this.#pos(loopArea.from.getValue()),
                to: this.#pos(loopArea.to.getValue())}
        }
    }

    // Walks the whole project each time, so nothing added meanwhile is missed (TAKEDO_API.md, "Snapshot").
    snapshot(detail: Detail = "outline"): Snapshot {
        const {timelineBox, engine} = this.#project
        const [nominator, denominator] = this.#signature()
        const bar = this.#bar()
        let end = 0
        const tracks: Track[] = this.#units().filter(unit => !unit.isOutput).map(unit => {
            const ref = this.#trackRef(unit)
            const volume = `${ref}.mix.volume`
            const regionAdapters = unit.tracks.values().flatMap(track => track.regions.collection.asArray())
                .filter(region => region.type !== "value-region")
            regionAdapters.forEach(region => end = Math.max(end, region.complete))
            return {
                ref, name: unit.label, kind: unit.isBus ? "bus" : unit.isInstrument ? "notes" : "audio",
                instrument: unit.inputAdapter.mapOr(input => deviceKey(input.box), null),
                device: unit.inputAdapter.mapOr(input => ({...describe(input), ...content(input)}), null),
                midiEffects: unit.midiEffects.mapOr(effects => effects.adapters().map(describe), []),
                effects: this.#effectsOf(unit),
                mix: {
                    volume: unit.namedParameter.volume.getValue(), pan: unit.namedParameter.panning.getValue(),
                    mute: unit.namedParameter.mute.getValue(), solo: unit.namedParameter.solo.getValue()
                },
                bars: regionAdapters.length === 0 ? null : {
                    from: Math.floor(Math.min(...regionAdapters.map(region => region.position)) / bar) + 1,
                    to: Math.ceil(Math.max(...regionAdapters.map(region => region.complete)) / bar)
                },
                lanes: unit.namedParameter.volume.track.nonEmpty() ? [volume] : [],
                regions: regionAdapters.map(region => this.#region(region, bar, detail))
            }
        })
        const master = this.#units().find(unit => unit.isOutput)
        return {
            at: {t: Date.now(), pos: this.#pos(), seq: this.#seq, revision: this.#revision},
            detail,
            playing: engine.isPlaying.getValue(),
            playback: this.playback(),
            timeline: {bpm: timelineBox.bpm.getValue(), signature: [nominator, denominator], length: this.#pos(end)},
            tracks,
            master: {volume: master?.namedParameter.volume.getValue() ?? 0, effects: master ? this.#effectsOf(master) : []}
        }
    }

    #effectsOf(unit: AudioUnitBoxAdapter): Device[] {
        return this.#effects(unit).map(effect => ({
            ...describe(effect.adapter), ref: effect.ref,
            params: this.#allParams().filter(param => param.ref.startsWith(`${effect.ref}.`)).map(param => this.#state(param))
        }))
    }

    #state({ref, parameter}: Param): ParamState {
        return {ref, name: parameter.name, value: numeric(parameter.getValue()), display: print(parameter),
            min: numeric(parameter.valueMapping.y(0)), max: numeric(parameter.valueMapping.y(1)),
            stepped: isStepped(parameter)}
    }

    #region(region: AnyRegionBoxAdapter, bar: ppqn, detail: Detail): Region {
        const key = region.address.toString()
        let ref = this.#regionRefs.get(key)
        if (ref === undefined) {
            ref = `r${this.#nextRegion++}`
            this.#regionRefs.set(key, ref)
        }
        const loops = region.loopDuration < region.duration
        const result: Region = {
            ref, name: region.label, from: this.#pos(region.position), to: this.#pos(region.complete),
            muted: region.mute, loop: loops ? Number((region.loopDuration / bar).toFixed(3)) : null,
            kind: region instanceof AudioRegionBoxAdapter ? "audio" : "notes"
        }
        if (region instanceof AudioRegionBoxAdapter) {result.sample = region.file.box.fileName.getValue()}
        if (detail === "full" && region instanceof NoteRegionBoxAdapter) {
            result.notes = region.optCollection.mapOr(collection => collection.events.asArray()
                .filter(note => note.position < region.loopDuration)
                .map((note): Note => [this.#pos(note.position), note.pitch,
                    Number((note.duration / PPQN.SemiQuaver).toFixed(2)), Math.round(note.velocity * 127)]), [])
        }
        return result
    }

    #receive(message: BackendToPage): void {
        switch (message.type) {
            case "query":
                this.#connection.send({type: "result", id: message.id, snapshot: this.snapshot(message.detail)})
                return
            case "look":
                runLook(message.code, this.#env)
                    .then(value => this.#connection.send({type: "looked", id: message.id, ok: true, value: serialize(value)}))
                    .catch(error => this.#connection.send({type: "looked", id: message.id, ok: false, value: errorText(error)}))
                return
            case "apply":
                this.apply(message.request)
                return
        }
    }

    // ---------- applying ----------

    // A request from the backend (public for tests, which send one straight to the page; the backend ignores statuses
    // of requests it didn't send).
    apply(request: Apply): void {
        this.#apply(request).catch(error =>
            this.#status(request, {state: "failed", reason: "opendaw_error", detail: String(error)}))
    }

    async #apply(request: Apply): Promise<void> {
        const {plan} = request
        if (plan.op === "add_effect") {return this.#addEffect(request, plan)}
        if (plan.op === "remove_effect") {return this.#removeEffect(request, plan)}
        if (plan.op === "script") {return this.#script(request, plan)}
        const param = this.#param(plan.ref)
        if (param === null) {return this.#status(request, {state: "failed", reason: "unknown_ref", detail: plan.ref})}
        const {parameter} = param
        // While openDAW records, a write is recorded over the lane (only the recorded span is replaced), so it's allowed.
        if (parameter.track.nonEmpty() && !this.#project.engine.isRecording.getValue()) {
            return this.#status(request, {state: "failed", reason: "not_allowed",
                detail: "this parameter has an automation lane; writing it would switch the lane off until stop"})
        }
        const switched = isSwitch(parameter)
        const to = switched ? (plan.to !== 0 ? 1 : 0)
            : isStepped(parameter) ? Math.round(parameter.valueMapping.clamp(plan.to)) : parameter.valueMapping.clamp(plan.to)
        if (!switched && Math.abs(to - plan.to) > Math.max(0.01, Math.abs(plan.to) * 0.001) && !isStepped(parameter)) {
            return this.#status(request, {state: "failed", reason: "out_of_range", detail: `${plan.to} → ${to}`})
        }
        if ((this.#lastTouched.get(plan.ref) ?? 0) > request.seq) {
            return this.#status(request, {state: "failed", reason: "stale",
                detail: `${param.label} changed after seq ${request.seq}`})
        }
        const held = (): boolean => this.#held.has(parameter.address.toString())
        if (held()) {return this.#status(request, {state: "dropped", reason: "held"})}
        if (this.#held.size > 0) {
            this.#status(request, {state: "queued"})
            while (this.#held.size > 0) {await this.#clock.tick()}
            if (held()) {return this.#status(request, {state: "dropped", reason: "held"})}
        }
        if (!(await this.#land(request))) {return}
        if (held()) {return this.#status(request, {state: "dropped", reason: "held"})}
        const from = numeric(parameter.getValue())
        const beats = plan.op === "ramp" && !isStepped(parameter) && this.#project.engine.isPlaying.getValue() ? plan.beats : 0
        if (beats > 0) {this.#status(request, {state: "running", landsAt: this.#pos()})}
        await this.#ramp(request, parameter, from, to, beats)
        const read = numeric(parameter.getValue())
        if (Math.abs(read - to) > Math.max(0.05, Math.abs(to) * 0.001)) {
            return this.#status(request, {state: "failed", reason: "value_not_taken", detail: `read back ${read}`})
        }
        this.#status(request, {state: "applied", result: {ref: plan.ref, label: param.label, from, to: read}})
    }

    async #addEffect(request: Apply, plan: AddEffectPlan): Promise<void> {
        const unit = this.#units().find(unit => this.#trackRef(unit) === plan.track)
        if (unit === undefined) {return this.#status(request, {state: "failed", reason: "unknown_ref", detail: plan.track})}
        const factory = effectFactory(plan.factory)
        if (factory === null) {
            return this.#status(request, {state: "failed", reason: "invalid_args", detail: `no audio effect ${plan.factory}`})
        }
        if (!(await this.#land(request))) {return}
        const {api, boxAdapters, parameterFieldAdapters} = this.#project
        const box = this.#tagged(request, () => this.#project.editing.modify(() => {
            const box = api.insertEffect(unit.box.audioEffects, factory)
            boxAdapters.adapterFor(box, Devices.isEffect) // registers its parameters
            for (const field of primitives(box.fields())) {
                const path = box.mapFields(field => field.fieldName, ...field.address.fieldKeys).join("/")
                const setting = plan.settings.find(setting => setting.param === path)
                if (setting === undefined) {continue}
                parameterFieldAdapters.opt(field.address).ifSome(parameter => parameter.setValue(isSwitch(parameter)
                    ? setting.value !== 0 : parameter.valueMapping.clamp(setting.value)))
            }
            return box
        }).unwrapOrNull())
        if (box === null) {return this.#status(request, {state: "failed", reason: "opendaw_error", detail: "insert failed"})}
        const adapter = this.#project.boxAdapters.adapterFor(box, Devices.isEffect)
        this.#params = null
        const effect = this.#effects(unit).find(effect => effect.adapter === adapter)
        const device = this.#effectsOf(unit).find(device => device.ref === effect?.ref)
        this.#status(request, {state: "applied",
            result: {ref: effect?.ref ?? plan.track, label: effect?.label ?? factory.defaultName, device}})
    }

    async #removeEffect(request: Apply, plan: RemoveEffectPlan): Promise<void> {
        const effect = this.#units().flatMap(unit => this.#effects(unit)).find(effect => effect.ref === plan.ref)
        if (effect === undefined) {return this.#status(request, {state: "failed", reason: "unknown_ref", detail: plan.ref})}
        if (!(await this.#land(request))) {return}
        this.#tagged(request, () => this.#project.editing.modify(() => Devices.deleteEffectDevices([effect.adapter])))
        this.#params = null
        this.#status(request, {state: "applied", result: {ref: plan.ref, label: effect.label}})
    }

    // One edit: rolled back by openDAW if it throws; undone if it changed anything the producer holds.
    async #script(request: Apply, plan: ScriptPlan): Promise<void> {
        if (!(await this.#land(request))) {return}
        this.#touched = new Set()
        this.#updates = 0
        let value: unknown
        try {
            this.#tagged(request, () => this.#project.editing.modify(() => {value = runScript(plan.code, this.#env)}))
        } catch (error) {
            return this.#status(request, {state: "failed", reason: "invalid_args", detail: errorText(error)})
        } finally {
            this.#params = null
        }
        const touched = this.#touched
        const updates = this.#updates
        this.#touched = null
        if ([...touched].some(address => this.#held.has(address))) {
            this.#project.editing.undo()
            return this.#status(request, {state: "dropped", reason: "held", detail: "it changed a control you're holding"})
        }
        this.#status(request, {state: "applied",
            result: {ref: "project", label: plan.description, value: serialize(value), updates}})
    }

    // A ref as a script sees it: the adapter openDAW's UI uses.
    #resolve(ref: string): unknown {
        if (/^r\d+$/.test(ref)) {
            const key = [...this.#regionRefs].find(([, value]) => value === ref)?.[0]
            return this.#units().flatMap(unit => unit.tracks.values().flatMap(track => track.regions.collection.asArray()))
                .find(region => region.address.toString() === key) ?? null
        }
        if (/\.fx\d+$/.test(ref)) {
            return this.#units().flatMap(unit => this.#effects(unit)).find(effect => effect.ref === ref)?.adapter ?? null
        }
        return this.#units().find(unit => this.#trackRef(unit) === ref) ?? null
    }

    // Runs an edit tagged as the requesting agent's (origin tagging).
    #tagged<R>(request: Apply, edit: () => R): R {
        this.#applying = {actor: request.from, request: request.id}
        try {
            return edit()
        } finally {
            this.#applying = null
        }
    }

    // Like a knob drag: one mark before, unmarked writes each clock tick, one mark after, so the ramp is one undo step.
    async #ramp(request: Apply, parameter: AutomatableParameterFieldAdapter, from: number, to: number,
                beats: number): Promise<void> {
        const {editing, engine} = this.#project
        const write = (value: number): void => {
            this.#applying = {actor: request.from, request: request.id}
            try {
                editing.modify(() => parameter.setValue(isSwitch(parameter) ? value !== 0 : value), false)
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

    // Reports scheduled and waits for the landing; false (after reporting failed) if it can't land.
    async #land(request: Apply): Promise<boolean> {
        const {engine} = this.#project
        if (!engine.isPlaying.getValue() || request.when.at === "asap") {
            this.#status(request, {state: "scheduled", landsAt: this.#pos()})
            return true
        }
        const landing = this.#landing(request)
        if ("error" in landing) {
            this.#status(request, {state: "failed", reason: landing.error, detail: landing.detail})
            return false
        }
        const bars = landing.after === undefined ? 0 : Math.round(landing.after / this.#bar())
        this.#status(request, {state: "scheduled",
            landsAt: `${this.#pos(landing.at)}${bars > 0 ? ` (after ${bars} bars of playing)` : ""}`})
        const {loopArea} = this.#project.timelineBox
        let last = engine.position.getValue()
        if (landing.after !== undefined) {
            // Played time, counting each pass of the loop.
            let played = 0
            while (engine.isPlaying.getValue() && played < landing.after) {
                await this.#clock.tick()
                const position = engine.position.getValue()
                played += position >= last ? position - last
                    : (loopArea.to.getValue() - last) + (position - loopArea.from.getValue())
                last = position
            }
            return true
        }
        // Armed once the playhead is before the landing, or has jumped back (the loop wrapped): in a loop, a landing
        // already passed waits for the next pass, and one on the loop's start lands as the loop wraps.
        let armed = last < landing.at
        while (engine.isPlaying.getValue()) {
            const position = engine.position.getValue()
            if (position < landing.at || position < last) {armed = true}
            if (armed && position >= landing.at) {break}
            last = position
            await this.#clock.tick()
        }
        return true
    }

    // The next beat or bar at least LeadMs ahead of the playhead, or a given bar; asap is now (nothing waits for it).
    // In a loop, a next beat or bar past the loop's end wraps to its start; a bar inside the loop lands the next time
    // the playhead reaches it; a bar past its end counts played bars from the playhead, as if the loop were unrolled
    // (playhead in bar 2, bar 10: after 8 bars of playing), so a plan's later steps keep their spacing; a bar before
    // the loop is refused (the playhead would never reach it).
    #landing(request: Apply): Landing {
        const {engine, timelineBox: {loopArea}} = this.#project
        const position = engine.position.getValue()
        const earliest = position + PPQN.secondsToPulses(LeadMs / 1000, engine.bpm.getValue())
        const looping = loopArea.enabled.getValue()
        const [loopFrom, loopTo] = [loopArea.from.getValue(), loopArea.to.getValue()]
        const {when} = request
        if (when.at === "bar") {
            const at = (when.bar - 1) * this.#bar()
            if (looping && at < loopFrom) {
                return {error: "not_allowed", detail: `bar ${when.bar} is before the loop (${this.#pos(loopFrom)} to ${this.#pos(loopTo)})`}
            }
            if (looping && at >= loopTo && loopTo > loopFrom) {
                // From where the playhead is in the loop (or the loop's start, if it's outside and about to jump in).
                const after = at - (position >= loopFrom && position < loopTo ? position : loopFrom)
                return {at: loopFrom + (at - loopFrom) % (loopTo - loopFrom), after}
            }
            if (!looping && at < earliest) {return {error: "too_late", detail: `bar ${when.bar} has passed`}}
            return {at}
        }
        if (when.at === "asap") {return {at: position}}
        const unit = when.unit === "bar" ? this.#bar() : PPQN.Quarter
        const at = Math.ceil(earliest / unit) * unit
        return {at: looping && at >= loopTo ? loopFrom : at}
    }

    #status(request: Apply, status: Omit<Status, "request" | "t" | "pos">): void {
        const full: Status = {request: request.id, t: Date.now(), pos: this.#pos(), ...status}
        this.#connection.send({type: "status", status: full})
        const label = this.#labels.get(request.id) ?? this.#label(request)
        if (status.state === "applied" || status.state === "dropped" || status.state === "failed") {
            this.#labels.delete(request.id)
        } else {
            this.#labels.set(request.id, label)
        }
        this.#activity.forEach(listener => listener({request, label, status: full}))
    }

    // ---------- observing changes ----------

    #observe(update: Update): void {
        this.#revision++
        if (this.#touched !== null) {
            this.#updates++
            if (update instanceof PrimitiveUpdate) {this.#touched.add(update.address.toString())}
        }
        if (!(update instanceof PrimitiveUpdate)) {
            this.#params = null
            return
        }
        const param = this.#allParams().find(param => param.parameter.address.equals(update.address))
        if (param === undefined) {return}
        this.#seq++
        const actor: Actor = this.#applying?.actor ?? "user"
        if (actor === "user") {this.#lastTouched.set(param.ref, this.#seq)}
        const value = numeric(update.newValue)
        const pending = this.#pending.get(param.ref)
        if (pending !== undefined && pending.actor === actor) {
            clearTimeout(pending.timer)
            pending.change.to = value
            pending.timer = setTimeout(() => this.#flush(param.ref), GestureFoldMs)
            return
        }
        if (pending !== undefined) {this.#flush(param.ref)}
        this.#pending.set(param.ref, {
            change: {kind: "value", ref: param.ref, label: param.label, from: numeric(update.oldValue), to: value},
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

    #trackLabel(unit: AudioUnitBoxAdapter): string {return unit.isOutput ? "Master" : unit.label}

    #effects(unit: AudioUnitBoxAdapter): Effect[] {
        const track = this.#trackRef(unit)
        return unit.audioEffects.mapOr(effects => effects.adapters(), []).map(adapter => {
            const key = adapter.address.toString()
            let ref = this.#effectRefs.get(key)
            if (ref === undefined) {
                const next = this.#nextEffect.get(track) ?? 1
                this.#nextEffect.set(track, next + 1)
                ref = `${track}.fx${next}`
                this.#effectRefs.set(key, ref)
            }
            return {ref, label: `${this.#trackLabel(unit)} › ${adapter.labelField.getValue()}`, adapter}
        })
    }

    // Every parameter agents can write: each channel's mix controls and every audio effect's automatable parameters,
    // by their path in the box (as the catalog lists them).
    #allParams(): ReadonlyArray<Param> {
        if (this.#params !== null) {return this.#params}
        const {parameterFieldAdapters} = this.#project
        this.#params = this.#units().flatMap(unit => {
            const ref = this.#trackRef(unit)
            const label = this.#trackLabel(unit)
            const {volume, panning, mute, solo} = unit.namedParameter
            const mix: Param[] = [["volume", volume], ["pan", panning], ["mute", mute], ["solo", solo]]
                .map(([name, parameter]) => ({ref: `${ref}.mix.${name}`, label: `${label} › ${(parameter as AutomatableParameterFieldAdapter).name}`,
                    parameter: parameter as AutomatableParameterFieldAdapter}))
            const effects = this.#effects(unit).flatMap(effect => {
                const box = effect.adapter.box
                return primitives(box.fields()).flatMap(field => parameterFieldAdapters.opt(field.address).match({
                    none: () => [],
                    some: parameter => [{
                        ref: `${effect.ref}.${box.mapFields(field => field.fieldName, ...field.address.fieldKeys).join("/")}`,
                        label: `${effect.label} › ${parameter.name}`, parameter
                    }]
                }))
            })
            return [...mix, ...effects]
        })
        return this.#params
    }

    #param(ref: string): Param | null {return this.#allParams().find(param => param.ref === ref) ?? null}

    #bar(): ppqn {
        const [nominator, denominator] = this.#signature()
        return PPQN.fromSignature(nominator, denominator)
    }

    #signature(): [number, number] {
        const {signature} = this.#project.timelineBox
        return [signature.nominator.getValue(), signature.denominator.getValue()]
    }

    #pos(position: ppqn = this.#project.engine.position.getValue()): string {
        const [nominator, denominator] = this.#signature()
        return PPQN.toString(position, nominator, denominator).replace(/:0$/, "")
    }
}
