// What one edit changed, in the snapshot's terms (decided 2026-11-24, ARCHITECTURE.md "Ownership"): the page compares
// the project just before and just after an agent's script, so the backend can record what each activity owns (a
// dial's directions, later a row of the activity to roll back) with the values it replaced. Fixed operations say
// what they changed in their result already (a value's from and to, an effect added or removed).
import type {Device, Snapshot, Track} from "./protocol.ts"

export type Touched = {
    values: Array<{ ref: string, from: number, to: number }>        // mix (volume dB, pan, mute 0/1) and effect parameters
    notes: Array<{ region: string, track: string }>                 // regions whose notes changed
    regions: Array<{ ref: string, track: string, change: "added" | "removed" | "moved" | "muted" | "unmuted" }>
    tracks: Array<{ ref: string, change: "added" | "removed" }>
    effects: Array<{ ref: string, change: "added" | "removed" }>
    switches: Array<{ ref: string, from: boolean, to: boolean }>    // instruments (a track's ref) and effects on or off
    tempo?: { from: number, to: number }
    loop?: { from: Snapshot["playback"]["loop"], to: Snapshot["playback"]["loop"] }
}

export const nothingTouched = (touched: Touched): boolean => touched.values.length === 0 && touched.notes.length === 0 &&
    touched.regions.length === 0 && touched.tracks.length === 0 && touched.effects.length === 0 &&
    touched.switches.length === 0 && touched.tempo === undefined && touched.loop === undefined

const same = (a: number, b: number): boolean => a === b || (Number.isNaN(a) && Number.isNaN(b)) || Math.abs(a - b) < 1e-9

export const touchedBetween = (before: Snapshot, after: Snapshot): Touched => {
    const touched: Touched = {values: [], notes: [], regions: [], tracks: [], effects: [], switches: []}
    const value = (ref: string, from: number, to: number) => {if (!same(from, to)) {touched.values.push({ref, from, to})}}
    const devices = (was: ReadonlyArray<Device>, is: ReadonlyArray<Device>) => {
        is.forEach(effect => {
            if (effect.ref === undefined) {return}
            const old = was.find(candidate => candidate.ref === effect.ref)
            if (old === undefined) {
                touched.effects.push({ref: effect.ref, change: "added"})
                return
            }
            if (old.enabled !== effect.enabled) {touched.switches.push({ref: effect.ref, from: old.enabled, to: effect.enabled})}
            ;(effect.params ?? []).forEach(param => {
                const previous = old.params?.find(candidate => candidate.ref === param.ref)
                if (previous !== undefined) {value(param.ref, previous.value, param.value)}
            })
        })
        was.filter(effect => effect.ref !== undefined && !is.some(candidate => candidate.ref === effect.ref))
            .forEach(effect => touched.effects.push({ref: effect.ref!, change: "removed"}))
    }
    const track = (was: Track | undefined, is: Track) => {
        if (was === undefined) {
            touched.tracks.push({ref: is.ref, change: "added"})
            is.effects.forEach(effect => {if (effect.ref !== undefined) {touched.effects.push({ref: effect.ref, change: "added"})}})
            is.regions.forEach(region => touched.regions.push({ref: region.ref, track: is.ref, change: "added"}))
            return
        }
        value(`${is.ref}.mix.volume`, was.mix.volume, is.mix.volume)
        value(`${is.ref}.mix.pan`, was.mix.pan, is.mix.pan)
        value(`${is.ref}.mix.mute`, was.mix.mute ? 1 : 0, is.mix.mute ? 1 : 0)
        if (was.device !== null && is.device !== null && was.device.enabled !== is.device.enabled) {
            touched.switches.push({ref: is.ref, from: was.device.enabled, to: is.device.enabled})
        }
        devices(was.effects, is.effects)
        is.regions.forEach(region => {
            const old = was.regions.find(candidate => candidate.ref === region.ref)
            if (old === undefined) {
                touched.regions.push({ref: region.ref, track: is.ref, change: "added"})
                return
            }
            if (old.from !== region.from || old.to !== region.to || old.loop !== region.loop) {
                touched.regions.push({ref: region.ref, track: is.ref, change: "moved"})
            }
            if (old.muted !== region.muted) {touched.regions.push({ref: region.ref, track: is.ref, change: region.muted ? "muted" : "unmuted"})}
            if (JSON.stringify(old.notes ?? []) !== JSON.stringify(region.notes ?? [])) {touched.notes.push({region: region.ref, track: is.ref})}
        })
        was.regions.filter(region => !is.regions.some(candidate => candidate.ref === region.ref))
            .forEach(region => touched.regions.push({ref: region.ref, track: is.ref, change: "removed"}))
    }
    after.tracks.forEach(is => track(before.tracks.find(was => was.ref === is.ref), is))
    before.tracks.filter(was => !after.tracks.some(is => is.ref === was.ref))
        .forEach(was => touched.tracks.push({ref: was.ref, change: "removed"}))
    value("master.mix.volume", before.master.volume, after.master.volume)
    devices(before.master.effects, after.master.effects)
    if (!same(before.timeline.bpm, after.timeline.bpm)) {touched.tempo = {from: before.timeline.bpm, to: after.timeline.bpm}}
    const [was, is] = [before.playback.loop, after.playback.loop]
    if (was.on !== is.on || was.from !== is.from || was.to !== is.to) {touched.loop = {from: was, to: is}}
    return touched
}
