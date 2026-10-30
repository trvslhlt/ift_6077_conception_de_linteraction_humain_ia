// Fetches the library's recorded sounds from the Versilian Community Sample Library (VCSL, CC0) at the commit pinned
// in sources.json, then prepares each one: 48 kHz, leading silence trimmed (so hits land on the beat), trailing
// silence trimmed, cut to `maxSeconds` with a fade-out, peak at -1 dBFS. Downloads are cached in .cache/.
// Usage: node scripts/fetch.mjs (from sample_library/). Needs ffmpeg.
import {execFileSync} from "node:child_process"
import {existsSync, mkdirSync, readFileSync, writeFileSync} from "node:fs"
import {dirname} from "node:path"
import {normalize, peak, RATE, readWav, writeWav} from "./audio.mjs"

const sources = JSON.parse(readFileSync("sources.json", "utf8"))
const {repo, commit} = sources.vcsl
const Fade = 0.3

// First and last frames louder than `db` below the peak.
const audibleRange = (channels, db) => {
    const threshold = peak(channels) * 10 ** (db / 20)
    const loud = index => channels.some(data => Math.abs(data[index]) >= threshold)
    let first = 0, last = channels[0].length - 1
    while (first < last && !loud(first)) {first++}
    while (last > first && !loud(last)) {last--}
    return [first, last + 1]
}

const prepare = (channels, maxSeconds) => {
    const [, end] = audibleRange(channels, -60)
    const [start] = audibleRange(channels, -40)
    const length = Math.min(end - start, Math.round(maxSeconds * RATE))
    const fade = Math.round(Fade * RATE)
    return normalize(channels.map(data => data.slice(start, start + length).map((value, i) =>
        i > length - fade ? value * (length - i) / fade : value)))
}

for (const sample of sources.samples.filter(sample => sample.source.vcsl !== undefined)) {
    const cached = `.cache/vcsl/${sample.source.vcsl}`
    if (!existsSync(cached)) {
        const url = `${repo.replace("github.com", "raw.githubusercontent.com")}/${commit}/`
            + sample.source.vcsl.split("/").map(encodeURIComponent).join("/")
        const response = await fetch(url)
        if (!response.ok) {throw new Error(`${sample.id}: HTTP ${response.status} for ${url}`)}
        mkdirSync(dirname(cached), {recursive: true})
        writeFileSync(cached, Buffer.from(await response.arrayBuffer()))
    }
    const converted = `.cache/converted/${sample.id}.wav`
    mkdirSync(dirname(converted), {recursive: true})
    execFileSync("ffmpeg", ["-v", "error", "-y", "-i", cached, "-ar", String(RATE), "-c:a", "pcm_f32le", converted])
    const path = `samples/${sample.file}`
    mkdirSync(dirname(path), {recursive: true})
    writeWav(path, prepare(readWav(converted).channels, sample.source.maxSeconds ?? 4))
    console.log(`vcsl   ${path}`)
}
