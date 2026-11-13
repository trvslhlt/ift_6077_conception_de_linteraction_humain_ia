// Writes drum `pattern` entries from the Groove MIDI Dataset (Magenta, groove-v1.0.0-midionly.zip, sha256
// 651cbc524ffb891be1a3e46d89dc82a1cecb09a57c748c7b45b844c4841dcc1e): human drummers on an electronic kit, labelled by
// style, tempo and beat or fill. For each style (and sub-style, where the label has a real one), two beats near the
// style's median tempo, two bars each, with the human timing and velocities kept; and one fill per main style.
// Deterministic: the same download gives the same files.
//   node knowledge/import/groove.mjs <unzipped dir containing groove/info.csv>     (from takedo/)
import {readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync} from "node:fs"
import {join, dirname} from "node:path"
import {fileURLToPath} from "node:url"

const Root = join(dirname(fileURLToPath(import.meta.url)), "..")
const source = process.argv[2]
if (!source) {throw new Error("usage: node knowledge/import/groove.mjs <dir with groove/info.csv>")}
const Groove = join(source, "groove")

// The dataset's Roland TD-11 notes to our drum roles (backend/src/knowledge.ts, DrumRoles).
const Roles = {36: "kick", 38: "snare", 40: "snare", 37: "rim", 39: "clap", 48: "tom_high", 50: "tom_high", 45: "tom_mid", 47: "tom_mid",
    43: "tom_low", 58: "tom_low", 46: "open_hat", 26: "open_hat", 42: "closed_hat", 22: "closed_hat", 44: "closed_hat",
    49: "crash", 55: "crash", 57: "crash", 52: "crash", 51: "ride", 59: "ride", 53: "ride"}
// Main styles to our tag words (KNOWLEDGE.md's genre list where it overlaps).
const Tags = {
    afrobeat: ["afrobeat", "afro", "fela"], afrocuban: ["afro-cuban", "latin", "clave"], blues: ["blues", "shuffle"],
    country: ["country", "train beat"], dance: ["dance", "disco", "house"], funk: ["funk", "groove", "soul"],
    gospel: ["gospel", "church", "soul"], highlife: ["highlife", "afro", "west african"], hiphop: ["hip hop", "boom bap", "breakbeat"],
    jazz: ["jazz", "swing"], latin: ["latin", "brazilian"], middleeastern: ["middle eastern", "arabic"],
    neworleans: ["new orleans", "second line", "funk"], pop: ["pop"], punk: ["punk", "fast", "rock"],
    reggae: ["reggae", "one drop", "dub"], rock: ["rock", "indie"], soul: ["soul", "motown", "r&b"]
}
const Beats = 2, Fills = 1, Bars = 2

// ---- a minimal Standard MIDI File reader: note-ons with their tick, pitch and velocity ----
const readMidi = bytes => {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    if (view.getUint32(0) !== 0x4D546864) {throw new Error("not a MIDI file")}
    const tracks = view.getUint16(10), ppq = view.getUint16(12)
    if (ppq & 0x8000) {throw new Error("SMPTE time isn't supported")}
    const notes = []
    let offset = 14
    for (let track = 0; track < tracks; track++) {
        if (view.getUint32(offset) !== 0x4D54726B) {throw new Error("bad track chunk")}
        const end = offset + 8 + view.getUint32(offset + 4)
        let at = offset + 8, tick = 0, status = 0
        const varLen = () => {
            let value = 0, byte
            do {byte = bytes[at++]; value = (value << 7) | (byte & 0x7F)} while (byte & 0x80)
            return value
        }
        while (at < end) {
            tick += varLen()
            const byte = bytes[at]
            // Meta and sysex events don't change running status, which only channel messages set.
            // (The length is read first: `at += varLen()` would read `at` before varLen moves it.)
            if (byte === 0xFF) {at += 2; const length = varLen(); at += length; continue}
            if (byte === 0xF0 || byte === 0xF7) {at++; const length = varLen(); at += length; continue}
            if (byte & 0x80) {status = byte; at++}
            const kind = status & 0xF0
            const data1 = bytes[at++], data2 = kind === 0xC0 || kind === 0xD0 ? 0 : bytes[at++]
            if (kind === 0x90 && data2 > 0) {notes.push({tick, pitch: data1, velocity: data2})}
        }
        offset = end
    }
    return {ppq, notes: notes.sort((a, b) => a.tick - b.tick || a.pitch - b.pitch)}
}

// Hits in [fromBeat, fromBeat + beats), as [beat, role, velocity]; a hit played a little early counts on the beat.
const window = ({ppq, notes}, fromBeat, beats) => {
    const early = 1 / 16
    return notes.flatMap(note => {
        const beat = note.tick / ppq - fromBeat
        const role = Roles[note.pitch]
        if (role === undefined || beat < -early || beat >= beats - early) {return []}
        return [[Math.max(0, Number(beat.toFixed(3))), role, Number((note.velocity / 127).toFixed(2))]]
    })
}

