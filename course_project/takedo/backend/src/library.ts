import {existsSync, readFileSync, renameSync, writeFileSync} from "node:fs"
import type {LibraryEntry, LibrarySound, SoundRole} from "../../shared/protocol.ts"
import type {Samples, Sound} from "./samples.ts"
import type {Hit} from "./generate.ts"
import {chordHits, melodyHits} from "./compose.ts"

// The producer's sound library (2026-11-26, the producer: the sounds agents picked were the worst so far, so they filter,
// tune and tag them by ear in the Sounds tab). Each instrument sound may have the producer's entry: kept or rejected,
// the roles and tags they gave it, and its tuning (level, octave, register, tone, a character effect). Agents never use a
// rejected sound, pick kept ones first with their tuning, and an unheard one only when a role has none kept. Stored in
// knowledge/sound-library.json, checked in, so the listening survives and travels.

// A General MIDI program's family as a role (programs in eights: pianos, chromatic percussion, organs, ...).
const Families: Array<[string, SoundRole[]]> = [["piano", ["keys"]], ["chromatic percussion", ["bells", "keys"]], ["organ", ["keys"]],
    ["guitar", ["guitar"]], ["bass", ["bass"]], ["strings", ["strings", "pad"]], ["ensemble", ["strings", "pad"]], ["brass", ["brass"]],
    ["reed", ["lead"]], ["pipe", ["lead"]], ["synth lead", ["lead"]], ["synth pad", ["pad"]], ["synth effects", ["pad", "other"]],
    ["ethnic", ["lead", "other"]], ["percussive", ["other"]], ["sound effects", ["other"]]]

export const familyOf = (sound: Sound): string => {
    if (sound.source === "preset") {return `openDAW ${sound.device ?? "synth"} preset`}
    if (sound.soundfont === "HS TB-303") {return "TB-303"}
    if (sound.program < 0 || sound.program > 127) {return "other"}
    return Families[Math.floor(sound.program / 8)][0]
}

// The roles a sound is likely for, before the producer says: its General MIDI family, else words in its name.
export const guessRoles = (sound: Sound): SoundRole[] => {
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
    return roles.length > 0 ? roles : ["other"]
}

type Stored = { sounds: Record<string, LibraryEntry> }

export class Library {
    readonly #path: string
    readonly #samples: Samples
    #entries: Record<string, LibraryEntry>

    constructor(path: string, samples: Samples) {
        this.#path = path
        this.#samples = samples
        this.#entries = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Stored).sounds ?? {} : {}
    }

    entry(id: string): LibraryEntry | null {return this.#entries[id] ?? null}

    // Every instrument sound with its family, roles (the producer's, else guessed) and entry.
    list(): LibrarySound[] {
        return this.#samples.sounds.map(sound => {
            const entry = this.entry(sound.id)
            return {id: sound.id, source: sound.source, family: familyOf(sound), bank: sound.bank,
                roles: entry !== null && entry.roles.length > 0 ? entry.roles : guessRoles(sound), entry}
        })
    }

    // The producer's verdict and tuning for one sound (null: forget it, back to unheard). Written at once.
    set(id: string, entry: LibraryEntry | null): string | null {
        if (this.#samples.sound(id) === null) {return `no sound ${id}`}
        if (entry === null) {delete this.#entries[id]} else {this.#entries[id] = entry}
        const sorted = Object.fromEntries(Object.entries(this.#entries).sort(([a], [b]) => a.localeCompare(b)))
        writeFileSync(`${this.#path}.tmp`, `${JSON.stringify({sounds: sorted}, null, 1)}\n`)
        renameSync(`${this.#path}.tmp`, this.#path)
        return null
    }

    // How agents rank a sound for a role: kept with that role first, then unheard (when the role has nothing kept), and
    // never a rejected one. Returns the order key (lower is better) or null to leave it out.
    rank(sound: Sound, role: SoundRole | null): number | null {
        const entry = this.entry(sound.id)
        if (entry?.verdict === "rejected") {return null}
        const roles = entry !== null && entry.roles.length > 0 ? entry.roles : guessRoles(sound)
        const fits = role === null || roles.includes(role)
        if (entry?.verdict === "kept") {return fits ? 0 : 2}
        return fits ? 1 : 3
    }

    // How many sounds are kept for a role.
    kept(role: SoundRole): number {
        return this.list().filter(sound => sound.entry?.verdict === "kept" && sound.roles.includes(role)).length
    }
}

// What a sound plays when the producer auditions it (the Sounds tab): its role's usual part in the project's key, two
// bars looping, written by code as agents' parts are. register: the tuning's range for a line.
export const auditionPhrase = (role: SoundRole, key: string, register: [number, number] | null): { hits: Hit[], beats: number } | string => {
    const range = register === null ? {} : {range: register}
    const line = (pattern: string, where: "low" | "mid" | "high") => melodyHits({pattern, bars: 2, register: where, key, ...range})
    const chords = (rhythm: string, voicing: "open" | "spread") =>
        chordHits({progression: "i7:4 VImaj7:4", key, voicing, register: "mid", rhythm})
    switch (role) {
        case "bass": return line("0 _ 0 [2 4] ~ 4 _ 3 5 _ 5 4 ~ 3 _ 2", "low")
        case "keys": case "guitar": return chords("x..x..x.x...x...", "open")
        case "brass": return chords("x...x.....x.x...", "open")
        case "pad": case "strings": return chords("hold", "spread")
        case "lead": return line("4 _ _ 2 3 _ 4 _ 7 _ 6 4 _ _ ~ ~", "mid")
        case "bells": return line("7 4 2 4 7 _ 9 _ 7 4 2 0 2 _ ~ ~", "high")
        default: return line("0 _ 2 _ 4 _ 2 _ 3 _ 2 _ 0 _ ~ ~", "mid")
    }
}
