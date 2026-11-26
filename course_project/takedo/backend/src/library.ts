import {existsSync, readFileSync, renameSync, statSync, writeFileSync} from "node:fs"
import type {DrumEntry, DrumPiece, Genre, LibraryDrum, LibraryEntry, LibrarySound, SoundRole, StyleGuess} from "../../shared/protocol.ts"
import {guessDrum, guessSound} from "./soundStyles.ts"
import type {Sample, Samples, Sound} from "./samples.ts"
import type {Hit} from "./generate.ts"
import {chordHits, drumHits, melodyHits} from "./compose.ts"

// The producer's sound library (2026-11-26, the producer: the sounds agents picked were the worst so far, so they filter,
// tune and tag them by ear in the Sounds tab). Each instrument sound may have the producer's entry: kept or rejected,
// the roles and tags they gave it, and its tuning (level, octave, register, tone, a character effect). Agents never use a
// rejected sound, pick kept ones first with their tuning, and an unheard one only when a role has none kept. Stored in
// knowledge/sound-library.json, checked in, so the listening survives and travels.

// A General MIDI program's family as a role (programs in eights: pianos, chromatic percussion, organs, ...).
const Families: Array<[string, SoundRole[]]> = [["piano", ["keys"]], ["chromatic percussion", ["bells", "keys"]], ["organ", ["keys"]],
    ["guitar", ["guitar"]], ["bass", ["bass"]], ["strings", ["strings", "pad"]], ["ensemble", ["strings", "pad"]], ["brass", ["brass"]],
    ["reed", ["lead"]], ["pipe", ["lead"]], ["synth lead", ["lead"]], ["synth pad", ["pad"]], ["synth effects", ["pad", "other"]],
    ["ethnic", ["lead", "other"]], ["percussive", ["percussion"]], ["sound effects", ["other"]]]

// A General MIDI drum kit (GeneralUser GS's banks 120 and 128): a whole kit as one instrument.
const kitRoles = (name: string): SoundRole[] => /sfx/i.test(name) ? ["other"] : /orchestra/i.test(name) ? ["percussion"] : ["drums"]

export const familyOf = (sound: Sound): string => {
    if (sound.source === "preset") {return `openDAW ${sound.device ?? "synth"} preset`}
    if (sound.soundfont === "GeneralUser GS" && sound.bank >= 120) {return "General MIDI drum kit"}
    if (sound.soundfont === "HS TB-303") {return "TB-303"}
    if (sound.program < 0 || sound.program > 127) {return "other"}
    return Families[Math.floor(sound.program / 8)][0]
}

// The roles a sound is likely for, before the producer says: its General MIDI family, else words in its name.
export const guessRoles = (sound: Sound): SoundRole[] => {
    if (sound.source === "soundfont" && sound.soundfont === "GeneralUser GS" && sound.bank >= 120) {return kitRoles(sound.preset)}
    if (sound.source === "soundfont" && sound.soundfont === "GeneralUser GS" && sound.program >= 0 && sound.program < 128) {
        return Families[Math.floor(sound.program / 8)][1]
    }
    const name = `${sound.preset} ${sound.about ?? ""}`.toLowerCase()
    const roles: SoundRole[] = []
    if (/bass|303|woofer/.test(name)) {roles.push("bass")}
    if (/piano|rhodes|organ|b3|leslie|clav|key/.test(name)) {roles.push("keys")}
    if (/pad|dream|galaxy|shimmer|thoughts|hollow|vibration|air/.test(name)) {roles.push("pad")}
    if (/lead|square|saw|pluck|pipe|flute|zelda/.test(name)) {roles.push("lead")}
    if (/string/.test(name)) {roles.push("strings")}
    if (/brass/.test(name)) {roles.push("brass")}
    if (/guitar/.test(name)) {roles.push("guitar")}
    if (/xylophone|glas|bell|harp|dingl/.test(name)) {roles.push("bells")}
    if (/\bkit\b|drum ?kit|drums/.test(name)) {roles.push("drums")}
    if (/perc|conga|bongo|timbal|taiko|tabla/.test(name)) {roles.push("percussion")}
    return roles.length > 0 ? roles : ["other"]
}

// A drum sample's piece in a kit, from its role in the collections (samples/manifest.json).
const Pieces: Record<string, DrumPiece> = {kick: "kick", snare: "snare", sd2: "snare", rim: "rim", clap: "clap", "closed hat": "closed_hat",
    "open hat": "open_hat", ride: "ride", crash: "crash", "low tom": "tom_low", "mid tom": "tom_mid", "high tom": "tom_high",
    shaker: "shaker", tambourine: "shaker", cowbell: "perc", percussion: "perc"}
