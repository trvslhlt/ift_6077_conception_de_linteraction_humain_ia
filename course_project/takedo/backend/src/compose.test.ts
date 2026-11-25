import {strict as assert} from "node:assert"
import {describe, it} from "node:test"
import {chordHits, drumHits, melodyHits, numeralChord, parseKey, rangeOf} from "./compose.ts"

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

describe("mini-notation", () => {
    it("reads a groove's parts at once, with velocities, one bar per cycle", () => {
        const groove = drumHits({pattern: "[bd ~ ~ bd ~ ~ bd ~, ~ sd ~ sd:0.4, hh*4]", bars: 1})
        assert.ok(typeof groove !== "string")
        assert.equal(groove.beats, 4)
        assert.deepEqual(groove.hits.filter(([, role]) => role === "kick").map(([beat]) => beat), [0, 1.5, 3])
        assert.deepEqual(groove.hits.filter(([, role]) => role === "snare"), [[1, "snare", 0.8], [3, "snare", 0.4]])
        assert.equal(groove.hits.filter(([, role]) => role === "closed_hat").length, 4)
    })
    it("alternates across bars and spreads Euclid hits", () => {
        const turns = drumHits({pattern: "bd <sd cp>", bars: 2})
        assert.ok(typeof turns !== "string")
        assert.deepEqual(turns.hits.map(([beat, role]) => [beat, role]), [[0, "kick"], [2, "snare"], [4, "kick"], [6, "clap"]])
        const euclid = drumHits({pattern: "bd(3,8)", bars: 1})
        assert.ok(typeof euclid !== "string" && euclid.hits.map(([beat]) => beat).join() === "0,1.5,3")
    })
    it("refuses what isn't a drum or isn't mini-notation", () => {
        assert.match(String(drumHits({pattern: "bd tuba", bars: 1})), /isn't a drum/)
        assert.match(String(drumHits({pattern: "bd [", bars: 1})), /isn't mini-notation/)
    })
    it("writes a line's degrees in the key, in its register, with holds", () => {
        const line = melodyHits({pattern: "0 2 4 _", bars: 1, register: "low", key: "E minor"})
        assert.ok(typeof line !== "string")
        assert.deepEqual(line.hits.map(([beat, pitch]) => [beat, pitch]), [[0, 40], [1, 43], [2, 47]])   // E1 G1 B1, openDAW's
        assert.equal(line.hits[2][2], 1.9)                                                                  // the fifth held two beats
        const below = melodyHits({pattern: "-1 7", bars: 1, register: "mid", key: "C major"})
        assert.ok(typeof below !== "string" && below.hits.map(([, pitch]) => pitch).join() === "47,60")
    })
    it("keeps a line in the part's range: a bass's 5 is the sixth below, not above", () => {
        // The Cubed bass (A1–A2) evolved to "<0 5 3 4>" (2026-11-25: its C went to C3).
        const bass = melodyHits({pattern: "<0 5 3 4>", bars: 4, register: "mid", key: "E minor", range: rangeOf([45, 52, 57])})
        assert.ok(typeof bass !== "string")
        assert.deepEqual(bass.hits.map(([, pitch]) => pitch), [52, 48, 57, 47])     // E2 C2 A2 B1: in its range, C and B below
        const lead = melodyHits({pattern: "0 9", bars: 1, register: "high", key: "C major"})
        assert.ok(typeof lead !== "string" && lead.hits.map(([, pitch]) => pitch).join() === "60,76")
    })
    it("reads note names as openDAW's (C3 = 60), and needs the key for degrees", () => {
        const named = melodyHits({pattern: "c3 e2", bars: 1, register: "mid"})
        assert.ok(typeof named !== "string" && named.hits.map(([, pitch]) => pitch).join() === "60,52")
        assert.match(String(melodyHits({pattern: "0 2", bars: 1, register: "mid"})), /need the key/)
        assert.match(String(melodyHits({pattern: "0 zz", bars: 1, register: "mid", key: "A minor"})), /isn't a degree/)
    })
})
