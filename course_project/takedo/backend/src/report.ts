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
    scenario: string, project: string, session?: string, sessions?: string[], started: string, clock?: { start: Tick, end?: Tick }, playing?: boolean, problems: string[]
    before?: Snapshot, after?: Snapshot
    controls?: Array<{ ref: string, label: string, value: number }>
    messages: Array<{ text: string, set?: { ref: string, value: number, ok: boolean }, control?: boolean, restartAfterMs?: number, restartReplies?: number, replyMs: number, settledMs: number, settled: boolean, replies: Line[] }>
}
type Tick = { t: number, played: number }
type Entry = Record<string, any> & { t: number, type: string }

const [runDir, sessionsDir = join(import.meta.dirname, "../../sessions")] = process.argv.slice(2)
if (runDir === undefined) {throw new Error("usage: node src/report.ts <run dir> [sessions dir]")}
const run: Run = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"))
// One backend session per connection: more than one when the backend was restarted during the run.
const sessions = run.sessions ?? (run.session === undefined ? [] : [run.session])
const sessionDirs = sessions.map(session => readdirSync(sessionsDir).find(name => name.endsWith(`_${session.slice(0, 8)}`)))
const sessionDir = sessionDirs[0]
// A line the backend was still writing (or two interleaved, or cut by a kill) is skipped and counted.
const unreadable: string[] = []
const logs: Entry[][] = sessionDirs.map(dir => dir === undefined || !existsSync(join(sessionsDir, dir, "log.jsonl")) ? []
    : readFileSync(join(sessionsDir, dir, "log.jsonl"), "utf8").trim().split("\n").flatMap(line => {
        try {return [JSON.parse(line)]} catch {unreadable.push(line.slice(0, 80)); return []}
    }))
const log: Entry[] = logs.flat()