export const pieceOf = (sample: Sample): DrumPiece => Pieces[(sample.role ?? "").toLowerCase()] ?? "other"
// The role a piece plays as on a kit's pad (other: as perc).
export const padRole = (piece: DrumPiece): string => piece === "other" ? "perc" : piece

// A guess the producer's own words speak against (Warm Pad, kept but "cheesy", was guessed lofi): no style guessed.
const Against = /cheesy|harsh|thin|cheap|fake|ugly|bad|awful|tinny|plastic|video ?game|donkey kong/i
const doubted = (guess: StyleGuess, entry: { tags: string[], note: string } | null): StyleGuess =>
    entry !== null && Against.test(`${entry.tags.join(" ")} ${entry.note}`)
        ? {styles: [], moods: [...new Set([...guess.moods, "cheesy" as const])]} : guess

// The order agents see sounds in: the role first, then the style, then the producer's keeping.
const tier = (kept: boolean, fitsRole: boolean, fitsStyle: boolean): number =>
    (fitsRole ? 0 : 4) + (fitsStyle ? 0 : 2) + (kept ? 0 : 1)

type Stored = { sounds: Record<string, LibraryEntry>, drums?: Record<string, DrumEntry> }

export class Library {
    readonly #path: string
    readonly #samples: Samples
    #entries: Record<string, LibraryEntry>
    #drums: Record<string, DrumEntry>
    #allSamples: Sample[] | null = null

    #loaded = 0
    #checked = 0

    constructor(path: string, samples: Samples) {
        this.#path = path
        this.#samples = samples
        this.#entries = {}
        this.#drums = {}
        this.#load()
    }

