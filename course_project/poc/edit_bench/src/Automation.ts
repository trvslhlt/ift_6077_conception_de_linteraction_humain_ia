import {Interpolation, PPQN, ppqn} from "@opendaw/lib-dsp"
import {ValueEventCollectionBox} from "@opendaw/studio-boxes"
import type {Project} from "@opendaw/studio-core"
import {addPoint, createRig, Log, msToPpqn, Point, playFromStart, position, round, sleep, writeAutomation} from "./Bench"

// Check 3: is automation written during playback heard on the same pass? Each case writes a one-bar ramp starting
// LeadMs ahead of the playhead, then samples the value the engine actually applies, every animation frame:
// for a parameter, AutomatableParameterFieldAdapter.getControlledUnitValue() (the engine reports the automated
// value back); for tempo, engine.bpm. A ramp counts as followed when the applied value moves across the bar.
// - linear, curve: ramps on a synth's volume, which had no automation before;
// - touched, lane existed: the volume already had a lane, and was written (as a user's knob move would) earlier in
//   the pass; openDAW suspends that lane until stop, so the ramp is expected NOT to be followed;
// - touched, no lane yet: the same write, but before any lane existed;
// - tempo: a ramp on the tempo track.

export type AutomationCase = {
    name: string
    expected: "followed" | "not followed"
    followed: boolean
    samples: Array<{ at: number, value: number }>
}

const LeadMs = 500
const Bars = 64
const From = 0.2
const To = 0.8
const SampleFractions = [0.05, 0.25, 0.5, 0.75, 0.95]

export const runAutomation = async (project: Project, log: Log): Promise<ReadonlyArray<AutomationCase>> => {
    const cases: Array<AutomationCase> = []
    const fresh = createRig(project, "bench: automation", Bars)
    const laned = createRig(project, "bench: touched, lane", Bars)
    const unlaned = createRig(project, "bench: touched, no lane", Bars)
    writeAutomation(project, laned, laned.volume, (Bars - 4) * PPQN.Bar, PPQN.Bar, [])
    await playFromStart(project)
    await sleep(300)
    const ramp = (interpolation: Interpolation): ReadonlyArray<Point> =>
        [{position: 0, value: From, interpolation}, {position: PPQN.Bar, value: To, interpolation: Interpolation.Linear}]
    const run = async (name: string, expected: AutomationCase["expected"], write: (start: ppqn) => void,
                       read: () => number, minChange: number = (To - From) / 2): Promise<void> => {
        const start = position(project) + msToPpqn(project, LeadMs)
        write(start)
        const samples = await sample(project, start, PPQN.Bar, read)
        const followed = Math.abs(samples[samples.length - 1].value - samples[0].value) > minChange
        cases.push({name, expected, followed, samples})
        log(`automation: ${name}: ${followed ? "followed" : "not followed"} (expected ${expected}), `
            + samples.map(({at, value}) => `${at}:${value}`).join(" "))
        await sleep(300)
    }
    await run("linear ramp, no lane before", "followed",
        start => writeAutomation(project, fresh, fresh.volume, start, PPQN.Bar, ramp(Interpolation.Linear)),
        () => fresh.volume.getControlledUnitValue())
    await run("curve ramp (slope 0.8), same lane", "followed",
        start => writeAutomation(project, fresh, fresh.volume, start, PPQN.Bar, ramp(Interpolation.Curve(0.8))),
        () => fresh.volume.getControlledUnitValue())
    project.editing.modify(() => laned.volume.setUnitValue(0.5))
    await sleep(100)
    await run("linear ramp, touched this pass, lane existed", "not followed",
        start => writeAutomation(project, laned, laned.volume, start, PPQN.Bar, ramp(Interpolation.Linear)),
        () => laned.volume.getControlledUnitValue())
    project.editing.modify(() => unlaned.volume.setUnitValue(0.5))
    await sleep(100)
    await run("linear ramp, touched this pass, no lane before", "followed",
        start => writeAutomation(project, unlaned, unlaned.volume, start, PPQN.Bar, ramp(Interpolation.Linear)),
        () => unlaned.volume.getControlledUnitValue())
    const {tempoTrack, bpm} = project.timelineBox
    const tempoWasEnabled = tempoTrack.enabled.getValue()
    const baseBpm = bpm.getValue()
    const tempoEvents = tempoTrack.events.targetVertex.unwrap().box
    if (!(tempoEvents instanceof ValueEventCollectionBox)) {throw new Error("tempo track without events")}
    const added: Array<{ delete(): void }> = []
    await run(`tempo ramp ${baseBpm} -> ${baseBpm + 30} BPM`, "followed",
        start => project.editing.modify(() => {
            tempoTrack.enabled.setValue(true)
            added.push(addPoint(project, tempoEvents, {position: start, value: baseBpm, interpolation: Interpolation.Linear}))
            added.push(addPoint(project, tempoEvents, {position: start + PPQN.Bar, value: baseBpm + 30, interpolation: Interpolation.None}))
        }),
        () => project.engine.bpm.getValue(), 15)
    project.engine.stop()
    project.editing.modify(() => {
        added.forEach(box => box.delete())
        tempoTrack.enabled.setValue(tempoWasEnabled)
    })
    return cases
}

// Waits for the playhead to cross [start, start + duration] and returns the applied value at a few fractions of it.
const sample = async (project: Project, start: ppqn, duration: ppqn, read: () => number): Promise<Array<{ at: number, value: number }>> => {
    const seen: Array<{ fraction: number, value: number }> = []
    while (position(project) < start + duration) {
        const fraction = (position(project) - start) / duration
        if (fraction >= 0) {seen.push({fraction, value: read()})}
        await new Promise(resolve => requestAnimationFrame(resolve))
    }
    return SampleFractions.map(at => {
        const nearest = seen.reduce((best, entry) =>
            Math.abs(entry.fraction - at) < Math.abs(best.fraction - at) ? entry : best, seen[0] ?? {fraction: at, value: NaN})
        return {at, value: round(nearest.value, 3)}
    })
}
