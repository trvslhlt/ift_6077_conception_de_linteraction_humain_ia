import {UUID} from "@opendaw/lib-std"
import {Interpolation, PPQN, ppqn} from "@opendaw/lib-dsp"
import {AudioUnitBox, NoteRegionBox, TrackBox, ValueEventBox, ValueEventCollectionBox, ValueRegionBox} from "@opendaw/studio-boxes"
import {AudioUnitBoxAdapter, AutomatableParameterFieldAdapter, InstrumentBox, InstrumentFactories, InterpolationFieldAdapter} from "@opendaw/studio-adapters"
import type {Project} from "@opendaw/studio-core"

// Shared by the checks: timing conversions, a synth "rig" to put notes and automation on, transport control, and a
// probe that measures main-thread and audio-thread cost while a check runs.

export type Log = (line: string) => void

export type Rig = {
    audioUnitBox: AudioUnitBox
    instrumentBox: InstrumentBox
    trackBox: TrackBox
    region: NoteRegionBox
    volume: AutomatableParameterFieldAdapter<number>
}

export const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

export const msToPpqn = (project: Project, ms: number): ppqn =>
    ms / 60000 * project.engine.bpm.getValue() * PPQN.Quarter

export const ppqnToMs = (project: Project, pulses: ppqn): number =>
    pulses / PPQN.Quarter / project.engine.bpm.getValue() * 60000

export const position = (project: Project): ppqn => project.engine.position.getValue()

// A Vaporisateur synth with one note region from the start of the timeline. With loopBars set, the region repeats
// its first loopBars bars for its whole length.
export const createRig = (project: Project, name: string, bars: number, loopBars?: number): Rig => {
    const {audioUnitBox, instrumentBox, trackBox, region} = project.editing.modify(() => {
        const product = project.api.createInstrument(InstrumentFactories.Vaporisateur)
        const region = project.api.createNoteRegion({
            trackBox: product.trackBox, position: 0, duration: bars * PPQN.Bar, name,
            loopDuration: (loopBars ?? bars) * PPQN.Bar
        })
        return {...product, region}
    }).unwrap()
    const volume = project.boxAdapters.adapterFor(audioUnitBox, AudioUnitBoxAdapter).namedParameter.volume
    return {audioUnitBox, instrumentBox, trackBox, region, volume}
}

// Plays from the start with the loop area off, so the playhead runs straight through the timeline.
export const playFromStart = async (project: Project): Promise<void> => {
    const {engine} = project
    engine.stop()
    project.editing.modify(() => project.timelineBox.loopArea.enabled.setValue(false))
    engine.setPosition(0)
    await engine.isReady()
    engine.play()
    const deadline = performance.now() + 5000
    while (position(project) <= 0) {
        if (performance.now() > deadline) {throw new Error("engine did not start playing")}
        await sleep(20)
    }
}

// An automation region on the parameter's lane (created if missing), holding exactly the given points.
export type Point = { position: ppqn, value: number, interpolation: Interpolation }

export const writeAutomation = (project: Project, rig: Rig, parameter: AutomatableParameterFieldAdapter<number>,
                                start: ppqn, duration: ppqn, points: ReadonlyArray<Point>): ValueRegionBox =>
    project.editing.modify(() => {
        const lane = parameter.track.match({
            none: () => project.api.createAutomationTrack(rig.audioUnitBox, parameter.field),
            some: track => track.box
        })
        const region = project.api.createTrackRegion(lane, start, duration).unwrap()
        if (!(region instanceof ValueRegionBox)) {throw new Error("automation lane made a non-value region")}
        const collection = eventCollection(region)
        collection.events.pointerHub.incoming().forEach(pointer => pointer.box.delete())
        points.forEach(point => addPoint(project, collection, point))
        return region
    }).unwrap()

export const eventCollection = (region: ValueRegionBox): ValueEventCollectionBox => {
    const box = region.events.targetVertex.unwrap().box
    if (!(box instanceof ValueEventCollectionBox)) {throw new Error("value region without an event collection")}
    return box
}

