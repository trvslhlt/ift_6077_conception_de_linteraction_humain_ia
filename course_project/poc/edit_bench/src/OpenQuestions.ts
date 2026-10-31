import {Terminator, UUID} from "@opendaw/lib-std"
import {Interpolation, PPQN, ppqn} from "@opendaw/lib-dsp"
import {AudioFileBox, ConvolverDeviceBox, NanoDeviceBox, PlayfieldDeviceBox, PlayfieldSampleBox, ValueRegionBox} from "@opendaw/studio-boxes"
import {Devices, InstrumentFactories, InstrumentFactory, NoteStreamReceiver, Sample} from "@opendaw/studio-adapters"
import {EffectFactories, type Project} from "@opendaw/studio-core"
import {createRig, Log, msToPpqn, playFromStart, position, Rig, sleep, writeAutomation} from "./Bench"
import {gaps, meanRms, msUntil, OutputTap, Silent} from "./OutputTap"

// Check 10: behaviour questions left open by the live POC (project_plan/OPENDAW.md, "Checks").
// - recording: while openDAW records, is an agent's write through a parameter adapter recorded as automation, and a
//   write straight to the box field? What happens to an agent's existing lane when recording writes over it?
// - timeline end: with the loop off, does playback stop at the end of the timeline?
// - loop boundary: is a note that crosses a looping region's end heard (the suspected cause of check 2's misses)?
// - samplers: how long until Nano, Playfield and Convolver sound after a sample is assigned during playback? The
//   samples are generated here and imported through openDAW's sample service, as the library's would be.

export type RecordingResult = {
    automationEnabledByDefault: boolean
    adapterWrites: { regions: number, events: number }
    fieldWrites: { lane: boolean }
    overLane: { before: ReadonlyArray<string>, after: ReadonlyArray<string> }
}
export type SamplerCase = { device: string, msToSound: number | null, gaps: number, longestGapMs: number }
export type OpenQuestionsResult = {
    recording: RecordingResult
    timelineEnd: { endBar: string, playingAfter: boolean, positionAfter: string }
    loopBoundary: ReadonlyArray<{ note: string, heard: boolean }>
    samplers: ReadonlyArray<SamplerCase>
}

const Bars = 16

export const runOpenQuestions = async (project: Project, log: Log): Promise<OpenQuestionsResult> => {
    const recording = await recordingQuestions(project, log)
    const timelineEnd = await timelineEndQuestion(project)
    log(`questions: timeline end ${JSON.stringify(timelineEnd)}`)
    const loopBoundary = await loopBoundaryQuestion(project)
    log(`questions: loop boundary ${JSON.stringify(loopBoundary)}`)
    const samplers = await samplerQuestions(project, log)
    project.engine.stop()
    return {recording, timelineEnd, loopBoundary, samplers}
}

const recordingQuestions = async (project: Project, log: Log): Promise<RecordingResult> => {
    const {engine} = project
    const settings = engine.preferences.settings.recording
    const automationEnabledByDefault = settings.automationEnabled
    settings.automationEnabled = true
    const written = createRig(project, "bench: questions, adapter writes", Bars)
    const direct = createRig(project, "bench: questions, field writes", Bars)
    const laned = createRig(project, "bench: questions, lane", Bars)
    // An agent's lane on the third rig's volume over bars 1-8.
    writeAutomation(project, laned, laned.volume, 0, 8 * PPQN.Bar, [
        {position: 0, value: 0.3, interpolation: Interpolation.Linear},
        {position: 8 * PPQN.Bar, value: 0.9, interpolation: Interpolation.None}])
    const regionsOf = (rig: Rig): Array<string> => rig.volume.track.mapOr(track => track.regions.collection.asArray()
        .map(region => `${PPQN.toString(region.position)}-${PPQN.toString(region.position + region.duration)}`), [])
    const before = regionsOf(laned)
    await playFromStart(project)
    await sleep(300)
    project.startRecording(false)
    while (!engine.isRecording.getValue()) {await sleep(20)}
    // Bar 2 onwards (120 BPM: 2 s per bar): writes every 100 ms for 1.5 s, three ways.
    while (position(project) < PPQN.Bar) {await sleep(20)}
    for (let step = 0; step < 15; step++) {
        const value = 0.4 + 0.3 * Math.sin(step / 3)
        project.editing.modify(() => {
            written.volume.setUnitValue(value)                                    // through the adapter
            direct.audioUnitBox.volume.setValue(direct.volume.valueMapping.y(value)) // straight to the field
            laned.volume.setUnitValue(value)                                      // over the agent's lane
        })
        await sleep(100)
    }
    project.stopRecording()
    while (engine.isRecording.getValue()) {await sleep(20)}
    await sleep(200)
    engine.stop()
    settings.automationEnabled = automationEnabledByDefault
    const lane = written.volume.track
    const result: RecordingResult = {
        automationEnabledByDefault,
        adapterWrites: {
            regions: lane.mapOr(track => track.regions.collection.asArray().length, 0),
            events: lane.mapOr(track => track.regions.collection.asArray().reduce((sum, region) => {
                const box = region.box
                return sum + (box instanceof ValueRegionBox
                    ? box.events.targetVertex.mapOr(vertex => vertex.box.pointerHub.incoming().length, 0) : 0)
            }, 0), 0)
        },
        fieldWrites: {lane: direct.volume.track.nonEmpty()},
        overLane: {before, after: regionsOf(laned)}
    }
    log(`questions: recording ${JSON.stringify(result)}`)
    return result
}

