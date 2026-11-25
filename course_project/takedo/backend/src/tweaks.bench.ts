import {mkdirSync, writeFileSync} from "node:fs"
import {join} from "node:path"
import {Gateway, loadConfig} from "./gateway.ts"
import {judgeTweak, type TweakJudged, type TriageState} from "./triage.ts"

// Musical tweaks, judged (triage.ts, judgeTweak; variants.ts makes them): on knowledge/bench/tweaks.mjs's labelled
// messages, how often Jev names the right tweak and part, and at each threshold how many a tweak fast path would take and
// how many of those it would get wrong (the music-library plan, steps 3 and 4). Costs Jev cents.
//   node --env-file=../.env src/tweaks.bench.ts        (`make tweak-bench`)
// Results go to knowledge/bench/results/ (git-ignored).

const Takedo = join(import.meta.dirname, "..", "..")
const Concurrency = 4
type Item = { msg: string, tweak: string | string[], part: string | null, amount: number | null, src: string, recent: Array<{ from: string, text: string }> }
const {Messages, Project} = await import(join(Takedo, "knowledge", "bench", "tweaks.mjs")) as { Messages: Item[], Project: TriageState }
const gateway = new Gateway(loadConfig(join(Takedo, "config", "models.json")))
const results: Array<{ item: Item, judged?: TweakJudged, error?: string }> = []
let next = 0
await Promise.all(Array.from({length: Concurrency}, async () => {
    while (next < Messages.length) {
        const item = Messages[next++]
        try {
            results.push({item, judged: await judgeTweak(gateway, () => {}, Project, item.msg, item.recent)})
        } catch (error) {
            results.push({item, error: String(error)})
        }
    }
}))

type Judged = { item: Item, judged: TweakJudged }
const judged = results.filter(result => result.judged !== undefined) as Judged[]
const pct = (n: number, of: number): string => of === 0 ? "-" : `${Math.round(100 * n / of)}%`
const tweakRight = ({item, judged}: Judged) => [item.tweak].flat().includes(judged.tweak)
const partRight = ({item, judged}: Judged) => item.part === null || judged.part === item.part
const isTweak = ({item}: Judged) => item.tweak !== "none"
console.log(`${Messages.length} messages (${Messages.filter(item => item.src === "observed").length} observed), ${results.length - judged.length} errors`)
results.filter(result => result.error !== undefined).slice(0, 3).forEach(result => console.log(`  error: ${result.error}`))

const tweaks = judged.filter(isTweak), nones = judged.filter(result => !isTweak(result))
console.log(`\nTweaks (${tweaks.length}): tweak right ${pct(tweaks.filter(tweakRight).length, tweaks.length)}, part right ` +
    `${pct(tweaks.filter(partRight).length, tweaks.length)}, both ${pct(tweaks.filter(result => tweakRight(result) && partRight(result)).length, tweaks.length)}`)
tweaks.filter(result => !tweakRight(result) || !partRight(result)).forEach(({item, judged}) =>
    console.log(`  "${item.msg}": ${judged.tweak} on ${judged.part} (want ${[item.tweak].flat().join("/")} on ${item.part}; p ${judged.tweakP.toFixed(2)} ${judged.partP.toFixed(2)})`))
console.log(`Not tweaks (${nones.length}): judged none ${pct(nones.filter(({judged}) => judged.tweak === "none").length, nones.length)}`)
nones.filter(({judged}) => judged.tweak !== "none").forEach(({item, judged}) =>
    console.log(`  p ${judged.tweakP.toFixed(2)} "${item.msg}" → ${judged.tweak} on ${judged.part}`))

// Amounts, where the label gives one: off by how much on the 0..3 scale.
const amounts = tweaks.filter(({item}) => item.amount !== null)
const off = amounts.map(({item, judged}) => Math.abs(judged.amount - item.amount!))
console.log(`\nAmounts (${amounts.length}): mean off ${(off.reduce((a, b) => a + b, 0) / Math.max(1, off.length)).toFixed(2)}, within 1: ${pct(off.filter(d => d <= 1).length, off.length)}`)

// A tweak fast path: act when Jev names a tweak with tweak and part at the threshold or more. Wrong: anything but the
// labelled tweak on the labelled part (a none taken is the costly case).
console.log("\nA tweak fast path at each threshold (taken: no model writes notes; wrong: taken but not that tweak on that part)")
for (const threshold of [0.5, 0.6, 0.7, 0.8, 0.9]) {
    const taken = judged.filter(({judged}) => judged.tweak !== "none" && Math.min(judged.tweakP, judged.partP) >= threshold)
    const wrong = taken.filter(result => !isTweak(result) || !tweakRight(result) || !partRight(result))
    console.log(`  ${threshold.toFixed(1)}: taken ${taken.length} of ${tweaks.length} tweaks, wrong ${wrong.length}` +
        `${wrong.length > 0 ? `: ${wrong.map(({item, judged}) => `"${item.msg}" → ${judged.tweak} on ${judged.part}`).join("; ")}` : ""}`)
}
const ms = judged.map(({judged}) => judged.ms).sort((a, b) => a - b)
console.log(`\nJev: median ${ms[Math.floor(ms.length / 2)]} ms`)

const dir = join(Takedo, "knowledge", "bench", "results")
mkdirSync(dir, {recursive: true})
const file = join(dir, `tweaks-${new Date().toISOString().replace(/[:.]/g, "-")}.json`)
writeFileSync(file, JSON.stringify(results, null, 2))
console.log(`\n${file}`)
