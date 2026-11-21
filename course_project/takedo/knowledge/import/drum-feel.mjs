// How a drum pattern feels, from its hits: how busy, the hat subdivision, swing, ghost notes, where the kick goes.
// Words a producer uses ("busy", "sparse", "swung", "straight", "16ths") so the shortlist and Jev can find a pattern
// by feel, not only by style. groove.mjs uses feelOf; run directly, this rewrites the existing Groove MIDI entries'
// summaries and tags in place (no dataset needed: the hits are in the entries).
//   node knowledge/import/drum-feel.mjs          (from takedo/)
import {readdirSync, readFileSync, writeFileSync} from "node:fs"
import {join, dirname} from "node:path"
import {fileURLToPath} from "node:url"

const Ghost = 0.25          // a snare hit softer than this is a ghost note
const Timekeepers = new Set(["closed_hat", "open_hat", "ride", "shaker"])

// hits: [beat, role, velocity]; beats: the pattern's length in beats (4 per bar).
export const feelOf = (hits, beats) => {
    const bars = beats / 4
    const played = hits.filter(([, , velocity]) => velocity >= 0.1)
    const perBar = played.length / bars
    const busy = perBar >= 24 ? "busy" : perBar <= 12 ? "sparse" : "medium"
    // The timekeeper's grid: straight 8ths, 16ths (hits on the e and a), or triplets (swung 8ths land near .67).
    const keeper = hits.filter(([, role]) => Timekeepers.has(role))
    const fraction = beat => beat - Math.floor(beat)
    const near = (f, points, within) => points.some(point => Math.abs(f - point) <= within)
    const share = test => keeper.filter(([beat]) => test(fraction(beat))).length / Math.max(1, keeper.length)
    const sixteenths = share(f => near(f, [0.25, 0.75], 0.06))
    const triplets = share(f => near(f, [0.33, 0.67], 0.05))
    const subdivision = keeper.length < 4 ? null : sixteenths > 0.25 ? "16ths" : "8ths"
    // Swing: off-beats landing late (a straight off-beat is at .5; triplet swing at .67).
    const offbeats = keeper.map(([beat]) => fraction(beat)).filter(f => f > 0.4 && f < 0.8 && !near(f, [0.75], 0.04))
    const late = offbeats.length === 0 ? 0.5 : offbeats.reduce((sum, f) => sum + f, 0) / offbeats.length
    const swing = keeper.length < 4 || offbeats.length < 3 ? null
        : triplets > 0.2 || late >= 0.6 ? "swung" : late >= 0.55 ? "lightly swung" : "straight"
    const ghosts = hits.filter(([, role, velocity]) => role === "snare" && velocity < Ghost && velocity > 0.02).length / bars
    const kicks = hits.filter(([, role, velocity]) => role === "kick" && velocity >= Ghost).length / bars
    const roles = [...new Set(hits.map(([, role]) => role))]
    const thin = roles.length <= 2 ? `only ${roles.join(" and ")}` : null
    const where = keeper.some(([, role]) => role === "ride") && !keeper.some(([, role]) => role === "closed_hat") ? "ride" : "hats"
    const words = [thin, busy, subdivision && `${subdivision} on the ${where}`, swing,
        ghosts >= 2 ? "ghost notes on the snare" : null, kicks >= 5 ? "a busy kick" : kicks <= 2 && roles.includes("kick") ? "a sparse kick" : null].filter(Boolean)
    const tags = [busy === "busy" ? "busy" : null, busy === "sparse" ? "sparse" : null, busy === "sparse" ? "simple" : null,
        subdivision === "16ths" ? "16ths" : null, swing === "swung" || swing === "lightly swung" ? "swing" : swing === "straight" ? "straight" : null,
        swing === "swung" ? "shuffle" : null, ghosts >= 2 ? "ghost notes" : null].filter(Boolean)
    return {words: words.join(", "), tags, thin: thin !== null}
}

// The summary's feel clause, replacing any earlier one: "funk groove, 2 bars at 100 BPM (busy, 16ths on the hats), played by…"
export const withFeel = (summary, words) =>
    summary.replace(/ \([^)]*\)(, played by)/, "$1").replace(/(BPM)(, played by)/, `$1 (${words})$2`)

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "pattern")
    let count = 0
    for (const name of readdirSync(dir).filter(name => name.startsWith("gmd-"))) {
        const path = join(dir, name), entry = JSON.parse(readFileSync(path, "utf8"))
        const {words, tags} = feelOf(entry.pattern.hits, entry.pattern.beats)
        // A style's own tags stay (groove.mjs gives jazz "swing"; shuffles are named so).
        const original = [...(entry.key.startsWith("pattern/gmd-jazz") || entry.key.includes("swing") ? ["swing"] : []),
            ...(entry.key.includes("shuffle") ? ["shuffle"] : [])]
        entry.summary = withFeel(entry.summary, words)
        const Feel = ["busy", "sparse", "simple", "16ths", "swing", "straight", "shuffle", "ghost notes"]
        entry.tags = [...new Set([...entry.tags.filter(tag => !Feel.includes(tag) || original.includes(tag)), ...tags])]
        writeFileSync(path, `${JSON.stringify(entry, null, 1)}\n`)
        count++
    }
    console.log(`described the feel of ${count} Groove MIDI patterns`)
}
