// The utility's chat line: what its reply tool accepts, and the fallback when it ends without one (`make knowledge`).
import {describe, it} from "node:test"
import assert from "node:assert/strict"
import {asChatLine, replyProblem} from "./utility.ts"

describe("reply", () => {
    it("accepts one or two short plain sentences", () => {
        assert.equal(replyProblem("I'm lowering the tempo from 86 down to about 74 in a few small steps, so it settles without a jolt."), null)
        assert.equal(replyProblem("The drums go lazy and swung, and a soft Rhodes drifts in on warm chords. Want the bass darker too?"), null)
    })
    it("refuses lists, line breaks, caveats and length, saying what to fix", () => {
        assert.match(replyProblem("Doing it now.\n\n- **Tempo:** down to 86.")!, /line breaks/)
        assert.match(replyProblem("- Tempo down. - Drums softer.")!, /list marks/)
        assert.match(replyProblem("Done. I haven't heard any of this.")!, /caveat/)
        assert.match(replyProblem("I've kept going. The Rhodes sits in a reverb. The bass pulls back. The tempo is at 86.")!, /4 sentences/)
        assert.match(replyProblem(`${"warm ".repeat(60).trim()}.`)!, /characters/)
        assert.match(replyProblem("  ")!, /empty/)
    })
    it("falls back to the first plain sentences of a long reply", () => {
        const long = "I'm turning this into a lofi girl beat in slow stages. Nothing should jump.\n\n- **Tempo:** it eases down.\n- **Drums:** softer.\n\nI haven't confirmed the Rhodes notes."
        assert.equal(asChatLine(long), "I'm turning this into a lofi girl beat in slow stages. Nothing should jump.")
    })
})
