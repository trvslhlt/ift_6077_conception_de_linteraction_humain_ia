// A scenario run's report (`make scenario`): what the producer read, what changed in the project, and a few checks
// code can make, from the runner's run.json (test/scenario.mjs) and the backend's session log. Writes report.md beside
// run.json and prints it. Usage: node src/report.ts <run dir> [sessions dir]
import {existsSync, readdirSync, readFileSync, writeFileSync} from "node:fs"
import {join} from "node:path"
import type {Note, Snapshot, Track} from "../../shared/protocol.ts"
import {analyse, isDrums, type Key} from "./analysis.ts"
import {MaxReplySentences} from "./utility.ts"

type Line = { from: string, shown?: string, text: string }
type Run = {
    scenario: string, project: string, session?: string, started: string, playing?: boolean, problems: string[]
    before?: Snapshot, after?: Snapshot
    messages: Array<{ text: string, replyMs: number, settledMs: number, settled: boolean, replies: Line[] }>
}
type Entry = Record<string, any> & { t: number, type: string }

const [runDir, sessionsDir = join(import.meta.dirname, "../../sessions")] = process.argv.slice(2)
if (runDir === undefined) {throw new Error("usage: node src/report.ts <run dir> [sessions dir]")}
const run: Run = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"))
const sessionDir = run.session === undefined ? undefined
    : readdirSync(sessionsDir).find(name => name.endsWith(`_${run.session!.slice(0, 8)}`))
// A line the backend was still writing (or two interleaved) is skipped and counted.
const unreadable: string[] = []
const log: Entry[] = sessionDir === undefined || !existsSync(join(sessionsDir, sessionDir, "log.jsonl")) ? []
    : readFileSync(join(sessionsDir, sessionDir, "log.jsonl"), "utf8").trim().split("\n").flatMap(line => {
        try {return [JSON.parse(line)]} catch {unreadable.push(line.slice(0, 80)); return []}
    })

const Names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
const scale = (key: Key): Set<number> => {
    const tonic = Names.indexOf(key.tonic)
    const steps = key.mode === "major" ? [0, 2, 4, 5, 7, 9, 11] : [0, 2, 3, 5, 7, 8, 10]
    return new Set(steps.map(step => (tonic + step) % 12))
}
const notesOf = (track: Track): Note[] => track.regions.flatMap(region => region.notes ?? [])
const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
const noteName = (pitch: number): string => `${Names[pitch % 12]}${Math.floor(pitch / 12) - 2}`
const sentences = (text: string): number => text.split(/(?<=[.!?])\s+/).filter(part => part.trim() !== "").length
const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`

const out: string[] = []
const check = (ok: boolean, text: string): void => {out.push(`- ${ok ? "✅" : "❌"} ${text}`)}
out.push(`# ${run.scenario}: ${run.started}`, "",
    `Project \`${run.project}\`, session \`${run.session ?? "none"}\`${sessionDir === undefined ? " (no session log found)" : ""}.`)
if (unreadable.length > 0) {run.problems.push(`${unreadable.length} unreadable session log lines, skipped: ${unreadable.join(" | ")}`)}
if (run.problems.length > 0) {out.push("", "**Problems:**", ...run.problems.map(problem => `- ${problem}`))}

// ---------- the conversation ----------
out.push("", "## Conversation", "")
for (const message of run.messages) {
    out.push(`**Producer:** ${message.text}`, "")
    for (const line of message.replies) {
        const shown = (line.shown ?? line.from).replace(/^agent:/, "").replace(/_/g, " ")
        out.push(`**${shown}** (${sentences(line.text)} sentences): ${line.text}`, "")
    }
    out.push(`_${seconds(message.replyMs)} to reply, ${seconds(message.settledMs)} until its edits landed${message.settled ? "" : " (still landing when the runner moved on)"}._`, "")
}

