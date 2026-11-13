// Writes chord `pattern` entries (loops of three or four chords) from Chordonomicon (huggingface.co/datasets/ailsntua/Chordonomicon, revision
// f3a8b678bd65639c01caa342921733f1db01be23, chordonomicon_v2.csv, sha256
// 9d2f4ccdc876a4e816712f128e4772b2af558c2a2923cce5be3a0364fbad9a8d): 680k songs' chords from user-written charts,
// with Spotify's genres. For each genre on our list (KNOWLEDGE.md, "Existing sources"), the four-chord progressions
// the most songs use (common) and the ones used much more there than elsewhere (characteristic), as numerals in the
// song's key, so they fit any project's key. Deterministic: the same file gives the same entries.
//   node knowledge/import/chordonomicon.mjs <chordonomicon_v2.csv>     (from takedo/)
//
// Method, and its limits (the chords are user-written, so noisy): each song's key is estimated from its chords (the
// major key whose diatonic chords cover the most of them; minor when its vi outweighs its I), each chord becomes a
// numeral (root by scale degree, b or # when outside the scale; case by quality; 7ths kept, extensions dropped),
// repeats collapse, and every four-chord window inside a section counts once per song.
import {createReadStream, mkdirSync, readdirSync, rmSync, writeFileSync} from "node:fs"
import {createInterface} from "node:readline"
import {dirname, join} from "node:path"
import {fileURLToPath} from "node:url"

const Root = join(dirname(fileURLToPath(import.meta.url)), "..")
const file = process.argv[2]
if (!file) {throw new Error("usage: node knowledge/import/chordonomicon.mjs <chordonomicon_v2.csv>")}

// Our genres, by Spotify genre words (whole genre names, or a word inside one) and Chordonomicon's main genre.
const Genres = {
    "pop": {main: ["pop"]}, "rock": {main: ["rock"]}, "country": {main: ["country"]}, "punk": {main: ["punk"]},
    "metal": {main: ["metal"]}, "jazz": {main: ["jazz"]}, "reggae": {main: ["reggae"]}, "soul": {main: ["soul"]},
    "hip-hop": {main: ["rap"], words: ["hip hop", "boom bap"]},
    "lofi-hip-hop": {words: ["lo-fi", "lofi", "chillhop", "lo-fi beats"]},
    "trap": {words: ["trap"]}, "r-and-b": {words: ["r&b", "neo soul", "contemporary r&b"]},
    "neo-soul": {words: ["neo soul"]}, "funk": {words: ["funk"]}, "disco": {words: ["disco"]},
    "house": {words: ["house"]}, "deep-house": {words: ["deep house"]}, "techno": {words: ["techno"]},
    "uk-garage": {words: ["uk garage", "garage house", "2-step"]}, "drum-and-bass": {words: ["drum and bass", "liquid funk", "jungle"]},
    "dubstep": {words: ["dubstep"]}, "trip-hop": {words: ["trip hop", "downtempo"]}, "ambient": {words: ["ambient"]},
    "bossa-nova": {words: ["bossa nova"]}, "latin": {words: ["latin", "reggaeton", "salsa", "bachata"]},
    "afrobeat": {words: ["afrobeat", "afrobeats", "afropop"]}, "dub": {words: ["dub"], exact: true},
    "synth-pop": {words: ["synthpop", "synth-pop", "new wave"]}, "indie": {words: ["indie"]},
    "synthwave": {words: ["synthwave", "retrowave", "outrun"]}, "vaporwave": {words: ["vaporwave"]},
    "gospel": {words: ["gospel"]}, "blues": {words: ["blues"]}, "electronic": {main: ["electronic"]},
    "edm": {words: ["edm", "electro house", "big room", "progressive house"]}, "folk": {words: ["folk"]}
}
const Common = 4, Characteristic = 3, MinSongs = 40, MinShare = 0.01

