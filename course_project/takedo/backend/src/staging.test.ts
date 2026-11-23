// The board's staged steps (board.ts): held per direction, a bar's limit, sent in bar order from one anchor moved past
// the playhead. Run from backend/: node --test src/staging.test.ts
import {describe, it} from "node:test"
import assert from "node:assert/strict"
import type {Snapshot} from "../../shared/protocol.ts"
import {Board, commitAnchor, MaxPerBar, planSlide} from "./board.ts"

// 01_good_base in the lofi scenario: 4/4, looping bars 1–4.
const bar = 3840
const now = (played: number, loop = true, pos = "3.2.1"): Snapshot => ({
    at: {t: 0, pos, seq: 0, revision: 0}, detail: "outline", playing: true,
    playback: {playing: true, pos, bar: Number(pos.split(".")[0]), loop: {on: loop, from: "1.1.1", to: "5.1.1"}, position: 0, played},
    timeline: {bpm: 120, signature: [4, 4], length: "5.1.1"}, tracks: [], master: {volume: 0, effects: []}
})
const script = {script: "", description: ""}

describe("the board", () => {
    it("holds a direction's steps until they're taken, then hands them over in bar order, once", () => {
        const board = new Board(() => {})
        const lofi = board.direction("make it lofi"), other = board.direction("louder")
        board.stage(lofi.id, "agent:utility", 9, "tempo", script)
        board.stage(lofi.id, "agent:utility", 3, "drums", script)
        board.stage(other.id, "agent:utility", 5, "volume", script)
        assert.deepEqual(board.take(lofi.id).map(step => step.bar), [3, 9])
        assert.equal(board.take(lofi.id).length, 0, "sent steps aren't sent again")
        assert.equal(board.staged(other.id).length, 1, "another direction's steps stay")
        assert.equal(board.drop(other.id), 1)
    })
    it("refuses a fourth step on one bar of a plan, unless the caller lifts the limit (a knowledge entry)", () => {
        const board = new Board(() => {})
        const {id} = board.direction("make it lofi")
        for (let index = 0; index < MaxPerBar; index++) {assert.equal(board.stage(id, "agent:utility", 9, "fx", script).ok, true)}
        assert.equal(board.stage(id, "agent:utility", 9, "fx", script).ok, false)
        assert.equal(board.stage(id, "agent:utility", 9, "fx", script, Infinity).ok, true)
        assert.equal(board.stage(board.direction("other").id, "agent:utility", 9, "fx", script).ok, true, "per plan")
    })
    it("moves the anchor past the playhead by whole passes of a short loop, else by whole bars", () => {
        const anchor = {position: 2 * bar, played: 0, bar: 3}
        assert.equal(commitAnchor(anchor, now(0)).played, 0, "nothing has played: as it was")
        assert.equal(commitAnchor(anchor, now(1.5 * bar)).played, 4 * bar, "a pass of the 4-bar loop")
        assert.equal(commitAnchor(anchor, now(5 * bar)).played, 8 * bar)
        assert.equal(commitAnchor(anchor, now(1.5 * bar, false)).played, 2 * bar, "no loop: whole bars")
    })
    it("slides a plan whose first bar has gone by, keeping its spacing, only when not looping", () => {
        assert.equal(planSlide([2, 4, 6], now(0, false, "5.2.1")), 4)
        assert.equal(planSlide([2, 4, 6], now(0, false, "5.4.1")), 5, "last beat: one bar later")
        assert.equal(planSlide([9, 11], now(0, false, "5.2.1")), 0)
        assert.equal(planSlide([2, 4], now(0, true, "3.2.1")), 0)
    })
})

describe("the board across a restart", () => {
    it("keeps steps the page still has, and marks the rest lost: sent and gone, or staged and never sent", async () => {
        const {mkdtempSync} = await import("node:fs")
        const {join} = await import("node:path")
        const {tmpdir} = await import("node:os")
        const file = join(mkdtempSync(join(tmpdir(), "board-")), "p.board.json")
        const board = new Board(() => {})
        board.open(file)
        const {id} = board.direction("make it lofi")
        const [a, b] = [board.stage(id, "agent:utility", 3, "a", script), board.stage(id, "agent:utility", 5, "b", script)]
        board.take(id)
        if (!a.ok || !b.ok) {throw new Error("not staged")}
        board.link(a.step.id, "r1")
        board.link(b.step.id, "r2")
        board.status({request: "r1", t: 0, pos: "", state: "scheduled"})
        board.stage(id, "agent:utility", 7, "c", script)
        const restarted = new Board(() => {})
        restarted.open(file)
        const {coming, lost} = restarted.reconcile(["r1"])
        assert.deepEqual(coming.map(step => step.says), ["a"])
        assert.deepEqual(lost.map(step => [step.says, step.detail]), [["b", "the page no longer has it"], ["c", "never sent: its turn was cut off"]])
        restarted.status({request: "r1", t: 0, pos: "", state: "applied"})
        assert.equal(restarted.coming().length, 0)
    })
})
