// A dial between its two takes (decided 2026-11-25): a position between the ends is worked out by code from the two
// versions of the project, not re-decided by the Team Lead (a session's trap dial layered two kits at 0.18 and 0.49 and
// went dead near its top, where every landed position had become a take). blendOf builds the project at fraction f
// from `lo` (0) to `hi` (1), and recallOf (takes.ts) glides there as it does to a take.
//   - numbers (tempo, levels, pans, effect values) in between, linearly;
//   - a part in both versions: its notes morphed f of the way (morphNotes, the stages evolve_notes uses);
//   - parts in one version only either hand over at the middle or crossfade (the user, 2026-11-25: handover a default,
//     not a rule). Handover, the default for drums and bass, where two grooves or two low ends at once are mud: a part
//     leaving plays until 0.5 and one arriving from there, and when they pair (two kits; two pitched parts in about the
//     same register) the groove moves across: the leaving part's notes morph toward the arriving part's (drums mapped
//     by role onto its own pads), and the arriving part picks up from the same halfway groove. Crossfade, the default
//     for the rest (pads, keys, melodies): the leaving part fades out over the whole range as the arriving one fades in.
//     The Team Lead can set either per part on a dial (set_transition);
//   - switches (an effect on or off, a device swapped) at the middle.
import type {Device, Note, Region, Snapshot, Track} from "../../shared/protocol.ts"
import {hitOf, type Hit, morphNotes, tile} from "./generate.ts"
import {drumMap, DrumRoles} from "./knowledge.ts"

// Stages from one end to the other: f picks the nearest.
const Stages = 8
// Roles tried in this order to name a pad (an open hat's name matches the closed hat's "hi-hat" too).
const RoleOrder = ["open_hat", "closed_hat", "kick", "snare", "clap", "rim", "ride", "crash", "tom_low", "tom_high", "tom_mid", "shaker", "perc"]

export type Transition = "handover" | "crossfade"

export type Blend = {
    target: Snapshot
    // What the blend itself rewrites beyond what the dial's directions changed: the notes of a leaving part it morphs
    // toward the arriving one ("notes t1"). The caller widens the recall's scope with these.
    governs: Set<string>
    says: string[]
}

const lerp = (a: number, b: number, f: number): number => a + (b - a) * f
// A level f of the way up from silence, as gain (a crossfade sums to about the same loudness).
const faded = (db: number, f: number): number => f <= 0 ? -60 : Math.max(-60, db + 20 * Math.log10(f))
const live = (track: Track | undefined): track is Track => track !== undefined && !track.mix.mute && track.device?.enabled !== false

export const noteOf = ([beat, pitch, beats, velocity]: Hit, beatsPerBar: number): Note => {
    const bar = Math.floor(beat / beatsPerBar + 1e-9), inBar = beat - bar * beatsPerBar
    const whole = Math.floor(inBar + 1e-9), sixteenth = Math.floor((inBar - whole) * 4 + 1e-9)
    const ticks = Math.round((inBar - whole - sixteenth / 4) * 960)
    return [`${bar + 1}.${whole + 1}.${sixteenth + 1}:${ticks}`, pitch, Math.max(0.01, Number((beats * 4).toFixed(3))), Math.round(Math.min(1, velocity) * 127)]
}

const loopBeats = (region: Region, beatsPerBar: number): number => {
    if (region.loop !== null) {return region.loop * beatsPerBar}
    const at = (pos: string) => hitOf([pos, 0, 0, 0], beatsPerBar)[0]
    return Math.max(beatsPerBar, at(region.to) - at(region.from))
}

// The region a part plays from now on: the one the playhead is in, else the last one with notes.
const playing = (track: Track, now: Snapshot): Region | null => {
    const bpb = now.timeline.signature[0]
    const beat = hitOf([now.playback.pos.split(":")[0], 0, 0, 0], bpb)[0]
    const at = (pos: string) => hitOf([pos, 0, 0, 0], bpb)[0]
    const notes = track.regions.filter(region => region.kind === "notes" && region.notes !== undefined && !region.muted)
    return notes.find(region => at(region.from) <= beat && beat < at(region.to)) ?? notes.at(-1) ?? null
}

