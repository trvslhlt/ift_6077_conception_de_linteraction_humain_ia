import {existsSync} from "node:fs"
import {createSdkMcpServer, getSessionInfo, query, type Query, tool} from "@anthropic-ai/claude-agent-sdk"
import type {CallToolResult} from "@modelcontextprotocol/sdk/types.js"
import {z} from "zod"
import type {Actor, Snapshot} from "../../shared/protocol.ts"
import {type Anchor, type Direction, type Job, type Piece, type PieceKind, PieceKinds, type Step} from "./board.ts"
import type {Coordinator} from "./coordinator.ts"
import {projectFor} from "./members.ts"
import {type AgentState, Kinds, type Kind} from "./notebook.ts"
import {asChatLine, Inbox, replyProblem} from "./utility.ts"

// The captain (ARCHITECTURE.md, "The team's structure", decided 2026-11-22): the Team Lead the producer talks with. It
// works out what each message means for the work and hands pieces to workers (the utility in a fresh session per
// piece, run in parallel), cancels what's still coming when the producer changes their mind, offers controls, and
// replies. It never edits the project itself, so it can always answer. One long-lived Agent SDK session per project,
// kept on disk and resumed after a restart (its notebook's agent state says which).

const MaxCalls = 40
const MaxRecall = 40000
// A turn TakeDo was restarted in the middle of is picked back up if it's this recent; older, the model is only told.
const RecoverMs = 10 * 60000

