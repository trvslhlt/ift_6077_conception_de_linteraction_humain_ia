// A dial between its two takes (blend.ts). Run from backend/: node --test src/blend.test.ts
import {describe, it} from "node:test"
import assert from "node:assert/strict"
import type {Note, Snapshot, Track} from "../../shared/protocol.ts"
import {blendOf, noteOf} from "./blend.ts"
import {hitOf} from "./generate.ts"
import {recallOf} from "./takes.ts"

const track = (ref: string, name: string, notes: Note[], extra: Partial<Track> = {}): Track => ({ref, name, kind: "notes", instrument: "Vaporisateur",
    device: {key: "Vaporisateur", name: "Vaporisateur", enabled: true}, midiEffects: [], effects: [], mix: {volume: -6, pan: 0, mute: false, solo: false},
    bars: {from: 1, to: 5}, lanes: [], regions: [{ref: `r${ref}`, name, from: "1.1.1", to: "5.1.1", muted: false, loop: 1, kind: "notes", notes}], ...extra})
const kit = (ref: string, name: string, pads: Array<{ note: number, name: string }>, notes: Note[], extra: Partial<Track> = {}): Track =>
    track(ref, name, notes, {instrument: "Playfield", device: {key: "Playfield", name: "Playfield", enabled: true, content: {pads}}, ...extra})
const snapshot = (tracks: Track[], bpm = 120): Snapshot => ({at: {t: 0, pos: "1.1.1", seq: 0, revision: 0}, detail: "full", playing: true,
    playback: {playing: true, pos: "1.1.1", bar: 1, loop: {on: true, from: "1.1.1", to: "5.1.1"}, position: 0, played: 0},
    timeline: {bpm, signature: [4, 4], length: "17.1.1"}, tracks, master: {volume: 0, effects: []}})
const muted = (t: Track): Track => ({...t, mix: {...t.mix, mute: true}})
const pitches = (t: Track | undefined) => new Set((t?.regions[0].notes ?? []).map(([, pitch]) => pitch))

describe("a note's position, both ways", () => {
    it("writes a hit back as the snapshot has it", () => {
        for (const note of [["1.1.1:0", 36, 1, 127], ["1.3.2:0", 42, 1, 64], ["2.4.4:120", 40, 2, 100]] as Note[]) {
            assert.deepEqual(noteOf(hitOf(note, 4), 4), note)
        }
    })
})

