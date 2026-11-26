import {existsSync, readdirSync, readFileSync} from "node:fs"
import {join} from "node:path"
import type {Snapshot, Track} from "../../shared/protocol.ts"
import {analyse} from "./analysis.ts"
import type {Catalog} from "./catalog.ts"
import {chordHits} from "./compose.ts"
import {type Hit, hitOf} from "./generate.ts"
import type {Knowledge} from "./knowledge.ts"
import {roleOf} from "./mixProfiles.ts"
import {playing} from "./blend.ts"
import {soundOf} from "./soundFit.ts"

// Style templates (2026-11-26, the producer: "the genre style directions should have much more strict defaults; randomly
// choosing instruments and melodies that should fit, piecemeal, is not working"). A style is one file in
// knowledge/style/: each part's exact sound, register, rhythm and level, the tempo range, the master's character, and the
// producer's rules learned from sessions. Applied by code as one unit: every playing part of a role the template has
// moves onto the template's sound, its notes carried over (moved by octaves into the register, chords held when the
// template says so), the old part fading out and parked; a part the style needs that the song lacks is written from the
// template (chords only: melodies aren't invented). Tempo and the master stay workers' pieces, with exact goals.

export const TemplateRoles = ["drums", "bass", "chords", "lead"] as const
export type TemplateRole = typeof TemplateRoles[number]
export type PartSpec = {
    sound: string, level_db: number
    range?: [number, number]                    // pitched parts: every note moved by octaves into it (chords as a whole)
    rhythm?: "hold" | "as played"               // hold: each chord rings until the next one (repeats merged)
    velocity?: number                           // 0..1: every note at it (a soft attack)
    groove?: string                             // drums: a pattern entry
    add?: { major: string, minor: string }      // chords: the progression written when the song has no chords
}
export type Rule = { text: string, said: string, date: string }
export type Template = { style: string, about: string, tempo: [number, number], parts: Partial<Record<TemplateRole, PartSpec>>,
    master: string, rules: Rule[] }

export const loadTemplates = (dir: string): Map<string, Template> => {
    const templates = new Map<string, Template>()
    if (!existsSync(dir)) {return templates}
    for (const file of readdirSync(dir).filter(name => name.endsWith(".json"))) {
        const template = JSON.parse(readFileSync(join(dir, file), "utf8")) as Template
        templates.set(template.style, template)
    }
    return templates
}

// A part of the template made on a new track: the edit, its old part (null: a new part), and the level it ends at.
export type Move = { role: TemplateRole, old: Track | null, name: string, code: string, says: string, level_db: number, handover: boolean }

// A part's role: the template's own part when it's named after that part's sound (a low Rhodes chord is still chords),
// else what it plays (mixProfiles.ts).
const roleFor = (track: Track, template: Template): TemplateRole | null => {
    const own = TemplateRoles.find(role => {
        const preset = template.parts[role]?.sound.split("/").pop()
        return preset !== undefined && (track.name === preset || track.name.startsWith(`${preset} `))
    })
    if (own !== undefined) {return own}
    const role = roleOf(track)
    return role === "drums" ? "drums" : role === "bass" ? "bass" : role === "chords" || role === "pad" ? "chords" : role === "lead" ? "lead" : null
}

// Notes moved by octaves into a range: a chord (notes starting together) as a whole, so its shape stays.
export const intoRange = (hits: ReadonlyArray<Hit>, [low, high]: [number, number]): Hit[] => {
    const groups = new Map<number, Hit[]>()
    hits.forEach(hit => groups.set(hit[0], [...groups.get(hit[0]) ?? [], hit]))
    return [...groups.values()].flatMap(group => {
        const pitches = group.map(([, pitch]) => pitch)
        let shift = 0
        while (Math.min(...pitches) + shift < low) {shift += 12}
        while (Math.max(...pitches) + shift > high && Math.min(...pitches) + shift - 12 >= low) {shift -= 12}
        return group.map(([beat, pitch, beats, velocity]): Hit => [beat, Math.max(0, Math.min(127, pitch + shift)), beats, velocity])
    }).sort((a, b) => a[0] - b[0] || a[1] - b[1])
}

// Chords held: each chord rings until the next different one (a repeat of the same chord merges into it), the last
// until the loop's end.
export const held = (hits: ReadonlyArray<Hit>, loopBeats: number): Hit[] => {
    const onsets = [...new Set(hits.map(([beat]) => beat))].sort((a, b) => a - b)
    const chordAt = (beat: number) => hits.filter(hit => hit[0] === beat).map(([, pitch]) => pitch).sort((a, b) => a - b).join(",")
    const starts = onsets.filter((beat, index) => index === 0 || chordAt(beat) !== chordAt(onsets[index - 1]))
    return starts.flatMap((beat, index) => {
        const end = index + 1 < starts.length ? starts[index + 1] : loopBeats
        return hits.filter(hit => hit[0] === beat).map(([, pitch, , velocity]): Hit => [beat, pitch, Number((end - beat - 0.05).toFixed(4)), velocity])
    })
}

// A part's notes as it plays now: the hits of its playing region and the region's loop length in beats.
const partNotes = (track: Track, snapshot: Snapshot): { hits: Hit[], beats: number } | null => {
    const bpb = snapshot.timeline.signature[0]
    const region = playing(track, snapshot)
    if (region === null || region.notes === undefined || region.notes.length === 0) {return null}
    const at = (pos: string) => hitOf([pos, 0, 0, 0], bpb)[0]
    const beats = region.loop !== null ? region.loop * bpb : Math.max(bpb, at(region.to) - at(region.from))
    return {hits: region.notes.map(note => hitOf(note, bpb)).filter(([beat]) => beat < beats), beats}
}