const timelineEndQuestion = async (project: Project) => {
    const {engine, timelineBox} = project
    const end = timelineBox.durationInPulses.getValue()
    project.editing.modify(() => timelineBox.loopArea.enabled.setValue(false))
    engine.setPosition(end - PPQN.Bar)
    await engine.isReady()
    engine.play()
    await sleep(3500) // 120 BPM: the last bar is 2 s
    const result = {endBar: PPQN.toString(end), playingAfter: engine.isPlaying.getValue(),
        positionAfter: PPQN.toString(position(project))}
    engine.stop()
    return result
}

// A one-bar looping region; each trial inserts a note at least a second ahead: one ending past the loop's end, one
// mid-loop as a control.
const loopBoundaryQuestion = async (project: Project) => {
    const rig = createRig(project, "bench: questions, loop boundary", Bars, 1)
    const heard = new Set<number>()
    const terminator = new Terminator()
    const receiver = terminator.own(new NoteStreamReceiver(project.liveStreamReceiver, rig.audioUnitBox.address))
    terminator.own(receiver.subscribe(state => {for (let note = 0; note < 128; note++) {if (state.isNoteOn(note)) {heard.add(note)}}}))
    await playFromStart(project)
    const loop = rig.region.loopDuration.getValue()
    const duration = PPQN.SemiQuaver
    const trials: Array<{ note: string, pitch: number, local: ppqn }> = []
    for (let trial = 0; trial < 3; trial++) {
        trials.push({note: `crosses the loop end (trial ${trial + 1})`, pitch: 70 + trial, local: loop - duration / 2})
        trials.push({note: `mid-loop (trial ${trial + 1})`, pitch: 80 + trial, local: loop / 2})
    }
    for (const {pitch, local} of trials) {
        // Insert when the note is between 1 and 2 loops ahead, so it lands well within any lead time.
        const ahead = (local - (position(project) % loop) + loop) % loop
        if (ahead < msToPpqn(project, 1000)) {await sleep(500)}
        project.editing.modify(() => project.api.createNoteEvent({owner: rig.region, position: local, duration, pitch, velocity: 0.8}))
    }
    await sleep(3 * 2000)
    terminator.terminate()
    project.engine.stop()
    return trials.map(({note, pitch}) => ({note, heard: heard.has(pitch)}))
}

