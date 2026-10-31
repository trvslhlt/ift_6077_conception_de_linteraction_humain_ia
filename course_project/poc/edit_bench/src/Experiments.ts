import {Terminator} from "@opendaw/lib-std"
import {PPQN} from "@opendaw/lib-dsp"
import {ConvolverDeviceBox, VaporisateurDeviceBox} from "@opendaw/studio-boxes"
import {Devices} from "@opendaw/studio-adapters"
import {EffectFactories, type Project} from "@opendaw/studio-core"
import {createRig, Log, msToPpqn, playFromStart, position, ppqnToMs, Rig, round, sleep} from "./Bench"
import {Listener} from "./LeadTime"
import {fileBoxOf, importSample, wav} from "./OpenQuestions"
import {Chunk, OutputTap} from "./OutputTap"

// Experiments C and D from project_plan/EXPERIMENTS.md. Not part of `make test` (C alone takes minutes): run them
// with `make experiment` or window.editBench.experiment("C" | "D").
//
// C: why check 2 occasionally misses a note inserted into a looping region. The same loop insert, many times, in
//    three conditions: notes accumulating in the region as in check 2; each note deleted after it is heard; notes
//    accumulating with a 10 ms release (fewer overlapping voices). In the "clear" condition the region holds one
//    note at a time, so the output itself shows whether it played, which tells "not played" from "not reported".
// D: whether a Convolver applies its impulse response as soon as it is inserted. The response is silent except for
//    one click at EchoMs, so it adds a distinct echo after every note; short notes on an eighth-note grid leave room
//    to hear it. The first echo after the insert shows when the response applied.

export type LoopCondition = "accumulate" | "clear" | "short release"
export type LoopTrial = {
    condition: LoopCondition
    trial: number
    notesInRegion: number
    modifyMs: number
    remainingMs: number   // how far ahead the note still was when modify() returned
    insertLocal: string   // playhead's position in the loop at insert, beats.sixteenths.ticks of the bar
    targetLocal: string
    wrapped: boolean      // the target is in the loop's next pass
    stream: boolean       // reported by the engine's note stream
    output: number | null // "clear" only: output peak around the note's time
}
export type LoopMissResult = {
    leadMs: number
    trials: ReadonlyArray<LoopTrial>
    summary: ReadonlyArray<{ condition: LoopCondition, trials: number, reported: number, sounded: number | null,
        missesWrapped: number }>
}

export type ConvolverCase = {
    case: string
    firstEchoMs: number | null   // from the insert to the first echo's onset
    echoOffsetMs: number | null  // the echo's measured distance from its note (EchoMs plus any latency)
    dryExpected: number          // dry notes due in the 3 s after the insert
    dryHeard: number
}

const LeadMs = 300
const LoopTrials = 100
const ListenMs = 400
const LoopBars = 128
const Audible = 0.01

export const runLoopMisses = async (project: Project, log: Log, trials: number = LoopTrials): Promise<LoopMissResult> => {
    const tap = OutputTap.create()
    tap.start()
    const all: Array<LoopTrial> = []
    try {
        for (const condition of ["accumulate", "clear", "short release"] as const) {
            const terminator = new Terminator()
            const rig = createRig(project, `bench: experiment C, ${condition}`, LoopBars, 1)
            const listener = terminator.own(new Listener(project, rig))
            project.editing.modify(() => {
                rig.audioUnitBox.solo.setValue(true)
                if (condition === "short release") {vaporisateur(rig).release.setValue(0.01)}
            })
            await playFromStart(project)
            await sleep(300)
            for (let trial = 0; trial < trials; trial++) {
                all.push(await loopTrial(project, rig, listener, tap, condition, trial))
            }
            project.engine.stop()
            project.editing.modify(() => rig.audioUnitBox.solo.setValue(false))
            terminator.terminate()
            const missed = all.filter(row => row.condition === condition && !row.stream).length
            log(`experiment C: ${condition}: ${missed} of ${trials} not reported`)
        }
    } finally {
        tap.stop()
    }
    const summary = (["accumulate", "clear", "short release"] as const).map(condition => {
        const rows = all.filter(row => row.condition === condition)
        return {
            condition, trials: rows.length, reported: rows.filter(row => row.stream).length,
            sounded: condition === "clear" ? rows.filter(row => (row.output ?? 0) >= Audible).length : null,
            missesWrapped: rows.filter(row => !row.stream && row.wrapped).length
        }
    })
    return {leadMs: LeadMs, trials: all, summary}
}

// Pitches 20-119, one per trial, so in the accumulating conditions every note in the region is distinct.
const loopTrial = async (project: Project, rig: Rig, listener: Listener, tap: OutputTap, condition: LoopCondition,
                         trial: number): Promise<LoopTrial> => {
    const loop = rig.region.loopDuration.getValue()
    const duration = PPQN.SemiQuaver
    const pitch = 20 + trial % 100
    listener.forget(pitch)
    const notesInRegion = rig.region.events.targetVertex.mapOr(vertex => vertex.box.pointerHub.incoming().length, 0)
    const now = position(project)
    const at = now + msToPpqn(project, LeadMs)
    const started = performance.now()
    const note = project.editing.modify(() => project.api.createNoteEvent(
        {owner: rig.region, position: at % loop, duration, pitch, velocity: 0.8})).unwrap()
    const modifyMs = performance.now() - started
    const remainingMs = ppqnToMs(project, at - position(project))
    const soundsAt = tap.now() + remainingMs / 1000
    await sleep(Math.max(0, remainingMs) + ppqnToMs(project, duration) + ListenMs)
    let output: number | null = null
    if (condition === "clear") {
        // From just before the note's time: the previous note's release has faded below Audible by then.
        output = round(peakOf(tap.between(soundsAt - 0.03, soundsAt + 0.2)), 4)
        project.editing.modify(() => note.delete())
    }
    return {
        condition, trial, notesInRegion, modifyMs: round(modifyMs), remainingMs: round(remainingMs),
        insertLocal: local(now % loop), targetLocal: local(at % loop), wrapped: at % loop < now % loop,
        stream: listener.heard(pitch), output
    }
}