// ---------- the edits ----------
const requests = log.filter(entry => entry.type === "request")
const statuses = log.filter(entry => entry.type === "status")
const final = new Map<string, Entry>()
statuses.forEach(entry => final.set(entry.request, entry))
const applied = statuses.filter(entry => entry.state === "applied")
const failed = [...final.values()].filter(entry => entry.state === "failed" || entry.state === "dropped")
// Edits landing together: the most applied in any window of one bar (at the tempo the run started at).
const barMs = run.before === undefined ? 2000 : 60000 / run.before.timeline.bpm * run.before.timeline.signature[0]
// When an edit starts to land: its first "running" (a ramp) or "applied" status; a ramp reports applied when it ends.
const startedAt = new Map<string, number>()
statuses.forEach(entry => {
    if ((entry.state === "running" || entry.state === "applied") && !startedAt.has(entry.request)) {startedAt.set(entry.request, entry.t)}
})
const times = applied.map(entry => startedAt.get(entry.request) ?? entry.t).sort((a, b) => a - b)
const bunched = times.reduce((most, t, index) => Math.max(most, times.slice(index).filter(other => other - t < barMs).length), 0)
// Steps of one message landing in the opposite order to their bars (the loop's trap): pairs, per producer message.
const messageTimes = log.filter(entry => entry.type === "chat" && entry.from === "user").map(entry => entry.t)
const windowOf = (t: number): number => messageTimes.filter(start => start <= t).length
const landedAt = new Map(applied.map(entry => [entry.request, startedAt.get(entry.request) ?? entry.t]))
const timed = requests.filter(entry => entry.when?.at === "bar" && landedAt.has(entry.id))
const outOfOrder = timed.flatMap((first, index) => timed.slice(index + 1).filter(second =>
    windowOf(first.t) === windowOf(second.t) && first.when.bar !== second.when.bar &&
    Math.sign(second.when.bar - first.when.bar) !== Math.sign(landedAt.get(second.id)! - landedAt.get(first.id)!) &&
    Math.abs(landedAt.get(second.id)! - landedAt.get(first.id)!) > barMs / 2).map(second => [first, second]))
const models = log.filter(entry => entry.type === "model")
const utilityCost = Math.max(0, ...models.filter(entry => entry.job === "utility").map(entry => entry.costUsd ?? 0))
const byJob = new Map<string, { calls: number, ms: number, out: number }>()
models.forEach(entry => {
    const job = byJob.get(entry.job) ?? {calls: 0, ms: 0, out: 0}
    byJob.set(entry.job, {calls: job.calls + 1, ms: job.ms + (entry.ms ?? 0), out: job.out + (entry.outputTokens ?? 0)})
})
out.push("## Edits", "",
    `${requests.length} requested, ${applied.length} applied, ${failed.length} not done; landed over ${times.length > 1 ? seconds(times[times.length - 1] - times[0]) : "0 s"}; at most ${bunched} in one bar.`, "",
    ...requests.map(entry => {
        const plan = entry.plan
        const what = plan.op === "script" ? plan.description ?? "script" : plan.op === "ramp" ? `${plan.ref} → ${plan.to} over ${plan.beats} beats`
            : plan.op === "add_effect" ? `${plan.device} on ${plan.track}` : `${plan.op} ${plan.ref ?? plan.track ?? ""}`
        const state = final.get(entry.id)?.state ?? "no status"
        return `- ${String(entry.from).replace("agent:", "")}: ${what}${entry.when?.at === "bar" ? `, bar ${entry.when.bar}` : ""} (${state})`
    }), "",
    `Model calls: ${[...byJob].map(([job, {calls, ms, out}]) => `${job} ${calls} (${seconds(ms)}, ${out} tokens out)`).join(", ") || "none"}; utility cost $${utilityCost.toFixed(2)}.`)

