// Notes written by code (generate.ts). Run from backend/: node --test src/generate.test.ts
import {describe, it} from "node:test"
import assert from "node:assert/strict"
import {type Hit, hitOf, morphNotes, targetHitOf, tile} from "./generate.ts"

const Kick = 36, Snare = 38, Hat = 42
// Four on the floor with straight 8th hats, to a boom-bap: kick moves, snare on 2 and 4, swung softer hats.
const house: Hit[] = [[0, Kick, 0.25, 1], [1, Kick, 0.25, 1], [2, Kick, 0.25, 1], [3, Kick, 0.25, 1],
    [0.5, Hat, 0.25, 0.8], [1.5, Hat, 0.25, 0.8], [2.5, Hat, 0.25, 0.8], [3.5, Hat, 0.25, 0.8]]
const boombap: Hit[] = [[0, Kick, 0.25, 0.95], [2.5, Kick, 0.25, 0.85], [1, Snare, 0.25, 0.9], [3, Snare, 0.25, 0.9],
    [0.58, Hat, 0.25, 0.5], [1.58, Hat, 0.25, 0.5], [2.58, Hat, 0.25, 0.5], [3.58, Hat, 0.25, 0.5], [1.5, Snare, 0.25, 0.2]]
const sorted = (hits: Hit[]) => [...hits].sort((a, b) => a[0] - b[0] || a[1] - b[1])

describe("morphing a part", () => {
    it("ends exactly on the target, in as many stages as asked", () => {
        const stages = morphNotes(house, boombap, 4)
        assert.equal(stages.length, 4)
        assert.deepEqual(stages[3], sorted(boombap))
    })
    it("glides hits both parts share: swing and velocity move a step each stage", () => {
        const hatAt = (stage: Hit[]) => stage.find(([beat, pitch]) => pitch === Hat && beat > 0.4 && beat < 0.7)!
        const [first, second] = morphNotes(house, boombap, 4).map(hatAt)
        assert.deepEqual([first[0], first[3]], [0.52, 0.725])
        assert.deepEqual([second[0], second[3]], [0.54, 0.65])
    })
    it("brings new hits in loudest first and drops old ones quietest first", () => {
        const [first] = morphNotes(house, boombap, 4)
        const snares = first.filter(([, pitch]) => pitch === Snare)
        assert.equal(snares.length, 1, "a quarter of the 4 new hits, and a snare before the softer kick")
        assert.ok(snares[0][3] >= 0.9, "the backbone before the ghost")
        assert.equal(first.filter(([, pitch]) => pitch === Kick).length, 3, "kicks on 1 and 3 glide; one of 2 and 4 has gone")
    })
    it("comes out the same every time", () => {
        assert.deepEqual(morphNotes(house, boombap, 6), morphNotes(house, boombap, 6))
    })
})

describe("notes for a region", () => {
    it("reads a snapshot note's position and length in beats", () => {
        assert.deepEqual(hitOf(["2.1.3:120", 36, 2, 127], 4), [4.625, 36, 0.5, 1])
    })
    it("reads a target's velocity as 0..127, or as 0..1 when it's at most 1", () => {
        assert.equal(targetHitOf(["1.1.1:0", 36, 1, 100], 4)[3], Number((100 / 127).toFixed(3)))
        assert.equal(targetHitOf(["1.1.1:0", 36, 1, 0.5], 4)[3], 0.5)
    })
    it("repeats a short pattern to fill the region's loop, and cuts a long one", () => {
        assert.deepEqual(tile([[0, Kick, 0.25, 1], [3.5, Hat, 0.25, 0.5]], 4, 8).map(([beat]) => beat), [0, 3.5, 4, 7.5])
        assert.deepEqual(tile([[0, Kick, 0.25, 1], [5, Kick, 0.25, 1]], 8, 4).map(([beat]) => beat), [0])
    })
})
