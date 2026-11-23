import {randomUUID} from "node:crypto"
import {readFileSync, writeFileSync} from "node:fs"
import type {Actor, Snapshot, Status} from "../../shared/protocol.ts"

// The board (ARCHITECTURE.md, "The team's structure"): the team's shared state as data, kept by code, read and
// written by agents through their tools. First piece (2026-11-22): directions, for now one per producer message or
// control move, and their staged steps.
//
// A timed edit is staged here, not sent. When the agent's turn ends, its direction's steps go out together, timed from
// one anchor (commitAnchor), so they land in their bars' order however long the plan took to write. Only the page
// times them (Adapter.#landing); the backend doesn't predict when an edit lands.
//
// Kept with the project (beside its notebook), each sent step linked to the request carrying it out: after a backend
// restart the page says which requests are still waiting (they keep waiting through it), so the board knows what's
// still coming, what landed meanwhile and what was lost, and the resumed agent is told rather than planning it again.

export type Direction = { id: string, text: string, t: number, control: boolean }
// What a step does, as data, so it can be carried out later (and, later still, kept with the project): one of the
// members' fixed operations with its input, or a script.
export type Action = { op: string, input: Record<string, unknown> } | { script: string, description: string }
// sent: handed to the page, its request not heard of yet; waiting: for its bar or under way; lost: the page doesn't
// have it (it was reloaded) or it was staged when its turn was cut off.
export type StepState = "staged" | "sent" | "waiting" | "landed" | "failed" | "lost"
export type Step = { id: string, direction: string, agent: Actor, bar: number, says: string, action: Action,
    state: StepState, t: number, request?: string, detail?: string }
const Open: ReadonlyArray<StepState> = ["sent", "waiting"]

// Edits one bar takes in a gradual change; a step past it is refused (2026-11-22: a note alone didn't hold, four edits
// on bar 12, a tempo step and three effects).
export const MaxPerBar = 3

export class Board {
    readonly #log: (data: object) => void
    readonly #directions = new Map<string, Direction>()
    #steps: Step[] = []
    #file: string | null = null