const System = `You are the Team Lead of an AI music production team working live in openDAW (a web DAW) with a producer, usually while the track plays. The producer talks with you; speak as "I". You don't change the project yourself: you work out what each message means for the work and hand it to workers, who edit openDAW, and you keep track of what's going on. Your conversation carries on across messages (each brings a fresh project summary), but its older parts are summarized when it grows long: keep what you'll need later in your notebook.

Each turn brings one of:
- producer_message: something the producer said (with conversation, the chat before you joined, if any).
- control_moved: the producer moved one of the dials on your card.
- job_finished: a worker's report on a piece you handed out (or job_failed: it stopped with an error; job_failed_later: some of its edits failed after it reported).
- restarted: TakeDo was restarted; what was cut off.
With it: project (tracks with refs, tempo, playback.bar: where the playhead is now), notebook (its entries; "facts" holds the key, tempo, meter and each part's register), producer_changed (what the producer did in openDAW by hand since you last heard), coming_steps (timed edits not landed yet, with short ids, by the message they're for), jobs_running.

Tools:
- assign: hand one piece to a fresh worker. A worker can do anything openDAW supports and has the team's knowledge base of genres, sounds, effect chains and patterns. It starts with no memory of the conversation, so a piece stands alone, and it is one kind of change (kind): a drum pattern and the drums' crusher are two pieces (drums, effects). tracks: the refs it changes (none for tempo). goal: one sentence on where it ends up, as a listener would check it ("a lazy, swung boom-bap at soft velocities"), not how to get there. from_bar and to_bar: bars counted from where the playhead was when the producer's message arrived (project.playback.bar), 0 and 0 for now; a gradual change takes 8 to 16 bars, or what the producer said. steps: 1 for one change, more for a gradual one. keep: what must stay (the producer's own settings, the key, a part's register with its MIDI numbers), "" for nothing. Give independent parts to separate workers, which run at the same time: for a style change, typically drums, harmony and keys, bass, tempo, and master effects. Never give two workers the same setting. A simple request is one piece. Hand out every part the message needs in this turn.
- cancel: take back what hasn't landed: steps (coming_steps), or a piece still being planned (its job id from jobs_running: the job stops and its steps go with it). Use it when the producer says stop, less, or changes their mind about something still coming; cancel the job when the piece is still running. To change one part of a plan still being made, cancel that part's job, then assign what replaces it: a piece assigned after cancelling a running job joins that job's plan and lands with the rest of it. What has landed stays; to undo it, assign a piece that changes it back.
- offer_control, remove_control: dials on your card, for the producer to steer a direction that keeps going (how far toward a style, how busy, how wet) without typing. Whenever a producer_message starts a gradual change or a style direction, offer one dial for it in that same turn, before you reply, and mention it in a few words: its ends in the producer's words, meaning what moving it should change, and its value where your direction takes the project (a dial toward the style the producer asked for starts near its high end, not at 0). At most 3; remove one that no longer applies. When one moves (control_moved), act on it like a direction: assign a piece that moves what's still to come toward the new position, in proportion to how far it moved.
- look: read-only JavaScript to inspect the project (an async function body, \`takedo\` in scope: project, snapshot()). Only when the summary doesn't answer what you need.
- remember, recall, forget: your notebook, kept on disk per project. Keep the producer's wishes and taste (note) and each direction and how it's split (plan).
- reply: what the producer reads in the chat, as in a chat with a bandmate mid-session: one or two short, plain sentences. For producer_message and control_moved, call it once after assigning, on what's happening and how it will sound (or why it can't). For job reports and restarts, reply only when the producer needs to know (a problem, or something they asked about that's now done); otherwise end the turn without it. No lists or markdown; no bar numbers, refs, dB values or device settings unless they asked; no caveats about not having heard it. Ask at most one short question, only when you need the answer. Nothing else you write is shown.

Rules:
- project is the project as it is now: what has landed. A gradual change that has finished shows its end values (a tempo eased from 119 to 82 reads 82); that's the plan having worked, not a jump.
- "Keep going", "more", "go on" continue the latest direction: hand out its next stage (further along, over the next bars), building on what has landed. Don't ask whether to.
- producer_changed is the producer's own hand: keep it. Tell workers in their pieces to leave those settings as they are, unless the producer asked otherwise.
- Write everything pitched in the key in the notebook's facts, and keep each part in its role (a bass stays a bass); say so in the keep of pieces that write notes, giving registers with their MIDI numbers as facts has them (openDAW names C3 = MIDI 60).
- A worker's report says what it did; trust it. A failed piece: assign it again once, differently, or tell the producer what's in the way.
- The loop (project.playback.loop): while it's on, only its bars are heard. A gradual change still spans its 8 to 16 bars of playing, as the loop's passes: parts change in place, pass by pass, and a new part goes inside the loop. When a direction needs more room than the loop has (a longer form, parts that take turns), widen or move the loop, or turn it off, yourself: an arrange piece, said in a few words in your reply.
- You may change anything in the project (the loop, the tempo, tracks, devices) to do what the producer asks: act, don't ask permission. Ask only when what they want is unclear.
- Except the transport, which is the producer's: no piece plays, stops, records or moves the playhead, even when asked; tell the producer what to press instead. A new loop includes where the playhead is now.
- A new part (chords, a pad, a lead) gets a new track of its own: tracks ["new"], never an existing part's track; the worker makes the track as it writes the part.
- A style direction adds what the style needs as well as changing what's there: "lush" or "fuller" means parts and space added across the whole loop (a chord bed or pad heard from its first bar, reverb); thinning and softening every part at once empties the track.
- To take back one piece's steps, cancel that piece's (coming_steps says whose each step is); a piece that reported changing nothing has nothing to cancel.
- Keep turns short: decide, assign, reply. Your own bookkeeping (a cancel with nothing to cancel, a correction to what you said) isn't news for the producer.`

type Session = { inbox: Inbox, query: Query }
// What a turn is about: the producer's message (or a control move: the producer's too), or the team's own news.
export type Turn = { kind: "producer_message" | "control_moved", text: string, history?: ReadonlyArray<{ from: string, text: string }> }
    | { kind: "job_finished" | "job_failed" | "job_failed_later" | "restarted", text: string, direction?: Direction }
// The turn being worked on: its direction (the producer's message's, or the job's it reports on) and anchor.
// revising: a job this turn cancelled while it was planning; the pieces assigned after it join its plan.
type Current = { context: Coordinator, turn: Turn, direction: Direction, anchor: Anchor | null, calls: number, said?: string, revising?: string }

const text = (value: string): CallToolResult => ({content: [{type: "text", text: value}]})
const anchorOf = (snapshot: Snapshot): Anchor | null => snapshot.playback.position === undefined ? null
    : {position: snapshot.playback.position, played: snapshot.playback.played, bar: snapshot.playback.bar}

