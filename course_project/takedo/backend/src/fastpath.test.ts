import {strict as assert} from "node:assert"
import {describe, it} from "node:test"
import type {Snapshot, Track} from "../../shared/protocol.ts"
import {fastEffect, fastMix} from "./fastpath.ts"
import type {Triage} from "./triage.ts"

// The mix fast path offline: Jev's answers given, so these check what code does with them. Run from backend/:
// node --test src/fastpath.test.ts

const track = (ref: string, name: string, volume: number, mute = false, pan = 0): Track => ({
    ref, name, kind: "notes", instrument: "Vaporisateur", device: {key: "Vaporisateur", name: "Vaporisateur", enabled: true},
    midiEffects: [], effects: [], mix: {volume, pan, mute, solo: false}, bars: {from: 1, to: 4}, lanes: [], regions: []
})
const snapshot: Snapshot = {
    at: {t: 0, pos: "1.1.1", seq: 0, revision: 0}, detail: "outline", playing: true,
    playback: {playing: true, pos: "2.1.1", bar: 2, loop: {on: false, from: "1.1.1", to: "5.1.1"}, position: 3840, played: 0},
    timeline: {bpm: 90, signature: [4, 4], length: "5.1.1"},
    tracks: [track("t1", "Drums", -4), track("t2", "Keys", -6, true), track("t3", "Bass", -5, false, 0.2)],
    master: {volume: 0, effects: []}
}
const judged = (part: string, move: Triage["move"], extra: Partial<Triage> = {}): Triage => ({
    path: "mix", pathP: 0.95, part, partP: 0.95, move, moveP: 0.95, effect: "other", effectP: 0, action: "add", actionP: 0,
    amount: 1, when: "unspecified", ms: 90, ...extra
})

describe("the effect fast path", () => {
    const withReverb: Snapshot = {...snapshot, master: {volume: 0, effects: [{key: "Reverb", name: "Reverb", enabled: true, ref: "master.fx1",
        params: [{ref: "master.fx1.wet", name: "Wet", value: -12, display: "-12 dB", min: -96, max: 0, stepped: false}]}]}}
    const effect = (part: string, kind: Triage["effect"], action: Triage["action"], extra: Partial<Triage> = {}): Triage =>
        judged(part, "quieter", {path: "effect", effect: kind, effectP: 0.95, action, actionP: 0.95, ...extra})
    it("adds an effect with settings by Jev's amount", () => {
        assert.deepEqual(fastEffect(effect("whole_mix", "reverb", "add"), "put a reverb on master", snapshot)?.step.plan,
            {op: "add_effect", track: "master", device: "Reverb", factory: "Reverb", settings: [{param: "decay", value: 0.5}, {param: "wet", value: -12}]})
    })
    it("makes more of one there, adds one where there's none", () => {
        assert.deepEqual(fastEffect(effect("whole_mix", "reverb", "more"), "more reverb", withReverb)?.step.plan,
            {op: "ramp", ref: "master.fx1.wet", to: -7, beats: 2})
        assert.equal(fastEffect(effect("whole_mix", "reverb", "more"), "more reverb", snapshot)?.step.plan.op, "add_effect")
    })
    it("takes one out (parked), and leaves to the Team Lead what it can't place", () => {
        assert.deepEqual(fastEffect(effect("whole_mix", "reverb", "remove"), "take the reverb off", withReverb)?.step.plan,
            {op: "remove_effect", ref: "master.fx1"})
        assert.equal(fastEffect(effect("whole_mix", "reverb", "add", {partP: 0.84}), "add a reverb after the limiter", snapshot), null)
        assert.equal(fastEffect(effect("t1", "other", "add"), "add a phaser to the drums", snapshot), null)
    })
})

describe("the mix fast path", () => {
    it("turns a part down by Jev's amount, as a short glide", () => {
        const fast = fastMix(judged("t1", "quieter"), "the drums are too loud", snapshot)
        assert.deepEqual(fast?.step.plan, {op: "ramp", ref: "t1.mix.volume", to: -8, beats: 2})
        assert.equal(fast?.says, "Drums down 4 dB.")
    })
    it("fades the whole track out gradually, to silence", () => {
        const fast = fastMix(judged("whole_mix", "quieter", {amount: 2.8, when: "gradual"}), "fade the track out", snapshot)
        assert.deepEqual(fast?.step.plan, {op: "ramp", ref: "master.mix.volume", to: -60, beats: 8})
    })
    it("unmutes a muted part, and leaves an unmuted one to the Team Lead", () => {
        assert.deepEqual(fastMix(judged("t2", "unmute"), "bring the keys back", snapshot)?.step.plan, {op: "set", ref: "t2.mix.mute", to: 0})
        assert.equal(fastMix(judged("t1", "unmute"), "bring the drums back", snapshot), null)
    })
    it("pans from where the part is", () => {
        assert.deepEqual(fastMix(judged("t3", "pan_left", {amount: 0}), "pan the bass a little left", snapshot)?.step.plan,
            {op: "ramp", ref: "t3.mix.pan", to: -0.05, beats: 2})
    })
    it("puts a part back where it was before its latest change", () => {
        const fast = fastMix(judged("t1", "back"), "bring them back up", snapshot, {"t3.mix.pan": 0, "t1.mix.volume": -4})
        assert.deepEqual(fast?.step.plan, {op: "ramp", ref: "t1.mix.volume", to: -4, beats: 2})
        assert.equal(fastMix(judged("t2", "back"), "undo that", snapshot, {"t1.mix.volume": -4}), null)
    })
    it("leaves to the Team Lead: a number, a later time, another path, or doubt", () => {
        assert.equal(fastMix(judged("t1", "quieter"), "set the drums to -20 dB", snapshot), null)
        assert.equal(fastMix(judged("t1", "quieter", {when: "later"}), "drums down at the chorus", snapshot), null)
        assert.equal(fastMix(judged("t1", "quieter", {path: "team"}), "make it trap", snapshot), null)
        assert.equal(fastMix(judged("t1", "quieter", {partP: 0.55}), "its too loud", snapshot), null)
        assert.equal(fastMix(judged("t1", "unmute", {pathP: 0.76}), "its still muted", snapshot), null)
    })
})