    constructor(log: (data: object) => void) {this.#log = log}

    // The open project's board, from its file (none: an empty board, kept in memory).
    open(file: string | null): void {
        this.clear()
        this.#file = file
        if (file === null) {return}
        try {
            const stored = JSON.parse(readFileSync(file, "utf8")) as { directions: Direction[], steps: Step[] }
            stored.directions.forEach(direction => this.#directions.set(direction.id, direction))
            this.#steps = stored.steps
        } catch {/* a new project, or an unreadable file: start empty */}
    }

    #save(): void {
        if (this.#file === null) {return}
        writeFileSync(this.#file, JSON.stringify({directions: [...this.#directions.values()], steps: this.#steps}))
    }

    direction(text: string, control = false): Direction {
        const direction = {id: randomUUID(), text, t: Date.now(), control}
        this.#directions.set(direction.id, direction)
        this.#log({event: "direction", ...direction})
        this.#save()
        return direction
    }

    // Steps of a direction on a bar, staged or sent.
    count(direction: string, bar: number): number {
        return this.#steps.filter(step => step.direction === direction && step.bar === bar).length
    }

    // A step for later, or the reason it's refused.
    // limit: steps the bar may hold (a knowledge entry's, checked as a whole, may go over).
    stage(direction: string, agent: Actor, bar: number, says: string, action: Action,
          limit = MaxPerBar): { ok: true, step: Step } | { ok: false, reason: string } {
        if (this.count(direction, bar) >= limit) {
            return {ok: false, reason: `bar ${bar} already has ${MaxPerBar} edits in this plan, the most one bar takes in a gradual change. Put this on another bar`}
        }
        const step: Step = {id: randomUUID(), direction, agent, bar, says, action, state: "staged", t: Date.now()}
        this.#steps.push(step)
        this.#log({event: "staged", id: step.id, direction, agent, bar, says})
        this.#save()
        return {ok: true, step}
    }

    staged(direction: string): Step[] {return this.#steps.filter(step => step.direction === direction && step.state === "staged")}

    // The direction's staged steps, in bar order, marked sent: the caller carries them out.
    take(direction: string): Step[] {
        const steps = this.staged(direction).sort((a, b) => a.bar - b.bar)
        steps.forEach(step => {step.state = "sent"})
        if (steps.length > 0) {this.#log({event: "sent", direction, steps: steps.map(step => step.id)})}
        this.#save()
        return steps
    }

    // A direction's staged steps dropped (its turn failed).
    drop(direction: string): number {
        const dropped = this.staged(direction)
        this.#steps = this.#steps.filter(step => !dropped.includes(step))
        if (dropped.length > 0) {this.#log({event: "dropped", direction, steps: dropped.map(step => step.id)})}
        this.#save()
        return dropped.length
    }

    // The request carrying a step out (Coordinator.request).
    link(stepId: string, request: string): void {
        const step = this.#steps.find(candidate => candidate.id === stepId)
        if (step === undefined) {return}
        step.request = request
        this.#log({event: "linked", step: stepId, request})
        this.#save()
    }

    // A request's status, if it carries a step: live, or delivered after a restart.
    status(status: Status): void {
        const step = this.#steps.find(candidate => candidate.request === status.request)
        if (step === undefined) {return}
        const state: StepState = status.state === "applied" ? "landed"
            : status.state === "failed" || status.state === "dropped" ? "failed" : "waiting"
        if (state === step.state) {return}
        step.state = state
        if (state === "failed") {step.detail = status.detail ?? status.reason ?? status.state}
        this.#save()
    }

    // After a restart: the page's requests still waiting. A step sent but not among them, and not heard of since, is
    // lost; a step staged when its turn was cut off is too (it was never sent). Returns what's still coming and lost.
    reconcile(waiting: ReadonlyArray<string>): { coming: Step[], lost: Step[] } {
        const coming: Step[] = [], lost: Step[] = []
        this.#steps.forEach(step => {
            if (step.state === "staged" || (Open.includes(step.state) && (step.request === undefined || !waiting.includes(step.request)))) {
                step.detail = step.state === "staged" ? "never sent: its turn was cut off" : "the page no longer has it"
                step.state = "lost"
                lost.push(step)
            } else if (Open.includes(step.state)) {
                step.state = "waiting"
                coming.push(step)
            }
        })
        // gone: sent, but the page no longer has them (the bad kind; never sent is expected when a turn is cut off).
        this.#log({event: "reconciled", coming: coming.map(step => step.id), lost: lost.map(step => step.id),
            gone: lost.filter(step => step.request !== undefined).map(step => step.id)})
        this.#save()
        return {coming, lost}
    }

    // Steps still to land, across directions.
    coming(): Step[] {return this.#steps.filter(step => Open.includes(step.state))}

    clear(): void {
        this.#directions.clear()
        this.#steps = []
        this.#file = null
    }
}

// Where the playhead was when the message arrived (the bars in the project summary count from there).
export type Anchor = { position: number, played: number, bar: number }

// The anchor a plan is sent with: the message's, moved later past the playhead now, by whole passes of a short loop (up
// to 8 bars, so each step keeps its place in the loop) or else by whole bars. Every step's time is then still ahead.
export const commitAnchor = (anchor: Anchor, now: Snapshot): Anchor => {
    const [beats, unit] = now.timeline.signature
    const barPulses = 960 * 4 * beats / unit
    const {loop} = now.playback
    const loopBars = Number(loop.to.split(".")[0]) - Number(loop.from.split(".")[0])
    const step = loop.on && loopBars > 0 && loopBars <= 8 ? barPulses * loopBars : barPulses
    const delay = Math.max(0, Math.ceil((now.playback.played - anchor.played) / step)) * step
    return {...anchor, played: anchor.played + delay}
}

// Not looping, bars are the timeline's own: a plan whose first bar has gone by moves later as a whole, keeping its
// spacing. Returns the bars to add to each step (0 when looping, stopped, or still ahead).
export const planSlide = (bars: ReadonlyArray<number>, now: Snapshot): number => {
    if (now.playback.loop.on || !now.playback.playing || bars.length === 0) {return 0}
    // In the bar's last beat the next downbeat is too close to land on (the page keeps a lead), so aim one later.
    const beat = Number(now.playback.pos.split(".")[1] ?? 1)
    const first = now.playback.bar + (beat >= now.timeline.signature[0] ? 2 : 1)
    return Math.max(0, first - Math.min(...bars))
}
