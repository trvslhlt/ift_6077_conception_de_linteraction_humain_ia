import {randomUUID} from "node:crypto"
import {
    type Actor, type Apply, type BackendToPage, type ChangeEvent, type Control, type Detail, type MemberCard, type PageToBackend,
    type Plan, type Snapshot, type Status, target, type When
} from "../../shared/protocol.ts"
import type {Catalog} from "./catalog.ts"
import type {Gateway, ModelLog} from "./gateway.ts"
import {createTeam, type Member, type Task} from "./members.ts"
import {isRole, type KnowledgePick, type PartRole, pickKnowledge, type Role, route} from "./router.ts"
import type {LogType, SessionLog} from "./sessionLog.ts"
import {lead, writeOverview} from "./teamLead.ts"
import {Notebook} from "./notebook.ts"
import {Board} from "./board.ts"
import {analyse, isDrums} from "./analysis.ts"
import type {Knowledge} from "./knowledge.ts"
import {Utility} from "./utility.ts"

// The backend half of the bus (TAKEDO_API.md, "Overview"), one per connected page: claims, plans, chat, routing.
// Talks to the page's adapter for state (snapshot queries) and to apply plans.

const ClaimMs = 30000
const HistoryLines = 12
// Who's in play. "utility": the utility alone takes every message, with no Jev routing and no Team Lead split, while
// the basics of agents working in openDAW get worked out (it keeps the members' fixed operations as its tools);
// "team": the full team. Decided 2026-11-07, to bring the roles back one at a time once the utility works well.
// TAKEDO_ROSTER, from `make up ROSTER=…` (the smoke test runs the team).
const Roster: "utility" | "team" = process.env.TAKEDO_ROSTER === "team" ? "team" : "utility"
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
// The knowledge route (router.ts, pickKnowledge) in front of the utility: on with TAKEDO_KNOWLEDGE_ROUTE=on. Off by
// default until the utility alone has its baseline (the roadmap: the utility first, then Jev); the utility has the
// knowledge base either way.
const KnowledgeRoute = process.env.TAKEDO_KNOWLEDGE_ROUTE === "on"

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
        this.#members = Roster === "team" ? [...team, utility] : [utility]
    }

    get gateway(): Gateway {return this.#gateway}

    // The page went away: end the utility's agent session.
    close(): void {this.#members.forEach(member => {if (member instanceof Utility) {member.close()}})}

    // The open project's notebook (notebook.ts); null with no project open.
    get notebook(): Notebook | null {return this.#notebook}

    // Tells the page who's on the team (the Team Lead first), for mentions and autocomplete. The utility isn't shown:
    // the producer sees its work as the Team Lead's (an alias; it keeps its own claims, attribution and log lines).
    start(): void {
        this.#send({type: "team", aliases: {"agent:utility": "agent:team_lead"}, members: [
            {role: "team_lead", name: "Team lead", area: Roster === "team"
                ? "the front door: hands your direction to the team, and does the rest itself" : "does what you ask in openDAW"},
            ...this.#members.filter(member => member.role !== "utility")
                .map(({role, name, area, can}) => ({role, name, area: `${area}. Fast at: ${can}`}))]})
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
                const utility = this.#members.find(member => member instanceof Utility)
                if (this.#notebook !== null && utility instanceof Utility) {
                    utility.recover(this).catch(error => this.say("agent:team_lead", `Something went wrong: ${String(error)}`))
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
                this.#members.forEach(member => {if (member instanceof Utility) {member.reconciled(coming, lost)}})
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
                this.#members.forEach(member => {if (member instanceof Utility) {member.notice(text)}})
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
        const {cancelled, requests, missed} = this.board.cancel(ids)
        requests.forEach(request => this.#send({type: "cancel", request}))
        if (cancelled.length === 0) {return `Nothing cancelled${missed.length > 0 ? `: no step not yet landed starts with ${missed.join(", ")}` : ": nothing is waiting"}.`}
        return `Cancelled ${cancelled.length}: ${cancelled.map(step => `${step.says} (bar ${step.bar})`).join("; ")}.` +
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
        const utility = this.#members.find(member => member instanceof Utility)
        if (!(utility instanceof Utility) || control.owner !== utility.agent) {return}
        this.card({agent: utility.agent, name: utility.name, doing: `heard: ${control.label} ${placed(control).replace(/ \(0 is.*$/, "")}`})
        if (this.#steering) {return}
        this.#steering = true
        utility.steer(this, async () => {
            this.#steering = false
            const now = this.controls()
            const text = [...this.#moved].flatMap(([ref, was]) => {
                const control = now.find(candidate => candidate.ref === ref)
                return control === undefined || control.value === was ? []
                    : [`The producer moved your control "${control.label}" from ${was.toFixed(2)} to ${placed(control)}. It means: ${control.meaning}`]
            }).join("\n")
            this.#moved.clear()
            const snapshot = text === "" ? null : await this.snapshot()
            if (snapshot === null) {return null}
            const task: Task = {message: text, piece: null, hints: null, control: true}
            return {task, snapshot}
        }).catch(error => this.say("agent:team_lead", `Something went wrong: ${String(error)}`))
    }

    // ---------- chat and routing ----------

    // @member: straight to it (with Jev's hints if it wants them). @team_lead: the Team Lead splits it. Otherwise Jev
    // routes: one member clearly needed gets it with the hints, anything else goes to the Team Lead.
    async #chat(text: string): Promise<void> {
        const line = {id: randomUUID(), t: Date.now(), from: "user" as Actor, text}
        const history = this.#history.slice(-HistoryLines)
        this.#remember("user", text)
        this.#log.write("chat", line)
        this.#send({type: "chat", line})
        const mention = /^@(\w+)\s*/.exec(text)
        const named = mention === null ? null : mention[1]
        if (named !== null && named !== "team_lead" && !isRole(named)) {
            return this.say("agent:team_lead", `There's no @${named} on the team.`)
        }
        const message = mention === null ? text : text.slice(mention[0].length)
        if (this.#project === null) {return this.say("agent:team_lead", "Open a project first.")}
        const snapshot = await this.snapshot()
        if (snapshot === null) {return this.say("agent:team_lead", "Open a project first.")}
        await this.#keepFacts()
        const utility = this.#members.find(member => member.role === "utility")
        if (Roster === "utility" && utility instanceof Utility) {
            const task: Task = {message, piece: null, hints: null, history}
            const picked = await this.#pickKnowledge(snapshot, message, named)
            if (picked?.path === "apply") {return utility.applyEntry(this, task, picked.key, picked.args, snapshot)}
            return utility.handle(this, picked?.path === "hint" ? {...task, candidates: picked.candidates} : task, snapshot)
        }
        // A role nobody fills yet is still work the team does: the Team Lead takes it.
        const addressed = named === null ? null : this.#members.find(member => member.role === named)
        if (named === "team_lead" || addressed === undefined) {return this.#lead(message, snapshot)}
        if (addressed !== null && !addressed.wantsHints) {
            return addressed.handle(this, {message, piece: null, hints: null, direct: true}, snapshot)
        }
        const missing = this.#gateway.missing("fast_path")
        if (missing !== null) {return this.say("agent:team_lead", `I can't reach Jev: ${missing}.`)}
        const routed = await route(this.#gateway, this.modelLog(), snapshot, message, addressed === null ? null : named as Role)
        this.#log.write("route", routed)
        if (routed.path === "slow") {return this.#lead(message, snapshot)}
        const member = this.#members.find(member => member.role === routed.member)
        if (member === undefined) {return this.#lead(message, snapshot)}
        await member.handle(this, {message, piece: null, hints: routed.hints, direct: addressed !== null}, snapshot)
    }

    // Jev's look at the knowledge base before the utility's turn: null when there's no knowledge base or no Jev, the
    // message is addressed to someone, or the call fails (the utility then works as before).
    async #pickKnowledge(snapshot: Snapshot, message: string, named: string | null): Promise<KnowledgePick | null> {
        if (!KnowledgeRoute || this.#knowledge === null || named !== null || !this.#gateway.available("fast_path")) {return null}
        try {
            const facts = this.#notebook?.get("facts") ?? null
            const roles = facts === null ? {} : (JSON.parse(facts.value).roles ?? {}) as Record<string, PartRole>
            const picked = await pickKnowledge(this.#gateway, this.modelLog(), this.#knowledge, snapshot, message, roles)
            this.#log.write("route", {...picked, path: `knowledge_${picked.path}`})
            return picked
        } catch (error) {
            this.#log.write("route", {path: "knowledge_error", error: String(error)})
            return null
        }
    }

    // What a member's fast operations don't cover, done by the Team Lead's hands (the utility) on a fresh snapshot.
    async handOff(from: Member, task: Task, rest: string): Promise<void> {
        const utility = this.#members.find(member => member.role === "utility")
        const snapshot = await this.snapshot()
        if (utility === undefined || snapshot === null) {return}
        this.#log.write("by_hand", {from: from.agent, piece: rest})
        await utility.handle(this, {message: task.message, piece: rest, hints: null}, snapshot)
            .catch(error => this.say(utility.agent, `Something went wrong: ${String(error)}`))
    }

    // The slow path: the Team Lead replies and hands out pieces; the members work on them in parallel.
    async #lead(message: string, snapshot: Snapshot): Promise<void> {
        const missing = this.#gateway.missing("team_lead")
        if (missing !== null) {return this.say("agent:team_lead", `I can't plan that: ${missing}.`)}
        this.card({agent: "agent:team_lead", name: "Team lead", doing: "splitting it up…"})
        const plan = await lead(this.#gateway, this.modelLog(), snapshot, message, this.#members)
        this.#log.write("route", {path: "lead", plan})
        plan.members.filter(entry => entry.role === "utility")
            .forEach(({piece}) => this.#log.write("by_hand", {from: "agent:team_lead", piece}))
        this.card({agent: "agent:team_lead", name: "Team lead",
            doing: plan.members.length === 0 ? "idle" : `asked ${plan.members.map(entry => entry.role.replace(/_/g, " ")).join(", ")}`})
        this.say("agent:team_lead", plan.reply)
        await Promise.all(plan.members.map(({role, piece}) => {
            const member = this.#members.find(member => member.role === role)
            const task: Task = {message, piece, hints: null}
            return member?.handle(this, task, snapshot).catch(error =>
                this.report(member.agent, task, `Something went wrong with the ${member.name.toLowerCase()}'s part: ${String(error)}`, true))
        }))
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
