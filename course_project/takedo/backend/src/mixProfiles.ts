import type {Snapshot, Track} from "../../shared/protocol.ts"
import {isDrums} from "./analysis.ts"
import {type Return, Returns, type Step} from "./members.ts"

// Style mix profiles (2026-11-25, the producer: effects, sends and panning do a lot of the work of making something
// sound like a style). Per style: each part's place by its role (pan, how much it sends into the shared reverb and
// delay) and the character of those two returns. Applied by code, every change gliding over a bar or two; the Team
// Lead names the style, code applies it once the direction's parts are in (coordinator.ts, styleMix).

export type Role = "drums" | "perc" | "bass" | "chords" | "pad" | "lead" | "other"
type Place = { pan: number, reverb: number, delay: number }  // pan -1..1, sends in dB (-60: none)
type ReturnSettings = Array<{ param: string, value: number }>
export type Profile = { summary: string, reverb: ReturnSettings, delay: ReturnSettings, roles: Record<Role, Place> }

const None = -60
// The Delay's time is an index into openDAW's fractions (DelayDeviceBoxAdapter.Fractions): 11 1/8, 13 3/16, 14 1/4.
const Eighth = 11, DottedEighth = 13, Quarter = 14
const reverb = (decay: number, damping: number, preDelay: number): ReturnSettings =>
    [{param: "decay", value: decay}, {param: "damping", value: damping}, {param: "preDelay", value: preDelay}]
const delay = (time: number, feedback: number, filter: number): ReturnSettings =>
    [{param: "delayMusical", value: time}, {param: "feedback", value: feedback}, {param: "filter", value: filter}]
const place = (pan: number, reverbDb: number, delayDb: number): Place => ({pan, reverb: reverbDb, delay: delayDb})

