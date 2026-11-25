import {mkdirSync, writeFileSync} from "node:fs"
import {join} from "node:path"
import {Gateway, loadConfig} from "./gateway.ts"
import {type Triage, triage, type TriageState} from "./triage.ts"

// Jev in front of the Team Lead, judged (triage.ts): on knowledge/bench/triage.mjs's labelled messages, how often it
// picks the right path, and for mixer moves the right part and move; then, at each threshold, how many messages a
// mix fast path would take from the Team Lead and how many of those it would get wrong. Costs Jev cents.
//   node --env-file=../.env src/triage.bench.ts        (`make triage-bench`)
// Results go to knowledge/bench/results/ (git-ignored).

const Takedo = join(import.meta.dirname, "..", "..")
const Concurrency = 4
const {Messages, Project} = await import(join(Takedo, "knowledge", "bench", "triage.mjs")) as {
    Messages: Array<{ msg: string, path: Triage["path"], part?: string | null, move?: Triage["move"], src: string }>,
    Project: TriageState
}
const gateway = new Gateway(loadConfig(join(Takedo, "config", "models.json")))
const results: Array<{ item: typeof Messages[number], judged?: Triage, error?: string }> = []
let next = 0
await Promise.all(Array.from({length: Concurrency}, async () => {
    while (next < Messages.length) {
        const item = Messages[next++]
        try {
            results.push({item, judged: await triage(gateway, () => {}, Project, item.msg)})
        } catch (error) {
            results.push({item, error: String(error)})
        }
    }
}))

type Judged = { item: typeof Messages[number], judged: Triage }
const judged = results.filter(result => result.judged !== undefined) as Judged[]
const pct = (n: number, of: number): string => of === 0 ? "-" : `${Math.round(100 * n / of)}%`
console.log(`${Messages.length} messages (${Messages.filter(item => item.src === "observed").length} observed), ${results.length - judged.length} errors`)
results.filter(result => result.error !== undefined).slice(0, 3).forEach(result => console.log(`  error: ${result.error}`))

// Paths: a confusion table, labelled path by Jev's.
const paths = ["mix", "effect", "team"] as const
console.log("\nPath (rows: label, columns: Jev)")
console.log(`  ${"".padEnd(8)}${paths.map(path => path.padStart(8)).join("")}`)
paths.forEach(label => console.log(`  ${label.padEnd(8)}${paths.map(path =>
    String(judged.filter(({item, judged}) => item.path === label && judged.path === path).length).padStart(8)).join("")}`))
console.log(`  right: ${pct(judged.filter(({item, judged}) => item.path === judged.path).length, judged.length)}`)

// Mixer moves: the part and the move, where the label says mix.
const mixes = judged.filter(({item}) => item.path === "mix")
const partRight = ({item, judged}: Judged) => judged.part === item.part
const moveRight = ({item, judged}: Judged) => judged.move === item.move
console.log(`\nMixer moves (${mixes.length}): part right ${pct(mixes.filter(partRight).length, mixes.length)}, ` +
    `move right ${pct(mixes.filter(moveRight).length, mixes.length)}, both ${pct(mixes.filter(result => partRight(result) && moveRight(result)).length, mixes.length)}`)
mixes.filter(result => !partRight(result) || !moveRight(result)).forEach(({item, judged}) =>
    console.log(`  "${item.msg}": ${judged.part} ${judged.move} (want ${item.part} ${item.move}; p ${judged.partP.toFixed(2)} ${judged.moveP.toFixed(2)})`))

// The fast path: act when Jev says mix with path, part and move each at the threshold or more. Right: the label is
// mix with that part and move. Wrong: anything else (another path, or the wrong part or move), the costly case.
console.log("\nA mix fast path at each threshold (taken: no Team Lead call; wrong: taken but not that move)")
for (const threshold of [0.5, 0.6, 0.7, 0.8, 0.9]) {
    const taken = judged.filter(({judged}) => judged.path === "mix" && Math.min(judged.pathP, judged.partP, judged.moveP) >= threshold)
    const wrong = taken.filter(result => result.item.path !== "mix" || !partRight(result) || !moveRight(result))
    console.log(`  ${threshold.toFixed(1)}: taken ${taken.length} of ${mixes.length} mixer moves, wrong ${wrong.length}` +
        `${wrong.length > 0 ? `: ${wrong.map(({item, judged}) => `"${item.msg}" → ${judged.part} ${judged.move}`).join("; ")}` : ""}`)
}
// Wrongly called mix, at any probability: what a fast path must never take.
const notMix = judged.filter(({item, judged}) => item.path !== "mix" && judged.path === "mix")
console.log(`\nNot a mixer move, judged mix (${notMix.length}):`)
notMix.forEach(({item, judged}) => console.log(`  p ${judged.pathP.toFixed(2)} "${item.msg}" → ${judged.part} ${judged.move}`))
const missed = mixes.filter(({judged}) => judged.path !== "mix")
console.log(`Mixer moves judged another path (${missed.length}):`)
missed.forEach(({item, judged}) => console.log(`  ${judged.path} p ${judged.pathP.toFixed(2)} "${item.msg}"`))

const ms = judged.map(({judged}) => judged.ms).sort((a, b) => a - b)
console.log(`\nLatency: median ${ms[Math.floor(ms.length / 2)]} ms, 90% ${ms[Math.floor(ms.length * 0.9)]} ms, max ${ms.at(-1)} ms (${Concurrency} at a time)`)

const dir = join(Takedo, "knowledge", "bench", "results")
mkdirSync(dir, {recursive: true})
const file = join(dir, `triage-${new Date().toISOString().replace(/[:.]/g, "-")}.json`)
writeFileSync(file, JSON.stringify(results, null, 1))
console.log(`\n${file}`)
