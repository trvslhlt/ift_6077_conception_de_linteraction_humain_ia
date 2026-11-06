import {randomUUID} from "node:crypto"
import {
    type Actor, type Apply, type BackendToPage, type ChangeEvent, type Detail, type MemberCard, type PageToBackend,
    type Plan, type Snapshot, type Status, target, type When
} from "../../shared/protocol.ts"
import type {Catalog} from "./catalog.ts"
import type {Gateway, ModelLog} from "./gateway.ts"
import {createTeam, type Member, type Task} from "./members.ts"
import {isRole, type Role, Roster, route} from "./router.ts"
import type {SessionLog} from "./sessionLog.ts"
import {lead, writeOverview} from "./teamLead.ts"

// The backend half of the bus (TAKEDO_API.md, "Overview"), one per connected page: claims, plans, chat, routing.
// Talks to the page's adapter for state (snapshot queries) and to apply plans.

const ClaimMs = 30000
const Terminal: ReadonlyArray<Status["state"]> = ["applied", "dropped", "failed"]

export class Coordinator {
    readonly #send: (message: BackendToPage) => void
    readonly #gateway: Gateway
    readonly #catalog: Catalog
    readonly #log: SessionLog
    readonly #claims = new Map<string, { holder: Actor, until: number }>()
    readonly #queries = new Map<number, (snapshot: Snapshot | null) => void>()
    readonly #requests = new Map<string, (status: Status) => void>()
    readonly #members: ReadonlyArray<Member>
    #nextQuery = 0
    #project: string | null = null
    #viewOpen = false
    #overview: "none" | "writing" | "done" = "none"   // for the open project; written once, refreshed on request

    constructor(send: (message: BackendToPage) => void, gateway: Gateway, catalog: Catalog, log: SessionLog) {
        this.#send = send
        this.#gateway = gateway
        this.#catalog = catalog
        this.#log = log
        this.#members = createTeam(catalog)
    }