    // The file as it is on disk, read again when it changed there (a git checkout, the sounds probe putting it back),
    // looked at no more than once a second.
    #load(): void {
        const stored: Stored = existsSync(this.#path) ? JSON.parse(readFileSync(this.#path, "utf8")) as Stored : {sounds: {}}
        this.#entries = stored.sounds ?? {}
        this.#drums = stored.drums ?? {}
        this.#loaded = existsSync(this.#path) ? statSync(this.#path).mtimeMs : 0
        this.#checked = Date.now()
    }
    #fresh(): void {
        if (Date.now() - this.#checked < 1000) {return}
        this.#checked = Date.now()
        const changed = existsSync(this.#path) ? statSync(this.#path).mtimeMs : 0
        if (changed !== this.#loaded) {
            try {this.#load()} catch {/* half-written by hand: keep what's loaded */}
        }
    }

    #write(): void {
        const sorted = <T>(record: Record<string, T>) => Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)))
        writeFileSync(`${this.#path}.tmp`, `${JSON.stringify({sounds: sorted(this.#entries), drums: sorted(this.#drums)}, null, 1)}\n`)
        renameSync(`${this.#path}.tmp`, this.#path)
        this.#loaded = statSync(this.#path).mtimeMs
    }
    get #all(): Sample[] {return this.#allSamples ??= this.#samples.search({}, Number.MAX_SAFE_INTEGER)}

    entry(id: string): LibraryEntry | null {
        this.#fresh()
        return this.#entries[id] ?? null
    }

    // Every instrument sound with its family, roles (the producer's, else guessed) and entry.
    list(): LibrarySound[] {
        return this.#samples.sounds.map(sound => {
            const entry = this.entry(sound.id)
            return {id: sound.id, source: sound.source, family: familyOf(sound), bank: sound.bank,
                roles: entry !== null && entry.roles.length > 0 ? entry.roles : guessRoles(sound), entry, guess: doubted(guessSound(sound), entry)}
        })
    }

    // The producer's verdict and tuning for one sound (null: forget it, back to unheard). Written at once.
    set(id: string, entry: LibraryEntry | null): string | null {
        if (this.#samples.sound(id) === null) {return `no sound ${id}`}
        this.#fresh()
        if (entry === null) {delete this.#entries[id]} else {this.#entries[id] = entry}
        this.#write()
        return null
    }

    // What a sound is good for: the producer's styles and moods once they saved some, else the guess; confirmed says which.
    styles(sound: Sound): StyleGuess & { confirmed: boolean } {
        const entry = this.entry(sound.id)
        if (entry?.styles !== undefined) {return {styles: entry.styles, moods: entry.moods ?? [], confirmed: true}}
        return {...doubted(guessSound(sound), entry), confirmed: false}
    }

    // The library sound a track is named after (its name or its device's: "Finger Bass"), the producer's kept one first.
    named(names: string[]): Sound | null {
        const wanted = names.map(name => name.trim().toLowerCase()).filter(name => name !== "")
        const found = this.#samples.sounds.filter(sound => wanted.includes(sound.preset.toLowerCase()))
        return found.find(sound => this.entry(sound.id)?.verdict === "kept") ?? found[0] ?? null
    }

    // How agents rank a sound for a role and a style (null: any): kept and good for both first, then unheard ones that
    // are, then those not for the style, then other roles; never a rejected one. The order key (lower is better) or null.
    rank(sound: Sound, role: SoundRole | null, style: Genre | null = null): number | null {
        const entry = this.entry(sound.id)
        if (entry?.verdict === "rejected") {return null}
        const roles = entry !== null && entry.roles.length > 0 ? entry.roles : guessRoles(sound)
        return tier(entry?.verdict === "kept", role === null || roles.includes(role), style === null || this.styles(sound).styles.includes(style))
    }

    // The producer's own drums for a style (2026-11-26: a drums worker went to a knowledge kit though they had kept kits):
    // whole kits (instruments with the role drums) and how many pieces they've kept samples for. Null when there are none.
    ownDrums(styles: Genre[]): { kits: Sound[], pieces: DrumPiece[] } | null {
        const fits = (rank: number | null) => rank !== null && rank === 0
        const kits = this.#samples.sounds.filter(sound => styles.some(style => fits(this.rank(sound, "drums", style))))
        const pieces = [...new Set(this.#all.filter(sample => this.drumEntry(sample.id)?.verdict === "kept"
            && styles.some(style => this.drumStyles(sample).styles.includes(style))).map(sample => this.piece(sample)))]
        return kits.length === 0 && pieces.length === 0 ? null : {kits, pieces}
    }

    // How many sounds are kept for a role.
    kept(role: SoundRole): number {
        return this.list().filter(sound => sound.entry?.verdict === "kept" && sound.roles.includes(role)).length
    }

    // Drum samples (2026-11-26, the producer: a lofi kit came out as 80s gated drums): the same verdicts, per sample.
    drumEntry(id: string): DrumEntry | null {
        this.#fresh()
        return this.#drums[this.#samples.find(id)?.id ?? id] ?? null
    }
    // A sample's piece: the producer's, else its role in the collections.
    piece(sample: Sample): DrumPiece {return this.drumEntry(sample.id)?.piece ?? pieceOf(sample)}
    drums(): LibraryDrum[] {
        return this.#all.map(sample => ({id: sample.id, machine: sample.machine ?? "other", piece: this.piece(sample),
            duration: sample.duration, entry: this.drumEntry(sample.id), guess: doubted(guessDrum(sample), this.drumEntry(sample.id))}))
    }
    setDrum(id: string, entry: DrumEntry | null): string | null {
        const sample = this.#samples.find(id)
        if (sample === null) {return `no drum sample ${id}`}
        this.#fresh()
        if (entry === null) {delete this.#drums[sample.id]} else {this.#drums[sample.id] = entry}
        this.#write()
        return null
    }
    drumStyles(sample: Sample): StyleGuess & { confirmed: boolean } {
        const entry = this.drumEntry(sample.id)
        if (entry?.styles !== undefined) {return {styles: entry.styles, moods: entry.moods ?? [], confirmed: true}}
        return {...doubted(guessDrum(sample), entry), confirmed: false}
    }
    // As rank, for a drum sample, a piece and a style (null: any).
    rankDrum(sample: Sample, piece: DrumPiece | null, style: Genre | null = null): number | null {
        const entry = this.drumEntry(sample.id)
        if (entry?.verdict === "rejected") {return null}
        return tier(entry?.verdict === "kept", piece === null || this.piece(sample) === piece, style === null || this.drumStyles(sample).styles.includes(style))
    }
    // The producer's kept samples for a piece, those of one machine first, then the latest kept.
    keptDrums(piece: DrumPiece, machine: string | null = null): Sample[] {
        return this.#all.filter(sample => this.drumEntry(sample.id)?.verdict === "kept" && this.piece(sample) === piece)
            .sort((a, b) => Number(b.machine === machine) - Number(a.machine === machine) || this.drumEntry(b.id)!.t - this.drumEntry(a.id)!.t)
    }
    // A sample to stand in for a rejected one: a kept one for its piece (its machine's first), else an unheard one from
    // its machine for that piece; null if there's none.
    standIn(sample: Sample, piece: DrumPiece): Sample | null {
        return this.keptDrums(piece, sample.machine)[0]
            ?? this.#all.find(other => other.machine === sample.machine && this.piece(other) === piece && this.drumEntry(other.id) === null)
            ?? null
    }
    // A sample for a piece around one being auditioned: kept first, else its machine's, else any unheard one.
    backing(piece: DrumPiece, machine: string | null): Sample | null {
        return this.keptDrums(piece, machine)[0]
            ?? this.#all.find(other => other.machine === machine && this.piece(other) === piece && this.drumEntry(other.id)?.verdict !== "rejected")
            ?? this.#all.find(other => this.piece(other) === piece && this.drumEntry(other.id)?.verdict !== "rejected")
            ?? null
    }
}