describe("a dial between its two takes", () => {
    const old808 = [{note: 36, name: "TR-808 Bass Drum"}, {note: 38, name: "TR-808 Snare Drum"}, {note: 42, name: "TR-808 Closed Hi-Hat"}, {note: 46, name: "TR-808 Open Hi-Hat"}]
    const trapPads = [{note: 60, name: "Kick (RolandTR808 BD2525)"}, {note: 61, name: "Snare (RolandTR808 SD5075)"}, {note: 62, name: "Closed Hat (RolandTR808 CH)"}]
    const oldGroove: Note[] = [["1.1.1:0", 36, 1, 120], ["1.2.1:0", 38, 1, 110], ["1.1.3:0", 42, 1, 80], ["1.3.3:0", 42, 1, 80]]
    const trapGroove: Note[] = [["1.1.1:0", 60, 1, 120], ["1.3.1:0", 61, 1, 110], ...[1, 2, 3, 4].flatMap(beat => [1, 2, 3, 4]
        .map(sixteenth => [`1.${beat}.${sixteenth}:0`, 62, 1, 70] as Note))]
    const bass = track("t2", "Cubed", [["1.1.1:0", 40, 4, 100], ["1.3.1:0", 43, 4, 100]])
    // lo: the project before "make it trap"; hi: its work landed (old kit parked, a trap kit in, the bass rewritten, faster).
    const lo = snapshot([kit("t1", "TR-808", old808, oldGroove), bass], 119)
    const hi = snapshot([muted(kit("t1", "TR-808", old808, oldGroove)), {...bass, mix: {...bass.mix, volume: -2},
        regions: [{...bass.regions[0], notes: [["1.1.1:0", 28, 8, 120]]}]}, kit("t3", "Trap Kit", trapPads, trapGroove)], 140)
    it("puts numbers in between: tempo, levels", () => {
        const {target} = blendOf(lo, hi, 0.5, hi)
        assert.equal(target.timeline.bpm, 129.5)
        assert.equal(target.tracks.find(t => t.ref === "t2")!.mix.volume, -4)
    })
    it("lands exactly on each end", () => {
        const at0 = blendOf(lo, hi, 0, hi).target, at1 = blendOf(lo, hi, 1, hi).target
        assert.deepEqual(at0.tracks.find(t => t.ref === "t2")!.regions[0].notes, lo.tracks[1].regions[0].notes)
        assert.deepEqual(at1.tracks.find(t => t.ref === "t2")!.regions[0].notes, hi.tracks[1].regions[0].notes)
        assert.equal(at0.tracks.find(t => t.ref === "t1")!.mix.mute, false)
        assert.equal(at0.tracks.find(t => t.ref === "t3")!.mix.mute, true)
        assert.equal(at1.tracks.find(t => t.ref === "t1")!.mix.mute, true)
        assert.equal(at1.tracks.find(t => t.ref === "t3")!.mix.mute, false)
    })
    it("hands the drums over at the middle, never both kits at once", () => {
        for (const f of [0.1, 0.3, 0.49, 0.5, 0.7, 0.9]) {
            const {target} = blendOf(lo, hi, f, hi)
            const old = target.tracks.find(t => t.ref === "t1")!, trap = target.tracks.find(t => t.ref === "t3")!
            assert.equal(old.mix.mute !== trap.mix.mute, true, `at ${f}: exactly one kit plays`)
            assert.equal(trap.mix.mute, f < 0.5)
        }
    })
    it("moves the groove across the handover: the old kit toward trap's hats before it, the trap kit from halfway after", () => {
        const before = blendOf(lo, hi, 0.4, hi), after = blendOf(lo, hi, 0.6, hi)
        const old = before.target.tracks.find(t => t.ref === "t1")!, trap = after.target.tracks.find(t => t.ref === "t3")!
        assert.ok(before.governs.has("notes t1") && after.governs.has("notes t3"))
        assert.ok([...pitches(old)].every(pitch => [36, 38, 42, 46].includes(pitch)), "the old kit plays its own pads")
        assert.ok((old.regions[0].notes ?? []).filter(([, pitch]) => pitch === 42).length > 2, "more hats than the old groove's two")
        assert.ok([...pitches(trap)].every(pitch => [60, 61, 62].includes(pitch)), "the trap kit plays its own pads")
        assert.ok((trap.regions[0].notes ?? []).filter(([, pitch]) => pitch === 62).length < 16, "fewer hats than full trap")
        assert.match(after.says.join(), /TR-808 hands over to Trap Kit/)
    })
    it("glides there as a recall: the trap kit back in, the old kit out", () => {
        const now = blendOf(lo, hi, 0.2, hi).target
        const recall = recallOf(blendOf(lo, hi, 0.8, now).target, now)
        assert.ok(recall.values.some(({ref, to}) => ref === "t3.mix.mute" && to === 0))
        assert.ok(recall.values.some(({ref, to}) => ref === "t1.mix.mute" && to === 1))
        assert.ok(recall.scripts.some(script => script.code.includes(`notes("rt3"`)))
    })
    it("pairs pitched parts by register, carrying the line by octaves", () => {
        const sub = track("t4", "808 Bass", [["1.1.1:0", 28, 8, 120]])
        const keys = track("t5", "Keys", [["1.1.1:0", 64, 4, 90], ["1.1.1:0", 67, 4, 90]])
        const lo2 = snapshot([bass, keys]), hi2 = snapshot([muted(bass), keys, sub])
        const after = blendOf(lo2, hi2, 0.75, hi2)
        assert.ok(after.governs.has("notes t4"))
        const line = after.target.tracks.find(t => t.ref === "t4")!.regions[0].notes!
        assert.ok(line.every(([, pitch]) => pitch < 40), `the 808 stays in its register: ${JSON.stringify(line)}`)
    })
    it("hands a bass line around E2 over at the middle, not crossfaded under the old bass", () => {
        // The trap dial's 808 bass, its median E2 (52), and the acid bass it replaced (2026-11-25).
        const acid = track("t2", "Acid Bass", [["1.1.1:0", 45, 2, 100], ["1.2.1:0", 52, 2, 100]]), sub = track("t4", "808 Bass", [["1.1.1:0", 52, 6, 120]])
        const lo4 = snapshot([acid]), hi4 = snapshot([muted(acid), sub])
        const {target} = blendOf(lo4, hi4, 0.49, hi4)
        assert.deepEqual(["t2", "t4"].map(ref => target.tracks.find(t => t.ref === ref)!.mix.mute), [false, true])
    })
    it("crossfades a part that isn't drums or bass: both play in between, one fading as the other comes up", () => {
        const pad = track("t6", "Pad", [["1.1.1:0", 64, 16, 80]]), strings = track("t7", "Strings", [["1.1.1:0", 67, 16, 80]])
        const lo3 = snapshot([pad]), hi3 = snapshot([muted(pad), strings])
        const {target} = blendOf(lo3, hi3, 0.5, hi3)
        const [out, into] = ["t6", "t7"].map(ref => target.tracks.find(t => t.ref === ref)!)
        assert.equal(out.mix.mute, false)
        assert.equal(into.mix.mute, false)
        assert.ok(Math.abs(out.mix.volume - -12.02) < 0.05 && Math.abs(into.mix.volume - -12.02) < 0.05, `${out.mix.volume}, ${into.mix.volume}`)
        const ends = [blendOf(lo3, hi3, 0, hi3).target, blendOf(lo3, hi3, 1, hi3).target]
        assert.deepEqual(ends.map(end => [end.tracks.find(t => t.ref === "t6")!.mix.mute, end.tracks.find(t => t.ref === "t7")!.mix.mute]), [[false, true], [true, false]])
    })
    it("crossfades the kits when the dial says so, and leaves their grooves alone", () => {
        const {target, governs} = blendOf(lo, hi, 0.5, hi, {t1: "crossfade", t3: "crossfade"})
        assert.equal(target.tracks.find(t => t.ref === "t1")!.mix.mute, false)
        assert.equal(target.tracks.find(t => t.ref === "t3")!.mix.mute, false)
        assert.equal(governs.size, 0)
    })
})
