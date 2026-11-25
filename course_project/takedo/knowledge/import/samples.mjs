// The sample collections' manifest (samples/manifest.json), made by `make samples` after fetching them. Each WAV gets a
// fixed UUID from its path (a name-based UUID, version 5 layout over SHA-1), so a project that uses a sample names the
// same one after any refetch, and the studio can always reload it from samples/ (page/Samples.ts) when the browser has
// lost its copy. Per sample: where it is, a name, the drum machine, its role (the folder's suffix: bd kick, sd snare,
// hh closed hat, oh open hat, cp clap, rim, cr crash, ...), length and sample rate (from the WAV header).
// Usage: node knowledge/import/samples.mjs <samples dir>
import {createHash} from "node:crypto"
import {openSync, readSync, closeSync, readdirSync, statSync, writeFileSync} from "node:fs"
import {join, relative, sep} from "node:path"

const root = process.argv[2] ?? "samples"
const Roles = {bd: "kick", sd: "snare", hh: "closed hat", oh: "open hat", cp: "clap", rim: "rim", cr: "crash", rd: "ride",
    cb: "cowbell", ht: "high tom", mt: "mid tom", lt: "low tom", perc: "percussion", sh: "shaker", tb: "tambourine",
    misc: "misc", fx: "effect"}

const uuidOf = text => {
    const bytes = createHash("sha1").update(`takedo-sample:${text}`).digest().subarray(0, 16)
    bytes[6] = (bytes[6] & 0x0f) | 0x50
    bytes[8] = (bytes[8] & 0x3f) | 0x80
    const hex = bytes.toString("hex")
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

// Sample rate and length from the RIFF chunks (fmt, data), reading only the header.
const header = path => {
    const fd = openSync(path, "r")
    const buffer = Buffer.alloc(65536)
    const read = readSync(fd, buffer, 0, buffer.length, 0)
    closeSync(fd)
    if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {return null}
    let offset = 12, rate = 0, blockAlign = 0, frames = 0
    while (offset + 8 <= read) {
        const id = buffer.toString("ascii", offset, offset + 4), size = buffer.readUInt32LE(offset + 4)
        if (id === "fmt ") {rate = buffer.readUInt32LE(offset + 12); blockAlign = buffer.readUInt16LE(offset + 20)}
        if (id === "data") {frames = Math.floor(Math.min(size, statSync(path).size - offset - 8) / blockAlign); break}
        offset += 8 + size + (size & 1)
    }
    return rate > 0 && blockAlign > 0 ? {sample_rate: rate, duration: frames / rate} : null
}

const walk = dir => readdirSync(dir, {withFileTypes: true}).flatMap(entry =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : /\.wav$/i.test(entry.name) ? [join(dir, entry.name)] : [])

const samples = walk(root).sort().flatMap(path => {
    const file = relative(root, path).split(sep).join("/")
    const meta = header(path)
    if (meta === null) {return []}
    const [collection, machine, folder] = file.split("/")
    const code = folder?.includes("-") ? folder.slice(folder.lastIndexOf("-") + 1) : null
    const name = file.split("/").pop().replace(/\.wav$/i, "")
    return [{uuid: uuidOf(file), file, collection, machine: machine ?? null, role: code === null ? null : Roles[code] ?? code,
        name: `${machine ?? collection} ${code ?? ""} ${name}`.replace(/\s+/g, " ").trim(), ...meta}]
})
writeFileSync(join(root, "manifest.json"), JSON.stringify({made: new Date().toISOString(), samples}))
console.log(`${samples.length} samples in ${join(root, "manifest.json")}`)