export const Profiles: Record<string, Profile> = {
    trap: {summary: "dry, hard drums and 808 in the centre; the lead and keys in a dark reverb with an eighth-note echo",
        reverb: reverb(0.6, 0.5, 10), delay: delay(Eighth, 0.3, -0.3),
        roles: {drums: place(0, -32, None), perc: place(0.35, -24, None), bass: place(0, None, None), chords: place(-0.2, -14, -22),
            pad: place(0, -12, None), lead: place(0.1, -14, -16), other: place(0, -20, None)}},
    lofi: {summary: "everything in one dark, soft room; keys warm and a little wide, a lazy dotted echo on the melody",
        reverb: reverb(0.55, 0.75, 15), delay: delay(DottedEighth, 0.35, -0.6),
        roles: {drums: place(0, -22, None), perc: place(-0.3, -20, None), bass: place(0, -36, None), chords: place(-0.15, -14, -26),
            pad: place(0.15, -12, None), lead: place(0.15, -16, -18), other: place(0, -18, None)}},
    boombap: {summary: "a short room on the drums, keys and samples a little wide, the bass dry",
        reverb: reverb(0.45, 0.6, 5), delay: delay(Quarter, 0.25, -0.4),
        roles: {drums: place(0, -20, None), perc: place(0.3, -20, None), bass: place(0, None, None), chords: place(-0.2, -18, None),
            pad: place(0.2, -16, None), lead: place(0.15, -18, -24), other: place(0, -20, None)}},
    house: {summary: "dry, punchy drums; chords and stabs in a bright room with a dotted echo; pads wide and wet",
        reverb: reverb(0.7, 0.25, 20), delay: delay(DottedEighth, 0.4, 0),
        roles: {drums: place(0, -30, None), perc: place(0.4, -22, -28), bass: place(0, None, None), chords: place(-0.2, -14, -18),
            pad: place(0.2, -10, None), lead: place(0.15, -14, -16), other: place(0, -18, None)}},
    techno: {summary: "a big dark space, synths in a dotted echo, drums dry and centred",
        reverb: reverb(0.85, 0.5, 25), delay: delay(DottedEighth, 0.5, -0.2),
        roles: {drums: place(0, -28, None), perc: place(0.45, -18, -22), bass: place(0, None, None), chords: place(-0.25, -12, -14),
            pad: place(0.2, -8, -20), lead: place(0.1, -12, -12), other: place(0, -16, -24)}},
    synthwave: {summary: "big 80s reverb on the drums, leads in a long echo, chords wide",
        reverb: reverb(0.8, 0.2, 15), delay: delay(DottedEighth, 0.45, 0),
        roles: {drums: place(0, -16, None), perc: place(0.35, -16, None), bass: place(0, None, None), chords: place(-0.3, -12, -22),
            pad: place(0.3, -10, None), lead: place(0, -12, -12), other: place(0, -16, None)}},
    ambient: {summary: "everything far away in a long, soft reverb, the melody in a long echo",
        reverb: reverb(0.92, 0.5, 40), delay: delay(Quarter, 0.55, -0.4),
        roles: {drums: place(0, -14, -24), perc: place(0.4, -10, -20), bass: place(0, -24, None), chords: place(-0.25, -8, -18),
            pad: place(0.25, -6, -20), lead: place(0.1, -8, -12), other: place(0, -10, -20)}},
    dnb: {summary: "tight dry drums, the bass centred and dry, pads and leads wide in a big space",
        reverb: reverb(0.75, 0.35, 15), delay: delay(DottedEighth, 0.4, -0.2),
        roles: {drums: place(0, -28, None), perc: place(0.4, -20, None), bass: place(0, None, None), chords: place(-0.25, -14, -20),
            pad: place(0.25, -8, None), lead: place(0.1, -12, -14), other: place(0, -18, None)}},
    pop: {summary: "clean and wide: a bright plate-like room, the vocal-like lead centred with a quarter echo",
        reverb: reverb(0.65, 0.2, 20), delay: delay(Quarter, 0.3, 0),
        roles: {drums: place(0, -26, None), perc: place(0.35, -22, None), bass: place(0, None, None), chords: place(-0.25, -16, None),
            pad: place(0.25, -12, None), lead: place(0, -14, -20), other: place(0, -18, None)}},
    jazz: {summary: "a natural room, the band spread as on a stage, nothing echoing",
        reverb: reverb(0.6, 0.45, 10), delay: delay(Quarter, 0.2, -0.4),
        roles: {drums: place(0.15, -20, None), perc: place(0.4, -18, None), bass: place(-0.1, -30, None), chords: place(-0.3, -16, None),
            pad: place(0.3, -14, None), lead: place(0.2, -16, None), other: place(0, -18, None)}},
}
export const Styles = Object.keys(Profiles)

// A track's role from what it plays, then its name: a kit is drums (a sparse one of shakers or congas is perc), notes
// in the bass register a bass, several at once chords (a pad if they're long), one at a time a lead.
export const roleOf = (track: Track): Role => {
    const name = track.name.toLowerCase()
    // A General MIDI kit on a soundfont has no pads to read: its name says it (restyle.ts names tracks after their sound).
    if (isDrums(track) || /\bkit\b|drum/.test(name)) {return /perc|shaker|conga|bongo|tamb|cabasa/.test(name) ? "perc" : "drums"}
    const notes = track.regions.flatMap(region => region.notes ?? [])
    if (/bass|808|sub/.test(name)) {return "bass"}
    if (/pad|string|choir|atmos/.test(name)) {return "pad"}
    if (notes.length === 0) {return /lead|melod|bell|pluck|hook/.test(name) ? "lead" : /chord|key|piano|rhodes|organ|ep\b/.test(name) ? "chords" : "other"}
    if (Math.max(...notes.map(([, pitch]) => pitch)) < 60) {return "bass"}
    const starts = new Map<string, number>()
    notes.forEach(([pos]) => starts.set(pos, (starts.get(pos) ?? 0) + 1))
    const stacked = [...starts.values()].filter(count => count >= 3).length / starts.size
    if (stacked >= 0.5) {return notes.reduce((sum, [, , sixteenths]) => sum + sixteenths, 0) / notes.length >= 8 ? "pad" : "chords"}
    return /chord|key|piano|rhodes|organ/.test(name) ? "chords" : "lead"
}

