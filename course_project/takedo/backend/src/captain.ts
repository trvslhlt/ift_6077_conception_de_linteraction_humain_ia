import {existsSync} from "node:fs"
import {createSdkMcpServer, getSessionInfo, query, type Query, tool} from "@anthropic-ai/claude-agent-sdk"
import type {CallToolResult} from "@modelcontextprotocol/sdk/types.js"
import {z} from "zod"
import type {Actor, Control, Genre, Plan, Snapshot} from "../../shared/protocol.ts"
import {type Anchor, type Direction, type Job, type Piece, type PieceKind, PieceKinds, type Step} from "./board.ts"
import type {Coordinator} from "./coordinator.ts"
import {performStep, projectFor} from "./members.ts"
import {type AgentState, Kinds, type Kind} from "./notebook.ts"
import {asChatLine, Inbox, replyProblem} from "./utility.ts"
import {Styles} from "./mixProfiles.ts"
import {genresIn} from "./soundStyles.ts"
import {ruleLine} from "./restyle.ts"
import {MaxControls, MaxTotalControls, memberActor, type MemberName, MemberNames, Members} from "./team.ts"

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
- control_moved: the producer moved, switched, picked or pressed one of the controls on your card.
- job_finished: a worker's report on a piece you handed out (or job_failed: it stopped with an error; job_failed_later: some of its edits failed after it reported).
- restarted: TakeDo was restarted; what was cut off.
With it: project (tracks with refs, tempo, playback.bar: where the playhead is now), notebook (its entries; "facts" holds the key, tempo, meter and each part's register), producer_changed (what the producer did in openDAW by hand since you last heard), coming_steps (timed edits not landed yet, with short ids, by the message they're for), jobs_running.

