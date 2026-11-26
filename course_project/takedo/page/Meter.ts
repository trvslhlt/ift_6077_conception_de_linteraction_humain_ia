// What the page and the engine were doing, every few seconds (2026-11-26, the producer's session: a clipping artifact
// that grew over time, then the audio stopped and the playhead froze with the engine's state unread; the log couldn't
// say why). Each heartbeat carries: the engine's output as it reaches the speakers (peak, samples at or over full
// scale, NaNs: an effect blowing up), the page's frames drawn and its longest gap (openDAW's frame loop reads the
// engine's state; no frames means a hidden tab or a stuck page), the tab's visibility and the JS heap. Installed before
// any engine starts (TakeDoHost imports it): the engine's worklet is tapped when it connects to the speakers.

export type Beat = { frames: number, longestFrameMs: number, visible: boolean, peak: number, clipped: number, nan: number,
    heapMb: number | null, longTasks: number, longestTaskMs: number }

let analyser: AnalyserNode | null = null
const original = AudioNode.prototype.connect
;(AudioNode.prototype as { connect: unknown }).connect = function (this: AudioNode, destination: AudioNode | AudioParam, ...rest: number[]) {
    const result = (original as (...args: unknown[]) => unknown).call(this, destination, ...rest)
    // openDAW connects one worklet to the speakers, its engine's (class names don't survive the build's minifying).
    if (this instanceof AudioWorkletNode && destination === this.context.destination) {
        try {
            const tap = this.context.createAnalyser()
            tap.fftSize = 2048
            ;(original as (...args: unknown[]) => unknown).call(this, tap, rest[0] ?? 0)
            analyser = tap
        } catch {/* metering is optional */}
    }
    return result
}

let peak = 0, clipped = 0, nan = 0, frames = 0, longestFrameMs = 0, lastFrame = performance.now(), longTasks = 0, longestTaskMs = 0
const samples = new Float32Array(2048)
// The output, sampled ten times a second (a window each time, not every sample: enough to see it clip or go NaN).
setInterval(() => {
    if (analyser === null) {return}
    analyser.getFloatTimeDomainData(samples)
    for (const sample of samples) {
        if (Number.isNaN(sample)) {nan++; continue}
        const level = Math.abs(sample)
        if (level > peak) {peak = level}
        if (level >= 1) {clipped++}
    }
}, 100)
const frame = (now: number) => {
    frames++
    longestFrameMs = Math.max(longestFrameMs, now - lastFrame)
    lastFrame = now
    requestAnimationFrame(frame)
}
requestAnimationFrame(frame)
try {
    new PerformanceObserver(list => list.getEntries().forEach(entry => {
        longTasks++
        longestTaskMs = Math.max(longestTaskMs, entry.duration)
    })).observe({type: "longtask", buffered: false})
} catch {/* not every browser has long tasks */}

// The beat since the last one, and the counters reset. A frame gap still open counts too.
export const beat = (): Beat => {
    const memory = (performance as { memory?: { usedJSHeapSize: number } }).memory
    const result: Beat = {frames, longestFrameMs: Math.round(Math.max(longestFrameMs, performance.now() - lastFrame)),
        visible: document.visibilityState === "visible", peak: Number(peak.toFixed(3)), clipped, nan,
        heapMb: memory === undefined ? null : Math.round(memory.usedJSHeapSize / 1e6), longTasks, longestTaskMs: Math.round(longestTaskMs)}
    peak = 0; clipped = 0; nan = 0; frames = 0; longestFrameMs = 0; longTasks = 0; longestTaskMs = 0
    return result
}
