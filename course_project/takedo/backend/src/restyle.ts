import {existsSync, readdirSync, readFileSync, writeFileSync} from "node:fs"
import {join} from "node:path"
import type {Snapshot, Track} from "../../shared/protocol.ts"
import {analyse} from "./analysis.ts"
import type {Catalog} from "./catalog.ts"
import {chordHits} from "./compose.ts"
import {type Hit, hitOf} from "./generate.ts"
import {expandPattern, type Knowledge} from "./knowledge.ts"
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
    sound?: string                              // a sound (soundfont or preset) its new track plays
    kit?: { name: string, pads: Array<{ role: string, sample: string }> }   // or a drum kit of samples (a Playfield)
    keep?: boolean                              // or the song's own part stays on its sound, only its tone and level glide
    level_db?: number                           // the level it ends at (a keep without one stays where it is)
    range?: [number, number]                    // pitched parts: every note moved by octaves into it (chords as a whole)
    rhythm?: "hold" | "as played"               // hold: each chord rings until the next one (repeats merged)
    velocity?: number                           // 0..1: every note at it (a soft attack)
    groove?: string                             // drums: a pattern entry
    add?: { major: string, minor: string }      // chords: the progression written when the song has no chords
    tone?: { low_cut: number, high_cut: number } // a high- and low-pass on the part (Hz; 20 and 20000 for none)
    heard?: boolean                             // its level and tone came from the producer's approval: they win over a kept sound's tuning
}
export type Template = { style: string, about: string, tempo: [number, number], parts: Partial<Record<TemplateRole, PartSpec>>,
    master: string }

// The producer's rules, learned from their corrections in sessions (2026-11-26, the producer: apply them at once, but
// only corrections, never the experimental, exploratory combinations): knowledge/rules.json, for one style or every one
// (style null), about one role or the whole song (role null), with their words and the date.
// not_sound: the sound the correction rejected for that style and part (2026-11-26, the producer: "that harmonica sound is
// horrible for hip hop", the boombap template's Muted Trumpet; the rule alone left the template playing it next time).
export type Rule = { style: string | null, role: TemplateRole | null, text: string, said: string, date: string, not_sound?: string }
export const loadRules = (path: string): Rule[] =>
    existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as { rules: Rule[] }).rules : []
export const rulesFor = (path: string, styles: ReadonlyArray<string>): Rule[] =>
    loadRules(path).filter(rule => rule.style === null || styles.includes(rule.style))
// replacing: rules this one refines (learned earlier in the same session), removed.
export const addRule = (path: string, rule: Rule, replacing: ReadonlyArray<Rule> = []): void => {
    const same = (a: Rule, b: Rule) => a.style === b.style && a.role === b.role && a.text === b.text
    const rules = loadRules(path).filter(other => !same(other, rule) && !replacing.some(old => same(old, other)))
    writeFileSync(path, `${JSON.stringify({rules: [...rules, rule]}, null, 2)}\n`)
}
export const ruleLine = (rule: Rule): string =>
    `${rule.text} (${rule.style ?? "every style"}${rule.role !== null ? `, ${rule.role}` : ""}; the producer, ${rule.date}: "${rule.said}")`

// A template part changed by the producer's approval of a fix ("much better"): the fields given, written at once.
export const learnPart = (dir: string, style: string, role: TemplateRole, change: Partial<PartSpec>): string | null => {
    const path = join(dir, `${style}.json`)
    if (!existsSync(path)) {return `no template for ${style}`}
    const template = JSON.parse(readFileSync(path, "utf8")) as Template
    // A new sound replaces a kit or keeping the song's own part.
    const {kit: _kit, keep: _keep, ...before} = template.parts[role] ?? {}
    template.parts[role] = {...(change.sound !== undefined ? before : template.parts[role] ?? {}), ...change,
        ...(change.level_db !== undefined || change.tone !== undefined ? {heard: true} : {})}
    const part = template.parts[role]!
    if (part.sound === undefined && part.kit === undefined && part.keep !== true) {return `a new ${role} part needs its sound`}
    writeFileSync(path, `${JSON.stringify(template, null, 2)}\n`)
    return null
}