// What a drum sample plays when the producer auditions it: a beat that features its piece (a kick, snare and hats
// around it), one bar of 16ths looping; alone: its own hits only.
const Grooves: Record<DrumPiece, { line: string, backing: string[] }> = {
    kick: {line: "bd ~ ~ ~ ~ ~ ~ bd ~ ~ bd ~ ~ ~ ~ ~", backing: ["~ ~ ~ ~ sd ~ ~ ~ ~ ~ ~ ~ sd ~ ~ ~", "hh*8"]},
    snare: {line: "~ ~ ~ ~ sd ~ ~ ~ ~ ~ ~ ~ sd ~ ~ sd:0.4", backing: ["bd ~ ~ ~ ~ ~ ~ bd ~ ~ bd ~ ~ ~ ~ ~", "hh*8"]},
    rim: {line: "~ ~ ~ rim ~ ~ rim ~ ~ ~ ~ rim ~ ~ rim ~", backing: ["bd ~ ~ ~ ~ ~ ~ bd ~ ~ bd ~ ~ ~ ~ ~", "hh*8"]},
    clap: {line: "~ ~ ~ ~ cp ~ ~ ~ ~ ~ ~ ~ cp ~ ~ ~", backing: ["bd ~ ~ ~ ~ ~ ~ bd ~ ~ bd ~ ~ ~ ~ ~", "hh*8"]},
    closed_hat: {line: "hh hh:0.5 hh hh:0.5 hh hh:0.5 hh hh:0.6 hh hh:0.5 hh hh:0.5 hh hh:0.5 hh hh:0.7",
        backing: ["bd ~ ~ ~ ~ ~ ~ bd ~ ~ bd ~ ~ ~ ~ ~", "~ ~ ~ ~ sd ~ ~ ~ ~ ~ ~ ~ sd ~ ~ ~"]},
    open_hat: {line: "~ ~ oh ~ ~ ~ oh ~ ~ ~ oh ~ ~ ~ oh ~", backing: ["bd ~ ~ ~ ~ ~ ~ bd ~ ~ bd ~ ~ ~ ~ ~", "~ ~ ~ ~ sd ~ ~ ~ ~ ~ ~ ~ sd ~ ~ ~", "hh ~ ~ ~ hh ~ ~ ~ hh ~ ~ ~ hh ~ ~ ~"]},
    ride: {line: "ride ~ ~ ~ ride ~ ~ ride ride ~ ~ ~ ride ~ ~ ride", backing: ["bd ~ ~ ~ ~ ~ ~ bd ~ ~ bd ~ ~ ~ ~ ~", "~ ~ ~ ~ sd ~ ~ ~ ~ ~ ~ ~ sd ~ ~ ~"]},
    crash: {line: "crash ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~", backing: ["bd ~ ~ ~ ~ ~ ~ bd ~ ~ bd ~ ~ ~ ~ ~", "~ ~ ~ ~ sd ~ ~ ~ ~ ~ ~ ~ sd ~ ~ ~", "hh*8"]},
    tom_low: {line: "~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ lt ~ lt lt", backing: ["bd ~ ~ ~ ~ ~ ~ bd ~ ~ bd ~ ~ ~ ~ ~", "~ ~ ~ ~ sd ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~", "hh hh hh hh hh hh hh hh hh hh hh hh ~ ~ ~ ~"]},
    tom_mid: {line: "~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ mt ~ mt mt", backing: ["bd ~ ~ ~ ~ ~ ~ bd ~ ~ bd ~ ~ ~ ~ ~", "~ ~ ~ ~ sd ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~", "hh hh hh hh hh hh hh hh hh hh hh hh ~ ~ ~ ~"]},
    tom_high: {line: "~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ht ~ ht ht", backing: ["bd ~ ~ ~ ~ ~ ~ bd ~ ~ bd ~ ~ ~ ~ ~", "~ ~ ~ ~ sd ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~", "hh hh hh hh hh hh hh hh hh hh hh hh ~ ~ ~ ~"]},
    shaker: {line: "sh:0.5 sh:0.3 sh:0.8 sh:0.3 sh:0.5 sh:0.3 sh:0.8 sh:0.3 sh:0.5 sh:0.3 sh:0.8 sh:0.3 sh:0.5 sh:0.3 sh:0.8 sh:0.3",
        backing: ["bd ~ ~ ~ ~ ~ ~ bd ~ ~ bd ~ ~ ~ ~ ~", "~ ~ ~ ~ sd ~ ~ ~ ~ ~ ~ ~ sd ~ ~ ~"]},
    perc: {line: "~ ~ perc ~ ~ perc ~ ~ ~ ~ perc ~ ~ perc ~ ~", backing: ["bd ~ ~ ~ ~ ~ ~ bd ~ ~ bd ~ ~ ~ ~ ~", "~ ~ ~ ~ sd ~ ~ ~ ~ ~ ~ ~ sd ~ ~ ~", "hh*8"]},
    other: {line: "~ ~ perc ~ ~ ~ ~ ~ ~ ~ perc ~ ~ ~ ~ ~", backing: ["bd ~ ~ ~ ~ ~ ~ bd ~ ~ bd ~ ~ ~ ~ ~", "~ ~ ~ ~ sd ~ ~ ~ ~ ~ ~ ~ sd ~ ~ ~", "hh*8"]},
}
export const drumAudition = (piece: DrumPiece, alone: boolean, beatsPerBar: number)
    : { hits: Array<[number, string, number]>, beats: number, backing: DrumPiece[] } | string => {
    const groove = Grooves[piece]
    const lines = alone ? [groove.line] : [groove.line, ...groove.backing]
    const made = drumHits({pattern: `[${lines.join(", ")}]`, bars: 1}, beatsPerBar)
    if (typeof made === "string") {return made}
    // The pieces around it, by the words in its backing lines.
    const backing = alone ? [] : (["kick", "snare", "closed_hat"] as DrumPiece[])
        .filter((other, index) => other !== piece && groove.backing.some(line => line.includes(["bd", "sd", "hh"][index])))
    return {hits: made.hits, beats: made.beats, backing}
}

