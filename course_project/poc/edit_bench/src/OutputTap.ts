import {round} from "./Bench"

// The engine's audio output, as 128-sample chunks on the audio clock. openDAW keeps its engine node private, so this
// module catches it when it connects to the speakers; it must load before a project opens (it does, via TeamHost).
// An AnalyserNode is read every animation frame; its 2048-sample window (~43 ms) overlaps consecutive frames, so
// chunks are seen once each unless a frame takes longer than the window ("unobserved"). Times line up with the audio
// clock to within one audio callback (a few ms), which bounds the precision of every time measured from chunks.

export type Chunk = { time: number, peak: number, rms: number }

export const Silent = 1e-4
const WindowSize = 2048
const ChunkSize = 128

let engineNode: AudioWorkletNode | null = null
const prototype = AudioNode.prototype as unknown as { connect: (this: AudioNode, ...args: Array<unknown>) => unknown }
const connect = prototype.connect
prototype.connect = function (this: AudioNode, ...args: Array<unknown>) {
    if (this instanceof AudioWorkletNode && args[0] instanceof AudioDestinationNode) {engineNode = this}
    return connect.apply(this, args)
}

export class OutputTap {
    static create(): OutputTap {
        if (engineNode === null) {throw new Error("engine output not found (open a project after the bench loads)")}
        return new OutputTap(engineNode)
    }

    readonly #node: AudioWorkletNode
    readonly #analyser: AnalyserNode
    readonly #buffer: Float32Array<ArrayBuffer>
    readonly #chunkSeconds: number
    readonly #chunks: Array<Chunk> = []
    #lastEnd = -1
    #unobservedMs = 0
    #running = false

    private constructor(node: AudioWorkletNode) {
        this.#node = node
        this.#analyser = node.context.createAnalyser()
        this.#analyser.fftSize = WindowSize
        this.#buffer = new Float32Array(WindowSize)
        this.#chunkSeconds = ChunkSize / node.context.sampleRate
        node.connect(this.#analyser)
    }

    get unobservedMs(): number {return Math.round(this.#unobservedMs)}

    now(): number {return this.#node.context.currentTime}

    start(): void {
        this.#running = true
        const read = () => {
            if (!this.#running) {return}
            this.#read()
            requestAnimationFrame(read)
        }
        requestAnimationFrame(read)
    }

    stop(): void {
        this.#running = false
        this.#node.disconnect(this.#analyser)
    }

    between(from: number, to: number): ReadonlyArray<Chunk> {
        return this.#chunks.filter(chunk => chunk.time > from && chunk.time <= to)
    }

    #read(): void {
        this.#analyser.getFloatTimeDomainData(this.#buffer)
        const end = this.now()
        const count = WindowSize / ChunkSize
        for (let index = 0; index < count; index++) {
            const time = end - (count - 1 - index) * this.#chunkSeconds
            if (time <= this.#lastEnd + this.#chunkSeconds / 2) {continue}
            if (this.#lastEnd >= 0 && time - this.#lastEnd > this.#chunkSeconds * 1.5) {
                this.#unobservedMs += (time - this.#lastEnd - this.#chunkSeconds) * 1000
            }
            let peak = 0, sum = 0
            for (let sample = index * ChunkSize; sample < (index + 1) * ChunkSize; sample++) {
                const value = this.#buffer[sample]
                peak = Math.max(peak, Math.abs(value))
                sum += value * value
            }
            this.#chunks.push({time, peak, rms: Math.sqrt(sum / ChunkSize)})
            this.#lastEnd = time
        }
    }
}

// Silent runs between sounding chunks.
export const gapList = (chunks: ReadonlyArray<Chunk>): Array<{ start: number, ms: number }> => {
    const found: Array<{ start: number, ms: number }> = []
    let silentSince: number | null = null, heard = false
    for (const chunk of chunks) {
        if (chunk.peak < Silent) {
            if (heard && silentSince === null) {silentSince = chunk.time}
        } else {
            if (silentSince !== null) {
                found.push({start: silentSince, ms: round((chunk.time - silentSince) * 1000, 1)})
                silentSince = null
            }
            heard = true
        }
    }
    return found
}

export const gaps = (chunks: ReadonlyArray<Chunk>): { count: number, longestMs: number } => {
    const found = gapList(chunks)
    return {count: found.length, longestMs: found.reduce((longest, gap) => Math.max(longest, gap.ms), 0)}
}

export const meanRms = (chunks: ReadonlyArray<Chunk>): number =>
    chunks.length === 0 ? 0 : chunks.reduce((sum, chunk) => sum + chunk.rms, 0) / chunks.length

// Milliseconds from `since` to the first chunk that matches, or null.
export const msUntil = (chunks: ReadonlyArray<Chunk>, since: number, match: (chunk: Chunk) => boolean): number | null => {
    const found = chunks.find(chunk => chunk.time > since && match(chunk))
    return found === undefined ? null : round((found.time - since) * 1000, 1)
}