// Drums and bass hand over; the rest crossfade.
export const defaultTransition = (track: Track): Transition => {
    if (track.device?.content !== undefined && "pads" in track.device.content) {return "handover"}
    const pitches = track.regions.flatMap(region => region.notes ?? []).map(([, pitch]) => pitch).sort((a, b) => a - b)
    return pitches.length > 0 && pitches[Math.floor(pitches.length / 2)] < 52 ? "handover" : "crossfade"
}

const pads = (track: Track): ReadonlyArray<{ note: number, name: string }> | null =>
    track.device?.content !== undefined && "pads" in track.device.content ? track.device.content.pads : null

const roleOf = (pitch: number, kit: ReadonlyArray<{ note: number, name: string }>): string | null => {
    const pad = kit.find(candidate => candidate.note === pitch)
    return pad === undefined ? null : RoleOrder.find(role => DrumRoles[role].names.test(pad.name)) ?? null
}

// One part's notes played by another: drums by role onto its pads, pitched notes moved by octaves into its register.
const carried = (hits: ReadonlyArray<Hit>, from: Track, to: Track, register: number | null): Hit[] => {
    const fromKit = pads(from), toKit = pads(to)
    if (fromKit !== null && toKit !== null) {
        return hits.flatMap(([beat, pitch, beats, velocity]) => {
            const role = roleOf(pitch, fromKit)
            if (role === null) {return []}
            const mapped = drumMap([role], to)
            return typeof mapped === "string" ? [] : [[beat, mapped.notes[role], beats, velocity] as Hit]
        })
    }
    const median = medianOf(hits)
    const shift = register === null || median === null ? 0 : Math.round((register - median) / 12) * 12
    return hits.map(([beat, pitch, beats, velocity]) => [beat, pitch + shift, beats, velocity] as Hit)
}

const medianOf = (hits: ReadonlyArray<Hit>): number | null => {
    if (hits.length === 0) {return null}
    const sorted = hits.map(([, pitch]) => pitch).sort((a, b) => a - b)
    return sorted[Math.floor(sorted.length / 2)]
}

// f's stage of the way from `from` to `to` (0: from, Stages: to), both tiled to the region's loop.
const stage = (from: ReadonlyArray<Hit>, fromBeats: number, to: ReadonlyArray<Hit>, toBeats: number, beats: number, f: number): Hit[] => {
    const a = tile(from, fromBeats, beats), b = tile(to, toBeats, beats)
    const at = Math.round(Math.min(1, Math.max(0, f)) * Stages)
    return at === 0 ? a : morphNotes(a, b, Stages)[at - 1]
}

const effectsAt = (now: ReadonlyArray<Device>, lo: ReadonlyArray<Device>, hi: ReadonlyArray<Device>, f: number): Device[] =>
    now.map(effect => {
        const a = lo.find(candidate => candidate.ref === effect.ref && candidate.key === effect.key)
        const b = hi.find(candidate => candidate.ref === effect.ref && candidate.key === effect.key)
        const side = f < 0.5 ? a : b
        const enabled = side?.enabled ?? false
        if (!enabled) {return {...effect, enabled: false}}
        const params = (effect.params ?? []).map(param => {
            const pa = a?.enabled ? a.params?.find(candidate => candidate.ref === param.ref) : undefined
            const pb = b?.enabled ? b.params?.find(candidate => candidate.ref === param.ref) : undefined
            if (pa !== undefined && pb !== undefined && !param.stepped) {return {...param, value: lerp(pa.value, pb.value, f)}}
            const kept = (f < 0.5 ? pa : pb) ?? pa ?? pb
            return kept === undefined ? param : {...param, value: kept.value}
        })
        return {...effect, enabled, params}
    })