// ---- chords ----
const Letters = {C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11}
// "Fsmin7/A" → {root: 6, quality: "min", seventh: "7"}; null for no chord ("N", ".", junk).
const parseChord = text => {
    const match = /^([A-G])(s|#|b)?([^/]*)/.exec(text)
    if (match === null) {return null}
    const root = (Letters[match[1]] + (match[2] === "s" || match[2] === "#" ? 1 : match[2] === "b" ? -1 : 0) + 12) % 12
    const rest = match[3]
    const quality = /^(dim|o|°)/.test(rest) ? "dim" : /^(aug|\+)/.test(rest) ? "aug" : /^(hdim|m7b5|min7b5|ø)/.test(rest) ? "hdim"
        : /^(min|m(?!aj))/.test(rest) ? "min" : "maj"
    const seventh = quality === "hdim" ? "7" : /maj7|maj9|maj11|maj13|M7/.test(rest) ? "maj7" : /(^|[^a-z])(7|9|11|13)/.test(rest) || /^(min|m)(7|9|11|13)/.test(rest) ? "7" : ""
    return {root, quality, seventh}
}
const Major = [0, 2, 4, 5, 7, 9, 11], Minor = [0, 2, 3, 5, 7, 8, 10]
const DiatonicMajor = {0: "maj", 2: "min", 4: "min", 5: "maj", 7: "maj", 9: "min", 11: "dim"}
// The major key (tonic) whose diatonic triads cover the most of the song's chords; minor when vi outweighs I.
const keyOf = chords => {
    let best = null
    for (let tonic = 0; tonic < 12; tonic++) {
        let score = 0
        for (const chord of chords) {
            const quality = DiatonicMajor[(chord.root - tonic + 12) % 12]
            score += quality === undefined ? 0 : quality === chord.quality || (quality === "dim" && chord.quality === "hdim") ? 1 : 0.4
        }
        if (best === null || score > best.score) {best = {tonic, score}}
    }
    const weight = interval => chords.filter(chord => (chord.root - best.tonic + 12) % 12 === interval).length
    const minor = weight(9) > weight(0) * 1.2
    return minor ? {tonic: (best.tonic + 9) % 12, mode: "minor"} : {tonic: best.tonic, mode: "major"}
}
const Romans = ["I", "II", "III", "IV", "V", "VI", "VII"]
const numeral = (chord, key) => {
    const scale = key.mode === "major" ? Major : Minor
    const interval = (chord.root - key.tonic + 12) % 12
    let degree = scale.indexOf(interval), accidental = ""
    if (degree < 0) {
        const flat = scale.indexOf((interval + 1) % 12), sharp = scale.indexOf((interval + 11) % 12)
        if (flat >= 0) {degree = flat; accidental = "b"} else {degree = sharp; accidental = "#"}
    }
    const roman = Romans[degree]
    const lower = chord.quality === "min" || chord.quality === "dim" || chord.quality === "hdim"
    const suffix = chord.quality === "dim" ? (chord.seventh ? "°7" : "°") : chord.quality === "hdim" ? "ø7"
        : chord.quality === "aug" ? "+" : chord.seventh === "maj7" ? "maj7" : chord.seventh === "7" ? "7" : ""
    return `${accidental}${lower ? roman.toLowerCase() : roman}${suffix}`
}

// A loop as heard, whatever chord a window happened to start on: a window that ends where it began is a three-chord
// loop; rotations are the same loop, written from the tonic (I or i) when it's in it, else from the first in order.
const loopOf = window => {
    const chords = window[0] === window[3] ? window.slice(0, 3) : window
    if (new Set(chords).size < chords.length) {return null}   // a chord twice in the loop: not a simple cycle
    const rotations = chords.map((_, index) => [...chords.slice(index), ...chords.slice(0, index)])
    const tonic = rotations.find(rotation => /^(I|i)(7|maj7)?$/.test(rotation[0]))
    return (tonic ?? rotations.sort((a, b) => a.join(" ").localeCompare(b.join(" ")))[0]).join(" ")
}

// ---- CSV (quoted fields allowed) ----
const fields = line => {
    const out = []
    let current = "", quoted = false
    for (let index = 0; index < line.length; index++) {
        const char = line[index]
        if (quoted) {
            if (char === '"' && line[index + 1] === '"') {current += '"'; index++}
            else if (char === '"') {quoted = false}
            else {current += char}
        } else if (char === '"') {quoted = true}
        else if (char === ",") {out.push(current); current = ""}
        else {current += char}
    }
    out.push(current)
    return out
}

const genresOf = (spotify, main) => {
    const names = [...spotify.matchAll(/'([^']+)'/g)].map(match => match[1].toLowerCase())
    return Object.entries(Genres).filter(([, rule]) =>
        (rule.main ?? []).includes(main)
        || (rule.words ?? []).some(word => names.some(name => rule.exact ? name === word || name.split(" ").includes(word) && !name.includes("dubstep") : name.includes(word))))
        .map(([genre]) => genre)
}

// counts[genre][progression] = {songs, sections: {verse: n, …}}; totals for "characteristic".
const counts = new Map(), songsPer = new Map(), overall = new Map()
let header = null, total = 0
const lines = createInterface({input: createReadStream(file), crlfDelay: Infinity})
for await (const line of lines) {
    const row = fields(line)
    if (header === null) {header = Object.fromEntries(row.map((name, index) => [name, index])); continue}
    const genres = genresOf(row[header.genres] ?? "", row[header.main_genre] ?? "")
    const sections = []
    let current = null
    for (const token of (row[header.chords] ?? "").split(/\s+/)) {
        const section = /^<([a-z]+)_?\d*>$/.exec(token)
        if (section !== null) {current = {name: section[1], chords: []}; sections.push(current); continue}
        const chord = parseChord(token)
        if (chord === null) {continue}
        if (current === null) {current = {name: "song", chords: []}; sections.push(current)}
        current.chords.push(chord)
    }
    const all = sections.flatMap(section => section.chords)
    if (all.length < 4) {continue}
    total++
    const key = keyOf(all)
    const found = new Map()   // progression → sections it's in, for this song
    for (const section of sections) {
        const names = section.chords.map(chord => numeral(chord, key)).filter((name, index, list) => index === 0 || name !== list[index - 1])
        for (let index = 0; index + 4 <= names.length; index++) {
            const window = names.slice(index, index + 4)
            if (new Set(window).size < 3) {continue}   // two-chord back-and-forths are a vamp, not a progression
            const text = loopOf(window)
            if (text === null) {continue}
            if (!found.has(text)) {found.set(text, new Set())}
            found.get(text).add(section.name)
        }
    }
    found.forEach((_, text) => overall.set(text, (overall.get(text) ?? 0) + 1))
    for (const genre of genres) {
        songsPer.set(genre, (songsPer.get(genre) ?? 0) + 1)
        if (!counts.has(genre)) {counts.set(genre, new Map())}
        const byProgression = counts.get(genre)
        found.forEach((sectionNames, text) => {
            const entry = byProgression.get(text) ?? {songs: 0, sections: {}, minor: 0}
            entry.songs++
            if (key.mode === "minor") {entry.minor++}
            sectionNames.forEach(name => entry.sections[name] = (entry.sections[name] ?? 0) + 1)
            byProgression.set(text, entry)
        })
    }
}

const outDir = join(Root, "pattern")
mkdirSync(outDir, {recursive: true})
readdirSync(outDir).filter(name => name.startsWith("prog-")).forEach(name => rmSync(join(outDir, name)))
const percent = value => `${(value * 100).toFixed(value < 0.1 ? 1 : 0)}%`
const title = genre => genre.replace(/-and-/g, " & ").replace(/-/g, " ")
const slug = text => text.toLowerCase().replace(/[°]/g, "dim").replace(/ø/g, "hdim").replace(/[^a-z0-9#]+/g, "-").replace(/#/g, "sharp").replace(/^-|-$/g, "")
let written = 0
const report = []
for (const [genre, byProgression] of [...counts].sort(([a], [b]) => a.localeCompare(b))) {
    const songs = songsPer.get(genre)
    if (songs < MinSongs) {report.push(`${genre}: ${songs} songs, skipped`); continue}
    const ranked = [...byProgression].map(([text, entry]) => ({text, ...entry, share: entry.songs / songs,
        lift: (entry.songs / songs) / ((overall.get(text) ?? 1) / total)}))
    const common = [...ranked].sort((a, b) => b.songs - a.songs || a.text.localeCompare(b.text)).slice(0, Common)
    const characteristic = ranked.filter(entry => entry.share >= MinShare && entry.songs >= 10 && !common.includes(entry))
        .sort((a, b) => b.lift - a.lift || a.text.localeCompare(b.text)).slice(0, Characteristic)
    report.push(`${genre}: ${songs} songs`)
    for (const [kind, list] of [["common", common], ["characteristic", characteristic]]) {
        list.forEach((entry, index) => {
            const chords = entry.text.split(" ")
            const where = Object.entries(entry.sections).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([name]) => name).join(" and ")
            const minorShare = entry.minor / entry.songs
            const mode = minorShare > 0.6 ? "minor" : minorShare < 0.4 ? "major" : "either"
            const name = `prog-${genre}-${kind}-${index + 1}`
            const value = {
                key: `pattern/${name}`, kind: "pattern",
                summary: `${title(genre)}, ${kind}: ${chords.join(" → ")} (${percent(entry.share)} of ${songs.toLocaleString("en")} songs${kind === "characteristic" ? `, ${entry.lift.toFixed(1)}× more than overall` : ""})`,
                tags: [title(genre), "chords", "progression", kind, mode === "either" ? "major or minor" : mode],
                label: chords.join(" "),
                group: `Chord loops, ${title(genre)} (Chordonomicon; numerals in the key, a bar per chord)`,
                devices: [], links: [],
                checked: {how: "imported", by: "knowledge/import/chordonomicon.mjs", date: "2026-11-12", opendaw: "652e6ca"},
                sources: [{title: "Chordonomicon (Kantarelis et al. 2024), chordonomicon_v2.csv", url: "https://huggingface.co/datasets/ailsntua/Chordonomicon"}],
                body: [
                    `In ${entry.songs.toLocaleString("en")} of ${songs.toLocaleString("en")} ${title(genre)} songs (${percent(entry.share)}), mostly in ${where} sections; ${mode === "either" ? "in major and minor keys alike" : `mostly in ${mode} keys: use the project's key in ${mode}, or its relative ${mode === "minor" ? "major" : "minor"} if that's what the project is in, and read the numerals there`}.`,
                    `A loop of ${chords.length} chords, written from the tonic when it's in it (songs start it anywhere). Numerals follow the key's own scale (natural minor in minor keys); b and # mark roots outside it. A bar per chord; change the rhythm and voicing to suit the part.`,
                    "From user-written chord charts, with each song's key estimated: frequent progressions are reliable, rarer ones less so."
                ],
                pattern: {type: "chords", beats: chords.length * 4, chords: chords.map((chord, slot) => [slot * 4, chord, 4])},
                apply: {params: {track: {type: "track", about: "a chordal part (keys, pad)"}, key: {type: "key", about: "the project's key, e.g. \"G major\""},
                    from_bar: {type: "number", optional: true}, bars: {type: "number", optional: true}, octave: {type: "number", optional: true, default: 3}},
                    steps: [{op: "pattern", input: {track: "$track", key: "$key", from_bar: "$from_bar", bars: "$bars", octave: "$octave"}}]}
            }
            writeFileSync(join(outDir, `${name}.json`), `${JSON.stringify(value, null, 1)}\n`)
            written++
        })
    }
}
console.log(report.join("\n"))
console.log(`${total.toLocaleString("en")} songs read; wrote ${written} progression patterns`)
