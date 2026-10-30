import {Option, Terminator, ValueMapping} from "@opendaw/lib-std"
import {Box, IndexedBox} from "@opendaw/lib-box"
import {Interpolation, PPQN, ppqn} from "@opendaw/lib-dsp"
import {AudioUnitBox, InstrumentCompositeBox, InstrumentCompositeCellBox, NoteRegionBox, TrackBox, VaporisateurDeviceBox} from "@opendaw/studio-boxes"
import {AudioUnitBoxAdapter, AutomatableParameterFieldAdapter, InstrumentCompositeCellBoxAdapter, InstrumentFactories,
    InstrumentFactory, NoteStreamReceiver} from "@opendaw/studio-adapters"
import {EffectBox, type Project} from "@opendaw/studio-core"
import {createRig, msToPpqn, PerfProbe, position, ppqnToMs, Rig, round, sleep, writeAutomation} from "./Bench"
import {Chunk, gapList, gaps, meanRms, OutputTap, Silent} from "./OutputTap"

// Part of check 7: three ways to change a playing track's instrument, each on a fresh synth with a 2 s release and a
// short note every beat, so the tails fill the time between notes. Each edit lands 40 ms into a
// note, while it sounds.
// - swap: replaceMIDIInstrument, one step;
// - layers: wrap the instrument as layer 1 of an instrument composite, add the new one as layer 2 at -inf, crossfade
//   the two layers' gain over one bar with automation, then delete layer 1 and the fade lanes;
// - layers, prewrapped: the same on a track that was already a composite before it started sounding;
// - new track: a new unit with the old one's mixer settings and effects, the regions moved onto it, the old unit's
//   volume faded out over one bar, then the old unit deleted.
// Measured on the engine's output: gaps, and the deepest level dip (mean over ~21 ms windows, against the second
// before the change; normalDipDb is the same for that second itself, the dip between notes). For new track, whether the old unit still reports the note that was sounding at the move.

export type ChangeMethod = "swap" | "layers" | "layers, prewrapped" | "new track"
// gapMs: the longest gap starting within 600 ms after the step.
export type ChangeStep = { name: string, modifyMs: number, gapMs: number, overruns: number, blocks: number }
export type ChangeCase = {
    method: ChangeMethod, steps: ReadonlyArray<ChangeStep>, gaps: number, longestGapMs: number, dipDb: number,
    normalDipDb: number,
    newHeard: boolean, oldNoteAfter50Ms: boolean | null, oldNoteAfter300Ms: boolean | null
}

const Bars = 64
const ReleaseSeconds = 2
const IntoNoteMs = 40
// Same synth, also with a long release: any gap after the change is then the change's, not the new sound's.
const To: InstrumentFactory = InstrumentFactories.Vaporisateur
const ZeroDb = ValueMapping.DefaultDecibel.x(0)

export const runInstrumentChanges = async (project: Project, tap: OutputTap, probe: PerfProbe): Promise<ReadonlyArray<ChangeCase>> => {
    const cases: Array<ChangeCase> = []
    for (const method of ["swap", "layers", "layers, prewrapped", "new track"] as const) {
        const rig = tailRig(project, `bench: change by ${method}`)
        const prewrapped = method === "layers, prewrapped" ? project.editing.modify(() => wrap(project, rig)).unwrap() : null
        project.editing.modify(() => rig.audioUnitBox.solo.setValue(true))
        await sleep(1500)
        const since = tap.now()
        const steps: Array<ChangeStep> = []
        const stepTimes: Array<number> = []
        const step = async (name: string, edit: () => void): Promise<void> => {
            stepTimes.push(tap.now())
            probe.start()
            const start = performance.now()
            project.editing.modify(edit)
            const modifyMs = round(performance.now() - start)
            await sleep(100)
            const {overruns, blocks} = probe.stop()
            steps.push({name, modifyMs, gapMs: 0, overruns, blocks})
        }
        await intoNote(project)
        let notes: { after50: boolean | null, after300: boolean | null } = {after50: null, after300: null}
        let remaining: AudioUnitBox = rig.audioUnitBox
        if (method === "swap") {
            await step("replace instrument", () => withTail(attempt(project.api.replaceMIDIInstrument(rig.instrumentBox, To))))
            await sleep(2000)
        } else if (method !== "new track") {
            await crossfadeLayers(project, rig, step, prewrapped)
        } else {
            const result = await newTrack(project, rig, step)
            notes = result.notes
            remaining = result.unit
        }
        const chunks = tap.between(since, tap.now())
        const before = tap.between(since - 1, since)
        const {count, longestMs} = gaps(chunks)
        const found = gapList(chunks)
        steps.forEach((entry, index) => entry.gapMs = found
            .filter(gap => gap.start >= stepTimes[index] && gap.start < stepTimes[index] + 0.6)
            .reduce((longest, gap) => Math.max(longest, gap.ms), 0))
        cases.push({method, steps, gaps: count, longestGapMs: longestMs, dipDb: dip(before, chunks), normalDipDb: dip(before, before),
            newHeard: chunks.slice(-200).some(chunk => chunk.peak >= Silent),
            oldNoteAfter50Ms: notes.after50, oldNoteAfter300Ms: notes.after300})
        project.editing.modify(() => remaining.solo.setValue(false))
    }
    return cases
}

