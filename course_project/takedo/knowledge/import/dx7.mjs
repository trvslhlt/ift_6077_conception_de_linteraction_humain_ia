// Writes knowledge entries from the DX7 cartridges openDAW bundles (copied into knowledge/dx7/ from openDAW 652e6ca's
// packages/app/studio/public/tubular): one `sound` entry per Tubular Classics voice (openDAW's own 32, written for
// Tubular), and `note/dx7-library`, every bundled voice by cartridge, so an agent can load any of them by name.
// Deterministic: re-running it gives the same files.
//   node knowledge/import/dx7.mjs          (from takedo/)
import {readFileSync, writeFileSync, mkdirSync} from "node:fs"
import {join, dirname} from "node:path"
import {fileURLToPath} from "node:url"

const Root = join(dirname(fileURLToPath(import.meta.url)), "..")
const OpenDAW = "652e6ca"
const index = JSON.parse(readFileSync(join(Root, "dx7", "index.json"), "utf8"))

// Tubular Classics by family (the families are the comments in openDAW's adapters/scripts/tubular-classics.mts).
const Families = {
    "e-piano": {voices: ["Rhodes", "Soft Rhds", "Brite Rhds"], tags: ["keys", "electric piano", "rhodes", "e-piano", "tine"],
        roles: "chords and comping; soft voicings around C3–C5", genres: ["lofi", "neo soul", "r&b", "jazz", "funk", "hip hop", "chill"]},
    "bells": {voices: ["Tubular", "Glass Bell", "Celesta", "Marimba", "Vibes", "Steel Drum"], tags: ["bells", "mallets", "chime", "pluck"],
        roles: "melodies, arpeggios and sparkle on top; short decays sit well above C4", genres: ["ambient", "pop", "lofi", "tropical", "downtempo"]},
    "bass": {voices: ["Slap Bass", "Solid Bass", "Synth Bass", "Fretless"], tags: ["bass", "fm bass"],
        roles: "bass lines, C1–C2; mono parts", genres: ["funk", "disco", "80s", "synth-pop", "house", "r&b"]},
    "ensemble": {voices: ["Brass Sect", "Strings", "Analog Pad", "Choir", "Bell Pad"], tags: ["pad", "strings", "brass", "choir", "sustained"],
        roles: "pads and long chords; stabs for the brass", genres: ["synth-pop", "80s", "ambient", "cinematic", "pop"]},
    "winds": {voices: ["Flute", "Harmonica"], tags: ["lead", "wind", "melody"],
        roles: "melodies and hooks", genres: ["pop", "ambient", "folk", "lofi"]},
    "keys": {voices: ["Clav", "Harpsichrd"], tags: ["keys", "clavinet", "harpsichord", "funky", "pluck"],
        roles: "rhythmic comping (clav), baroque lines (harpsichord)", genres: ["funk", "disco", "soul", "baroque pop"]},
    "organ": {voices: ["Drawbars", "Pipe Organ"], tags: ["organ", "keys", "sustained"],
        roles: "sustained chords, gospel and church sounds", genres: ["gospel", "soul", "reggae", "rock", "house"]},
    "plucked": {voices: ["Harp", "Nylon Gtr"], tags: ["pluck", "guitar", "harp", "acoustic"],
        roles: "arpeggios and gentle chords", genres: ["bossa nova", "ambient", "lofi", "folk", "pop"]},
    "lead": {voices: ["Square Ld", "Bright Ld", "FM Lead"], tags: ["lead", "synth", "melody"],
        roles: "lead lines above C4", genres: ["synth-pop", "80s", "chiptune", "electro", "pop"]},
    "drums": {voices: ["Bass Drum", "Snare", "Timpani"], tags: ["drums", "percussion", "fm drums"],
        roles: "FM percussion: one note per hit (pitch changes the tone)", genres: ["electro", "80s", "cinematic"]}
}

