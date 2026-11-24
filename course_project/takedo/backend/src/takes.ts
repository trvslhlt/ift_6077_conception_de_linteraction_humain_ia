// Takes (decided 2026-11-24): versions of the project kept under a dial's positions, so moving a dial back to where it
// was recalls that version in one bar instead of rebuilding it (a session's dial move back was 32 edits over 47 s of
// workers). A take is the whole project as the snapshot has it (notes, mix, effects, tempo), kept when a dial is first
// offered (the project before its direction: the dial's other end) and when it next moves with nothing still coming
// (its direction's work, landed, at the position it had). Recalling writes back what differs: notes, tempo, mutes and
// effects switched on or off in one script, values by the page's own set. Parts added since are muted, not deleted,
// so a later take can bring them back. One file per opening of a project, archived with its notebook.
import {existsSync, readFileSync, writeFileSync} from "node:fs"
import type {Device, Snapshot, Track} from "../../shared/protocol.ts"
import {hitOf} from "./generate.ts"

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

// What recalling a take sends: one script (null: nothing for it) and parameter values, each with what it says.
export type Recall = { script: string | null, says: string[], sets: Array<{ ref: string, to: number, says: string }>, missing: string[] }

const differs = (a: number, b: number, by: number): boolean => Number.isFinite(a) && Number.isFinite(b) ? Math.abs(a - b) > by : a !== b

export const recallOf = (take: Snapshot, now: Snapshot): Recall => {
    const lines: string[] = [], says: string[] = [], missing: string[] = []
    const sets: Recall["sets"] = []
    const beatsPerBar = now.timeline.signature[0]
    if (differs(take.timeline.bpm, now.timeline.bpm, 0.5)) {
        lines.push(`project.timelineBox.tempoTrack.enabled.setValue(false); api.setBpm(${take.timeline.bpm})`)
        says.push(`tempo back to ${Math.round(take.timeline.bpm)} BPM`)
    }
    const effects = (name: string, was: ReadonlyArray<Device>, is: ReadonlyArray<Device>, lanes: ReadonlyArray<string>) => {
        is.forEach(effect => {
            if (effect.ref === undefined) {return}
            const kept = was.find(candidate => candidate.ref === effect.ref && candidate.key === effect.key)
            const enabled = kept?.enabled ?? false
            if (enabled !== effect.enabled) {
                lines.push(`ref(${JSON.stringify(effect.ref)}).enabledField.setValue(${enabled})`)
                says.push(`${name}'s ${effect.name} ${enabled ? "back on" : "off"}`)
            }
            if (kept === undefined || !enabled) {return}
            ;(kept.params ?? []).forEach(param => {
                const current = effect.params?.find(candidate => candidate.ref === param.ref)
                if (current === undefined || lanes.includes(param.ref)) {return}
                if (differs(param.value, current.value, Math.max(1e-6, (param.max - param.min) * 0.001))) {
                    sets.push({ref: param.ref, to: param.value, says: `${name}'s ${effect.name} ${param.name} to ${param.display}`})
                }
            })
        })
        was.filter(effect => effect.ref !== undefined && !is.some(candidate => candidate.ref === effect.ref))
            .forEach(effect => missing.push(`${name}'s ${effect.name} (removed since)`))
    }
    const mix = (track: Track, kept: Track | undefined) => {
        const muted = kept === undefined ? true : kept.mix.mute
        if (muted !== track.mix.mute && !track.lanes.includes(`${track.ref}.mix.mute`)) {
            sets.push({ref: `${track.ref}.mix.mute`, to: muted ? 1 : 0, says: `${track.name} ${muted ? "muted" : "back in"}`})
        }
        if (kept === undefined) {return}
        if (differs(kept.mix.volume, track.mix.volume, 0.1) && !track.lanes.includes(`${track.ref}.mix.volume`)) {
            sets.push({ref: `${track.ref}.mix.volume`, to: kept.mix.volume, says: `${track.name} to ${kept.mix.volume.toFixed(1)} dB`})
        }
        if (differs(kept.mix.pan, track.mix.pan, 0.01) && !track.lanes.includes(`${track.ref}.mix.pan`)) {
            sets.push({ref: `${track.ref}.mix.pan`, to: kept.mix.pan, says: `${track.name} panned to ${kept.mix.pan.toFixed(2)}`})
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
                lines.push(`ref(${JSON.stringify(region.ref)}).box.mute.setValue(${muted})`)
                says.push(`${track.name}'s ${region.name} ${muted ? "muted" : "back in"}`)
            }
            if (was?.notes === undefined || region.notes === undefined || JSON.stringify(was.notes) === JSON.stringify(region.notes)) {return}
            notes = true
            lines.push(`notes(${JSON.stringify(region.ref)}, ${JSON.stringify(was.notes.map(note => hitOf(note, beatsPerBar)))})`)
            says.push(`${track.name}'s notes as they were`)
        })
        kept.regions.filter(region => !track.regions.some(candidate => candidate.ref === region.ref))
            .forEach(region => missing.push(`${track.name}'s ${region.name} (deleted since)`))
    })
    take.tracks.filter(track => !now.tracks.some(candidate => candidate.ref === track.ref))
        .forEach(track => missing.push(`${track.name} (deleted since)`))
    if (differs(take.master.volume, now.master.volume, 0.1)) {
        sets.push({ref: "master.mix.volume", to: take.master.volume, says: `master to ${take.master.volume.toFixed(1)} dB`})
    }
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
    return {script: lines.length === 0 ? null : `${notes ? helper : ""}${lines.join("\n")}`, says, sets, missing}
}