    get gateway(): Gateway {return this.#gateway}

    // Tells the page who's on the team (the Team Lead first), for mentions and autocomplete.
    start(): void {
        this.#send({type: "team", members: [
            {role: "team_lead", name: "Team lead", area: "the front door: splits a direction among the team"},
            ...this.#members.map(({role, name, area, can}) => ({role, name, area: `${area}. So far: ${can}`}))]})
    }

    receive(message: PageToBackend): void {
        switch (message.type) {
            case "project":
                this.#project = message.open ? (message.name ?? "untitled") : null
                this.#overview = "none"
                this.#log.write("project", {open: message.open, name: message.name})
                this.#maybeOverview()
                return
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
            case "result":
                this.#queries.get(message.id)?.(message.snapshot)
                this.#queries.delete(message.id)
                return
            case "status":
                this.#log.write("status", message.status)
                this.#requests.get(message.status.request)?.(message.status)
                if (Terminal.includes(message.status.state)) {this.#requests.delete(message.status.request)}
                return
            case "change":
                this.#change(message.event)
                return
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

    // Claims are locks (TAKEDO_API.md, "Team"): granted one at a time; the first wins, others get the holder.
    claim(agent: Actor, refs: ReadonlyArray<string>, reason: string): { ok: true } | { ok: false, holder: Actor } {
        const now = Date.now()
        for (const ref of refs) {
            const claim = this.#claims.get(ref)
            if (claim !== undefined && claim.until > now && claim.holder !== agent) {return {ok: false, holder: claim.holder}}
        }
        refs.forEach(ref => this.#claims.set(ref, {holder: agent, until: now + ClaimMs}))
        this.#log.write("claim", {agent, refs, reason, until: now + ClaimMs})
        return {ok: true}
    }

    release(agent: Actor, refs: ReadonlyArray<string>): void {
        refs.forEach(ref => {if (this.#claims.get(ref)?.holder === agent) {this.#claims.delete(ref)}})
        this.#log.write("claim", {agent, refs, released: true})
    }

    // Sends a plan to the adapter; resolves with its terminal status. Requires the plan to be in the agent's area
    // (TAKEDO_API.md, "Team") and the agent's claim on its target.
    request(agent: Actor, plan: Plan, when: When, seq: number, reason: string,
            onStatus: (status: Status) => void = () => {}): Promise<Status> {
        const id = randomUUID()
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
        this.#log.write("request", request)
        return new Promise(resolve => {
            this.#requests.set(id, status => {
                onStatus(status)
                if (Terminal.includes(status.state)) {resolve(status)}
            })
            this.#send({type: "apply", request})
        })
    }

    say(agent: Actor, text: string): void {
        const line = {id: randomUUID(), t: Date.now(), from: agent, to: "user" as Actor, text}
        this.#log.write("chat", line)
        this.#send({type: "chat", line})
    }

    card(card: MemberCard): void {
        this.#log.write("card", card)
        this.#send({type: "card", card})
    }

    modelLog(): ModelLog {return entry => this.#log.write("model", entry)}

    // ---------- chat and routing ----------

    // @member: straight to it (with Jev's hints if it wants them). @team_lead: the Team Lead splits it. Otherwise Jev
    // routes: one member clearly needed gets it with the hints, anything else goes to the Team Lead.
    async #chat(text: string): Promise<void> {
        const line = {id: randomUUID(), t: Date.now(), from: "user" as Actor, text}
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
        if (named === "team_lead") {return this.#lead(message, snapshot)}
        const addressed = named === null ? null : this.#members.find(member => member.role === named)
        if (addressed === undefined) {
            return this.say("agent:team_lead", `The ${named!.replace(/_/g, " ")} isn't on the team yet.`)
        }
        if (addressed !== null && !addressed.wantsHints) {
            return addressed.handle(this, {message, piece: null, hints: null}, snapshot)
        }
        const missing = this.#gateway.missing("fast_path")
        if (missing !== null) {return this.say("agent:team_lead", `I can't reach Jev: ${missing}.`)}
        const routed = await route(this.#gateway, this.modelLog(), snapshot, message, addressed === null ? null : named as Role)
        this.#log.write("route", routed)
        if (routed.path === "slow") {return this.#lead(message, snapshot)}
        const member = this.#members.find(member => member.role === routed.member)
        if (member === undefined) {
            return this.say("agent:team_lead", `That's for the ${routed.member.replace(/_/g, " ")}, who isn't on the team yet.`)
        }
        await member.handle(this, {message, piece: null, hints: routed.hints}, snapshot)
    }

    // The slow path: the Team Lead replies and hands out pieces; the members work on them in parallel.
    async #lead(message: string, snapshot: Snapshot): Promise<void> {
        const missing = this.#gateway.missing("team_lead")
        if (missing !== null) {return this.say("agent:team_lead", `I can't plan that: ${missing}.`)}
        this.card({agent: "agent:team_lead", name: "Team lead", doing: "splitting it up…"})
        const roles = new Set(this.#members.map(member => member.role))
        const notOnTeam = Object.fromEntries(Object.entries(Roster).filter(([role]) => !roles.has(role))
            .map(([role, area]) => [role, area.split(";")[0]]))
        const plan = await lead(this.#gateway, this.modelLog(), snapshot, message, this.#members, notOnTeam)
        this.#log.write("route", {path: "lead", plan})
        plan.not_built.forEach(wish => this.#log.write("wish", wish))
        this.card({agent: "agent:team_lead", name: "Team lead",
            doing: plan.members.length === 0 ? "idle" : `asked ${plan.members.map(entry => entry.role.replace(/_/g, " ")).join(", ")}`})
        this.say("agent:team_lead", plan.reply)
        await Promise.all(plan.members.map(({role, piece}) => {
            const member = this.#members.find(member => member.role === role)
            const task: Task = {message, piece, hints: null}
            return member?.handle(this, task, snapshot).catch(error =>
                this.say(member.agent, `Something went wrong: ${String(error)}`))
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
    }
}
