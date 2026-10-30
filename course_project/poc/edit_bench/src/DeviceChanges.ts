import {Interpolation, PPQN} from "@opendaw/lib-dsp"
import {StereoToolDeviceBox, TrackBox, VaporisateurDeviceBox} from "@opendaw/studio-boxes"
import {AutomatableParameterFieldAdapter, Devices, InstrumentBox, InstrumentFactories, InstrumentFactory,
    StereoToolDeviceBoxAdapter, VaporisateurDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {EffectBox, EffectFactories, EffectFactory, type Project} from "@opendaw/studio-core"
import {createRig, Log, PerfProbe, playFromStart, position, ppqnToMs, Rig, round, sleep, writeAutomation} from "./Bench"
import {Chunk, gaps, meanRms, msUntil, OutputTap, Silent} from "./OutputTap"
import {ChangeCase, runInstrumentChanges} from "./InstrumentChange"

// Check 7: agents changing devices during playback. Sound is read from the engine's output (OutputTap), with only
// the rig under test soloed.
// - baseline: a held note with no edits, for the gap count to compare against;
// - effects: insert then remove each effect on a held note: gaps (silence inside the note) and audio blocks over
//   budget. Stereo Tool goes in at -24 dB, so the time until the level drops is the time until an inserted effect is
//   heard (and, on removal, until it is gone);
// - swaps: replace the instrument of a rig playing a note every beat, as the device browser does. The new instrument
//   doesn't receive notes already sounding, so it can be heard from the next note at the earliest;
// - changes: swap vs. crossfading layers vs. a new track (InstrumentChange.ts);
// - lanes: what happens to an automation lane when its device is replaced or deleted, and whether one undo brings
//   both back.

export type EffectCase = {
    name: string, modifyMs: number, msToHeard: number | null, gaps: number, longestGapMs: number,
    overruns: number, blocks: number, maxBlockMs: number
}
export type SwapCase = {
    to: string, modifyMs: number, msToNextNote: number, msToSilence: number | null, msToSound: number | null,
    overruns: number, blocks: number, maxBlockMs: number
}
export type LaneCase = { name: string, laneKept: boolean, undoRestores: boolean }
export type DeviceChangesResult = {
    baseline: { gaps: number, longestGapMs: number }
    effects: ReadonlyArray<EffectCase>
    swaps: ReadonlyArray<SwapCase>
    changes: ReadonlyArray<ChangeCase>
    lanes: ReadonlyArray<LaneCase>
    unobservedMs: number
}

const Bars = 64
const ListenMs = 1000
const SwapListenMs = 1500
const BaselineMs = 2000
const LevelDb = -24
const Effects: ReadonlyArray<EffectFactory> = [EffectFactories.StereoTool, EffectFactories.Delay, EffectFactories.Reverb,
    EffectFactories.DattorroReverb, EffectFactories.Compressor, EffectFactories.Crusher, EffectFactories.Tidal]
const Instruments: ReadonlyArray<InstrumentFactory> = [InstrumentFactories.Tubular, InstrumentFactories.Neon,
    InstrumentFactories.Cubed, InstrumentFactories.Korpus, InstrumentFactories.Apparat, InstrumentFactories.Vaporisateur]

export const runDeviceChanges = async (project: Project, sampleRate: number, log: Log): Promise<DeviceChangesResult> => {
    const tap = OutputTap.create()
    const held = createRig(project, "bench: devices, held note", Bars)
    const pulse = createRig(project, "bench: devices, swap", Bars)
    project.editing.modify(() => {
        project.api.createNoteEvent({owner: held.region, position: 0, duration: Bars * PPQN.Bar, pitch: 60, velocity: 0.8})
        for (let beat = 0; beat < Bars * 4; beat++) {
            project.api.createNoteEvent({owner: pulse.region, position: beat * PPQN.Quarter, duration: PPQN.Quarter,
                pitch: 60, velocity: 0.8})
        }
    })
    const solo = (rig: Rig, value: boolean) => project.editing.modify(() => rig.audioUnitBox.solo.setValue(value))
    const probe = new PerfProbe(project, sampleRate)
    tap.start()
    try {
        solo(held, true)
        await playFromStart(project)
        await sleep(500)
        const baseFrom = tap.now()
        await sleep(BaselineMs)
        const baseline = gaps(tap.between(baseFrom, tap.now()))
        log(`devices: baseline ${baseline.count} gaps, longest ${baseline.longestMs} ms`)
        const effects: Array<EffectCase> = []
        for (const factory of Effects) {
            const levelled = factory === EffectFactories.StereoTool
            const label = levelled ? `${factory.defaultName} (${LevelDb} dB)` : factory.defaultName
            let effect: EffectBox | null = null
            effects.push(await measureEffect(project, tap, probe, `insert ${label}`, levelled ? "drops" : null, () => {
                effect = project.api.insertEffect(held.audioUnitBox.audioEffects, factory)
                if (effect instanceof StereoToolDeviceBox) {effect.volume.setValue(LevelDb)}
            }))
            effects.push(await measureEffect(project, tap, probe, `remove ${label}`, levelled ? "rises" : null,
                () => deleteEffect(project, effect)))
            effects.slice(-2).forEach(entry => log(`devices: ${JSON.stringify(entry)}`))
        }
        solo(held, false)
        solo(pulse, true)
        await sleep(500)
        const swaps: Array<SwapCase> = []
        let instrument: InstrumentBox = pulse.instrumentBox
        for (const factory of Instruments) {
            const since = tap.now()
            const at = position(project)
            const msToNextNote = round(ppqnToMs(project, Math.ceil(at / PPQN.Quarter) * PPQN.Quarter - at), 1)
            probe.start()
            const start = performance.now()
            instrument = project.editing.modify(() => replace(project, instrument, factory)).unwrap()
            const modifyMs = round(performance.now() - start)
            await sleep(SwapListenMs)
            const perf = probe.stop()
            const chunks = tap.between(since, tap.now())
            const msToSilence = msUntil(chunks, since, chunk => chunk.peak < Silent)
            const msBack = msToSilence === null ? null
                : msUntil(chunks, since + msToSilence / 1000, chunk => chunk.peak >= Silent)
            swaps.push({to: factory.defaultName, modifyMs, msToNextNote, msToSilence,
                msToSound: msToSilence === null ? 0 : msBack === null ? null : round(msToSilence + msBack, 1),
                overruns: perf.overruns, blocks: perf.blocks, maxBlockMs: perf.maxBlockMs})
            log(`devices: swap ${JSON.stringify(swaps[swaps.length - 1])}`)
        }
        solo(pulse, false)
        const changes = await runInstrumentChanges(project, tap, probe)
        changes.forEach(change => log(`devices: change ${JSON.stringify(change)}`))
        project.engine.stop()
        let laneEffect: EffectBox | null = null
        const lanes: Array<LaneCase> = [
            laneCase(project, "instrument replaced (Vaporisateur cutoff lane)", pulse, () => {
                if (!(instrument instanceof VaporisateurDeviceBox)) {throw new Error("swaps did not end on Vaporisateur")}
                return project.boxAdapters.adapterFor(instrument, VaporisateurDeviceBoxAdapter).namedParameter.cutoff
            }, () => replace(project, instrument, InstrumentFactories.Tubular)),
            laneCase(project, "effect deleted (Stereo Tool volume lane)", held, () => {
                const effect = project.editing.modify(() =>
                    project.api.insertEffect(held.audioUnitBox.audioEffects, EffectFactories.StereoTool)).unwrap()
                laneEffect = effect
                return project.boxAdapters.adapterFor(effect, StereoToolDeviceBoxAdapter).namedParameter.volume
            }, () => deleteEffect(project, laneEffect))
        ]
        lanes.forEach(lane => log(`devices: lane ${JSON.stringify(lane)}`))
        return {baseline: {gaps: baseline.count, longestGapMs: baseline.longestMs}, effects, swaps, changes, lanes,
            unobservedMs: tap.unobservedMs}
    } finally {
        tap.stop()
        project.engine.stop()
    }
}

const replace = (project: Project, instrument: InstrumentBox, factory: InstrumentFactory): InstrumentBox => {
    const attempt = project.api.replaceMIDIInstrument(instrument, factory)
    if (attempt.isFailure()) {throw new Error(attempt.failureReason())}
    return attempt.result()
}

const deleteEffect = (project: Project, effect: EffectBox | null): void => {
    if (effect === null) {throw new Error("no effect to delete")}
    Devices.deleteEffectDevices([project.boxAdapters.adapterFor(effect, Devices.isEffect)])
}

// One modify, then ListenMs of output. With `level`, msToHeard is the time until the level moves 12 dB that way from
// its mean over the 300 ms before.
const measureEffect = async (project: Project, tap: OutputTap, probe: PerfProbe, name: string,
                             level: "drops" | "rises" | null, edit: () => void): Promise<EffectCase> => {
    const since = tap.now()
    const before = meanRms(tap.between(since - 0.3, since))
    probe.start()
    const start = performance.now()
    project.editing.modify(edit)
    const modifyMs = round(performance.now() - start)
    await sleep(ListenMs)
    const perf = probe.stop()
    const chunks = tap.between(since, tap.now())
    const factor = 10 ** (12 / 20)
    const moved = (chunk: Chunk) => level === "drops" ? chunk.rms < before / factor : chunk.rms > before * factor
    const {count, longestMs} = gaps(chunks)
    return {name, modifyMs, msToHeard: level === null ? null : msUntil(chunks, since, moved), gaps: count,
        longestGapMs: longestMs, overruns: perf.overruns, blocks: perf.blocks, maxBlockMs: perf.maxBlockMs}
}

const laneCase = (project: Project, name: string, rig: Rig,
                  parameter: () => AutomatableParameterFieldAdapter<number>, destroy: () => void): LaneCase => {
    const region = writeAutomation(project, rig, parameter(), 0, PPQN.Bar, [
        {position: 0, value: 0.2, interpolation: Interpolation.Linear},
        {position: PPQN.Bar, value: 0.8, interpolation: Interpolation.None}])
    const lane = region.regions.targetVertex.unwrap().box
    if (!(lane instanceof TrackBox)) {throw new Error("automation region outside a track")}
    const uuid = lane.address.uuid
    project.editing.modify(destroy)
    const laneKept = project.boxGraph.findBox(uuid).nonEmpty()
    project.editing.undo()
    return {name, laneKept, undoRestores: project.boxGraph.findBox(uuid).nonEmpty()}
}
