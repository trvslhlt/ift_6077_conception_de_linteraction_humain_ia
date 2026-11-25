// Fetches openDAW's factory presets in presets.json into <samples dir>/presets/<uuid>.odp (those missing or not
// matching their hash), for `make samples`. Usage: node knowledge/import/presets.mjs <samples dir>
import {createHash} from "node:crypto"
import {existsSync, mkdirSync, readFileSync, writeFileSync} from "node:fs"
import {join} from "node:path"

const root = join(process.argv[2] ?? "samples", "presets")
const {source, presets} = JSON.parse(readFileSync(new URL("./presets.json", import.meta.url), "utf8"))
const hash = bytes => createHash("sha256").update(bytes).digest("hex")
mkdirSync(root, {recursive: true})
let fetched = 0
for (const preset of presets) {
    const path = join(root, `${preset.uuid}.odp`)
    if (existsSync(path) && hash(readFileSync(path)) === preset.sha256) {continue}
    const response = await fetch(`${source}/${preset.uuid}.odp`, {headers: {"User-Agent": "takedo-course-project"}})
    if (!response.ok) {throw new Error(`${preset.name}: ${response.status}`)}
    const bytes = Buffer.from(await response.arrayBuffer())
    if (hash(bytes) !== preset.sha256) {throw new Error(`${preset.name}: its hash changed upstream (the pin moved?)`)}
    writeFileSync(path, bytes)
    fetched++
}
console.log(`presets: ${presets.length} (${fetched} fetched)`)
