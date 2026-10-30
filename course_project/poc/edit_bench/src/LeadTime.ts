import {Terminator} from "@opendaw/lib-std"
import {PPQN} from "@opendaw/lib-dsp"
import {NoteStreamReceiver} from "@opendaw/studio-adapters"
import type {Project} from "@opendaw/studio-core"
import {createRig, Log, msToPpqn, playFromStart, position, ppqnToMs, Rig, round, sleep} from "./Bench"

// Check 2: how far ahead of the playhead an edit must land to be heard on this pass. "Ahead" is measured against
// engine.position as the main thread sees it, which is what agents will see. Three kinds of edit:
// - insert: a new note at playhead + lead, in the region under the playhead;
// - change: an existing note's pitch changed when it is `lead` away (pitch, not velocity: the engine reports which
//   notes are sounding, not how loud, and both are the same kind of edit, a field on an existing note);
// - loop: insert into a region that repeats one bar, at the loop position playhead + lead.
// A note counts as heard when the engine reports it sounding (NoteStreamReceiver, read once per animation frame).

export type LeadKind = "insert" | "change" | "loop"
export type LeadTrial = { kind: LeadKind, targetMs: number, actualMs: number, heard: boolean }
export type LeadSummary = { kind: LeadKind, byLead: Array<{ leadMs: number, heard: number, trials: number }>, minReliableMs: number | null }
export type LeadTimeResult = { noteAddress: string, trials: ReadonlyArray<LeadTrial>, summary: ReadonlyArray<LeadSummary> }

const LeadsMs = [0, 10, 20, 30, 50, 75, 100, 150, 200, 300]
const TrialsPerLead = 3
const Bars = 64
const Decoy = 30
const ListenMs = 400

export const runLeadTime = async (project: Project, log: Log): Promise<LeadTimeResult> => {
    const terminator = new Terminator()
    try {
        const rigs: Record<LeadKind, Rig> = {
            insert: createRig(project, "bench: lead insert", Bars),
            change: createRig(project, "bench: lead change", Bars),
            loop: createRig(project, "bench: lead loop", Bars, 1)
        }
        const listeners = {} as Record<LeadKind, Listener>
        for (const kind of Object.keys(rigs) as Array<LeadKind>) {listeners[kind] = terminator.own(new Listener(project, rigs[kind]))}
        await playFromStart(project)
        await sleep(300)
        const trials: Array<LeadTrial> = []
        let pitch = 40
        const nextPitch = () => pitch = pitch >= 100 ? 40 : pitch + 1
        for (const kind of ["insert", "change", "loop"] as const) {
            for (const targetMs of LeadsMs) {
                for (let trial = 0; trial < TrialsPerLead; trial++) {
                    const result = await runTrial(project, rigs[kind], listeners[kind], kind, targetMs, nextPitch())
                    trials.push(result)
                }
            }
            log(`lead time: ${kind} done`)
        }
        project.engine.stop()
        const addresses = Object.values(listeners).map(listener => listener.heardAt()).filter(address => address !== "")
        return {noteAddress: addresses[0] ?? "none", trials, summary: summarize(trials)}
    } finally {
        terminator.terminate()
    }
}

const runTrial = async (project: Project, rig: Rig, listener: Listener, kind: LeadKind, targetMs: number,
                        pitch: number): Promise<LeadTrial> => {
    const regionStart = rig.region.position.getValue()
    const loop = rig.region.loopDuration.getValue()
    const duration = PPQN.Quarter / 4
    listener.forget(pitch)
    let actualMs = targetMs
    if (kind === "change") {
        const at = position(project) + msToPpqn(project, 1000)
        const note = project.editing.modify(() => project.api.createNoteEvent(
            {owner: rig.region, position: at - regionStart, duration, pitch: Decoy, velocity: 0.8})).unwrap()
        const editAt = at - msToPpqn(project, targetMs)
        await until(() => position(project) >= editAt)
        actualMs = round(ppqnToMs(project, at - position(project)))
        project.editing.modify(() => note.pitch.setValue(pitch))
    } else {
        const at = position(project) + msToPpqn(project, targetMs)
        const local = kind === "loop" ? (at - regionStart) % loop : at - regionStart
        project.editing.modify(() => project.api.createNoteEvent(
            {owner: rig.region, position: local, duration, pitch, velocity: 0.8}))
    }
    await sleep(Math.max(0, actualMs) + ppqnToMs(project, duration) + ListenMs)
    return {kind, targetMs, actualMs, heard: listener.heard(pitch)}
}

const until = async (condition: () => boolean): Promise<void> => {
    while (!condition()) {await new Promise(resolve => requestAnimationFrame(resolve))}
}

// The engine reports a unit's sounding notes as a 128-bit set. Which address it uses (instrument or audio unit) is
// one of the things this check finds out, so it listens on both.
class Listener {
    readonly #terminator = new Terminator()
    readonly #heard = new Set<number>()
    #heardAt = ""

    constructor(project: Project, rig: Rig) {
        for (const [name, address] of [["audio unit", rig.audioUnitBox.address], ["instrument", rig.instrumentBox.address]] as const) {
            const receiver = this.#terminator.own(new NoteStreamReceiver(project.liveStreamReceiver, address))
            this.#terminator.own(receiver.subscribe(state => {
                for (let note = 0; note < 128; note++) {
                    if (state.isNoteOn(note)) {
                        this.#heard.add(note)
                        this.#heardAt = name
                    }
                }
            }))
        }
    }

    forget(pitch: number): void {this.#heard.delete(pitch)}
    heard(pitch: number): boolean {return this.#heard.has(pitch)}
    heardAt(): string {return this.#heardAt}
    terminate(): void {this.#terminator.terminate()}
}

const summarize = (trials: ReadonlyArray<LeadTrial>): Array<LeadSummary> =>
    (["insert", "change", "loop"] as const).map(kind => {
        const ofKind = trials.filter(trial => trial.kind === kind)
        const byLead = LeadsMs.map(leadMs => {
            const atLead = ofKind.filter(trial => trial.targetMs === leadMs)
            return {leadMs, heard: atLead.filter(trial => trial.heard).length, trials: atLead.length}
        })
        // Smallest lead from which every trial at that lead and above was heard.
        let minReliableMs: number | null = null
        for (let index = byLead.length - 1; index >= 0 && byLead[index].heard === byLead[index].trials; index--) {
            minReliableMs = byLead[index].leadMs
        }
        return {kind, byLead, minReliableMs}
    })
