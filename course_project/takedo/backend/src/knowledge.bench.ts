import {mkdirSync, writeFileSync} from "node:fs"
import {join} from "node:path"
import Anthropic from "@anthropic-ai/sdk"
import {choice, TypeSafeClient} from "@typesafe-ai/sdk"
import {loadCatalog} from "./catalog.ts"
import {loadConfig} from "./gateway.ts"
import {type IndexLine, loadKnowledge, shortlist} from "./knowledge.ts"

// Which producer messages the knowledge base serves (KNOWLEDGE.md, "Will it make TakeDo faster?"). The messages and
// their labels are in knowledge/bench/messages.mjs: observed (session logs), from jev_bench, and simulated.
//
//   node src/knowledge.bench.ts                  offline: labels check, coverage, shortlist recall (free)
//   node src/knowledge.bench.ts jev claude       also the pickers (cost money: Jev cents per picker, Claude ~$0.50)
//
// Pickers, each asked "which entry, applied now, does what this message asks, or none":
//   jev         Jev's choice over the shortlist's top Shortlist entries plus "none" (the fast route KNOWLEDGE.md plans)
//   jev-staged  stratified, two requests: first what kind of change the message asks for (a style, a sound, an effect,
//               drums, chords, or none of these), then a pick among that kind's entries only, shortlisted
//   jev-joint   the same two questions in one request (the pick over the plain shortlist); applied only when they agree
//   claude  the utility's model (config/models.json) given the compact index, as the utility sees it
// Results go to knowledge/bench/results/ (git-ignored).

const Takedo = join(import.meta.dirname, "..", "..")
const Shortlist = 12
const Confident = 0.7
const Concurrency = 4

const {Messages, Project} = await import(join(Takedo, "knowledge", "bench", "messages.mjs")) as {
    Messages: Array<{ msg: string, cat: string, want: string[], helps: string[], gap?: string, src: string }>,
    Project: Record<string, unknown>
}
const catalog = loadCatalog(join(Takedo, "catalog", "devices.json"), join(Takedo, "catalog", "generated.json"))
const knowledge = loadKnowledge(join(Takedo, "knowledge"), catalog)
const index = knowledge.index()
const keys = index.map(line => line.key)

const pickers = process.argv.slice(2)
const Pickers = ["jev", "jev-staged", "jev-joint", "claude"]
const unknown = pickers.filter(name => !Pickers.includes(name))
if (unknown.length > 0) {throw new Error(`unknown picker ${unknown.join(", ")}: ${Pickers.join(", ")}`)}

// ---------- labels ----------

const matches = (label: string, key: string): boolean =>
    label.endsWith("*") ? key.startsWith(label.slice(0, -1)) : key === label
const expand = (labels: string[]): string[] => keys.filter(key => labels.some(label => matches(label, key)))
const bad = Messages.flatMap(({msg, want, helps}) => [...want, ...helps]
    .filter(label => !keys.some(key => matches(label, key))).map(label => `"${msg}": ${label} matches no entry`))
if (bad.length > 0) {throw new Error(`labels that match no entry:\n${bad.join("\n")}`)}
const duplicates = Messages.map(({msg}) => msg).filter((msg, at, all) => all.indexOf(msg) !== at)
if (duplicates.length > 0) {throw new Error(`duplicate messages: ${duplicates.join(", ")}`)}

const cases = Messages.map(message => ({...message, wanted: expand(message.want), helpful: expand(message.helps)}))
type Case = typeof cases[number]

// ---------- report helpers ----------

const pct = (n: number, of: number): string => of === 0 ? "   -" : `${Math.round(100 * n / of)}%`.padStart(4)
const quantile = (values: number[], p: number): number => {
    const sorted = [...values].sort((a, b) => a - b)
    return sorted.length === 0 ? NaN : sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
}
const groupsOf = <T>(items: T[], by: (item: T) => string): Map<string, T[]> => {
    const groups = new Map<string, T[]>()
    items.forEach(item => groups.set(by(item), [...groups.get(by(item)) ?? [], item]))
    return groups
}
const table = (title: string, rows: string[][]): void => {
    const widths = rows[0].map((_, column) => Math.max(...rows.map(row => row[column].length)))
    console.log(`\n${title}`)
    rows.forEach(row => console.log(`  ${row.map((cell, column) => column === 0 ? cell.padEnd(widths[column]) : cell.padStart(widths[column])).join("  ")}`))
}