const samplerQuestions = async (project: Project, log: Log): Promise<ReadonlyArray<SamplerCase>> => {
    const tap = OutputTap.create()
    const tone = await importSample(project, "bench tone", wav(1, t => Math.sin(2 * Math.PI * 440 * t) * Math.exp(-t * 3)))
    const ir = await importSample(project, "bench impulse", wav(0.5, (t, i) => (i === 0 ? 1 : (Math.random() * 2 - 1) * 0.5) * Math.exp(-t * 8)))
    const fileBox = (sample: Sample): AudioFileBox => project.boxGraph.findBox<AudioFileBox>(UUID.parse(sample.uuid))
        .unwrapOrElse(() => AudioFileBox.create(project.boxGraph, UUID.parse(sample.uuid), box => {
            box.fileName.setValue(sample.name)
            box.endInSeconds.setValue(sample.duration)
        }))
    const pulse = (rig: { region: Rig["region"] }, pitch: number) => project.editing.modify(() => {
        for (let eighth = 0; eighth < Bars * 8; eighth++) {
            project.api.createNoteEvent({owner: rig.region, position: eighth * PPQN.Quarter / 2, duration: PPQN.SemiQuaver, pitch, velocity: 0.9})
        }
    })
    const instrumentRig = (name: string, factory: InstrumentFactory) =>
        project.editing.modify(() => {
            const product = project.api.createInstrument(factory)
            const region = project.api.createNoteRegion({trackBox: product.trackBox, position: 0, duration: Bars * PPQN.Bar, name})
            return {...product, region}
        }).unwrap()
    const solo = (units: ReadonlyArray<Rig["audioUnitBox"]>, value: boolean) =>
        project.editing.modify(() => units.forEach(unit => unit.solo.setValue(value)))
    const measure = async (device: string, assign: () => void, listen: (since: number) => number | null): Promise<SamplerCase> => {
        await sleep(600)
        const since = tap.now()
        project.editing.modify(assign)
        await sleep(2000)
        const chunks = tap.between(since, tap.now())
        const {count, longestMs} = gaps(chunks)
        const result = {device, msToSound: listen(since), gaps: count, longestGapMs: longestMs}
        log(`questions: sampler ${JSON.stringify(result)}`)
        return result
    }
    tap.start()
    try {
        const nano = instrumentRig("bench: questions, nano", InstrumentFactories.Nano)
        const playfield = instrumentRig("bench: questions, playfield", InstrumentFactories.Playfield)
        pulse(nano, 60)
        pulse(playfield, 60)
        const held = createRig(project, "bench: questions, convolver", Bars)
        project.editing.modify(() => project.api.createNoteEvent({owner: held.region, position: 0, duration: Bars * PPQN.Bar, pitch: 60, velocity: 0.8}))
        await playFromStart(project)
        const sounding = (since: number) => msUntil(tap.between(since, tap.now()), since, chunk => chunk.peak >= Silent)
        const cases: Array<SamplerCase> = []
        solo([nano.audioUnitBox], true)
        cases.push(await measure("Nano (sample not loaded yet)", () => {
            if (!(nano.instrumentBox instanceof NanoDeviceBox)) {throw new Error("not a Nano")}
            nano.instrumentBox.file.refer(fileBox(tone))
        }, sounding))
        solo([nano.audioUnitBox], false)
        solo([playfield.audioUnitBox], true)
        cases.push(await measure("Playfield (same sample, already loaded)", () => {
            if (!(playfield.instrumentBox instanceof PlayfieldDeviceBox)) {throw new Error("not a Playfield")}
            const device = playfield.instrumentBox
            PlayfieldSampleBox.create(project.boxGraph, UUID.generate(), box => {
                box.device.refer(device.samples)
                box.file.refer(fileBox(tone))
                box.index.setValue(60)
            })
        }, sounding))
        solo([playfield.audioUnitBox], false)
        solo([held.audioUnitBox], true)
        await sleep(500)
        const before = meanRms(tap.between(tap.now() - 0.3, tap.now()))
        cases.push(await measure("Convolver (impulse response not loaded yet)", () => {
            const convolver = project.api.insertEffect(held.audioUnitBox.audioEffects, EffectFactories.Convolver)
            project.boxAdapters.adapterFor(convolver, Devices.isEffect)
            if (!(convolver instanceof ConvolverDeviceBox)) {throw new Error("not a Convolver")}
            convolver.file.refer(fileBox(ir))
        }, since => msUntil(tap.between(since, tap.now()), since, chunk => Math.abs(20 * Math.log10((chunk.rms || 1e-9) / before)) >= 1)))
        solo([held.audioUnitBox], false)
        return cases
    } finally {
        tap.stop()
    }
}

const importSample = (project: Project, name: string, arrayBuffer: ArrayBuffer): Promise<Sample> =>
    project.env.sampleService.importFile({name, bpm: 0, arrayBuffer})

// A mono 16-bit WAV of `seconds` at 48 kHz.
const wav = (seconds: number, signal: (t: number, i: number) => number): ArrayBuffer => {
    const rate = 48000, frames = Math.round(seconds * rate)
    const view = new DataView(new ArrayBuffer(44 + frames * 2))
    const text = (at: number, value: string) => [...value].forEach((char, i) => view.setUint8(at + i, char.charCodeAt(0)))
    text(0, "RIFF"); view.setUint32(4, 36 + frames * 2, true); text(8, "WAVEfmt ")
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
    view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
    text(36, "data"); view.setUint32(40, frames * 2, true)
    for (let i = 0; i < frames; i++) {
        view.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, signal(i / rate, i))) * 32767), true)
    }
    return view.buffer
}