export const loadTemplates = (dir: string): Map<string, Template> => {
    const templates = new Map<string, Template>()
    if (!existsSync(dir)) {return templates}
    for (const file of readdirSync(dir).filter(name => name.endsWith(".json"))) {
        const template = JSON.parse(readFileSync(join(dir, file), "utf8")) as Template
        templates.set(template.style, template)
    }
    return templates
}

// A template whose part plays a sound a rule rejects gets another (pick: the library's best for the role and style, never
// a rejected one); the template on disk stays as it is until the producer approves a fix (learnPart).
export const withoutRejected = (template: Template, rules: ReadonlyArray<Rule>,
                                pick: (role: TemplateRole, avoid: string[]) => string | null): Template => {
    const parts = {...template.parts}
    const notes: string[] = []
    for (const [role, spec] of Object.entries(parts) as Array<[TemplateRole, PartSpec]>) {
        const avoid = rules.filter(rule => rule.style === template.style && rule.role === role && rule.not_sound !== undefined)
            .map(rule => rule.not_sound!)
        if (spec.sound === undefined || !avoid.includes(spec.sound)) {continue}
        const other = pick(role, avoid)
        parts[role] = other === null ? {...spec, sound: undefined, keep: true} : {...spec, sound: other}
        notes.push(`its ${role} is ${other ?? "the song's own"}, never ${spec.sound} (the producer rejected it)`)
    }
    // Its description names the old sound ("a muted trumpet phrase on top"), and the Team Lead tells the producer from it.
    return {...template, parts, ...(notes.length > 0 ? {about: `${template.about}; but ${notes.join("; ")}`} : {})}
}

// A part of the template made on a new track: the edit, its old part (null: a new part), and the level it ends at.
// keep: no new track (code null): the old part itself glides to the tone and level.
export type Move = { role: TemplateRole, old: Track | null, name: string, code: string | null, says: string, level_db: number, handover: boolean,
    keep?: boolean, tone?: { low_cut: number, high_cut: number } }

// What a template part's tracks are named: after its sound or kit, so a later restyle knows them ("Fretless Bass").
// Drums on a sound are named for their style too ("Funk Room Kit"): styles share a kit sound with different grooves.
export const partName = (spec: PartSpec, style?: string): string | null => {
    const sound = spec.sound?.split("/").pop()
    if (spec.kit !== undefined) {return spec.kit.name}
    if (sound === undefined) {return null}
    return spec.groove !== undefined && style !== undefined ? `${style.charAt(0).toUpperCase()}${style.slice(1)} ${sound}` : sound
}
const named = (track: Track, name: string | null): boolean => name !== null && (track.name === name || track.name.startsWith(`${name} `))