type Step = (name: string, edit: () => void) => Promise<void>

// The instrument as layer 1 of a composite, with the unit's effects left on the unit (wrapping moves them onto the
// layer), so they apply to every layer.
const wrap = (project: Project, rig: Rig): InstrumentCompositeCellBox => {
    const {api} = project
    const {cellBox} = attempt(api.wrapInstrumentIntoComposite(rig.instrumentBox))
    api.moveEffects(rig.audioUnitBox.midiEffects, IndexedBox.collectIndexedBoxes(cellBox.midiEffects) as ReadonlyArray<EffectBox>, 0)
    api.moveEffects(rig.audioUnitBox.audioEffects, IndexedBox.collectIndexedBoxes(cellBox.audioEffects) as ReadonlyArray<EffectBox>, 0)
    return cellBox
}

const crossfadeLayers = async (project: Project, rig: Rig, step: Step,
                               prewrapped: InstrumentCompositeCellBox | null): Promise<void> => {
    const {api, boxAdapters} = project
    let cells: { old: InstrumentCompositeCellBoxAdapter, added: InstrumentCompositeCellBoxAdapter } | null = null
    await step(prewrapped === null ? "wrap into layers, add layer at -inf" : "add layer at -inf", () => {
        const cellBox = prewrapped ?? wrap(project, rig)
        const composite = cellBox.composite.targetVertex.unwrap().box
        if (!(composite instanceof InstrumentCompositeBox)) {throw new Error("layer outside a composite")}
        const {cellBox: added, instrumentBox} = attempt(api.createCompositeLayer(composite, To))
        withTail(instrumentBox)
        added.gain.setValue(ValueMapping.DefaultDecibel.y(0))
        cells = {old: boxAdapters.adapterFor(cellBox, InstrumentCompositeCellBoxAdapter),
            added: boxAdapters.adapterFor(added, InstrumentCompositeCellBoxAdapter)}
    })
    if (cells === null) {throw new Error("layers not created")}
    const {old, added} = cells as { old: InstrumentCompositeCellBoxAdapter, added: InstrumentCompositeCellBoxAdapter }
    const start = nextBar(project)
    const lanes: Array<TrackBox> = []
    await step("crossfade the layers' gain over one bar", () => lanes.push(
        ramp(project, rig, old.namedParameter.gain, start, ZeroDb, 0),
        ramp(project, rig, added.namedParameter.gain, start, 0, ZeroDb)))
    await untilPast(project, start + PPQN.Bar)
    await step("delete layer 1 and the fade lanes", () => {
        project.api.deleteCompositeLayer(old.box)
        lanes.filter(lane => lane.isAttached()).forEach(lane => lane.delete())
        added.box.gain.setValue(0)
    })
    await sleep(1000)
}

