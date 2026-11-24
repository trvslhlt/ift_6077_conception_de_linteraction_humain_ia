// Takes (takes.ts). Run from backend/: node --test src/takes.test.ts
import {describe, it} from "node:test"
import assert from "node:assert/strict"
import {mkdtempSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"
import type {Snapshot, Track} from "../../shared/protocol.ts"
import {recallOf, Takes} from "./takes.ts"

const track = (ref: string, name: string, extra: Partial<Track> = {}): Track => ({ref, name, kind: "notes", instrument: "Vaporisateur",
    device: null, midiEffects: [], effects: [], mix: {volume: -6, pan: 0, mute: false, solo: false}, bars: {from: 1, to: 5}, lanes: [],
    regions: [{ref: `r${ref}`, name, from: "1.1.1", to: "5.1.1", muted: false, loop: 1, kind: "notes", notes: [["1.1.1", 40, 4, 100]]}], ...extra})

const snapshot = (tracks: Track[], bpm = 120): Snapshot => ({at: {t: 0, pos: "1.1.1", seq: 0, revision: 0}, detail: "full", playing: true,
    playback: {playing: true, pos: "1.1.1", bar: 1, loop: {on: true, from: "1.1.1", to: "5.1.1"}, position: 0, played: 0},
    timeline: {bpm, signature: [4, 4], length: "17.1.1"}, tracks, master: {volume: 0, effects: []}})

describe("recalling a take", () => {
    it("does nothing when the project is as the take has it", () => {
        const same = snapshot([track("t1", "Bass")])
        const recall = recallOf(same, same)
        assert.equal(recall.script, null)
        assert.deepEqual(recall.sets, [])
    })
    it("brings back tempo, notes and levels, and mutes a part added since", () => {
        const take = snapshot([track("t1", "Bass")], 120)
        const now = snapshot([track("t1", "Bass", {mix: {volume: -12, pan: 0, mute: false, solo: false},
            regions: [{ref: "rt1", name: "Bass", from: "1.1.1", to: "5.1.1", muted: false, loop: 1, kind: "notes", notes: [["1.1.1", 43, 2, 80]]}]}),
            track("t2", "Keys")], 84)
        const recall = recallOf(take, now)
        assert.match(recall.script ?? "", /api\.setBpm\(120\)/)
        assert.match(recall.script ?? "", /notes\("rt1", \[\[0,40,1,0\.787\]\]\)/)
        assert.deepEqual(recall.sets.map(({ref, to}) => [ref, to]), [["t1.mix.volume", -6], ["t2.mix.mute", 1]])
    })
    it("switches off an effect added since, and restores a kept one's values", () => {
        const reverb = {key: "DattorroReverb", name: "Reverb", enabled: true, ref: "t1.fx1",
            params: [{ref: "t1.fx1.wet", name: "Wet", value: 0.2, display: "20%", min: 0, max: 1, stepped: false}]}
        const take = snapshot([track("t1", "Bass", {effects: [reverb]})])
        const crusher = {key: "Crusher", name: "Crusher", enabled: true, ref: "t1.fx2", params: []}
        const now = snapshot([track("t1", "Bass", {effects: [{...reverb, params: [{...reverb.params[0], value: 0.7, display: "70%"}]}, crusher]})])
        const recall = recallOf(take, now)
        assert.match(recall.script ?? "", /ref\("t1\.fx2"\)\.enabledField\.setValue\(false\)/)
        assert.deepEqual(recall.sets.map(({ref, to}) => [ref, to]), [["t1.fx1.wet", 0.2]])
    })
})

describe("the takes kept", () => {
    it("keeps one per position, and outlasts a restart", () => {
        const file = join(mkdtempSync(join(tmpdir(), "takes-")), "song.takes.json")
        const takes = new Takes(file)
        takes.keep("c:lofi", 0, "before", snapshot([]))
        takes.keep("c:lofi", 0.9, "landed", snapshot([]))
        const newer = takes.keep("c:lofi", 0.92, "landed again", snapshot([]))
        const reopened = new Takes(file)
        assert.equal(reopened.lines().length, 2)
        assert.equal(reopened.get(newer.id)?.label, "landed again")
    })
})