const rows = (() => {
    const [header, ...lines] = readFileSync(join(Groove, "info.csv"), "utf8").trim().split("\n")
    const names = header.split(",")
    return lines.map(line => Object.fromEntries(line.split(",").map((value, index) => [names[index], value])))
})()
// "funk/groove3" and "rock/fill7" carry no sub-style; "rock/halftime" and "funk/purdieshuffle" do.
const styleOf = row => {
    const [main, sub] = row.style.split("/")
    return {main, sub: sub === undefined || /^(groove|fill)\d+$/.test(sub) ? null : sub}
}
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
const pretty = text => text.replace(/-/g, " ")
const label = ({main, sub}) => `${pretty(main === "hiphop" ? "hip hop" : main === "neworleans" ? "New Orleans" : main === "afrocuban" ? "Afro-Cuban" : main === "middleeastern" ? "Middle Eastern" : main)}${sub ? ` (${pretty(sub)})` : ""}`
const slug = text => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")

const outDir = join(Root, "pattern")
mkdirSync(outDir, {recursive: true})
readdirSync(outDir).filter(name => name.startsWith("gmd-")).forEach(name => rmSync(join(outDir, name)))

const entry = (key, summary, tags, beats, hits, body, row, group) => ({
    key, kind: "pattern", summary, tags, group, devices: [], links: [],
    checked: {how: "imported", by: "knowledge/import/groove.mjs", date: "2026-11-12", opendaw: "652e6ca"},
    sources: [{title: `Groove MIDI Dataset (Magenta), ${row.midi_filename}`, url: "https://magenta.tensorflow.org/datasets/groove"}],
    body, pattern: {type: "drums", beats, hits},
    apply: {params: {track: {type: "track", about: "the drum track (a kit)"}, from_bar: {type: "number", optional: true}, bars: {type: "number", optional: true}},
        steps: [{op: "pattern", input: {track: "$track", from_bar: "$from_bar", bars: "$bars"}}]}
})

const groups = new Map()
rows.filter(row => row.time_signature === "4-4").forEach(row => {
    const style = styleOf(row), id = `${row.beat_type}:${style.main}${style.sub ? `/${style.sub}` : ""}`
    if (!groups.has(id)) {groups.set(id, {style, type: row.beat_type, rows: []})}
    groups.get(id).rows.push(row)
})
const written = []
for (const {style, type, rows: members} of [...groups.values()].sort((a, b) => a.rows[0].style.localeCompare(b.rows[0].style))) {
    if (type === "fill" && style.sub !== null) {continue}
    const middle = median(members.map(row => Number(row.bpm)))
    const picked = [...members].sort((a, b) => Math.abs(a.bpm - middle) - Math.abs(b.bpm - middle) || a.midi_filename.localeCompare(b.midi_filename))
    let count = 0
    for (const row of picked) {
        if (count >= (type === "beat" ? Beats : Fills)) {break}
        const midi = readMidi(readFileSync(join(Groove, row.midi_filename)))
        const totalBars = Math.floor(Math.max(...midi.notes.map(note => note.tick)) / midi.ppq / 4)
        let hits, fromBar
        if (type === "beat") {
            if (totalBars < 1 + Bars) {continue}
            fromBar = 1                                         // skip the first bar: drummers settle in
            hits = window(midi, fromBar * 4, Bars * 4)
        } else {
            // A fill file is a bar or two of beat and the fill: the bar with the most hits.
            const bars = Array.from({length: Math.max(1, totalBars + 1)}, (_, bar) => ({bar, hits: window(midi, bar * 4, 4)}))
            const busiest = bars.sort((a, b) => b.hits.length - a.hits.length)[0]
            fromBar = busiest.bar
            hits = busiest.hits
        }
        if (hits.length < (type === "beat" ? 12 : 6)) {continue}
        count++
        const name = `gmd-${slug(style.main)}${style.sub ? `-${slug(style.sub)}` : ""}-${type}${type === "beat" ? `-${count}` : ""}`
        const roles = [...new Set(hits.map(([, role]) => role))].sort()
        const tags = [...new Set([...(Tags[style.main] ?? [style.main]), ...(style.sub ? [pretty(style.sub)] : []), "drums", type === "fill" ? "fill" : "groove", "human", "live drums"])]
        const summary = type === "beat"
            ? `${label(style)} groove, ${Bars} bars at ${row.bpm} BPM, played by a human drummer (Groove MIDI)`
            : `${label(style)} fill, 1 bar at ${row.bpm} BPM, played by a human drummer (Groove MIDI)`
        const body = [
            `Played at ${row.bpm} BPM; it holds up roughly ±15% from there. Uses ${roles.join(", ")}.`,
            "Human timing and dynamics kept: hits sit a little ahead of or behind the grid, and velocities vary. Don't quantize it unless asked; that's the point of it.",
            ...(type === "fill" ? ["Write it on the bar before a section change (from_bar = that bar, bars = 1)."] : [])
        ]
        const value = entry(`pattern/${name}`, summary, tags, type === "beat" ? Bars * 4 : 4, hits, body, row,
            `Groove MIDI drums, ${label({main: style.main, sub: null})} (human drummers; 2-bar beats and 1-bar fills)`)
        writeFileSync(join(outDir, `${name}.json`), `${JSON.stringify(value, null, 1)}\n`)
        written.push(name)
    }
}
console.log(`wrote ${written.length} Groove MIDI patterns`)
