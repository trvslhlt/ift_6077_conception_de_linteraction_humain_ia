import {strict as assert} from "node:assert"
import {describe, it} from "node:test"
import type {Snapshot, Track} from "../../shared/protocol.ts"
import {fastMix} from "./fastpath.ts"
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
    path: "mix", pathP: 0.95, part, partP: 0.95, move, moveP: 0.95, amount: 1, when: "unspecified", ms: 90, ...extra
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
    it("leaves to the Team Lead: a number, a later time, another path, or doubt", () => {
        assert.equal(fastMix(judged("t1", "quieter"), "set the drums to -20 dB", snapshot), null)
        assert.equal(fastMix(judged("t1", "quieter", {when: "later"}), "drums down at the chorus", snapshot), null)
        assert.equal(fastMix(judged("t1", "quieter", {path: "team"}), "make it trap", snapshot), null)
        assert.equal(fastMix(judged("t1", "quieter", {partP: 0.55}), "its too loud", snapshot), null)
    })
})
