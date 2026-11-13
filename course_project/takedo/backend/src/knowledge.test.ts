import {strict as assert} from "node:assert"
import {cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {after, describe, it} from "node:test"
import type {Snapshot, Track} from "../../shared/protocol.ts"
import {loadCatalog} from "./catalog.ts"
import {chordPitches, drumMap, loadKnowledge, parseKey, readCartridge, shortlist} from "./knowledge.ts"

// Offline checks of the knowledge base (KNOWLEDGE.md): every entry loads and validates against the catalog, the music
// helpers give the right pitches, and entries expand to edits whose scripts at least compile. Run from backend/:
//   node --test src/knowledge.test.ts

const Takedo = join(import.meta.dirname, "..", "..")
const catalog = loadCatalog(join(Takedo, "catalog", "devices.json"), join(Takedo, "catalog", "generated.json"))
const scratch = mkdtempSync(join(tmpdir(), "takedo-knowledge-"))
cpSync(join(Takedo, "knowledge"), scratch, {recursive: true})
after(() => rmSync(scratch, {recursive: true, force: true}))
const warnings: string[] = []
const knowledge = loadKnowledge(scratch, catalog, text => warnings.push(text))

const track = (ref: string, name: string, instrument: string, extra: Partial<Track> = {}): Track => ({
    ref, name, kind: "notes", instrument, device: {key: instrument, name: instrument, enabled: true},
    midiEffects: [], effects: [], mix: {volume: 0, pan: 0, mute: false, solo: false}, bars: {from: 1, to: 4}, lanes: [],
    regions: [], ...extra
})
const drumsTrack = track("t1", "Drums", "Playfield", {device: {key: "Playfield", name: "Playfield", enabled: true,
    content: {pads: [{note: 36, name: "TR-808 Bass Drum"}, {note: 38, name: "TR-808 Snare"}, {note: 39, name: "TR-808 Clap"},
        {note: 42, name: "TR-808 Closed Hat"}, {note: 46, name: "TR-808 Open Hat"}]}}})
const snapshot: Snapshot = {
    at: {t: 0, pos: "1.1.1", seq: 0, revision: 0}, detail: "outline", playing: true,
    playback: {playing: true, pos: "2.1.1", bar: 2, loop: {on: true, from: "1.1.1", to: "5.1.1"}},
    timeline: {bpm: 119, signature: [4, 4], length: "5.1.1"},
    tracks: [drumsTrack, track("t2", "Keys", "Tubular"), track("t3", "Bass", "Vaporisateur", {bars: null})],
    master: {volume: 0, effects: []}
}
const Names = ["takedo", "project", "api", "lib", "ref", "bar", "ppqn", "pos", "snapshot"]
const compiles = (code: string): void => {new Function(...Names, `{\n${code}\n}`)}

describe("loading", () => {
    it("loads every entry without errors or warnings", () => {
        assert.ok(knowledge.size >= 50, `only ${knowledge.size} entries`)
        assert.deepEqual(warnings, [])
    })
    it("lists an index line per entry, sorted", () => {
        const index = knowledge.index()
        assert.equal(index.length, knowledge.size)
        assert.deepEqual(index.map(line => line.key), [...index.map(line => line.key)].sort())
    })
    it("keeps the model's index small: families on one line", () => {
        const lines = knowledge.compact(knowledge.index())
        assert.ok(lines.length < knowledge.size / 2, `${lines.length} lines for ${knowledge.size} entries`)
        // Sent once per agent session (cached after): a few thousand tokens is fine, tens of thousands isn't.
        assert.ok(JSON.stringify(lines).length < 30000, "the compact index has grown past ~8k tokens")
        assert.ok(lines.some(line => line.startsWith("Groove MIDI drums, funk") && line.includes("pattern/gmd-funk-* = ") && line.includes("fill")))
        assert.ok(lines.includes("chain/tape-dust: Worn-tape character: fewer bits, high end rolled off, a dark dotted-8th echo"))
    })
    it("returns linked entries as summaries, and says which keys are missing", () => {
        const [lofi, missing] = knowledge.get(["production/lofi", "style/nope"])
        assert.ok("linked" in lofi && lofi.linked!.some(line => line.key === "chain/tape-dust"))
        assert.deepEqual(missing, {missing: "style/nope"})
    })
    it("rejects an entry with a field outside its range", () => {
        const bad = mkdtempSync(join(tmpdir(), "takedo-bad-"))
        try {
            cpSync(join(scratch, "scripts"), join(bad, "scripts"), {recursive: true})
            cpSync(join(scratch, "chain", "small-room.json"), join(bad, "small-room.json"))
            const entry = JSON.parse(readFileSync(join(bad, "small-room.json"), "utf8"))
            entry.apply.steps[0].input.settings[0].value = 4   // Reverb decay is 0..1
            cpSync(join(scratch, "chain"), join(bad, "chain"), {recursive: true})
            writeFileSync(join(bad, "chain", "small-room.json"), JSON.stringify(entry))
            assert.throws(() => loadKnowledge(bad, catalog), /decay outside 0\.\.1/)
        } finally {rmSync(bad, {recursive: true, force: true})}
    })
})

describe("music", () => {
    it("parses keys", () => {
        assert.deepEqual(parseKey("G major"), {tonic: 7, mode: "major", name: "G major"})
        assert.equal(parseKey("F# minor")?.tonic, 6)
        assert.equal(parseKey("Bbm")?.mode, "minor")
        assert.equal(parseKey("H dur"), null)
    })
    it("voices numerals in a major key", () => {
        const c = parseKey("C major")!
        assert.deepEqual(chordPitches("ii7", c), [50, 53, 57, 60])        // Dm7
        assert.deepEqual(chordPitches("V7", c), [55, 59, 62, 65])         // G7
        assert.deepEqual(chordPitches("Imaj7", c), [48, 52, 55, 59])      // Cmaj7
        assert.deepEqual(chordPitches("vi7", c), [57, 60, 64, 67])        // Am7
        assert.deepEqual(chordPitches("bVII", c), [58, 62, 65])           // Bb
        assert.deepEqual(chordPitches("I", parseKey("G major")!), [55, 59, 62])
    })
    it("voices numerals in a minor key on its own scale", () => {
        const a = parseKey("A minor")!
        assert.deepEqual(chordPitches("i", a), [57, 60, 64])              // Am
        assert.deepEqual(chordPitches("VI", a), [53, 57, 60])             // F
        assert.deepEqual(chordPitches("III", a), [48, 52, 55])            // C
        assert.deepEqual(chordPitches("VII", a), [55, 59, 62])            // G
        assert.deepEqual(chordPitches("IV7", a), [50, 54, 57, 60])        // D7 (Dorian)
        assert.equal(chordPitches("q7", a), null)
    })
    it("maps drum roles to a kit's pads, with fallbacks", () => {
        const mapped = drumMap(["kick", "snare", "closed_hat", "open_hat", "rim", "ride"], drumsTrack)
        assert.ok(typeof mapped !== "string")
        assert.deepEqual(mapped.notes, {kick: 36, snare: 38, closed_hat: 42, open_hat: 46, rim: 38, ride: 42})
    })
    it("says when a kit lacks a drum", () => {
        const sparse = track("t9", "Perc", "Playfield", {device: {key: "Playfield", name: "Playfield", enabled: true,
            content: {pads: [{note: 60, name: "Conga"}]}}})
        assert.match(String(drumMap(["kick"], sparse)), /no pad for kick/)
    })
    it("reads DX7 cartridges", () => {
        const voices = readCartridge(readFileSync(join(scratch, "dx7", "Tubular_Classics.syx")))
        assert.equal(voices.length, 32)
        assert.equal(voices[0].name, "Rhodes")
        assert.equal(voices[0].data[134], 4)                              // algorithm 5, stored 0-based
    })
    it("finds every voice the library note lists", () => {
        const library = knowledge.voices()
        assert.ok(Object.keys(library).length >= 38)
        assert.ok(library["SynprezFM_08"].includes("DL RHODES4"))
    })
})

describe("expansion", () => {
    it("loads a DX7 voice on a new track as one script", () => {
        const planned = knowledge.expand("sound/tubular-rhodes", {}, snapshot)
        assert.ok(Array.isArray(planned) && planned.length === 1)
        const [step] = planned
        assert.equal(step.kind, "script")
        if (step.kind !== "script") {return}
        assert.match(step.code, /return kb\.dx7\(args\)/)
        const args = JSON.parse(/^const args = (.*);$/m.exec(step.code)![1])
        assert.equal(args.voice.length, 155)
        assert.equal(args.track, null)
        compiles(step.code)
    })
    it("turns a chain's dials with amount", () => {
        const subtle = knowledge.expand("chain/tape-dust", {track: "t2", amount: 0}, snapshot)
        const most = knowledge.expand("chain/tape-dust", {track: "t2", amount: 3}, snapshot)
        assert.ok(Array.isArray(subtle) && Array.isArray(most))
        const bits = (planned: typeof subtle) => {
            const step = (planned as Exclude<typeof subtle, string>)[0]
            return step.kind === "op" ? (step.input.settings as Array<{ param: string, value: number }>).find(s => s.param === "bits")!.value : null
        }
        assert.equal(bits(subtle), 14)
        assert.equal(bits(most), 8)
        assert.deepEqual((most as Exclude<typeof most, string>).map(step => step.kind === "op" ? [step.name, step.input.effect] : null),
            [["add_effect", "Crusher"], ["add_effect", "Revamp"], ["add_effect", "Delay"]])
    })
    it("writes a drum pattern over the track's bars with the kit's notes", () => {
        const planned = knowledge.expand("pattern/boombap-1", {track: "t1"}, snapshot)
        assert.ok(Array.isArray(planned))
        const step = planned[0]
        if (step.kind !== "script") {return assert.fail("not a script")}
        const args = JSON.parse(/^const args = (.*);$/m.exec(step.code)![1])
        assert.deepEqual([args.notes.from_bar, args.notes.bars, args.notes.loop_bars], [1, 4, 1])
        assert.deepEqual([...new Set(args.notes.notes.map((note: number[]) => note[1]))].sort(), [36, 38, 42])
        compiles(step.code)
    })
    it("needs the key for chords, and voices them in it", () => {
        assert.match(String(knowledge.expand("pattern/jazz-ii-v-i", {track: "t2"}, snapshot)), /needs key/)
        const planned = knowledge.expand("pattern/jazz-ii-v-i", {track: "t2", key: "G major"}, snapshot)
        assert.ok(Array.isArray(planned))
        const step = planned[0]
        if (step.kind !== "script") {return assert.fail("not a script")}
        const args = JSON.parse(/^const args = (.*);$/m.exec(step.code)![1])
        assert.deepEqual(args.notes.notes.filter((note: number[]) => note[0] === 0).map((note: number[]) => note[1]), [57, 60, 64, 67])   // Am7
        assert.equal(args.notes.loop_bars, 4)
    })
    it("refuses a track that isn't in the project", () => {
        assert.match(String(knowledge.expand("chain/small-room", {track: "t7"}, snapshot)), /not a track ref/)
    })
    it("expands a production style through its chain, on the master", () => {
        const planned = knowledge.expand("production/lofi", {amount: 2}, snapshot)
        assert.ok(Array.isArray(planned))
        assert.ok(planned.every(step => step.kind === "op" && step.input.track === "master"))
    })
    it("sets up an instrument's fields, checked against the catalog", () => {
        const planned = knowledge.expand("sound/sine-sub-vaporisateur", {track: "t3"}, snapshot)
        assert.ok(Array.isArray(planned))
        const step = planned[0]
        if (step.kind !== "script") {return assert.fail("not a script")}
        assert.match(step.code, /return kb\.instrument\(args\)/)
        compiles(step.code)
    })
    it("says a reading-only entry has nothing to apply", () => {
        assert.match(String(knowledge.expand("note/delay-step-table", {}, snapshot)), /nothing to apply/)
    })
})

describe("drafts", () => {
    it("keeps a valid draft on disk and in the index", () => {
        const result = knowledge.draft({kind: "chain", name: "Wide Shimmer", summary: "A test chain", tags: ["test"],
            devices: ["Reverb"], body: ["test"], apply: {params: {track: {type: "track"}}, steps: [
                {op: "add_effect", input: {track: "$track", effect: "Reverb", settings: [{param: "decay", value: 0.9}]}}]}}, "test")
        assert.match(result, /Kept as draft chain\/wide-shimmer/)
        assert.ok(existsSync(join(scratch, "drafts", "chain", "wide-shimmer.json")))
        assert.ok(knowledge.index().some(line => line.key === "chain/wide-shimmer" && line.draft === true))
        assert.ok(Array.isArray(knowledge.expand("chain/wide-shimmer", {track: "t2"}, snapshot)))
    })
    it("refuses a draft that would replace a reviewed entry, or doesn't validate", () => {
        assert.match(knowledge.draft({kind: "chain", name: "tape-dust", summary: "x"}, "test"), /has been reviewed/)
        assert.match(knowledge.draft({kind: "chain", name: "loud", summary: "x", devices: ["Reverb"], apply: {params: {},
            steps: [{op: "add_effect", input: {track: "master", effect: "Reverb", settings: [{param: "wet", value: 12}]}}]}}, "test"), /outside/)
    })
})

describe("shortlist", () => {
    const top = (message: string, limit = 12) => shortlist(knowledge.index(), message, limit).map(({line}) => line.key)
    it("ranks the entry a message names first", () => {
        assert.ok(top("make the keys sound like an old radio", 2).includes("chain/telephone"))
        assert.equal(top("give me a warm pad")[0], "sound/warm-pad-vaporisateur")
        assert.ok(top("make this more lofi", 3).includes("production/lofi"))
    })
    it("matches joined, stemmed and synonym words", () => {
        assert.ok(top("lo-fi please", 3).includes("production/lofi"))
        assert.ok(top("make it funkier").some(key => key.startsWith("pattern/gmd-funk-")))
        assert.ok(top("add a vibraphone", 3).includes("sound/tubular-vibes"))
    })
    it("keeps one family from filling the list", () => {
        const jazz = top("give it a jazz club feel")
        assert.ok(jazz.filter(key => key.startsWith("pattern/gmd-jazz-")).length <= 3)
        assert.ok(jazz.includes("pattern/jazz-ii-v-i"))
    })
    it("returns nothing for a message no entry shares a word with", () => {
        assert.deepEqual(top("undo that"), [])
    })
})

describe("genres", () => {
    it("plans drums then chords, four bars apart", () => {
        const planned = knowledge.expand("genre/house", {drums: "t1", keys: "t2", key: "A minor"}, snapshot)
        assert.ok(Array.isArray(planned), String(planned))
        assert.deepEqual(planned.map(step => step.at), [0, 4])
        assert.match(planned[0].says, /four-on-the-floor on Drums/)
    })
    it("skips the parts the project lacks", () => {
        const planned = knowledge.expand("genre/house", {drums: "t1"}, snapshot)
        assert.ok(Array.isArray(planned) && planned.length === 1, String(planned))
    })
    it("asks for the key when it plans chords without one", () => {
        assert.match(String(knowledge.expand("genre/jazz", {keys: "t2"}, snapshot)), /needs key/)
    })
    it("chains a production style for lofi hip hop", () => {
        const planned = knowledge.expand("genre/lofi-hip-hop", {drums: "t1", keys: "t2", key: "C major"}, snapshot)
        assert.ok(Array.isArray(planned) && planned.length === 5, String(planned))
        assert.ok(planned.slice(2).every(step => step.at === 8 && step.kind === "op"))
    })
})
