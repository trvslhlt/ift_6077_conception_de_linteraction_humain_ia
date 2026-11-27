import {strict as assert} from "node:assert"
import {describe, it} from "node:test"
import type {Snapshot, Track} from "../../shared/protocol.ts"
import {fastEffect, fastMix, fastTone, fastTweak} from "./fastpath.ts"
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
    path: "mix", pathP: 0.95, part, partP: 0.95, move, moveP: 0.95, effect: "other", effectP: 0, action: "add", actionP: 0, tone: "none", toneP: 0,
    tweak: "none", tweakP: 0, amount: 1, when: "unspecified", member: "mix_engineer", memberP: 0.9, control: "none", controlP: 0.9, newPart: 0, ms: 90, ...extra
})

describe("the effect fast path", () => {
    const withReverb: Snapshot = {...snapshot, master: {volume: 0, effects: [{key: "Reverb", name: "Reverb", enabled: true, ref: "master.fx1",
        params: [{ref: "master.fx1.wet", name: "Wet", value: -12, display: "-12 dB", min: -96, max: 0, stepped: false}]}]}}
    const effect = (part: string, kind: Triage["effect"], action: Triage["action"], extra: Partial<Triage> = {}): Triage =>
        judged(part, "quieter", {path: "effect", effect: kind, effectP: 0.95, action, actionP: 0.95, ...extra})
    it("adds an effect mild, by Jev's amount at most moderate, the subtlest on the master", () => {
        assert.deepEqual(fastEffect(effect("whole_mix", "reverb", "add"), "put a reverb on master", snapshot)?.step.plan,
            {op: "add_effect", track: "master", device: "Reverb", factory: "Reverb", settings: [{param: "decay", value: 0.4}, {param: "wet", value: -18}]})
        assert.deepEqual(fastEffect(effect("t1", "crusher", "add", {amount: 3}), "destroy the drums with a crusher", snapshot)?.step.plan,
            {op: "add_effect", track: "t1", device: "Crusher", factory: "Crusher", settings: [{param: "crush", value: 0.4}, {param: "bits", value: 10}]})
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

describe("the musical fast path", () => {
    // A bass line playing in a 1-bar loop (notes as the project shows them), and a script maker that records its calls.
    const bass = {...track("t3", "Bass", -5), regions: [{ref: "r3", name: "Bass", from: "1.1.1", to: "5.1.1", muted: false, loop: 1, kind: "notes" as const,
        notes: [["1.1.1:0", 40, 8, 100], ["1.3.1:0", 43, 8, 100]] as Array<[string, number, number, number]>}]}
    const full: Snapshot = {...snapshot, detail: "full", tracks: [track("t1", "Drums", -4), bass]}
    const calls: Array<{ call: string, args: { region: string, notes: number[][] } }> = []
    const script = (call: string, args: unknown) => {calls.push({call, args: args as { region: string, notes: number[][] }}); return `kb.${call}()`}
    const tweak = (extra: Partial<Triage>) => judged("t3", "quieter", {path: "team", tweak: "octave_down", tweakP: 0.95, member: "composer", ...extra})
    it("makes a tweak Jev is sure of by code: two stages, a bar apart, the last the tweak exactly", () => {
        calls.length = 0
        const fast = fastTweak(tweak({}), "drop the bass an octave", full, script)
        assert.ok(fast !== null)
        assert.equal(fast.says, "Bass an octave down, over the next 2 bars.")
        assert.deepEqual(fast.steps.map(step => step.when.at === "bar" ? step.when.bar : null), [1, 2])
        assert.deepEqual(calls.map(({call, args}) => [call, args.region]), [["replaceNotes", "r3"], ["replaceNotes", "r3"]])
        assert.deepEqual(calls[1].args.notes.map(([, pitch]) => pitch).sort(), [28, 31])
    })
    it("leaves to the Team Lead what isn't sure, has a number, is for later, isn't the Team Lead's path, or can't be made", () => {
        assert.equal(fastTweak(tweak({tweakP: 0.7}), "lower the bass", full, script), null)
        assert.equal(fastTweak(tweak({partP: 0.6}), "lower it", full, script), null)
        assert.equal(fastTweak(tweak({}), "drop the bass an octave at bar 9", full, script), null)
        assert.equal(fastTweak(tweak({when: "later"}), "drop the bass an octave next section", full, script), null)
        assert.equal(fastTweak(tweak({path: "mix"}), "bass down", full, script), null)
        assert.equal(fastTweak(tweak({tweak: "none"}), "make it trap", full, script), null)
        assert.equal(fastTweak(tweak({tweak: "fill"}), "a fill on the bass", full, script), null)     // a fill is for drums
        assert.equal(fastTweak(tweak({member: "mix_engineer", memberP: 0.7}), "add some space on the bass", full, script), null)
        assert.equal(fastTweak(tweak({newPart: 0.9}), "sparse lead melody", full, script), null)
    })
})

describe("the tone path, on a part's strip EQ (strips.ts)", () => {
    const param = (ref: string, value: number) => ({ref, name: ref, value, display: String(value), min: 0, max: 20000, stepped: false})
    const eq = (values: Record<string, number>) => ({key: "Revamp", name: "Revamp", enabled: true, ref: "t3.fx1",
        params: Object.entries({"highPass/enabled": 1, "highPass/frequency": 20, "lowPass/enabled": 1, "lowPass/frequency": 20000,
            "lowShelf/enabled": 1, "lowShelf/gain": 0, "highShelf/enabled": 1, "highShelf/gain": 0, ...values}).map(([name, value]) => param(`t3.fx1.${name}`, value))})
    const withEq = (values: Record<string, number> = {}): Snapshot => ({...snapshot, tracks: snapshot.tracks.map(track => track.ref === "t3" ? {...track, effects: [eq(values)]} : track)})
    const tone = (way: Triage["tone"], extra: Partial<Triage> = {}): Triage =>
        judged("t3", "quieter", {path: "team", tone: way, toneP: 0.95, member: "sound_designer", ...extra})
    const plan = (judged: Triage, from = withEq()) => fastTone(judged, "make it so", from)?.step.plan
    it("moves one band by Jev's amount: darker closes the top, thinner raises the low cut", () => {
        assert.deepEqual(plan(tone("darker")), {op: "ramp", ref: "t3.fx1.lowPass/frequency", to: 3750, beats: 2})
        assert.deepEqual(plan(tone("darker", {amount: 0})), {op: "ramp", ref: "t3.fx1.lowPass/frequency", to: 7500, beats: 2})
        assert.deepEqual(plan(tone("thinner")), {op: "ramp", ref: "t3.fx1.highPass/frequency", to: 160, beats: 2})
        assert.equal(fastTone(tone("darker"), "darker", withEq())?.panel, "t3.fx1")
    })
    it("on a flat EQ, brighter and fuller lift a shelf; once a filter has moved, they open it again", () => {
        assert.deepEqual(plan(tone("brighter")), {op: "ramp", ref: "t3.fx1.highShelf/gain", to: 4, beats: 2})
        assert.deepEqual(plan(tone("fuller")), {op: "ramp", ref: "t3.fx1.lowShelf/gain", to: 4, beats: 2})
        assert.deepEqual(plan(tone("brighter"), withEq({"lowPass/frequency": 3000})), {op: "ramp", ref: "t3.fx1.lowPass/frequency", to: 12000, beats: 2})
        assert.deepEqual(plan(tone("fuller"), withEq({"highPass/frequency": 160})), {op: "ramp", ref: "t3.fx1.highPass/frequency", to: 40, beats: 2})
    })
    it("leaves to the Team Lead: notes (the composer's darker chords), a mixer move, a number, no EQ, an unsure part", () => {
        assert.equal(plan(tone("darker", {member: "composer", memberP: 0.8})), undefined)
        assert.equal(plan(tone("darker", {path: "mix"})), undefined)
        assert.equal(fastTone(tone("darker"), "darker, cut above 2k", withEq()), null)
        assert.equal(plan(tone("darker"), snapshot), undefined)
        assert.equal(plan(tone("darker", {partP: 0.8})), undefined)
        assert.equal(plan(tone("darker", {toneP: 0.85})), undefined)
    })
})

describe("the compressor on a part's strip", () => {
    const param = (ref: string, value: number) => ({ref, name: ref, value, display: String(value), min: -60, max: 24, stepped: false})
    const comp = (threshold: number, ratio: number): Snapshot => ({...snapshot, tracks: snapshot.tracks.map(track => track.ref === "t1" ? {...track,
        effects: [{key: "Compressor", name: "Compressor", enabled: true, ref: "t1.fx2", params: [param("t1.fx2.threshold", threshold), param("t1.fx2.ratio", ratio)]}]} : track)})
    const effect = (action: Triage["action"]) => judged("t1", "quieter", {path: "effect", effect: "compressor", effectP: 0.95, action, actionP: 0.95})
    const plans = (action: Triage["action"], from: Snapshot) => {
        const fast = fastEffect(effect(action), "compress the drums", from)
        return fast === null ? null : [fast.step, ...fast.also ?? []].map(step => step.plan)
    }
    it("a flat one is brought in mild, not doubled; more and less move threshold and ratio together", () => {
        assert.deepEqual(plans("add", comp(0, 1)), [{op: "ramp", ref: "t1.fx2.threshold", to: -18, beats: 2}, {op: "ramp", ref: "t1.fx2.ratio", to: 3, beats: 2}])
        assert.deepEqual(plans("more", comp(0, 1)), [{op: "ramp", ref: "t1.fx2.threshold", to: -18, beats: 2}, {op: "ramp", ref: "t1.fx2.ratio", to: 3, beats: 2}])
        assert.deepEqual(plans("more", comp(-18, 3)), [{op: "ramp", ref: "t1.fx2.threshold", to: -24, beats: 2}, {op: "ramp", ref: "t1.fx2.ratio", to: 4, beats: 2}])
        assert.deepEqual(plans("less", comp(-18, 3)), [{op: "ramp", ref: "t1.fx2.threshold", to: -12, beats: 2}, {op: "ramp", ref: "t1.fx2.ratio", to: 2, beats: 2}])
        assert.equal(plans("less", comp(0, 1)), null)
        assert.equal(fastEffect(effect("add"), "compress the drums", comp(0, 1))?.panel, "t1.fx2")
    })
})
