import {randomUUID} from "node:crypto"
import type {
    Actor, Apply, BackendToPage, ChangeEvent, MemberCard, PageToBackend, Plan, Snapshot, Status, When
} from "../../shared/protocol.ts"
import type {Gateway, ModelLog} from "./gateway.ts"
import {isRole, type Role, type Route, route} from "./router.ts"
import type {SessionLog} from "./sessionLog.ts"
import {MixEngineer} from "./members.ts"

// The backend half of the bus (TAKEDO_API.md, "Overview"), one per connected page: claims, plans, chat, routing.
// Talks to the page's adapter for state (snapshot queries) and to apply plans.

const ClaimMs = 30000
const Terminal: ReadonlyArray<Status["state"]> = ["applied", "dropped", "failed"]

export type Member = {
    readonly agent: Actor
    readonly name: string
    handle(context: Coordinator, message: string, route: Extract<Route, { path: "fast" }>, snapshot: Snapshot): Promise<void>
}

export class Coordinator {
    readonly #send: (message: BackendToPage) => void
    readonly #gateway: Gateway
    readonly #log: SessionLog
    readonly #claims = new Map<string, { holder: Actor, until: number }>()
    readonly #queries = new Map<number, (snapshot: Snapshot | null) => void>()
    readonly #requests = new Map<string, (status: Status) => void>()
    readonly #members: Partial<Record<Role, Member>> = {mix_engineer: new MixEngineer()}
    #nextQuery = 0
    #project: string | null = null

    constructor(send: (message: BackendToPage) => void, gateway: Gateway, log: SessionLog) {
        this.#send = send
        this.#gateway = gateway
        this.#log = log
    }

    receive(message: PageToBackend): void {
        switch (message.type) {
            case "project":
                this.#project = message.open ? (message.name ?? "untitled") : null
                this.#log.write("project", {open: message.open, name: message.name})
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

    snapshot(): Promise<Snapshot | null> {
        const id = ++this.#nextQuery
        return new Promise(resolve => {
            this.#queries.set(id, snapshot => {
                if (snapshot !== null) {this.#log.seen(snapshot.at.seq)}
                resolve(snapshot)
            })
            this.#send({type: "query", id, query: "snapshot"})
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

    // Sends a plan to the adapter; resolves with its terminal status. Requires the agent's claim on the plan's target.
    request(agent: Actor, plan: Plan, when: When, seq: number, reason: string,
            onStatus: (status: Status) => void = () => {}): Promise<Status> {
        const id = randomUUID()
        const claim = this.#claims.get(plan.ref)
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

    async #chat(text: string): Promise<void> {
        const line = {id: randomUUID(), t: Date.now(), from: "user" as Actor, text}
        this.#log.write("chat", line)
        this.#send({type: "chat", line})
        const mention = /^@(\w+)\s*/.exec(text)
        const addressed = mention !== null && isRole(mention[1]) ? mention[1] : null
        if (mention !== null && addressed === null) {
            return this.say("agent:team_lead", `There's no @${mention[1]} on the team.`)
        }
        const message = mention === null ? text : text.slice(mention[0].length)
        if (this.#project === null) {return this.say("agent:team_lead", "Open a project first.")}
        if (!this.#gateway.available("fast_path")) {
            return this.say("agent:team_lead", "I can't reach Jev: TYPESAFE_API_KEY isn't set in takedo/.env.")
        }
        const snapshot = await this.snapshot()
        if (snapshot === null) {return this.say("agent:team_lead", "Open a project first.")}
        const routed = await route(this.#gateway, this.modelLog(), snapshot, message, addressed)
        this.#log.write("route", routed)
        if (routed.path === "slow") {
            return this.say("agent:team_lead",
                "That needs several of us, or I'd have to ask you something. I can't plan that yet: the Team Lead's language model isn't connected.")
        }
        const member = this.#members[routed.member]
        if (member === undefined) {
            return this.say("agent:team_lead", `That's for the ${routed.member.replace(/_/g, " ")}, who isn't on the team yet.`)
        }
        await member.handle(this, message, routed, snapshot)
    }

    #change(event: ChangeEvent): void {
        this.#log.seen(event.seq)
        this.#log.write("change", event)
    }
}
