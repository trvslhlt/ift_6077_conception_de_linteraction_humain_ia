import {Interpolation, PPQN} from "@opendaw/lib-dsp"
import {NoteEventBox} from "@opendaw/studio-boxes"
import type {Project} from "@opendaw/studio-core"
import {addPoint, createRig, eventCollection, Log, PerfProbe, PerfReport, playFromStart, position, ppqnToMs, Rig, round,
    sleep, stats, writeAutomation} from "./Bench"

// Check 1: how much programmatic editing playback can take. Three kinds of load, each for `seconds`:
// - velocity changes to N notes in one modify(), once per bar (N = 10, 100, 1000);
// - one parameter (a synth's volume) written at 30, 60 and 120 Hz with modify(fn, false), as a macro fader would;
// - the same rates, adding automation points instead of writing the value.
// Each case reports the time spent in modify() and the PerfProbe numbers.

export type EditRateOptions = { seconds: number }
export type EditRateRow = { load: string, edits: number, perSecond: number, modifyMs: ReturnType<typeof stats> } & PerfReport

const NoteCounts = [10, 100, 1000]
const Rates = [30, 60, 120]
const Bars = 64
const NotesPerSixteenth = 4

export const runEditRate = async (project: Project, sampleRate: number, {seconds}: EditRateOptions,
                                  log: Log): Promise<ReadonlyArray<EditRateRow>> => {
    const rows: Array<EditRateRow> = []
    const notesRig = createRig(project, "bench: velocity", Bars)
    const notes = fillNotes(project, notesRig)
    const valueRig = createRig(project, "bench: value writes", Bars)
    const automationRig = createRig(project, "bench: automation writes", Bars)
    const lane = writeAutomation(project, automationRig, automationRig.volume, 0, Bars * PPQN.Bar, [])
    const laneEvents = eventCollection(lane)
    log(`edit rate: ${notes.length} notes ready, ${seconds} s per case`)
    await playFromStart(project)
    const measure = async (load: string, intervalMs: number, edit: (tick: number) => void): Promise<void> => {
        const probe = new PerfProbe(project, sampleRate)
        const durations: Array<number> = []
        probe.start()
        const end = performance.now() + seconds * 1000
        let tick = 0
        while (performance.now() < end) {
            const begin = performance.now()
            edit(tick++)
            durations.push(performance.now() - begin)
            await sleep(Math.max(0, intervalMs - (performance.now() - begin)))
        }
        project.editing.mark()
        const row = {
            load, edits: durations.length, perSecond: round(durations.length / seconds, 1), modifyMs: stats(durations),
            ...probe.stop()
        }
        rows.push(row)
        log(`  ${load}: ${row.perSecond}/s, modify mean ${row.modifyMs.mean} ms, max ${row.modifyMs.max} ms, `
            + `audio overruns ${row.overruns}/${row.blocks}, long tasks ${row.longTasks}, heap ${row.heapDeltaMb ?? "n/a"} MB`)
        await sleep(500)
    }
    const barMs = ppqnToMs(project, PPQN.Bar)
    for (const count of NoteCounts) {
        await measure(`velocity x${count} per bar`, barMs, () => project.editing.modify(() => {
            for (let index = 0; index < count; index++) {
                notes[Math.floor(Math.random() * notes.length)].velocity.setValue(0.3 + Math.random() * 0.6)
            }
        }))
    }
    for (const rate of Rates) {
        await measure(`value writes ${rate} Hz`, 1000 / rate, tick => project.editing.modify(() =>
            valueRig.volume.setUnitValue(0.5 + 0.3 * Math.sin(tick / rate * Math.PI)), false))
    }
    for (const rate of Rates) {
        let last = -1
        await measure(`automation points ${rate} Hz`, 1000 / rate, tick => project.editing.modify(() => {
            last = Math.max(last + 1, Math.round(position(project)))
            addPoint(project, laneEvents, {
                position: last, value: 0.5 + 0.3 * Math.sin(tick / rate * Math.PI), interpolation: Interpolation.Linear
            })
        }, false))
    }
    project.engine.stop()
    return rows
}

// Four notes on every sixteenth of the rig's region: 64 bars give 4096 notes, enough to pick 1000 from.
const fillNotes = (project: Project, rig: Rig): Array<NoteEventBox> => project.editing.modify(() => {
    const sixteenth = PPQN.Quarter / 4
    const notes: Array<NoteEventBox> = []
    for (let step = 0; step < Bars * 16; step++) {
        for (let voice = 0; voice < NotesPerSixteenth; voice++) {
            notes.push(project.api.createNoteEvent({
                owner: rig.region, position: step * sixteenth, duration: sixteenth,
                pitch: 48 + voice * 7, velocity: 0.6
            }))
        }
    }
    return notes
}).unwrap()
