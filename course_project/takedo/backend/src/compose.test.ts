import {strict as assert} from "node:assert"
import {describe, it} from "node:test"
import {chordHits, numeralChord, parseKey} from "./compose.ts"

// Chords written by code (compose.ts). Run from backend/: node --test src/compose.test.ts

const voicings = (result: ReturnType<typeof chordHits>): number[][] => {
    if (typeof result === "string") {throw new Error(result)}
    const by = new Map<number, number[]>()
    result.hits.forEach(([beat, pitch]) => by.set(beat, [...by.get(beat) ?? [], pitch]))
    return [...by.values()].map(pitches => pitches.sort((a, b) => a - b))
}

describe("chords written by code", () => {
    it("reads numerals by their case, accidentals against the major scale", () => {
        const key = parseKey("E minor")!
        assert.deepEqual(["iv7", "VI", "bVI", "bVII", "V7sus4", "i9"].map(numeral => numeralChord(numeral, key)), ["Am7", "C", "C", "D", "B7sus4", "Em9"])
    })
    it("voices a progression close and led: each chord near the last, every tone of it there", () => {
        const chords = voicings(chordHits({progression: "Em9:4 Cmaj7:4 Am7:4 B7sus4:4", voicing: "close", register: "mid", rhythm: "hold"}))
        assert.equal(chords.length, 4)
        assert.deepEqual(chords.map(pitches => new Set(pitches.map(pitch => pitch % 12)).size), [5, 4, 4, 4])
        const centre = (pitches: number[]) => pitches.reduce((sum, pitch) => sum + pitch, 0) / pitches.length
        chords.slice(1).forEach((pitches, index) => assert.ok(Math.abs(centre(pitches) - centre(chords[index])) <= 4))
        chords.flat().forEach(pitch => assert.ok(pitch >= 52 && pitch <= 78))
    })
    it("spreads the root under the rest, and keeps a slash chord's bass lowest", () => {
        const [fmaj7] = voicings(chordHits({progression: "Fmaj7:4", voicing: "spread", register: "mid", rhythm: "hold"}))
        assert.equal(fmaj7[0] % 12, 5)
        assert.ok(fmaj7[1] - fmaj7[0] >= 12)
        const [cOverE] = voicings(chordHits({progression: "C/E:4", voicing: "spread", register: "mid", rhythm: "hold"}))
        assert.equal(cOverE[0] % 12, 4)
    })
    it("plays a rhythm of sixteenths over each chord, accents louder", () => {
        const result = chordHits({progression: "Em7:4", voicing: "close", register: "mid", rhythm: "x..x..x.X.......", velocity: 0.6})
        if (typeof result === "string") {throw new Error(result)}
        const top = result.hits.filter(([, pitch]) => pitch === result.hits[0][1])
        assert.deepEqual(top.map(([beat]) => beat), [0, 0.75, 1.5, 2])
        assert.ok(top[3][3] > top[0][3])
        assert.equal(result.beats, 4)
    })
    it("says what's wrong with a chord or a rhythm", () => {
        assert.match(String(chordHits({progression: "Xyz:4", voicing: "close", register: "mid", rhythm: "hold"})), /not a chord name/)
        assert.match(String(chordHits({progression: "i:4", voicing: "close", register: "mid", rhythm: "hold"})), /needs the key/)
        assert.match(String(chordHits({progression: "Am:4", voicing: "close", register: "mid", rhythm: "x-x-"})), /sixteenths/)
    })
})