const Names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
const scale = (key: Key): Set<number> => {
    const tonic = Names.indexOf(key.tonic)
    // Minor counts its raised 7th too (harmonic minor's leading tone, in the V chord: D# in B7 for E minor), which
    // minor-key progressions borrow as a matter of course; it was flagged as a clash in run after run (2026-11-23).
    const steps = key.mode === "major" ? [0, 2, 4, 5, 7, 9, 11] : [0, 2, 3, 5, 7, 8, 10, 11]
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
    `Project \`${run.project}\`, session${sessions.length > 1 ? "s" : ""} ${sessions.map(session => `\`${session}\``).join(", ") || "`none`"}${sessionDir === undefined ? " (no session log found)" : ""}.`)
if (unreadable.length > 0) {run.problems.push(`${unreadable.length} unreadable session log lines, skipped: ${unreadable.join(" | ")}`)}
if (run.problems.length > 0) {out.push("", "**Problems:**", ...run.problems.map(problem => `- ${problem}`))}

// ---------- the conversation ----------
out.push("", "## Conversation", "")
for (const message of run.messages) {
    out.push(message.set !== undefined ? `**Producer**, by hand: ${message.text}` : message.control === true ? `**Producer** moves a control: ${message.text}` : `**Producer:** ${message.text}`, "")
    if (message.restartAfterMs !== undefined) {out.push(`_(backend killed ${seconds(message.restartAfterMs)} after this message)_`, "")}
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
const failed = [...final.values()].filter(entry => entry.state === "failed" || (entry.state === "dropped" && entry.reason !== "cancelled"))
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
// A plan's bars in the order it means them: anchored in a loop (When's from), a bar inside the loop behind the anchor's
// bar is the next pass, so it counts a loop later.
const loopBars = run.before?.playback.loop.on === true
    ? [Number(run.before.playback.loop.from.split(".")[0]), Number(run.before.playback.loop.to.split(".")[0])] : null
const barPulses = run.before === undefined ? 3840 : 960 * 4 * run.before.timeline.signature[0] / run.before.timeline.signature[1]
const unrolled = (when: Entry): number => {
    if (loopBars === null || when.from === undefined) {return when.bar}
    const [from, to] = loopBars
    const anchorBar = Math.floor(when.from.position / barPulses) + 1
    return when.bar >= from && when.bar < to && when.bar < anchorBar ? when.bar + (to - from) : when.bar
}
// A ramp on an effect added in the same plan (add_effect's then) can't start before the effect is on: its bar counts as
// no earlier than the effect's.
const addedAt = new Map<string, number>()
statuses.forEach(entry => {
    const device = entry.result?.device?.ref
    const when = requests.find(request => request.id === entry.request)?.when
    if (entry.state === "applied" && typeof device === "string" && typeof when?.bar === "number") {addedAt.set(device, unrolled(when))}
})
const barOf = (entry: Entry): number => {
    const parent = [...addedAt].find(([device]) => typeof entry.plan.ref === "string" && entry.plan.ref.startsWith(`${device}.`))
    return parent === undefined ? unrolled(entry.when) : Math.max(unrolled(entry.when), parent[1])
}
const timed = requests.filter(entry => entry.when?.at === "bar" && landedAt.has(entry.id)).map((entry): Entry => ({...entry, when: {...entry.when, bar: barOf(entry)}}))
// Each worker's part goes out when it's planned, so parts aren't in lockstep: order is checked within a part (a job's
// steps), across all of a window's edits only when the job isn't known.
const jobOfStep = new Map(log.filter(entry => entry.type === "board" && entry.event === "staged" && entry.job !== undefined)
    .map(entry => [entry.id, entry.job]))
const jobOfRequest = new Map(log.filter(entry => entry.type === "board" && entry.event === "linked")
    .map(entry => [entry.request, jobOfStep.get(entry.step)]))
const samePart = (a: Entry, b: Entry): boolean => jobOfRequest.get(a.id) === jobOfRequest.get(b.id)
const outOfOrder = timed.flatMap((first, index) => timed.slice(index + 1).filter(second =>
    windowOf(first.t) === windowOf(second.t) && samePart(first, second) && first.when.bar !== second.when.bar &&
    Math.sign(second.when.bar - first.when.bar) !== Math.sign(landedAt.get(second.id)! - landedAt.get(first.id)!) &&
    Math.abs(landedAt.get(second.id)! - landedAt.get(first.id)!) > barMs / 2).map(second => [first, second]))
const models = log.filter(entry => entry.type === "model")
// costUsd is an agent session's running total: the largest per session (the SDK's, when logged; else per backend
// session), added up, per job (the captain's and the workers').
const agentCost = (job: string): number => {
    const most = new Map<string, number>()
    logs.forEach((entries, index) => entries.filter(entry => entry.type === "model" && entry.job === job).forEach(entry => {
        const key = entry.session ?? `backend-${index}`
        most.set(key, Math.max(most.get(key) ?? 0, entry.costUsd ?? 0))
    }))
    return [...most.values()].reduce((sum, cost) => sum + cost, 0)
}
const utilityCost = agentCost("utility"), captainCost = agentCost("captain")
const workerSessions = new Set(log.filter(entry => entry.type === "model" && entry.job === "utility").map(entry => entry.session)).size
const byJob = new Map<string, { calls: number, ms: number, out: number }>()
models.forEach(entry => {
    const job = byJob.get(entry.job) ?? {calls: 0, ms: 0, out: 0}
    byJob.set(entry.job, {calls: job.calls + 1, ms: job.ms + (entry.ms ?? 0), out: job.out + (entry.outputTokens ?? 0)})
})
out.push("## Edits", "",
    `${requests.length} requested, ${applied.length} applied, ${failed.length} not done, ${[...final.values()].filter(entry => entry.reason === "cancelled").length} cancelled; landed over ${times.length > 1 ? seconds(times[times.length - 1] - times[0]) : "0 s"}; at most ${bunched} in one bar.`, "",
    ...requests.map(entry => {
        const plan = entry.plan
        const what = plan.op === "script" ? plan.description ?? "script" : plan.op === "ramp" ? `${plan.ref} → ${plan.to} over ${plan.beats} beats`
            : plan.op === "add_effect" ? `${plan.device} on ${plan.track}` : `${plan.op} ${plan.ref ?? plan.track ?? ""}`
        const state = final.get(entry.id)?.reason === "cancelled" ? "cancelled" : final.get(entry.id)?.state ?? "no status"
        return `- ${String(entry.from).replace("agent:", "")}: ${what}${entry.when?.at === "bar" ? `, bar ${entry.when.bar}` : ""} (${state})`
    }), "",
    `Model calls: ${[...byJob].map(([job, {calls, ms, out}]) => `${job} ${calls} (${seconds(ms)}, ${out} tokens out)`).join(", ") || "none"}; agents $${(utilityCost + captainCost).toFixed(2)} (captain $${captainCost.toFixed(2)}, workers $${utilityCost.toFixed(2)} over ${workerSessions} session${workerSessions === 1 ? "" : "s"}).`)

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
        // A bass (every note below openDAW's C3, MIDI 60) may move within the bass range: going deeper isn't a change of
        // role (a lofi bass an octave lower flagged as one, 2026-11-23). It fails only by leaving that range: up to C3 or
        // more, or below a bass guitar's lowest string (MIDI 28, E0 in openDAW's naming). Other parts: within an octave.
        if (Math.max(...was.map(([, pitch]) => pitch)) < 60) {
            const [low, high] = [Math.min(...is.map(([, pitch]) => pitch)), Math.max(...is.map(([, pitch]) => pitch))]
            check(high < 60 && low >= 28, `${track.name}: still a bass, ${noteName(low)}–${noteName(high)} (was median ${noteName(from)}, now ${noteName(to)})`)
            continue
        }
        check(Math.abs(to - from) <= 12, `${track.name}: register ${noteName(from)} → ${noteName(to)} (median note)`)
    }
    const added = after.tracks.filter(track => !before.tracks.some(candidate => candidate.ref === track.ref))
    if (added.length > 0) {out.push(`- New tracks: ${added.map(track => `${track.name} (${track.device?.name ?? track.instrument ?? "?"})`).join(", ")}`)}
    check(failed.length === 0, `${failed.length} edits not done${failed.length > 0 ? `: ${failed.map(entry => entry.detail ?? entry.reason ?? entry.state).join("; ")}` : ""}`)
    out.push(`- At most ${bunched} edits landed in one bar`)
    const label = (entry: Entry): string => entry.plan.description ?? `${entry.plan.op} ${entry.plan.ref ?? entry.plan.device ?? ""}`.trim()
    check(outOfOrder.length === 0, `${outOfOrder.length} pairs of a part's steps landed in the opposite order to their bars` +
        `${outOfOrder.length > 0 ? `: ${outOfOrder.slice(0, 3).map(([first, second]) => `${label(first)} (bar ${first.when.bar}) / ${label(second)} (bar ${second.when.bar})`).join("; ")}` : ""}`)
    check(run.playing === true, `engine ${run.playing ? "still playing" : "stopped"} at the end`)
    // Pulses played against the clock, at the slower of the two tempos (960 a beat): a stall shows as too few.
    const {start, end} = run.clock ?? {start: undefined, end: undefined}
    if (start !== undefined && end !== undefined && end.t > start.t) {
        const expected = (end.t - start.t) / 60000 * Math.min(before.timeline.bpm, after.timeline.bpm) * 960
        const share = (end.played - start.played) / expected
        check(share >= 0.8, `playhead moved ${Math.round(share * 100)}% as far as the clock says it should (under 80%: the playhead fell behind, from a tempo near 0 or a stalled engine; the run's samples show which, and edits timed by bars bunch up)`)
    }
    // After a restart: the message picked back up, in the same agent conversation (the SDK's session, resumed).
    if (run.messages.some(message => message.restartAfterMs !== undefined)) {
        const agentSessions = log.filter(entry => entry.type === "agent_session")
        const ids = new Set(agentSessions.map(entry => entry.session).filter(id => typeof id === "string"))
        const recovered = agentSessions.filter(entry => entry.recover !== undefined)
        // Jobs the restart cut off (the captain's workers): handed out again afterwards.
        const jobsLost = log.find(entry => entry.type === "board" && entry.event === "jobs_lost")
        if (jobsLost !== undefined) {
            const again = log.filter(entry => entry.type === "board" && entry.event === "job" && entry.t > jobsLost.t)
            check(again.length > 0, `${jobsLost.jobs.length} jobs cut off by the restart; ${again.length} handed out after it`)
        }
        // Only when the kill cut a turn off (restart_replies 1: it came after the reply, nothing to pick up; or the
        // captain had already replied and only its workers were cut off).
        if (jobsLost === undefined && run.messages.some(message => message.restartAfterMs !== undefined && message.restartReplies !== 1)) check(recovered.some(entry => entry.recent === true), `${recovered.length > 0 ? `picked back up after the restart: "${recovered[0].recover}"` : "no message was picked back up after the restart"}`)
        // Timed edits waiting at the restart kept waiting and landed (the board, reconciled when the page reconnected).
        const reconciled = log.filter(entry => entry.type === "board" && entry.event === "reconciled" && (entry.coming.length > 0 || entry.lost.length > 0)).at(-1)
        if (reconciled !== undefined) {
            const requestOf = new Map(log.filter(entry => entry.type === "board" && entry.event === "linked").map(entry => [entry.step, entry.request]))
            const landed = (reconciled.coming as string[]).filter(step => final.get(requestOf.get(step))?.state === "applied")
            const gone = (reconciled.gone ?? []) as string[]
            check(landed.length === reconciled.coming.length && gone.length === 0,
                `after the restart: ${landed.length} of ${reconciled.coming.length} timed edits still waiting landed; ${gone.length} gone from the page; ${reconciled.lost.length - gone.length} staged and never sent (re-planned by the resumed turn)`)
        }
        check(agentSessions.some(entry => entry.resumed === true) && ids.size === 1,
            `one agent conversation across the restart (${ids.size} session${ids.size === 1 ? "" : "s"}${agentSessions.some(entry => entry.resumed === true) ? ", resumed" : ", none resumed"})`)
    }
    // Controls (when the scenario moves one): offered, and each move heard: a reply and edits after it.
    if (run.messages.some(message => message.control === true)) {
        const offered = log.filter(entry => entry.type === "controls").flatMap(entry => entry.controls as Array<{ ref: string, label: string, low: string, high: string }>)
        check(offered.length > 0, offered.length > 0
            ? `controls offered: ${[...new Map(offered.map(control => [control.ref, `"${control.label}" (${control.low} → ${control.high})`])).values()].join(", ")}`
            : "no control was offered")
        const moves = log.filter(entry => entry.type === "control")
        for (const move of moves) {
            // Its window ends at the producer's next message or move.
            const next = log.find(entry => entry.t > move.t && (entry.type === "control" || entry.type === "chat" && entry.from === "user"))?.t ?? Infinity
            const edits = requests.filter(entry => entry.t > move.t && entry.t < next).length
            const replied = log.some(entry => entry.t > move.t && entry.t < next && entry.type === "chat" && entry.from !== "user")
            check(replied && edits > 0, `moving ${move.ref} to ${move.value}: ${replied ? "a reply" : "no reply"} and ${edits} edits after it`)
        }
        if (run.controls !== undefined) {out.push(`- Controls at the end: ${run.controls.map(control => `${control.label} ${control.value}`).join(", ") || "none"}`)}
    }
    // The producer's own changes (set steps): kept at the end, within a dB or a few percent of where they put them.
    for (const {set} of run.messages) {
        if (set === undefined) {continue}
        const [track, , param] = set.ref.split(".")
        const now = track === "master" ? after.master.volume : (after.tracks.find(candidate => candidate.ref === track)?.mix as Record<string, number> | undefined)?.[param]
        const agentAfter = requests.filter(entry => entry.plan.ref === set.ref && entry.t > (log.find(other => other.type === "change" && other.actor === "user"
            && other.changes.some((change: { ref: string }) => change.ref === set.ref))?.t ?? Infinity))
        check(typeof now === "number" && Math.abs(now - set.value) <= Math.max(1, Math.abs(set.value) * 0.05),
            `the producer's ${set.ref} at ${set.value}: ${typeof now === "number" ? `${Math.round(now * 10) / 10} at the end` : "not found"}; ${agentAfter.length} agent edits on it after`)
    }
    // Cancels (the board): every step taken back was cancelled, none landed after.
    const cancels = log.filter(entry => entry.type === "board" && entry.event === "cancel")
    if (cancels.length > 0) {
        const steps = cancels.flatMap(entry => entry.steps as string[])
        const requestOf = new Map(log.filter(entry => entry.type === "board" && entry.event === "linked").map(entry => [entry.step, entry.request]))
        const landed = steps.filter(step => final.get(requestOf.get(step))?.state === "applied")
        if (steps.length > 0) {check(landed.length === 0, `cancelled ${steps.length} waiting steps${landed.length > 0 ? `, but ${landed.length} landed anyway` : ", none landed"}`)}
        // Cancelled jobs (pieces still being planned): nothing staged by them after the cancel.
        const jobs = cancels.flatMap(entry => (entry.jobs as string[] | undefined ?? []).map(job => ({job, t: entry.t as number})))
        if (jobs.length > 0) {
            const after = jobs.filter(({job, t}) => log.some(entry => entry.type === "board" && entry.event === "staged" && entry.job === job && entry.t > t))
            check(after.length === 0, `cancelled ${jobs.length} piece${jobs.length === 1 ? "" : "s"} still being planned (${jobs.map(({job}) => job).join(", ")})${after.length > 0 ? `, but ${after.length} staged after` : ", nothing staged after"}`)
        }
    }
    const long = run.messages.flatMap(message => message.replies).filter(line => sentences(line.text) > MaxReplySentences)
    check(long.length === 0, `${long.length} replies longer than ${MaxReplySentences} sentences`)
}

const report = out.join("\n") + "\n"
writeFileSync(join(runDir, "report.md"), report)
console.log(report)