const dbText = (value: number): string => value <= None ? "none" : `${value} dB`
const panText = (pan: number): string => pan === 0 ? "centre" : `${Math.round(Math.abs(pan) * 100)}% ${pan < 0 ? "left" : "right"}`

// The steps a profile takes on the project as it is: each part playing (not muted, not a return) to its place, its pan
// and sends gliding over Glide beats; a return already there moves to the profile's character, one not yet there is made
// with it. Two parts of one role are spread to either side of its place.
export const Glide = 8
export const styleSteps = (style: string, snapshot: Snapshot): { steps: Step[], says: string } | string => {
    const profile = Profiles[style]
    if (profile === undefined) {return `no mix profile for ${style}; there are ${Styles.join(", ")}`}
    const parts = snapshot.tracks.filter(track => track.kind !== "bus" && !track.mix.mute)
    const roles = new Map(parts.map(track => [track.ref, roleOf(track)]))
    const seen = new Map<Role, number>()
    const settingsOf = (bus: Return): ReturnSettings => bus === "Reverb" ? profile.reverb : profile.delay
    const returns = new Map((Object.keys(Returns) as Return[]).map(bus => [bus, snapshot.tracks.find(track => track.kind === "bus" && track.name === bus)]))
    const steps: Step[] = []
    const when = {at: "next" as const, unit: "bar" as const}
    for (const track of parts) {
        const role = roles.get(track.ref)!, base = profile.roles[role]
        const nth = seen.get(role) ?? 0
        seen.set(role, nth + 1)
        const twin = parts.filter(other => roles.get(other.ref) === role).length > 1
        const pan = Math.max(-1, Math.min(1, twin ? (nth % 2 === 0 ? -1 : 1) * Math.max(Math.abs(base.pan), 0.25) : base.pan))
        if (Math.abs(track.mix.pan - pan) > 0.02) {
            steps.push({plan: {op: "ramp", ref: `${track.ref}.mix.pan`, to: pan, beats: Glide}, when, says: `${track.name} (${role}) panned ${panText(pan)}`})
        }
        for (const [bus, level] of [["Reverb", base.reverb], ["Delay", base.delay]] as Array<[Return, number]>) {
            const sending = track.sends?.find(send => send.bus === bus)
            if (sending === undefined && level <= None) {continue}
            if (sending !== undefined && Math.abs(sending.gain - level) < 1) {continue}
            const ramp = (ref: string): Step => ({plan: {op: "ramp", ref, to: level, beats: Glide}, when: {at: "next", unit: "beat"},
                says: `${track.name}'s ${bus.toLowerCase()} send to ${dbText(level)}`})
            if (sending !== undefined) {
                steps.push({...ramp(`${track.ref}.send.${bus}.gain`), when})
                continue
            }
            const settings = [...Returns[bus].settings.filter(setting => !settingsOf(bus).some(own => own.param === setting.param)), ...settingsOf(bus)]
            steps.push({plan: {op: "send", track: track.ref, bus, effect: {factory: Returns[bus].factory, settings}}, when,
                says: `${track.name} into the ${bus.toLowerCase()}`, then: added => {
                    const gain = added.params?.find(param => param.ref === `${added.ref}.gain`)
                    return gain === undefined ? [] : [ramp(gain.ref)]
                }})
        }
    }
    // A return made by an earlier style takes this one's character, gliding (a stepped time switches at once).
    for (const [bus, track] of returns) {
        const effect = track?.effects[0]
        if (effect === undefined) {continue}
        for (const setting of settingsOf(bus)) {
            const param = effect.params?.find(param => param.ref === `${effect.ref}.${setting.param}`)
            if (param === undefined || Math.abs(param.value - setting.value) < 1e-3) {continue}
            steps.push({plan: {op: "ramp", ref: param.ref, to: setting.value, beats: param.stepped ? 0 : Glide}, when,
                says: `the ${bus.toLowerCase()}'s ${param.name.toLowerCase()} to ${setting.value}`})
        }
    }
    return {steps, says: `The ${style} mix: ${profile.summary}.`}
}
