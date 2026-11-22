// When the utility's edits land, and the note it gets when a gradual change bunches up or runs out of order (`make knowledge`).
import {describe, it} from "node:test"
import assert from "node:assert/strict"
import {barsFromAnchor, barsUntil, MaxPerBar, stagingNote, together} from "./utility.ts"

// 01_good_base in the lofi scenario: looping bars 1–4, the playhead in bar 3.
const playback = {playing: true, pos: "3.2.1", bar: 3, loop: {on: true, from: "1.1.1", to: "5.1.1"}, position: 8640, played: 0}
const barMs = 2000

describe("staging", () => {
    it("times a plan's bars from its anchor, in their order (bar 3 before bar 6 in a 4-bar loop)", () => {
        // The run of 2026-11-22: anchored in bar 2, bar 3 landed after bar 6 when bars in the loop waited for the playhead.
        assert.equal(barsFromAnchor(playback.loop, 2, 3), 1)
        assert.equal(barsFromAnchor(playback.loop, 2, 6), 4)
        assert.equal(barsFromAnchor(playback.loop, 3, 2), 3)   // behind the anchor: its next pass
        assert.equal(barsFromAnchor(playback.loop, 2, 2), 1)   // the anchor's own bar: the next bar line, as "now"
    })
    it("times a bar as the bus does: ahead in the loop, round again, or past its end", () => {
        assert.equal(barsUntil(playback, 4), 1)
        assert.equal(barsUntil(playback, 3), 4)     // already reached: next pass
        assert.equal(barsUntil(playback, 1), 2)     // the top of the loop, as it wraps
        assert.equal(barsUntil(playback, 7), 4)     // past the end: bars of playing
        assert.equal(barsUntil(playback, 0), 1)
        assert.equal(barsUntil({...playback, loop: {...playback.loop, on: false}}, 3), 1)
    })
    it("notes the scenario's tempo steps landing out of order (bar 5, then 3, then 7)", () => {
        const at = (atBar: number) => ({atBar, lands: barsUntil(playback, atBar) * barMs, edits: 1})
        assert.equal(stagingNote([], at(5), barMs), "")
        assert.match(stagingNote([at(5)], at(3), barMs), /bar 5 land in the opposite order/)
    })
    it("notes a third edit on one bar, counting a knowledge entry's edits", () => {
        const at = (atBar: number, edits = 1) => ({atBar, lands: barsUntil(playback, atBar) * barMs, edits})
        assert.equal(stagingNote([at(9)], at(9), barMs), "")
        assert.match(stagingNote([at(9, 3)], at(9), barMs), /4 edits now land on the same bar/)
        assert.equal(stagingNote([at(9), at(11)], at(13), barMs), "")
        assert.equal(together([at(9), at(9), at(9)], at(9), barMs) > MaxPerBar, true, "a fourth single edit on a bar is refused")
        assert.equal(together([at(9), at(9)], at(9), barMs) > MaxPerBar, false)
    })
})