// The level a sound ends at: the producer's own (a kept sound's tuning), else the template's.
const levelOf = (knowledge: Knowledge, spec: PartSpec): number => {
    const entry = knowledge.library?.entry(spec.sound)
    return entry?.verdict === "kept" ? entry.tuning.level_db : spec.level_db
}

// The moves a template makes on the project as it is (a full snapshot, with notes), and what it leaves alone.
export const restyleMoves = (template: Template, snapshot: Snapshot, knowledge: Knowledge, catalog: Catalog, fading: boolean)
    : { moves: Move[], left: string[] } | string => {
    const bpb = snapshot.timeline.signature[0]
    const moves: Move[] = [], left: string[] = []
    const made = (role: TemplateRole, old: Track | null, notes: { hits: Hit[], beats: number }): string | null => {
        const spec = template.parts[role]!
        // Named after its sound, so a later restyle (and soundFit) knows what it plays: "Fretless Bass", "Jazz Kit".
        const preset = spec.sound.split("/").pop()!
        const taken = snapshot.tracks.filter(other => other.name === preset || other.name.startsWith(`${preset} `)).length
            + moves.filter(move => move.name.startsWith(preset)).length
        const name = taken === 0 ? preset : `${preset} ${taken + 1}`
        const level = levelOf(knowledge, spec)
        const handover = role === "drums" || !fading || old === null
        const plan = knowledge.soundfont({sound: spec.sound, name, ...(handover ? {} : {start_db: -60}),
            notes: {notes: notes.hits, loop_bars: Math.max(1, Math.ceil(notes.beats / bpb))}}, snapshot)
        if (typeof plan === "string") {return `${role}: ${plan}`}
        moves.push({role, old, name, code: plan.code, says: plan.says, level_db: level, handover})
        return null
    }
    const playingParts = snapshot.tracks.filter(track => track.kind === "notes" && !track.mix.mute)
    const covered = new Set<TemplateRole>()
    for (const track of playingParts) {
        const role = roleFor(track, template)
        const spec = role === null ? undefined : template.parts[role]
        if (role === null || spec === undefined) {left.push(`${track.ref} ${track.name}: ${role ?? roleOf(track)} isn't in the ${template.style} template`); continue}
        covered.add(role)
        const preset = spec.sound.split("/").pop()!
        if (soundOf(track, catalog, knowledge.library)?.sound === spec.sound || track.name === preset || track.name.startsWith(`${preset} `)) {left.push(`${track.ref} ${track.name}: already the template's ${spec.sound}`); continue}
        if (role === "drums") {
            if (spec.groove === undefined) {left.push(`${track.ref} ${track.name}: the template has no groove`); continue}
            const kit = {...track, ref: "new", name: spec.sound, device: {key: "Soundfont", name: spec.sound, enabled: true}} as Track
            const groove = knowledge.patternHits(spec.groove, kit, {}, bpb)
            if (typeof groove === "string") {return `drums: ${groove}`}
            const problem = made(role, track, {hits: groove.hits, beats: groove.beats})
            if (problem !== null) {return problem}
            continue
        }
        const notes = partNotes(track, snapshot)
        if (notes === null) {left.push(`${track.ref} ${track.name}: no notes playing`); continue}
        let hits = spec.range === undefined ? notes.hits : intoRange(notes.hits, spec.range)
        if (spec.rhythm === "hold") {hits = held(hits, notes.beats)}
        if (spec.velocity !== undefined) {hits = hits.map(([beat, pitch, beats]): Hit => [beat, pitch, beats, spec.velocity!])}
        const problem = made(role, track, {hits, beats: notes.beats})
        if (problem !== null) {return problem}
    }
    // Chords the style needs and the song lacks, in its key.
    const chords = template.parts.chords
    if (!covered.has("chords") && chords?.add !== undefined) {
        const key = analyse(snapshot).key
        if (key === null) {
            left.push("chords: no key to write them in")
        } else {
            const written = chordHits({progression: chords.add[key.mode], key: `${key.tonic} ${key.mode}`, voicing: "open", register: "mid",
                rhythm: chords.rhythm === "hold" ? "hold" : "x.......x.......", velocity: chords.velocity}, bpb)
            if (typeof written === "string") {return `chords: ${written}`}
            const problem = made("chords", null, {hits: chords.range === undefined ? written.hits : intoRange(written.hits, chords.range), beats: written.beats})
            if (problem !== null) {return problem}
        }
    }
    return {moves, left}
}

// The template as the Team Lead and workers read it: its parts, master and the producer's rules.
export const templateText = (template: Template): string => [
    `${template.style}: ${template.about}. Tempo ${template.tempo[0]}–${template.tempo[1]} BPM.`,
    ...TemplateRoles.flatMap(role => {
        const spec = template.parts[role]
        return spec === undefined ? [] : [`${role}: ${spec.sound}${spec.groove ? `, groove ${spec.groove}` : ""}${spec.range ? `, notes ${spec.range[0]}–${spec.range[1]}` : ""}${spec.rhythm === "hold" ? ", chords held" : ""}`]
    }),
    `master: ${template.master}`,
    ...template.rules.map(rule => `the producer's rule (${rule.date}): ${rule.text}`)
].join("\n")
