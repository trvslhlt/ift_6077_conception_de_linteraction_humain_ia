import {strict as assert} from "node:assert"
import {describe, it} from "node:test"
import type {Track} from "../../shared/protocol.ts"
import {stripPlans} from "./strips.ts"

// Which part gets what of its strip. Run from backend/: node --test src/strips.test.ts

const track = (ref: string, name: string, extra: Partial<Track> = {}): Track => ({
    ref, name, kind: "notes", instrument: "Vaporisateur", device: {key: "Vaporisateur", name, enabled: true},
    midiEffects: [], effects: [], mix: {volume: -6, pan: 0, mute: false, solo: false}, bars: {from: 1, to: 4}, lanes: [], regions: [], ...extra
})
const drums = track("t1", "TR-808", {device: {key: "Playfield", name: "TR-808", enabled: true, content: {pads: [{note: 60, name: "Kick"}]}}})
const what = (plans: ReturnType<typeof stripPlans>) => plans.map(plan => plan.op === "add_effect" ? plan.device : plan.op === "script" ? "Zeitgeist" : plan.op)

describe("a part's strip", () => {
    it("drums get swing (playing straight), an EQ and a compressor; a bass an EQ and a compressor; anything else an EQ", () => {
        assert.deepEqual(what(stripPlans(drums)), ["Zeitgeist", "Revamp", "Compressor"])
        assert.match(stripPlans(drums)[0].op === "script" ? (stripPlans(drums)[0] as { code: string }).code : "", /amount\.setValue\(0\.5\)/)
        assert.deepEqual(what(stripPlans(track("t2", "Acid Bass"))), ["Revamp", "Compressor"])
        assert.deepEqual(what(stripPlans(track("t3", "Rhodes Keys"))), ["Revamp"])
    })
    it("goes in flat: no low cut, the top open, shelves at 0 dB; the compressor at 0 dB and 1:1", () => {
        const [eq, compressor] = stripPlans(track("t2", "Acid Bass"))
        assert.ok(eq.op === "add_effect" && compressor.op === "add_effect")
        if (eq.op !== "add_effect" || compressor.op !== "add_effect") {return}
        const settings = (plan: typeof eq) => Object.fromEntries(plan.settings.map(({param, value}) => [param, value]))
        assert.deepEqual(settings(eq), {"highPass/enabled": 1, "highPass/frequency": 20, "lowPass/enabled": 1, "lowPass/frequency": 20000,
            "lowShelf/enabled": 1, "lowShelf/gain": 0, "highShelf/enabled": 1, "highShelf/gain": 0})
        assert.deepEqual(settings(compressor), {threshold: 0, ratio: 1, automakeup: 0})
    })
    it("adds only what's missing, and nothing to a bus or a parked part", () => {
        const kept = {...drums, midiEffects: [{key: "Zeitgeist", name: "Zeitgeist", enabled: true}],
            effects: [{key: "Revamp", name: "Revamp", enabled: true, ref: "t1.fx1"}]}
        assert.deepEqual(what(stripPlans(kept)), ["Compressor"])
        assert.deepEqual(stripPlans(track("t4", "Reverb", {kind: "bus"})), [])
        assert.deepEqual(stripPlans({...drums, mix: {...drums.mix, mute: true}}), [])
    })
})