// What a sound plays when the producer auditions it (the Sounds tab): its role's usual part in the project's key, two
// bars looping, written by code as agents' parts are. register: the tuning's range for a line.
export const auditionPhrase = (role: SoundRole, key: string, register: [number, number] | null): { hits: Hit[], beats: number } | string => {
    const range = register === null ? {} : {range: register}
    const line = (pattern: string, where: "low" | "mid" | "high") => melodyHits({pattern, bars: 2, register: where, key, ...range})
    const gm = (hits: Array<[number, number]>) => ({hits: hits.map(([beat, pitch]): Hit => [beat, pitch, 0.25, pitch === 42 || pitch === 70 ? 0.55 : 0.85]), beats: 4})
    const chords = (rhythm: string, voicing: "open" | "spread") =>
        chordHits({progression: "i7:4 VImaj7:4", key, voicing, register: "mid", rhythm})
    switch (role) {
        case "bass": return line("0 _ 0 [2 4] ~ 4 _ 3 5 _ 5 4 ~ 3 _ 2", "low")
        case "keys": case "guitar": return chords("x..x..x.x...x...", "open")
        case "brass": return chords("x...x.....x.x...", "open")
        case "pad": case "strings": return chords("hold", "spread")
        case "lead": return line("4 _ _ 2 3 _ 4 _ 7 _ 6 4 _ _ ~ ~", "mid")
        case "bells": return line("7 4 2 4 7 _ 9 _ 7 4 2 0 2 _ ~ ~", "high")
        // A kit as one instrument: General MIDI drum notes (kick 36, snare 38, closed hat 42, open hat 46; congas, bongos, a shaker).
        case "drums": return gm([[0, 36], [1.75, 36], [2.5, 36], [1, 38], [3, 38], ...[0, 0.5, 1, 1.5, 2, 2.5, 3].map(beat => [beat, 42] as [number, number]), [3.5, 46]])
        case "percussion": return gm([[0, 63], [0.75, 62], [1.5, 64], [2, 60], [2.5, 61], [3, 63], [3.5, 64], ...[0, 1, 2, 3].map(beat => [beat + 0.5, 70] as [number, number])])
        default: return line("0 _ 2 _ 4 _ 2 _ 3 _ 2 _ 0 _ ~ ~", "mid")
    }
}
