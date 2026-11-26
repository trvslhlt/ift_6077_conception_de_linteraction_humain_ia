import {strict as assert} from "node:assert"
import {describe, it} from "node:test"
import {drumHits, melodyHits} from "./compose.ts"
import type {Hit} from "./generate.ts"
import {type Part, swingOf, type Tweak, Tweaks, vary} from "./variants.ts"

// Musical tweaks made by code (variants.ts), each measured on what it claims. Run from backend/: node --test src/variants.test.ts

const Pads: Record<string, number> = {kick: 36, snare: 38, clap: 39, closed_hat: 42, open_hat: 46, ride: 51}
const drums = (mini: string, swing?: number): Part => {
    const written = drumHits({pattern: mini, bars: 1, swing})
    if (typeof written === "string") {throw new Error(written)}
    const byPitch = Object.fromEntries(Object.entries(Pads).map(([role, pitch]) => [pitch, role]))
    return {hits: written.hits.map(([beat, role, velocity]): Hit => [beat, Pads[role], 0.25, velocity]), beats: written.beats, beatsPerBar: 4,
        roleOf: pitch => byPitch[pitch] ?? null}
}
const boombap = drums("[bd:0.95 ~ ~ bd:0.6 ~ bd:0.85 ~ ~, ~ sd:0.9 ~ sd:0.9, hh:0.6 hh:0.35 hh:0.55 hh:0.35 hh:0.6 hh:0.35 hh:0.55 hh:0.4]", 0.58)
const house = drums("[[bd:0.95]*4, ~ cp:0.85 ~ cp:0.85, [~ oh:0.6]*4]")
const line = (() => {
    const written = melodyHits({pattern: "0 _ 0 [2 4] ~ 4 _ 3", bars: 1, register: "low", key: "E minor"})
    if (typeof written === "string") {throw new Error(written)}
    return {hits: written.hits, beats: written.beats, beatsPerBar: 4} satisfies Part
})()
const hits = (result: Hit[] | string): Hit[] => {
    if (typeof result === "string") {throw new Error(result)}
    return result
}
const of = (part: Part, role: string, result: Hit[]) => result.filter(([, pitch]) => part.roleOf?.(pitch) === role)

describe("variants", () => {
    it("busier: more hats, then more kicks; a line's long notes split", () => {
        const one = hits(vary("busier", boombap, 1)), three = hits(vary("busier", boombap, 3))
        assert.ok(one.length >= boombap.hits.length && three.length > one.length, `${boombap.hits.length} → ${one.length} → ${three.length}`)
        assert.ok(of(boombap, "closed_hat", three).length === 16 && of(boombap, "kick", three).length > of(boombap, "kick", boombap.hits).length)
        const split = hits(vary("busier", line, 2))
        assert.ok(split.length > line.hits.length)
    })
    it("sparser: the weakest go first, the backbone stays; all the way leaves kick and snare", () => {
        const less = hits(vary("sparser", boombap, 1))
        assert.ok(less.length < boombap.hits.length)
        assert.ok(less.some(([beat, pitch]) => pitch === Pads.kick && beat === 0) && of(boombap, "snare", less).length === 2)
        const bare = hits(vary("sparser", boombap, 3))
        assert.deepEqual([...new Set(bare.map(([, pitch]) => boombap.roleOf!(pitch)))].sort(), ["kick", "snare"])
        assert.equal(hits(vary("sparser", line, 3)).length, 1)
    })
    it("ghost notes: quiet snares around the backbeat, more with more", () => {
        const one = hits(vary("ghost_notes", boombap, 1)), two = hits(vary("ghost_notes", boombap, 2))
        const ghosts = (result: Hit[]) => of(boombap, "snare", result).filter(([, , , velocity]) => velocity < 0.5)
        assert.ok(ghosts(one).length >= 2 && ghosts(two).length > ghosts(one).length)
        assert.match(String(vary("ghost_notes", house, 1)), /no snare/)
        // The jam project's TR-808: a clap backbeat, the snare pad never played (2026-11-25): ghosts on the snare pad.
        const withPad = {...house, padOf: (role: string) => Pads[role] ?? null}
        const ghosted = hits(vary("ghost_notes", withPad, 1))
        assert.ok(ghosted.filter(([, pitch]) => pitch === Pads.snare).length >= 2)
        // No closed hat or ride playing: busier fills in on the closed-hat pad.
        const busy = hits(vary("busier", withPad, 1))
        assert.ok(busy.filter(([, pitch]) => pitch === Pads.closed_hat).length >= 4)
    })
    it("swing: more moves the off-beats later, straighten brings them back", () => {
        assert.equal(swingOf(boombap.hits), 0.58)
        const more = hits(vary("swing_more", boombap, 2))
        assert.ok(Math.abs(swingOf(more) - 0.66) < 0.01, String(swingOf(more)))     // amount 2: 8% later
        assert.equal(swingOf(hits(vary("straighten", boombap, 3))), 0.5)
        assert.ok(Math.abs(swingOf(hits(vary("swing_more", house, 1))) - 0.55) < 0.01)
    })
    it("half time puts the backbeat on 3; double time plays the bar twice", () => {
        const half = hits(vary("halftime", boombap))
        assert.deepEqual(of(boombap, "snare", half).map(([beat]) => beat), [2])
        const double = hits(vary("double_time", house))
        assert.equal(of(house, "kick", double).length, 8)
    })
    it("a fill: rising snare sixteenths at the loop's end", () => {
        const fill = hits(vary("fill", boombap, 2))
        const run = of(boombap, "snare", fill).filter(([beat]) => beat >= 2)
        assert.equal(run.length, 8)
        assert.ok(run.every(([, , , velocity], index) => index === 0 || velocity > run[index - 1][3]))
        assert.ok(of(boombap, "closed_hat", fill).every(([beat]) => beat < 2))
    })
    it("harder and softer move velocities, octaves and lengths move a line, and drums refuse what's pitched", () => {
        const mean = (result: Hit[]) => result.reduce((sum, [, , , velocity]) => sum + velocity, 0) / result.length
        assert.ok(mean(hits(vary("harder", boombap, 1))) > mean(boombap.hits) && mean(hits(vary("softer", boombap, 1))) < mean(boombap.hits))
        assert.deepEqual(hits(vary("octave_down", line)).map(([, pitch]) => pitch), line.hits.map(([, pitch]) => pitch - 12))
        const short = hits(vary("shorter", line, 2)), long = hits(vary("longer", line, 2))
        assert.ok(short.every(([, , length], index) => length < line.hits[index][2]) && long.some(([, , length], index) => length > line.hits[index][2]))
        assert.match(String(vary("octave_up", boombap)), /pitched part/)
        assert.match(String(vary("fill", line)), /for drums/)
    })
    it("gives the same notes every time", () => {
        for (const tweak of Object.keys(Tweaks) as Tweak[]) {
            const part = ["octave_up", "octave_down", "shorter", "longer"].includes(tweak) ? line : boombap
            assert.deepEqual(vary(tweak, part, 2), vary(tweak, part, 2), tweak)
        }
    })
})