export class Captain {
    readonly agent: Actor = "agent:team_lead"
    readonly name = "Team lead"
    readonly #source: string
    #session: Session | null = null
    #sessionId: string | null = null
    #resumed = false
    #okTurns = 0
    #current: Current | null = null
    #queue: Promise<void> = Promise.resolve()
    #unheard: string[] = []
    #handSeen = 0
    #reconciled: { coming: Step[], lost: Step[], jobs: Job[] } | null = null
    // Anchors of directions this session, so a job's follow-up pieces count bars from the same place.
    readonly #anchors = new Map<string, Anchor | null>()

    // source: openDAW's source tree, the session's working directory (as the utility's, so sessions are found).
    constructor(source: string) {this.#source = source}

    notice(text: string): void {this.#unheard.push(text)}

    close(): void {
        this.#session?.inbox.close()
        this.#session?.query.close()
        this.#session = null
        this.#sessionId = null
    }

    // The board after (re)connecting: steps still coming and lost, and jobs cut off.
    reconciled(coming: Step[], lost: Step[], jobs: Job[]): void {
        this.#reconciled = coming.length + lost.length + jobs.length === 0 ? null : {coming, lost, jobs}
    }

    #boardNote(): string {
        const reconciled = this.#reconciled
        this.#reconciled = null
        if (reconciled === null) {return ""}
        const list = (steps: Step[]) => steps.map(step => `${step.says} (bar ${step.bar}${step.detail !== undefined ? `, ${step.detail}` : ""})`).join("; ")
        return [reconciled.coming.length > 0 ? `Timed edits still coming as planned: ${list(reconciled.coming)}.` : "",
            reconciled.lost.length > 0 ? `Timed edits that won't land: ${list(reconciled.lost)}.` : "",
            reconciled.jobs.length > 0 ? `Jobs cut off (their workers are gone; what they had sent stands): ${reconciled.jobs.map(job => `${job.id}: ${job.piece}`).join("; ")}.` : ""]
            .filter(line => line !== "").join(" ")
    }

    // The project just opened (also after a restart): a turn the last session was in the middle of is finished now,
    // and jobs that were cut off are reported, so they can be handed out again.
    async recover(context: Coordinator): Promise<void> {
        const notebook = context.notebook
        if (notebook === null) {return}
        // A round trip to the page first: it says which edits are still waiting before it answers (the board).
        const snapshot = await context.snapshot()
        const state = notebook.agentState()
        const jobsCut = (this.#reconciled?.jobs.length ?? 0) > 0
        const board = this.#boardNote()
        if (state?.pending != null) {
            const {message, t} = state.pending
            notebook.setAgentState({...state, pending: null})
            const recent = Date.now() - t < RecoverMs
            context.event("agent_session", {recover: message, recent})
            this.#unheard.push(`TakeDo restarted while you were working on: ${message}. Your last tool call may not have finished.${board === "" ? "" : ` ${board}`} ${recent
                ? "Finish it now: check coming_steps and jobs_running, and don't hand out again what's already done or coming."
                : "That was a while ago: don't pick it up unless the producer asks."}`)
            if (!recent || snapshot === null) {return}
            context.say(this.agent, "I got restarted partway through that; picking it back up.")
            return this.handle(context, {kind: "producer_message", text: message.replace(/^producer_message: /, "")}, snapshot)
        }
        // No turn was cut off, but jobs were: a turn of its own, so they can be handed out again.
        if (jobsCut && snapshot !== null) {return this.handle(context, {kind: "restarted", text: board}, snapshot)}
        if (board !== "") {this.#unheard.push(board)}
    }

    // A turn built when its time comes (control moves and job reports, coalesced: only what's new by then is told);
    // null from build: nothing left to tell.
    later(context: Coordinator, build: () => Promise<{ turn: Turn, snapshot: Snapshot } | null>): Promise<void> {
        const next = this.#queue.then(async () => {
            const built = await build()
            if (built !== null) {await this.#work(context, built.turn, built.snapshot)}
        })
        this.#queue = next.catch(() => {})
        return next
    }

    // One turn at a time: they share the session.
    handle(context: Coordinator, turn: Turn, snapshot: Snapshot): Promise<void> {
        const next = this.#queue.then(() => this.#work(context, turn, snapshot))
        this.#queue = next.catch(() => {})   // the caller hears of it
        return next
    }

    async #work(context: Coordinator, turn: Turn, snapshot: Snapshot): Promise<void> {
        context.card({agent: this.agent, name: this.name, doing: "thinking…"})
        const opening = this.#session === null
        const stored = opening ? await this.#stored(context) : null
        const fresh = opening && stored === null
        const session = this.#session ?? (this.#session = this.#open(context, stored?.session))
        if (opening) {
            this.#resumed = stored !== null
            this.#okTurns = 0
            this.#sessionId = stored?.session ?? null
            context.event("agent_session", {session: this.#sessionId, resumed: stored !== null, agent: this.agent})
        }
        const producers = turn.kind === "producer_message" || turn.kind === "control_moved"
        const pending = {message: `${turn.kind}: ${turn.text}`, t: Date.now()}
        if (this.#sessionId !== null) {context.notebook?.setAgentState({session: this.#sessionId, pending})}
        // The producer's turns start a direction; the team's own news continue the one it's about.
        const direction = "direction" in turn && turn.direction !== undefined ? turn.direction
            : context.board.direction(turn.text, turn.kind === "control_moved")
        if (!this.#anchors.has(direction.id)) {this.#anchors.set(direction.id, anchorOf(snapshot))}
        const current: Current = {context, turn, direction, anchor: this.#anchors.get(direction.id) ?? null, calls: 0}
        this.#current = current
        const board = this.#boardNote()
        if (board !== "") {this.#unheard.push(board)}
        const {lines: hand, next} = context.handChanges(this.#handSeen)
        this.#handSeen = next
        const outstanding = context.board.outstanding()
        const running = context.board.running()
        session.inbox.push(JSON.stringify({
            ...(fresh && "history" in turn && turn.history !== undefined && turn.history.length > 0 ? {conversation: turn.history} : {}),
            ...(this.#unheard.length > 0 ? {since_you_last_heard: this.#unheard.splice(0)} : {}),
            [turn.kind]: turn.text,
            ...(hand.length > 0 ? {producer_changed: hand} : {}),
            ...(outstanding.length > 0 ? {coming_steps: outstanding.map(({direction, steps}) => ({for: direction?.text ?? "?",
                steps: steps.map(step => `${step.id.slice(0, 8)}: ${step.says} (${step.job !== undefined ? `${step.job}'s, ` : ""}bar ${step.bar}, ${step.state === "staged" ? "being planned" : "waiting"})`)}))} : {}),
            ...(running.length > 0 ? {jobs_running: running.map(job => `${job.id}: ${job.piece}`)} : {}),
            project: projectFor(snapshot, false),
            notebook: context.notebook?.list() ?? []
        }))
        try {
            const result = await this.#turn(context, session, pending)
            this.#okTurns++
            if (this.#sessionId !== null) {context.notebook?.setAgentState({session: this.#sessionId, pending: null})}
            const said = current.said ?? (producers ? asChatLine(result) : "")
            if (said !== "") {context.say(this.agent, said)}
            const jobs = context.board.running()
            context.card({agent: this.agent, name: this.name, doing: jobs.length > 0 ? `${jobs.length} job${jobs.length > 1 ? "s" : ""} running` : "idle"})
        } catch (error) {
            const id = this.#sessionId
            if (id !== null) {context.notebook?.setAgentState(this.#resumed && this.#okTurns === 0 ? null : {session: id, pending: null})}
            this.close()
            throw error
        } finally {
            this.#current = null
        }
    }

    // Reads the session until this turn ends; logged like a model call (the cost is the session's running total).
    async #turn(context: Coordinator, session: Session, pending: AgentState["pending"]): Promise<string> {
        const {model} = context.gateway.agent("captain")
        while (true) {
            const next = await session.query.next()
            if (next.done === true) {throw new Error("the captain's session ended")}
            const message = next.value
            if (this.#sessionId === null && "session_id" in message && typeof message.session_id === "string") {
                this.#sessionId = message.session_id
                context.notebook?.setAgentState({session: message.session_id, pending})
                context.event("agent_session", {session: message.session_id, resumed: false, agent: this.agent})
            }
            if (message.type !== "result") {continue}
            const {usage} = message
            context.modelLog()({job: "captain", provider: "anthropic", model, ms: message.duration_ms, session: message.session_id,
                inputTokens: usage.input_tokens, outputTokens: usage.output_tokens,
                cacheRead: usage.cache_read_input_tokens, cacheWrite: usage.cache_creation_input_tokens,
                turns: message.num_turns, costUsd: message.total_cost_usd, agent: this.agent,
                ...(message.subtype === "success" && !message.is_error ? {} : {error: message.subtype === "success"
                    ? message.result : `${message.subtype}: ${message.errors.join("; ")}`})})
            if (message.subtype !== "success") {throw new Error(`${message.subtype}: ${message.errors.join("; ")}`)}
            if (message.is_error) {throw new Error(message.result)}
            return message.result
        }
    }

    async #stored(context: Coordinator): Promise<AgentState | null> {
        const state = context.notebook?.agentState() ?? null
        if (state === null) {return null}
        const found = await getSessionInfo(state.session, {dir: this.#cwd()}).catch(() => undefined)
        if (found === undefined) {context.notebook?.setAgentState(null)}
        return found === undefined ? null : state
    }

    #cwd(): string {return existsSync(this.#source) ? this.#source : process.cwd()}

    #open(context: Coordinator, resume?: string): Session {
        const {model, effort} = context.gateway.agent("captain")
        const handler = (run: (current: Current, input: Record<string, unknown>) => Promise<string> | string) =>
            async (input: Record<string, unknown>): Promise<CallToolResult> => {
                const current = this.#current
                if (current === null) {return text("No turn is being worked on.")}
                if (++current.calls > MaxCalls) {return text(`Not run: that's ${MaxCalls} calls this turn. Reply now, or end the turn.`)}
                return text(await run(current, input))
            }
        const tools = [
            tool("assign", "Hand one piece of the work to a fresh worker, which runs at the same time as the others. Answers at once; its report comes back as job_finished.", {
                kind: z.enum(Object.keys(PieceKinds) as [PieceKind, ...PieceKind[]]).describe(Object.entries(PieceKinds).map(([kind, about]) => `${kind}: ${about}`).join("; ")),
                tracks: z.array(z.string()).describe("Track refs it changes (t1, master); [\"new\"] for a new part on its own track; [] for tempo"),
                goal: z.string().describe("One sentence: where it ends up, as a listener would check it"),
                from_bar: z.number().int().describe("First bar, counted from the playhead at the producer's message; 0 for now"),
                to_bar: z.number().int().describe("Last bar; 0 for now, the same as from_bar for one change"),
                steps: z.number().int().describe("1 for one change, more for a gradual one"),
                keep: z.string().describe("What must stay: the producer's settings, the key, a part's register with MIDI numbers; \"\" for nothing"),
                with: z.string().optional().describe("A job id (jobs_running): this piece joins that job's plan, counting bars from the same place and landing together with it. Left out: a new direction, or, after you cancel a running job this turn, that job's plan")},
                handler((current, input) => {
                    const joins = typeof input.with === "string" ? input.with : current.revising
                    const job = joins === undefined ? undefined : current.context.board.jobOf(joins)
                    const direction = job === undefined ? undefined : current.context.board.directionOf(job.direction)
                    if (input.with !== undefined && direction === undefined) {return `Not started: no job ${String(input.with)}. Leave out with for a new direction.`}
                    const piece: Piece = {kind: input.kind as PieceKind, tracks: (input.tracks ?? []) as string[], goal: String(input.goal),
                        from_bar: Number(input.from_bar) || 0, to_bar: Number(input.to_bar) || 0, steps: Math.max(1, Number(input.steps) || 1),
                        keep: String(input.keep ?? "")}
                    return direction === undefined ? current.context.assign(current.direction, current.anchor, piece)
                        : current.context.assign(direction, this.#anchors.get(direction.id) ?? current.anchor, piece)
                })),
            tool("cancel", "Take back what hasn't landed yet: steps (coming_steps), or whole pieces still being planned (jobs_running: their steps with them).", {
                steps: z.array(z.string()).describe("Step ids from coming_steps, job ids from jobs_running (\"j3\"), or [\"all\"] for everything")},
                handler((current, input) => {
                    const ids = (input.steps as string[]).map(String)
                    const revising = ids.find(id => current.context.board.running().some(job => job.id === id))
                    if (revising !== undefined) {current.revising = revising}
                    return current.context.cancel(ids.includes("all") ? "all" : ids)
                })),
            tool("offer_control", "Put a dial on your card in the team view (or change one you have: same name), for the producer to steer a direction that keeps going. It changes nothing by itself.", {
                name: z.string().regex(/^[a-z][a-z0-9_]{0,30}$/).describe("A short id, lower case (\"lofi_amount\")"),
                label: z.string().max(30).describe("What the producer reads on it, a word or two (\"Lofi\", \"Busy\")"),
                low: z.string().max(30).describe("Its 0 end, in the producer's words (\"clean\")"),
                high: z.string().max(30).describe("Its 1 end (\"dusty tape\")"),
                meaning: z.string().describe("What moving it should change, for yourself later: what changes, between which settings"),
                value: z.number().min(0).max(1).describe("Where it starts: where the direction you just assigned takes the project (asked for a lush lofi beat on a lofi dial: near 1), so moving it means more or less than that")},
                handler((current, input) => current.context.offerControl(this.agent, {ref: `c:${String(input.name)}`,
                    label: String(input.label), low: String(input.low), high: String(input.high), meaning: String(input.meaning),
                    value: Number(input.value)}))),
            tool("remove_control", "Take a dial off your card.", {name: z.string()},
                handler((current, input) => current.context.removeControl(this.agent, `c:${String(input.name).replace(/^c:/, "")}`))),
            tool("look", "Run read-only JavaScript (an async function body, `takedo` in scope) and see what it returns.", {
                code: z.string()}, handler(async (current, input) => {
                    const {ok, value} = await current.context.look(this.agent, String(input.code))
                    return ok ? value : `Error: ${value}`
                }), {annotations: {readOnlyHint: true}}),
            tool("remember", "Keep something in your notebook, outside your conversation: replaces the entry with that key.", {
                key: z.string(), kind: z.enum(Kinds), summary: z.string().describe("One line, shown with every turn"),
                value: z.string()}, handler((current, input) => {
                    const notebook = current.context.notebook
                    if (notebook === null) {return "No project is open."}
                    notebook.set(String(input.key), String(input.kind) as Kind, String(input.summary), String(input.value))
                    return `Kept as "${String(input.key)}".`
                })),
            tool("recall", "Read a notebook entry's content.", {key: z.string()}, handler((current, input) => {
                const entry = current.context.notebook?.get(String(input.key)) ?? null
                if (entry === null) {return `No entry "${String(input.key)}".`}
                return entry.value.length > MaxRecall ? `${entry.value.slice(0, MaxRecall)}\n… (cut)` : entry.value
            }), {annotations: {readOnlyHint: true}}),
            tool("forget", "Delete a notebook entry.", {key: z.string()}, handler((current, input) =>
                current.context.notebook?.delete(String(input.key)) === true ? `Forgot "${String(input.key)}".` : `No entry "${String(input.key)}".`)),
            tool("reply", "What the producer reads in the chat: one or two short, plain sentences.", {text: z.string()},
                handler((current, input) => {
                    const said = String(input.text).trim()
                    const problem = replyProblem(said)
                    if (problem !== null) {return `Not sent: ${problem}. Call reply again.`}
                    current.said = said
                    return "Sent. End your turn now."
                }))
        ]
        const inbox = new Inbox()
        return {inbox, query: query({prompt: inbox, options: {
            model, ...(effort !== undefined ? {effort} : {}),
            systemPrompt: System,
            cwd: this.#cwd(),
            ...(resume !== undefined ? {resume} : {}),
            tools: [],
            allowedTools: ["mcp__takedo__*"],
            permissionMode: "dontAsk",
            mcpServers: {takedo: createSdkMcpServer({name: "takedo", tools, alwaysLoad: true})},
            settingSources: [],
            env: {...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "takedo"},
            stderr: data => console.error(`[captain] ${data.trimEnd()}`)
        }})}
    }
}
