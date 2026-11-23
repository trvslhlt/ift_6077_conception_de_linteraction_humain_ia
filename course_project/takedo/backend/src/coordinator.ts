import {randomUUID} from "node:crypto"
import {
    type Actor, type Apply, type BackendToPage, type ChangeEvent, type Control, type Detail, type MemberCard, type PageToBackend,
    type Plan, type Snapshot, type Status, target, type When
} from "../../shared/protocol.ts"
import type {Catalog} from "./catalog.ts"
import type {Gateway, ModelLog} from "./gateway.ts"
import {createTeam, type Member, type Task} from "./members.ts"
import type {LogType, SessionLog} from "./sessionLog.ts"
import type {PartRole} from "./router.ts"
import {writeOverview} from "./teamLead.ts"
import {Notebook} from "./notebook.ts"
import {type Anchor, Board, type Direction} from "./board.ts"
import {Captain} from "./captain.ts"
import type {LlmMember} from "./members.ts"
import {analyse, isDrums} from "./analysis.ts"
import type {Knowledge} from "./knowledge.ts"
import {Utility} from "./utility.ts"

// The backend half of the bus (TAKEDO_API.md, "Overview"), one per connected page: claims, plans, chat, routing.
// Talks to the page's adapter for state (snapshot queries) and to apply plans.

const ClaimMs = 30000
const HistoryLines = 12
// Who's in play. "utility" (the default; the name is older than what it now runs): the captain takes every message
// and hands pieces to workers, the utility in a fresh session per piece, running in parallel (ARCHITECTURE.md, "The
// team's structure", 2026-11-22); "team": the older full team (Jev routing, the one-off Team Lead split, specialists
// handing leftovers to one long-lived utility session), kept until it's retired (step 3).
// Controls a member may have on its card at once (INTERACTION.md: one intent control each; a few while it's tried out).
export const MaxControls = 3
// A control's position in words, for its owner: where it sits between its two ends.
export const placed = (control: Control): string => {
    const {value, low, high} = control
    const where = value <= 0.05 ? `all the way to "${low}"` : value < 0.35 ? `toward "${low}"` : value <= 0.65 ? `in the middle`
        : value < 0.95 ? `toward "${high}"` : `all the way to "${high}"`
    return `${value.toFixed(2)}, ${where} (0 is "${low}", 1 is "${high}")`
}
const Terminal: ReadonlyArray<Status["state"]> = ["applied", "dropped", "failed"]

export class Coordinator {
    readonly #send: (message: BackendToPage) => void
    readonly #gateway: Gateway
    readonly #catalog: Catalog
    readonly #log: SessionLog
    // count: the holder's claims on it not yet released (an agent's scripts share "project.script": the first to land
    // mustn't free it for the others still waiting).
    readonly #claims = new Map<string, { holder: Actor, until: number, count: number }>()
    readonly #queries = new Map<number, (snapshot: Snapshot | null) => void>()
    readonly #requests = new Map<string, (status: Status) => void>()
    readonly #looks = new Map<number, (result: { ok: boolean, value: string }) => void>()
    readonly #members: ReadonlyArray<Member>
    readonly #team: ReadonlyArray<LlmMember>
    readonly #source: string
    readonly #captain: Captain
    // Job reports not yet told to the captain, and whether a turn to tell it is queued (several are told together).
    readonly #reports: Array<{ kind: "job_finished" | "job_failed" | "job_failed_later", text: string, direction?: Direction }> = []
    #reporting = false
    readonly #knowledge: Knowledge | null
    readonly #history: Array<{ from: string, text: string }> = []   // the chat so far, for messages that refer back
    #nextQuery = 0
    #project: string | null = null
    readonly #notebooks: string
    #notebook: Notebook | null = null       // the open project's
    #startKept = false                      // whether this session has kept the project's starting state
    #viewOpen = false
    #overview: "none" | "writing" | "done" = "none"   // for the open project; written once, refreshed on request
    #overviewLines: ReadonlyArray<{ label: string, text: string }> | null = null
    // Controls moved since their owner last heard; whether a turn to tell it is already queued (only the latest
    // position counts, so moves made while it works are told together).
    readonly #moved = new Map<string, number>()
    // The producer's own changes in openDAW (value changes, a gesture folded into one), in order, for the agents
    // (ARCHITECTURE.md, issue 1); cleared when another project opens.
    readonly #handChanges: Array<{ t: number, pos: string, ref: string, label: string, from: number, to: number }> = []
    // The team's shared state as data (board.ts); cleared when another project opens.
    readonly board: Board
    #steering = false

