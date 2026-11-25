// Takes (decided 2026-11-24): versions of the project kept under a dial's positions, so moving a dial back to where it
// was recalls that version in one bar instead of rebuilding it (a session's dial move back was 32 edits over 47 s of
// workers). A take is the whole project as the snapshot has it (notes, mix, effects, tempo), kept when a dial is first
// offered (the project before its direction: the dial's other end) and when it next moves with nothing still coming
// (its direction's work, landed, at the position it had). Recalling writes back what differs: notes, tempo, mutes and
// effects switched on or off in one script, values by the page's own set. Parts added since are muted, not deleted,
// so a later take can bring them back. One file per opening of a project, archived with its notebook.
import {existsSync, readFileSync, writeFileSync} from "node:fs"
import type {Device, Snapshot, Track} from "../../shared/protocol.ts"
import {hitOf, morphNotes} from "./generate.ts"
import {type Entry, ownedBy} from "./ledger.ts"

export type Take = { id: string, control: string, value: number, t: number, label: string, snapshot: Snapshot }

// Takes kept per dial: the oldest go first. Positions this close count as the same take (the newer replaces it).
const PerControl = 6
const Same = 0.05

export class Takes {
    readonly #file: string | null
    #takes: Take[] = []
    #next = 1

    constructor(file: string | null) {
        this.#file = file
        if (file === null || !existsSync(file)) {return}
        try {
            const stored = JSON.parse(readFileSync(file, "utf8")) as { takes: Take[], next: number }
            this.#takes = stored.takes
            this.#next = stored.next
        } catch {/* unreadable: start empty */}
    }

    keep(control: string, value: number, label: string, snapshot: Snapshot): Take {
        const take: Take = {id: `k${this.#next++}`, control, value, t: Date.now(), label, snapshot}
        const others = this.#takes.filter(kept => kept.control !== control)
        const own = this.#takes.filter(kept => kept.control === control && Math.abs(kept.value - value) > Same)
        this.#takes = [...others, ...own.slice(-(PerControl - 1)), take]
        this.#save()
        return take
    }