const newTrack = async (project: Project, rig: Rig, step: Step): Promise<{ unit: AudioUnitBox, notes: { after50: boolean, after300: boolean } }> => {
    const {api} = project
    const old = rig.audioUnitBox
    const terminator = new Terminator()
    let sounding = false
    const receiver = terminator.own(new NoteStreamReceiver(project.liveStreamReceiver, old.address))
    terminator.own(receiver.subscribe(state => {
        sounding = false
        for (let note = 0; note < 128; note++) {if (state.isNoteOn(note)) {sounding = true}}
    }))
    let unit: AudioUnitBox | null = null
    await step("new unit, copy mixer and effects, move regions", () => {
        const product = api.createInstrument(To)
        withTail(product.instrumentBox)
        const target = product.audioUnitBox
        target.volume.setValue(old.volume.getValue())
        target.panning.setValue(old.panning.getValue())
        target.mute.setValue(old.mute.getValue())
        target.solo.setValue(old.solo.getValue())
        api.copyEffects(target.midiEffects, IndexedBox.collectIndexedBoxes(old.midiEffects) as ReadonlyArray<EffectBox>, 0)
        api.copyEffects(target.audioEffects, IndexedBox.collectIndexedBoxes(old.audioEffects) as ReadonlyArray<EffectBox>, 0)
        rig.trackBox.regions.pointerHub.incoming()
            .map(pointer => pointer.box)
            .filter(box => box instanceof NoteRegionBox)
            .forEach(region => region.regions.refer(product.trackBox.regions))
        api.placeAudioUnitBefore(target, Option.wrap(old.address.uuid))
        unit = target
    })
    const after50 = sounding
    await sleep(250)
    const after300 = sounding
    terminator.terminate()
    if (unit === null) {throw new Error("new unit not created")}
    const start = nextBar(project)
    const volume = project.boxAdapters.adapterFor(old, AudioUnitBoxAdapter).namedParameter.volume
    await step("fade out old unit over one bar", () => ramp(project, rig, volume, start, volume.getUnitValue(), 0))
    await untilPast(project, start + PPQN.Bar)
    await step("delete old unit", () => api.deleteAudioUnit(old))
    await sleep(1000)
    return {unit, notes: {after50, after300}}
}

// A one-bar ramp on the parameter's lane; writeAutomation's own modify joins the caller's.
const ramp = (project: Project, rig: Rig, parameter: AutomatableParameterFieldAdapter<number>, start: ppqn,
              from: number, to: number): TrackBox => {
    const region = writeAutomation(project, rig, parameter, start, PPQN.Bar, [
        {position: 0, value: from, interpolation: Interpolation.Linear},
        {position: PPQN.Bar, value: to, interpolation: Interpolation.None}])
    const lane = region.regions.targetVertex.unwrap().box
    if (!(lane instanceof TrackBox)) {throw new Error("automation region outside a track")}
    return lane
}

const tailRig = (project: Project, name: string): Rig => {
    const rig = createRig(project, name, Bars)
    project.editing.modify(() => {
        withTail(rig.instrumentBox)
        for (let beat = 0; beat < Bars * 4; beat++) {
            project.api.createNoteEvent({owner: rig.region, position: beat * PPQN.Quarter, duration: PPQN.Quarter / 4,
                pitch: 60, velocity: 0.8})
        }
    })
    return rig
}

const withTail = (box: Box): void => {
    if (box instanceof VaporisateurDeviceBox) {box.release.setValue(ReleaseSeconds)}
}

const attempt = <T>(value: { isFailure(): boolean, failureReason(): string, result(): T }): T => {
    if (value.isFailure()) {throw new Error(value.failureReason())}
    return value.result()
}

// Waits until the playhead (as the main thread sees it) is IntoNoteMs past a beat.
const intoNote = async (project: Project): Promise<void> => {
    while (true) {
        const into = ppqnToMs(project, position(project) % PPQN.Quarter)
        if (into >= IntoNoteMs && into < IntoNoteMs + 20) {return}
        await new Promise(resolve => requestAnimationFrame(resolve))
    }
}

// The first bar line at least 200 ms ahead.
const nextBar = (project: Project): ppqn =>
    Math.ceil((position(project) + msToPpqn(project, 200)) / PPQN.Bar) * PPQN.Bar

const untilPast = async (project: Project, at: ppqn): Promise<void> => {
    while (position(project) < at + msToPpqn(project, 200)) {await sleep(20)}
}

const dip = (before: ReadonlyArray<Chunk>, chunks: ReadonlyArray<Chunk>): number => {
    const reference = meanRms(before)
    let lowest = Infinity
    for (let index = 0; index + 8 <= chunks.length; index++) {lowest = Math.min(lowest, meanRms(chunks.slice(index, index + 8)))}
    return reference === 0 || !Number.isFinite(lowest) ? 0 : round(20 * Math.log10(Math.max(lowest, 1e-9) / reference), 1)
}
