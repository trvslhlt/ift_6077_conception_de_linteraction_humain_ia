import {strict as assert} from "node:assert"
import {copyFileSync, mkdtempSync, readFileSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {describe, it} from "node:test"
import type {Snapshot} from "../../shared/protocol.ts"
import {loadCatalog} from "./catalog.ts"
import {loadKnowledge} from "./knowledge.ts"
import {addRule, held, intoRange, learnPart, loadRules, loadTemplates, restyleMoves, rulesFor, TemplateRoles, withoutRejected} from "./restyle.ts"
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
                assert.equal([spec.sound, spec.kit, spec.keep, spec.synth].filter(given => given !== undefined).length, 1, `${template.style} ${role}: a sound, a kit, a synth or keep`)
                if (spec.sound !== undefined) {assert.notEqual(samples.sound(spec.sound), null, `${template.style} ${role}: no sound ${spec.sound}`)}
                spec.kit?.pads.forEach(pad => assert.notEqual(samples.find(pad.sample), null, `${template.style} ${role}: no sample ${pad.sample}`))
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
    it("takes the good base to lofi: an 808 kit fading in, the song's own bass kept and warmed, held Rhodes chords added", () => {
        const made = restyleMoves(templates.get("lofi")!, base, knowledge, catalog, true)
        assert.equal(typeof made, "object", String(made))
        if (typeof made === "string") {return}
        const byRole = Object.fromEntries(made.moves.map(move => [move.role, move]))
        assert.equal(byRole.drums.old?.name, "TR-808")
        assert.match(byRole.drums.says, /Lofi 808: a new kit track/)
        assert.ok(!byRole.drums.handover)
        assert.match(byRole.drums.code!, /"volume_db":-60/)
        assert.match(byRole.drums.code!, /"lowPass\/frequency":6000/)
        assert.equal(byRole.bass.old?.name, "Cubed")
        assert.ok(byRole.bass.keep)
        assert.equal(byRole.bass.code, null)
        assert.deepEqual(byRole.bass.tone, {low_cut: 30, high_cut: 600})
        assert.equal(byRole.chords.old, null)
        assert.match(byRole.chords.says, /openDAW\/Rhodes/)
        // The chords held (each at least a bar) and soft.
        const notesOf = (code: string) => (JSON.parse(code.split("\n")[0].replace(/^const args = /, "").replace(/;$/, "")).notes.notes) as Array<[number, number, number, number]>
        assert.ok(notesOf(byRole.chords.code!).every(([, pitch, beats, velocity]) => pitch >= 50 && pitch <= 74 && beats >= 3.9 && velocity === 0.45))
        assert.equal(made.moves.length, 3)
        assert.deepEqual(made.moves.map(move => move.name).sort(), ["Cubed", "Lofi 808", "Rhodes"])
    })
    it("gives lofi the early sessions' bass: a Cubed kept and set so, any other bass a new Cubed playing its notes", () => {
        const kept = restyleMoves(templates.get("lofi")!, base, knowledge, catalog, true)
        if (typeof kept === "string") {assert.fail(kept)}
        const cubed = kept.moves.find(move => move.role === "bass")!
        assert.ok(cubed.keep && cubed.code === null)
        assert.deepEqual(Object.fromEntries((cubed.settings ?? []).map(({param, value}) => [param, value])),
            {waveform: 0, cutoff: 0.28, resonance: 0.05, envMod: 0.2, decay: 0.6, accent: 0.4})
        const finger = structuredClone(base)
        finger.tracks[1] = {...finger.tracks[1], name: "Finger Bass", instrument: "Soundfont", device: {key: "Soundfont", name: "Finger Bass", enabled: true}}
        const made = restyleMoves(templates.get("lofi")!, finger, knowledge, catalog, true)
        if (typeof made === "string") {assert.fail(made)}
        const bass = made.moves.find(move => move.role === "bass")!
        assert.equal(bass.name, "Lofi Bass")
        assert.equal(bass.old?.name, "Finger Bass")
        assert.match(bass.code!, /"factory":"Cubed"/)
        assert.match(bass.code!, /"cutoff":0\.28/)
        assert.match(bass.code!, /"lowPass\/frequency":600/)
    })
    it("leaves alone what is the template already (keep going), a soundfont kit read as drums", () => {
        const after = structuredClone(base)
        after.tracks[0].mix.mute = true
        // Toned already: its Revamp low-passed where the template puts it (a flat strip Revamp isn't, see below).
        after.tracks[1].effects = [{key: "Revamp", name: "Revamp", enabled: true, ref: "t2.fx1",
            params: [{ref: "t2.fx1.lowPass/frequency", name: "Low-Pass Freq", value: 600, display: "600 Hz", min: 20, max: 20000, stepped: false}]}]
        const like = (ref: string, name: string, notes: Array<[string, number, number, number]>) => ({...structuredClone(base.tracks[1]), ref, name,
            instrument: "Soundfont", device: {key: "Soundfont", name, enabled: true}, mix: {volume: -8, pan: 0, mute: false, solo: false},
            regions: [{...structuredClone(base.tracks[1].regions[0]), notes}]})
        after.tracks.push(like("t3", "Lofi 808", [["1.1.1", 60, 1, 100], ["1.2.1", 61, 1, 90]]),
            like("t5", "Rhodes", [["1.1.1", 52, 16, 60], ["1.1.1", 55, 16, 60], ["1.1.1", 59, 16, 60]]))
        const made = restyleMoves(templates.get("lofi")!, after, knowledge, catalog, true)
        if (typeof made === "string") {assert.fail(made)}
        assert.equal(made.moves.length, 0, made.moves.map(move => `${move.old?.name} → ${move.says}`).join("; ") + made.left.join("; "))
        assert.equal(made.left.filter(line => /already the template|already toned/.test(line)).length, 3, made.left.join("; "))
    })
    it("moves drums on a kit sound another style shares onto this style's groove, named for the style", () => {
        const country = restyleMoves(templates.get("country")!, base, knowledge, catalog, false)
        if (typeof country === "string") {assert.fail(country)}
        const drums = country.moves.find(move => move.role === "drums")!
        assert.equal(drums.name, "Country Room Kit")
        const after = structuredClone(base)
        after.tracks[0] = {...after.tracks[0], name: "Country Room Kit", instrument: "Soundfont", device: {key: "Soundfont", name: "Room Kit", enabled: true}}
        const funk = restyleMoves(templates.get("funk")!, after, knowledge, catalog, false)
        if (typeof funk === "string") {assert.fail(funk)}
        assert.equal(funk.moves.find(move => move.role === "drums")?.name, "Funk Room Kit", funk.left.join("; "))
        after.tracks[0].name = "Funk Room Kit"
        const again = restyleMoves(templates.get("funk")!, after, knowledge, catalog, false)
        if (typeof again === "string") {assert.fail(again)}
        assert.equal(again.moves.find(move => move.role === "drums"), undefined)
    })
    it("keeps the producer's rules:a style's and every style's, a repeat once; a part an approved fix changed", () => {
        const dir = mkdtempSync(join(tmpdir(), "rules-")), path = join(dir, "rules.json")
        addRule(path, {style: "lofi", role: "chords", text: "keys held", said: "not sustained", date: "2026-11-26"})
        addRule(path, {style: null, role: "lead", text: "no wash as a lead", said: "never a lead", date: "2026-11-26"})
        addRule(path, {style: "lofi", role: "chords", text: "keys held", said: "not sustained", date: "2026-11-27"})
        addRule(path, {style: "dnb", role: null, text: "clean master", said: "too muddy", date: "2026-11-26"})
        assert.equal(loadRules(path).length, 3)
        assert.deepEqual(rulesFor(path, ["lofi"]).map(rule => rule.text), ["no wash as a lead", "keys held"])
        assert.deepEqual(rulesFor(path, []).map(rule => rule.text), ["no wash as a lead"])
        copyFileSync(join(Takedo, "knowledge", "style", "lofi.json"), join(dir, "lofi.json"))
        assert.equal(learnPart(dir, "lofi", "chords", {sound: "GeneralUser GS/Tine Electric Piano", range: [55, 76]}), null)
        const changed = loadTemplates(dir).get("lofi")!.parts.chords!
        assert.equal(changed.sound, "GeneralUser GS/Tine Electric Piano")
        assert.deepEqual(changed.range, [55, 76])
        assert.equal(changed.rhythm, "hold")
        assert.match(String(learnPart(dir, "house", "bass", {sound: "x"})), /no template/)
        // An approval's rule replaces its correction's; a level or tone it learned wins over a kept sound's tuning.
        const correction = {style: "lofi", role: "bass" as const, text: "bass not boomy", said: "too boomy", date: "2026-11-26"}
        addRule(path, correction)
        addRule(path, {...correction, text: "bass soft, rolled off below 100 Hz", said: "much better"}, [correction])
        assert.deepEqual(rulesFor(path, ["lofi"]).filter(rule => rule.role === "bass").map(rule => rule.text), ["bass soft, rolled off below 100 Hz"])
        assert.equal(learnPart(dir, "lofi", "chords", {level_db: -18, tone: {low_cut: 100, high_cut: 20000}}), null)
        const learned = loadTemplates(dir).get("lofi")!
        assert.equal(learned.parts.chords!.heard, true)
        const made = restyleMoves(learned, base, knowledge, catalog, false)
        if (typeof made === "string") {assert.fail(made)}
        const move = made.moves.find(one => one.role === "chords")!
        assert.equal(move.level_db, -18)
        assert.match(move.code!, /"volume_db":-18/)
        assert.match(move.code!, /"highPass\/frequency":100/)
        // A new sound replaces keeping the song's own part.
        assert.equal(learnPart(dir, "lofi", "bass", {sound: "GeneralUser GS/Acoustic Bass"}), null)
        assert.equal(loadTemplates(dir).get("lofi")!.parts.bass!.keep, undefined)
    })
    it("the knowledge base's rules file reads", () => {
        assert.ok(loadRules(join(Takedo, "knowledge", "rules.json")).length >= 3)
    })
})

