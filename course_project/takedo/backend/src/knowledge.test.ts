import {strict as assert} from "node:assert"
import {cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {after, describe, it} from "node:test"
import type {Snapshot, Track} from "../../shared/protocol.ts"
import {loadCatalog} from "./catalog.ts"
import {chordPitches, drumMap, loadKnowledge, parseKey, progressionKey, progressionMode, readCartridge, shortlist} from "./knowledge.ts"
import {loadSamples} from "./samples.ts"

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
// TakeDo's sample collections, when fetched (make samples): the kits' samples are checked against them.
const samples = loadSamples(join(Takedo, "samples"))
const withSamples = loadKnowledge(scratch, catalog, text => warnings.push(text), samples)

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
    playback: {playing: true, pos: "2.1.1", bar: 2, loop: {on: true, from: "1.1.1", to: "5.1.1"}, position: 3840, played: 0},
    timeline: {bpm: 119, signature: [4, 4], length: "5.1.1"},
    tracks: [drumsTrack, track("t2", "Keys", "Tubular"), track("t3", "Bass", "Vaporisateur", {bars: null})],
    master: {volume: 0, effects: []}
}
const Names = ["takedo", "project", "api", "lib", "ref", "bar", "ppqn", "pos", "snapshot"]
const compiles = (code: string): void => {new Function(...Names, `{\n${code}\n}`)}

