import {strict as assert} from "node:assert"
import {readFileSync} from "node:fs"
import {join} from "node:path"
import {describe, it} from "node:test"
import type {Snapshot} from "../../shared/protocol.ts"
import {loadCatalog} from "./catalog.ts"
import {loadKnowledge} from "./knowledge.ts"
import {held, intoRange, loadTemplates, restyleMoves, TemplateRoles} from "./restyle.ts"
import {loadSamples} from "./samples.ts"

// Style templates (restyle.ts) on the lofi scenario's starting project (01_good_base: a TR-808 loop and a Cubed acid line,
// E minor, 119 BPM). Run from backend/: node --test src/restyle.test.ts

const Takedo = join(import.meta.dirname, "..", "..")
const catalog = loadCatalog(join(Takedo, "catalog", "devices.json"), join(Takedo, "catalog", "generated.json"))
const samples = loadSamples(join(Takedo, "samples"))
const knowledge = loadKnowledge(join(Takedo, "knowledge"), catalog, () => {}, samples)
const templates = loadTemplates(join(Takedo, "knowledge", "style"))
const base = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "good-base.json"), "utf8")) as Snapshot

describe("style templates", () => {
    it("name sounds that exist, and grooves and progressions that write", () => {
        assert.ok(templates.size >= 2)
        for (const template of templates.values()) {
            for (const role of TemplateRoles) {
                const spec = template.parts[role]
                if (spec === undefined) {continue}
                assert.notEqual(samples.sound(spec.sound), null, `${template.style} ${role}: no sound ${spec.sound}`)
                if (spec.groove !== undefined) {assert.ok(knowledge.applicable().some(line => line.key === spec.groove) || knowledge.get([spec.groove])[0] !== undefined)}
            }
            assert.ok(template.tempo[0] < template.tempo[1])
        }
    })
    it("moves notes by octaves into a range, a chord as a whole", () => {
        assert.deepEqual(intoRange([[0, 76, 1, 0.5], [0, 79, 1, 0.5], [1, 28, 1, 0.5]], [50, 74]),
            [[0, 64, 1, 0.5], [0, 67, 1, 0.5], [1, 52, 1, 0.5]])
    })
    it("holds chords until the next different one, repeats merged", () => {
        const choppy: Array<[number, number, number, number]> = [[0, 60, 0.25, 0.8], [0, 64, 0.25, 0.8], [1, 60, 0.25, 0.8], [1, 64, 0.25, 0.8], [4, 62, 0.25, 0.8], [4, 65, 0.25, 0.8]]
        assert.deepEqual(held(choppy, 8), [[0, 60, 3.95, 0.8], [0, 64, 3.95, 0.8], [4, 62, 3.95, 0.8], [4, 65, 3.95, 0.8]])
    })
    it("takes the good base to lofi: the 808 to the Jazz Kit, the acid line to the Fretless Bass, held Rhodes chords added", () => {
        const made = restyleMoves(templates.get("lofi")!, base, knowledge, catalog, true)
        assert.equal(typeof made, "object", String(made))
        if (typeof made === "string") {return}
        const byRole = Object.fromEntries(made.moves.map(move => [move.role, move]))
        assert.equal(byRole.drums.old?.name, "TR-808")
        assert.match(byRole.drums.says, /GeneralUser GS\/Jazz Kit/)
        assert.ok(byRole.drums.handover)
        assert.equal(byRole.bass.old?.name, "Cubed")
        assert.match(byRole.bass.says, /GeneralUser GS\/Fretless Bass/)
        assert.ok(!byRole.bass.handover)
        assert.match(byRole.bass.code, /"start_db"|"volume_db":-60/)
        assert.equal(byRole.chords.old, null)
        assert.match(byRole.chords.says, /openDAW\/Rhodes/)
        // The bass's notes in its range; the chords held (each at least a bar) and soft.
        const notesOf = (code: string) => (JSON.parse(code.split("\n")[0].replace(/^const args = /, "").replace(/;$/, "")).notes.notes) as Array<[number, number, number, number]>
        assert.ok(notesOf(byRole.bass.code).every(([, pitch]) => pitch >= 28 && pitch <= 50))
        assert.ok(notesOf(byRole.chords.code).every(([, pitch, beats, velocity]) => pitch >= 50 && pitch <= 74 && beats >= 3.9 && velocity === 0.45))
        assert.equal(made.moves.length, 3)
        assert.deepEqual(made.moves.map(move => move.name).sort(), ["Fretless Bass", "Jazz Kit", "Rhodes"])
    })
    it("leaves alone what is the template already (keep going), a soundfont kit read as drums", () => {
        const after = structuredClone(base)
        after.tracks.forEach(track => {track.mix.mute = true})
        const like = (ref: string, name: string, notes: Array<[string, number, number, number]>) => ({...structuredClone(base.tracks[1]), ref, name,
            instrument: "Soundfont", device: {key: "Soundfont", name, enabled: true}, mix: {volume: -8, pan: 0, mute: false, solo: false},
            regions: [{...structuredClone(base.tracks[1].regions[0]), notes}]})
        after.tracks.push(like("t3", "Jazz Kit", [["1.1.1", 36, 1, 100], ["1.2.1", 38, 1, 90]]), like("t4", "Fretless Bass", [["1.1.1", 40, 4, 90]]),
            like("t5", "Rhodes", [["1.1.1", 52, 16, 60], ["1.1.1", 55, 16, 60], ["1.1.1", 59, 16, 60]]))
        const made = restyleMoves(templates.get("lofi")!, after, knowledge, catalog, true)
        if (typeof made === "string") {assert.fail(made)}
        assert.equal(made.moves.length, 0, made.moves.map(move => `${move.old?.name} → ${move.says}`).join("; ") + made.left.join("; "))
        assert.equal(made.left.filter(line => /already the template/.test(line)).length, 3)
    })
})
