import {randomUUID} from "node:crypto"
import {
    type Actor, type Apply, type Decided, type BackendToPage, type ChangeEvent, type Control, type Detail, type MemberCard, type PageToBackend,
    type Plan, type Snapshot, type DrumPiece, type DrumTuning, type Genre, type SoundRole, type SoundTuning, type Status, target, type When
} from "../../shared/protocol.ts"
import type {Catalog} from "./catalog.ts"
import type {Gateway, ModelLog} from "./gateway.ts"
import {createTeam, type Member, performStep, type Step as MemberStep, type Task} from "./members.ts"
import {type Recall, RecallBars, recallOf, type Scope, scopeOf, Takes} from "./takes.ts"
import {blendOf} from "./blend.ts"
import {type Activity, Ledger, touchedBy} from "./ledger.ts"
import type {LogType, SessionLog} from "./sessionLog.ts"
import type {PartRole} from "./router.ts"
import {writeOverview} from "./teamLead.ts"
import {Notebook} from "./notebook.ts"
import {type Anchor, Board, type Direction, type Piece, pieceLine} from "./board.ts"
import {Captain} from "./captain.ts"
import type {LlmMember} from "./members.ts"
import {analyse, isDrums} from "./analysis.ts"
import type {Knowledge} from "./knowledge.ts"
import {Utility} from "./utility.ts"
import {type Line, triage, triageState} from "./triage.ts"
import {fastEffect, fastMix, SurePath, fastTweak} from "./fastpath.ts"
import {Profiles, Styles, styleSteps} from "./mixProfiles.ts"
import {auditionPhrase, drumAudition, padRole} from "./library.ts"
import {soundsAgainst} from "./soundFit.ts"
import {join} from "node:path"
import {addRule, learnPart, loadTemplates, type Move, type PartSpec, restyleMoves, type Rule, rulesFor, type Template, type TemplateRole, templateText} from "./restyle.ts"

// The backend half of the bus (TAKEDO_API.md, "Overview"), one per connected page: claims, plans, chat, routing.
// Talks to the page's adapter for state (snapshot queries) and to apply plans.

const ClaimMs = 30000
const HistoryLines = 12
// A dial move this close past one of its two ends still counts as between them (blend.ts).
const Edge = 0.02
// Who's in play. "utility" (the default; the name is older than what it now runs): the captain takes every message
// and hands pieces to workers, the utility in a fresh session per piece, running in parallel (ARCHITECTURE.md, "The
// team's structure", 2026-11-22); "team": the older full team (Jev routing, the one-off Team Lead split, specialists
// handing leftovers to one long-lived utility session), kept until it's retired (step 3).
// Controls a member may have on its card at once (INTERACTION.md: one intent control each; a few while it's tried out).
export const MaxControls = 3
const MaxOptions = 6
const Pressed = -1                                  // a button's "was" in #moved: never its value, so a press is always news
// A parameter a direct control may set: a track's or the master's mix control, or an effect's parameter.
const ParamRef = /^(t\d+|master)\.(mix\.(volume|pan|mute|solo)|fx\d+\.[A-Za-z0-9_.]+)$/
// A control's value as its widget has it: a switch on one of its two states, a choice on an option, a button at 0.
const settled = (widget: Control["widget"], value: number, options?: ReadonlyArray<string>): number => {
    const clamped = Number.isFinite(value) ? value : 0
    switch (widget) {
        case "dial": return Math.min(1, Math.max(0, clamped))
        case "switch": return clamped >= 0.5 ? 1 : 0
        case "choice": return Math.min((options?.length ?? 1) - 1, Math.max(0, Math.round(clamped)))
        case "button": return 0
    }
}
// A control's position in words, for its owner: where it sits between its two ends.
export const placed = (control: Control): string => {
    const {value, low, high, widget, options = []} = control
    if (widget === "switch") {return value >= 0.5 ? `on "${high}" (off is "${low}")` : `on "${low}" (the other is "${high}")`}
    if (widget === "choice") {return `"${options[Math.round(value)] ?? "?"}" (of ${options.map(option => `"${option}"`).join(", ")})`}
    if (widget === "button") {return "a button"}
    const where = value <= 0.05 ? `all the way to "${low}"` : value < 0.35 ? `toward "${low}"` : value <= 0.65 ? `in the middle`
        : value < 0.95 ? `toward "${high}"` : `all the way to "${high}"`
    return `${value.toFixed(2)}, ${where} (0 is "${low}", 1 is "${high}")`
}
const Terminal: ReadonlyArray<Status["state"]> = ["applied", "dropped", "failed"]

