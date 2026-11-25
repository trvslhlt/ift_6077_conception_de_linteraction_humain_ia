import {Chord, Note} from "tonal"
import type {Hit} from "./generate.ts"
import {DrumRoles} from "./knowledge.ts"

// Strudel's mini-notation (pinned 1.2.5: 1.2.6's core imports an audio package that doesn't load in Node), quieted: it
// greets the console on import.
const {mini} = await (async () => {
    const {log, warn} = console
    console.log = console.warn = () => {}
    try {return await import("@strudel/mini")} finally {Object.assign(console, {log, warn})}
})()

// Notes from what a producer would say (2026-11-25, STRATEGY.md "Ordinary code libraries do the domain work; models
// choose"): a worker names the harmony, code writes exact notes. A worker spent most of a job's ~3,000 output tokens
// writing note lists; a progression is one line. tonal (pinned 6.5.1) reads chord names, slash chords included; the
// voicing is here (tonal's voicing dictionaries cover jazz shapes only: no m9 or sus4).

export type Voicing = "close" | "open" | "spread" | "shell"
export type Register = "low" | "mid" | "high"
export type ChordSpec = {
    progression: string             // "Em9:4 Cmaj7:4 Am7:4 B7sus4:4", or numerals in the key: "i9:4 VImaj7:4 iv7:4 V7sus4:4"
    key?: string                    // "E minor": needed for numerals
    voicing: Voicing
    register: Register
    rhythm: string                  // "hold", or a bar of sixteenths: x a hit, X an accent, . a rest ("x...x...x...x...")
    velocity?: number               // 0..1, a plain hit's; an accent is louder
}

// Where a chord's voices sit, MIDI (openDAW's C3 = 60): low for a bass-range pad, mid for keys, high for a top line.
const Registers: Record<Register, [number, number]> = {low: [40, 62], mid: [52, 76], high: [64, 88]}
const PitchClasses = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"]
const Degrees: Record<string, number> = {I: 0, II: 1, III: 2, IV: 3, V: 4, VI: 5, VII: 6}
const Modes: Record<string, number[]> = {major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10]}

