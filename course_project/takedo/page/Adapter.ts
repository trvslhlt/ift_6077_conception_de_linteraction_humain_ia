import {Terminable, Terminator, UUID} from "@opendaw/lib-std"
import {PPQN, ppqn} from "@opendaw/lib-dsp"
import {Address, Box, PrimitiveUpdate, Update} from "@opendaw/lib-box"
import {
    AudioRegionBoxAdapter, AudioUnitBoxAdapter, AutomatableParameterFieldAdapter, DeviceBoxAdapter, Devices,
    EffectDeviceBoxAdapter, NoteRegionBoxAdapter, PlayfieldDeviceBoxAdapter, TempoRange, TrackBoxAdapter
} from "@opendaw/studio-adapters"
import {AudioRegionBox, NoteEventBox, NoteRegionBox, ValueEventBox, ValueEventCollectionBox} from "@opendaw/studio-boxes"
import {EffectFactories, type EffectFactory, type Project} from "@opendaw/studio-core"
import type {
    Actor, AddEffectPlan, Apply, BackendToPage, Change, Content, Detail, Device, FailReason, Note, ParamState, Playback, Region,
    RemoveEffectPlan, ScriptPlan, Snapshot, Status, Track
} from "@/takedo_shared/protocol"
import {numeric, primitives} from "./Catalog"
import {touchedBetween} from "@/takedo_shared/touched"
import {Clock} from "./Clock"
import {type Correction, guardField} from "./Guard"
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

const EngineSettleMs = 3000      // an engine start this soon after the adapter is the project opening, not a restart
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

// A recorded jam with the loop off keeps going (#keepGoing): this many bars before the song's end, it grows by this many.
const KeepAheadBars = 4
const KeepGoingBars = 16