// ---------- coverage (offline) ----------

const listed = (item: Case) => shortlist(index, item.msg, Shortlist).map(({line}) => line.key)
const shortlists = new Map(cases.map(item => [item.msg, listed(item)]))
const recalled = (item: Case) => item.wanted.some(key => shortlists.get(item.msg)!.includes(key))

console.log(`${cases.length} messages (${[...groupsOf(cases, item => item.src)].map(([src, items]) => `${items.length} ${src}`).join(", ")}); `
    + `${knowledge.size} entries`)
const coverageRow = (name: string, items: Case[]): string[] => {
    const served = items.filter(item => item.wanted.length > 0)
    return [name, String(items.length), String(served.length), pct(served.length, items.length),
        String(items.filter(item => item.wanted.length === 0 && item.helpful.length > 0).length),
        String(items.filter(item => item.gap).length), `${served.filter(recalled).length}/${served.length}`]
}
const coverageHead = ["", "messages", "hits", "", "read only", "gaps", `shortlist@${Shortlist}`]
table("Coverage by category (hits: an entry should be applied; read only: no entry applies but some help)",
    [coverageHead, ...[...groupsOf(cases, item => item.cat)].map(([cat, items]) => coverageRow(cat, items)), coverageRow("all", cases)])
table("Coverage by source", [coverageHead, ...[...groupsOf(cases, item => item.src)].map(([src, items]) => coverageRow(src, items))])

const lost = cases.filter(item => item.wanted.length > 0 && !recalled(item))
if (lost.length > 0) {
    console.log(`\nShortlist misses (a hit whose entries aren't in the top ${Shortlist}; Jev would never see them):`)
    lost.forEach(item => console.log(`  "${item.msg}"  want ${item.want.join(", ")}\n      got ${shortlists.get(item.msg)!.slice(0, 4).join(", ") || "(nothing)"}`))
}
console.log("\nGaps (entries that would have served a message):")
cases.filter(item => item.gap).forEach(item => console.log(`  ${item.gap!.padEnd(40)} "${item.msg}"`))

// ---------- pickers ----------

type Pick = { apply: string | null, read?: string[], confidence?: number, ms: number, tokens?: Record<string, number>, error?: string,
    stratum?: string }
const grade = (item: Case, pick: Pick) => {
    if (pick.error !== undefined) {return "error"}
    if (item.wanted.length === 0) {return pick.apply === null ? "right none" : "false apply"}
    if (pick.apply === null) {return "missed"}
    return item.wanted.includes(pick.apply) ? "right apply" : "wrong apply"
}
const Outcomes = ["right apply", "right none", "wrong apply", "false apply", "missed", "error"] as const

const premise = "The producer sent `message` to their AI music team while working on `project`, during playback."

// ---------- stratified Jev ----------

// The kind of change a message asks for, and the entries that make each kind. Notes are never applied.
const Strata = {
    style: "A new genre or production style for the track as a whole (\"make it house\", \"more lofi\", \"funkier\")",
    sound: "A different instrument sound for a part, or a new part with a named sound (\"a rhodes\", \"add strings\")",
    effect: "A new effect or treatment on a part (reverb, echo, tremolo, telephone, tape, a room)",
    drums: "A different drum pattern, groove or fill",
    chords: "A different chord progression or harmony",
    other: "None of these: a level, mute, pan, tempo or arrangement change, adjusting something already there "
        + "(\"faster tremolo\", \"less crunchy\", \"darker keys\"), a question, feedback or chat"
}
type Stratum = keyof typeof Strata
// Jev only chooses among entries the backend can apply (KNOWLEDGE.md, "Interface for Jev").
const runnable = new Set(knowledge.get(keys).flatMap(entry => "missing" in entry || entry.apply === undefined ? [] : [entry.key]))
const Applicable = index.filter(line => runnable.has(line.key))
const stratumOf = new Map<string, Stratum | null>(knowledge.get(keys).flatMap(entry => "missing" in entry ? [] : [[entry.key,
    entry.kind === "genre" || entry.kind === "production" ? "style" : entry.kind === "sound" ? "sound" : entry.kind === "chain" ? "effect"
        : entry.kind === "pattern" ? (entry.pattern?.type === "drums" ? "drums" : "chords") : null] as [string, Stratum | null]]))