// The knowledge base's folder (main.ts reads it the same way): style templates and the producer's rules live there.
const KnowledgeDir = process.env.KNOWLEDGE_DIR ?? "../knowledge"

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
    // Style mix profiles waiting for their direction's parts to land: direction id → style (mixProfiles.ts).
    readonly #pendingMix = new Map<string, string>()
    readonly #reports: Array<{ kind: "job_finished" | "job_failed" | "job_failed_later", text: string, direction?: Direction }> = []
    #reporting = false
    readonly #knowledge: Knowledge | null
    readonly #learned: Rule[] = []                                  // rules learned in this session (learn)
    readonly #history: Array<{ from: string, text: string }> = []   // the chat so far, for messages that refer back
    #nextQuery = 0
    #project: string | null = null
    #opening: string | undefined = undefined   // the page's id for this opening of the project (protocol.ts)
    readonly #notebooks: string
    #takes: Takes = new Takes(null)        // the open project's takes (takes.ts)
    #effectAsked: string | null = null                // the producer's latest message Jev judged one effect (#effectKnob)
    readonly #mixBefore = new Map<string, number>()    // each mix control's value before its latest change, latest last ("back")
    readonly #recentChanges: Array<{ t: number, pos: string, actor: string, label: string, from: unknown, to: unknown }> = []
    readonly #blending = new Map<string, Set<string>>()   // per dial: the requests its last move sent (#blend)
    #ledger: Ledger = new Ledger(null)      // the open project's activity ledger (ledger.ts)
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
                // The team's sessions belong to one opening of a project: another project, or the same one opened anew,
                // starts them fresh (notebook.ts); a reconnect or a backend restart carries on.
                if (name !== this.#project || (message.opening !== undefined && message.opening !== this.#opening)) {this.close()}
                this.#project = name
                this.#opening = message.opening
                this.#notebook = this.#project === null ? null : new Notebook(this.#notebooks, this.#project, message.opening)
                this.board.open(this.#notebook?.boardFile ?? null)
                this.#takes = new Takes(this.#notebook?.takesFile ?? null)
                this.#ledger = new Ledger(this.#notebook?.ledgerFile ?? null, data => this.#log.write("activity", data))
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
            case "library":
                this.#sendLibrary()
                return
            case "audition":
                void this.#audition(message.id, message.role, message.tuning)
                return
            case "drum_audition":
                void this.#drumAudition(message.id, message.piece, message.tuning, message.alone)
                return
            case "drum_set": {
                const problem = this.#knowledge?.library?.setDrum(message.id, message.entry) ?? "no sound library (no samples)"
                if (problem !== null) {return this.#send({type: "error", detail: `The sound library: ${problem}`})}
                this.#log.write("library", {drum: message.id, entry: message.entry})
                this.#sendLibrary()
                return
            }
            case "library_set": {
                const problem = this.#knowledge?.library?.set(message.id, message.entry) ?? "no sound library (no samples)"
                if (problem !== null) {return this.#send({type: "error", detail: `The sound library: ${problem}`})}
                this.#log.write("library", {id: message.id, entry: message.entry})
                this.#sendLibrary()
                return
            }
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
            case "engine_health": {
                // With what came just before: the last changes, by hand or by agents (the session's riding of a tremolo).
                const recent = this.#recentChanges.slice(-12)
                this.#log.write("engine", {health: message.state, detail: message.detail, recent})
                if (message.state === "recovered" || message.state === "page_error") {return}
                const text = message.state === "crashed" ? "The audio engine crashed (openDAW is asking to restart it)."
                    : "The audio engine has stalled: the playhead stopped while playing."
                this.say("agent:team_lead", `${text} The last changes before it: ${recent.slice(-4).map(change => `${change.label} ${change.from} → ${change.to} (${change.actor.replace("agent:", "")})`).join("; ") || "none"}.`)
                this.#captain.notice(`${text} ${message.detail}`)
                return
            }
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
    // step: the board's step it carries out, if any (board.ts), linked to the request. activity: the direction (and
    // piece) it belongs to, for the ledger (a board step says its own); what it changes is recorded once it lands.
    request(agent: Actor, plan: Plan, when: When, seq: number, reason: string,
            onStatus: (status: Status) => void = () => {}, step?: string, activity?: Activity,
            decided: Decided = {by: "model"}): Promise<Status> {
        const id = randomUUID()
        if (step !== undefined) {this.board.link(step, id)}
        const staged = step === undefined ? null : this.board.step(step)
        const belongs: Activity | undefined = activity ?? (staged === null ? undefined
            : {direction: staged.direction, ...(staged.job !== undefined ? {job: staged.job} : {}), step: staged.id})
        const allowed = agent === this.#captain.agent ? this.#captain.may(plan) : this.#members.find(member => member.agent === agent)?.may(plan) === true
        if (!allowed) {
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
        const request: Apply = {id, from: agent, plan, when, seq, reason, decided}
        return this.#keepStart().then(() => new Promise<Status>(resolve => {
            this.#log.write("request", request)
            this.#requests.set(id, status => {
                onStatus(status)
                if (status.state === "applied") {
                    this.#recordActivity(request, status, belongs)
                    void this.#effectKnob(request, status, belongs)
                    if (request.plan.op === "remove_effect") {this.#dropKnobs(request.plan.ref)}
                }
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
            // MIDI numbers beside the names: openDAW names C3 = MIDI 60, a model's habit is C4 = 60, and a worker asked
            // for "A1 to A2" wrote it an octave low (2026-11-23).
            return `${track.name} (${track.ref}): ${part.register?.low}–${part.register?.high} (MIDI ${Math.min(...pitches)}–${Math.max(...pitches)})${low ? ", the bass register" : ""}`
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

    // Whether the producer said these words in this session (a learned rule quotes them; parts joined by " / ").
    producerSaid(words: string): boolean {
        const plain = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
        const said = this.#history.filter(line => line.from === "user").map(line => plain(line.text))
        const parts = words.split(/\s*(?:\/|→)\s*/).map(plain).filter(part => part !== "")
        return parts.length > 0 && parts.every(part => said.some(line => line.includes(part)))
    }

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
            notebook.set("controls", "state", `Controls on your card, as the producer has them now: ${controls.map(control =>
                `"${control.label}" (${control.ref}) at ${placed(control)}: ${control.meaning}`).join("; ")}.`, JSON.stringify(controls))
        }
        this.#log.write("controls", {controls})
        this.#sendControls()
    }

    #sendControls(): void {this.#send({type: "controls", controls: this.controls()})}

    // A member puts a control on its card, or changes one it has (same ref: the producer's position is kept).
    offerControl(owner: Actor, offered: Omit<Control, "owner">): string {
        if (this.#notebook === null) {return "Not offered: no project is open."}
        const controls = this.controls()
        const existing = controls.find(control => control.ref === offered.ref)
        if (existing !== undefined && existing.owner !== owner) {return `Not offered: ${offered.ref} is ${existing.owner}'s.`}
        if (existing === undefined && controls.filter(control => control.owner === owner).length >= MaxControls) {
            return `Not offered: you have ${MaxControls} controls already; remove one that no longer applies first.`
        }
        const {widget, kind} = offered
        const options = widget === "choice" ? (offered.options ?? []).filter(option => option.trim() !== "") : undefined
        if (options !== undefined && (options.length < 2 || options.length > MaxOptions)) {
            return `Not offered: a choice needs 2 to ${MaxOptions} options.`
        }
        const bind = kind === "direct" ? (offered.bind ?? []).filter(({ref, from, to}) =>
            ParamRef.test(ref) && Number.isFinite(from) && Number.isFinite(to)) : undefined
        if (bind !== undefined && (bind.length === 0 || (widget !== "dial" && widget !== "switch"))) {
            return "Not offered: a direct control is a dial or a switch, bound to at least one parameter (t2.mix.volume, t3.fx1.wet) with its from and to."
        }
        const control: Control = {ref: offered.ref, owner, kind, widget, label: offered.label, low: offered.low, high: offered.high,
            meaning: offered.meaning, value: settled(widget, existing?.widget === widget ? existing.value : offered.value, options),
            ...(options !== undefined ? {options} : {}), ...(bind !== undefined ? {bind} : {}),
            ...(existing?.transitions !== undefined ? {transitions: existing.transitions} : {})}
        this.#setControls(existing === undefined ? [...controls, control]
            : controls.map(candidate => candidate.ref === control.ref ? control : candidate))
        return `On your card: "${control.label}" at ${placed(control)}. ${kind === "direct"
            ? "The producer's moves set its parameters at once, as their own hand; you'll see them as producer_changed."
            : widget === "button" ? "A press will reach you as control_moved." : "Moving it will reach you as control_moved."}`
    }

    removeControl(owner: Actor, ref: string): string {
        const controls = this.controls()
        if (!controls.some(control => control.ref === ref && control.owner === owner)) {return `You have no control ${ref}.`}
        this.#setControls(controls.filter(control => control.ref !== ref))
        return `Removed ${ref}.`
    }

    // How a part in one of a dial's two versions only comes and goes as the dial moves (blend.ts): a default per part
    // (drums and bass hand over at the middle, the rest crossfade) that the Team Lead can change.
    setTransition(owner: Actor, ref: string, track: string, transition: "handover" | "crossfade"): string {
        const controls = this.controls()
        const control = controls.find(candidate => candidate.ref === ref && candidate.owner === owner)
        if (control === undefined) {return `You have no control ${ref}.`}
        this.#setControls(controls.map(candidate => candidate === control
            ? {...control, transitions: {...control.transitions ?? {}, [track]: transition}} : candidate))
        return `${control.label}: ${track} will ${transition === "handover" ? "hand over at the middle" : "crossfade across the dial"}.`
    }

    // The producer let go of a control: a direction to its owner (TAKEDO_API.md, "Controls"), queued behind whatever
    // it's doing. Its card shows the move was heard at once.
    #control(ref: string, value: number): void {
        const controls = this.controls()
        const moved = controls.find(control => control.ref === ref)
        if (moved === undefined || !Number.isFinite(value)) {return}
        const was = this.#moved.has(ref) ? null : moved.value
        const control = {...moved, value: settled(moved.widget, value, moved.options)}
        this.#setControls(controls.map(candidate => candidate.ref === ref ? control : candidate))
        this.#log.write("control", {ref, value: control.value, owner: control.owner, widget: control.widget, kind: control.kind})
        // A direct control's move is the producer's own hand on its parameters (the page set them): nothing for its owner
        // to do now; it sees them as producer_changed with its next turn.
        if (control.kind === "direct") {return}
        // A button keeps no position: each press is news (Pressed, below).
        if (!this.#moved.has(ref)) {this.#moved.set(ref, control.widget === "button" ? Pressed : was ?? moved.value)}
        const describe = (): string => {
            const now = this.controls()
            const text = [...this.#moved].flatMap(([ref, was]) => {
                const control = now.find(candidate => candidate.ref === ref)
                if (control === undefined) {return []}
                if (control.widget === "button") {return [`The producer pressed your button "${control.label}". It means: ${control.meaning}`]}
                if (control.value === was) {return []}
                const from = control.widget === "dial" ? was.toFixed(2) : placed({...control, value: was}).replace(/ \(.*$/, "")
                return [`The producer moved your control "${control.label}" from ${from} to ${placed(control)}. It means: ${control.meaning}`]
            }).join("\n")
            this.#moved.clear()
            return text
        }
        const captain = this.#captain
        if (control.owner !== captain.agent) {return}
        const within = () => {
            const ends = this.#takes.ends(ref)
            return ends !== null && control.value >= ends.lo.value - Edge && control.value <= ends.hi.value + Edge
        }
        const glide = () => {
            this.#moved.delete(ref)
            this.card({agent: captain.agent, name: captain.name, doing: `${control.label} ${placed(control).replace(/ \(0 is.*$/, "")}: gliding there`})
            void this.#blend(ref, control.value).catch(error => this.#log.write("blend_failed", {ref, error: String(error)}))
        }
        const lead = () => {
            this.card({agent: captain.agent, name: captain.name, doing: control.widget === "button" ? `heard: ${control.label}, pressed`
                : `heard: ${control.label} ${placed(control).replace(/ \((0 is|of|off is|the other is) .*$/, "")}`})
            if (this.#steering) {return}
            this.#steering = true
            captain.later(this, async () => {
                this.#steering = false
                const was = this.#moved.get(ref)
                const controls = [...this.#moved.keys()]
                const text = describe()
                if (text !== "" && was !== undefined && versioned) {await this.#keepLanded(ref, was)}
                const snapshot = text === "" ? null : await this.snapshot()
                return snapshot === null ? null : {turn: {kind: "control_moved", text, controls}, snapshot}
            }).catch(error => this.say("agent:team_lead", `Something went wrong: ${String(error)}`))
        }
        // Only a dial or a switch lies between two versions of the project (its takes); a choice's or a button's move is
        // always its owner's to act on.
        const versioned = control.widget === "dial" || control.widget === "switch"
        if (this.#steering || !versioned) {return lead()}
        if (within()) {return glide()}
        // The first move after its direction landed: that work is the dial's other end, kept now, then glided between.
        const previous = this.#moved.get(ref)
        if (previous === undefined || !this.#landed()) {return lead()}
        void this.#keepLanded(ref, previous).then(() => within() ? glide() : lead())
    }

    // ---------- the activity ledger (ledger.ts) ----------

    get ledger(): Ledger {return this.#ledger}

    #recordActivity(request: Apply, status: Status, activity: Activity | undefined): void {
        const touched = touchedBy(request.plan, status)
        const entry = {request: request.id, t: status.t, agent: request.from, direction: activity?.direction ?? "unknown",
            ...(activity?.job !== undefined ? {job: activity.job} : {}), ...(activity?.step !== undefined ? {step: activity.step} : {}),
            says: request.plan.op === "script" ? request.plan.description : status.result?.label ?? request.plan.op, op: request.plan.op, touched}
        if (this.#ledger.record(entry)) {this.#log.write("activity", entry)}
    }

    // ---------- takes (takes.ts) ----------

    takeLines(): string[] {return this.#takes.lines()}

    // The project as it is now, kept under a dial's position. before: a snapshot taken earlier (a direction's start).
    async keepTake(control: string, value: number, label: string, before?: Promise<Snapshot | null>): Promise<string | null> {
        const snapshot = await (before ?? this.snapshot("full"))
        if (snapshot === null || snapshot.detail !== "full") {return null}
        const take = this.#takes.keep(control, value, label, snapshot)
        this.#log.write("take", {id: take.id, control, value, label})
        return take.id
    }

    // A dial moved: if its direction's work has all landed (nothing coming, no job running), the project is that
    // direction at the dial's old position, kept as a take before the Team Lead acts on the move.
    #landed(): boolean {return !this.board.outstanding().some(({steps}) => steps.length > 0) && this.board.running().length === 0}

    async #keepLanded(ref: string, value: number): Promise<void> {
        // Only a position past the dial's two ends: one between them is a blend of the two, not a version of its own.
        const ends = this.#takes.ends(ref)
        if (ends !== null && value > ends.lo.value + Edge && value < ends.hi.value - Edge) {return}
        if (this.board.outstanding().some(({steps}) => steps.length > 0) || this.board.running().length > 0) {return}
        await this.keepTake(ref, value, "its direction's work, landed")
    }

    // Writes a take back, gliding over RecallBars bars from the next bar line (takes.ts): what the take's dial's own
    // directions changed since it (the ledger's scope), not other dials' or messages' work. The agent's own edits, so
    // they're undoable. Answers once they're sent; a failure later is logged and said.
    async recallTake(agent: Actor, id: string, reason: string, direction?: string): Promise<string> {
        const activity: Activity | undefined = direction === undefined ? undefined : {direction}
        const take = this.#takes.get(id)
        if (take === null) {return `Not done: no take ${id} (takes: ${this.#takes.lines().join("; ") || "none"}).`}
        const now = await this.snapshot("full")
        if (now === null) {return "Not done: no project is open."}
        const recall = recallOf(take.snapshot, now, scopeOf(take, this.#ledger.entries(), this.#ledger.directionsOf(take.control)))
        const conflicts = recall.conflicts.length === 0 ? "" : ` Not brought back, because another direction changed them too since: ` +
            `${recall.conflicts.join(", ")}'s notes. To take this dial's part out of them, assign a piece for each (notes): its notes ` +
            `as they are now, without what this dial's direction did to them, at the dial's new position.`
        if (recall.scripts.length === 0 && recall.values.length === 0) {return `Nothing to bring back for this dial: what it changed since take ${id} is as the take has it, or someone else's now.${conflicts}`}
        const says = await this.#sendRecall(agent, recall, now, `recall take ${id}`, reason, activity)
        return `Recalling take ${id} over the next ${RecallBars} bars, only what this dial's directions changed: ${says.join(", ")}.` +
            (recall.missing.length > 0 ? ` Can't bring back: ${recall.missing.join(", ")}.` : "") + conflicts
    }

    // A dial moved between its two takes: the project f of the way from one to the other (blend.ts), glided to as a
    // recall, by code (no Team Lead turn). What a move before it sent and hasn't landed yet is taken back first.
    async #blend(ref: string, value: number): Promise<void> {
        const ends = this.#takes.ends(ref), captain = this.#captain
        const now = await this.snapshot("full")
        if (ends === null || now === null) {return}
        this.#blending.get(ref)?.forEach(request => this.#send({type: "cancel", request}))
        const sent = new Set<string>()
        this.#blending.set(ref, sent)
        const {lo, hi} = ends
        const f = Math.min(1, Math.max(0, (value - lo.value) / (hi.value - lo.value)))
        const blend = blendOf(lo.snapshot, hi.snapshot, f, now, this.controls().find(control => control.ref === ref)?.transitions ?? {})
        const scope = scopeOf(lo.t < hi.t ? lo : hi, this.#ledger.entries(), this.#ledger.directionsOf(ref))
        // Also what the blend governs (a leaving part's notes it morphs), and everything on a track the dial's work made.
        const made = (key: string) => {
            const track = /^(?:value|notes|regions|switch|effect) (t\d+)/.exec(key)?.[1]
            return track !== undefined && scope.owns(`track ${track}`)
        }
        const wide: Scope = {owns: key => scope.owns(key) || blend.governs.has(key) || made(key), value: scope.value, shared: scope.shared}
        const recall = recallOf(blend.target, now, wide)
        const direction = this.#ledger.directionsOf(ref).at(-1)
        const says = recall.scripts.length === 0 && recall.values.length === 0 ? []
            : await this.#sendRecall(captain.agent, recall, now, `dial ${ref} to ${value.toFixed(2)}`, `dial ${ref}`,
                direction === undefined ? undefined : {direction}, request => sent.add(request))
        this.#log.write("blend", {ref, value, f, from: lo.id, to: hi.id, says: [...blend.says, ...says], conflicts: recall.conflicts})
    }

    // Sends a recall's edits, each on its bar from the next bar line; answers with what they'll do once they're sent.
    async #sendRecall(agent: Actor, recall: Recall, now: Snapshot, label: string, reason: string, activity: Activity | undefined,
                      sent: (request: string) => void = () => {}): Promise<string[]> {
        const track = (status: Status) => {if (status.state === "scheduled" || status.state === "queued") {sent(status.request)}}
        const from = {position: now.playback.position, played: now.playback.played}
        const at = (bar: number): When => ({at: "bar", bar, from})
        await Promise.all(recall.first.map(({ref, to}) => performStep(this, agent, {plan: {op: "set", ref, to}, when: {at: "asap"}, says: "", activity, decided: {by: "code"}}, reason)))
        const scripts = recall.scripts.map(async ({bar, code, says}) => {
            const claimed = this.claim(agent, ["project.script"], reason)
            if (!claimed.ok) {return `${says || "a stage"}: not done, ${claimed.holder.replace("agent:", "")} is running a script`}
            try {
                const status = await this.request(agent, {op: "script", code, description: `${label}, bar ${bar} of ${RecallBars}`}, at(bar), now.at.seq, reason,
                    track, undefined, activity, {by: "code"})
                return status.state === "applied" ? says : `${says || `bar ${bar}`}: not done (${status.reason}: ${status.detail ?? ""})`
            } finally {
                this.release(agent, ["project.script"])
            }
        })
        const values = recall.values.map(({ref, to, beats, bar, says}) =>
            performStep(this, agent, {plan: beats > 0 ? {op: "ramp", ref, to, beats} : {op: "set", ref, to}, when: at(bar), says, activity, decided: {by: "code"}}, reason, track))
        const all = Promise.all([...scripts, ...values]).then(results => {
            const failed = results.filter(result => /not done/.test(result))
            this.#log.write("take", {recalled: label, scripts: recall.scripts.length, values: recall.values.length, failed})
            const real = failed.filter(result => !/cancelled/.test(result))
            if (real.length > 0) {this.say(agent, `Part of bringing that version back didn't land: ${real.join("; ")}.`)}
        })
        void all
        return [...recall.scripts.map(script => script.says), ...recall.values.map(value => value.says)].filter(text => text !== "")
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
        if (await this.#fastPath(message, snapshot, history)) {return}
        await this.#keepFacts()
        return this.#captain.handle(this, {kind: "producer_message", text: message, history}, snapshot)
    }

    // Jev in front of the Team Lead (triage.ts, fastpath.ts): one mixer move it's sure of is done by code at once, the
    // reply from the Team Lead's name; the line goes into the chat history, so the Team Lead's next turn sees it.
    // Anything else, or Jev unavailable, goes to the Team Lead as before.
    async #fastPath(message: string, snapshot: Snapshot, history: Line[]): Promise<boolean> {
        if (!this.#gateway.available("fast_path")) {return false}
        const full = await this.snapshot("full")
        const judged = await triage(this.#gateway, this.modelLog(), triageState(full ?? snapshot), message, history).catch(() => null)
        if (judged === null) {return false}
        if (judged.path === "effect" && judged.pathP >= SurePath) {this.#effectAsked = message}
        const single = fastMix(judged, message, snapshot, Object.fromEntries(this.#mixBefore)) ?? fastEffect(judged, message, full ?? snapshot)
        const fast = single !== null ? {steps: [single.step], says: single.says}
            : full === null ? null : fastTweak(judged, message, full, (call, args) => this.#knowledge?.script(call, args) ?? null)
        this.#log.write("triage", {message, ...judged, fast: fast !== null})
        if (fast === null) {return false}
        const agent: Actor = "agent:team_lead"
        this.say(agent, fast.says)
        // Its own direction on the board, so the edit is owned (the ledger) and an effect it adds gets its knob (#effectKnob).
        const direction = this.board.direction(message)
        for (const step of fast.steps) {
            void performStep(this, agent, {...step, decided: {by: "jev", ms: judged.ms}, activity: {direction: direction.id}}, message).then(result => {
                if (/not done/.test(result)) {this.say(agent, `That didn't land: ${result.replace(/^.*?: not done/, "not done")}.`)}
            })
        }
        return true
    }

    // ---------- jobs (the captain's workers) ----------

    // Hands a piece of a direction to a fresh worker (the utility in job mode), which runs at once, alongside any
    // others; its timed steps join the direction's plan from the same anchor. Its report goes to the captain.
    assign(direction: Direction, anchor: Anchor | null, task: Piece): string {
        const piece = pieceLine(task)
        const same = this.board.sameAs(direction.id, task)
        if (same !== undefined) {
            return `Not started: ${same.id} ${same.state === "running" ? "is making" : "made"} this change (${same.piece})` +
                `${same.summary !== undefined ? `; it reported: ${same.summary}` : ""}. Its edits are its own: a second job would add ` +
                "a second part on top. To change what it made, give a piece on the track it made (its ref from the project), saying what to change."
        }
        const job = this.board.job(direction.id, piece, task)
        const worker = new Utility(this.#team, this.#catalog, this.#source, this.#knowledge)
        void (async () => {
            const snapshot = await this.snapshot()
            if (snapshot === null) {throw new Error("no project is open")}
            return worker.job(this, {id: job.id, piece, task, message: direction.text, direction, anchor}, snapshot)
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

    // The sound library for the Sounds tab, with the character effects a sound's tuning can name (knowledge chains).
    #sendLibrary(): void {
        const library = this.#knowledge?.library
        if (library === undefined || library === null) {return this.#send({type: "error", detail: "The sound library needs TakeDo's samples (make samples)."})}
        const chains = this.#knowledge!.index().filter(line => line.key.startsWith("chain/")).map(line => ({key: line.key, summary: line.summary}))
        this.#send({type: "library", sounds: library.list(), drums: library.drums(), chains})
    }

    // A sound as the Sounds tab auditions it: its role's phrase in the project's key, on a track made the way an agent
    // makes one with that sound and the tuning being tried. The page runs it as the producer's edit and removes it after.
    async #audition(id: string, role: SoundRole, tuning: SoundTuning): Promise<void> {
        const knowledge = this.#knowledge, snapshot = await this.snapshot()
        if (knowledge === null || snapshot === null) {return this.#send({type: "audition", id, error: "Open a project first."})}
        const facts = this.#notebook?.get("facts") ?? null
        const said = facts === null ? null : (JSON.parse(facts.value)?.key?.said as string | undefined) ?? null
        const key = said !== null && !said.startsWith("unknown") ? said : "C minor"
        const phrase = auditionPhrase(role, key, tuning.register)
        if (typeof phrase === "string") {return this.#send({type: "audition", id, error: phrase})}
        const made = knowledge.audition({sound: id, name: `Audition: ${id.split("/").pop()}`,
            notes: {notes: phrase.hits, loop_bars: phrase.beats / snapshot.timeline.signature[0], bars: 16, from_bar: 0}}, tuning, snapshot)
        this.#send(typeof made === "string" ? {type: "audition", id, error: made} : {type: "audition", id, code: made.code})
    }

    // A drum sample as the Sounds tab auditions it: a beat featuring its piece on a kit made the way an agent makes one,
    // the sample on its piece's pad with the tuning being tried, the producer's kept samples (else its machine's) around it.
    async #drumAudition(id: string, piece: DrumPiece, tuning: DrumTuning, alone: boolean): Promise<void> {
        const knowledge = this.#knowledge, library = knowledge?.library ?? null, snapshot = await this.snapshot()
        if (knowledge === null || library === null || snapshot === null) {return this.#send({type: "audition", id, error: "Open a project first."})}
        const sample = knowledge.samples?.find(id) ?? null
        if (sample === null) {return this.#send({type: "audition", id, error: `no drum sample ${id}`})}
        const groove = drumAudition(piece, alone, snapshot.timeline.signature[0])
        if (typeof groove === "string") {return this.#send({type: "audition", id, error: groove})}
        const around = groove.backing.flatMap(other => {
            const backing = library.backing(other, sample.machine)
            return backing === null ? [] : [{role: other, sample: backing.id}]
        })
        const made = knowledge.kit({name: `Audition: ${id.split("/").pop()}`, pads: [{role: padRole(piece), sample: sample.id, tuning}, ...around],
            notes: {hits: groove.hits, beats: groove.beats, bars: 16, from_bar: 0}}, snapshot)
        this.#send(typeof made === "string" ? {type: "audition", id, error: made} : {type: "audition", id, code: made.code})
    }

    // The parts playing whose sound isn't for a style (soundFit.ts), for the Team Lead's style turns.
    soundsAgainst(style: Genre, snapshot: Snapshot): string[] {
        return soundsAgainst(style, snapshot, this.#catalog, this.#knowledge?.library ?? null)
    }

    // Style templates (restyle.ts), read again each time, so a rule learned in this session applies at once.
    templates(): Map<string, Template> {
        return loadTemplates(join(KnowledgeDir, "style"))
    }

    // The producer's rules for these styles and every style (restyle.ts), read again each time.
    rules(styles: ReadonlyArray<string>): Rule[] {
        return rulesFor(join(KnowledgeDir, "rules.json"), styles)
    }

    // A correction learned (the Team Lead's learn): the rule kept at once, and a template's part changed when a fix the
    // producer approved changed it. The event goes in the session log.
    learn(rule: Rule, part: Partial<PartSpec> | null): string {
        if (part !== null) {
            if (rule.style === null || rule.role === null) {return "Not learned: a part change needs its style and role."}
            if (part.sound !== undefined && this.#knowledge?.samples?.sound(part.sound) === null) {return `Not learned: no sound ${part.sound} (ids as the sounds tool gives them).`}
            const problem = learnPart(join(KnowledgeDir, "style"), rule.style, rule.role as TemplateRole, part)
            if (problem !== null) {return `Not learned: ${problem}.`}
        }
        // A fix's approval refines the rule its correction made earlier in this session: one rule per style and part.
        const earlier = this.#learned.filter(other => other.style === rule.style && other.role === rule.role)
        const kept = earlier.length === 0 ? rule : {...rule, said: [...earlier.map(other => other.said), rule.said].join(" / ")}
        addRule(join(KnowledgeDir, "rules.json"), kept, earlier)
        this.#learned.push(kept)
        this.#log.write("board", {event: "learned", rule, part})
        return `Learned, from now on: ${kept.text}${part !== null ? ` (the ${rule.style} template's ${rule.role} changed: ${JSON.stringify(part)})` : ""}.`
    }

    // A style direction by its template (restyle.ts): the parts by code, each new one handed over (drums) or crossfaded
    // over the bars given while the old fades out and is parked; tempo and the master as workers' pieces with exact
    // goals; the style's mix after. Answers what it does at once; the edits land in the background.
    async restyle(direction: Direction, anchor: Anchor | null, style: string, overBars: number): Promise<string> {
        const template = this.templates().get(style)
        if (template === undefined) {return `Not done: no template for ${style}; there are ${[...this.templates().keys()].join(", ")}.`}
        if (this.#knowledge === null) {return "Not done: no knowledge base."}
        const snapshot = await this.snapshot("full")
        if (snapshot === null) {return "Not done: no project open."}
        const made = restyleMoves(template, snapshot, this.#knowledge, this.#catalog, overBars > 0)
        if (typeof made === "string") {return `Not done: ${made}`}
        const beats = Math.max(0, overBars) * snapshot.timeline.signature[0]
        void Promise.all(made.moves.map(move => this.#move(direction, move, beats)))
            .then(results => this.#log.write("board", {event: "restyle", style, direction: direction.id, results}))
        const [low, high] = template.tempo, bpm = snapshot.timeline.bpm
        const tempo = bpm < low ? low : bpm > high ? high : null
        if (made.moves.length === 0 && tempo === null) {
            return `Everything is the ${style} template already: ${made.left.join("; ")}. Nothing assigned.\nThe template:\n${templateText(template, this.rules([style]))}`
        }
        const pieces: Piece[] = [
            ...(tempo === null ? [] : [{kind: "tempo" as const, tracks: [], goal: `The tempo glides from ${Math.round(bpm)} to ${tempo} BPM.`,
                from_bar: 0, to_bar: overBars, steps: overBars > 0 ? 4 : 1, keep: ""}]),
            {kind: "effects", tracks: ["master"], goal: `The master for ${style}: ${template.master}.`, from_bar: 0, to_bar: overBars,
                steps: overBars > 0 ? 4 : 1, keep: this.rules([style]).filter(rule => rule.role === null).map(rule => rule.text).join("; ")}
        ]
        const assigned = pieces.map(piece => this.assign(direction, anchor, piece))
        const mix = Profiles[style] === undefined ? "" : this.styleMix(direction, style)
        return [`The ${style} template, by code: ${made.moves.map(move => `${move.old === null ? "new" : `${move.old.ref} ${move.old.name} →`} ${move.says}`).join("; ") || "no part to change"}.`,
            ...(made.left.length > 0 ? [`Left as they are: ${made.left.join("; ")}.`] : []),
            ...assigned, mix, `The template:\n${templateText(template, this.rules([style]))}`].filter(line => line !== "").join("\n")
    }

    // One template part: its new track made, then (crossfading) faded up while its old part fades down, the old parked.
    async #move(direction: Direction, move: Move, beats: number): Promise<string> {
        const agent = this.#captain.agent
        const step = (plan: Plan, says: string) => performStep(this, agent, {plan, when: {at: "next", unit: "bar"}, says,
            decided: {by: "code"}, activity: {direction: direction.id}}, `the style template: ${move.says}`)
        if (move.code === null) {return this.#keep(direction, move, beats)}
        const made = await step({op: "script", code: move.code, description: move.says}, move.says)
        if (/not done/.test(made)) {return made}
        const now = await this.snapshot()
        const track = now?.tracks.filter(candidate => candidate.name === move.name).at(-1)
        const results = [made]
        if (move.old !== null && (move.handover || beats === 0)) {
            results.push(await step({op: "set", ref: `${move.old.ref}.mix.mute`, to: 1}, `${move.old.name} parked`))
            return results.join("; ")
        }
        if (track !== undefined) {
            const up = step({op: "ramp", ref: `${track.ref}.mix.volume`, to: move.level_db, beats}, `${move.name} fading in`)
            const down = move.old === null ? Promise.resolve("") : step({op: "ramp", ref: `${move.old.ref}.mix.volume`, to: -60, beats}, `${move.old.name} fading out`)
            results.push(...await Promise.all([up, down]))
        }
        if (move.old !== null) {results.push(await step({op: "set", ref: `${move.old.ref}.mix.mute`, to: 1}, `${move.old.name} parked`))}
        return results.filter(result => result !== "").join("; ")
    }

    // A part the template keeps (the song's own bass, 2026-11-26): a Revamp put on open, then its high- and low-pass and
    // the part's level glide to the template's over the bars given (at least a bar: nothing jumps).
    async #keep(direction: Direction, move: Move, beats: number): Promise<string> {
        const track = move.old!
        const over = Math.max(beats, 4)
        const step = (plan: Plan, says: string, then?: MemberStep["then"]) => performStep(this, this.#captain.agent, {plan, when: {at: "next", unit: "bar"}, says,
            decided: {by: "code"}, activity: {direction: direction.id}, ...(then !== undefined ? {then} : {})}, `the style template: ${move.says}`)
        const results: Array<Promise<string>> = []
        if (Math.abs(track.mix.volume - move.level_db) > 0.5) {
            results.push(step({op: "ramp", ref: `${track.ref}.mix.volume`, to: move.level_db, beats: over}, `${track.name} to ${move.level_db} dB`))
        }
        const tone = move.tone
        if (tone !== undefined) {
            results.push(step({op: "add_effect", track: track.ref, device: "Revamp", factory: "Revamp", settings: [
                {param: "highPass/enabled", value: 1}, {param: "highPass/frequency", value: 20},
                {param: "lowPass/enabled", value: 1}, {param: "lowPass/frequency", value: 20000}]}, `${track.name}: a Revamp, open`, added => {
                const ramp = (path: string, to: number, says: string): MemberStep[] => {
                    const param = added.params?.find(one => one.ref === `${added.ref}.${path}`)
                    return param === undefined ? [] : [{plan: {op: "ramp", ref: param.ref, to, beats: over}, when: {at: "next", unit: "beat"}, says}]
                }
                return [...ramp("lowPass/frequency", tone.high_cut, `${track.name} low-passed to ${tone.high_cut} Hz`),
                    ...ramp("highPass/frequency", tone.low_cut, `${track.name} high-passed at ${tone.low_cut} Hz`)]
            }))
        }
        return (await Promise.all(results)).join("; ")
    }

    // A style's mix (mixProfiles.ts): applied by code once the direction's parts have landed (no job running, nothing
    // staged or on its way), so new parts get their place too; every pan and send glides. A later call in the same
    // direction changes the style still waiting.
    styleMix(direction: Direction, style: string): string {
        const profile = Profiles[style]
        if (profile === undefined) {return `Not done: no mix profile for ${style}; there are ${Styles.join(", ")}.`}
        const waiting = this.#pendingMix.has(direction.id)
        this.#pendingMix.set(direction.id, style)
        if (!waiting) {void this.#mixWhenLanded(direction)}
        return `The ${style} mix (${profile.summary}) goes on once this direction's parts have landed, each part's pan and sends gliding over 2 bars.`
    }

    async #mixWhenLanded(direction: Direction): Promise<void> {
        const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
        const busy = () => this.board.running().some(job => job.direction === direction.id)
            || this.board.outstanding().some(entry => entry.direction?.id === direction.id && entry.steps.length > 0)
        // A grace for pieces assigned in the same turn, then until its work has landed (at most 5 minutes).
        await pause(4000)
        const deadline = Date.now() + 5 * 60_000
        while (busy() && Date.now() < deadline) {await pause(1000)}
        const style = this.#pendingMix.get(direction.id)
        this.#pendingMix.delete(direction.id)
        const snapshot = style === undefined ? null : await this.snapshot("full")
        if (style === undefined || snapshot === null) {return}
        const made = styleSteps(style, snapshot)
        if (typeof made === "string") {return this.#log.write("board", {event: "style_mix_failed", style, error: made})}
        // Code in the Team Lead's name, as the fast path's edits are.
        const results = await Promise.all(made.steps.map(step => performStep(this, this.#captain.agent,
            {...step, decided: {by: "code"}, activity: {direction: direction.id}}, `the ${style} mix`)))
        this.#log.write("board", {event: "style_mix", style, direction: direction.id, results})
        const missed = results.filter(result => /not done/.test(result))
        if (missed.length > 0) {this.jobLate(null, `the ${style} mix: ${missed.join("; ")}`, direction)}
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
            .then(async ({overview, names}) => {
                if (!done("done")) {return}
                const renamed = await this.#rename(names)
                const shown = renamed.length === 0 ? overview
                    : {...overview, lines: [...overview.lines, {label: "Renamed", text: `${renamed.join(", ")}, for what they play.`}]}
                this.#log.write("overview", shown)
                this.#send({type: "overview", state: "done", overview: shown})
                this.#factsOverview(shown.lines)
            })
            .catch(error => {
                if (!done("none")) {return}
                this.#log.write("overview", {error: String(error)})
                this.#send({type: "overview", state: "failed", detail: `The Team Lead couldn't read the project: ${String(error)}`})
            })
    }

    // Tracks named after their instrument get the overview's names (teamLead.ts, deviceNamed): one edit, the Team
    // Lead's, undoable. Returns "Cubed → Acid Bass" for each track renamed.
    async #rename(names: Record<string, string>): Promise<string[]> {
        const snapshot = await this.snapshot()
        if (snapshot === null || Object.keys(names).length === 0) {return []}
        const pairs = Object.entries(names).flatMap(([ref, name]) => {
            const track = snapshot.tracks.find(track => track.ref === ref)
            return track === undefined || track.name === name ? [] : [{ref, from: track.name, to: name}]
        })
        if (pairs.length === 0) {return []}
        const code = `for (const [track, name] of ${JSON.stringify(pairs.map(({ref, to}) => [ref, to]))}) ` +
            `ref(track).inputAdapter.unwrap().labelField.setValue(name)`
        const reason = "naming tracks for what they play"
        if (!this.claim("agent:team_lead", ["project.script"], reason).ok) {return []}
        try {
            const status = await this.request("agent:team_lead", {op: "script", code,
                description: `Tracks named for what they play: ${pairs.map(({from, to}) => `${from} → ${to}`).join(", ")}`},
                {at: "asap"}, snapshot.at.seq, reason)
            return status.state === "applied" ? pairs.map(({from, to}) => `${from} → ${to}`) : []
        } finally {
            this.release("agent:team_lead", ["project.script"])
        }
    }

    // An effect the producer asked for gets a knob (2026-11-25: "put a reverb on master", then "more reverb", and no
    // control to ride): when an edit made for a message Jev judged one effect adds one, code offers a direct dial on
    // the Team Lead's card bound to its amount (wet or mix), and the Team Lead says so. Only for that message's first
    // effect: a style direction's effects get none, so the card doesn't fill up.
    async #effectKnob(request: Apply, status: Status, activity: Activity | undefined): Promise<void> {
        const asked = activity === undefined ? undefined : this.board.textOf(activity.direction)
        if (this.#effectAsked === null || asked !== this.#effectAsked) {return}
        const added = touchedBy(request.plan, status).effects.find(effect => effect.change === "added")
        if (added === undefined) {return}
        this.#effectAsked = null
        // After its fade-in (a beat, page/Adapter.ts EffectFadeBeats), so the knob starts where the effect settles.
        const tempo = (await this.snapshot())?.timeline.bpm ?? 120
        await new Promise(resolve => setTimeout(resolve, 1.5 * 60000 / tempo))
        const snapshot = await this.snapshot()
        if (snapshot === null) {return}
        const devices = [...snapshot.tracks.map(track => ({where: track.name, effects: track.effects})), {where: "the master", effects: snapshot.master.effects}]
        const owner = devices.find(({effects}) => effects.some(effect => effect.ref === added.ref))
        const device = owner?.effects.find(effect => effect.ref === added.ref)
        const amount = device?.params?.find(param => /\.(wet|mix)$/.test(param.ref))
        if (owner === undefined || device === undefined || amount === undefined) {return}
        // A wet in dB from -40 (barely there) to 0; a mix from none to all.
        const [from, to] = amount.ref.endsWith(".wet") ? [Math.max(amount.min, -40), Math.min(amount.max, 0)] : [amount.min, amount.max]
        const value = Math.max(0, Math.min(1, (amount.value - from) / (to - from)))
        const said = this.offerControl("agent:team_lead", {ref: `c:${added.ref.replace(/\./g, "_")}_amount`, kind: "direct", widget: "dial",
            label: `${device.name} on ${owner.where === "the master" ? "the master" : owner.where}`, low: "dry", high: "wet",
            meaning: `How much of the ${device.name} you hear`, value, bind: [{ref: amount.ref, from, to}]})
        if (said.startsWith("On your card")) {this.say("agent:team_lead", `There's a knob for the ${device.name.toLowerCase()} on my card, to set how much of it you hear.`)}
    }

    // A parked effect's knobs leave the card with it.
    #dropKnobs(effect: string): void {
        const controls = this.controls()
        const kept = controls.filter(control => !(control.bind ?? []).some(({ref}) => ref.startsWith(`${effect}.`)))
        if (kept.length !== controls.length) {this.#setControls(kept)}
    }

    // A direct knob follows its parameter when an agent moves it ("more reverb" after the reverb's knob was offered);
    // the producer's own moves aren't echoed back, so the knob doesn't fight their hand.
    #followKnobs(event: ChangeEvent): void {
        if (event.actor === "user") {return}
        const controls = this.controls()
        let moved = false
        const next = controls.map(control => {
            const bound = control.kind === "direct" && control.widget === "dial" ? control.bind?.[0] : undefined
            const change = bound === undefined ? undefined : event.changes.find(change => change.ref === bound.ref)
            if (bound === undefined || change === undefined || bound.to === bound.from) {return control}
            moved = true
            return {...control, value: Math.max(0, Math.min(1, (Number(change.to) - bound.from) / (bound.to - bound.from)))}
        })
        if (moved) {this.#setControls(next)}
    }

    #change(event: ChangeEvent): void {
        this.#followKnobs(event)
        this.#log.seen(event.seq)
        this.#log.write("change", event)
        event.changes.filter(({ref}) => /\.mix\.(volume|pan|mute)$/.test(ref) && typeof ref === "string").forEach(({ref, from}) => {
            this.#mixBefore.delete(ref)
            this.#mixBefore.set(ref, Number(from))
        })
        event.changes.forEach(({label, from, to}) => this.#recentChanges.push({t: event.t, pos: event.pos, actor: event.actor, label,
            from: typeof from === "number" ? Number(from.toFixed(3)) : from, to: typeof to === "number" ? Number(to.toFixed(3)) : to}))
        this.#recentChanges.splice(0, Math.max(0, this.#recentChanges.length - 40))
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
