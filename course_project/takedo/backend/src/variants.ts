import type {Hit} from "./generate.ts"
import {swung} from "./compose.ts"

// Musical tweaks made by code (2026-11-25, the music-library plan, step 3): "busier drums", "simplify the bass", "more
// swing" are one change to a part's notes, made from the notes already there. A model (Jev, step 4) names the tweak, the
// part and how much; code writes the notes, the same way every time (no randomness: a tweak asked twice gives the same).
// The descriptions are what Jev reads (triage.ts, judgeTweak).

export const Tweaks = {
    busier: "busier: more notes (drums: hats in sixteenths, more kicks; a line: notes split into quicker repeats)",
    sparser: "sparser, simpler: fewer notes, the weakest go first (stripped right down: only kick and snare, or each bar's first note)",
    ghost_notes: "ghost notes: quiet extra snare hits around the backbeat",
    swing_more: "more swing, a lazier, more shuffled groove",
    straighten: "less swing, a straighter groove",
    halftime: "half time: the same part at half the speed",
    double_time: "double time: the same part at twice the speed",
    fill: "a drum fill at the end of the loop",
    harder: "played harder, louder hits, more punch",
    softer: "played softer, a lighter touch",
    octave_up: "an octave higher",
    octave_down: "an octave lower",
    shorter: "shorter notes, staccato, stabs",
    longer: "longer notes, legato, ringing out"
} as const
export type Tweak = keyof typeof Tweaks
export const DrumOnly: Tweak[] = ["ghost_notes", "fill"]
export const PitchedOnly: Tweak[] = ["octave_up", "octave_down", "shorter", "longer"]

// A part's notes: its hits over a loop of `beats`, and for drums which role each pitch plays (from the kit's pads).
export type Part = { hits: Hit[], beats: number, beatsPerBar: number, roleOf?: (pitch: number) => string | null }

const round = (value: number): number => Number(value.toFixed(4))
const clamp = (value: number, low: number, high: number): number => Math.max(low, Math.min(high, value))
const sorted = (hits: Hit[]): Hit[] => hits.map(([beat, pitch, beats, velocity]): Hit => [round(beat), pitch, round(beats), round(velocity)])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
const level = (amount: number): number => clamp(Math.round(amount), 0, 3)

// How strong a place in the bar is: the downbeat 4, the half bar 3, a beat 2, an eighth 1, anything finer 0.
const weight = (beat: number, beatsPerBar: number): number => {
    const inBar = ((beat % beatsPerBar) + beatsPerBar) % beatsPerBar
    const near = (grid: number) => Math.abs(inBar / grid - Math.round(inBar / grid)) < 0.02
    return near(beatsPerBar) ? 4 : near(beatsPerBar / 2) ? 3 : near(1) ? 2 : near(0.5) ? 1 : 0
}

// The swing a part plays with: where its off-beat eighths land in the beat (0.5 straight), from its notes between the
// beat's middle and its last sixteenth.
export const swingOf = (hits: ReadonlyArray<Hit>): number => {
    const places = hits.map(([beat]) => beat - Math.floor(beat + 1e-9)).filter(f => f > 0.49 && f < 0.72).sort((a, b) => a - b)
    return places.length === 0 ? 0.5 : Number(places[Math.floor(places.length / 2)].toFixed(3))
}
const unswung = (beat: number, swing: number): number => {
    const whole = Math.floor(beat + 1e-9), f = beat - whole
    return whole + (f <= swing ? f / swing * 0.5 : 0.5 + (f - swing) / (1 - swing) * 0.5)
}

const isDrums = (part: Part): boolean => part.roleOf !== undefined
const rolePitch = (part: Part, role: string): number | null => {
    const pitches = [...new Set(part.hits.map(([, pitch]) => pitch))]
    return pitches.find(pitch => part.roleOf?.(pitch) === role) ?? null
}