// A part's role: the template's own part when it's named after that part's sound (a low Rhodes chord is still chords),
// else what it plays (mixProfiles.ts).
const roleFor = (track: Track, template: Template): TemplateRole | null => {
    const own = TemplateRoles.find(role => {
        const spec = template.parts[role]
        return spec !== undefined && named(track, partName(spec, template.style))
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
    const entry = spec.sound === undefined ? null : knowledge.library?.entry(spec.sound)
    return entry?.verdict === "kept" && spec.heard !== true ? entry.tuning.level_db : spec.level_db ?? -10
}

// The moves a template makes on the project as it is (a full snapshot, with notes), and what it leaves alone.
export const restyleMoves = (template: Template, snapshot: Snapshot, knowledge: Knowledge, catalog: Catalog, fading: boolean)
    : { moves: Move[], left: string[] } | string => {
    const bpb = snapshot.timeline.signature[0]
    const moves: Move[] = [], left: string[] = []
    // hits: pitched notes, or for a kit [beat, role, beats, velocity] with the role in the pitch's place.
    const made = (role: TemplateRole, old: Track | null, notes: { hits: Array<[number, number, number, number]> | Array<[number, string, number, number]>, beats: number }): string | null => {
        const spec = template.parts[role]!
        // Named after its sound, so a later restyle (and soundFit) knows what it plays: "Fretless Bass", "Lofi 808".
        const base = partName(spec, template.style)!
        const taken = snapshot.tracks.filter(other => named(other, base)).length + moves.filter(move => move.name.startsWith(base)).length
        const name = taken === 0 ? base : `${base} ${taken + 1}`
        const level = levelOf(knowledge, spec)
        // Every part fades in over the bars given, the drums too (2026-11-26, the producer: the lofi drums jumped in).
        const handover = !fading || old === null
        const tone = spec.tone !== undefined ? {tone: spec.tone} : {}
        const plan = spec.kit !== undefined
            ? knowledge.kit({name, pads: spec.kit.pads, volume_db: handover ? level : -60, ...tone,
                notes: {hits: notes.hits.map(([beat, role, , velocity]) => [beat, role, velocity]), beats: notes.beats}}, snapshot)
            : knowledge.soundfont({sound: spec.sound, name, start_db: handover ? level : -60, ...tone,
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
        // The song's own part kept: only its tone and level glide there (once: a Revamp on it means it's done).
        if (spec.keep === true) {
            if (track.effects.some(effect => effect.key === "Revamp")) {left.push(`${track.ref} ${track.name}: kept, already toned`); continue}
            moves.push({role, old: track, name: track.name, code: null, keep: true, handover: !fading, level_db: spec.level_db ?? track.mix.volume,
                says: `${track.name} kept on its own sound${spec.tone !== undefined ? `, low-passed to ${spec.tone.high_cut} Hz` : ""}`, ...(spec.tone !== undefined ? {tone: spec.tone} : {})})
            continue
        }
        // Drums by their name only: the same kit sound on another style's groove isn't this style's drums.
        if ((role !== "drums" && spec.sound !== undefined && soundOf(track, catalog, knowledge.library)?.sound === spec.sound) || named(track, partName(spec, template.style))) {
            left.push(`${track.ref} ${track.name}: already the template's ${partName(spec, template.style)}`)
            continue
        }
        if (role === "drums") {
            if (spec.groove === undefined) {left.push(`${track.ref} ${track.name}: the template has no groove`); continue}
            let problem: string | null
            if (spec.kit !== undefined) {
                const entry = knowledge.get([spec.groove])[0]
                const view = "pattern" in entry ? entry.pattern : undefined
                const pattern = view === undefined ? undefined : expandPattern(view)
                if (pattern === undefined || typeof pattern === "string" || pattern.type !== "drums") {return `drums: ${spec.groove} isn't a drum pattern`}
                problem = made(role, track, {hits: pattern.hits.map(([beat, drum, velocity]): [number, string, number, number] => [beat, drum, 0.25, velocity]), beats: pattern.beats})
            } else {
                const kit = {...track, ref: "new", name: spec.sound, device: {key: "Soundfont", name: spec.sound, enabled: true}} as Track
                const groove = knowledge.patternHits(spec.groove, kit, {}, bpb)
                if (typeof groove === "string") {return `drums: ${groove}`}
                problem = made(role, track, {hits: groove.hits, beats: groove.beats})
            }
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
export const templateText = (template: Template, rules: ReadonlyArray<Rule>): string => [
    `${template.style}: ${template.about}. Tempo ${template.tempo[0]}–${template.tempo[1]} BPM.`,
    ...TemplateRoles.flatMap(role => {
        const spec = template.parts[role]
        return spec === undefined ? [] : [`${role}: ${spec.keep ? "the song's own part, kept" : spec.kit !== undefined ? `${spec.kit.name} (${spec.kit.pads.map(pad => pad.sample).join(", ")})` : spec.sound}${spec.tone ? `, low cut ${spec.tone.low_cut} Hz, high cut ${spec.tone.high_cut} Hz` : ""}${spec.groove ? `, groove ${spec.groove}` : ""}${spec.range ? `, notes ${spec.range[0]}–${spec.range[1]}` : ""}${spec.rhythm === "hold" ? ", chords held" : ""}`]
    }),
    `master: ${template.master}`,
    ...rules.map(rule => `the producer's rule: ${ruleLine(rule)}`)
].join("\n")
