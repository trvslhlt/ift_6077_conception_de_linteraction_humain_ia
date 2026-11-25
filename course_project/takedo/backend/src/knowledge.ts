import {existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync} from "node:fs"
import {basename, join} from "node:path"
import type {Snapshot, Track} from "../../shared/protocol.ts"
import type {Catalog, CatalogParameter} from "./catalog.ts"
import type {Samples} from "./samples.ts"

// The knowledge base (project_plan/KNOWLEDGE.md): what agents would otherwise look up or work out again every session,
// kept as small named entries, some of which code can apply. One JSON file per entry under <dir>/<kind>/<name>.json
// (reviewed) or <dir>/drafts/<kind>/<name>.json (written by an agent, not yet reviewed); DX7 cartridges under <dir>/dx7;
// the page-side helpers in <dir>/scripts/kb.js, and named scripts beside it.
//
// The music is worked out here, where it can be tested: keys and chord numerals to pitches, drum roles to a kit's
// pads, DX7 voices to bytes. The page gets pitches, bytes and field values, through the same paths as the utility's
// own edits (fixed operations and scripts), so an entry can do nothing the utility couldn't.

export const Kinds = ["genre", "production", "sound", "chain", "pattern", "note"] as const
export type Kind = typeof Kinds[number]
export const Checks = ["heard", "measured", "written", "imported"] as const

export type Param = { type: "track" | "amount" | "number" | "key" | "text", about?: string, default?: unknown,
    optional?: boolean }
// when: a param's name; the step is skipped when that param has no value (a genre's plan for parts the project lacks).
export type Step = { op: string, at?: number, input?: Record<string, unknown>, key?: string,
    args?: Record<string, unknown>, script?: string, when?: string }
export type Apply = { params: Record<string, Param>, steps: Step[] }
// Notes with no sound: drums by role, chords by numeral, both in beats from the pattern's start.
export type Pattern =
    | { type: "drums", beats: number, hits: Array<[beat: number, role: string, velocity: number]> }
    | { type: "chords", beats: number, chords: Array<[beat: number, numeral: string, beats: number]>, velocity?: number }
export type Entry = {
    key: string, kind: Kind, summary: string, tags: string[], devices: string[], links: string[]
    checked: { how: typeof Checks[number], by: string, date: string, opendaw: string }
    sources?: Array<{ title: string, url?: string }>
    body: string[]
    apply?: Apply
    pattern?: Pattern
    fields?: string[]                               // notes: the catalog paths they speak of ("Delay/delayMusical")
    tempo?: [number, number]                        // genres: the usual range, BPM
    targets?: Record<string, string>                // production styles: what the Listening part should find
    group?: string                                  // a family listed as one line in the model's index ("Groove MIDI drums: funk")
    label?: string                                  // a few words for that line, when the key alone says too little ("I V vi IV")
    "//"?: string | string[]
}
// One edit an entry expands to: a fixed operation (the members' tools) or a script, `at` bars after the start.
export type Planned =
    | { at: number, kind: "op", name: string, input: Record<string, unknown>, says: string }
    | { at: number, kind: "script", code: string, says: string }
export type IndexLine = { key: string, summary: string, tags: string[], draft?: true, group?: string, label?: string }

const FixedOps = ["add_effect", "set_param", "remove_effect", "volume", "pan", "mute"] as const
const Ops = [...FixedOps, "instrument", "dx7", "kit", "sampler", "pattern", "tempo", "script", "entry"]
const ParamTypes = ["track", "amount", "number", "key", "text"]
const DefaultAmount = 1                             // "a clear, moderate change", on Jev's 0..3 amount scale
const MaxDepth = 6

// ---------- music: keys, chord numerals, drum roles ----------

const PitchClasses: Record<string, number> = {C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11}
const Scales = {major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10]}
export type Key = { tonic: number, mode: "major" | "minor", name: string }