export const parseKey = (text: string): { tonic: number, mode: "major" | "minor" } | null => {
    const match = /^\s*([A-Ga-g][#b♯♭]?)\s*(major|minor|maj|min|m)?\s*$/i.exec(text)
    if (match === null) {return null}
    const chroma = Note.chroma(match[1].replace("♯", "#").replace("♭", "b").replace(/^./, letter => letter.toUpperCase()))
    if (chroma === undefined || Number.isNaN(chroma)) {return null}
    return {tonic: chroma, mode: /^(minor|min|m)$/i.test(match[2] ?? "") ? "minor" : "major"}
}

// A Roman numeral in a key as a chord symbol: its case says major or minor ("iv7" in E minor is Am7, where tonal's own
// reading gives A7), its suffix the rest. Without an accidental, degrees follow the key's own scale (VI in E minor is C).
export const numeralChord = (numeral: string, key: { tonic: number, mode: "major" | "minor" }): string | null => {
    const match = /^([b#♭♯]?)(VII|VI|V|IV|III|II|I|vii|vi|v|iv|iii|ii|i)(.*)$/.exec(numeral.trim())
    if (match === null) {return null}
    const [, accidental, roman, rest] = match
    const shift = /[b♭]/.test(accidental) ? -1 : /[#♯]/.test(accidental) ? 1 : 0
    // A flat or sharp is against the major scale, as numerals are usually written (bVI in E minor is C, not B).
    const degree = (shift === 0 ? Modes[key.mode] : Modes.major)[Degrees[roman.toUpperCase()]]
    const root = PitchClasses[(key.tonic + degree + shift + 12) % 12]
    const minor = roman !== roman.toUpperCase()
    const suffix = rest.replace("°", "dim").replace("ø", "m7b5")
    if (!minor || /^(dim|m7b5|sus)/.test(suffix)) {return `${root}${suffix}`}
    return `${root}${suffix === "" ? "m" : suffix.startsWith("maj") ? `mMaj${suffix.slice(3)}` : `m${suffix}`}`
}

type Parsed = { symbol: string, beats: number, classes: number[], root: number, bass: number | null }

// "Em9:4 Cmaj7:4" (a | between bars is allowed and ignored); a chord with no length takes 4 beats.
export const parseProgression = (spec: ChordSpec): Parsed[] | string => {
    const key = spec.key ? parseKey(spec.key) : null
    const tokens = spec.progression.replace(/\|/g, " ").split(/\s+/).filter(token => token !== "")
    if (tokens.length === 0) {return "an empty progression"}
    const parsed: Parsed[] = []
    for (const token of tokens) {
        const [name, length] = token.split(":")
        const beats = length === undefined ? 4 : Number(length)
        if (!(beats > 0)) {return `${token}: its length in beats after the colon isn't a number`}
        const numeral = /^[b#♭♯]?[IViv]/.test(name)     // chord names start with A to G
        if (numeral && key === null) {return `${token}: a Roman numeral needs the key ("E minor")`}
        const symbol = numeral ? numeralChord(name, key!) : name
        const chord = symbol === null ? null : Chord.get(symbol)
        if (chord === null || chord.empty) {return `${token}: not a chord name tonal knows ("Em9", "Cmaj7", "B7sus4", "C/E")`}
        const classes = chord.notes.map(note => Note.chroma(note)).filter((chroma): chroma is number => typeof chroma === "number")
        const bass = chord.bass ? Note.chroma(chord.bass) ?? null : null
        const root = Note.chroma(chord.tonic ?? chord.notes[0]) ?? classes[0]
        parsed.push({symbol: symbol!, beats, classes, root, bass})
    }
    return parsed
}

// Every pitch of the classes inside a range.
const inRange = (classes: number[], [low, high]: [number, number]): number[] => {
    const out: number[] = []
    for (let pitch = low; pitch <= high; pitch++) {if (classes.includes(pitch % 12)) {out.push(pitch)}}
    return out
}

// One voicing of a chord: its tones stacked from a bottom note, close (each the next tone up), then reshaped. Of all the
// bottoms in the register, the one whose centre is nearest the last chord's, so the chords move as little as they can.
const voice = (chord: Parsed, asked: Voicing, register: [number, number], last: number[] | null): number[] => {
    const slash = chord.bass !== null && chord.bass !== chord.root
    const voicing: Voicing = slash && asked === "spread" ? "close" : asked     // a slash chord's own bass goes under it
    const tones = voicing === "shell" ? [chord.classes[0], chord.classes[1], chord.classes[3] ?? chord.classes[2]].filter(tone => tone !== undefined) : chord.classes
    // Close: from the bottom note, each remaining tone at its nearest pitch above (Em9 from G: G B D E F#).
    const stack = (bottom: number): number[] => {
        const pitches = [bottom]
        const left = new Set(tones.filter(tone => tone !== bottom % 12))
        let next = bottom + 1
        while (left.size > 0) {
            if (left.has(next % 12)) {
                pitches.push(next)
                left.delete(next % 12)
            }
            next++
        }
        return pitches
    }
    const shaped = (close: number[]): number[] => {
        if (voicing === "open" && close.length >= 4) {         // drop 2: the second from the top an octave down
            const drop = close[close.length - 2] - 12
            return [drop, ...close.filter((_, index) => index !== close.length - 2)].sort((a, b) => a - b)
        }
        if (voicing === "spread") {                           // the root well under the rest
            const rest = close.filter(pitch => pitch % 12 !== chord.root)
            let root = rest[0] - 1
            while (root % 12 !== chord.root) {root--}
            return [root - 12, ...rest]
        }
        return close
    }
    const candidates = inRange(tones, register).map(bottom => shaped(stack(bottom)))
        .filter(pitches => pitches[0] >= register[0] - (voicing === "spread" ? 12 : 0) && pitches[pitches.length - 1] <= register[1] + 2)
    if (candidates.length === 0) {return shaped(stack(inRange(tones, register)[0] ?? register[0]))}
    const centre = (pitches: number[]) => pitches.reduce((sum, pitch) => sum + pitch, 0) / pitches.length
    const target = last === null ? (register[0] + register[1]) / 2 : centre(last)
    const best = candidates.reduce((best, pitches) => Math.abs(centre(pitches) - target) < Math.abs(centre(best) - target) ? pitches : best)
    // A slash chord's bass under the voicing.
    if (slash) {
        let bass = best[0] - 1
        while (bass % 12 !== chord.bass) {bass--}
        return [bass, ...best]
    }
    return best
}

// The hits of a progression: each chord voiced, played by the rhythm across its beats; [beat, pitch, beats, velocity].
export const chordHits = (spec: ChordSpec, beatsPerBar = 4): { hits: Hit[], beats: number } | string => {
    const chords = parseProgression(spec)
    if (typeof chords === "string") {return chords}
    const rhythm = spec.rhythm.trim().toLowerCase() === "hold" ? null : spec.rhythm.replace(/[\s|]/g, "")
    if (rhythm !== null && (!/^[xX.]+$/.test(rhythm) || !rhythm.includes("x") && !rhythm.includes("X"))) {
        return `rhythm "${spec.rhythm}": "hold", or sixteenths with x a hit, X an accent and . a rest ("x...x...x...x...")`
    }
    const velocity = Math.max(0.1, Math.min(1, spec.velocity ?? 0.65))
    const hits: Hit[] = []
    let start = 0, last: number[] | null = null
    for (const chord of chords) {
        const pitches = voice(chord, spec.voicing, Registers[spec.register] ?? Registers.mid, last)
        last = pitches
        if (rhythm === null) {
            pitches.forEach(pitch => hits.push([start, pitch, chord.beats - 0.05, velocity]))
        } else {
            // The bar of sixteenths repeats over the chord; a hit sounds until the next one, or the chord's end.
            const steps = Math.round(chord.beats * 4)
            const onsets: number[] = []
            for (let step = 0; step < steps; step++) {if (rhythm[step % rhythm.length] !== ".") {onsets.push(step)}}
            onsets.forEach((step, index) => {
                const end = index + 1 < onsets.length ? onsets[index + 1] : steps
                const accent = rhythm[step % rhythm.length] === "X"
                pitches.forEach(pitch => hits.push([start + step / 4, pitch, Math.max(0.2, (end - step) / 4 - 0.05),
                    Math.min(1, accent ? velocity + 0.2 : velocity)]))
            })
        }
        start += chord.beats
    }
    return {hits: hits.map(([beat, pitch, beats, vel]) => [Number(beat.toFixed(4)), pitch, Number(beats.toFixed(4)), Number(vel.toFixed(3))]),
        beats: Math.ceil(start / beatsPerBar) * beatsPerBar}
}

// ---------- mini-notation: drums and melodies as one line (Strudel's) ----------
// A pattern is one bar per cycle: "bd ~ sd ~" is four quarters, "hh*8" eighths, "[bd ~ bd ~, ~ sd ~ sd]" two parts at
// once, "bd(3,8)" three hits spread over eight, "<sd cp>" one per bar in turn, "~" a rest, "_" holds, ":0.6" a velocity.

// swing: where an off-beat eighth lands, as a fraction of the beat (0.5 straight, 0.58 a lazy boom-bap, 0.67 a shuffle);
// sixteenths between move with it.
export type MiniSpec = { pattern: string, bars: number, swing?: number }
// range: the pitches a line keeps to, each note moved by octaves into it (2026-11-25: "0 5 3 4" on a bass put its 5 a
// sixth above the root, C3, where a bass player plays the C below); by default its register's, for a part being changed
// the part's own (rangeOf).
export type MelodySpec = MiniSpec & { register: Register, key?: string, velocity?: number, range?: [number, number] }
export type RoleHit = [beat: number, role: string, velocity: number]

type Event = { begin: number, length: number, value: unknown }
const events = (text: string, bars: number): Event[] | string => {
    if (text.trim() === "") {return "an empty pattern"}
    try {
        const haps = (mini(text) as { queryArc: (from: number, to: number) => Array<{ hasOnset: () => boolean, whole: { begin: { valueOf: () => number }, end: { valueOf: () => number } }, value: unknown }> })
            .queryArc(0, bars).filter(hap => hap.hasOnset())
        return haps.map(hap => ({begin: hap.whole.begin.valueOf(), length: hap.whole.end.valueOf() - hap.whole.begin.valueOf(), value: hap.value}))
            .sort((a, b) => a.begin - b.begin)
    } catch (error) {
        return `"${text}" isn't mini-notation (${String((error as Error).message ?? error).split("\n")[0]})`
    }
}
const barsOf = (bars: number): number => Math.max(1, Math.min(16, Math.round(bars) || 1))
export const swung = (beat: number, swing = 0.5): number => {
    const s = Math.max(0.5, Math.min(0.75, swing || 0.5)), whole = Math.floor(beat + 1e-9), f = beat - whole
    return whole + (f <= 0.5 ? f * 2 * s : s + (f - 0.5) * 2 * (1 - s))
}
// A value and its velocity: "bd" or ["bd", 0.6] ("bd:0.6").
const split = (value: unknown, fallback: number): [unknown, number] => Array.isArray(value)
    ? [value[0], typeof value[1] === "number" && value[1] > 0 ? Math.min(1, value[1]) : fallback] : [value, fallback]

// Drum names as producers and Strudel write them, to TakeDo's roles (knowledge.ts, DrumRoles).
const DrumWords: Record<string, string> = {bd: "kick", kick: "kick", sd: "snare", snare: "snare", cp: "clap", clap: "clap",
    rim: "rim", rs: "rim", hh: "closed_hat", ch: "closed_hat", hat: "closed_hat", oh: "open_hat", ride: "ride", rd: "ride",
    crash: "crash", cr: "crash", lt: "tom_low", mt: "tom_mid", ht: "tom_high", sh: "shaker", shaker: "shaker", perc: "perc"}
export const drumRoleOf = (word: string): string | null => DrumWords[word.toLowerCase()] ?? (DrumRoles[word] !== undefined ? word : null)

// A drum pattern's hits, [beat, role, velocity], and the beats it loops over.
export const drumHits = (spec: MiniSpec, beatsPerBar = 4): { hits: RoleHit[], beats: number } | string => {
    const bars = barsOf(spec.bars)
    const found = events(spec.pattern, bars)
    if (typeof found === "string") {return found}
    const hits: RoleHit[] = []
    for (const event of found) {
        const [word, velocity] = split(event.value, 0.8)
        const role = drumRoleOf(String(word))
        if (role === null) {return `"${String(word)}" isn't a drum (bd, sd, cp, rim, hh, oh, ride, crash, lt, mt, ht, sh, perc)`}
        hits.push([Number(swung(event.begin * beatsPerBar, spec.swing).toFixed(4)), role, velocity])
    }
    if (hits.length === 0) {return `"${spec.pattern}" has no hits`}
    return {hits, beats: bars * beatsPerBar}
}

// Where a melody's degree 0 (the key's tonic) sits: the octave of each register its tonic starts in; and the pitches
// each register's lines keep to.
const TonicFrom: Record<Register, number> = {low: 36, mid: 48, high: 60}
const LineRanges: Record<Register, [number, number]> = {low: [28, 55], mid: [45, 76], high: [57, 88]}
// The range a part's notes cover, an octave at least, so a line written for it stays in its role.
export const rangeOf = (pitches: number[]): [number, number] | undefined => {
    if (pitches.length === 0) {return undefined}
    let low = Math.min(...pitches), high = Math.max(...pitches)
    const short = 12 - (high - low)
    if (short > 0) {low -= Math.floor(short / 2); high += Math.ceil(short / 2)}
    return [low, high]
}
// A note outside the range goes to its octave inside it nearest the note before (the smallest leap a player would make).
const fold = (pitch: number, [low, high]: [number, number], previous: number | null): number => {
    if (pitch >= low && pitch <= high) {return pitch}
    const inside: number[] = []
    for (let octave = pitch % 12; octave <= 127; octave += 12) {if (octave >= low && octave <= high) {inside.push(octave)}}
    if (inside.length === 0) {return pitch}
    const target = previous ?? (low + high) / 2
    return inside.reduce((best, candidate) => Math.abs(candidate - target) < Math.abs(best - target) ? candidate : best)
}

// A melody's notes, [beat, pitch, beats, velocity]: numbers are degrees of the key's scale (0 the tonic, 7 an octave up,
// -1 the degree below), note names are openDAW's (C3 = MIDI 60).
export const melodyHits = (spec: MelodySpec, beatsPerBar = 4): { hits: Hit[], beats: number } | string => {
    const bars = barsOf(spec.bars)
    const found = events(spec.pattern, bars)
    if (typeof found === "string") {return found}
    const key = spec.key ? parseKey(spec.key) : null
    const scale = key === null ? null : Modes[key.mode]
    const tonic = key === null ? 0 : TonicFrom[spec.register] + key.tonic
    const hits: Hit[] = []
    for (const event of found) {
        const [value, velocity] = split(event.value, spec.velocity ?? 0.75)
        let pitch: number
        if (typeof value === "number") {
            if (scale === null) {return "scale degrees need the key (\"E minor\"); or write note names (e2, g#3)"}
            const step = Math.round(value), octave = Math.floor(step / 7)
            pitch = tonic + scale[step - octave * 7] + 12 * octave
        } else {
            const midi = Note.midi(String(value))
            if (midi === null || !/\d$/.test(String(value))) {return `"${String(value)}" isn't a degree (0, 2, -3) or a note with its octave (e2, f#3)`}
            pitch = midi + 12      // tonal's C4 is 60; openDAW's C3 is
        }
        pitch = fold(pitch, spec.range ?? LineRanges[spec.register] ?? LineRanges.mid, hits.at(-1)?.[1] ?? null)
        if (pitch < 0 || pitch > 127) {return `"${String(value)}" is out of MIDI's range`}
        hits.push([Number((event.begin * beatsPerBar).toFixed(4)), pitch, Number(Math.max(0.1, event.length * beatsPerBar * 0.95).toFixed(4)), velocity])
    }
    if (hits.length === 0) {return `"${spec.pattern}" has no notes`}
    return {hits, beats: bars * beatsPerBar}
}
