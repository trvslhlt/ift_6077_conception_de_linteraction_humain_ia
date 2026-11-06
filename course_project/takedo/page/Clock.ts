// Timing for applying edits that keeps running while the page is hidden. Chrome stops animation frames for a hidden
// page (another tab, a minimized window, or on macOS a window fully covered by another app) and throttles the page's
// own timers, while playback carries on. A dedicated worker's timers aren't throttled that way, so a worker ticks and
// the page does its writes on each tick. The worker only runs while someone is waiting for a tick.

const TickMs = 10
const WorkerSource = `let timer = null
onmessage = event => {
    if (event.data === "start" && timer === null) timer = setInterval(() => postMessage(0), ${TickMs})
    if (event.data === "stop" && timer !== null) { clearInterval(timer); timer = null }
}`

export class Clock {
    readonly #worker: Worker
    readonly #waiting: Array<() => void> = []
    #running = false

    constructor() {
        const url = URL.createObjectURL(new Blob([WorkerSource], {type: "text/javascript"}))
        this.#worker = new Worker(url)
        URL.revokeObjectURL(url)
        this.#worker.onmessage = () => {
            const waiting = this.#waiting.splice(0)
            waiting.forEach(resolve => resolve())
            if (this.#waiting.length === 0 && this.#running) {
                this.#worker.postMessage("stop")
                this.#running = false
            }
        }
    }

    // Resolves on the next tick, about TickMs from now, visible or not.
    tick(): Promise<void> {
        return new Promise(resolve => {
            this.#waiting.push(resolve)
            if (!this.#running) {
                this.#worker.postMessage("start")
                this.#running = true
            }
        })
    }

    terminate(): void {this.#worker.terminate()}
}