// One tweak of a part's notes, amount 0 (subtle) to 3 (all the way); or why it can't be made.
export const vary = (tweak: Tweak, part: Part, amount = 1): Hit[] | string => {
    const n = level(amount), {hits, beats, beatsPerBar} = part
    if (hits.length === 0) {return "the part has no notes to change"}
    if (DrumOnly.includes(tweak) && !isDrums(part)) {return `${tweak} is for drums`}
    if (PitchedOnly.includes(tweak) && isDrums(part)) {return `${tweak} is for a pitched part, not drums`}
    const swing = swingOf(hits)
    switch (tweak) {
        case "busier": {
            const added: Hit[] = []
            const has = (beat: number, pitch: number) => hits.some(([b, p]) => p === pitch && Math.abs(b - beat) < 0.05)
            if (isDrums(part)) {
                // Hats fill in a grid finer: eighths where they're missing, else sixteenths (at 0-1 only each beat's last),
                // then kicks on the and of beats.
                const hat = rolePitch(part, "closed_hat") ?? rolePitch(part, "ride")
                if (hat !== null) {
                    const eighths = Array.from({length: Math.round(beats * 2)}, (_, index) => index / 2)
                    const missing = eighths.filter(beat => !has(swung(beat, swing), hat))
                    const places = missing.length > 0 && n <= 1 ? missing
                        : Array.from({length: Math.round(beats * 4)}, (_, index) => index / 4).filter(beat => n >= 2 || beat % 1 === 0.75)
                    for (const beat of places) {
                        const at = swung(beat, swing)
                        if (!has(at, hat)) {added.push([at, hat, 0.25, beat % 0.5 === 0 ? 0.45 : 0.3])}
                    }
                }
                const kick = rolePitch(part, "kick")
                if (kick !== null && n >= 2) {
                    for (let bar = 0; bar < beats; bar += beatsPerBar) {
                        const at = swung(bar + beatsPerBar / 2 - 0.5, swing)
                        if (!has(at, kick)) {added.push([at, kick, 0.25, 0.7])}
                        if (n >= 3) {
                            const late = swung(bar + beatsPerBar - 0.25, swing)
                            if (!has(late, kick)) {added.push([late, kick, 0.25, 0.6])}
                        }
                    }
                }
                if (added.length === 0) {return "the drums are already as busy as this tweak makes them"}
                return sorted([...hits, ...added])
            }
            // A line: each note at least `split` beats long repeats every `step` beats (in eighths, or sixteenths at 3).
            const step = n >= 3 ? 0.25 : 0.5, split = [2, 1, 0.5, 0.5][n]
            const out = hits.flatMap(([beat, pitch, length, velocity]): Hit[] => {
                if (length < split * 0.9) {return [[beat, pitch, length, velocity]]}       // a note is written a little short of its step
                const repeats = Math.max(1, Math.round(length / step))
                return Array.from({length: repeats}, (_, index): Hit => [beat + index * step, pitch, step * 0.9, index === 0 ? velocity : velocity * 0.85])
            })
            return out.length === hits.length ? "the line's notes are already short; nothing to split" : sorted(out)
        }
        case "sparser": {
            if (n >= 3) {   // stripped right down
                if (isDrums(part)) {
                    const kept = hits.filter(([, pitch]) => ["kick", "snare", "clap"].includes(part.roleOf!(pitch) ?? ""))
                    return kept.length > 0 ? sorted(kept) : "the drums have no kick or snare to keep"
                }
                const firsts = new Map<number, Hit>()
                hits.forEach(hit => {const bar = Math.floor(hit[0] / beatsPerBar + 1e-6); if (!firsts.has(bar)) {firsts.set(bar, hit)}})
                return sorted([...firsts.values()].map(([beat, pitch, , velocity]) => [beat, pitch, beatsPerBar * 0.95, velocity]))
            }
            // The weakest go first (a weak place in the bar, then a soft hit); a drum's backbone (kicks on the downbeat,
            // snares on the backbeat) stays.
            const share = [0.15, 0.3, 0.5][n]
            const score = ([beat, pitch, , velocity]: Hit): number => {
                const role = part.roleOf?.(pitch) ?? null
                const backbone = (role === "kick" && weight(unswung(beat, swing), beatsPerBar) >= 3) || ((role === "snare" || role === "clap") && weight(unswung(beat, swing), beatsPerBar) >= 2)
                return backbone ? 99 : weight(unswung(beat, swing), beatsPerBar) + velocity
            }
            const order = hits.map((hit, index) => ({index, score: score(hit)})).sort((a, b) => a.score - b.score || b.index - a.index)
            const drop = new Set(order.slice(0, Math.max(1, Math.round(hits.length * share))).filter(({score}) => score < 99).map(({index}) => index))
            return drop.size === 0 ? "nothing left to take out but the part's backbone" : sorted(hits.filter((_, index) => !drop.has(index)))
        }
        case "ghost_notes": {
            const snare = rolePitch(part, "snare")
            if (snare === null) {return "the kit has no snare playing to ghost"}
            const backbeats = hits.filter(([, pitch, , velocity]) => pitch === snare && velocity >= 0.5).map(([beat]) => beat)
            const offsets = [-0.25, 0.75, 0.25, -0.75, 0.5, -0.5].slice(0, [1, 2, 4, 6][n])
            const added: Hit[] = []
            for (const at of backbeats) {
                for (const offset of offsets) {
                    const beat = round(swung(unswung(at, swing) + offset, swing))
                    if (beat >= 0 && beat < beats && !hits.some(([b]) => Math.abs(b - beat) < 0.05) && !added.some(([b]) => Math.abs(b - beat) < 0.05)) {
                        added.push([beat, snare, 0.25, 0.25 + 0.03 * n])
                    }
                }
            }
            return added.length === 0 ? "no room for ghost notes around the snare" : sorted([...hits, ...added])
        }
        case "swing_more":
        case "straighten": {
            const to = tweak === "swing_more" ? clamp(swing + [0.03, 0.05, 0.08, 0.12][n], 0.5, 0.72)
                : n >= 3 ? 0.5 : clamp(swing - [0.02, 0.04, 0.06][n], 0.5, 0.72)
            if (Math.abs(to - swing) < 0.005) {return tweak === "swing_more" ? "the part is already swung as far as it goes" : "the part is already straight"}
            return sorted(hits.map(([beat, pitch, length, velocity]) => [swung(unswung(beat, swing), to), pitch, length, velocity]))
        }
        case "halftime":
            return sorted(hits.filter(([beat]) => beat * 2 < beats - 1e-6).map(([beat, pitch, length, velocity]) => [beat * 2, pitch, length * (isDrums(part) ? 1 : 2), velocity]))
        case "double_time": {
            const half = hits.map(([beat, pitch, length, velocity]): Hit => [beat / 2, pitch, isDrums(part) ? length : length / 2, velocity])
            return sorted([...half, ...half.map(([beat, pitch, length, velocity]): Hit => [beat + beats / 2, pitch, length, velocity])])
        }
        case "fill": {
            // The loop's last beat (1), half bar (2) or bar (3): snare sixteenths rising, the kick on the first.
            const snare = rolePitch(part, "snare") ?? rolePitch(part, "clap")
            if (snare === null) {return "the kit has no snare playing to fill with"}
            const length = [1, 1, beatsPerBar / 2, beatsPerBar][n], from = beats - length
            const kept = hits.filter(([beat, pitch]) => beat < from - 1e-6 || part.roleOf!(pitch) === "kick" && Math.abs(beat - from) < 0.05)
            const steps = Math.round(length * 4)
            const run = Array.from({length: steps}, (_, index): Hit => [from + index / 4, snare, 0.25, 0.45 + 0.5 * (index + 1) / steps])
            return sorted([...kept, ...run])
        }
        case "harder":
        case "softer": {
            const k = [0.15, 0.3, 0.5, 0.7][n]
            return sorted(hits.map(([beat, pitch, length, velocity]) => [beat, pitch, length,
                tweak === "harder" ? clamp(velocity + (1 - velocity) * k, 0.05, 1) : clamp(velocity * (1 - k * 0.8), 0.08, 1)]))
        }
        case "octave_up":
        case "octave_down": {
            const shift = tweak === "octave_up" ? 12 : -12
            if (hits.some(([, pitch]) => pitch + shift < 0 || pitch + shift > 127)) {return "an octave that way is out of MIDI's range"}
            return sorted(hits.map(([beat, pitch, length, velocity]) => [beat, pitch + shift, length, velocity]))
        }
        case "shorter":
            return sorted(hits.map(([beat, pitch, length, velocity]) => [beat, pitch, Math.max(0.1, length * [0.75, 0.5, 0.3, 0.15][n]), velocity]))
        case "longer": {
            // Toward legato: each note reaching for the next onset after it (the loop's end for the last).
            const onsets = [...new Set(hits.map(([beat]) => round(beat)))].sort((a, b) => a - b)
            return sorted(hits.map(([beat, pitch, length, velocity]) => {
                const next = onsets.find(onset => onset > beat + 1e-6) ?? beats
                const legato = (next - beat) * 0.97
                return [beat, pitch, Math.max(length, length + (legato - length) * [0.4, 0.7, 1, 1][n]), velocity]
            }))
        }
    }
}