    // notebooks: the folder of agents' notebooks, one per project; source: the root of openDAW's source tree, for the
    // utility to read; knowledge: the knowledge base shared across projects (knowledge.ts), if it loaded.
    constructor(send: (message: BackendToPage) => void, gateway: Gateway, catalog: Catalog, log: SessionLog,
                notebooks: string, source: string, knowledge: Knowledge | null = null) {
        this.#send = send
        this.#gateway = gateway
        this.#catalog = catalog
        this.#log = log
        this.#notebooks = notebooks
        this.board = new Board(data => this.#log.write("board", data))
        const team = createTeam(catalog)
        this.#knowledge = knowledge
        const utility = new Utility(team, catalog, source, knowledge)
        // The utility as the agent workers act as: it holds what they may do (may) and borrows the members' fixed
        // operations; the members themselves aren't agents any more (the ROSTER=team path, retired 2026-11-23).
        this.#members = [utility]
        this.#team = team
        this.#source = source
        this.#captain = new Captain(source)
    }

    get gateway(): Gateway {return this.#gateway}

    // The page went away: end the utility's agent session.
    close(): void {
        this.#members.forEach(member => {if (member instanceof Utility) {member.close()}})
        this.#captain.close()
    }

    // The open project's notebook (notebook.ts); null with no project open.
    get notebook(): Notebook | null {return this.#notebook}

    // Tells the page who's on the team (the Team Lead first), for mentions and autocomplete. The utility isn't shown:
    // the producer sees its work as the Team Lead's (an alias; it keeps its own claims, attribution and log lines).
    start(): void {
        // The Team Lead is the captain itself; the workers show as the utility, in the activity.
        this.#send({type: "team", aliases: {}, members: [{role: "team_lead", name: "Team lead", area: "does what you ask in openDAW"}]})
    }

    receive(message: PageToBackend): void {
        switch (message.type) {
            case "project": {
                const name = message.open ? (message.name ?? "untitled") : null
                // The utility's session belongs to a project (its notebook says which); another project, another.
                if (name !== this.#project) {this.close()}
                this.#project = name
                this.#notebook = this.#project === null ? null : new Notebook(this.#notebooks, this.#project)
                this.board.open(this.#notebook?.boardFile ?? null)
                this.#handChanges.length = 0
                this.#startKept = false
                this.#overview = "none"
                this.#overviewLines = null
                this.#log.write("project", {open: message.open, name: message.name})
                this.#moved.clear()
                this.#sendControls()
                this.#maybeOverview()
                // A message the backend was restarted in the middle of, picked back up.
                if (this.#notebook !== null) {
                    this.#captain.recover(this).catch(error => this.say("agent:team_lead", `Something went wrong: ${String(error)}`))
                }
                return
            }
            case "view":
                this.#viewOpen = message.open
                this.#log.write("view", {open: message.open})
                this.#maybeOverview()
                return
            case "overview":
                if (this.#overview !== "writing") {this.#writeOverview()}
                return
            case "chat":
                this.#chat(message.text).catch(error => {
                    this.say("agent:team_lead", `Something went wrong: ${String(error)}`)
                })
                return
            case "control":
                this.#control(message.ref, message.value)
                return
            case "waiting": {
                const {coming, lost} = this.board.reconcile(message.requests)
                // Workers' sessions don't outlive the backend: a job still running was cut off.
                this.#captain.reconciled(coming, lost, this.board.loseRunning())
                return
            }
            case "result":
                this.#queries.get(message.id)?.(message.snapshot)
                this.#queries.delete(message.id)
                return
            case "status":
                this.#log.write("status", message.status)
                this.board.status(message.status)
                this.#requests.get(message.status.request)?.(message.status)
                if (Terminal.includes(message.status.state)) {this.#requests.delete(message.status.request)}
                return
            case "change":
                this.#change(message.event)
                return
            case "looked":
                this.#looks.get(message.id)?.({ok: message.ok, value: message.value})
                this.#looks.delete(message.id)
                return
            case "engine": {
                this.#log.write("engine", {undone: message.undone})
                const text = message.undone === null
                    ? "The audio engine crashed and is restarting. No recent change of ours was the latest, so nothing was undone."
                    : `The audio engine crashed and is restarting. I undid my last change ("${message.undone}"), the likely cause.`
                this.say("agent:team_lead", text)
                this.#captain.notice(text)
                return
            }
        }
    }

    // ---------- for members ----------

    snapshot(detail: Detail = "outline"): Promise<Snapshot | null> {
        const id = ++this.#nextQuery
        return new Promise(resolve => {
            this.#queries.set(id, snapshot => {
                if (snapshot !== null) {this.#log.seen(snapshot.at.seq)}
                resolve(snapshot)
            })
            this.#send({type: "query", id, query: "snapshot", detail})
        })
    }

    // Runs read-only JavaScript in the page (the open path's look); resolves with its JSON result or its error.
    look(agent: Actor, code: string): Promise<{ ok: boolean, value: string }> {
        const id = ++this.#nextQuery
        this.#log.write("look", {agent, code})
        return new Promise(resolve => {
            this.#looks.set(id, result => {
                this.#log.write("look", {agent, ok: result.ok, value: result.value.slice(0, 500)})
                resolve(result)
            })
            this.#send({type: "look", id, code})
        })
    }

    // Claims are locks (TAKEDO_API.md, "Team"): granted one at a time; the first wins, others get the holder.
    claim(agent: Actor, refs: ReadonlyArray<string>, reason: string): { ok: true } | { ok: false, holder: Actor } {
        const now = Date.now()
        for (const ref of refs) {
            const claim = this.#claims.get(ref)
            if (claim !== undefined && claim.until > now && claim.holder !== agent) {return {ok: false, holder: claim.holder}}
        }
        refs.forEach(ref => {
            const held = this.#claims.get(ref)
            const count = held !== undefined && held.holder === agent && held.until > now ? held.count + 1 : 1
            this.#claims.set(ref, {holder: agent, until: now + ClaimMs, count})
        })
        this.#log.write("claim", {agent, refs, reason, until: now + ClaimMs})
        return {ok: true}
    }

    release(agent: Actor, refs: ReadonlyArray<string>): void {
        refs.forEach(ref => {
            const held = this.#claims.get(ref)
            if (held?.holder !== agent) {return}
            if (held.count > 1) {this.#claims.set(ref, {...held, count: held.count - 1})} else {this.#claims.delete(ref)}
        })
        this.#log.write("claim", {agent, refs, released: true})
    }

    // Sends a plan to the adapter; resolves with its terminal status. Requires the plan to be in the agent's area
    // (TAKEDO_API.md, "Team") and the agent's claim on its target.
    // step: the board's step it carries out, if any (board.ts), linked to the request.
    request(agent: Actor, plan: Plan, when: When, seq: number, reason: string,
            onStatus: (status: Status) => void = () => {}, step?: string): Promise<Status> {
        const id = randomUUID()
        if (step !== undefined) {this.board.link(step, id)}
        if (this.#members.find(member => member.agent === agent)?.may(plan) !== true) {
            const status: Status = {request: id, t: Date.now(), pos: "", state: "failed", reason: "not_allowed",
                detail: `${plan.op} on ${target(plan)} is outside ${agent}'s area`}
            this.#log.write("status", status)
            return Promise.resolve(status)
        }
        const claim = this.#claims.get(target(plan))
        if (claim === undefined || claim.holder !== agent || claim.until <= Date.now()) {
            const status: Status = {request: id, t: Date.now(), pos: "", state: "failed", reason: "conflict",
                detail: claim === undefined ? "not claimed" : `held by ${claim.holder}`}
            this.#log.write("status", status)
            return Promise.resolve(status)
        }
        const request: Apply = {id, from: agent, plan, when, seq, reason}
        return this.#keepStart().then(() => new Promise<Status>(resolve => {
            this.#log.write("request", request)
            this.#requests.set(id, status => {
                onStatus(status)
                if (Terminal.includes(status.state)) {resolve(status)}
            })
            this.#send({type: "apply", request})
        }))
    }

    // The project's facts, in the notebook the first time a message needs them (notebook.ts): the
    // key and each part's register from the notes as they stand (analysis.ts), tempo and meter, and the overview once
    // written. Listed with every message, so no task guesses them. Recorded once, so the agents' own notes can't shift
    // the key; an entry an agent rewrote (it has no recorded_by) is left alone.
    async #keepFacts(): Promise<void> {
        const notebook = this.#notebook
        if (notebook === null || notebook.get("facts") !== null) {return}
        const snapshot = await this.snapshot("full")
        if (snapshot === null) {return}
        const {key, parts} = analyse(snapshot)
        const described = snapshot.tracks.map(track => {
            const part = parts[track.ref]
            if (part === undefined) {return `${track.name} (${track.ref}): no notes`}
            if (isDrums(track)) {return `${track.name} (${track.ref}): drums`}
            const pitches = track.regions.flatMap(region => region.notes ?? []).map(([, pitch]) => pitch)
            const low = Math.max(...pitches) < 60   // nothing above openDAW's C3 (MIDI 60)
            return `${track.name} (${track.ref}): ${part.register?.low}–${part.register?.high}${low ? ", the bass register" : ""}`
        })
        // Each part's role, for code that picks parts (the knowledge route): from the notes, as described above.
        const roles: Record<string, PartRole> = Object.fromEntries(snapshot.tracks.map(track => {
            const pitches = track.regions.flatMap(region => region.notes ?? []).map(([, pitch]) => pitch)
            return [track.ref, pitches.length === 0 ? "empty" : isDrums(track) ? "drums" : Math.max(...pitches) < 60 ? "bass" : "pitched"]
        }))
        const keyText = key === null ? "unknown (too few notes)" : `${key.tonic} ${key.mode}`
        const value = {recorded_by: "takedo", from: "the project as it was when the agents first worked on it",
            key: key === null ? null : {...key, said: keyText}, tempo: snapshot.timeline.bpm,
            meter: snapshot.timeline.signature.join("/"), parts: described, roles, overview: this.#overviewLines}
        notebook.set("facts", "state", `Key ${keyText}${key === null ? "" : " (from the notes)"}; ${snapshot.timeline.bpm} BPM, ` +
            `${value.meter}; ${described.join("; ")}. Use these; if the producer says otherwise, rewrite this entry.`, JSON.stringify(value))
    }

    // The overview's lines join the facts recorded by code (not an entry an agent rewrote).
    #factsOverview(lines: ReadonlyArray<{ label: string, text: string }>): void {
        this.#overviewLines = lines
        const entry = this.#notebook?.get("facts") ?? null
        if (entry === null) {return}
        const value = JSON.parse(entry.value)
        if (value.recorded_by !== "takedo") {return}
        this.#notebook!.set("facts", entry.kind, entry.summary, JSON.stringify({...value, overview: lines}))
    }

    // Before the agents' first edit in a session: the whole project, notes included, as it was, in the notebook.
    async #keepStart(): Promise<void> {
        const notebook = this.#notebook
        if (this.#startKept || notebook === null) {return}
        this.#startKept = true
        const snapshot = await this.snapshot("full")
        if (snapshot === null) {return}
        notebook.set("start", "state", `The whole project before the agents' first edit this session (${new Date().toISOString()}): ` +
            `${snapshot.tracks.length} tracks at ${snapshot.timeline.bpm} BPM. A snapshot, notes included.`, JSON.stringify(snapshot))
    }

    say(agent: Actor, text: string): void {
        const line = {id: randomUUID(), t: Date.now(), from: agent, to: "user" as Actor, text}
        this.#remember(agent, text)
        this.#log.write("chat", line)
        this.#send({type: "chat", line})
    }

    // A member's word for the producer (INTERACTION.md, "Who speaks in the chat"). The producer talks with the Team
    // Lead: a member speaks for itself only when the producer addressed it (@member). Otherwise a problem is passed on
    // by the Team Lead, and so is the result of a message Jev routed to this member alone (it's the only answer the
    // producer gets); a piece of a direction the Team Lead split stays in the member's card and the activity.
    report(agent: Actor, task: Task, text: string, problem: boolean): void {
        if (task.direct === true) {return this.say(agent, text)}
        if (problem || task.piece === null) {return this.say("agent:team_lead", text)}
        this.#log.write("unsaid", {agent, text})
    }

    card(card: MemberCard): void {
        this.#log.write("card", card)
        this.#send({type: "card", card})
    }

    // A line in the session log, for members' own events.
    event(type: LogType, data: object): void {this.#log.write(type, data)}

    modelLog(): ModelLog {return entry => this.#log.write("model", entry)}

    // Agents' lines as the producer sees them (the utility as the Team Lead).
    #remember(from: Actor, text: string): void {
        this.#history.push({from: from === "agent:utility" ? "team_lead" : from.replace("agent:", ""), text})
        this.#history.splice(0, this.#history.length - HistoryLines)
    }

    // Takes back steps that haven't landed (board.ts, Board.cancel), on the page too.
    cancel(ids: ReadonlyArray<string> | "all"): string {
        const {cancelled, requests, missed, jobs} = this.board.cancel(ids)
        requests.forEach(request => this.#send({type: "cancel", request}))
        const stopped = jobs.length > 0 ? ` Stopped ${jobs.map(job => job.id).join(", ")}: nothing more of ${jobs.length > 1 ? "theirs" : "its"} will be staged.` : ""
        if (cancelled.length === 0) {return `${stopped === "" ? "Nothing cancelled" : stopped.trim()}${missed.length > 0 ? ` Not found, or landed already: ${missed.join(", ")}.` : stopped === "" ? ": nothing is waiting." : ""}`}
        return `Cancelled ${cancelled.length}: ${cancelled.map(step => `${step.says} (bar ${step.bar})`).join("; ")}.${stopped}` +
            `${missed.length > 0 ? ` Not found (or landed already): ${missed.join(", ")}.` : ""} What has landed stays.`
    }

    // ---------- controls ----------

    // The open project's controls, kept in the notebook ("controls"), so they outlast a restart and their owner sees
    // each one's position with every message (the entry's summary).
    controls(): Control[] {
        const entry = this.#notebook?.get("controls") ?? null
        if (entry === null) {return []}
        try {return JSON.parse(entry.value) as Control[]} catch {return []}
    }

    #setControls(controls: ReadonlyArray<Control>): void {
        const notebook = this.#notebook
        if (notebook === null) {return}
        if (controls.length === 0) {notebook.delete("controls")} else {
            notebook.set("controls", "state", `Dials on your card, as the producer has them now: ${controls.map(control =>
                `"${control.label}" (${control.ref}) at ${placed(control)}: ${control.meaning}`).join("; ")}.`, JSON.stringify(controls))
        }
        this.#log.write("controls", {controls})
        this.#sendControls()
    }

    #sendControls(): void {this.#send({type: "controls", controls: this.controls()})}

    // A member puts a dial on its card, or changes one it has (same ref: the producer's position is kept).
    offerControl(owner: Actor, offered: Omit<Control, "owner" | "kind" | "widget">): string {
        if (this.#notebook === null) {return "Not offered: no project is open."}
        const controls = this.controls()
        const existing = controls.find(control => control.ref === offered.ref)
        if (existing !== undefined && existing.owner !== owner) {return `Not offered: ${offered.ref} is ${existing.owner}'s.`}
        if (existing === undefined && controls.filter(control => control.owner === owner).length >= MaxControls) {
            return `Not offered: you have ${MaxControls} controls already; remove one that no longer applies first.`
        }
        const control: Control = {...offered, owner, kind: "intent", widget: "dial",
            value: existing?.value ?? Math.min(1, Math.max(0, offered.value))}
        this.#setControls(existing === undefined ? [...controls, control]
            : controls.map(candidate => candidate.ref === control.ref ? control : candidate))
        return `On your card: "${control.label}" at ${placed(control)}. Moving it will reach you as control_moved.`
    }

    removeControl(owner: Actor, ref: string): string {
        const controls = this.controls()
        if (!controls.some(control => control.ref === ref && control.owner === owner)) {return `You have no control ${ref}.`}
        this.#setControls(controls.filter(control => control.ref !== ref))
        return `Removed ${ref}.`
    }

    // The producer let go of a control: a direction to its owner (TAKEDO_API.md, "Controls"), queued behind whatever
    // it's doing. Its card shows the move was heard at once.
    #control(ref: string, value: number): void {
        const controls = this.controls()
        const moved = controls.find(control => control.ref === ref)
        if (moved === undefined || !Number.isFinite(value)) {return}
        const was = this.#moved.has(ref) ? null : moved.value
        const control = {...moved, value: Math.min(1, Math.max(0, value))}
        this.#setControls(controls.map(candidate => candidate.ref === ref ? control : candidate))
        this.#log.write("control", {ref, value: control.value, owner: control.owner})
        if (!this.#moved.has(ref)) {this.#moved.set(ref, was ?? moved.value)}
        const describe = (): string => {
            const now = this.controls()
            const text = [...this.#moved].flatMap(([ref, was]) => {
                const control = now.find(candidate => candidate.ref === ref)
                return control === undefined || control.value === was ? []
                    : [`The producer moved your control "${control.label}" from ${was.toFixed(2)} to ${placed(control)}. It means: ${control.meaning}`]
            }).join("\n")
            this.#moved.clear()
            return text
        }
        const captain = this.#captain
        if (control.owner !== captain.agent) {return}
        this.card({agent: captain.agent, name: captain.name, doing: `heard: ${control.label} ${placed(control).replace(/ \(0 is.*$/, "")}`})
        if (this.#steering) {return}
        this.#steering = true
        captain.later(this, async () => {
            this.#steering = false
            const text = describe()
            const snapshot = text === "" ? null : await this.snapshot()
            return snapshot === null ? null : {turn: {kind: "control_moved", text}, snapshot}
        }).catch(error => this.say("agent:team_lead", `Something went wrong: ${String(error)}`))
    }

    // ---------- chat and routing ----------

    // Every message goes to the captain (the Team Lead), with or without "@team_lead" in front.
    async #chat(text: string): Promise<void> {
        const line = {id: randomUUID(), t: Date.now(), from: "user" as Actor, text}
        const history = this.#history.slice(-HistoryLines)
        this.#remember("user", text)
        this.#log.write("chat", line)
        this.#send({type: "chat", line})
        const mention = /^@(\w+)\s*/.exec(text)
        const named = mention === null ? null : mention[1]
        if (named !== null && named !== "team_lead") {
            return this.say("agent:team_lead", `There's no @${named} on the team.`)
        }
        const message = mention === null ? text : text.slice(mention[0].length)
        if (this.#project === null) {return this.say("agent:team_lead", "Open a project first.")}
        const snapshot = await this.snapshot()
        if (snapshot === null) {return this.say("agent:team_lead", "Open a project first.")}
        await this.#keepFacts()
        return this.#captain.handle(this, {kind: "producer_message", text: message, history}, snapshot)
    }

    // ---------- jobs (the captain's workers) ----------

    // Hands a piece of a direction to a fresh worker (the utility in job mode), which runs at once, alongside any
    // others; its timed steps join the direction's plan from the same anchor. Its report goes to the captain.
    assign(direction: Direction, anchor: Anchor | null, piece: string): string {
        const job = this.board.job(direction.id, piece)
        const worker = new Utility(this.#team, this.#catalog, this.#source, this.#knowledge, "job")
        void (async () => {
            const snapshot = await this.snapshot()
            if (snapshot === null) {throw new Error("no project is open")}
            return worker.job(this, {id: job.id, piece, message: direction.text, direction, anchor}, snapshot)
        })().then(async report => {
            this.board.jobDone(job.id, "done", report)
            await this.#sendJob(worker, direction, anchor, job.id)
            this.#report({kind: "job_finished", text: `${job.id} (${piece}): ${report}`, direction})
        }, async error => {
            this.board.jobDone(job.id, "failed", String(error))
            await this.#sendJob(worker, direction, anchor, job.id)
            this.#report({kind: "job_failed", text: `${job.id} (${piece}): stopped with an error: ${String(error)}`, direction})
        })
        return `Started ${job.id}. Its report comes back as job_finished.`
    }

    // A job's part goes out as soon as it's planned, from the direction's anchor (moved past the playhead by whole loop
    // passes, so a part planned late keeps its own order and spacing). Parts aren't in lockstep: waiting for the
    // slowest held a whole plan back 2 minutes in one session (2026-11-23), and the producer chose speed.
    async #sendJob(worker: Utility, direction: Direction, anchor: Anchor | null, job: string): Promise<void> {
        if (!this.board.staged(direction.id).some(step => step.job === job)) {return}
        await worker.send(this, direction, anchor, job).catch(error => this.#log.write("board", {event: "send_failed", error: String(error)}))
    }

    // A job's edits (or a direction's sent plan's: id null) that failed after the job reported.
    jobLate(id: string | null, text: string, direction?: Direction): void {
        const job = id === null ? undefined : this.board.jobOf(id)
        this.#report({kind: "job_failed_later", text: `${id ?? "the plan"}: failed after planning: ${text}`,
            direction: direction ?? (job === undefined ? undefined : this.board.directionOf(job.direction))})
    }

    // Job reports reach the captain together, in one turn built when its time comes.
    #report(report: { kind: "job_finished" | "job_failed" | "job_failed_later", text: string, direction?: Direction }): void {
        const captain = this.#captain
        this.#reports.push(report)
        if (this.#reporting) {return}
        this.#reporting = true
        captain.later(this, async () => {
            this.#reporting = false
            const reports = this.#reports.splice(0)
            const snapshot = reports.length === 0 ? null : await this.snapshot()
            if (snapshot === null) {return null}
            const kind = reports.some(report => report.kind !== "job_finished") ? reports.find(report => report.kind !== "job_finished")!.kind : "job_finished"
            return {turn: {kind, text: reports.map(report => report.text).join("\n"), direction: reports[0].direction}, snapshot}
        }).catch(error => this.say("agent:team_lead", `Something went wrong: ${String(error)}`))
    }

    // ---------- the overview ----------

    // Written when the view is open on a project that has none yet: on opening the view, or a project while it's open.
    #maybeOverview(): void {
        if (this.#viewOpen && this.#project !== null && this.#overview === "none") {this.#writeOverview()}
    }

    #writeOverview(): void {
        const project = this.#project
        if (project === null) {return}
        const missing = this.#gateway.missing("overview")
        if (missing !== null) {
            this.#send({type: "overview", state: "failed", detail: `The Team Lead can't read the project: ${missing}.`})
            return
        }
        this.#overview = "writing"
        this.#send({type: "overview", state: "writing"})
        const done = (state: "none" | "done"): boolean => {
            if (this.#project !== project) {return false}   // the project changed meanwhile; this one is moot
            this.#overview = state
            return true
        }
        this.snapshot("full")
            .then(snapshot => {
                if (snapshot === null) {throw new Error("no project open")}
                return writeOverview(this.#gateway, this.#catalog, this.modelLog(), snapshot)
            })
            .then(overview => {
                if (!done("done")) {return}
                this.#log.write("overview", overview)
                this.#send({type: "overview", state: "done", overview})
                this.#factsOverview(overview.lines)
            })
            .catch(error => {
                if (!done("none")) {return}
                this.#log.write("overview", {error: String(error)})
                this.#send({type: "overview", state: "failed", detail: `The Team Lead couldn't read the project: ${String(error)}`})
            })
    }

    #change(event: ChangeEvent): void {
        this.#log.seen(event.seq)
        this.#log.write("change", event)
        if (event.actor !== "user") {return}
        event.changes.forEach(({ref, label, from, to}) => this.#handChanges.push({t: event.t, pos: event.pos, ref, label, from, to}))
    }

    // The producer's changes from index on, folded per parameter (first from, last to), in words; and the index to
    // ask from next time. A parameter moved and put back is left out.
    handChanges(from: number): { lines: string[], next: number } {
        const folded = new Map<string, { label: string, from: number, to: number, pos: string, t: number }>()
        // Asked from past the end: the list was cleared (another project), so from its start.
        this.#handChanges.slice(from > this.#handChanges.length ? 0 : from).forEach(change => {
            const was = folded.get(change.ref)
            folded.set(change.ref, {label: change.label, from: was?.from ?? change.from, to: change.to, pos: change.pos, t: change.t})
        })
        const value = (number: number): string => String(Math.round(number * 100) / 100)
        const lines = [...folded].filter(([, change]) => Math.abs(change.to - change.from) > 1e-6).map(([ref, change]) =>
            `${change.label} (${ref}): ${value(change.from)} → ${value(change.to)}, at ${change.pos}, ${Math.round((Date.now() - change.t) / 1000)} s ago`)
        return {lines, next: this.#handChanges.length}
    }
}
