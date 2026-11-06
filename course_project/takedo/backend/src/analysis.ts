import type {Note, Snapshot, Track} from "../../shared/protocol.ts"

// What models are bad at, done in code and handed to them with the snapshot (STRATEGY.md, "What the state query must
// return"): the key, each part's register and dynamics, whether it sits on the grid, and which drum sound each hit is.

const Names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
// openDAW's naming: MIDI 60 is "C3" (FEATURES.md, "Project overview", Open).
export const noteName = (pitch: number): string => `${Names[pitch % 12]}${Math.floor(pitch / 12) - 2}`

// Krumhansl–Kessler key profiles, major and minor, from C.
const Major = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
const Minor = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]

const correlation = (a: number[], b: number[]): number => {
    const mean = (xs: number[]) => xs.reduce((sum, x) => sum + x, 0) / xs.length
    const [ma, mb] = [mean(a), mean(b)]
    let num = 0, da = 0, db = 0
    a.forEach((x, i) => {
        num += (x - ma) * (b[i] - mb)
        da += (x - ma) ** 2
        db += (b[i] - mb) ** 2
    })
    return da === 0 || db === 0 ? 0 : num / Math.sqrt(da * db)
}

export type Key = { tonic: string, mode: "major" | "minor", confidence: number, runnerUp: string }

// Pitch classes weighted by duration, correlated with each of the 24 profiles. confidence: the best correlation.
export const findKey = (notes: ReadonlyArray<Note>): Key | null => {
    if (notes.length < 3) {return null}
    const weights = new Array(12).fill(0)
    notes.forEach(([, pitch, sixteenths]) => weights[pitch % 12] += sixteenths)
    const scored = Names.flatMap((tonic, shift) => (["major", "minor"] as const).map(mode => {
        const profile = mode === "major" ? Major : Minor
        const rotated = profile.map((_, i) => profile[(i - shift + 12) % 12])
        return {tonic, mode, r: correlation(weights, rotated)}
    })).sort((a, b) => b.r - a.r)
    const [best, next] = scored
    return {tonic: best.tonic, mode: best.mode, confidence: Number(best.r.toFixed(2)), runnerUp: `${next.tonic} ${next.mode}`}
}

const isDrums = (track: Track): boolean => track.device?.content !== undefined && "pads" in track.device.content

export type PartAnalysis = {
    notes: number
    register?: { low: string, high: string }
    velocity: { min: number, max: number }
    offGrid: number                                 // notes not on a sixteenth
    hits?: Record<string, string[]>                 // drums: pad name → positions in the region
}
export type Analysis = { key: Key | null, parts: Record<string, PartAnalysis> }

export const analyse = (snapshot: Snapshot): Analysis => {
    const pitched: Note[] = []
    const parts: Record<string, PartAnalysis> = {}
    for (const track of snapshot.tracks) {
        const notes = track.regions.flatMap(region => region.notes ?? [])
        if (notes.length === 0) {continue}
        const pitches = notes.map(([, pitch]) => pitch)
        const velocities = notes.map(([, , , velocity]) => velocity)
        const part: PartAnalysis = {
            notes: notes.length,
            velocity: {min: Math.min(...velocities), max: Math.max(...velocities)},
            offGrid: notes.filter(([pos]) => pos.includes(":")).length
        }
        if (isDrums(track)) {
            const pads = new Map((track.device!.content as { pads: Array<{ note: number, name: string }> }).pads
                .map(pad => [pad.note, pad.name]))
            part.hits = {}
            notes.forEach(([pos, pitch]) => (part.hits![pads.get(pitch) ?? `note ${pitch}`] ??= []).push(pos))
        } else {
            part.register = {low: noteName(Math.min(...pitches)), high: noteName(Math.max(...pitches))}
            pitched.push(...notes)
        }
        parts[track.ref] = part
    }
    return {key: findKey(pitched), parts}
}
