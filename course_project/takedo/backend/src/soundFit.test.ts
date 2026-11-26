import {strict as assert} from "node:assert"
import {mkdtempSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {describe, it} from "node:test"
import {DefaultTuning, type Snapshot, type Track} from "../../shared/protocol.ts"
import {loadCatalog} from "./catalog.ts"
import {Library} from "./library.ts"
import {loadSamples} from "./samples.ts"
import {soundsAgainst} from "./soundFit.ts"

// Whether each part's sound is for a style (soundFit.ts), on the tracks of the lofi session the producer heard.
// Run from backend/: node --test src/soundFit.test.ts

const Takedo = join(import.meta.dirname, "..", "..")
const catalog = loadCatalog(join(Takedo, "catalog", "devices.json"), join(Takedo, "catalog", "generated.json"))
const samples = loadSamples("../samples")
const track = (ref: string, name: string, key: string, device = name, notes: Array<[string, number, number, number]> = []): Track => ({
    ref, name, kind: "notes", instrument: key, device: {key, name: device, enabled: true}, midiEffects: [], effects: [],
    mix: {volume: 0, pan: 0, mute: false, solo: false}, bars: {from: 1, to: 4}, lanes: [],
    regions: [{ref: `${ref}.r1`, name, from: "1.1.1", to: "5.1.1", muted: false, loop: null, kind: "notes", notes}]
})
const project = (tracks: Track[]) => ({tracks} as unknown as Snapshot)

describe("sounds against a style", () => {
    const library = new Library(join(mkdtempSync(join(tmpdir(), "fit-")), "sound-library.json"), samples)
    it("names the acid bass for lofi, not the Rhodes or the kit", () => {
        const lines = soundsAgainst("lofi", project([
            track("t1", "TR-808", "Playfield", "TR-808"),
            track("t2", "Cubed", "Cubed", "Cubed", [["1.1.1", 40, 2, 100]]),
            track("t3", "Dusty Rhodes Chords", "Tubular", "Dusty Rhodes Chords", [["1.1.1", 60, 16, 80], ["1.1.1", 64, 16, 80], ["1.1.1", 67, 16, 80]]),
            track("t4", "Lofi Room Kit", "Soundfont", "Lofi Room Kit")
        ]), catalog, library)
        assert.equal(lines.length, 1, lines.join("\n"))
        assert.match(lines[0], /^t2 Cubed \(bass\): Cubed is for .*techno/)
        assert.equal(soundsAgainst("techno", project([track("t2", "Acid Bass", "Cubed", "Acid Bass", [["1.1.1", 40, 2, 100]])]), catalog, library).length, 0)
    })
    it("goes by the producer's styles for a library sound a part is named after", () => {
        const bass = track("t2", "Finger Bass", "Soundfont", "Finger Bass", [["1.1.1", 40, 2, 100]])
        library.set("GeneralUser GS/Finger Bass", {verdict: "kept", roles: ["bass"], tuning: DefaultTuning, tags: [], note: "", t: 0, styles: ["house"], moods: []})
        assert.match(soundsAgainst("lofi", project([bass]), catalog, library)[0], /GeneralUser GS\/Finger Bass is for house \(the producer says\), not lofi/)
        library.set("GeneralUser GS/Finger Bass", {verdict: "kept", roles: ["bass"], tuning: DefaultTuning, tags: [], note: "", t: 0, styles: ["lofi"], moods: []})
        assert.equal(soundsAgainst("lofi", project([bass]), catalog, library).length, 0)
    })
    it("leaves out a muted part and a sound nothing is known about", () => {
        const muted = track("t2", "Cubed", "Cubed")
        muted.mix.mute = true
        assert.equal(soundsAgainst("lofi", project([muted, track("t3", "Strange", "Soundfont", "Strange")]), catalog, library).length, 0)
    })
})