const local = (pulses: number): string => PPQN.toString(pulses).split(".").slice(1).join(".")

const vaporisateur = (rig: Rig): VaporisateurDeviceBox => {
    if (!(rig.instrumentBox instanceof VaporisateurDeviceBox)) {throw new Error("rig is not a Vaporisateur")}
    return rig.instrumentBox
}

const peakOf = (chunks: ReadonlyArray<Chunk>): number => chunks.reduce((max, chunk) => Math.max(max, chunk.peak), 0)

const EchoMs = 80
const NoteMs = 30
const AfterMs = 3000

export const runConvolverResponse = async (project: Project, log: Log): Promise<ReadonlyArray<ConvolverCase>> => {
    const tap = OutputTap.create()
    // Each run makes new responses (the click's level varies), so "not loaded" never finds one cached. The sample
    // service names a sample by its content's hash.
    const response = (name: string) => importSample(project, name, wav(0.2, (_, i) =>
        i === Math.round(EchoMs * 48) ? 0.9 + Math.random() * 0.09 : 0))
    const fresh = await response("bench echo response")
    const preloaded = await response("bench echo response, preloaded")
    const rig = createRig(project, "bench: experiment D", 32)
    const holder = createRig(project, "bench: experiment D, holder", 32)
    project.editing.modify(() => {
        const synth = vaporisateur(rig)
        synth.attack.setValue(0.001)
        synth.release.setValue(0.005)
        for (let eighth = 0; eighth < 32 * 8; eighth++) {
            project.api.createNoteEvent({owner: rig.region, position: eighth * PPQN.Quarter / 2,
                duration: Math.round(msToPpqn(project, NoteMs)), pitch: 60, velocity: 0.9})
        }
        rig.audioUnitBox.solo.setValue(true)
    })
    const insert = (target: Rig, sample: typeof fresh | null): ConvolverDeviceBox => {
        const convolver = project.api.insertEffect(target.audioUnitBox.audioEffects, EffectFactories.Convolver)
        project.boxAdapters.adapterFor(convolver, Devices.isEffect)
        if (!(convolver instanceof ConvolverDeviceBox)) {throw new Error("not a Convolver")}
        if (sample !== null) {convolver.file.refer(fileBoxOf(project, sample))}
        return convolver
    }
    const measure = async (name: string, sample: typeof fresh | null): Promise<ConvolverCase> => {
        await sleep(1000)
        const since = tap.now()
        const convolver = project.editing.modify(() => insert(rig, sample)).unwrap()
        await sleep(AfterMs)
        const result = {case: name, ...echoes(tap.between(since - 1, since + AfterMs / 1000), since,
            ppqnToMs(project, PPQN.Quarter / 2))}
        log(`experiment D: ${JSON.stringify(result)}`)
        project.editing.modify(() => convolver.delete())
        return result
    }
    tap.start()
    try {
        await playFromStart(project)
        const cases: Array<ConvolverCase> = []
        cases.push(await measure("no response (control)", null))
        cases.push(await measure("response not loaded", fresh))
        // Loaded by a Convolver on another (unheard) track 2 s before.
        project.editing.modify(() => insert(holder, preloaded))
        await sleep(2000)
        cases.push(await measure("response already loaded", preloaded))
        project.engine.stop()
        project.editing.modify(() => rig.audioUnitBox.solo.setValue(false))
        return cases
    } finally {
        tap.stop()
    }
}

// Onsets are chunks that turn audible after silence. Those before `since` are all dry notes and give the grid; after
// it, an onset off the grid is an echo.
const echoes = (chunks: ReadonlyArray<Chunk>, since: number, periodMs: number) => {
    const onsets = chunks.filter((chunk, index) => index > 0 && chunk.peak >= Audible && chunks[index - 1].peak < Audible)
        .map(chunk => chunk.time)
    const grid = onsets.find(time => time < since)
    if (grid === undefined) {throw new Error("no notes heard before the insert")}
    const phaseMs = (time: number) => ((time - grid) * 1000 % periodMs + periodMs) % periodMs
    const onGrid = (time: number) => Math.min(phaseMs(time), periodMs - phaseMs(time)) < 20
    const after = onsets.filter(time => time > since)
    const firstEcho = after.find(time => !onGrid(time))
    return {
        firstEchoMs: firstEcho === undefined ? null : round((firstEcho - since) * 1000, 1),
        echoOffsetMs: firstEcho === undefined ? null : round(phaseMs(firstEcho), 1),
        dryExpected: Math.floor(AfterMs / periodMs),
        dryHeard: after.filter(onGrid).length
    }
}
