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
}

const differs = (a: number, b: number, by: number): boolean => Number.isFinite(a) && Number.isFinite(b) ? Math.abs(a - b) > by : a !== b

export const recallOf = (take: Snapshot, now: Snapshot): Recall => {
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
    const values: Recall["values"] = [], first: Recall["first"] = [], missing: string[] = []
    const ramp = (ref: string, to: number, says: string, beats = span, bar = 1) => values.push({ref, to, beats, bar, says})
    if (differs(take.timeline.bpm, now.timeline.bpm, 0.5)) {
        for (let stage = 1; stage <= RecallBars; stage++) {
            const bpm = Math.round((now.timeline.bpm + (take.timeline.bpm - now.timeline.bpm) * stage / RecallBars) * 10) / 10
            line(stage, `project.timelineBox.tempoTrack.enabled.setValue(false); api.setBpm(${bpm})`,
                stage === RecallBars ? `tempo back to ${Math.round(take.timeline.bpm)} BPM` : "")
        }
    }
    const effects = (name: string, was: ReadonlyArray<Device>, is: ReadonlyArray<Device>, lanes: ReadonlyArray<string>) => {
        is.forEach(effect => {
            if (effect.ref === undefined) {return}
            const kept = was.find(candidate => candidate.ref === effect.ref && candidate.key === effect.key)
            const enabled = kept?.enabled ?? false
            if (enabled !== effect.enabled) {
                line(enabled ? 1 : end, `ref(${JSON.stringify(effect.ref)}).enabledField.setValue(${enabled})`,
                    `${name}'s ${effect.name} ${enabled ? "back on" : "off"}`)
            }
            if (kept === undefined || !enabled) {return}
            ;(kept.params ?? []).forEach(param => {
                const current = effect.params?.find(candidate => candidate.ref === param.ref)
                if (current === undefined || lanes.includes(param.ref)) {return}
                if (differs(param.value, current.value, Math.max(1e-6, (param.max - param.min) * 0.001))) {
                    ramp(param.ref, param.value, `${name}'s ${effect.name} ${param.name} to ${param.display}`, param.stepped ? 0 : span)
                }
            })
        })
        was.filter(effect => effect.ref !== undefined && !is.some(candidate => candidate.ref === effect.ref))
            .forEach(effect => missing.push(`${name}'s ${effect.name} (removed since)`))
    }
    const mix = (track: Track, kept: Track | undefined) => {
        const free = (control: string) => !track.lanes.includes(`${track.ref}.mix.${control}`)
        const muted = kept === undefined ? true : kept.mix.mute
        if (muted && !track.mix.mute && free("mute")) {
            // Leaving: faded out over the span, then muted.
            if (free("volume")) {ramp(`${track.ref}.mix.volume`, Silence, "")}
            values.push({ref: `${track.ref}.mix.mute`, to: 1, beats: 0, bar: end, says: `${track.name} faded out`})
            return
        }
        if (kept === undefined) {return}
        if (!muted && track.mix.mute && free("mute")) {
            // Coming back: silent while still muted, unmuted on the first bar line, then faded in.
            if (free("volume")) {first.push({ref: `${track.ref}.mix.volume`, to: Silence})}
            values.push({ref: `${track.ref}.mix.mute`, to: 0, beats: 0, bar: 1, says: ""})
            if (free("volume")) {ramp(`${track.ref}.mix.volume`, kept.mix.volume, `${track.name} faded back in`)}
        } else if (differs(kept.mix.volume, track.mix.volume, 0.1) && free("volume")) {
            ramp(`${track.ref}.mix.volume`, kept.mix.volume, `${track.name} to ${kept.mix.volume.toFixed(1)} dB`)
        }
        if (differs(kept.mix.pan, track.mix.pan, 0.01) && free("pan")) {
            ramp(`${track.ref}.mix.pan`, kept.mix.pan, `${track.name} panned to ${kept.mix.pan.toFixed(2)}`)
        }
    }
    let notes = false
    now.tracks.forEach(track => {
        const kept = take.tracks.find(candidate => candidate.ref === track.ref)
        mix(track, kept)
        if (kept === undefined) {return}
        effects(track.name, kept.effects, track.effects, track.lanes)
        track.regions.forEach(region => {
            const was = kept.regions.find(candidate => candidate.ref === region.ref)
            const muted = was?.muted ?? true
            if (muted !== region.muted) {
                line(muted ? end : 1, `ref(${JSON.stringify(region.ref)}).box.mute.setValue(${muted})`,
                    `${track.name}'s ${region.name} ${muted ? "muted" : "back in"}`)
            }
            if (was?.notes === undefined || region.notes === undefined || JSON.stringify(was.notes) === JSON.stringify(region.notes)) {return}
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
    if (differs(take.master.volume, now.master.volume, 0.1)) {ramp("master.mix.volume", take.master.volume, `master to ${take.master.volume.toFixed(1)} dB`)}
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
    return {scripts, values, first, missing}
}