const slug = name => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
const classics = index.cartridges.find(cartridge => cartridge.file === "Tubular_Classics.syx")
const written = []
for (const [family, {voices, tags, roles, genres}] of Object.entries(Families)) {
    for (const voice of voices) {
        if (!classics.voices.includes(voice)) {throw new Error(`${voice} isn't in Tubular Classics`)}
        const key = `sound/tubular-${slug(voice)}`
        const entry = {
            key, kind: "sound",
            summary: `${voice} (Tubular Classics, openDAW's own DX7 voice): ${family}`,
            group: `Tubular Classics sounds, ${family} (DX7 voices on a Tubular)`,
            tags: [...new Set([...tags, ...genres, "tubular", "fm", "dx7"])],
            devices: ["Tubular"], links: [],
            checked: {how: "imported", by: "knowledge/import/dx7.mjs", date: "2026-11-12", opendaw: OpenDAW},
            sources: [{title: "openDAW Tubular Classics cartridge (packages/studio/adapters/scripts/tubular-classics.mts)",
                url: "https://github.com/andremichelle/openDAW/blob/main/packages/studio/adapters/scripts/tubular-classics.mts"}],
            body: [`Good for ${roles}. Usual in: ${genres.join(", ")}.`,
                "Loads the whole voice (all six operators, envelopes, algorithm) onto a Tubular: a track's own Tubular, or a new Tubular track when no track is given. To change it after, set Tubular's fields (catalog paths) with the instrument op or a script."],
            apply: {
                params: {
                    track: {type: "track", optional: true, about: "a track whose instrument is a Tubular; leave out to add a new track"},
                    name: {type: "text", optional: true, about: "the new track's name"}
                },
                steps: [{op: "dx7", input: {track: "$track", voice: `Tubular_Classics/${voice}`, name: "$name"}}]
            }
        }
        mkdirSync(join(Root, "sound"), {recursive: true})
        writeFileSync(join(Root, "sound", `tubular-${slug(voice)}.json`), `${JSON.stringify(entry, null, 2)}\n`)
        written.push(key)
    }
}

// Any bundled voice, by name: a generic executable entry, and the list of names to choose from.
writeFileSync(join(Root, "sound", "dx7-voice.json"), `${JSON.stringify({
    key: "sound/dx7-voice", kind: "sound",
    summary: "Any of openDAW's ~1,200 bundled DX7 voices on a Tubular, by cartridge and name (list: note/dx7-library)",
    tags: ["dx7", "fm", "tubular", "preset", "patch"],
    devices: ["Tubular"], links: ["note/dx7-library"],
    checked: {how: "imported", by: "knowledge/import/dx7.mjs", date: "2026-11-12", opendaw: OpenDAW},
    body: ["voice is \"<cartridge>/<voice name>\" as note/dx7-library lists them (\"SynprezFM_08/DL RHODES4\"), or \"<cartridge>/<1..32>\".",
        "The SynprezFM and Dexed cartridges are a compilation of classic DX7 patches; names are the patch authors' and often abbreviated (E.PNO, BRS, STRG)."],
    apply: {
        params: {
            voice: {type: "text", about: "cartridge/voice name, from note/dx7-library"},
            track: {type: "track", optional: true, about: "a track whose instrument is a Tubular; leave out to add a new track"},
            name: {type: "text", optional: true, about: "the new track's name"}
        },
        steps: [{op: "dx7", input: {track: "$track", voice: "$voice", name: "$name"}}]
    }
}, null, 2)}\n`)

mkdirSync(join(Root, "note"), {recursive: true})
writeFileSync(join(Root, "note", "dx7-library.json"), `${JSON.stringify({
    key: "note/dx7-library", kind: "note",
    summary: "Every DX7 voice openDAW bundles for Tubular, by cartridge: names to load with sound/dx7-voice",
    tags: ["dx7", "fm", "tubular", "preset", "patch", "library"],
    devices: ["Tubular"], links: ["sound/dx7-voice"],
    checked: {how: "imported", by: "knowledge/import/dx7.mjs", date: "2026-11-12", opendaw: OpenDAW},
    sources: index.cartridges.map(cartridge => ({title: `${cartridge.name}: ${cartridge.author}`, ...(cartridge.source ? {url: cartridge.source} : {})})),
    body: index.cartridges.map(cartridge => `${cartridge.file.replace(/\.syx$/, "")}: ${cartridge.voices.map(voice => voice.trim()).join(" | ")}`)
}, null, 2)}\n`)

console.log(`wrote ${written.length} Tubular Classics sounds, sound/dx7-voice and note/dx7-library`)