describe("loading", () => {
    it("writes stored lines into hits and chords, and shows readers the line", () => {
        const [boombap] = knowledge.get(["pattern/boombap-1"]) as Array<{ pattern: Record<string, unknown> }>
        assert.ok(typeof boombap.pattern.mini === "string" && boombap.pattern.hits === undefined, JSON.stringify(boombap.pattern))
        const hits = knowledge.patternHits("pattern/boombap-1", track("t1", "Drums", "Playfield"), {}, 4)
        assert.ok(typeof hits !== "string" && hits.beats === 4 && hits.hits.length === 13, String(hits))
        const [jazz] = knowledge.get(["pattern/jazz-ii-v-i"]) as Array<{ pattern: Record<string, unknown> }>
        assert.equal(jazz.pattern.progression, "ii7:4 V7:4 Imaj7:8")
        const chords = knowledge.patternHits("pattern/jazz-ii-v-i", track("t2", "Keys", "Tubular"), {key: "C major"}, 4)
        assert.ok(typeof chords !== "string" && chords.beats === 16, String(chords))
    })
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
    it("plays a progression written in the other mode in the key's relative, so it stays in key", () => {
        // 2026-11-22: the lofi vamp (vi7 → IVmaj7) came out Cm7 → Amaj7 in E minor.
        const e = parseKey("E minor")!
        assert.equal(progressionMode(["vi7", "IVmaj7"], "minor"), "major")
        assert.equal(progressionMode(["i7", "VImaj7"], "major"), "minor")
        assert.equal(progressionMode(["bVII"], "minor"), "minor", "nothing to go on: the key's own")
        const played = progressionKey(["vi7", "IVmaj7"], e)
        assert.deepEqual(chordPitches("vi7", played), [52, 55, 59, 62])     // Em7
        assert.deepEqual(chordPitches("IVmaj7", played), [48, 52, 55, 59])  // Cmaj7
        assert.equal(progressionKey(["i7", "VImaj7"], e), e)
        const g = parseKey("G major")!
        assert.deepEqual(chordPitches("i", progressionKey(["i", "VI", "III", "VII"], g)), [52, 55, 59])   // Em
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

describe("kits", {skip: samples.size === 0 ? "no samples/ (make samples)" : false}, () => {
    it("names samples by machine, role folder and file", () => {
        assert.equal(Math.round(samples.find("RolandTR808/bd/BD0010")?.duration ?? 0), 3)
        assert.ok(samples.search({machine: "909", role: "kick"}, 10).every(sample => sample.id.startsWith("RolandTR909/bd/")))
    })
    it("makes a kit entry into a new Playfield whose pads the drum patterns find", () => {
        const planned = withSamples.expand("sound/kit-trap-808", {pattern: "pattern/trap-2bar", from_bar: 9, bars: 16}, snapshot)
        assert.ok(Array.isArray(planned), String(planned))
        assert.equal(planned.length, 1)
        assert.equal(planned[0].kind, "script")
        assert.match(planned[0].says, /Trap Kit: a new kit track \(Kick \(RolandTR808 BD2525\)/)
        assert.match(planned[0].says, /trap-2bar from bar 9/)
        if (planned[0].kind === "script") {
            compiles(planned[0].code)
            const args = JSON.parse(planned[0].code.slice("const args = ".length, planned[0].code.indexOf(";\n")))
            const kick = args.pads.find((pad: { name: string }) => pad.name.startsWith("Kick")).note
            assert.ok(args.notes.notes.some(([beat, pitch]: number[]) => beat === 0 && pitch === kick), "the kick on 1 is the kick pad")
            assert.equal(args.notes.loop_bars, 2)
        }
    })
    it("with the loop off, leaves a kit's groove to start on the bar its edit lands on, whatever bar it was given", () => {
        // 2026-11-25: bars worked out while planning had passed when the edit landed (a job's "bar 5" put chords 11 bars back).
        const take = {...snapshot, playback: {...snapshot.playback, bar: 30, loop: {...snapshot.playback.loop, on: false}}}
        for (const args of [{pattern: "pattern/four-on-the-floor"}, {pattern: "pattern/four-on-the-floor", from_bar: 5}]) {
            const planned = withSamples.expand("sound/kit-house-909", args, take)
            assert.ok(Array.isArray(planned) && /from the bar it lands on/.test(planned[0].says), JSON.stringify(planned).slice(0, 300))
            const sent = JSON.parse(planned[0].code.slice("const args = ".length, planned[0].code.indexOf(";\n")))
            assert.equal(sent.notes.from_bar, null)
        }
    })
    it("makes an empty kit when no pattern is given", () => {
        const planned = withSamples.expand("sound/kit-house-909", {}, snapshot)
        assert.ok(Array.isArray(planned) && planned[0].kind === "script" && planned[0].code.includes('"notes":null'), String(planned))
    })
    it("makes a kit with hits written out, and refuses unknown roles and samples", () => {
        const made = withSamples.kit({name: "K", pads: [{role: "kick", sample: "RolandTR808/bd/BD0010"}, {role: "snare", sample: "RolandTR808/sd/SD0010"}],
            notes: {hits: [[0, "kick", 1], [1, "snare", 0.8]], beats: 4, from_bar: 3, bars: 8}}, snapshot)
        assert.ok(typeof made !== "string" && made.says.includes("from bar 3"), String(made))
        assert.match(String(withSamples.kit({pads: [{role: "cowbell", sample: "RolandTR808/bd/BD0010"}]}, snapshot)), /unknown drum role cowbell/)
        assert.match(String(withSamples.kit({pads: [{role: "kick", sample: "RolandTR808/bd/NOPE"}]}, snapshot)), /no sample RolandTR808\/bd\/NOPE/)
        assert.match(String(withSamples.kit({pads: [{role: "kick", sample: "RolandTR808/bd/BD0010"}], notes: {hits: [[0, "tuba", 1]], beats: 4}}, snapshot)), /unknown drum role tuba/)
    })
    it("finds sampled instruments by name and makes one a new Soundfont track at its preset", () => {
        assert.ok(samples.searchSounds("fingered bass", 5).some(sound => sound.id === "GeneralUser GS/Finger Bass"))
        const sound = samples.sound("GeneralUser GS/Finger Bass")!
        assert.equal(sound.program, 33)
        const made = withSamples.soundfont({name: "Bass", sound: "GeneralUser GS/Finger Bass", notes: {notes: [[0, 40, 1, 0.9]], loop_bars: 1, from_bar: 3, bars: 8}}, snapshot)
        assert.ok(typeof made !== "string" && made.code.includes(`"preset":${sound.index}`) && made.code.includes('"from_bar":3'), String(made))
        compiles((made as { code: string }).code)
        assert.match(String(withSamples.soundfont({sound: "GeneralUser GS/Kazoo Deluxe"}, snapshot)), /no sound/)
    })
    it("writes a part onto an existing notes track, and refuses tracks that aren't there or aren't notes", () => {
        const made = knowledge.part({track: "t2", notes: {notes: [[0, 60, 4, 0.6]], loop_bars: 2, from_bar: 3, bars: 8}}, snapshot)
        assert.ok(typeof made !== "string" && made.code.includes("return kb.pattern(args)") && made.code.includes('"track":"t2"')
            && made.says === "Keys on Keys, bars 3–10", String(made))
        compiles((made as { code: string }).code)
        assert.match(String(knowledge.part({track: "t9", notes: {notes: [[0, 60, 4, 0.6]]}}, snapshot)), /no track t9/)
        const audio = {...snapshot, tracks: [track("t5", "Loop", "Tape", {kind: "audio"})]}
        assert.match(String(knowledge.part({track: "t5", notes: {notes: [[0, 60, 4, 0.6]]}}, audio)), /audio track/)
        assert.match(String(knowledge.part({track: "t2", notes: {}}, snapshot)), /no notes to write/)
    })
    it("makes an openDAW factory preset a new track on its synth, and puts an effect preset on a track", () => {
        assert.ok(samples.searchSounds("house bass", 5).some(sound => sound.id === "openDAW/House Bass" && sound.device === "Neon"))
        const made = withSamples.soundfont({name: "Bass", sound: "openDAW/House Bass", notes: {notes: [[0, 40, 1, 0.9]], loop_bars: 1, from_bar: 1, bars: 4}}, snapshot)
        assert.ok(typeof made !== "string" && made.code.includes("return kb.preset(args)") && made.code.includes('"device":"Neon"'), String(made))
        compiles((made as { code: string }).code)
        const track = snapshot.tracks[0]
        const plate = withSamples.effectPreset({track: track.ref, preset: "Large Plate"}, snapshot)
        assert.ok(typeof plate !== "string" && plate.code.includes("return kb.effectPreset(args)") && plate.says.includes("DattorroReverb"), String(plate))
        compiles((plate as { code: string }).code)
        assert.match(String(withSamples.effectPreset({track: track.ref, preset: "Huge Hall"}, snapshot)), /no effect preset Huge Hall; there are: .*Large Plate/)
    })
    it("makes the 808 bass a Nano at G1, with notes as written", () => {
        const planned = withSamples.expand("sound/808-bass", {}, snapshot)
        assert.ok(Array.isArray(planned) && planned[0].kind === "script" && planned[0].code.includes('"root_key":31'), String(planned))
        const made = withSamples.sampler({sample: "RolandTR808/bd/BD0010", root_key: 31, tune: -35, notes: {notes: [[0, 33, 2, 1]], loop_bars: 1, from_bar: 5, bars: 4}}, snapshot)
        assert.ok(typeof made !== "string", String(made))
        compiles(made.code)
        assert.ok(made.code.includes('"tune":-35') && made.code.includes('"from_bar":5'))
    })
})