export const blendOf = (lo: Snapshot, hi: Snapshot, f: number, now: Snapshot, transitions: Readonly<Record<string, Transition>> = {}): Blend => {
    const bpb = now.timeline.signature[0]
    const governs = new Set<string>(), says: string[] = []
    const target: Snapshot = structuredClone(now)
    target.timeline = {...target.timeline, bpm: Math.round(lerp(lo.timeline.bpm, hi.timeline.bpm, f) * 10) / 10}
    target.master = {volume: lerp(lo.master.volume, hi.master.volume, f), effects: effectsAt(now.master.effects, lo.master.effects, hi.master.effects, f)}
    const find = (snapshot: Snapshot, ref: string) => snapshot.tracks.find(track => track.ref === ref)
    const leaving: Track[] = [], arriving: Track[] = []
    target.tracks = now.tracks.map(track => {
        const a = find(lo, track.ref), b = find(hi, track.ref)
        if (live(a) && live(b)) {
            const regions = track.regions.map(region => {
                const ra = a.regions.find(candidate => candidate.ref === region.ref), rb = b.regions.find(candidate => candidate.ref === region.ref)
                if (ra?.notes === undefined || rb?.notes === undefined || region.notes === undefined) {return region}
                const beats = loopBeats(region, bpb)
                const notes = stage(ra.notes.map(note => hitOf(note, bpb)), loopBeats(ra, bpb), rb.notes.map(note => hitOf(note, bpb)), loopBeats(rb, bpb), beats, f)
                return {...region, notes: notes.map(hit => noteOf(hit, bpb))}
            })
            return {...track, regions, effects: effectsAt(track.effects, a.effects, b.effects, f),
                mix: {...track.mix, mute: false, volume: lerp(a.mix.volume, b.mix.volume, f), pan: lerp(a.mix.pan, b.mix.pan, f)}}
        }
        if (live(a) || live(b)) {
            const side = live(a) ? a : b as Track
            const transition = transitions[track.ref] ?? defaultTransition(side)
            const towards = live(a) ? 1 - f : f      // how much of this part the position has
            if (transition === "handover") {(live(a) ? leaving : arriving).push(side)}
            const on = transition === "handover" ? (live(a) ? f < 0.5 : f >= 0.5) : towards > 0
            const volume = transition === "handover" ? side.mix.volume : faded(side.mix.volume, towards)
            return on ? {...track, device: track.device === null ? null : {...track.device, enabled: true},
                    effects: effectsAt(track.effects, side.effects, side.effects, f), mix: {...track.mix, mute: false, volume, pan: side.mix.pan}}
                : {...track, mix: {...track.mix, mute: true}}
        }
        return track
    })
    // Pairs across the handover: kit with kit, else pitched parts within an octave and a fifth of each other.
    const notesOf = (track: Track) => {
        const region = playing(track, track === find(lo, track.ref) ? lo : hi)
        return region === null ? null : {region, hits: (region.notes ?? []).map(note => hitOf(note, bpb)), beats: loopBeats(region, bpb)}
    }
    const taken = new Set<string>()
    leaving.forEach(out => {
        const from = notesOf(out)
        if (from === null) {return}
        const drums = pads(out) !== null
        const candidates = arriving.filter(candidate => !taken.has(candidate.ref) && (pads(candidate) !== null) === drums)
            .map(candidate => ({candidate, to: notesOf(candidate)}))
            .filter((pair): pair is { candidate: Track, to: NonNullable<ReturnType<typeof notesOf>> } => pair.to !== null)
            .map(pair => ({...pair, distance: drums ? 0 : Math.abs((medianOf(pair.to.hits) ?? 0) - (medianOf(from.hits) ?? 0))}))
            .filter(pair => pair.distance <= 19)
            .sort((x, y) => x.distance - y.distance)
        const pair = candidates[0]
        if (pair === undefined) {return}
        taken.add(pair.candidate.ref)
        const {candidate, to} = pair
        // Write into the part that plays at f: the leaving part's region before the middle, the arriving part's after.
        const writing = f < 0.5 ? out : candidate
        const nowTrack = target.tracks.find(track => track.ref === writing.ref)
        const region = nowTrack === undefined ? null : playing(nowTrack, now)
        if (nowTrack === undefined || region === null) {return}
        const beats = loopBeats(region, bpb)
        const notes = f < 0.5
            ? stage(from.hits, from.beats, carried(to.hits, candidate, out, medianOf(from.hits)), to.beats, beats, f)
            : stage(carried(from.hits, out, candidate, medianOf(to.hits)), from.beats, to.hits, to.beats, beats, f)
        nowTrack.regions = nowTrack.regions.map(candidateRegion => candidateRegion.ref === region.ref
            ? {...candidateRegion, notes: notes.map(hit => noteOf(hit, bpb))} : candidateRegion)
        governs.add(`notes ${writing.ref}`)
        says.push(`${out.name} hands over to ${candidate.name} at the middle, the groove moving across`)
    })
    return {target, governs, says}
}