// A curve is its own box (ValueEventCurveBox), which can't be created inside another box's constructor.
export const addPoint = (project: Project, collection: ValueEventCollectionBox, point: Point): ValueEventBox => {
    const event = ValueEventBox.create(project.boxGraph, UUID.generate(), box => {
        box.position.setValue(point.position)
        box.value.setValue(point.value)
        box.index.setValue(0)
        box.events.refer(collection.events)
    })
    InterpolationFieldAdapter.write(event.interpolation, point.interpolation)
    return event
}

// Cost of whatever runs between start() and stop(). Audio thread: the engine's per-block render times (openDAW's
// DSP load measurement), against the block's real-time budget; a block over budget is a likely dropout. Main
// thread: long tasks (> 50 ms) and JS heap growth (Chromium only; coarse unless started with
// --enable-precise-memory-info).
export type PerfReport = {
    blocks: number
    overruns: number
    maxBlockMs: number
    budgetMs: number
    longTasks: number
    longTaskMs: number
    heapDeltaMb: number | null
}

type ChromePerformance = Performance & { memory?: { usedJSHeapSize: number } }

export class PerfProbe {
    readonly #project: Project
    readonly #budgetMs: number
    #running = false
    #readIndex = 0
    #blocks = 0
    #overruns = 0
    #maxBlockMs = 0
    #longTasks = 0
    #longTaskMs = 0
    #heapStart: number | null = null
    #observer: PerformanceObserver | null = null

    constructor(project: Project, sampleRate: number) {
        this.#project = project
        this.#budgetMs = 128 / sampleRate * 1000
    }

    start(): void {
        const {engine} = this.#project
        engine.preferences.settings.debug.dspLoadMeasurement = true
        this.#running = true
        this.#readIndex = engine.perfIndex
        this.#blocks = this.#overruns = this.#maxBlockMs = this.#longTasks = this.#longTaskMs = 0
        this.#heapStart = heap()
        this.#observer = new PerformanceObserver(list => list.getEntries().forEach(entry => {
            this.#longTasks++
            this.#longTaskMs += entry.duration
        }))
        try {this.#observer.observe({entryTypes: ["longtask"]})} catch {/* no long task API */}
        const read = () => {
            if (!this.#running) {return}
            this.#drain()
            requestAnimationFrame(read)
        }
        requestAnimationFrame(read)
    }

    stop(): PerfReport {
        this.#drain()
        this.#running = false
        this.#observer?.disconnect()
        return {
            blocks: this.#blocks, overruns: this.#overruns, maxBlockMs: round(this.#maxBlockMs),
            budgetMs: round(this.#budgetMs), longTasks: this.#longTasks, longTaskMs: Math.round(this.#longTaskMs),
            heapDeltaMb: heapDelta(this.#heapStart, heap())
        }
    }

    #drain(): void {
        const {perfBuffer, perfIndex} = this.#project.engine
        if (perfBuffer.length === 0) {return}
        while (this.#readIndex !== perfIndex) {
            const ms = perfBuffer[this.#readIndex]
            this.#blocks++
            if (ms > this.#budgetMs) {this.#overruns++}
            if (ms > this.#maxBlockMs) {this.#maxBlockMs = ms}
            this.#readIndex = (this.#readIndex + 1) % perfBuffer.length
        }
    }
}

const heap = (): number | null => (performance as ChromePerformance).memory?.usedJSHeapSize ?? null

const heapDelta = (start: number | null, end: number | null): number | null =>
    start === null || end === null ? null : round((end - start) / 1048576)

export const round = (value: number, digits: number = 2): number => Number(value.toFixed(digits))

export const stats = (values: ReadonlyArray<number>): { mean: number, p95: number, max: number } => {
    if (values.length === 0) {return {mean: 0, p95: 0, max: 0}}
    const sorted = [...values].sort((a, b) => a - b)
    return {
        mean: round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
        p95: round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]),
        max: round(sorted[sorted.length - 1])
    }
}
