import {strict as assert} from "node:assert"
import {mkdtempSync, readFileSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {describe, it} from "node:test"
import {DefaultTuning} from "../../shared/protocol.ts"
import {auditionPhrase, guessRoles, Library} from "./library.ts"
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
})
