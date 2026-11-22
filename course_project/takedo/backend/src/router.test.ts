import {strict as assert} from "node:assert"
import {join} from "node:path"
import {describe, it} from "node:test"
import type {Snapshot, Track} from "../../shared/protocol.ts"
import {loadCatalog} from "./catalog.ts"
import type {Gateway} from "./gateway.ts"
import {loadKnowledge} from "./knowledge.ts"
import {pickKnowledge} from "./router.ts"

// The knowledge route offline: Jev stubbed with fixed answers, so these check what the route does with them (which
// path, which params it fills), not what Jev would answer. Run from backend/: node --test src/router.test.ts

const Takedo = join(import.meta.dirname, "..", "..")
const catalog = loadCatalog(join(Takedo, "catalog", "devices.json"), join(Takedo, "catalog", "generated.json"))
const knowledge = loadKnowledge(join(Takedo, "knowledge"), catalog)

const track = (ref: string, name: string, instrument: string): Track => ({
    ref, name, kind: "notes", instrument, device: {key: instrument, name: instrument, enabled: true},
    midiEffects: [], effects: [], mix: {volume: 0, pan: 0, mute: false, solo: false}, bars: {from: 1, to: 4}, lanes: [], regions: []
})
const snapshot: Snapshot = {
    at: {t: 0, pos: "1.1.1", seq: 0, revision: 0}, detail: "outline", playing: true,
    playback: {playing: true, pos: "2.1.1", bar: 2, loop: {on: true, from: "1.1.1", to: "5.1.1"}, position: 3840, played: 0},
    timeline: {bpm: 90, signature: [4, 4], length: "5.1.1"},
    tracks: [track("t1", "Drums", "Playfield"), track("t2", "Keys", "Tubular"), track("t3", "Bass", "Vaporisateur"), track("t4", "Pad", "Vaporisateur")],
    master: {volume: 0, effects: []}
}

// Jev, stubbed: picks `key` from whatever options it's shown (none if it isn't there), with the given answers.
type Answers = { wants: string, key: string | null, part: string, amount?: number, confidence?: number }
const jev = (answers: Answers): Gateway => ({
    judge: async (_job: string, _state: unknown, questions: Record<string, { criteria: Record<string, string | null> }>) => {
        if (questions.pick === undefined) {return {part: {choice: answers.part, confidence: 0.9}, amount: {score: answers.amount ?? 1}}}
        const options = questions.pick.criteria
        const pick = Object.keys(options).find(option => options[option]?.startsWith(`${answers.key}:`)) ?? "none"
        const confidence = answers.confidence ?? 0.95
        return {wants: {choice: answers.wants, confidence}, pick: {choice: pick, confidence},
            part: {choice: answers.part, confidence}, amount: {score: answers.amount ?? 1}}
    }
}) as unknown as Gateway
const pick = (message: string, answers: Answers, roles = {}) => pickKnowledge(jev(answers), () => {}, knowledge, snapshot, message, roles)

describe("knowledge route", () => {
    it("applies a genre's plan with the drums and the keys found by name", async () => {
        const picked = await pick("slowly evolve this into a house track", {wants: "style", key: "genre/house", part: "whole_mix"})
        assert.equal(picked.path, "apply")
        assert.ok(picked.path === "apply" && picked.args.drums === "t1" && picked.args.keys === "t2")
    })
    it("puts an effect where the message points, and the whole mix on the master", async () => {
        const keys = await pick("give the keys a big lush reverb", {wants: "effect", key: "chain/lush-hall", part: "t2", amount: 2.6})
        assert.ok(keys.path === "apply" && keys.args.track === "t2" && keys.args.amount === 3)
        const all = await pick("put the whole thing in a small room", {wants: "effect", key: "chain/small-room", part: "whole_mix"})
        assert.ok(all.path === "apply" && all.args.track === "master")
    })
    it("swaps a sound on a part with the same instrument, else adds a track", async () => {
        const keys = await pick("swap the keys for a rhodes", {wants: "sound", key: "sound/tubular-rhodes", part: "t2"})
        assert.ok(keys.path === "apply" && keys.args.track === "t2")
        const pad = await pick("make the pad a rhodes", {wants: "sound", key: "sound/tubular-rhodes", part: "t4"})
        assert.ok(pad.path === "apply" && pad.args.track === null)
    })
    it("writes a drum pattern on the drums and a chord loop on a chordal part", async () => {
        const beat = await pick("four on the floor kick", {wants: "drums", key: "pattern/four-on-the-floor", part: "t1"})
        assert.ok(beat.path === "apply" && beat.args.track === "t1")
        const chords = await pick("give me a ii V I", {wants: "chords", key: "pattern/jazz-ii-v-i", part: "t3"})
        assert.ok(chords.path === "apply" && chords.args.track === "t2", "not the bass, though the part was the bass")
    })
    it("keeps chords off a part the facts say is a bass, whatever its name", async () => {
        // 2026-11-21: Cubed, an acid bass not named one, got the lofi entry's chords.
        const picked = await pick("evolve this into a lofi beat", {wants: "style", key: "genre/lofi-hip-hop", part: "whole_mix"},
            {t1: "drums", t2: "bass", t3: "bass", t4: "pitched"})
        assert.ok(picked.path === "apply" && picked.args.drums === "t1" && picked.args.keys === "t4")
        const none = await pick("evolve this into a lofi beat", {wants: "style", key: "genre/lofi-hip-hop", part: "whole_mix"},
            {t1: "drums", t2: "bass", t3: "bass", t4: "bass"})
        assert.ok(none.path === "hint" && none.candidates[0].key === "genre/lofi-hip-hop", "no chordal part: the utility adds one")
    })
    it("lets a style be served by a pattern", async () => {
        const picked = await pick("give me a boom bap beat", {wants: "style", key: "pattern/boombap-1", part: "t1"})
        assert.equal(picked.path, "apply")
    })
    it("hands the utility candidates when not sure, the pick first", async () => {
        const picked = await pick("give the keys a big lush reverb", {wants: "effect", key: "chain/lush-hall", part: "t2", confidence: 0.6})
        assert.ok(picked.path === "hint" && picked.candidates[0].key === "chain/lush-hall")
        assert.ok(picked.candidates.every(candidate => knowledge.stratum(candidate.key) === "effect"))
    })
    it("hands over when the kind and the pick disagree", async () => {
        const picked = await pick("more swing", {wants: "drums", key: "sound/tubular-rhodes", part: "t1"})
        assert.notEqual(picked.path, "apply")
    })
    it("does nothing for a level, tempo or chat message", async () => {
        const picked = await pick("the drums are too loud", {wants: "other", key: null, part: "t1"})
        assert.equal(picked.path, "none")
    })
})