describe("a sound the producer rejected", () => {
    const template = {style: "boombap", about: "", tempo: [85, 95] as [number, number], master: "",
        parts: {lead: {sound: "GeneralUser GS/Muted Trumpet", level_db: -15}, bass: {sound: "GeneralUser GS/Acoustic Bass"}}}
    const rule = {style: "boombap", role: "lead" as const, text: "no harmonica tones", said: "that harmonica sound is horrible for hip hop",
        date: "2026-11-26", not_sound: "GeneralUser GS/Muted Trumpet"}
    it("isn't played for that style's part: another one is, the part's other settings kept", () => {
        const asked: string[][] = []
        const changed = withoutRejected(template, [rule], (role, avoid) => {asked.push([role, ...avoid]); return "GeneralUser GS/Vibraphone"})
        assert.deepEqual(changed.parts.lead, {sound: "GeneralUser GS/Vibraphone", level_db: -15})
        assert.deepEqual(changed.parts.bass, template.parts.bass)
        assert.deepEqual(asked, [["lead", "GeneralUser GS/Muted Trumpet"]])
        assert.match(changed.about, /lead is GeneralUser GS\/Vibraphone, never GeneralUser GS\/Muted Trumpet/)
        assert.equal(template.parts.lead.sound, "GeneralUser GS/Muted Trumpet")
    })
    it("leaves other styles, and a rule without a sound, alone; keeps the song's own part when nothing else fits", () => {
        assert.deepEqual(withoutRejected({...template, style: "jazz"}, [rule], () => "x").parts, template.parts)
        assert.deepEqual(withoutRejected(template, [{...rule, not_sound: undefined}], () => "x").parts, template.parts)
        assert.equal(withoutRejected(template, [rule], () => null).parts.lead?.keep, true)
    })
})