const optionsOf = (lines: IndexLine[]): Record<string, string> => ({
    ...Object.fromEntries(lines.map((line, at) => [`e${at + 1}`,
        `${line.key}: ${line.label ? `${line.label}; ` : ""}${line.summary} (${line.tags.join(", ")})`])),
    none: "None of these: no entry fits, or the message isn't asking for one (a level, tempo, arrangement or chat)"
})
const chosen = (lines: IndexLine[], answer: string): string | null => answer === "none" ? null : lines[Number(answer.slice(1)) - 1].key
// Within a stratum: the shortlist of its entries; if no word matches, its hand-written entries (no family), as defaults.
const stratumList = (stratum: Stratum, message: string): IndexLine[] => {
    const lines = Applicable.filter(line => stratumOf.get(line.key) === stratum)
    const listed = shortlist(lines, message, Shortlist).map(({line}) => line)
    return listed.length > 0 ? listed : lines.filter(line => line.group === undefined).slice(0, Shortlist)
}

const jevStaged = async (client: TypeSafeClient, item: Case): Promise<Pick> => {
    const start = performance.now()
    const first = await client.systemOne({state: {project: Project as never, message: item.msg},
        questions: {wants: choice(`${premise} What kind of change does the message ask for?`, Strata)}})
    const wants = first.answers.wants
    if (wants.choice === "other") {
        return {apply: null, confidence: wants.confidence, ms: performance.now() - start, stratum: "other", tokens: {input: first.usage.input_tokens ?? 0}}
    }
    const lines = stratumList(wants.choice as Stratum, item.msg)
    const second = await client.systemOne({state: {project: Project as never, message: item.msg},
        questions: {pick: choice(`${premise} It asks for: ${Strata[wants.choice as Stratum]}. Which of these entries, applied now, would do it?`, optionsOf(lines))}})
    const pick = second.answers.pick
    return {apply: chosen(lines, pick.choice), confidence: Math.min(wants.confidence, pick.confidence), ms: performance.now() - start,
        stratum: wants.choice, tokens: {input: (first.usage.input_tokens ?? 0) + (second.usage.input_tokens ?? 0)}}
}

const jevJoint = async (client: TypeSafeClient, item: Case): Promise<Pick> => {
    const lines = shortlist(Applicable, item.msg, Shortlist).map(({line}) => line)
    const start = performance.now()
    const result = await client.systemOne({state: {project: Project as never, message: item.msg}, questions: {
        wants: choice(`${premise} What kind of change does the message ask for?`, Strata),
        pick: choice(`${premise} Which knowledge-base entry, applied now, would do what the message asks?`, optionsOf(lines))
    }})
    const {wants, pick} = result.answers
    const key = chosen(lines, pick.choice)
    // A style can be served by its drums or chords alone ("a boom bap beat" is judged a style, then served by a pattern).
    const kind = key === null ? null : stratumOf.get(key)
    const agree = kind !== null && wants.choice !== "other"
        && (kind === wants.choice || (wants.choice === "style" && (kind === "drums" || kind === "chords")))
    return {apply: agree ? key : null, confidence: Math.min(wants.confidence, pick.confidence), ms: performance.now() - start,
        stratum: wants.choice, tokens: {input: result.usage.input_tokens ?? 0}}
}

const jevPick = async (client: TypeSafeClient, item: Case): Promise<Pick> => {
    const listed = shortlist(Applicable, item.msg, Shortlist).map(({line}) => line)
    const options: Record<string, string> = Object.fromEntries(listed.map((line, at) => [`e${at + 1}`,
        `${line.key}: ${line.label ? `${line.label}; ` : ""}${line.summary} (${line.tags.join(", ")})`]))
    options.none = "None of these: no entry fits, or the message isn't asking for one (a level, tempo, arrangement or chat)"
    const start = performance.now()
    const result = await client.systemOne({
        state: {project: Project as never, message: item.msg},
        questions: {pick: choice(`${premise} Which knowledge-base entry, applied now, would do what the message asks?`, options)}
    })
    const answer = result.answers.pick
    const at = answer.choice === "none" ? -1 : Number(answer.choice.slice(1)) - 1
    return {apply: at < 0 ? null : listed[at].key, confidence: answer.confidence, ms: performance.now() - start,
        tokens: {input: result.usage.input_tokens ?? 0}}
}

