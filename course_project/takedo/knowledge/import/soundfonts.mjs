// Fetches the soundfonts in soundfonts.json into <samples dir>/soundfonts/ (those missing or the wrong size), for
// `make samples`. Usage: node knowledge/import/soundfonts.mjs <samples dir>
import {existsSync, mkdirSync, readFileSync, statSync, writeFileSync} from "node:fs"
import {dirname, join} from "node:path"

const root = join(process.argv[2] ?? "samples", "soundfonts")
const {soundfonts} = JSON.parse(readFileSync(new URL("./soundfonts.json", import.meta.url), "utf8"))
for (const source of soundfonts) {
    const path = join(root, source.file)
    if (existsSync(path) && statSync(path).size === source.size) {continue}
    process.stdout.write(`${source.name}: ${(source.size / 1e6).toFixed(1)} MB… `)
    const response = await fetch(source.url, {headers: {"User-Agent": "takedo-course-project"}})
    if (!response.ok) {throw new Error(`${source.url}: ${response.status}`)}
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length !== source.size) {throw new Error(`${source.name}: ${bytes.length} bytes, expected ${source.size} (the pin moved?)`)}
    mkdirSync(dirname(path), {recursive: true})
    writeFileSync(path, bytes)
    console.log("done")
}