// "G major", "F# minor", "Bbm", "A min", "C".
export const parseKey = (text: string): Key | null => {
    const match = /^\s*([A-Ga-g])([#b♯♭]?)\s*(major|minor|maj|min|m)?\s*$/.exec(text)
    if (match === null) {return null}
    const tonic = (PitchClasses[match[1].toUpperCase()] + (/[#♯]/.test(match[2]) ? 1 : /[b♭]/.test(match[2]) ? -1 : 0) + 12) % 12
    const mode = match[3] !== undefined && /^m(in(or)?)?$/i.test(match[3]) && match[3] !== "maj" ? "minor" : "major"
    return {tonic, mode, name: `${match[1].toUpperCase()}${match[2]} ${mode}`}
}

const Numerals = ["VII", "VI", "V", "IV", "III", "II", "I"]
const Degree: Record<string, number> = {I: 0, II: 1, III: 2, IV: 3, V: 4, VI: 5, VII: 6}
// Chord shapes by suffix, as intervals from the root; "upper"/"lower" is the numeral's case (major or minor triad).
const Shapes: Array<[RegExp, number[], number[]]> = [
    [/^(°7|o7|dim7)$/, [0, 3, 6, 9], [0, 3, 6, 9]],
    [/^(ø7?|m7b5)$/, [0, 3, 6, 10], [0, 3, 6, 10]],
    [/^(°|o|dim)$/, [0, 3, 6], [0, 3, 6]],
    [/^(\+|aug)$/, [0, 4, 8], [0, 4, 8]],
    [/^(maj9|M9)$/, [0, 4, 7, 11, 14], [0, 3, 7, 11, 14]],
    [/^(maj7|M7|Δ7?)$/, [0, 4, 7, 11], [0, 3, 7, 11]],
    [/^m7$/, [0, 3, 7, 10], [0, 3, 7, 10]],
    [/^7sus4$/, [0, 5, 7, 10], [0, 5, 7, 10]],
    [/^7$/, [0, 4, 7, 10], [0, 3, 7, 10]],
    [/^m9$/, [0, 3, 7, 10, 14], [0, 3, 7, 10, 14]],
    [/^9$/, [0, 4, 7, 10, 14], [0, 3, 7, 10, 14]],
    [/^(6)$/, [0, 4, 7, 9], [0, 3, 7, 9]],
    [/^sus2$/, [0, 2, 7], [0, 2, 7]],
    [/^sus4?$/, [0, 5, 7], [0, 5, 7]],
    [/^add9$/, [0, 4, 7, 14], [0, 3, 7, 14]],
    [/^m$/, [0, 3, 7], [0, 3, 7]],
    [/^$/, [0, 4, 7], [0, 3, 7]]
]

// A Roman numeral in a key ("ii7", "bVII", "Imaj7", "vii°", "V7sus4") to MIDI pitches, root placed in the octave
// starting at `octave` (3: C3 = 48), close voicing. Degrees follow the key's own scale (natural minor in minor keys);
// a b or # moves the root. Null when it doesn't parse.
export const chordPitches = (numeral: string, key: Key, octave = 3): number[] | null => {
    const match = /^([b#♭♯]?)(VII|VI|V|IV|III|II|I|vii|vi|v|iv|iii|ii|i)(.*)$/.exec(numeral.trim())
    if (match === null) {return null}
    const roman = match[2], upper = roman === roman.toUpperCase()
    const shift = /[b♭]/.test(match[1]) ? -1 : /[#♯]/.test(match[1]) ? 1 : 0
    const shape = Shapes.find(([pattern]) => pattern.test(match[3]))
    if (shape === undefined || !Numerals.includes(roman.toUpperCase())) {return null}
    const root = 12 * (octave + 1) + (key.tonic + Scales[key.mode][Degree[roman.toUpperCase()]] + shift + 24) % 12
    return (upper ? shape[1] : shape[2]).map(interval => root + interval)
}

// The mode a progression is written in, from its numerals' case against each mode's diatonic chords (major: I ii iii
// IV V vi vii°; minor: i ii° III iv v VI VII, V allowed as in harmonic minor); altered numerals (bVII) don't count.
// A tie keeps the key's own mode.
const Diatonic = {major: ["I", "ii", "iii", "IV", "V", "vi", "vii"], minor: ["i", "ii", "III", "iv", "v", "V", "VI", "VII"]}
export const progressionMode = (numerals: ReadonlyArray<string>, fallback: Key["mode"]): Key["mode"] => {
    const romans = numerals.flatMap(numeral => {
        const match = /^(VII|VI|V|IV|III|II|I|vii|vi|v|iv|iii|ii|i)/.exec(numeral.trim())
        return match === null ? [] : [match[1]]
    })
    const fits = (mode: Key["mode"]) => romans.filter(roman => Diatonic[mode].includes(roman)).length
    const [major, minor] = [fits("major"), fits("minor")]
    return major === minor ? fallback : major > minor ? "major" : "minor"
}

// The key to play a progression in: the project's, or its relative when the progression is written in the other mode
// (2026-11-22: a major-key lofi vamp, vi7 → IVmaj7, came out Cm7 → Amaj7 in E minor; in G major, its relative, it's
// Em7 → Cmaj7, the same notes as E minor).
export const progressionKey = (numerals: ReadonlyArray<string>, key: Key): Key => {
    const mode = progressionMode(numerals, key.mode)
    if (mode === key.mode) {return key}
    const tonic = (key.tonic + (mode === "major" ? 3 : 9)) % 12
    return {tonic, mode, name: `${key.name} (as its relative ${mode})`}
}

// Drum roles, matched against a kit's pad names (Playfield's samples) in order; then the role to fall back on.
export const DrumRoles: Record<string, { names: RegExp, fallback?: string, gm: number }> = {
    kick: {names: /kick|\bbd\b|bass ?drum|bassdrum/i, gm: 36},
    snare: {names: /snare|\bsd\b/i, gm: 38},
    rim: {names: /rim|\brs\b|side ?stick/i, fallback: "snare", gm: 37},
    clap: {names: /clap|\bcp\b/i, fallback: "snare", gm: 39},
    closed_hat: {names: /(closed|\bcl\b|\bch\b).*hat|hat.*(closed|\bcl\b)|^ch\b|hi-?hat(?!.*open)|\bhh\b(?!.*open)/i, gm: 42},
    open_hat: {names: /open.*hat|hat.*open|\boh\b/i, fallback: "closed_hat", gm: 46},
    ride: {names: /ride/i, fallback: "closed_hat", gm: 51},
    crash: {names: /crash|cymbal/i, fallback: "open_hat", gm: 49},
    tom_low: {names: /(low|floor|lo).*tom|tom.*(low|lo|floor)|\blt\b/i, fallback: "tom_mid", gm: 45},
    tom_mid: {names: /(mid|\bmt\b).*tom|tom.*mid|\btom\b/i, fallback: "kick", gm: 47},
    tom_high: {names: /(high|hi).*tom|tom.*(high|hi)|\bht\b/i, fallback: "tom_mid", gm: 50},
    shaker: {names: /shak|maraca|cabasa|tambourine/i, fallback: "closed_hat", gm: 70},
    perc: {names: /conga|bongo|cowbell|perc|clave|block/i, fallback: "rim", gm: 75}
}

// A kit's pad names (page: the pad's sample name), which DrumRoles above read back: "Closed Hat (RolandTR808 CH)".
const RoleLabels: Record<string, string> = {kick: "Kick", snare: "Snare", rim: "Rim", clap: "Clap", closed_hat: "Closed Hat",
    open_hat: "Open Hat", ride: "Ride", crash: "Crash", tom_low: "Low Tom", tom_mid: "Mid Tom", tom_high: "High Tom",
    shaker: "Shaker", perc: "Perc"}

// Each role used in a pattern, mapped to a pad of the track's kit, or to General MIDI notes when it has no pads.
export const drumMap = (roles: Iterable<string>, track: Track): { notes: Record<string, number>, says: string[] } | string => {
    const pads = track.device?.content !== undefined && "pads" in track.device.content ? track.device.content.pads : null
    const notes: Record<string, number> = {}, says: string[] = []
    if (pads === null || pads.length === 0) {
        for (const role of roles) {notes[role] = DrumRoles[role].gm}
        says.push(`${track.name} has no pads to read, so General MIDI drum notes were used`)
        return {notes, says}
    }
    const find = (role: string, seen: Set<string>): number | null => {
        if (seen.has(role)) {return null}
        seen.add(role)
        const pad = pads.find(candidate => DrumRoles[role].names.test(candidate.name))
        if (pad !== undefined) {return pad.note}
        const fallback = DrumRoles[role].fallback
        return fallback === undefined ? null : find(fallback, seen)
    }
    for (const role of roles) {
        const note = find(role, new Set())
        if (note === null) {return `${track.name}'s kit has no pad for ${role} (pads: ${pads.map(pad => pad.name).join(", ")})`}
        notes[role] = note
    }
    return {notes, says}
}

// ---------- DX7 voices ----------

// The 155-byte voice in a 128-byte packed cartridge slot (openDAW's Dx7Sysex.unpack, itself Dexed's).
const unpackVoice = (bulk: Uint8Array): Uint8Array => {
    const patch = new Uint8Array(155)
    for (let op = 0; op < 6; op++) {
        const src = op * 17, dst = op * 21
        for (let index = 0; index < 11; index++) {patch[dst + index] = bulk[src + index] & 0x7F}
        const curves = bulk[src + 11] & 0xF
        patch[dst + 11] = curves & 3
        patch[dst + 12] = (curves >> 2) & 3
        const detuneRate = bulk[src + 12] & 0x7F
        patch[dst + 13] = detuneRate & 7
        const velocityAmp = bulk[src + 13] & 0x1F
        patch[dst + 14] = velocityAmp & 3
        patch[dst + 15] = (velocityAmp >> 2) & 7
        patch[dst + 16] = bulk[src + 14] & 0x7F
        const coarseMode = bulk[src + 15] & 0x3F
        patch[dst + 17] = coarseMode & 1
        patch[dst + 18] = (coarseMode >> 1) & 0x1F
        patch[dst + 19] = bulk[src + 16] & 0x7F
        patch[dst + 20] = (detuneRate >> 3) & 0x7F
    }
    for (let index = 0; index < 8; index++) {patch[126 + index] = bulk[102 + index] & 0x7F}
    patch[134] = bulk[110] & 0x1F
    const syncFeedback = bulk[111] & 0xF
    patch[135] = syncFeedback & 7
    patch[136] = syncFeedback >> 3
    for (let index = 0; index < 4; index++) {patch[137 + index] = bulk[112 + index] & 0x7F}
    const sensWaveSync = bulk[116] & 0x7F
    patch[141] = sensWaveSync & 1
    patch[142] = (sensWaveSync >> 1) & 7
    patch[143] = sensWaveSync >> 4
    patch[144] = bulk[117] & 0x7F
    for (let index = 0; index < 10; index++) {patch[145 + index] = bulk[118 + index] & 0x7F}
    return patch
}
const voiceName = (patch: Uint8Array): string => Array.from(patch.subarray(145, 155))
    .map(code => code >= 32 && code < 127 ? String.fromCharCode(code) : " ").join("").trim()

// A cartridge file's 32 voices: a 4104-byte bulk dump (F0 43 0n 09 20 00 …) or a bare 4096-byte body.
export const readCartridge = (bytes: Uint8Array): Array<{ name: string, data: Uint8Array }> => {
    const body = bytes.length === 4096 && bytes[0] !== 0xF0 ? bytes
        : bytes.length >= 4104 && bytes[0] === 0xF0 && bytes[3] === 0x09 ? bytes.subarray(6, 6 + 4096) : null
    if (body === null) {throw new Error(`not a 32-voice DX7 cartridge (${bytes.length} bytes)`)}
    return Array.from({length: 32}, (_, index) => {
        const data = unpackVoice(body.subarray(index * 128, (index + 1) * 128))
        return {name: voiceName(data), data}
    })
}

// ---------- loading and validation ----------

const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string")
const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value)

// Every "$name" in a value (a string that is exactly "$name").
const references = (value: unknown, found: Set<string> = new Set()): Set<string> => {
    if (typeof value === "string" && /^\$\w+$/.test(value)) {found.add(value.slice(1))}
    else if (Array.isArray(value)) {value.forEach(item => references(item, found))}
    else if (isRecord(value)) {Object.values(value).forEach(item => references(item, found))}
    return found
}
const isDial = (value: unknown): value is { dial: [number, number] } =>
    isRecord(value) && Array.isArray(value.dial) && value.dial.length === 2 && value.dial.every(end => typeof end === "number")

// The kinds of change a message can ask for that entries make (the fast route's first question, KNOWLEDGE.md,
// "Which messages it serves"), and which entries make each. Notes, and entries with nothing to apply, make none.
export const Strata = {
    style: "A new genre or production style for the track as a whole (\"make it house\", \"more lofi\", \"funkier\")",
    sound: "A different instrument sound for a part, or a new part with a named sound (\"a rhodes\", \"add strings\")",
    effect: "A new effect or treatment on a part (reverb, echo, tremolo, telephone, tape, a room)",
    drums: "A different drum pattern, groove or fill",
    chords: "A different chord progression or harmony",
    other: "None of these: a level, mute, pan, tempo or arrangement change, adjusting something already there "
        + "(\"faster tremolo\", \"less crunchy\", \"darker keys\"), a question, feedback or chat"
} as const
export type Stratum = Exclude<keyof typeof Strata, "other">
const stratumOf = (entry: Entry): Stratum | null => entry.apply === undefined ? null
    : entry.kind === "genre" || entry.kind === "production" ? "style" : entry.kind === "sound" ? "sound"
    : entry.kind === "chain" ? "effect" : entry.kind === "pattern" ? (entry.pattern?.type === "drums" ? "drums" : "chords") : null
// Whether an entry of `kind` can serve a message asking for `wants`: a style can be served by its drums or chords alone.
export const serves = (wants: string, kind: Stratum | null): boolean =>
    kind !== null && (kind === wants || (wants === "style" && (kind === "drums" || kind === "chords")))

export type Knowledge = {
    index(): IndexLine[]
    // The entries that can be applied, and the kind of change each makes (null: it can't be applied).
    applicable(): IndexLine[]
    stratum(key: string): Stratum | null
    // An entry's params, to fill them (null: no entry, or nothing to apply).
    params(key: string): Record<string, Param> | null
    devices(key: string): string[]
    // What the model sees with a message: "key: summary" per entry, a family (group) as one line of its keys.
    compact(lines: IndexLine[]): string[]
    get(keys: string[]): Array<Entry & { draft?: true, linked?: IndexLine[] } | { missing: string }>
    expand(key: string, args: Record<string, unknown>, snapshot: Snapshot): Planned[] | string
    // A pattern entry's notes for a track, in beats ([beat, pitch, beats, velocity 0..1]), and how long it is.
    patternHits(key: string, track: Track, args: Record<string, unknown>, beatsPerBar: number)
        : { hits: Array<[number, number, number, number]>, beats: number, says: string[] } | string
    // A script calling one page helper (scripts/kb.js) with these args; null without the helpers.
    script(call: string, args: unknown): string | null
    // A new drum kit track (Playfield) from TakeDo's samples, or a new sampler track (Nano) playing one sample across the
    // keys, optionally with notes; the edit, or why not. Input as the kit and sampler ops take it.
    kit(input: Record<string, unknown>, snapshot: Snapshot): { code: string, says: string } | string
    sampler(input: Record<string, unknown>, snapshot: Snapshot): { code: string, says: string } | string
    readonly samples: Samples | null
    draft(entry: Record<string, unknown>, by: string): string
    voices(): Record<string, string[]>
    readonly size: number
}

export const loadKnowledge = (dir: string, catalog: Catalog, warn: (text: string) => void = () => {},
    samples: Samples | null = null): Knowledge => {
    const entries = new Map<string, Entry & { draft?: true }>()
    const cartridges = new Map<string, Array<{ name: string, data: Uint8Array }>>()
    const scripts = new Map<string, string>()
    const read = (base: string, draft: boolean): void => {
        if (!existsSync(base)) {return}
        for (const kind of Kinds) {
            const folder = join(base, kind)
            if (!existsSync(folder)) {continue}
            for (const file of readdirSync(folder).filter(name => name.endsWith(".json"))) {
                const key = `${kind}/${basename(file, ".json")}`
                try {
                    const entry = JSON.parse(readFileSync(join(folder, file), "utf8")) as Entry
                    const problems = shape(entry, key)
                    if (problems.length > 0) {throw new Error(problems.join("; "))}
                    if (draft && entries.has(key)) {throw new Error("a reviewed entry has that key")}
                    entries.set(key, draft ? {...entry, draft: true} : entry)
                } catch (error) {
                    if (!draft) {throw new Error(`knowledge ${key}: ${error instanceof Error ? error.message : String(error)}`)}
                    warn(`knowledge draft ${key} skipped: ${error instanceof Error ? error.message : String(error)}`)
                }
            }
        }
    }
    const dx7 = join(dir, "dx7")
    if (existsSync(dx7)) {
        for (const file of readdirSync(dx7).filter(name => name.toLowerCase().endsWith(".syx"))) {
            try {cartridges.set(basename(file, ".syx"), readCartridge(readFileSync(join(dx7, file))))}
            catch (error) {warn(`dx7 ${file} skipped: ${String(error)}`)}
        }
    }
    const scriptDir = join(dir, "scripts")
    if (existsSync(scriptDir)) {
        readdirSync(scriptDir).filter(name => name.endsWith(".js"))
            .forEach(name => scripts.set(basename(name, ".js"), readFileSync(join(scriptDir, name), "utf8")))
    }
    const kbScript = scripts.get("kb") ?? null

    const voice = (id: string): { name: string, data: Uint8Array } | null => {
        const [cartridge, name] = id.split("/", 2)
        const voices = cartridges.get(cartridge)
        if (voices === undefined || name === undefined) {return null}
        return /^\d+$/.test(name) ? voices[Number(name) - 1] ?? null : voices.find(entry => entry.name === name) ?? null
    }
    const parameter = (device: string, path: string): CatalogParameter | null =>
        catalog.device(device)?.parameters.find(param => param.path === path) ?? null
    const inRange = (param: CatalogParameter, value: unknown): boolean =>
        typeof value !== "number" || (value >= param.range[0] && value <= param.range[1])

    // The envelope and anything that can be checked without the other entries.
    const shape = (entry: Entry, key: string): string[] => {
        const problems: string[] = []
        if (entry.key !== key) {problems.push(`key is ${entry.key}, but the file says ${key}`)}
        if (!Kinds.includes(entry.kind) || !key.startsWith(`${entry.kind}/`)) {problems.push(`kind ${entry.kind} doesn't match its folder`)}
        if (typeof entry.summary !== "string" || entry.summary.length === 0) {problems.push("no summary")}
        for (const field of ["tags", "devices", "links", "body"] as const) {
            if (!isStrings(entry[field])) {problems.push(`${field} isn't a list of strings`)}
        }
        if (!isRecord(entry.checked) || !Checks.includes(entry.checked.how)) {problems.push(`checked.how isn't one of ${Checks.join(", ")}`)}
        if (isStrings(entry.devices)) {
            entry.devices.filter(device => catalog.device(device) === null).forEach(device => problems.push(`no device ${device} in the catalog`))
            if (entry.apply !== undefined) {
                entry.devices.filter(device => catalog.device(device)?.allowed === false)
                    .forEach(device => problems.push(`${device} isn't allowed, so an executable entry can't use it`))
            }
        }
        for (const field of entry.fields ?? []) {
            const [device, ...path] = field.split("/")
            if (parameter(device, path.join("/")) === null) {problems.push(`no field ${field} in the catalog`)}
        }
        if (entry.pattern !== undefined) {problems.push(...patternProblems(entry.pattern))}
        if (entry.apply !== undefined) {problems.push(...applyProblems(entry))}
        return problems
    }
    const patternProblems = (pattern: Pattern): string[] => {
        if (!(pattern.beats > 0)) {return ["a pattern needs beats > 0"]}
        if (pattern.type === "drums") {
            return pattern.hits.flatMap(([beat, role, velocity]) => [
                ...(DrumRoles[role] === undefined ? [`unknown drum role ${role} (one of ${Object.keys(DrumRoles).join(", ")})`] : []),
                ...(beat < 0 || beat >= pattern.beats ? [`a ${role} at beat ${beat} is outside the pattern`] : []),
                ...(velocity <= 0 || velocity > 1 ? [`velocity ${velocity} isn't in (0, 1]`] : [])])
        }
        if (pattern.type === "chords") {
            const key = parseKey("C major")!
            return pattern.chords.flatMap(([beat, numeral, beats]) => [
                ...(chordPitches(numeral, key) === null ? [`chord ${numeral} doesn't parse`] : []),
                ...(beat < 0 || beat + beats > pattern.beats + 1e-9 ? [`chord ${numeral} at ${beat} runs past the pattern`] : [])])
        }
        return [`unknown pattern type ${(pattern as { type: string }).type}`]
    }
    const applyProblems = (entry: Entry): string[] => {
        const {apply} = entry
        if (!isRecord(apply) || !isRecord(apply.params) || !Array.isArray(apply.steps)) {return ["apply needs params and steps"]}
        const problems: string[] = []
        Object.entries(apply.params).forEach(([name, param]) => {
            if (!ParamTypes.includes(param.type)) {problems.push(`param ${name} has unknown type ${param.type}`)}
        })
        references(apply.steps).forEach(name => {if (!(name in apply.params)) {problems.push(`$${name} isn't a declared param`)}})
        apply.steps.forEach((step, index) => {
            const where = `step ${index + 1} (${step.op})`
            if (!Ops.includes(step.op)) {problems.push(`${where}: unknown op`); return}
            if (step.when !== undefined && !(step.when in apply.params)) {problems.push(`${where}: when names ${step.when}, not a declared param`)}
            const input = step.input ?? {}
            if (step.op === "add_effect") {
                const device = catalog.device(String(input.effect))
                if (device === null || device.kind !== "audio effect") {problems.push(`${where}: no audio effect ${String(input.effect)}`); return}
                for (const setting of (input.settings ?? []) as Array<{ param: string, value: unknown }>) {
                    const param = parameter(device.key, setting.param)
                    if (param === null) {problems.push(`${where}: ${device.key} has no ${setting.param}`); continue}
                    const ends = isDial(setting.value) ? setting.value.dial : [setting.value]
                    if (!ends.every(end => inRange(param, end))) {problems.push(`${where}: ${device.key} ${setting.param} outside ${param.range.join("..")}`)}
                }
                for (const ramp of (input.then ?? []) as Array<{ param: string, to: unknown }>) {
                    const param = parameter(device.key, ramp.param)
                    if (param === null) {problems.push(`${where}: ${device.key} has no ${ramp.param}`); continue}
                    const ends = isDial(ramp.to) ? ramp.to.dial : [ramp.to]
                    if (!ends.every(end => inRange(param, end))) {problems.push(`${where}: ${device.key} ${ramp.param} ramp outside ${param.range.join("..")}`)}
                }
            }
            if (step.op === "volume") {
                const ends = isDial(input.to_db) ? input.to_db.dial : [input.to_db]
                if (!ends.every(end => typeof end !== "number" || (end >= -60 && end <= 6))) {problems.push(`${where}: to_db outside -60..6`)}
            }
            if (step.op === "instrument") {
                const device = catalog.device(String(input.device))
                if (device === null || device.kind !== "instrument") {problems.push(`${where}: no instrument ${String(input.device)}`); return}
                Object.entries((input.settings ?? {}) as Record<string, unknown>).forEach(([path, value]) => {
                    const param = parameter(device.key, path)
                    if (param === null) {problems.push(`${where}: ${device.key} has no ${path}`)}
                    else if (!inRange(param, value)) {problems.push(`${where}: ${device.key} ${path} = ${String(value)} outside ${param.range.join("..")}`)}
                })
            }
            if (step.op === "dx7" && typeof input.voice === "string" && !input.voice.startsWith("$") && voice(input.voice) === null) {
                problems.push(`${where}: no DX7 voice ${input.voice} (cartridge/voice name, in ${dx7})`)
            }
            if (step.op === "kit") {
                const pads = Array.isArray(input.pads) ? input.pads as Array<Record<string, unknown>> : []
                if (pads.length === 0) {problems.push(`${where}: a kit needs pads: [{role, sample}]`)}
                pads.forEach(pad => {
                    if (DrumRoles[String(pad.role)] === undefined) {problems.push(`${where}: unknown drum role ${String(pad.role)}`)}
                    if (samples !== null && samples.size > 0 && !String(pad.sample).startsWith("$") && samples.find(String(pad.sample)) === null) {
                        problems.push(`${where}: no sample ${String(pad.sample)}`)
                    }
                })
            }
            if (step.op === "sampler" && samples !== null && samples.size > 0 && typeof input.sample === "string"
                && !input.sample.startsWith("$") && samples.find(input.sample) === null) {
                problems.push(`${where}: no sample ${input.sample}`)
            }
            if (step.op === "pattern" && entry.pattern === undefined && typeof input.of !== "string") {
                problems.push(`${where}: no pattern here, and no "of" naming one`)
            }
            if (step.op === "script" && (typeof step.script !== "string" || !scripts.has(step.script))) {
                problems.push(`${where}: no script ${String(step.script)} in ${scriptDir}`)
            }
            if (step.op === "entry" && typeof step.key !== "string") {problems.push(`${where}: no key`)}
        })
        return problems
    }

    read(dir, false)
    read(join(dir, "drafts"), true)

    // What needs every entry: links and entry steps resolve, and entry steps make no cycles.
    const crossProblems = (entry: Entry): string[] => {
        const problems = entry.links.filter(link => !entries.has(link)).map(link => `links to ${link}, which doesn't exist`)
        for (const step of entry.apply?.steps ?? []) {
            const target = step.op === "entry" ? step.key : step.op === "pattern" ? step.input?.of : undefined
            if (typeof target === "string" && !entries.has(target)) {problems.push(`${step.op} step names ${target}, which doesn't exist`)}
        }
        const visit = (key: string, path: string[]): string | null => {
            if (path.includes(key)) {return [...path, key].join(" → ")}
            if (path.length > MaxDepth) {return `${path.join(" → ")} (too deep)`}
            for (const step of entries.get(key)?.apply?.steps ?? []) {
                if (step.op === "entry" && typeof step.key === "string") {
                    const cycle = visit(step.key, [...path, key])
                    if (cycle !== null) {return cycle}
                }
            }
            return null
        }
        const cycle = visit(entry.key, [])
        if (cycle !== null) {problems.push(`entry steps loop: ${cycle}`)}
        return problems
    }
    for (const entry of [...entries.values()]) {
        const problems = crossProblems(entry)
        if (problems.length === 0) {continue}
        if (entry.draft !== true) {throw new Error(`knowledge ${entry.key}: ${problems.join("; ")}`)}
        warn(`knowledge draft ${entry.key} skipped: ${problems.join("; ")}`)
        entries.delete(entry.key)
    }
    const opendaw = catalog.opendaw
    entries.forEach(entry => {
        if (entry.checked.opendaw !== undefined && opendaw !== undefined && !opendaw.startsWith(entry.checked.opendaw.replace(/…$/, ""))) {
            warn(`knowledge ${entry.key} was checked at openDAW ${entry.checked.opendaw}, not the pinned ${opendaw.slice(0, 7)}`)
        }
    })

    const line = (entry: Entry & { draft?: true }): IndexLine =>
        ({key: entry.key, summary: entry.summary, tags: entry.tags, ...(entry.draft ? {draft: true as const} : {}),
            ...(entry.group !== undefined ? {group: entry.group} : {}), ...(entry.label !== undefined ? {label: entry.label} : {})})

    // ---------- expansion ----------

    const trackOf = (snapshot: Snapshot, ref: unknown): Track | null =>
        typeof ref === "string" ? snapshot.tracks.find(track => track.ref === ref) ?? null : null

    // Where a pattern goes when the caller doesn't say: the bars the track's regions cover, else the loop, else the
    // bars the other parts cover. With the loop off (a take: the song plays straight through), from just ahead of the playhead instead (2026-11-24: a
    // house kit landing at bar 30 was placed over bars 1-16, already played, and never heard).
    const defaultSpan = (snapshot: Snapshot, track: Track | null, minBars: number): { from: number, bars: number } => {
        if (snapshot.playback.playing && !snapshot.playback.loop.on) {return {from: snapshot.playback.bar + 2, bars: Math.max(minBars, 16)}}
        if (track?.bars) {return {from: track.bars.from, bars: Math.max(minBars, track.bars.to - track.bars.from + 1)}}
        const covered = snapshot.tracks.flatMap(other => other.bars === null ? [] : [other.bars])
        if (covered.length > 0) {
            const from = Math.min(...covered.map(bars => bars.from)), to = Math.max(...covered.map(bars => bars.to))
            return {from, bars: Math.max(minBars, to - from + 1)}
        }
        return {from: 1, bars: minBars}
    }

    // A pattern's notes, for a track, as [beat, pitch, beats, velocity], with the bars they span.
    const patternNotes = (pattern: Pattern, track: Track | null, input: Record<string, unknown>, beatsPerBar: number)
        : { notes: Array<[number, number, number, number]>, says: string[] } | string => {
        if (pattern.type === "drums") {
            if (track === null) {return "drum patterns go on an existing drum track (a kit's pads say which note is which drum)"}
            const mapped = drumMap(new Set(pattern.hits.map(([, role]) => role)), track)
            if (typeof mapped === "string") {return mapped}
            return {notes: pattern.hits.map(([beat, role, velocity]) => [beat, mapped.notes[role], 0.25, velocity]), says: mapped.says}
        }
        const given = parseKey(String(input.key ?? ""))
        if (given === null) {return `a chord pattern needs the project's key ("G major", "A minor"), got ${JSON.stringify(input.key)}`}
        const key = progressionKey(pattern.chords.map(([, numeral]) => numeral), given)
        const octave = typeof input.octave === "number" ? input.octave : 3
        const velocity = pattern.velocity ?? 0.7
        void beatsPerBar
        return {notes: pattern.chords.flatMap(([beat, numeral, beats]) => (chordPitches(numeral, key, octave) ?? [])
            .map(pitch => [beat, pitch, beats * 0.95, velocity] as [number, number, number, number])), says: [`chords in ${key.name}`]}
    }

    // The notes a pattern step (or an instrument's or kit's `notes`) writes, as the page helper takes them: the pattern
    // named by `of`, else the owner's own.
    const notesOf = (input: Record<string, unknown>, track: Track | null, owner: Entry | null, snapshot: Snapshot)
        : Record<string, unknown> | string => {
        const beatsPerBar = snapshot.timeline.signature[0]
        const source = typeof input.of === "string" ? entries.get(input.of) : owner
        if (source?.pattern === undefined) {return typeof input.of === "string" ? `no pattern entry ${input.of}` : `${owner?.key ?? "notes"}: no pattern to write`}
        const written = patternNotes(source.pattern, track, input, beatsPerBar)
        if (typeof written === "string") {return written}
        const loopBars = Math.max(1, Math.ceil(source.pattern.beats / beatsPerBar))
        const span = defaultSpan(snapshot, track, loopBars)
        const from = typeof input.from_bar === "number" && input.from_bar > 0 ? input.from_bar : span.from
        const bars = typeof input.bars === "number" && input.bars > 0 ? input.bars : span.bars
        return {from_bar: from, bars, loop_bars: loopBars, name: source.key.split("/")[1], notes: written.notes,
            says: written.says}
    }

    const helper = (call: string, args: unknown): string | null => kbScript === null ? null
        : `const args = ${JSON.stringify(args)};\n${kbScript}\nreturn kb.${call}(args)`
    const sampleLabel = (sample: { machine: string | null, id: string }): string => `${sample.machine ?? ""} ${sample.id.split("/").pop()}`.trim()
    const volumeOf = (value: unknown): number | null => typeof value === "number" && value >= -60 && value <= 6 ? value : null
    // Notes go in when `notes` names a pattern (`of`), or when the owner has one; a null `of` (an unset param) means none.
    const wantsNotes = (input: Record<string, unknown>, owner: Entry | null): input is Record<string, unknown> & { notes: Record<string, unknown> } =>
        isRecord(input.notes) && (typeof input.notes.of === "string" || (input.notes.of === undefined && owner?.pattern !== undefined))
    const kitPlan = (input: Record<string, unknown>, snapshot: Snapshot, owner: Entry | null): { code: string, says: string } | string => {
        if (kbScript === null) {return "the knowledge base's page helpers (scripts/kb.js) are missing"}
        if (samples === null || samples.size === 0) {return "no sample collections here (make samples)"}
        const pads = Array.isArray(input.pads) ? input.pads as Array<Record<string, unknown>> : []
        if (pads.length === 0) {return "a kit needs pads: [{role, sample}]"}
        const resolved: Array<{ note: number, uuid: string, name: string, duration: number, exclude: boolean }> = []
        for (const pad of pads) {
            const role = String(pad.role)
            if (DrumRoles[role] === undefined) {return `unknown drum role ${role} (one of ${Object.keys(DrumRoles).join(", ")})`}
            const sample = samples.find(String(pad.sample))
            if (sample === null) {return `no sample ${String(pad.sample)} (find them with samples; ids look like RolandTR808/bd/BD0010)`}
            resolved.push({note: 60 + resolved.length, uuid: sample.uuid, name: `${RoleLabels[role]} (${sampleLabel(sample)})`,
                duration: sample.duration, exclude: role === "closed_hat" || role === "open_hat"})
        }
        const name = typeof input.name === "string" && input.name !== "" ? input.name : typeof input.default_name === "string" ? input.default_name : "Kit"
        let notes: Record<string, unknown> | null = null
        if (wantsNotes(input, owner)) {
            const track = {ref: "new", name, bars: null, device: {content: {pads: resolved.map(pad => ({note: pad.note, name: pad.name}))}}} as unknown as Track
            const written = notesOf(input.notes, track, owner, snapshot)
            if (typeof written === "string") {return written}
            notes = written
        }
        return {code: helper("kit", {name, pads: resolved, volume_db: volumeOf(input.volume_db), notes})!,
            says: `${name}: a new kit track (${resolved.map(pad => pad.name).join(", ")})${notes === null ? ""
                : `, ${String(notes.name)} from bar ${String(notes.from_bar)}`}`}
    }
    const samplerPlan = (input: Record<string, unknown>, snapshot: Snapshot, owner: Entry | null): { code: string, says: string } | string => {
        if (kbScript === null) {return "the knowledge base's page helpers (scripts/kb.js) are missing"}
        if (samples === null || samples.size === 0) {return "no sample collections here (make samples)"}
        const sample = samples.find(String(input.sample))
        if (sample === null) {return `no sample ${String(input.sample)} (find them with samples; ids look like RolandTR808/bd/BD0010)`}
        const root = typeof input.root_key === "number" ? Math.round(input.root_key) : 60
        if (root < 0 || root > 127) {return "root_key is a MIDI note, 0..127"}
        const name = typeof input.name === "string" && input.name !== "" ? input.name
            : typeof input.default_name === "string" ? input.default_name : sampleLabel(sample)
        let notes: Record<string, unknown> | null = null
        if (isRecord(input.notes) && Array.isArray(input.notes.notes)) {
            // Notes as written: [beat, pitch, beats, velocity 0..1], looping every loop_bars.
            const given = input.notes, loopBars = typeof given.loop_bars === "number" && given.loop_bars > 0 ? given.loop_bars : 1
            const span = defaultSpan(snapshot, null, loopBars)
            notes = {from_bar: typeof given.from_bar === "number" && given.from_bar > 0 ? given.from_bar : span.from,
                bars: typeof given.bars === "number" && given.bars > 0 ? given.bars : span.bars, loop_bars: loopBars, name, notes: given.notes}
        } else if (wantsNotes(input, owner)) {
            const written = notesOf(input.notes, null, owner, snapshot)
            if (typeof written === "string") {return written}
            notes = written
        }
        const settings: Record<string, number> = {}
        for (const field of ["release", "attack", "volume", "tune"] as const) {
            if (typeof input[field] === "number") {settings[field] = input[field] as number}
        }
        return {code: helper("sampler", {name, uuid: sample.uuid, file_name: sampleLabel(sample), duration: sample.duration,
                root_key: root, settings, volume_db: volumeOf(input.volume_db), notes})!,
            says: `${name}: a new sampler track playing ${sampleLabel(sample)} across the keys (root ${root})`}
    }

    const expand = (key: string, given: Record<string, unknown>, snapshot: Snapshot, depth = 0, at = 0): Planned[] | string => {
        const entry = entries.get(key)
        if (entry === undefined) {return `no entry ${key}`}
        if (entry.apply === undefined) {return `${key} has nothing to apply: read it with knowledge and act on it yourself`}
        if (depth > MaxDepth) {return `${key}: entries nest too deep`}
        // The params: given, else defaults; tracks must exist; amount 0..3.
        const args: Record<string, unknown> = {}
        for (const [name, param] of Object.entries(entry.apply.params)) {
            const value = given[name] ?? param.default ?? null
            if (value === null || value === undefined || value === "") {
                if (param.optional === true || param.type === "amount") {args[name] = param.type === "amount" ? DefaultAmount : null; continue}
                return `${key} needs ${name}${param.about ? ` (${param.about})` : ""}`
            }
            if (param.type === "track" && value !== "master" && trackOf(snapshot, value) === null) {
                return `${key}: ${name} is ${JSON.stringify(value)}, not a track ref (${snapshot.tracks.map(track => track.ref).join(", ")})`
            }
            if (param.type === "amount" && !(typeof value === "number" && value >= 0 && value <= 3)) {return `${key}: amount is 0..3`}
            if (param.type === "number" && typeof value !== "number") {return `${key}: ${name} must be a number`}
            if (param.type === "key" && parseKey(String(value)) === null) {return `${key}: ${name} isn't a key ("G major", "F# minor")`}
            args[name] = value
        }
        const amount = typeof args.amount === "number" ? args.amount : DefaultAmount
        const fill = (value: unknown): unknown => {
            if (typeof value === "string" && /^\$\w+$/.test(value)) {return args[value.slice(1)] ?? null}
            if (isDial(value)) {
                const [from, to] = value.dial, exact = from + (to - from) * amount / 3
                return Number.isInteger(from) && Number.isInteger(to) ? Math.round(exact) : Number(exact.toFixed(4))
            }
            if (Array.isArray(value)) {return value.map(fill)}
            if (isRecord(value)) {return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, fill(item)]))}
            return value
        }
        const planned: Planned[] = []
        const script = helper
        const notesFor = (input: Record<string, unknown>, track: Track | null, owner: Entry) => notesOf(input, track, owner, snapshot)
        for (const step of entry.apply.steps) {
            if (step.when !== undefined && args[step.when] === null) {continue}
            const stepAt = at + (typeof step.at === "number" ? step.at : 0)
            const input = fill(step.input ?? {}) as Record<string, unknown>
            if ((FixedOps as readonly string[]).includes(step.op)) {
                const defaults: Record<string, unknown> = step.op === "add_effect" ? {settings: [], then: []}
                    : step.op === "volume" || step.op === "pan" || step.op === "set_param" ? {over_beats: 0} : {}
                planned.push({at: stepAt, kind: "op", name: step.op, input: {...defaults, ...input}, says: `${step.op} (${entry.key})`})
                continue
            }
            if (step.op === "entry") {
                const nested = expand(String(step.key), fill(step.args ?? {}) as Record<string, unknown>, snapshot, depth + 1, stepAt)
                if (typeof nested === "string") {return nested}
                planned.push(...nested)
                continue
            }
            if (kbScript === null) {return "the knowledge base's page helpers (scripts/kb.js) are missing"}
            const track = trackOf(snapshot, input.track)
            if (step.op === "pattern") {
                if (track === null) {return `${entry.key}: a pattern needs an existing track (got ${JSON.stringify(input.track)})`}
                const notes = notesFor(input, track, entry)
                if (typeof notes === "string") {return notes}
                planned.push({at: stepAt, kind: "script", code: script("pattern", {track: track.ref, notes})!,
                    says: `${entry.key.split("/")[1]} on ${track.name}, bars ${String(notes.from_bar)}–${Number(notes.from_bar) + Number(notes.bars) - 1}`})
                continue
            }
            if (step.op === "dx7" || step.op === "instrument") {
                const notes = isRecord(input.notes) ? notesFor(input.notes, track, entry) : null
                if (typeof notes === "string") {return notes}
                const name = typeof input.name === "string" && input.name !== "" ? input.name : null
                if (step.op === "dx7") {
                    const found = voice(String(input.voice))
                    if (found === null) {return `no DX7 voice ${String(input.voice)}`}
                    planned.push({at: stepAt, kind: "script", says: `${found.name}${track ? ` on ${track.name}` : " on a new Tubular track"}`,
                        code: script("dx7", {track: track?.ref ?? null, voice: [...found.data], voice_name: found.name, name,
                            volume_db: input.volume_db ?? null, notes})!})
                } else {
                    const device = catalog.device(String(input.device))
                    if (device === null) {return `no instrument ${String(input.device)}`}
                    const settings = input.settings as Record<string, number> | undefined ?? {}
                    const outside = Object.entries(settings).filter(([path, value]) => {
                        const param = parameter(device.key, path)
                        return param === null || !inRange(param, value)
                    })
                    if (outside.length > 0) {return `${entry.key}: ${outside.map(([path, value]) => `${path} = ${value}`).join(", ")} unknown or out of range for ${device.key}`}
                    planned.push({at: stepAt, kind: "script", says: `${device.name}${track ? ` on ${track.name}` : " on a new track"} set up`,
                        code: script("instrument", {track: track?.ref ?? null, factory: device.factory, settings, name,
                            volume_db: input.volume_db ?? null, notes})!})
                }
                continue
            }
            if (step.op === "kit" || step.op === "sampler") {
                const made = (step.op === "kit" ? kitPlan : samplerPlan)(input, snapshot, entry)
                if (typeof made === "string") {return `${entry.key}: ${made}`}
                planned.push({at: stepAt, kind: "script", ...made})
                continue
            }
            if (step.op === "tempo") {
                const bpm = Number(input.bpm)
                if (!(bpm >= 30 && bpm <= 300)) {return `${entry.key}: tempo ${String(input.bpm)} isn't 30..300 BPM`}
                planned.push({at: stepAt, kind: "script", code: script("tempo", {bpm})!, says: `tempo → ${bpm}`})
                continue
            }
            if (step.op === "script") {
                const body = scripts.get(String(step.script))
                if (body === undefined) {return `no script ${String(step.script)}`}
                planned.push({at: stepAt, kind: "script", says: `${String(step.script)} (${entry.key})`,
                    code: `const args = ${JSON.stringify(fill(step.args ?? {}))};\n${kbScript}\n${body}`})
                continue
            }
            return `${entry.key}: unknown op ${step.op}`
        }
        return planned
    }

    return {
        get size() {return entries.size},
        index: () => [...entries.values()].sort((a, b) => a.key.localeCompare(b.key)).map(line),
        applicable: () => [...entries.values()].filter(entry => stratumOf(entry) !== null)
            .sort((a, b) => a.key.localeCompare(b.key)).map(line),
        stratum: key => {const entry = entries.get(key); return entry === undefined ? null : stratumOf(entry)},
        params: key => entries.get(key)?.apply?.params ?? null,
        devices: key => entries.get(key)?.devices ?? [],
        compact: lines => {
            const groups = new Map<string, IndexLine[]>()
            const out: string[] = []
            lines.forEach(entry => {
                if (entry.group === undefined || entry.draft) {
                    out.push(`${entry.key}: ${entry.summary}${entry.draft ? " (draft)" : ""}`)
                    return
                }
                if (!groups.has(entry.group)) {
                    groups.set(entry.group, [])
                    out.push(`\u0000${entry.group}`)
                }
                groups.get(entry.group)!.push(entry)
            })
            // A family: its keys' shared start once ("pattern/prog-pop-*"), then each key's rest and label.
            const family = (name: string): string => {
                const members = groups.get(name)!
                const keys = members.map(member => member.key)
                let prefix = keys.reduce((shared, key) => {
                    let length = 0
                    while (length < shared.length && shared[length] === key[length]) {length++}
                    return shared.slice(0, length)
                })
                prefix = prefix.slice(0, prefix.lastIndexOf("-") + 1) || prefix.slice(0, prefix.lastIndexOf("/") + 1)
                return `${name}: ${prefix}* = ${members.map(member =>
                    `${member.key.slice(prefix.length)}${member.label ? ` (${member.label})` : ""}`).join(", ")}`
            }
            return out.map(text => text.startsWith("\u0000") ? family(text.slice(1)) : text)
        },
        get: keys => keys.map(key => {
            const entry = entries.get(key)
            if (entry === undefined) {return {missing: key}}
            const linked = entry.links.flatMap(link => {
                const other = entries.get(link)
                return other === undefined ? [] : [line(other)]
            })
            return {...entry, ...(linked.length > 0 ? {linked} : {})}
        }),
        expand: (key, args, snapshot) => expand(key, args, snapshot),
        patternHits: (key, track, args, beatsPerBar) => {
            const pattern = entries.get(key)?.pattern
            if (pattern === undefined) {return `${key} isn't a pattern entry`}
            const written = patternNotes(pattern, track, args, beatsPerBar)
            return typeof written === "string" ? written : {hits: written.notes, beats: pattern.beats, says: written.says}
        },
        script: helper,
        // A kit's notes may be hits by role written here ({hits: [[beat, role, velocity]], beats}) rather than a pattern entry.
        kit: (input, snapshot) => {
            const given = isRecord(input.notes) && Array.isArray(input.notes.hits) ? input.notes : null
            if (given === null) {return kitPlan(input, snapshot, null)}
            const pattern: Pattern = {type: "drums", beats: Number(given.beats) || snapshot.timeline.signature[0], hits: given.hits as Array<[number, string, number]>}
            const problems = patternProblems(pattern)
            if (problems.length > 0) {return problems.slice(0, 5).join("; ")}
            const {hits: _hits, beats: _beats, ...rest} = given
            return kitPlan({...input, notes: rest}, snapshot, {key: "pattern/written", pattern} as Entry)
        },
        sampler: (input, snapshot) => samplerPlan(input, snapshot, null),
        samples,
        voices: () => Object.fromEntries([...cartridges].map(([name, voices]) => [name, voices.map(entry => entry.name)])),
        // An agent's entry, kept as a draft until a person reviews it. Returns what happened, for the model.
        draft: (input, by) => {
            const kind = String(input.kind), name = String(input.name ?? "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "")
            if (!Kinds.includes(kind as Kind)) {return `Not kept: kind must be one of ${Kinds.join(", ")}.`}
            if (name.length === 0) {return "Not kept: give it a name (letters, digits and dashes)."}
            const key = `${kind}/${name}`
            if (entries.has(key) && entries.get(key)!.draft !== true) {return `Not kept: ${key} exists and has been reviewed; choose another name.`}
            const entry = {
                key, kind: kind as Kind, summary: String(input.summary ?? ""), tags: isStrings(input.tags) ? input.tags : [],
                devices: isStrings(input.devices) ? input.devices : [], links: isStrings(input.links) ? input.links : [],
                checked: {how: "written" as const, by, date: new Date().toISOString().slice(0, 10), opendaw: (opendaw ?? "").slice(0, 7)},
                body: isStrings(input.body) ? input.body : typeof input.body === "string" ? [input.body] : [],
                ...(isRecord(input.apply) ? {apply: input.apply as Apply} : {}),
                ...(isRecord(input.pattern) ? {pattern: input.pattern as Pattern} : {})
            } satisfies Entry
            const problems = [...shape(entry, key), ...crossProblems(entry)]
            if (problems.length > 0) {return `Not kept: ${problems.join("; ")}.`}
            const folder = join(dir, "drafts", kind)
            mkdirSync(folder, {recursive: true})
            writeFileSync(join(folder, `${name}.json`), `${JSON.stringify(entry, null, 2)}\n`)
            entries.set(key, {...entry, draft: true})
            return `Kept as draft ${key}; it's in the index from now on, marked as a draft.`
        }
    }
}

// ---------- shortlist ----------

// The cheap prefilter before a pick (KNOWLEDGE.md, "Interface for Jev"): entries ranked by the words they share with
// a message, rarer words counting more. Words come from the key, summary, tags, group and label; a hyphenated or
// spaced pair also counts joined ("lo-fi", "hip hop", "boom bap"), and a few producer words map to the entries'.
const Stop = new Set(["a", "an", "the", "and", "or", "of", "to", "in", "on", "for", "with", "it", "this", "that", "is",
    "be", "can", "we", "you", "i", "me", "my", "please", "make", "more", "some", "give", "add", "get", "like", "want",
    "bit", "little", "into", "up", "go", "let", "lets", "s", "its", "use", "put", "would", "could", "do", "so", "all",
    "bar", "bars", "1", "2", "3", "4", "one", "two", "track", "sound", "sounds", "feel", "pattern", "style", "thing"])
const Synonyms: Record<string, string[]> = {
    echo: ["delay"], delay: ["echo"], reverb: ["room", "space", "hall"], verb: ["room", "space"], room: ["reverb"],
    radio: ["telephone"], phone: ["telephone"], tape: ["lofi", "worn"], dusty: ["dust", "lofi"], dust: ["lofi"],
    vintage: ["tape", "lofi"], old: ["vintage", "tape"], record: ["vinyl", "lofi"], vinyl: ["lofi"], chill: ["lofi"],
    study: ["lofi"], rhodes: ["e-piano", "epiano"], piano: ["keys"], keys: ["piano"], organ: ["drawbars"],
    sub: ["bass"], pad: ["pads"], chords: ["progression", "chord"], chord: ["progression", "chords"],
    progression: ["chords"], changes: ["progression", "chords"], vamp: ["chords"], beat: ["drums", "groove"],
    drums: ["beat", "groove"], groove: ["beat"], fill: ["fills"], roll: ["fill"], swing: ["swung", "shuffle"],
    shuffle: ["swing", "swung"], halftime: ["half-time"], dembow: ["reggaeton"], tremolo: ["pulse"], pulse: ["tremolo"],
    funky: ["funk"], jazzy: ["jazz"], soulful: ["soul"], vibraphone: ["vibes"], vibe: ["vibes"], epic: ["minor"], poppy: ["pop"]
}
const stem = (word: string): string => word.length > 5 && word.endsWith("ier") ? `${word.slice(0, -3)}y`
    : word.length > 4 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word
const wordsOf = (text: string): string[] => {
    // "drum and bass" is one word, or every drum message would find it.
    const raw = text.toLowerCase().replace(/[’']/g, "").replace(/drum[\s-]*(and|&|n)[\s-]*bass/g, "dnb").split(/[^a-z0-9&]+/).filter(word => /[a-z]/.test(word))
    const words = raw.map(stem)
    const joined = raw.slice(1).map((word, at) => stem(raw[at] + word))
    return [...words, ...joined]
}

const PerFamily = 3
export const shortlist = (index: IndexLine[], message: string, limit = 12): Array<{ line: IndexLine, score: number }> => {
    const taken = new Map<string, number>()
    // A word in the key's name counts double: it's what the entry is.
    const names = index.map(line => new Set(wordsOf(line.key.replace(/^[a-z]+\//, ""))))
    const whole = index.map(line => line.key.replace(/^[a-z]+\//, "").replace(/-/g, ""))
    const fields = index.map((line, at) => new Set([...names[at], ...wordsOf([line.summary, ...line.tags,
        line.group ?? "", line.label ?? ""].join(" "))]))
    const frequency = new Map<string, number>()
    fields.forEach(words => words.forEach(word => frequency.set(word, (frequency.get(word) ?? 0) + 1)))
    const weight = (word: string): number => Math.log((index.length + 1) / ((frequency.get(word) ?? 0) + 0.5))
    const asked = new Map<string, number>()
    for (const word of wordsOf(message).filter(word => !Stop.has(word))) {
        asked.set(word, 1)
        for (const synonym of Synonyms[word] ?? []) {if (!asked.has(synonym)) {asked.set(stem(synonym), 0.6)}}
    }
    return index.map((line, at) => ({line, score: [...asked].reduce((sum, [word, share]) =>
            fields[at].has(word) ? sum + share * weight(word) * (names[at].has(word) ? 2 : 1) : sum, 0)
            // The whole name asked for ("lofi" → production/lofi, "boom bap" → genre/boom-bap) wins its ties.
            + (asked.get(whole[at]) === 1 ? weight(whole[at]) : 0)}))
        .filter(({score}) => score > 0)
        .sort((a, b) => b.score - a.score || a.line.key.localeCompare(b.line.key))
        // At most PerFamily from one family, so 17 jazz drum grooves don't crowd out the jazz chords.
        .filter(({line}) => line.group === undefined || (taken.set(line.group, (taken.get(line.group) ?? 0) + 1).get(line.group)! <= PerFamily))
        .slice(0, limit)
}
