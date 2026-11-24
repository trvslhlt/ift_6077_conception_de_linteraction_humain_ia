// What an edit changed (shared/touched.ts) and the ledger of who owns what (ledger.ts). Run from backend/:
// node --test src/ledger.test.ts
import {describe, it} from "node:test"
import assert from "node:assert/strict"
import {mkdtempSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"
import type {Snapshot, Track} from "../../shared/protocol.ts"
import {nothingTouched, touchedBetween} from "../../shared/touched.ts"
import {Ledger, ownedBy, touchedBy} from "./ledger.ts"

const track = (ref: string, extra: Partial<Track> = {}): Track => ({ref, name: ref, kind: "notes", instrument: "Vaporisateur",
    device: {key: "Vaporisateur", name: "Vaporisateur", enabled: true}, midiEffects: [], effects: [],
    mix: {volume: -6, pan: 0, mute: false, solo: false}, bars: {from: 1, to: 5}, lanes: [],
    regions: [{ref: `r${ref}`, name: ref, from: "1.1.1", to: "5.1.1", muted: false, loop: 1, kind: "notes", notes: [["1.1.1", 40, 4, 100]]}], ...extra})
const snapshot = (tracks: Track[], bpm = 120, loop = {on: true, from: "1.1.1", to: "5.1.1"}): Snapshot => ({at: {t: 0, pos: "1.1.1", seq: 0, revision: 0},
    detail: "full", playing: true, playback: {playing: true, pos: "1.1.1", bar: 1, loop, position: 0, played: 0},
    timeline: {bpm, signature: [4, 4], length: "17.1.1"}, tracks, master: {volume: 0, effects: []}})

describe("what an edit changed", () => {
    it("nothing, when the project is the same", () => {
        const same = snapshot([track("t1")])
        assert.ok(nothingTouched(touchedBetween(same, same)))
    })
    it("notes, a level, a new track with its effect, the tempo and the loop", () => {
        const before = snapshot([track("t1")])
        const after = snapshot([track("t1", {mix: {volume: -10, pan: 0, mute: false, solo: false},
            regions: [{ref: "rt1", name: "t1", from: "1.1.1", to: "5.1.1", muted: false, loop: 1, kind: "notes", notes: [["1.1.1", 43, 4, 100]]}]}),
            track("t2", {effects: [{key: "DattorroReverb", name: "Reverb", enabled: true, ref: "t2.fx1", params: []}]})],
            84, {on: true, from: "1.1.1", to: "17.1.1"})
        const touched = touchedBetween(before, after)
        assert.deepEqual(touched.values, [{ref: "t1.mix.volume", from: -6, to: -10}])
        assert.deepEqual(touched.notes, [{region: "rt1", track: "t1"}])
        assert.deepEqual(touched.tracks, [{ref: "t2", change: "added"}])
        assert.deepEqual(touched.effects, [{ref: "t2.fx1", change: "added"}])
        assert.deepEqual(touched.tempo, {from: 120, to: 84})
        assert.equal(touched.loop?.to.to, "17.1.1")
    })
    it("an instrument and an effect switched off", () => {
        const reverb = {key: "DattorroReverb", name: "Reverb", enabled: true, ref: "t1.fx1", params: []}
        const before = snapshot([track("t1", {effects: [reverb]})])
        const after = snapshot([track("t1", {device: {key: "Vaporisateur", name: "Vaporisateur", enabled: false}, effects: [{...reverb, enabled: false}]})])
        assert.deepEqual(touchedBetween(before, after).switches, [{ref: "t1", from: true, to: false}, {ref: "t1.fx1", from: true, to: false}])
    })
    it("a fixed operation says it in its result", () => {
        const touched = touchedBy({op: "ramp", ref: "t1.mix.volume", to: -12, beats: 4},
            {request: "x", t: 0, pos: "", state: "applied", result: {ref: "t1.mix.volume", label: "", from: -6, to: -12}})
        assert.deepEqual(touched.values, [{ref: "t1.mix.volume", from: -6, to: -12}])
    })
})

describe("the ledger", () => {
    it("records what each direction changed, maps dials to directions, and outlasts a restart", () => {
        const file = join(mkdtempSync(join(tmpdir(), "ledger-")), "song.ledger.json")
        const ledger = new Ledger(file)
        const lofi = touchedBetween(snapshot([track("t1")]), snapshot([track("t1", {mix: {volume: -10, pan: 0, mute: false, solo: false}})], 84))
        const busy = touchedBetween(snapshot([track("t1")]), snapshot([track("t1", {regions: [{ref: "rt1", name: "t1", from: "1.1.1", to: "5.1.1", muted: false, loop: 1, kind: "notes", notes: []}]})]))
        ledger.record({request: "a", t: 1, agent: "agent:utility", says: "lofi", op: "script", touched: lofi, direction: "d1", job: "j1"})
        ledger.record({request: "b", t: 2, agent: "agent:utility", says: "busy", op: "script", touched: busy, direction: "d2", job: "j2"})
        assert.equal(ledger.record({request: "c", t: 3, agent: "agent:utility", says: "nothing", op: "script",
            touched: touchedBetween(snapshot([]), snapshot([])), direction: "d2"}), false, "an edit that changed nothing isn't kept")
        ledger.dial("c:lofi", "d1")
        ledger.dial("c:busy", "d2")
        const reopened = new Ledger(file)
        assert.deepEqual([...ownedBy(reopened.entries(reopened.directionsOf("c:lofi")))].sort(), ["tempo", "value t1.mix.volume"])
        assert.deepEqual([...ownedBy(reopened.entries(reopened.directionsOf("c:busy")))], ["notes t1"])
    })
})