const claudeSystem = (lines: string[]): string => [
    "You are part of an AI music team working in openDAW while the producer listens. A knowledge base holds entries:",
    "sounds, effect chains, drum and chord patterns, genre and production-style write-ups, and notes. Many can be applied",
    "directly (a backend runs them); applying a fitting entry is much faster than building the change by hand.",
    "",
    "Given the producer's message, say which one entry you would apply now to do what it asks, or null when none fits or",
    "the message doesn't call for one (levels, tempo, arrangement, questions and chat are done without entries). Also",
    "list the entries you'd read first (at most 4), or none. Give full keys: a family line `pattern/gmd-funk-* = beat-1, fill`",
    "means the keys pattern/gmd-funk-beat-1 and pattern/gmd-funk-fill.",
    "",
    `The project: ${JSON.stringify(Project)}`,
    "",
    "The knowledge base index:",
    ...lines
].join("\n")

const claudePick = async (client: Anthropic, model: string, effort: string | undefined, system: string, item: Case): Promise<Pick> => {
    const start = performance.now()
    const response = await client.messages.create({
        model, max_tokens: 4000,
        system: [{type: "text", text: system, cache_control: {type: "ephemeral"}}],
        messages: [{role: "user", content: `The producer's message: ${JSON.stringify(item.msg)}`}],
        output_config: {...(effort ? {effort: effort as "medium"} : {}), format: {type: "json_schema", schema: {
            type: "object", additionalProperties: false, required: ["apply", "read"],
            properties: {apply: {type: ["string", "null"]}, read: {type: "array", items: {type: "string"}}}
        }}}
    })
    const text = response.content.flatMap(block => block.type === "text" ? [block.text] : []).join("")
    const {apply, read} = JSON.parse(text) as { apply: string | null, read: string[] }
    const usage = response.usage
    return {apply, read, ms: performance.now() - start, tokens: {input: usage.input_tokens, output: usage.output_tokens,
        cacheRead: usage.cache_read_input_tokens ?? 0, cacheWrite: usage.cache_creation_input_tokens ?? 0}}
}

const run = async (pick: (item: Case) => Promise<Pick>, parallel: number) => {
    const picks = new Map<string, Pick>()
    const queue = [...cases]
    const worker = async () => {
        for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
            const start = performance.now()
            try {picks.set(item.msg, await pick(item))} catch (error) {
                picks.set(item.msg, {apply: null, ms: performance.now() - start, error: String(error)})
                if (/40[13]/.test(String(error))) {throw error}
            }
        }
    }
    await Promise.all(Array.from({length: parallel}, worker))
    return cases.map(item => ({item, pick: picks.get(item.msg)!, outcome: grade(item, picks.get(item.msg)!)}))
}

