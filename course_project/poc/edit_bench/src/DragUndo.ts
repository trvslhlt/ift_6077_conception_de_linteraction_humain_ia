import {Terminator} from "@opendaw/lib-std"
import type {Project} from "@opendaw/studio-core"
import {createRig, Rig} from "./Bench"
import {Holds} from "./Holds"

// Check 4: an agent editing while the user drags a knob. While running, the "agent" relabels a region every
// IntervalMs, using one of three strategies:
// - direct: editing.modify(), as if the bus did nothing special;
// - append: editing.append(), which adds to the last closed undo step instead of closing a new one;
// - queue: hold edits while any parameter is held (Holds, check 5) and apply them, each as its own modify(), when
//   the drag ends.
// stop() then walks the undo history back from the newest step, classifying each step as agent-only, user-only
// (the knob last held) or mixed, and redoes everything it undid. A mixed step means one Ctrl+Z would undo part of
// the user's drag together with an agent edit.

export type Strategy = "direct" | "append" | "queue"
export type UndoStep = { agent: boolean, user: boolean }
export type DragUndoResult = {
    strategy: Strategy
    agentEdits: number
    queuedDuringDrag: number
    steps: ReadonlyArray<UndoStep>
    agentOnly: number
    userOnly: number
    mixed: number
    knob: string
}

const IntervalMs = 250
const MaxSteps = 200

export class AgentLoop {
    readonly #project: Project
    readonly #holds: Holds
    readonly #strategy: Strategy
    readonly #rig: Rig
    readonly #terminator = new Terminator()
    readonly #queue: Array<number> = []
    #edits = 0
    #queued = 0

    constructor(project: Project, holds: Holds, strategy: Strategy) {
        this.#project = project
        this.#holds = holds
        this.#strategy = strategy
        this.#rig = createRig(project, "bench: agent target", 4)
        const timer = setInterval(() => this.#request(++this.#edits), IntervalMs)
        this.#terminator.own({terminate: () => clearInterval(timer)})
        this.#terminator.own(holds.subscribe(() => {if (!holds.any()) {this.#flush()}}))
    }

    stop(): DragUndoResult {
        this.#terminator.terminate()
        this.#flush()
        const knob = this.#holds.last()
        const steps = this.#classify(() => knob?.getValue() ?? 0)
        return {
            strategy: this.#strategy, agentEdits: this.#edits, queuedDuringDrag: this.#queued, steps,
            agentOnly: steps.filter(step => step.agent && !step.user).length,
            userOnly: steps.filter(step => !step.agent && step.user).length,
            mixed: steps.filter(step => step.agent && step.user).length,
            knob: knob === null ? "none held" : `${knob.name} ${knob.address.toString()}`
        }
    }

    #request(edit: number): void {
        if (this.#strategy === "queue" && this.#holds.any()) {
            this.#queue.push(edit)
            this.#queued++
            return
        }
        this.#apply(edit)
    }

    #apply(edit: number): void {
        const relabel = () => this.#rig.region.label.setValue(`agent edit ${edit}`)
        if (this.#strategy === "append") {
            this.#project.editing.append(relabel)
        } else {
            this.#project.editing.modify(relabel)
        }
    }

    #flush(): void {this.#queue.splice(0).forEach(edit => this.#apply(edit))}

    #classify(knobValue: () => number): Array<UndoStep> {
        const {editing} = this.#project
        const label = () => this.#rig.region.label.getValue()
        const steps: Array<UndoStep> = []
        let undone = 0
        while (editing.canUndo() && undone < MaxSteps) {
            const before = {label: label(), knob: knobValue()}
            if (!editing.undo()) {break}
            undone++
            const step = {agent: label() !== before.label, user: knobValue() !== before.knob}
            if (!step.agent && !step.user) {break}
            steps.push(step)
        }
        for (let index = 0; index < undone; index++) {editing.redo()}
        return steps
    }
}
