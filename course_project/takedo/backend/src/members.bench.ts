import {mkdirSync, writeFileSync} from "node:fs"
import {join} from "node:path"
import {Gateway, loadConfig} from "./gateway.ts"
import {Controls, Members, type Triage, triage, type TriageState} from "./triage.ts"

// Jev naming the team member a direction lands with and the kind of control it merits (triage.ts, the same request
// as the fast path's), judged on knowledge/bench/members.mjs's labelled messages. Costs Jev cents.
//   node --env-file=../.env src/members.bench.ts        (`make members-bench`)
// Results go to knowledge/bench/results/ (git-ignored).

type Member = keyof typeof Members
type Control = keyof typeof Controls
const Takedo = join(import.meta.dirname, "..", "..")
const Concurrency = 4
const {Messages, Project} = await import(join(Takedo, "knowledge", "bench", "members.mjs")) as {
    Messages: Array<{ msg: string, member: Member | Member[], control: Control | Control[], src: string, recent: Array<{ from: string, text: string }> }>,
    Project: TriageState
}
const gateway = new Gateway(loadConfig(join(Takedo, "config", "models.json")))
const results: Array<{ item: typeof Messages[number], judged?: Triage, error?: string }> = []
// As code will read it: not a direction, no control.
const read = (judged: Triage): Triage => judged.member === "none" ? {...judged, control: "none"} : judged
let next = 0
await Promise.all(Array.from({length: Concurrency}, async () => {
    while (next < Messages.length) {
        const item = Messages[next++]
        try {results.push({item, judged: read(await triage(gateway, () => {}, Project, item.msg, item.recent))})} catch (error) {results.push({item, error: String(error)})}
    }
}))

type Judged = { item: typeof Messages[number], judged: Triage }
const judged = results.filter(result => result.judged !== undefined) as Judged[]
const pct = (n: number, of: number): string => of === 0 ? "-" : `${Math.round(100 * n / of)}%`
const first = <T>(label: T | T[]): T => [label].flat()[0] as T
const memberRight = ({item, judged}: Judged) => [item.member].flat().includes(judged.member)
const controlRight = ({item, judged}: Judged) => [item.control].flat().includes(judged.control)
console.log(`${Messages.length} messages (${Messages.filter(item => item.src === "observed").length} observed), ${results.length - judged.length} errors`)
results.filter(result => result.error !== undefined).slice(0, 3).forEach(result => console.log(`  error: ${result.error}`))

const table = <K extends string>(title: string, keys: readonly K[], label: (row: Judged) => K, got: (row: Judged) => K, right: (row: Judged) => boolean) => {
    console.log(`\n${title} (rows: label, columns: Jev)`)
    console.log(`  ${"".padEnd(15)}${keys.map(key => key.slice(0, 8).padStart(9)).join("")}`)
    keys.forEach(row => console.log(`  ${row.padEnd(15)}${keys.map(column =>
        String(judged.filter(result => label(result) === row && got(result) === column).length).padStart(9)).join("")}`))
    console.log(`  right: ${pct(judged.filter(right).length, judged.length)}`)
}
table("Member", Object.keys(Members) as Member[], row => first(row.item.member), row => row.judged.member, memberRight)
table("Control", Object.keys(Controls) as Control[], row => first(row.item.control), row => row.judged.control, controlRight)

// Where it would act: a direction handed to a member when Jev is sure enough, at each threshold.
console.log("\nHanded to a member by Jev at p >= threshold (the rest left to the Team Lead)")
for (const threshold of [0.5, 0.6, 0.7, 0.8, 0.9]) {
    const taken = judged.filter(result => result.judged.memberP >= threshold)
    console.log(`  ${threshold.toFixed(1)}: ${String(taken.length).padStart(3)} taken (${pct(taken.length, judged.length)}), ${taken.filter(result => !memberRight(result)).length} wrong`)
}
console.log("\nWrong member")
judged.filter(result => !memberRight(result)).forEach(({item, judged}) =>
    console.log(`  "${item.msg}": ${judged.member} ${judged.memberP.toFixed(2)} (want ${[item.member].flat().join("/")})`))
console.log("\nWrong control")
judged.filter(result => !controlRight(result)).forEach(({item, judged}) =>
    console.log(`  "${item.msg}": ${judged.control} ${judged.controlP.toFixed(2)} (want ${[item.control].flat().join("/")})`))
const ms = judged.map(result => result.judged.ms).sort((a, b) => a - b)
console.log(`\nJev's time: median ${ms[Math.floor(ms.length / 2)]} ms`)

const dir = join(Takedo, "knowledge", "bench", "results")
mkdirSync(dir, {recursive: true})
const file = join(dir, `members-${new Date().toISOString().replace(/[:.]/g, "-")}.json`)
writeFileSync(file, JSON.stringify(results, null, 1))
console.log(`\n${file}`)
