import {strict as assert} from "node:assert"
import {mkdtempSync, readFileSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {describe, it} from "node:test"
import {DefaultDrumTuning, DefaultTuning} from "../../shared/protocol.ts"
import {auditionPhrase, drumAudition, guessRoles, Library, pieceOf} from "./library.ts"
import {loadSamples} from "./samples.ts"

// The producer's sound library (library.ts): roles guessed until they say, kept first, rejected never, saved at once.
// Run from backend/: node --test src/library.test.ts

const samples = loadSamples("../samples")
const sound = (id: string) => {
    const found = samples.sound(id)
    if (found === null) {throw new Error(`no ${id}`)}
    return found
}

describe("the sound library", () => {
    it("guesses roles from General MIDI's families and preset names", () => {
        assert.deepEqual(guessRoles(sound("GeneralUser GS/Finger Bass")), ["bass"])
        assert.deepEqual(guessRoles(sound("GeneralUser GS/Warm Pad")), ["pad"])
        assert.ok(guessRoles(sound("openDAW/House Bass")).includes("bass"))
    })
    it("ranks kept first, then unheard; never a rejected one; and keeps it on disk", () => {
        const path = join(mkdtempSync(join(tmpdir(), "library-")), "sound-library.json")
        const library = new Library(path, samples)
        const bass = sound("GeneralUser GS/Fretless Bass"), slap = sound("GeneralUser GS/Slap Bass 1"), finger = sound("GeneralUser GS/Finger Bass")
        assert.equal(library.rank(bass, "bass"), 1)
        assert.equal(library.set(bass.id, {verdict: "kept", roles: ["bass"], tags: ["round"], tuning: {...DefaultTuning, octave: -1}, note: "", t: 1}), null)
        assert.equal(library.set(slap.id, {verdict: "rejected", roles: ["bass"], tags: [], tuning: DefaultTuning, note: "slappy", t: 1}), null)
        assert.equal(library.rank(bass, "bass"), 0)
        assert.equal(library.rank(slap, "bass"), null)
        assert.equal(library.rank(finger, "bass"), 1)
        assert.equal(library.kept("bass"), 1)
        assert.equal(new Library(path, samples).entry(bass.id)?.tuning.octave, -1)
        assert.equal(library.set(bass.id, null), null)
        assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).sounds[bass.id], undefined)
        assert.match(String(library.set("nope/nothing", null)), /no sound/)
    })
    it("auditions a role's part in the key, in the register given", () => {
        const bass = auditionPhrase("bass", "E minor", null)
        if (typeof bass === "string") {throw new Error(bass)}
        assert.ok(bass.hits.every(([, pitch]) => pitch < 64) && bass.beats === 8)
        const keys = auditionPhrase("pad", "E minor", null)
        if (typeof keys === "string") {throw new Error(keys)}
        assert.ok(keys.hits.length >= 6)
        const placed = auditionPhrase("lead", "E minor", [72, 84])
        if (typeof placed === "string") {throw new Error(placed)}
        assert.ok(placed.hits.every(([, pitch]) => pitch >= 72 && pitch <= 84), JSON.stringify(placed.hits.map(([, pitch]) => pitch)))
    })
    it("knows General MIDI's drum kits as drums", () => {
        assert.deepEqual(guessRoles(sound("GeneralUser GS/Jazz Kit")), ["drums"])
        assert.deepEqual(guessRoles(sound("GeneralUser GS/Orchestral Kit")), ["percussion"])
        const kit = auditionPhrase("drums", "E minor", null)
        if (typeof kit === "string") {throw new Error(kit)}
        assert.ok(kit.hits.some(([, pitch]) => pitch === 36) && kit.hits.some(([, pitch]) => pitch === 38))
    })
    it("keeps drum samples too: kept first, rejected never, a stand-in for a rejected one, saved beside the sounds", () => {
        const path = join(mkdtempSync(join(tmpdir(), "library-")), "sound-library.json")
        const library = new Library(path, samples)
        const snares = samples.search({machine: "AkaiMPC60", role: "snare"}, 10)
        const gated = samples.find("AkaiMPC60/rim/Rim Gated")
        if (gated === null || snares.length < 3) {throw new Error("no MPC60 samples")}
        assert.equal(pieceOf(gated), "rim")
        assert.equal(library.rankDrum(snares[0], "snare"), 1)
        assert.equal(library.setDrum(gated.id, {verdict: "rejected", piece: "rim", tags: ["gated", "80s"], tuning: DefaultDrumTuning, note: "", t: 1}), null)
        assert.equal(library.setDrum(snares[1].id, {verdict: "kept", piece: "rim", tags: ["dusty"], tuning: {...DefaultDrumTuning, length: 0.5}, note: "", t: 2}), null)
        assert.equal(library.rankDrum(gated, null), null)
        assert.equal(library.rankDrum(snares[1], "rim"), 0)
        assert.equal(library.piece(snares[1]), "rim")
        assert.equal(library.standIn(gated, "rim")?.id, snares[1].id)
        const stored = JSON.parse(readFileSync(path, "utf8"))
        assert.ok(stored.sounds !== undefined && stored.drums[gated.id].verdict === "rejected")
        assert.equal(new Library(path, samples).drumEntry(snares[1].id)?.tuning.length, 0.5)
        assert.equal(library.drums().length, samples.size)
    })
    it("auditions a drum sample in a beat that features it, or alone", () => {
        const beat = drumAudition("rim", false, 4)
        if (typeof beat === "string") {throw new Error(beat)}
        assert.ok(beat.hits.some(([, role]) => role === "rim") && beat.hits.some(([, role]) => role === "kick"))
        assert.deepEqual(beat.backing.sort(), ["closed_hat", "kick"])
        const alone = drumAudition("snare", true, 4)
        if (typeof alone === "string") {throw new Error(alone)}
        assert.ok(alone.hits.every(([, role]) => role === "snare") && alone.backing.length === 0)
        for (const piece of ["kick", "snare", "clap", "closed_hat", "open_hat", "ride", "crash", "tom_low", "tom_mid", "tom_high", "shaker", "perc", "other"] as const) {
            assert.equal(typeof drumAudition(piece, false, 4), "object", piece)
        }
    })
})