type NoteEventCollectionAdapter = ReturnType<NoteRegionBoxAdapter["optCollection"]["unwrap"]>
type Kept = { region: NoteRegionBoxAdapter, saved: ReturnType<NoteEventCollectionAdapter["copy"]>, notes: string, at: ppqn }
// A part's notes as text, to tell whether a script changed them. Read from the boxes: the adapter's list of events
// catches up only when the edit ends, so mid-edit it still shows the notes from before.
const notesOf = (collection: NoteEventCollectionAdapter): string => collection.box.events.pointerHub.incoming()
    .map(pointer => pointer.box).filter((box): box is NoteEventBox => box instanceof NoteEventBox)
    .map(event => [event.position, event.duration, event.pitch, event.velocity, event.playCount, event.playCurve, event.cent, event.chance]
        .map(field => field.getValue()).join())
    .sort().join("|")

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
    #lastAgentEdit: { label: string, steps: number } | null = null   // the latest script or added effect, for a crash
    #historySteps = 0
    #played = 0                                                 // pulses played, through each pass of the loop
    #lastPosition = 0
    readonly #ramping = new Map<string, string>()               // parameter address → the request ramping it now                                           // changes to the undo history (edits, undos, redos)
    #touched: Map<string, { address: Address, previous: unknown }> | null = null   // what a running script changed, first value
    #updates = 0                                                // updates a running script made
    readonly #env: ScriptEnv
    readonly #activity = new Set<(activity: Activity) => void>()
    readonly #labels = new Map<string, string>()                // request id → what it does, while it's open
    readonly #cancelled = new Set<string>()                     // requests taken back while waiting for their bar

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
        this.#terminator.own(project.editing.subscribe(() => {this.#historySteps++}))
        this.#lastPosition = project.engine.position.getValue()
        this.#terminator.own(project.engine.position.subscribe(owner => this.#follow(owner.getValue())))
        this.#watchEngine(project)
    }

    // After an audio engine error openDAW asks to restart it, then starts a new engine on the same project; a value
    // that crashed it would crash it again. So on that restart, an agent's script or added effect that is still the
    // latest undo step (the history hasn't changed since) is undone first, and the backend hears (to tell the producer and the agent). The first start
    // after this adapter exists is the project opening, not a restart.
    #watchEngine(project: Project): void {
        const created = Date.now()
        const start = project.startAudioWorklet.bind(project)
        project.startAudioWorklet = (...args: Parameters<Project["startAudioWorklet"]>) => {
            if (Date.now() - created > EngineSettleMs) {this.#restarting()}
            return start(...args)
        }
        this.#terminator.own({terminate: () => {project.startAudioWorklet = start}})
    }

    #restarting(): void {
        const last = this.#lastAgentEdit
        this.#lastAgentEdit = null
        const undo = last !== null && last.steps === this.#historySteps
        if (undo) {this.#project.editing.undo()}
        this.#connection.send({type: "engine", undone: undo ? last.label : null})
    }

    // Counts played pulses: forward motion while playing, and the loop's wrap as the rest of the pass plus the new start.
    #follow(position: ppqn): void {
        const last = this.#lastPosition
        this.#lastPosition = position
        if (!this.#project.engine.isPlaying.getValue()) {return}
        this.#played += this.#advance(last, position)
        this.#keepGoing(position)
    }

    // A jam keeps going (2026-11-24): recording with the loop off, the song mustn't end under the producer (a 16-bar
    // project stopped at bar 17 and the take with it). A few bars before a part ends (a track's last region, not muted),
    // it plays on for KeepGoingBars more, its content repeating, and the timeline grows with it: added ahead of the
    // playhead, nothing that has played changes. Not while just playing: a finished song with the loop off ends as it is.
    #extending = false
    #keepGoing(position: ppqn): void {
        const {engine, timelineBox} = this.#project
        if (this.#extending || timelineBox.loopArea.enabled.getValue() || !engine.isRecording.getValue()) {return}
        const bar = this.#bar()
        // Parts only: an automation region being recorded is the recorder's to grow (2026-11-25: lengthening one fought
        // the recorder, which set it back each frame).
        const tracks = this.#units().flatMap(unit => unit.tracks.values())
            .filter(track => track.regions.collection.asArray().every(region =>
                region instanceof NoteRegionBoxAdapter || region instanceof AudioRegionBoxAdapter))
        const regions = tracks.flatMap(track => track.regions.collection.asArray())
        const end = regions.reduce((most, region) => Math.max(most, region.complete), 0)
        // Every part plays on: each track's last region, unless it's muted (parked) (2026-11-25: a part added mid-song
        // was given an end bar by its worker, the song's old end, and fell silent while the song went on).
        const ending = tracks.flatMap(track => {
            const last = track.regions.collection.asArray().reduce<typeof regions[number] | null>((latest, region) =>
                latest === null || region.complete > latest.complete ? region : latest, null)
            return last !== null && !last.mute && last.complete > position && last.complete - position <= KeepAheadBars * bar ? [last] : []
        })
        if (ending.length === 0) {return}
        this.#extending = true
        setTimeout(() => {
            try {
                const grow = KeepGoingBars * bar
                this.#project.editing.modify(() => {
                    ending.forEach(region => region.box.duration.setValue(region.duration + grow))
                    const longest = Math.max(end, ...ending.map(region => region.complete))
                    timelineBox.durationInPulses.setValue(Math.max(timelineBox.durationInPulses.getValue(), longest))
                })
            } finally {
                this.#extending = false
            }
        }, 0)
    }

    // Pulses played from one reading of the playhead to the next. Going back counts as the loop's wrap only when it
    // looks like one (from its last bar to its first): any other step back (the producer moving the playhead, or the
    // engine's position jittering as a loop was widened, 2026-11-24) counts nothing, where it had counted most of a
    // pass, and a whole plan's waits ran out at once.
    #advance(last: ppqn, position: ppqn): number {
        if (position >= last) {return position - last}
        const {loopArea} = this.#project.timelineBox
        if (!loopArea.enabled.getValue()) {return 0}
        const [from, to, bar] = [loopArea.from.getValue(), loopArea.to.getValue(), this.#bar()]
        return last >= to - bar && position < from + bar ? Math.max(0, to - last) + Math.max(0, position - from) : 0
    }

    terminate(): void {
        this.#pending.forEach(pending => clearTimeout(pending.timer))
        this.#clock.terminate()
        this.#terminator.terminate()
    }

    get revision(): number {return this.#revision}

    // Off only in the smoke test, to crash the engine on purpose and check the undo on restart.
    guarding = true

    // The scripts' environment, for live sessions driven from outside (live/eval.mjs).
    get env(): ScriptEnv {return this.#env}

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
                to: this.#pos(loopArea.to.getValue())},
            position, played: this.#played
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
            // The tempo playing (the tempo track's, when it's on), not the project's field: a Team Lead that read the field,
            // 82 BPM, while automation played 170 redid a finished tempo glide from 82 (2026-11-25).
            timeline: {bpm: this.#tempoAutomated() ? Math.round(engine.bpm.getValue() * 10) / 10 : timelineBox.bpm.getValue(),
                tempoAutomated: this.#tempoAutomated(), signature: [nominator, denominator], length: this.#pos(end)},
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
            case "cancel":
                // Kept even if it hasn't reached its wait yet; one that already landed just stays in the set.
                this.#cancelled.add(message.request)
                return
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
        if (!Number.isFinite(plan.to)) {return this.#status(request, {state: "failed", reason: "invalid_args", detail: `to: ${plan.to}`})}
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
        if (!(await this.#ramp(request, parameter, from, to, beats))) {
            return this.#status(request, {state: "applied", detail: `handed over at ${this.#pos()} to a later change of this control`,
                result: {ref: plan.ref, label: param.label, from, to: numeric(parameter.getValue())}})
        }
        const read = numeric(parameter.getValue())
        if (Math.abs(read - to) > Math.max(0.05, Math.abs(to) * 0.001)) {
            return this.#status(request, {state: "failed", reason: "value_not_taken", detail: `read back ${read}`})
        }
        this.#status(request, {state: "applied", result: {ref: plan.ref, label: param.label, from, to: read}})
    }

    async #addEffect(request: Apply, plan: AddEffectPlan): Promise<void> {
        const unit = this.#units().find(unit => this.#trackRef(unit) === this.#named(plan.track))
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
                if (setting === undefined || !Number.isFinite(setting.value)) {continue}
                // While recording, written past the recorder: a setting is the device's setup, not a performance, and each
                // write openDAW records opens an automation region that grows every frame until stop (2026-11-25: two
                // effects added mid-take opened 11).
                const recording = this.#project.engine.isRecording.getValue()
                parameterFieldAdapters.opt(field.address).ifSome(parameter => {
                    const value = isSwitch(parameter) ? setting.value !== 0 : parameter.valueMapping.clamp(setting.value)
                    if (recording) {parameter.field.setValue(value)} else {parameter.setValue(value)}
                })
            }
            return box
        }).unwrapOrNull())
        if (box === null) {return this.#status(request, {state: "failed", reason: "opendaw_error", detail: "insert failed"})}
        const adapter = this.#project.boxAdapters.adapterFor(box, Devices.isEffect)
        this.#params = null
        const effect = this.#effects(unit).find(effect => effect.adapter === adapter)
        const device = this.#effectsOf(unit).find(device => device.ref === effect?.ref)
        this.#lastAgentEdit = {label: `${factory.defaultName} on ${unit.label}`, steps: this.#historySteps}
        this.#status(request, {state: "applied",
            result: {ref: effect?.ref ?? plan.track, label: effect?.label ?? factory.defaultName, device}})
    }

    async #removeEffect(request: Apply, plan: RemoveEffectPlan): Promise<void> {
        const effect = this.#units().flatMap(unit => this.#effects(unit)).find(effect => effect.ref === this.#named(plan.ref))
        if (effect === undefined) {return this.#status(request, {state: "failed", reason: "unknown_ref", detail: plan.ref})}
        if (!(await this.#land(request))) {return}
        this.#tagged(request, () => this.#project.editing.modify(() => Devices.deleteEffectDevices([effect.adapter])))
        this.#params = null
        this.#status(request, {state: "applied", result: {ref: plan.ref, label: effect.label}})
    }

    // One edit: rolled back by openDAW if it throws; undone if it changed anything the producer holds.
    async #script(request: Apply, plan: ScriptPlan): Promise<void> {
        if (!(await this.#land(request))) {return}
        // The project just before, to say what the script changed (shared/touched.ts: what the activity owns).
        const before = this.snapshot("full")
        this.#touched = new Map()
        this.#updates = 0
        let value: unknown
        let corrections: Correction[] = []
        try {
            this.#tagged(request, () => this.#project.editing.modify(() => {
                const loop = this.#loopNow()
                const spans = this.#spans()
                const kept = this.#keepingPast()
                const bpm = this.#project.timelineBox.bpm.getValue()
                value = runScript(plan.code, this.#env)
                if (this.guarding) {
                    corrections = this.#guard()
                    const tempo = this.#tempoProblem()
                    if (tempo !== null) {throw new Error(tempo)}
                    const moved = this.#loopProblem(loop)
                    if (moved !== null) {throw new Error(moved)}
                    const played = this.#playedProblem(spans)
                    if (played !== null) {throw new Error(played)}
                }
                this.#keepPast(kept)
                this.#tempoOnTimeline(bpm)
            }))
        } catch (error) {
            return this.#status(request, {state: "failed", reason: "invalid_args", detail: errorText(error)})
        } finally {
            this.#params = null
        }
        const touched = this.#touched
        const updates = this.#updates
        this.#touched = null
        if ([...touched.keys()].some(address => this.#held.has(address))) {
            this.#project.editing.undo()
            return this.#status(request, {state: "dropped", reason: "held", detail: "it changed a control you're holding"})
        }
        this.#lastAgentEdit = {label: plan.description, steps: this.#historySteps}
        this.#status(request, {state: "applied",
            result: {ref: "project", label: plan.description, value: serialize(value), updates,
                touched: touchedBetween(before, this.snapshot("full")),
                ...(corrections.length > 0 ? {corrected: corrections.map(({field, from, to}) =>
                    `${field}: ${from} → ${to} (outside its range)`)} : {})}})
    }

    // Inside the script's edit: every field it wrote, brought into openDAW's declared range (Guard.ts), named as a
    // person reads it (the box and the field's path).
    #guard(): Correction[] {
        const touched = this.#touched
        if (touched === null) {return []}
        const corrections: Correction[] = []
        for (const {address, previous} of [...touched.values()]) {
            this.#project.boxGraph.findVertex(address).ifSome(vertex => {
                const correction = guardField(vertex, previous)
                if (correction === null) {return}
                const path = vertex.box.mapFields(field => field.fieldName, ...vertex.address.fieldKeys).join("/")
                corrections.push({...correction, field: `${vertex.box.name} › ${path}`})
            })
        }
        return corrections
    }

    // The project's tempo and every tempo event, against openDAW's TempoRange (in BPM). A tempo event's value is a plain
    // value-event field with no declared range, so the field guard can't catch it: a script that wrote normalized values
    // ((bpm - 60) / 180) set the tempo to 0.33 BPM and the playhead all but stopped for 6 minutes (2026-11-23). Thrown
    // inside the edit, so openDAW rolls the whole script back.
    #loopNow(): { enabled: boolean, from: ppqn, to: ppqn } {
        const {loopArea} = this.#project.timelineBox
        return {enabled: loopArea.enabled.getValue(), from: loopArea.from.getValue(), to: loopArea.to.getValue()}
    }

    // A loop change that leaves the playhead outside the loop would move it (to the loop's start at the next wrap, or on
    // past it): the playhead is the producer's, so the new loop must hold where it is now (decided 2026-11-24).
    #loopProblem(before: { enabled: boolean, from: ppqn, to: ppqn }): string | null {
        const after = this.#loopNow()
        if (!after.enabled || (before.enabled && before.from === after.from && before.to === after.to)) {return null}
        const position = this.#project.engine.position.getValue()
        if (!this.#project.engine.isPlaying.getValue() || (position >= after.from && position < after.to)) {return null}
        return `not applied: the new loop (${this.#pos(after.from)} to ${this.#pos(after.to)}) leaves out the playhead at ${this.#pos(position)}, ` +
            "which would move it; the playhead is the producer's: make the loop include where it is now"
    }

    // Where each region starts and ends, by address: what a script did to the timeline's past (#playedProblem).
    // Read from the boxes: a track's list of region adapters catches up only when the edit ends, so mid-edit it misses a
    // region the script just made (2026-11-25: a part placed at bar 11 while the playhead was at bar 24 got through).
    #spans(): Map<string, { position: ppqn, complete: ppqn }> {
        return new Map(this.#units().flatMap(unit => unit.tracks.values()).flatMap(track => track.box.regions.pointerHub.incoming())
            .map(pointer => pointer.box)
            .filter((box): box is NoteRegionBox | AudioRegionBox => box instanceof NoteRegionBox || box instanceof AudioRegionBox)
            .map(box => [box.address.toString(), {position: box.position.getValue(), complete: box.position.getValue() + box.duration.getValue()}]))
    }

    // With the loop off, the bars already played are the producer's take (2026-11-25: a live jam's new chords and pad
    // were placed from bar 1 while the playhead was at bars 15 and 70, so they were never heard, and a fix lengthened
    // them back over bars already played). A script may not start a region, move one or lengthen one into them; it
    // starts a new region from the next bar line instead. Notes rewritten in place aren't caught here (stages, for now).
    #playedProblem(before: Map<string, { position: ppqn, complete: ppqn }>): string | null {
        const {engine, timelineBox} = this.#project
        if (!engine.isPlaying.getValue() || timelineBox.loopArea.enabled.getValue()) {return null}
        const bar = this.#bar()
        const played = Math.floor(engine.position.getValue() / bar) * bar
        const problems = [...this.#spans()].flatMap(([address, {position, complete}]) => {
            const was = before.get(address)
            if (was === undefined) {
                return position < played ? [`a new region from ${this.#pos(position)} to ${this.#pos(complete)}`] : []
            }
            if (position < was.position && position < played) {return [`a region moved back to ${this.#pos(position)}`]}
            if (complete > was.complete && was.complete < played) {
                return [`a region that ended at ${this.#pos(was.complete)} lengthened to ${this.#pos(complete)}`]
            }
            return []
        })
        if (problems.length === 0) {return null}
        return `not applied: the loop is off and bars before ${this.#pos(played)} are already played (the producer's take); ` +
            `${problems.join("; ")} would reach into them. Start a new region at the next bar line, ` +
            `${this.#pos(played + bar)} (Math.ceil(project.engine.position.getValue() / bar) * bar), running to the song's end`
    }

    // With the loop off, an edit to a part's notes changes only what's still to play (2026-11-25: stages rewrote the
    // notes of regions running from bar 1, so the take replayed only the last stage). Before a script, each region the
    // playhead is inside has its notes copied aside (#keepingPast); after, one whose notes changed is split where the
    // playhead is (the next sixteenth): the bars before keep the copied notes as a new region, the region itself (its
    // ref unchanged) starts there with the new ones, its pattern in phase. An unchanged one's copy is dropped.
    #keepingPast(): Kept[] {
        const {engine, timelineBox} = this.#project
        if (!engine.isPlaying.getValue() || timelineBox.loopArea.enabled.getValue()) {return []}
        const at = Math.ceil(engine.position.getValue() / PPQN.SemiQuaver) * PPQN.SemiQuaver
        return this.#units().flatMap(unit => unit.tracks.values().flatMap(track => track.regions.collection.asArray()))
            .filter((region): region is NoteRegionBoxAdapter => region instanceof NoteRegionBoxAdapter)
            .filter(region => region.position < at && region.complete > at && region.hasCollection)
            .map(region => {
                const collection = region.optCollection.unwrap()
                return {region, saved: collection.copy(), notes: notesOf(collection), at}
            })
    }

    #keepPast(kept: Kept[]): void {
        kept.forEach(({region, saved, notes, at}) => {
            if (!region.box.isAttached() || notesOf(region.optCollection.unwrap()) === notes) {
                saved.box.delete()
                return
            }
            const {position, duration, loopOffset, loopDuration} = region
            const played = at - position
            region.box.position.setValue(at)
            region.box.duration.setValue(duration - played)
            region.box.loopOffset.setValue((loopOffset + played) % loopDuration)
            const past = region.copyTo({position, duration: played, loopOffset, loopDuration})
            past.box.events.refer(saved.box.owners)
        })
    }

    // With the loop off, a tempo set by a script (api.setBpm, a step) is also written to the tempo track where the
    // playhead is, so the take replays it (2026-11-25: a live jam's lofi slowdown, eight steps, replayed at one tempo).
    // A step: the tempo playing now, then the new one, at the same position; later points are dropped (from here, this).
    #tempoOnTimeline(before: number): void {
        const {engine, timelineBox, boxGraph} = this.#project
        const after = timelineBox.bpm.getValue()
        if (after === before || !engine.isPlaying.getValue() || timelineBox.loopArea.enabled.getValue()) {return}
        const {tempoTrack} = timelineBox
        const collection = tempoTrack.events.targetVertex
        if (collection.isEmpty() || !(collection.unwrap().box instanceof ValueEventCollectionBox)) {return}
        const events = (collection.unwrap().box as ValueEventCollectionBox).events
        const points = events.pointerHub.incoming().map(pointer => pointer.box)
            .filter((box): box is ValueEventBox => box instanceof ValueEventBox)
        const automated = tempoTrack.enabled.getValue() && points.length > 0
        const now = automated ? engine.bpm.getValue() : before
        const at = Math.ceil(engine.position.getValue() / PPQN.SemiQuaver) * PPQN.SemiQuaver
        points.filter(point => !automated || point.position.getValue() >= at).forEach(point => point.delete())
        const point = (position: ppqn, value: number, index: number): void => {
            ValueEventBox.create(boxGraph, UUID.generate(), box => {
                box.events.refer(events)
                box.position.setValue(position)
                box.value.setValue(value)
                box.index.setValue(index)
                box.interpolation.setValue(0)
            })
        }
        if (!automated) {point(0, before, 0)}
        point(at, now, 0)
        point(at, after, 1)
        tempoTrack.enabled.setValue(true)
    }

    #tempoAutomated(): boolean {
        const {tempoTrack} = this.#project.timelineBox
        return tempoTrack.enabled.getValue() && tempoTrack.events.targetVertex.mapOr(collection =>
            collection.box instanceof ValueEventCollectionBox && collection.box.events.pointerHub.incoming().length > 0, false)
    }

    #tempoProblem(): string | null {
        const {timelineBox} = this.#project
        const bad = (bpm: number): boolean => !Number.isFinite(bpm) || bpm < TempoRange.min || bpm > TempoRange.max
        const range = `${TempoRange.min} to ${TempoRange.max} BPM`
        if (bad(timelineBox.bpm.getValue())) {return `not applied: the tempo would be ${timelineBox.bpm.getValue()} BPM, outside ${range}`}
        const collection = timelineBox.tempoTrack.events.targetVertex
        if (collection.isEmpty()) {return null}
        const box = collection.unwrap().box
        if (!(box instanceof ValueEventCollectionBox)) {return null}
        const values = box.events.pointerHub.incoming()
            .map(pointer => pointer.box).filter((box): box is ValueEventBox => box instanceof ValueEventBox)
            .map(box => box.value.getValue())
        const out = values.filter(bad)
        return out.length === 0 ? null : `not applied: tempo events are in BPM (${range}), as the project's tempo is, not normalized; ` +
            `this would set ${out.length} to ${out.slice(0, 3).map(value => Math.round(value * 1000) / 1000).join(", ")}`
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
        return this.#units().find(unit => this.#trackRef(unit) === this.#named(ref)) ?? null
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
    // Returns false if a later ramp on the same parameter took over before this one finished.
    async #ramp(request: Apply, parameter: AutomatableParameterFieldAdapter, from: number, to: number,
                beats: number): Promise<boolean> {
        const {editing, engine} = this.#project
        const key = parameter.address.toString()
        this.#ramping.set(key, request.id)
        const mine = (): boolean => this.#ramping.get(key) === request.id
        // While recording, the field is written past openDAW's parameter adapter, so the ramp isn't recorded as automation
        // (2026-11-25: openDAW records every write, one per tick; a loop-off recording's growing automation region hung
        // its engine ~10 bars after the first ramp, `make jam-probe EDITS=ramp`; at one write per 200 ms the agents'
        // parallel long ramps still hung it by bar 25). The take keeps the value as it ends up, not the ramp's shape.
        const write = (value: number): void => {
            this.#applying = {actor: request.from, request: request.id}
            const written = isSwitch(parameter) ? value !== 0 : value
            try {
                editing.modify(() => engine.isRecording.getValue() ? parameter.field.setValue(written) : parameter.setValue(written), false)
            } finally {
                this.#applying = null
            }
        }
        editing.mark()
        const now = (): number => performance.now()
        const startMs = now()
        const durationMs = beats * 60000 / engine.bpm.getValue()
        while (durationMs > 0) {
            if (!mine()) {
                editing.mark()
                return false
            }
            const progress = Math.min(1, (now() - startMs) / durationMs)
            write(from + (to - from) * progress)
            if (progress >= 1 || this.#held.has(key)) {break}
            await this.#clock.tick()
        }
        if (durationMs <= 0) {write(to)}
        editing.mark()
        if (mine()) {this.#ramping.delete(key)}
        return true
    }

    // A parameter set as the producer would (not tagged as an agent's), for tests: false if there's no such ref.
    setAsProducer(ref: string, value: number): boolean {
        const param = this.#allParams().find(candidate => candidate.ref === ref)
        if (param === undefined) {return false}
        this.#project.editing.modify(() => param.parameter.setValue(value))
        return true
    }

    // Requests still waiting for their bar or under way. They outlive a backend restart (2026-11-22: the board keeps the
    // plan, and the backend that comes back is told which are still coming, so it doesn't plan them again).
    waiting(): string[] {return [...this.#labels.keys()]}

    // Reports scheduled and waits for the landing; false (after reporting failed) if it can't land.
    async #land(request: Apply): Promise<boolean> {
        const {engine} = this.#project
        // Taken back by an agent before it landed (BackendToPage "cancel"): dropped, and said so.
        const cancelled = (): boolean => {
            if (!this.#cancelled.delete(request.id)) {return false}
            this.#status(request, {state: "dropped", reason: "cancelled", detail: "cancelled before it landed"})
            return true
        }
        if (cancelled()) {return false}
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
        let last = engine.position.getValue()
        if (landing.after !== undefined) {
            // Played time, counting each pass of the loop.
            let played = 0
            while (engine.isPlaying.getValue() && played < landing.after) {
                await this.#clock.tick()
                if (cancelled()) {return false}
                const position = engine.position.getValue()
                played += this.#advance(last, position)
                last = position
            }
            return true
        }
        // Armed once the playhead is before the landing, or has jumped back (the loop wrapped): in a loop, a landing
        // already passed waits for the next pass, and one on the loop's start lands as the loop wraps.
        let armed = last < landing.at
        while (engine.isPlaying.getValue()) {
            if (cancelled()) {return false}
            const position = engine.position.getValue()
            if (position < landing.at || position < last) {armed = true}
            if (armed && position >= landing.at) {break}
            last = position
            await this.#clock.tick()
        }
        return true
    }

    // The next beat or bar at least LeadMs ahead of the playhead, or a given bar; asap is now (nothing waits for it).
    // A bar with an anchor (from: a plan's steps, decided 2026-11-24) counts bars of playing after the anchor: 1 is the
    // first bar line after it, 2 the next, through every pass of the loop. So a plan's steps land in their order however
    // the loop changes meanwhile (a 4-bar loop widened to 16 mid-plan landed a tempo plan's first steps last, and the
    // tempo went back up). One whose time has gone by lands on the next bar line. Without an anchor, a bar is the
    // timeline's: in a loop, a bar inside it lands the next time the playhead reaches it, a bar past its end counts
    // played bars from the playhead, as if the loop were unrolled; a bar before the loop is refused.
    #landing(request: Apply): Landing {
        const {engine, timelineBox: {loopArea}} = this.#project
        const position = engine.position.getValue()
        const earliest = position + PPQN.secondsToPulses(LeadMs / 1000, engine.bpm.getValue())
        const looping = loopArea.enabled.getValue()
        const [loopFrom, loopTo] = [loopArea.from.getValue(), loopArea.to.getValue()]
        const {when} = request
        if (when.at === "bar" && when.from !== undefined) {
            const bar = this.#bar()
            const offset = (Math.floor(when.from.position / bar) + Math.max(1, when.bar)) * bar - when.from.position
            const due = offset - (this.#played - when.from.played)
            const after = due >= 0 ? due : ((due % bar) + bar) % bar
            const target = position + after
            return {at: looping && loopTo > loopFrom && target >= loopTo ? loopFrom + (target - loopFrom) % (loopTo - loopFrom) : target, after}
        }
        if (when.at === "bar") {
            const at = (when.bar - 1) * this.#bar()
            if (looping && at < loopFrom) {
                return {error: "not_allowed", detail: `bar ${when.bar} is before the loop (${this.#pos(loopFrom)} to ${this.#pos(loopTo)})`}
            }
            if (looping && loopTo > loopFrom && at >= loopTo) {
                const after = at - (position >= loopFrom && position < loopTo ? position : loopFrom)
                const bar = this.#bar()
                return {at: loopFrom + (at - loopFrom) % (loopTo - loopFrom), after: after >= 0 ? after : ((after % bar) + bar) % bar}
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
            const key = update instanceof PrimitiveUpdate ? update.address.toString() : null
            if (update instanceof PrimitiveUpdate && key !== null && !this.#touched.has(key)) {
                this.#touched.set(key, {address: update.address, previous: update.oldValue})
            }
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

    #param(ref: string): Param | null {
        const named = this.#named(ref)
        return this.#allParams().find(param => param.ref === named) ?? null
    }

    // A ref that starts with a track's name ("Chord Bed.mix.volume") as one with its ref (t3.mix.volume): a step staged
    // for a track the same plan creates has no ref yet when it's planned (2026-11-24: a new part's fade-in failed and
    // it stayed at -60 dB). The longest matching name wins; a ref that's already a ref is left alone.
    #named(ref: string): string {
        const unit = this.#units().filter(unit => ref === unit.label || ref.startsWith(`${unit.label}.`))
            .sort((a, b) => b.label.length - a.label.length)[0]
        return unit === undefined || /^(t\d+|master)(\.|$)/.test(ref) ? ref : `${this.#trackRef(unit)}${ref.slice(unit.label.length)}`
    }

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
