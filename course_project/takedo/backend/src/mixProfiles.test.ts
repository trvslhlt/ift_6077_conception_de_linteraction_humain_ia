import {strict as assert} from "node:assert"
import {describe, it} from "node:test"
import type {Note, Snapshot, Track} from "../../shared/protocol.ts"
import {Profiles, roleOf, styleSteps} from "./mixProfiles.ts"

// Style mix profiles (mixProfiles.ts): roles read from what a part plays, and the steps a style's mix takes.
// Run from backend/: node --test src/mixProfiles.test.ts

const track = (ref: string, name: string, notes: Note[], extra: Partial<Track> = {}): Track => ({
    ref, name, kind: "notes", instrument: "Vaporisateur", device: {key: "Vaporisateur", name: "Vaporisateur", enabled: true},
    midiEffects: [], effects: [], mix: {volume: -6, pan: 0, mute: false, solo: false}, bars: {from: 1, to: 4}, lanes: [],
    regions: [{ref: `r${ref}`, name, from: "1.1.1", to: "5.1.1", muted: false, loop: 4, kind: "notes", notes}], ...extra
})
const kit = (ref: string, name: string): Track => track(ref, name, [["1.1.1", 36, 1, 0.9]],
    {device: {key: "Playfield", name: "Playfield", enabled: true, content: {pads: [{note: 36, name: "Kick"}]}}})
const chord = (pos: string, length: number): Note[] => [60, 64, 67].map(pitch => [pos, pitch, length, 0.7])
const snapshot = (tracks: Track[]): Snapshot => ({
    at: {t: 0, pos: "1.1.1", seq: 0, revision: 0}, detail: "full", playing: true,
    playback: {playing: true, pos: "2.1.1", bar: 2, loop: {on: false, from: "1.1.1", to: "5.1.1"}, position: 3840, played: 0},
    timeline: {bpm: 90, signature: [4, 4], length: "5.1.1"}, tracks, master: {volume: 0, effects: []}
})
const drums = kit("t1", "Trap Kit"), shaker = kit("t2", "Syncopated Perc")
const bass = track("t3", "Acid Bass", [["1.1.1", 40, 4, 0.8], ["1.2.1", 43, 4, 0.8]])
const keys = track("t4", "Tine EP", [...chord("1.1.1", 4), ...chord("1.3.1", 4)])
const pad = track("t5", "Warm Thing", [...chord("1.1.1", 16), ...chord("2.1.1", 16)])
const lead = track("t6", "Trap Saw", [["1.1.1", 71, 2, 0.7], ["1.2.1", 69, 2, 0.7]])

describe("style mix profiles", () => {
    it("reads each part's role from what it plays", () => {
        assert.deepEqual([drums, shaker, bass, keys, pad, lead].map(roleOf), ["drums", "perc", "bass", "chords", "pad", "lead"])
    })
    it("places each part: pans and sends glide, the bass stays dry and centred, returns are made with the style's character", () => {
        const made = styleSteps("lofi", snapshot([drums, bass, keys, lead]))
        if (typeof made === "string") {throw new Error(made)}
        const plans = made.steps.map(step => step.plan)
        assert.ok(!plans.some(plan => plan.op === "send" && plan.track === "t3" && plan.bus === "Delay"))
        const sends = plans.filter(plan => plan.op === "send")
        assert.ok(sends.some(plan => plan.op === "send" && plan.track === "t4" && plan.bus === "Reverb"))
        const reverb = sends.find(plan => plan.op === "send" && plan.bus === "Reverb")
        assert.ok(reverb?.op === "send" && reverb.effect.settings.some(setting => setting.param === "damping" && setting.value === Profiles.lofi.reverb[1].value))
        assert.ok(reverb?.op === "send" && reverb.effect.settings.some(setting => setting.param === "wet" && setting.value === 0))
        assert.ok(plans.some(plan => plan.op === "ramp" && plan.ref === "t4.mix.pan" && plan.to < 0 && plan.beats > 0))
        assert.ok(made.steps.filter(step => step.plan.op === "send").every(step => step.then !== undefined))
    })
    it("leaves muted parts alone, spreads two of a role, and moves what's there rather than making it again", () => {
        const second = track("t7", "Keys Two", [...chord("1.1.1", 4)])
        const sent = {...keys, sends: [{bus: "Reverb", gain: -30, pan: 0}]}
        const reverbBus: Track = {...track("t8", "Reverb", []), kind: "bus", regions: [], effects: [{key: "DattorroReverb", name: "Dattorro Reverb",
            enabled: true, ref: "t8.fx1", params: [{ref: "t8.fx1.decay", name: "Decay", value: 0.6, display: "60%", min: 0, max: 1, stepped: false}]}]}
        const made = styleSteps("house", snapshot([sent, second, {...lead, mix: {...lead.mix, mute: true}}, reverbBus]))
        if (typeof made === "string") {throw new Error(made)}
        const plans = made.steps.map(step => step.plan)
        assert.ok(!plans.some(plan => (plan.op === "send" && plan.track === "t6") || (plan.op === "ramp" && plan.ref.startsWith("t6."))))
        assert.ok(plans.some(plan => plan.op === "ramp" && plan.ref === "t4.send.Reverb.gain" && plan.to === Profiles.house.roles.chords.reverb))
        assert.ok(!plans.some(plan => plan.op === "send" && plan.track === "t4" && plan.bus === "Reverb"))
        const pans = plans.flatMap(plan => plan.op === "ramp" && plan.ref.endsWith(".mix.pan") ? [plan.to] : [])
        assert.ok(pans.some(pan => pan < 0) && pans.some(pan => pan > 0), String(pans))
        assert.ok(plans.some(plan => plan.op === "ramp" && plan.ref === "t8.fx1.decay" && plan.to === 0.7))
    })
    it("refuses a style it has no profile for", () => {
        assert.match(String(styleSteps("polka", snapshot([drums]))), /no mix profile/)
    })
})
