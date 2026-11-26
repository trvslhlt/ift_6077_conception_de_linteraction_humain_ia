import {describe, it} from "node:test"
import assert from "node:assert/strict"
import type {Control, Device} from "../../shared/protocol.ts"
import {effectPanel, slots} from "./panels.ts"

const param = (ref: string, value: number, min: number, max: number) => ({ref, name: ref, value, display: String(value), min, max, stepped: false})

describe("effect panels", () => {
    it("gives a crusher its crunch, bits and mix as direct dials and a bypass switch, in one group", () => {
        const crusher: Device = {key: "Crusher", name: "Crusher", enabled: true, ref: "t1.fx2",
            params: [param("t1.fx2.crush", 0.4, 0, 1), param("t1.fx2.bits", 10, 1, 16), param("t1.fx2.boost", 0, 0, 24), param("t1.fx2.mix", 1, 0, 1)]}
        const panel = effectPanel(crusher, "Drums")
        assert.deepEqual(panel.map(control => [control.label, control.widget, control.bind?.[0]?.ref]),
            [["Crunch", "dial", "t1.fx2.crush"], ["Bits", "dial", "t1.fx2.bits"], ["Mix", "dial", "t1.fx2.mix"], ["On", "switch", "t1.fx2.enabled"]])
        assert.ok(panel.every(control => control.group === "Crusher on Drums" && control.kind === "direct"))
        assert.equal(panel[1]!.value, 0.5)                                  // 10 bits between 16 (0) and 4 (1)
    })
    it("leaves out an EQ band that's switched off, and falls back to a device's wet", () => {
        const revamp: Device = {key: "Revamp", name: "Revamp", enabled: true, ref: "master.fx2", params: [param("master.fx2.highShelf/enabled", 1, 0, 1),
            param("master.fx2.highShelf/gain", -3, -24, 24), param("master.fx2.lowShelf/enabled", 0, 0, 1), param("master.fx2.lowShelf/gain", 0, -24, 24)]}
        assert.deepEqual(effectPanel(revamp, "the master").map(control => control.label), ["Top", "On"])
        const other: Device = {key: "Fold", name: "Fold", enabled: false, ref: "t2.fx1", params: [param("t2.fx1.wet", -20, -96, 0)]}
        assert.deepEqual(effectPanel(other, "Keys").map(control => [control.label, control.value]), [["Wet", 0.5], ["On", 0]])
    })
    it("counts a group once", () => {
        const control = (ref: string, group?: string) => ({ref, group}) as Control
        assert.equal(slots([control("a", "P"), control("b", "P"), control("c")]), 2)
    })
})