    get(id: string): Take | null {return this.#takes.find(take => take.id === id) ?? null}

    // A dial's two ends (blend.ts): its lowest and highest takes, when they're apart. A move between them is worked
    // out by code; one past them is the Team Lead's to build (and its work, landed, widens the span).
    ends(control: string): { lo: Take, hi: Take } | null {
        const own = this.#takes.filter(take => take.control === control).sort((a, b) => a.value - b.value)
        if (own.length < 2 || own.at(-1)!.value - own[0].value < 0.1) {return null}
        return {lo: own[0], hi: own.at(-1)!}
    }

    // For the Team Lead, per dial: "k2: 0.90, after its direction's work landed (07:36)".
    lines(): string[] {
        return this.#takes.map(take => `${take.id}: ${take.control} at ${take.value.toFixed(2)}, ${take.label} (${new Date(take.t).toISOString().slice(11, 16)})`)
    }

    #save(): void {
        if (this.#file !== null) {writeFileSync(this.#file, JSON.stringify({takes: this.#takes, next: this.#next}))}
    }
}

// Recalling glides over this many bars (decided 2026-11-24: on one bar line, a dial moved to its end changed the whole
// track at once, where a move between rebuilt it gradually). Notes move a stage a bar (morphNotes), the tempo a step a
// bar, values ramp across the span; parts leaving fade out and are muted at its end, parts coming back are unmuted at
// silence first and fade in; effects come back on at its start and go off at its end.
export const RecallBars = 4
const Silence = -60

// What recalling a take sends, each timed in bars of playing from the recall (1: the next bar line): scripts (notes,
// tempo, switches) and values (a ramp, or a set when beats is 0); first: values set at once, before (a returning part's
// level to silence while it's still muted).
export type Recall = {
    scripts: Array<{ bar: number, code: string, says: string }>
    values: Array<{ ref: string, to: number, beats: number, bar: number, says: string }>
    first: Array<{ ref: string, to: number }>
    missing: string[]
    conflicts: string[]     // notes another direction changed too since the take: left as they are, for a worker
}

// What a recall may bring back (decided 2026-11-24, ARCHITECTURE.md "Ownership"): only what the dial's own directions
// changed since the take (keys as ledger.ts ownedBy names them: "value t1.mix.volume", "notes t1", "track t3", "tempo").
// A number another direction changed too comes back as the take's value plus their changes since (max A, max B, min A:
// B's +2 dB stays); notes another direction changed too are left, a conflict for the Team Lead to hand a worker; what
// only others changed (another dial, a later message, the producer's hand) is left alone.
export type Scope = {
    owns(key: string): boolean
    value(key: string, take: number): number
    shared(key: string): boolean
}
export const everything: Scope = {owns: () => true, value: (_key, take) => take, shared: () => false}

export const scopeOf = (take: Take, entries: ReadonlyArray<Entry>, mine: ReadonlyArray<string>): Scope => {
    const since = entries.filter(entry => entry.t > take.t)
    const own = since.filter(entry => mine.includes(entry.direction)), others = since.filter(entry => !mine.includes(entry.direction))
    const byMe = ownedBy(own), byOthers = ownedBy(others)
    const delta = new Map<string, number>()
    const add = (key: string, by: number) => delta.set(key, (delta.get(key) ?? 0) + by)
    others.forEach(({touched}) => {
        touched.values.forEach(({ref, from, to}) => add(`value ${ref}`, to - from))
        if (touched.tempo !== undefined) {add("tempo", touched.tempo.to - touched.tempo.from)}
    })
    return {owns: key => byMe.has(key), value: (key, value) => value + (delta.get(key) ?? 0), shared: key => byOthers.has(key)}
}

const differs = (a: number, b: number, by: number): boolean => Number.isFinite(a) && Number.isFinite(b) ? Math.abs(a - b) > by : a !== b

export const recallOf = (take: Snapshot, now: Snapshot, scope: Scope = everything): Recall => {
    const beatsPerBar = now.timeline.signature[0]
    // Mutes and switches-off a bar after the span: a ramp can start a little after its bar line, so its fade ends late.
    const span = RecallBars * beatsPerBar, end = RecallBars + 2
    const lines = new Map<number, { code: string[], says: string[] }>()
    const line = (bar: number, code: string, says: string) => {
        const at = lines.get(bar) ?? {code: [], says: []}
        at.code.push(code)
        if (says !== "") {at.says.push(says)}
        lines.set(bar, at)
    }
    const values: Recall["values"] = [], first: Recall["first"] = [], missing: string[] = [], conflicts: string[] = []
    // A mute is a switch, not a number: brought back only when no other direction changed it too.
    const mutes = (ref: string) => scope.owns(`value ${ref}.mix.mute`) && !scope.shared(`value ${ref}.mix.mute`)
    const ramp = (ref: string, to: number, says: string, beats = span, bar = 1) => values.push({ref, to, beats, bar, says})
    const tempo = scope.value("tempo", take.timeline.bpm)
    if (scope.owns("tempo") && differs(tempo, now.timeline.bpm, 0.5)) {
        for (let stage = 1; stage <= RecallBars; stage++) {
            const bpm = Math.round((now.timeline.bpm + (tempo - now.timeline.bpm) * stage / RecallBars) * 10) / 10
            line(stage, `project.timelineBox.tempoTrack.enabled.setValue(false); api.setBpm(${bpm})`,
                stage === RecallBars ? `tempo back to ${Math.round(tempo)} BPM` : "")
        }
    }
    const effects = (name: string, was: ReadonlyArray<Device>, is: ReadonlyArray<Device>, lanes: ReadonlyArray<string>) => {
        is.forEach(effect => {
            if (effect.ref === undefined) {return}
            const kept = was.find(candidate => candidate.ref === effect.ref && candidate.key === effect.key)
            const enabled = kept?.enabled ?? false
            if (enabled !== effect.enabled && scope.owns(kept === undefined ? `effect ${effect.ref}` : `switch ${effect.ref}`)) {
                line(enabled ? 1 : end, `ref(${JSON.stringify(effect.ref)}).enabledField.setValue(${enabled})`,
                    `${name}'s ${effect.name} ${enabled ? "back on" : "off"}`)
            }
            if (kept === undefined || !enabled) {return}
            ;(kept.params ?? []).forEach(param => {
                const current = effect.params?.find(candidate => candidate.ref === param.ref)
                if (current === undefined || lanes.includes(param.ref) || !scope.owns(`value ${param.ref}`)) {return}
                const to = Math.min(param.max, Math.max(param.min, scope.value(`value ${param.ref}`, param.value)))
                if (differs(to, current.value, Math.max(1e-6, (param.max - param.min) * 0.001))) {
                    ramp(param.ref, to, `${name}'s ${effect.name} ${param.name} back`, param.stepped ? 0 : span)
                }
            })
        })
        was.filter(effect => effect.ref !== undefined && !is.some(candidate => candidate.ref === effect.ref))
            .forEach(effect => missing.push(`${name}'s ${effect.name} (removed since)`))
    }
    // Parking a part (decided 2026-11-24, make park-bench): muted, with its instrument and effects disabled, which takes
    // them out of the engine's chain. Muting alone saved nothing (the chain still runs: 0.55 vs 0.58 ms a block for 16
    // synth+reverb tracks); disabled, 0.21 ms. Notes and settings stay, so the part can come back as it was.
    const instrument = (track: Track, on: boolean) => `ref(${JSON.stringify(track.ref)}).inputAdapter.ifSome(input => input.box.enabled.setValue(${on}))`
    // Returns whether the part leaves (parked at the span's end).
    const mix = (track: Track, kept: Track | undefined): boolean => {
        const free = (control: string) => !track.lanes.includes(`${track.ref}.mix.${control}`)
        const muted = kept === undefined ? true : kept.mix.mute
        const leaves = kept === undefined ? scope.owns(`track ${track.ref}`) : mutes(track.ref)
        if (muted && !track.mix.mute && free("mute") && leaves) {
            // Leaving: faded out over the span, then muted and its devices disabled.
            if (free("volume")) {ramp(`${track.ref}.mix.volume`, Silence, "")}
            values.push({ref: `${track.ref}.mix.mute`, to: 1, beats: 0, bar: end, says: `${track.name} faded out`})
            line(end, [instrument(track, false), ...track.effects.filter(effect => effect.enabled && effect.ref !== undefined)
                .map(effect => `ref(${JSON.stringify(effect.ref)}).enabledField.setValue(false)`)].join("; "), "")
            return true
        }
        if (kept === undefined) {return false}
        const playing = kept.device?.enabled ?? true
        if (track.device !== null && track.device.enabled !== playing && scope.owns(`switch ${track.ref}`)) {line(playing ? 1 : end, instrument(track, playing), "")}
        const volume = scope.owns(`value ${track.ref}.mix.volume`) ? Math.min(6, Math.max(Silence, scope.value(`value ${track.ref}.mix.volume`, kept.mix.volume))) : null
        if (!muted && track.mix.mute && free("mute") && mutes(track.ref)) {
            // Coming back: silent while still muted, unmuted on the first bar line, then faded in.
            // (Faded in only when its level is the dial's to bring back; otherwise just unmuted, at the level it has.)
            const fades = free("volume") && volume !== null
            if (fades) {first.push({ref: `${track.ref}.mix.volume`, to: Silence})}
            values.push({ref: `${track.ref}.mix.mute`, to: 0, beats: 0, bar: 1, says: fades ? "" : `${track.name} back in`})
            if (fades) {ramp(`${track.ref}.mix.volume`, volume, `${track.name} faded back in`)}
        } else if (volume !== null && differs(volume, track.mix.volume, 0.1) && free("volume")) {
            ramp(`${track.ref}.mix.volume`, volume, `${track.name} to ${volume.toFixed(1)} dB`)
        }
        const pan = scope.owns(`value ${track.ref}.mix.pan`) ? Math.min(1, Math.max(-1, scope.value(`value ${track.ref}.mix.pan`, kept.mix.pan))) : null
        if (pan !== null && differs(pan, track.mix.pan, 0.01) && free("pan")) {
            ramp(`${track.ref}.mix.pan`, pan, `${track.name} panned to ${pan.toFixed(2)}`)
        }
        return false
    }
    let notes = false
    now.tracks.forEach(track => {
        const kept = take.tracks.find(candidate => candidate.ref === track.ref)
        const leaving = mix(track, kept)
        if (kept === undefined) {return}
        if (!leaving) {effects(track.name, kept.effects, track.effects, track.lanes)}
        track.regions.forEach(region => {
            const was = kept.regions.find(candidate => candidate.ref === region.ref)
            const muted = was?.muted ?? true
            if (muted !== region.muted && scope.owns(`regions ${track.ref}`)) {
                line(muted ? end : 1, `ref(${JSON.stringify(region.ref)}).box.mute.setValue(${muted})`,
                    `${track.name}'s ${region.name} ${muted ? "muted" : "back in"}`)
            }
            if (was?.notes === undefined || region.notes === undefined || JSON.stringify(was.notes) === JSON.stringify(region.notes)) {return}
            if (!scope.owns(`notes ${track.ref}`)) {return}
            if (scope.shared(`notes ${track.ref}`)) {
                if (!conflicts.includes(`${track.name} (${track.ref})`)) {conflicts.push(`${track.name} (${track.ref})`)}
                return
            }
            notes = true
            morphNotes(region.notes.map(note => hitOf(note, beatsPerBar)), was.notes.map(note => hitOf(note, beatsPerBar)), RecallBars)
                .forEach((stage, index) => line(index + 1, `notes(${JSON.stringify(region.ref)}, ${JSON.stringify(stage)})`,
                    index === RecallBars - 1 ? `${track.name}'s notes as they were` : ""))
        })
        kept.regions.filter(region => !track.regions.some(candidate => candidate.ref === region.ref))
            .forEach(region => missing.push(`${track.name}'s ${region.name} (deleted since)`))
    })
    take.tracks.filter(track => !now.tracks.some(candidate => candidate.ref === track.ref))
        .forEach(track => missing.push(`${track.name} (deleted since)`))
    const master = scope.value("value master.mix.volume", take.master.volume)
    if (scope.owns("value master.mix.volume") && differs(master, now.master.volume, 0.1)) {ramp("master.mix.volume", master, `master to ${master.toFixed(1)} dB`)}
    effects("the master", take.master.effects, now.master.effects, [])
    // A region's notes rewritten in place, as kb.replaceNotes does: [beat, pitch, beats long, velocity 0..1].
    const helper = `const beat = ppqn("1.2.1") - ppqn("1.1.1")
const notes = (at, hits) => {
    const region = ref(at)
    if (region === null || region === undefined || region.optCollection === undefined) {throw new Error("no notes region " + at)}
    region.optCollection.unwrap(at + " has no notes").events.asArray().slice().forEach(event => event.box.delete())
    hits.forEach(([start, pitch, length, velocity]) => api.createNoteEvent({owner: region.box,
        position: Math.round(start * beat), duration: Math.max(1, Math.round(length * beat)), pitch, velocity}))
}
`
    const scripts = [...lines].sort(([a], [b]) => a - b).map(([bar, {code, says}]) =>
        ({bar, code: `${notes ? helper : ""}${code.join("\n")}`, says: says.join(", ")}))
    return {scripts, values, first, missing, conflicts}
}