const results: Record<string, unknown> = {
    date: new Date().toISOString(), entries: knowledge.size, shortlist: Shortlist,
    cases: cases.map(item => ({...item, shortlist: shortlists.get(item.msg)}))
}
for (const name of pickers) {
    let rows: Awaited<ReturnType<typeof run>>
    let model = ""
    if (name.startsWith("jev")) {
        if (!process.env.TYPESAFE_API_KEY) {throw new Error("TYPESAFE_API_KEY is not set (takedo/.env)")}
        const client = new TypeSafeClient()
        model = "jev (TypeSafe default)"
        const picker = name === "jev-staged" ? jevStaged : name === "jev-joint" ? jevJoint : jevPick
        rows = await run(item => picker(client, item), 1)
    } else {
        if (!process.env.ANTHROPIC_API_KEY) {throw new Error("ANTHROPIC_API_KEY is not set (takedo/.env)")}
        const config = loadConfig(join(Takedo, "config", "models.json")).jobs.utility
        if (config.provider !== "anthropic") {throw new Error("the utility isn't an Anthropic job")}
        model = process.env.BENCH_MODEL ?? config.model
        const effort = process.env.BENCH_EFFORT ?? config.effort
        const client = new Anthropic()
        const system = claudeSystem(knowledge.compact(index))
        const first = cases[0]   // one call first, so the index is cached before the others start
        const warm = await claudePick(client, model, effort, system, first)
        rows = await run(item => item === first ? Promise.resolve(warm) : claudePick(client, model, effort, system, item), Concurrency)
        model = `${model}${effort ? `, effort ${effort}` : ""}`
    }

    console.log(`\n== ${name}: ${model}`)
    const outcomeRow = (label: string, items: typeof rows): string[] => [label, String(items.length),
        ...Outcomes.map(outcome => String(items.filter(row => row.outcome === outcome).length)),
        pct(items.filter(row => row.outcome.startsWith("right")).length, items.length)]
    table("Outcomes by category", [["", "n", ...Outcomes, "right"],
        ...[...groupsOf(rows, row => row.item.cat)].map(([cat, items]) => outcomeRow(cat, items)), outcomeRow("all", rows)])
    const hits = rows.filter(row => row.item.wanted.length > 0)
    const sure = rows.filter(row => (row.pick.confidence ?? 1) >= Confident && row.pick.apply !== null)
    const ms = rows.filter(row => !row.pick.error).map(row => row.pick.ms)
    console.log(`\n  hits picked right: ${hits.filter(row => row.outcome === "right apply").length}/${hits.length}; `
        + `applies that were wrong or unwanted: ${rows.filter(row => ["wrong apply", "false apply"].includes(row.outcome)).length}`
        + (name.startsWith("jev") ? `; confident applies (≥ ${Confident}) right: ${sure.filter(row => row.outcome === "right apply").length}/${sure.length}` : "")
        + `\n  latency p50 ${Math.round(quantile(ms, 0.5))} ms, p90 ${Math.round(quantile(ms, 0.9))} ms`)
    if (name === "jev-staged" || name === "jev-joint") {
        // The stratum a message's labels imply: the wanted entries' (when they agree), else other.
        const expected = (item: Case): string => {
            const found = new Set(item.wanted.map(key => stratumOf.get(key) ?? "other"))
            return item.wanted.length === 0 ? "other" : found.size === 1 ? [...found][0] : "mixed"
        }
        const judged = rows.filter(row => !row.pick.error && expected(row.item) !== "mixed")
        console.log(`  kind of change right: ${judged.filter(row => row.pick.stratum === expected(row.item)).length}/${judged.length}`
            + ` (messages whose wanted entries span kinds left out)`)
    }
    if (name === "claude") {
        const read = hits.filter(row => (row.pick.read ?? []).some(key => [...row.item.wanted, ...row.item.helpful].includes(key)) || row.outcome === "right apply")
        const sum = (field: string) => rows.reduce((total, row) => total + (row.pick.tokens?.[field] ?? 0), 0)
        console.log(`  hits where it applied or read a labelled entry: ${read.length}/${hits.length}`
            + `\n  tokens: input ${sum("input")}, cache read ${sum("cacheRead")}, cache write ${sum("cacheWrite")}, output ${sum("output")}`)
        const invalid = rows.filter(row => row.pick.apply !== null && !keys.includes(row.pick.apply))
        if (invalid.length > 0) {console.log(`  keys that don't exist: ${invalid.map(row => row.pick.apply).join(", ")}`)}
    }
    const wrong = rows.filter(row => !row.outcome.startsWith("right"))
    if (wrong.length > 0) {
        console.log("\n  Not right:")
        wrong.forEach(({item, pick, outcome}) => console.log(`    ${outcome.padEnd(11)} "${item.msg}"  → ${pick.stratum ? `[${pick.stratum}] ` : ""}${pick.error ?? pick.apply ?? "none"}`
            + `${pick.confidence !== undefined ? ` (${pick.confidence.toFixed(2)})` : ""}${item.want.length > 0 ? `  want ${item.want.join(", ")}` : ""}`))
    }
    results[name] = {model, rows: rows.map(({item, pick, outcome}) => ({msg: item.msg, outcome, ...pick}))}
}

const out = join(Takedo, "knowledge", "bench", "results")
mkdirSync(out, {recursive: true})
const file = join(out, `${new Date().toISOString().replace(/[:.]/g, "-")}${pickers.length ? `-${pickers.join("-")}` : ""}.json`)
writeFileSync(file, `${JSON.stringify(results, null, 2)}\n`)
console.log(`\nwrote ${file}`)
