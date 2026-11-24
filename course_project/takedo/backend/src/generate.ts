// Notes written by code, not by the model (ARCHITECTURE.md, "Each part goes out when its worker finishes": the drum
// worker spent 113 s writing 25.7k tokens of notes, seven stages of a whole pattern each). The model picks where a part
// is going (a knowledge pattern, or notes it writes once) and how many stages; this works out every stage.
import type {Note} from "../../shared/protocol.ts"

// A note in beats from the region's start: [beat, pitch, beats long, velocity 0..1]. The knowledge base's patterns
// use the same shape (knowledge.ts, patternNotes).
export type Hit = [beat: number, pitch: number, beats: number, velocity: number]

// A snapshot note ("2.1.3:120", relative to the region, its length in sixteenths, velocity 0..127) as a hit.
export const hitOf = ([pos, pitch, sixteenths, velocity]: Note, beatsPerBar: number): Hit => {
    const [bars, beat, sixteenth, ticks] = pos.split(/[.:]/).map(Number)
    return [(bars - 1) * beatsPerBar + (beat - 1) + (sixteenth - 1) / 4 + (ticks || 0) / 960, pitch, sixteenths / 4, Number((velocity / 127).toFixed(3))]
}

// A target note the model wrote, in the snapshot's shape. Its velocity is meant as 0..127, but a model sometimes writes
// 0..1 (2026-11-24: a drum target written as 0.5s came out at 0.004 and the drums faded out); at or under 1 it can only
// mean that, since 1 of 127 is silent.
export const targetHitOf = ([pos, pitch, sixteenths, velocity]: Note, beatsPerBar: number): Hit =>
    hitOf([pos, pitch, sixteenths, velocity <= 1 ? velocity * 127 : velocity], beatsPerBar)

// A pattern shorter than the region's loop repeats to fill it; a longer one is cut at the loop's end.
export const tile = (hits: ReadonlyArray<Hit>, patternBeats: number, loopBeats: number): Hit[] => {
    const out: Hit[] = []
    for (let start = 0; start < loopBeats; start += patternBeats) {
        hits.forEach(([beat, pitch, beats, velocity]) => {
            if (start + beat < loopBeats - 1e-6) {out.push([start + beat, pitch, beats, velocity])}
        })
    }
    return out
}

const round = (value: number, places = 4): number => Number(value.toFixed(places))
// A fixed order for hits that tie, so the same morph always comes out the same.
const order = ([beat, pitch]: Hit): number => {
    const x = Math.sin(pitch * 12.9898 + beat * 78.233) * 43758.5453
    return x - Math.floor(x)
}

// From one part to another in `stages` steps, the last being `to` exactly. A hit in both (same pitch, within a
// sixteenth) glides: its timing (swing), length and velocity move a step each stage. A hit only in `to` comes in, the
// loudest first, so the backbone (kick, snare, the chord's root) arrives before the ghosts; one only in `from` drops
// out, the quietest first. Each stage is the whole part, as a region's notes are rewritten in place.
export const morphNotes = (from: ReadonlyArray<Hit>, to: ReadonlyArray<Hit>, stages: number): Hit[][] => {
    const count = Math.max(1, Math.min(16, Math.round(stages)))
    const pairs: Array<[Hit, Hit]> = []
    const unmatched = new Set(from.map((_, index) => index))
    const arriving: Hit[] = []
    for (const target of to) {
        let best = -1, distance = Infinity
        unmatched.forEach(index => {
            const source = from[index]
            const apart = Math.abs(source[0] - target[0])
            if (source[1] === target[1] && apart <= 0.25 + 1e-6 && apart < distance) {best = index; distance = apart}
        })
        if (best >= 0) {
            unmatched.delete(best)
            pairs.push([from[best], target])
        } else {
            arriving.push(target)
        }
    }
    const leaving = [...unmatched].map(index => from[index])
    arriving.sort((a, b) => b[3] - a[3] || order(a) - order(b))
    leaving.sort((a, b) => a[3] - b[3] || order(a) - order(b))
    // How many of a list have changed by stage k: spread evenly, all by the last.
    const by = (length: number, k: number): number => Math.round(length * k / count)
    const out: Hit[][] = []
    for (let k = 1; k <= count; k++) {
        const t = k / count
        const glided = pairs.map(([[beat, pitch, beats, velocity], [toBeat, , toBeats, toVelocity]]): Hit =>
            [round(beat + (toBeat - beat) * t), pitch, round(beats + (toBeats - beats) * t), round(velocity + (toVelocity - velocity) * t, 3)])
        const stage = [...glided, ...arriving.slice(0, by(arriving.length, k)), ...leaving.slice(by(leaving.length, k))]
        out.push(stage.sort((a, b) => a[0] - b[0] || a[1] - b[1]))
    }
    return out
}