Tools:
- assign: hand one piece to a fresh worker. A worker can do anything openDAW supports and has the team's knowledge base of genres, sounds, effect chains and patterns. It starts with no memory of the conversation, so a piece stands alone, and it is one kind of change (kind): a drum pattern and the drums' crusher are two pieces (drums, effects). tracks: the refs it changes (none for tempo). goal: one sentence on where it ends up, as a listener would check it ("a lazy, swung boom-bap at soft velocities"), not how to get there. from_bar and to_bar: bars counted from where the playhead was when the producer's message arrived (project.playback.bar), 0 and 0 for now; a gradual change takes 8 to 16 bars, or what the producer said. steps: 1 for one change, more for a gradual one. keep: what must stay (the producer's own settings, the key, a part's register with its MIDI numbers), "" for nothing. Give independent parts to separate workers, which run at the same time: for a style change, typically drums, harmony and keys, bass, tempo, and master effects (character: tape, saturation, filtering), then style_mix for the parts' space and placement (reverb, delay, pan), which isn't a worker's piece. Never give two workers the same setting. A simple request is one piece. Hand out every part the message needs in this turn.
- adjust: change one mix control yourself, with no worker: a track's volume, pan or mute (or the master's volume), at once or ramped over beats. It lands within a second, where a worker takes several: use it whenever the request is just that ("drums down a bit", "mute the bass", "fade the pad out over 8 bars"), then reply. Only for a control the producer asked to change; never to restate or guard a value. Anything more (notes, sounds, effects, several steps at chosen bars) is a piece to assign.
- set_loop: the loop on over the timeline bars you give (it must include the playhead: project.playback.bar), or off, at once.
- cancel: take back what hasn't landed: steps (coming_steps), or a piece still being planned (its job id from jobs_running: the job stops and its steps go with it). Use it when the producer says stop, less, or changes their mind about something still coming; cancel the job when the piece is still running. To change one part of a plan still being made, cancel that part's job, then assign what replaces it: a piece assigned after cancelling a running job joins that job's plan and lands with the rest of it. What has landed stays; to undo it, assign a piece that changes it back.
- offer_control, remove_control: controls on your card, for the producer to steer without typing. Not everything is a dial: a dial for an amount between two ends (how far toward a style, how busy, how wet); a switch for one of two states (a part in or out, half-time or not); a choice for a few named options (sections to move between, variations of a part); a button for a one-shot the producer fires when they want it (a fill, a drop, a build into the next phrase); and a direct dial or switch, bound to parameters, when the producer wants something under their own hand ("give me a knob for the reverb", a mute switch for the hats): it sets them at once with no turn of yours, and several bound together make a macro. Whenever a producer_message starts a gradual change or a style direction, offer one dial for it in that same turn, before you reply, and mention it in a few words: its ends in the producer's words, meaning what moving it should change, and its value where your direction takes the project (a dial toward the style the producer asked for starts near its high end, not at 0). At most 3; remove one that no longer applies. Once a dial has two takes (the project before its direction, and its work landed), a move between them is played by code: the project glides to that point between the two versions (numbers in between, notes morphed, a part in one version only handing over at the middle), with no turn of yours. control_moved reaches you only before that (its direction's work still coming) or for a move past its ends: act on it like a direction, assigning a piece that takes what's still to come further toward the new position, in proportion to how far it moved; once that has landed it becomes the dial's new end. A choice picked or a button pressed always reaches you: act on it at once, as its meaning says (a fill lands on the next phrase's last bar, a section change on the next phrase).
- recall_take: takes are versions of the project kept under a dial's positions (the project before its direction, and its work once landed, at the position the dial had). Recalling one brings back what that dial's own directions changed since (notes, mix, effects, tempo), gliding over 4 bars, where rebuilding takes workers most of a minute; other dials' and messages' work stays. When it says a part's notes were changed by another direction too, assign the piece it describes for each, in the same turn.
- look: read-only JavaScript to inspect the project (an async function body, \`takedo\` in scope: project, snapshot()). Only when the summary doesn't answer what you need.
- remember, recall, forget: your notebook, kept on disk per project. Keep the producer's wishes and taste (note) and each direction and how it's split (plan).
- reply: what the producer reads in the chat, as in a chat with a bandmate mid-session: one or two short, plain sentences. For producer_message and control_moved, call it once after assigning, on what's happening and how it will sound (or why it can't). For job reports and restarts, reply only when the producer needs to know (a problem, or something they asked about that's now done); otherwise end the turn without it. No lists or markdown; no bar numbers, refs, dB values or device settings unless they asked; no caveats about not having heard it. Ask at most one short question, only when you need the answer. Nothing else you write is shown.

Your team (the producer sees them by name, and their cards in the team view): every piece goes to the member it lands with, by what it does to the music, not by instrument.
${MemberNames.map(member => `- ${member}: ${Members[member].area}; controls: ${Members[member].controls}.`).join("\n")}
A producer_message may come with lands_with: who the message most likely lands with and the control it merits, from a quick classifier; follow it unless the message plainly says otherwise. A direction for several members (a style, "bigger") is yours: split it into pieces, each to its member.
Controls tune a direction afterwards, and go on the card of the member it landed with (offer_control's card; yours for a style or a direction several members share). Not every direction gets one: never for a correction, an exact request or a plain level move. When lands_with names a control, offer that one; when it says unsure, it's the member's call: offer one of its_controls when the direction makes something new (a part, a melody, an effect, a sound) or is a matter of degree, in the same turn you assign it (a choice between versions needs the versions: ask the member for two or three); when the producer asks for a control, that one. At most ${MaxControls} on a card and ${MaxTotalControls} in all (a panel counts as one): remove one that no longer applies before adding another. A direction with several sides the producer will want to ride apart (a vintage master: wobble, crunch, tone) gets a panel: direct dials sharing a group, each bound to its own parameters once they exist (after its piece lands: its report gives the refs), with a switch bound to each effect's enabled (t3.fx1.enabled) to bypass it. An effect added for a message on its own already gets a panel by code, and so does a style by its template once its pieces land (the conductor's switch for the new drums, the mix engineer's master panel, the sound designer's character panel): offer only your own dial for the style.

Rules:
- project is the project as it is now: what has landed. A gradual change that has finished shows its end values (a tempo eased from 119 to 82 reads 82); that's the plan having worked, not a jump.
- "Keep going", "more", "go on" continue the latest direction: hand out its next stage (further along, over the next bars), building on what has landed. Don't ask whether to.
- producer_changed is the producer's own hand: keep it. Tell workers in their pieces to leave those settings as they are, unless the producer asked otherwise.
- Write everything pitched in the key in the notebook's facts, and keep each part in its role (a bass stays a bass); say so in the keep of pieces that write notes, giving registers with their MIDI numbers as facts has them (openDAW names C3 = MIDI 60).
- A worker's report says what it did; trust it. A failed piece: assign it again once, differently, or tell the producer what's in the way.
- The loop (project.playback.loop): while it's on, only its bars are heard. A gradual change still spans its 8 to 16 bars of playing, as the loop's passes: parts change in place, pass by pass, and a new part goes inside the loop. When a direction needs more room than the loop has (a longer form, parts that take turns), widen or move the loop, or turn it off, yourself with set_loop, first, before you assign anything, so every worker plans its part within the loop as it will be; say so in a few words in your reply. Never an arrange piece for the loop: workers run at the same time, and parts planned for the old loop come out too short or land out of place.
- You may change anything in the project (the loop, the tempo, tracks, devices) to do what the producer asks: act, don't ask permission. Ask only when what they want is unclear.
- Except the transport, which is the producer's: no piece plays, stops, records or moves the playhead, even when asked; tell the producer what to press instead. A new loop includes where the playhead is now.
- Nothing is deleted: "remove", "take out" or "lose" a part or effect means park it (the part muted with its instrument and effects switched off; an effect switched off), so a dial or a later request can bring it back and a recording keeps it. Say it's out, not deleted.
- A new part or a sound change: the workers have sampled instruments (basses, pianos, Rhodes, organs, guitars, strings, brass, pads, leads) as well as synths; say the sound you want in the goal ("a warm finger bass", "a dusty upright piano") so they pick one that fits the genre.
- The producer's corrections are kept (2026-11-26, the producer: apply them at once, but only corrections, never the experimental, exploratory combinations): when a message says something the team made is wrong ("too bright", "not sustained", "should never be a lead"), act on it, and call learn with the rule for next time, in that same turn; when they approve your fix ("much better"), learn the fix: the rule (it replaces the one you learned for that correction), and for a style with a template the part as the fix left it (its level, low and high cut, sound, register), read from the project. A request to try or add something is not a correction. producers_rules are the corrections kept so far: they hold over any template, entry or habit; put the ones a piece touches in its keep. Say in your reply, in a few words, what you'll remember.
- A style with a template (style_templates; 2026-11-26, the producer: style directions need much stricter defaults, sounds and melodies chosen piecemeal by separate workers didn't fit together): call restyle, once, with over_bars from how slowly the producer asked (0 for at once, 16 for "slowly"), then set the loop if needed, offer the dial, and reply. It does the drums, bass, chords, lead, tempo, master and mix; don't assign those pieces yourself. Assign on top only what the producer asked beyond the style ("with multiple melodic layers": a new layer whose goal follows the template's sounds and the producer's rules it gives back). The template is the producer's own choice of sounds, rhythm and tuning (a kept sound's effects are their tuning, not a fault): never second-guess a part it made. "Keep going" or "more" on a template direction calls restyle again (it changes only what isn't the template yet, and says what's already there), then the direction's remaining distance is the template's tempo and master, nothing else; if everything is there, say so. Only the producer's correction of a part restyle made ("the keys are too bright") is a piece on that part, as usual.
- A style without a template: a style's sound is new parts, not the old ones rewritten: the team has drum kits made of classic drum machines' samples (TR-808 for trap, TR-909 for house and techno, MPC60 and SP-12 for boom-bap, LinnDrum for 80s pop) and an 808 bass. The producer's own sounds come first (2026-11-26, the producer: they had kept drum kits, and a kit recipe came in sounding like a video game): workers find the kits, samples and instruments they kept for a style, so name the style in a piece's goal and leave the sound to the worker; name a machine only when the producer did. For a style change, the drums piece is "a new <style> kit, the producer's own first, playing a <style> groove from one bar, the old drums parked at that bar" (tracks: the old drums, so it can park them; steps 1: a kit comes in at once, on a phrase's first bar), and every pitched part whose sound isn't for the style gets the same (2026-11-26, the producer: a lofi session kept the 303 acid bass to the end, a filter "warming" it): code lists them in sounds_not_for_the_style, and each one's piece is "a new <style> <role> sound (a warm finger bass, an electric piano), the producer's own first, playing tN's notes, tN parked" (kind sound; tracks: that part, so it can park it; for a slow direction the new part fades in as the old fades out over the change's bars). A filter or effect on the old sound doesn't change what it is. For trap or drill the bass is an 808. Only when the producer asks to keep the sound (the same kit, "just the groove") does the old part change in place.
- A style change restyles the song, it doesn't replace it (2026-11-25, the producer: moving to a new style should keep melodies and note timings recognizable, or it feels like a tempo blend into another song). The style comes from the sound (kits, instruments), the feel (the drums' groove, swing, how notes are played), the chords' colour and the mix (effects, sends, pan); the music carries over. Say so in the keep of each piece on a pitched part that's there: "tN's notes and rhythm, in the new sound" for a bass line, riff, lead or melody (a new instrument taking it over plays those notes, moved by octaves into its register); "tN's chord roots and changes, recoloured for <style>" for chords (sevenths, ninths, the style's voicing and rhythm). The drums take the style's groove. The key, scale and time signature stay as they are, unless the producer asks or the direction needs it (a jazzy turn may need another scale; say so in your reply). The tempo stays where it is if the style's range allows, otherwise it goes only as far as the range's nearest end; a slower style over a fast tempo is a half-time feel (the drums' backbeat on 3, the tempo kept), never the tempo halved, which slows every part's notes. A part the style needs that isn't there yet is new. This is guidance, not a rule: what the producer asks for wins ("a new melody", "different chords").
- A new part (chords, a pad, a lead) gets a new track of its own: tracks ["new"], never an existing part's track; the worker makes the track as it writes the part.
- A style direction adds what the style needs as well as changing what's there: "lush" or "fuller" means parts and space added across the whole loop (a chord bed or pad heard from its first bar, reverb); thinning and softening every part at once empties the track.
- To take back one piece's steps, cancel that piece's (coming_steps says whose each step is); a piece that reported changing nothing has nothing to cancel.
- Keep turns short: decide, assign, reply. Your own bookkeeping (a cancel with nothing to cancel, a correction to what you said) isn't news for the producer.`

type Session = { inbox: Inbox, query: Query }
// What a turn is about: the producer's message (or a control move: the producer's too), or the team's own news.
// controls: the dials a control_moved turn is about (their moves are directions of theirs, in the ledger).
export type Turn = { kind: "producer_message" | "control_moved", text: string, history?: ReadonlyArray<{ from: string, text: string }>,
    controls?: string[] }
    | { kind: "job_finished" | "job_failed" | "job_failed_later" | "restarted", text: string, direction?: Direction }
// The turn being worked on: its direction (the producer's message's, or the job's it reports on) and anchor.
// revising: a job this turn cancelled while it was planning; the pieces assigned after it join its plan.
// before: the project, fully, as the producer's turn began (a take of it is kept if the turn offers a new dial).
type Current = { context: Coordinator, turn: Turn, direction: Direction, anchor: Anchor | null, calls: number, said?: string, revising?: string,
    before?: Promise<Snapshot | null> }

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
    #style: Genre | null = null
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
        // The style the producer is taking the song to: the last one a message of theirs named ("keep going" goes on with it).
        if (turn.kind === "producer_message") {
            // Or a template's own name ("reggaeton", "r&b").
            const plain = turn.text.toLowerCase().replace(/r ?(&|and|n) ?b\b/g, "rnb")
            const named = [...context.templates().keys()].find(style => new RegExp(`\\b${style}\\b`).test(plain))
            this.#style = genresIn(turn.text)[0] ?? named ?? this.#style
        }
        // A style with a template says each part's sound itself (it may keep the song's own bass).
        const against = producers && this.#style !== null && !context.templates().has(this.#style) ? context.soundsAgainst(this.#style, snapshot) : []
        const pending = {message: `${turn.kind}: ${turn.text}`, t: Date.now()}
        if (this.#sessionId !== null) {context.notebook?.setAgentState({session: this.#sessionId, pending})}
        // The producer's turns start a direction; the team's own news continue the one it's about.
        const direction = "direction" in turn && turn.direction !== undefined ? turn.direction
            : context.board.direction(turn.text, turn.kind === "control_moved")
        if (!this.#anchors.has(direction.id)) {this.#anchors.set(direction.id, anchorOf(snapshot))}
        if (turn.kind === "control_moved") {(turn.controls ?? []).forEach(ref => context.ledger.dial(ref, direction.id))}
        const current: Current = {context, turn, direction, anchor: this.#anchors.get(direction.id) ?? null, calls: 0,
            ...(turn.kind === "producer_message" ? {before: context.snapshot("full")} : {})}
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
            ...(context.takeLines().length > 0 ? {takes: context.takeLines()} : {}),
            project: projectFor(snapshot, false),
            ...(against.length > 0 ? {sounds_not_for_the_style: against} : {}),
            ...(turn.kind === "producer_message" && context.landsWith(turn.text) !== null ? {lands_with: context.landsWith(turn.text)} : {}),
            ...(producers ? {style_templates: [...context.templates()].map(([style, template]) => `${style}: ${template.about}`)} : {}),
            ...(producers ? {producers_rules: context.rules(this.#style === null ? [] : [this.#style]).map(ruleLine)} : {}),
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

    // The fast path for one mix control (decided 2026-11-24): the Team Lead's own edit, sent at once, so a small request
    // lands about a second after its decision instead of a worker's session later. Only what may() allows.
    // Its own edits: adjust (one mix control, checked there) and recalling a take (values, and one script).
    // add_effect and remove_effect: Jev's effect path acts in the Team Lead's name (fastpath.ts); its own tools don't ask for them.
    may(plan: Plan): boolean {return ["set", "ramp", "script", "add_effect", "remove_effect", "send"].includes(plan.op)}

    // The loop, set by the Team Lead itself before it hands out pieces (2026-11-24: an arrange piece widened it while
    // the other workers planned for the old one, and a keys part came out 4 bars long in a 16-bar loop).
    async #setLoop(current: Current, input: Record<string, unknown>): Promise<string> {
        const {context} = current
        const snapshot = await context.snapshot()
        if (snapshot === null) {return "Not done: no project is open."}
        const on = input.on === true
        const from = Math.max(1, Math.round(Number(input.from_bar))), to = Math.max(from, Math.round(Number(input.to_bar)))
        const code = on
            ? `const {loopArea} = project.timelineBox; loopArea.from.setValue(ppqn("${from}.1.1")); loopArea.to.setValue(ppqn("${to + 1}.1.1")); loopArea.enabled.setValue(true)`
            : "project.timelineBox.loopArea.enabled.setValue(false)"
        const description = on ? `loop over bars ${from}–${to}` : "loop off"
        const claimed = context.claim(this.agent, ["project.script"], current.turn.text)
        if (!claimed.ok) {return `Not done: ${claimed.holder.replace("agent:", "")} is running a script; try again in a moment.`}
        try {
            context.card({agent: this.agent, name: this.name, doing: description})
            const status = await context.request(this.agent, {op: "script", code, description}, {at: "asap"}, snapshot.at.seq, current.turn.text,
                () => {}, undefined, {direction: current.direction.id})
            return status.state === "applied" ? `Done: ${description}. Pieces you assign now see it.` : `Not done (${status.reason}): ${status.detail ?? ""}`
        } finally {
            context.release(this.agent, ["project.script"])
        }
    }

    async #adjust(current: Current, input: Record<string, unknown>): Promise<string> {
        const {context} = current
        const snapshot = await context.snapshot()
        if (snapshot === null) {return "Not done: no project is open."}
        const track = String(input.track), control = String(input.control)
        const found = snapshot.tracks.find(candidate => candidate.ref === track)
        if (track !== "master" && found === undefined) {return `Not done: no track ${track} (tracks: ${snapshot.tracks.map(t => `${t.ref} ${t.name}`).join(", ")}).`}
        if (track === "master" && control !== "volume") {return "Not done: only the master's volume is adjustable here; assign a piece for the rest."}
        const name = found?.name ?? "Master"
        const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, Number.isFinite(value) ? value : 0))
        const ref = `${track}.mix.${control}`
        const beats = control === "mute" ? 0 : clamp(Number(input.over_beats), 0, 256)
        const over = beats > 0 ? ` over ${beats} beats` : ""
        const {plan, says}: { plan: Plan, says: string } = control === "mute"
            ? Number(input.to) >= 0.5 ? {plan: {op: "set", ref, to: 1}, says: `${name} muted`} : {plan: {op: "set", ref, to: 0}, says: `${name} back in`}
            : control === "pan"
                ? {plan: {op: "ramp", ref, to: clamp(Number(input.to), -1, 1), beats}, says: `${name} panned to ${clamp(Number(input.to), -1, 1)}${over}`}
                : {plan: {op: "ramp", ref, to: clamp(Number(input.to), -60, 6), beats}, says: `${name} to ${clamp(Number(input.to), -60, 6).toFixed(1)} dB${over}`}
        context.card({agent: this.agent, name: this.name, doing: says})
        // A ramp's request ends when the ramp does: answer once it's under way, so the turn isn't held for its length.
        let started: (text: string) => void = () => {}
        const early = new Promise<string>(resolve => {started = resolve})
        const done = performStep(context, this.agent, {plan, when: {at: "asap"}, says, activity: {direction: current.direction.id}}, current.turn.text, status => {
            if (status.state === "running") {started(`${says}: under way.`)}
        })
        return Promise.race([early, done])
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
                member: z.enum(MemberNames).describe("The member it lands with: " + MemberNames.map(member => `${member}: ${Members[member].area}`).join("; ")),
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
                        keep: String(input.keep ?? ""), member: input.member as MemberName}
                    return direction === undefined ? current.context.assign(current.direction, current.anchor, piece)
                        : current.context.assign(direction, this.#anchors.get(direction.id) ?? current.anchor, piece)
                })),
            tool("adjust", "Change one mix control yourself, no worker: a track's volume, pan or mute, or the master's volume; at once or ramped over beats. Answers once it's under way.", {
                track: z.string().describe("A track's ref (\"t2\"), or \"master\" (volume only)"),
                control: z.enum(["volume", "pan", "mute"]),
                to: z.number().describe("volume: dB, -60 to +6 (the project's tracks show theirs); pan: -1 left to +1 right; mute: 1 muted, 0 playing"),
                over_beats: z.number().min(0).describe("0 for at once; else a ramp's length in beats (4 per bar in 4/4). Mute is always at once.")
            }, handler((current, input) => this.#adjust(current, input))),
            tool("set_loop", "Turn the loop on over timeline bars (first to last, inclusive; it must include the playhead), or off, at once. Before assigning pieces, so workers plan within it.", {
                on: z.boolean(), from_bar: z.number().int().min(1).describe("The loop's first bar (ignored when off)"),
                to_bar: z.number().int().min(1).describe("The loop's last bar, inclusive (bars 1 to 16: 16)")
            }, handler((current, input) => this.#setLoop(current, input))),
            tool("cancel", "Take back what hasn't landed yet: steps (coming_steps), or whole pieces still being planned (jobs_running: their steps with them).", {
                steps: z.array(z.string()).describe("Step ids from coming_steps, job ids from jobs_running (\"j3\"), or [\"all\"] for everything")},
                handler((current, input) => {
                    const ids = (input.steps as string[]).map(String)
                    const revising = ids.find(id => current.context.board.running().some(job => job.id === id))
                    if (revising !== undefined) {current.revising = revising}
                    return current.context.cancel(ids.includes("all") ? "all" : ids)
                })),
            tool("offer_control", "Put a control on your card in the team view (or change one you have: same name), for the producer to steer without typing. An intent control changes nothing by itself: its move reaches you (or, for a dial or switch between its two takes, is played by code). A direct one sets the parameters it's bound to at once, as the producer's own hand.", {
                name: z.string().regex(/^[a-z][a-z0-9_]{0,30}$/).describe("A short id, lower case (\"lofi_amount\")"),
                card: z.enum(["team_lead", ...MemberNames]).default("team_lead").describe("Whose card it goes on: the member the direction it tunes landed with; team_lead (yours) for a style or a direction several members share"),
                label: z.string().max(30).describe("What the producer reads on it, a word or two (\"Lofi\", \"Busy\")"),
                group: z.string().max(40).optional().describe("A panel's title: controls with the same group show together as one panel on the card and count as one control (up to 4 in a panel). For a direction with several sides the producer will ride separately: a Vintage panel of direct dials Wow (the tremolo's depth), Crunch (the crusher's crush), Tone (the EQ's top) and a switch bypassing it all"),
                widget: z.enum(["dial", "switch", "choice", "button"]).default("dial").describe("dial: an amount between two ends; switch: one of two states (a part in or out, half-time or not); choice: one of a few named options (sections, variations, kits); button: a one-shot the producer presses when they want it (a fill, a drop, a build into the next phrase)"),
                kind: z.enum(["intent", "direct"]).default("intent").describe("intent: a direction to you; direct: a dial or switch bound to parameters (bind), set instantly with no turn of yours (a macro knob for the reverb, a mute switch), for something the producer wants under their own hand"),
                low: z.string().max(30).default("").describe("dial, switch: its 0 end or off state, in the producer's words (\"clean\")"),
                high: z.string().max(30).default("").describe("dial, switch: its 1 end or on state (\"dusty tape\")"),
                options: z.array(z.string().max(24)).max(6).optional().describe("choice: 2 to 6 options, in order (\"verse\", \"chorus\", \"break\")"),
                bind: z.array(z.object({ref: z.string().describe("A parameter's ref: t2.mix.volume, t3.fx1.wet, master.mix.volume"),
                    from: z.number().describe("Its value at 0 (or off)"), to: z.number().describe("Its value at 1 (or on)")})).max(8).optional()
                    .describe("direct: the parameters it sets, each from its from to its to across the control (several make a macro)"),
                meaning: z.string().describe("What moving or pressing it should change, for yourself later: what changes, between which settings"),
                value: z.number().min(0).describe("Where it starts: a dial or switch where the direction you just assigned takes the project once it has landed, not how far it has got yet (asked for a lush lofi beat on a lofi dial: near 1); a choice, its option's index; a button, 0; a direct control, where its parameters are now"),
                before: z.number().min(0).max(1).optional().describe("An intent dial or switch for a direction you just assigned: where the project was before it, on this control (a lofi dial for a beat that wasn't lofi: 0). Its take is kept there, and moving the dial to it brings that project back: so its low end names what the song was (\"original\", \"acid house\"), never a lighter version of the direction (2026-11-26: a \"Lush\" dial, dry to lush, whose 0 was the song before the lofi change: moved to dry, the old drums came back)")},
                handler(async (current, input) => {
                    const ref = `c:${String(input.name)}`
                    const widget = input.widget as Control["widget"]
                    const kind = input.kind as Control["kind"]
                    const fresh = !current.context.controls().some(control => control.ref === ref)
                    // A direction that landed with one member is tuned on its card, even when the Team Lead names its own
                    // (2026-11-26: a vintage master panel went on the Team Lead's card); a style or a shared one is the Team Lead's.
                    const landed = current.context.landsWith(current.direction.text)?.member
                    const card = (input.card === undefined || input.card === "team_lead") && landed !== undefined && (MemberNames as readonly string[]).includes(landed)
                        ? landed : input.card
                    const owner: Actor = card === undefined || card === "team_lead" ? this.agent : memberActor(card as MemberName)
                    let said = current.context.offerControl(owner, {ref, kind, widget, label: String(input.label), low: String(input.low ?? ""),
                        ...(typeof input.group === "string" && input.group.trim() !== "" ? {group: input.group} : {}),
                        high: String(input.high ?? ""), meaning: String(input.meaning), value: Number(input.value),
                        ...(input.options !== undefined ? {options: (input.options as string[]).map(String)} : {}),
                        ...(input.bind !== undefined ? {bind: (input.bind as Array<{ ref: string, from: number, to: number }>)
                            .map(({ref, from, to}) => ({ref: String(ref), from: Number(from), to: Number(to)}))} : {})})
                    const placed = current.context.controls().find(control => control.ref === ref)
                    if (owner !== this.agent) {said = said.replace(/^On your card/, `On the ${Members[card as MemberName].name.toLowerCase()}'s card (not yours: say so)`)}
                    if (!fresh || placed === undefined) {return said}
                    current.context.ledger.dial(ref, current.direction.id)
                    // An intent dial's or switch's other end: the project before this direction, kept as a take.
                    if (kind !== "intent" || (widget !== "dial" && widget !== "switch") || current.before === undefined) {return said}
                    const before = input.before !== undefined && Number.isFinite(Number(input.before)) ? Math.min(1, Math.max(0, Number(input.before)))
                        : placed.value >= 0.5 ? 0 : 1
                    const id = await current.context.keepTake(ref, before, "the project before this direction", current.before)
                    return id === null ? said : `${said} Kept the project before this direction as take ${id}.`
                })),
            tool("set_transition", "How a part in only one of a dial's two versions comes and goes as the dial moves between them: handover (one plays until the middle, the other from there, the groove moving across; the default for drums and bass) or crossfade (both play in between, one fading as the other rises; the default for the rest). Use it when the producer asks for a part to blend or switch differently.", {
                name: z.string().describe("The dial's id (\"trap_amount\")"),
                track: z.string().describe("The part's track ref (t3)"),
                transition: z.enum(["handover", "crossfade"])},
                handler((current, input) => current.context.setTransition(this.agent, `c:${String(input.name)}`, String(input.track), input.transition as "handover" | "crossfade"))),
            tool("recall_take", "Bring the project back to a take (takes: versions kept under a dial's positions), gliding over the next 4 bars: notes, mix, effects and tempo as they were then; parts added since fade out.", {
                take: z.string().describe("A take's id (\"k2\")")}, handler((current, input) => current.context.recallTake(this.agent, String(input.take), current.turn.text, current.direction.id))),
            tool("restyle", "Take the song to a style by its template, all at once, by code: every part of a role the template has (drums, bass, chords, lead) moves onto the template's sound, register and rhythm, carrying its notes, or stays on its own sound with the template's tone when the template keeps it; chords the style needs are written if the song has none; tempo and the master go to workers with exact goals; the style's mix after. Answers with what it does and the template. For a style with a template, this is the whole direction: don't assign those parts yourself.", {
                style: z.string().describe("A style with a template: its name, before the colon in the turn's style_templates; the closest one to what the producer named (\"latin\" is reggaeton, \"hip hop\" boombap)"),
                over_bars: z.number().int().min(0).max(32).describe("Bars the old parts fade out over as the new ones fade in, the drums too; 0 for at once, 8 to 16 for a slow or gradual change")},
                handler((current, input) => current.context.restyle(current.direction, current.anchor, String(input.style), Number(input.over_bars) || 0))),
            tool("learn", "Keep a correction of the producer's for every session from now on, at once: a rule (and, when they approved a fix, the template part it changed). Only for corrections: something they said was wrong (too bright, choppy, never a lead, not sustained), or their approval of your fix of one. Never for exploratory requests (a new part, an effect to try, another style, a sound to swap in as an idea) nor for the team's own faults (a silent track).", {
                style: z.string().describe("The style the correction is about (lofi, dnb...), or \"\" when it holds for every style (\"a wash is never a lead\")"),
                role: z.enum(["drums", "bass", "chords", "lead", ""]).describe("The part it's about; \"\" for the whole song or the master"),
                rule: z.string().describe("What to do from now on, as an instruction for any worker: \"lofi keys are a Rhodes held as a pad, soft attack, never short hits\""),
                said: z.string().describe("The producer's own words this comes from, quoted exactly from their messages; several joined by \" / \""),
                part: z.object({sound: z.string().optional().describe("A sound id"), low: z.number().int().optional(), high: z.number().int().optional(),
                    rhythm: z.enum(["hold", "as played"]).optional(), velocity: z.number().optional(),
                    level_db: z.number().optional().describe("The part's level as the fix left it (the project's volume_db)"),
                    low_cut: z.number().optional().describe("Hz, as the fix left it; 20 for none"), high_cut: z.number().optional().describe("Hz; 20000 for none")}).optional()
                    .describe("Only when the producer approved a fix (\"much better\"): the style template's part as the fix made it")},
                handler((current, input) => {
                    if (!current.context.producerSaid(String(input.said))) {return "Not learned: those aren't the producer's words from this session. Quote them exactly."}
                    const part = input.part as { sound?: string, low?: number, high?: number, rhythm?: "hold" | "as played", velocity?: number,
                        level_db?: number, low_cut?: number, high_cut?: number } | undefined
                    const change = part === undefined ? null : {
                        ...(part.sound !== undefined ? {sound: part.sound} : {}), ...(part.rhythm !== undefined ? {rhythm: part.rhythm} : {}),
                        ...(part.velocity !== undefined ? {velocity: part.velocity} : {}), ...(part.level_db !== undefined ? {level_db: part.level_db} : {}),
                        ...(part.low_cut !== undefined || part.high_cut !== undefined ? {tone: {low_cut: part.low_cut ?? 20, high_cut: part.high_cut ?? 20000}} : {}),
                        ...(part.low !== undefined && part.high !== undefined ? {range: [part.low, part.high] as [number, number]} : {})}
                    return current.context.learn({style: input.style === "" ? null : String(input.style), role: input.role === "" ? null : input.role as "drums",
                        text: String(input.rule), said: String(input.said), date: new Date().toISOString().slice(0, 10)}, change)
                })),
            tool("style_mix", "Give the project a style's mix, by code: each part's pan, and how much it sends into a shared reverb and delay set up for that style (made the first time), by what it plays (drums, perc, bass, chords, pad, lead). It goes on once this direction's parts have landed, so new parts get their place too, every change gliding. Call it after assigning a style direction's pieces; it's cheaper and more consistent than an effects piece for the space and placement.", {
                style: z.enum(Styles as [string, ...string[]]).describe("The style whose mix this is: the nearest to the producer's")},
                handler((current, input) => current.context.styleMix(current.direction, String(input.style)))),
            tool("remove_control", "Take a control off its card (yours or a member's): its name, or a panel's title to take the whole panel.", {name: z.string()},
                handler((current, input) => current.context.removeControl(this.agent, String(input.name)))),
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