// ---------- the music ----------
out.push("", "## Checks", "")
const {before, after} = run
if (before === undefined || after === undefined) {
    out.push("No project snapshots: the run didn't finish.")
} else {
    const key = analyse(before).key
    const inKey = key === null ? null : scale(key)
    out.push(`Key before: ${key === null ? "unknown" : `${key.tonic} ${key.mode} (confidence ${key.confidence})`}; tempo ${before.timeline.bpm} → ${after.timeline.bpm} BPM.`, "")
    // New or rewritten pitched parts, against the starting key.
    const previous = new Map(before.tracks.map(track => [track.ref, JSON.stringify(notesOf(track))]))
    const changed = after.tracks.filter(track => !isDrums(track) && notesOf(track).length > 0 && previous.get(track.ref) !== JSON.stringify(notesOf(track)))
    if (inKey !== null) {
        for (const track of changed) {
            const notes = notesOf(track)
            const outside = notes.filter(([, pitch]) => !inKey.has(pitch % 12))
            const share = 1 - outside.length / notes.length
            // Strict: in a chord part one note out of key is a clash you hear on every pass.
            check(share >= 0.95, `${track.name}: ${Math.round(share * 100)}% of its ${notes.length} notes in ${key!.tonic} ${key!.mode}` +
                `${previous.has(track.ref) ? " (rewritten)" : " (new)"}` +
                `${outside.length > 0 ? `; outside it: ${[...new Set(outside.map(([pos, pitch]) => `${noteName(pitch)} at ${pos}`))].join(", ")}` : ""}`)
        }
        if (changed.length === 0) {out.push("- No pitched part was written or rewritten.")}
    }
    // Every starting part still there, heard, and in its register (a bass stays a bass).
    for (const track of before.tracks) {
        const now = after.tracks.find(candidate => candidate.ref === track.ref)
        if (now === undefined) {check(false, `${track.name}: removed`); continue}
        const [was, is] = [notesOf(track), notesOf(now)]
        if (now.mix.mute && !track.mix.mute) {check(false, `${track.name}: muted`); continue}
        if (was.length > 0 && is.length === 0) {check(false, `${track.name}: no notes left`); continue}
        if (isDrums(track) || was.length === 0) {check(true, `${track.name}: still playing`); continue}
        const [from, to] = [median(was.map(([, pitch]) => pitch)), median(is.map(([, pitch]) => pitch))]
        check(Math.abs(to - from) <= 12, `${track.name}: register ${noteName(from)} → ${noteName(to)} (median note)`)
    }
    const added = after.tracks.filter(track => !before.tracks.some(candidate => candidate.ref === track.ref))
    if (added.length > 0) {out.push(`- New tracks: ${added.map(track => `${track.name} (${track.device?.name ?? track.instrument ?? "?"})`).join(", ")}`)}
    check(failed.length === 0, `${failed.length} edits not done${failed.length > 0 ? `: ${failed.map(entry => entry.detail ?? entry.reason ?? entry.state).join("; ")}` : ""}`)
    check(bunched <= 3, `at most ${bunched} edits landed in one bar`)
    const label = (entry: Entry): string => entry.plan.description ?? `${entry.plan.op} ${entry.plan.ref ?? entry.plan.device ?? ""}`.trim()
    check(outOfOrder.length === 0, `${outOfOrder.length} pairs of steps landed in the opposite order to their bars` +
        `${outOfOrder.length > 0 ? `: ${outOfOrder.slice(0, 3).map(([first, second]) => `${label(first)} (bar ${first.when.bar}) / ${label(second)} (bar ${second.when.bar})`).join("; ")}` : ""}`)
    check(run.playing === true, `engine ${run.playing ? "still playing" : "stopped"} at the end`)
    const long = run.messages.flatMap(message => message.replies).filter(line => sentences(line.text) > MaxReplySentences)
    check(long.length === 0, `${long.length} replies longer than ${MaxReplySentences} sentences`)
}

const report = out.join("\n") + "\n"
writeFileSync(join(runDir, "report.md"), report)
console.log(report)
