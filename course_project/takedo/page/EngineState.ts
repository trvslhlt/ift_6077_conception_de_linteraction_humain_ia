import {SyncStream} from "@opendaw/lib-std"
import {EngineStateSchema} from "@opendaw/studio-adapters"

// The engine's state channel to the page (openDAW's SyncStream: one shared buffer whose first byte is a flag the
// worklet and the page hand back and forth). The stalls (2026-11-23..26: playhead frozen, "playing", the audio clock
// running) fit a flag that stopped changing hands: the page's read threw midway (a playhead subscriber), so the flag
// stayed "reading" and the engine never wrote again; or the frame loop stopped reading; or the engine stopped writing.
// So the engine's reader is wrapped here: a throw in its read is reported and can't hold the flag, and the watchdog
// can say which side stopped and hand the flag back. Installed before any engine starts (TakeDoHost imports it).

const Flags = ["reading", "read", "writing", "written"] as const
export type ChannelState = typeof Flags[number]

let engine: { reader: SyncStream.Reader, flags: Uint8Array } | null = null
let onThrow: (text: string) => void = () => {}
export const onStateReadError = (report: (text: string) => void): void => {onThrow = report}

const original = SyncStream.reader
const engineBytes = EngineStateSchema().bytesTotal
;(SyncStream as { reader: typeof SyncStream.reader }).reader = (io, procedure) => {
    const isEngine = io.bytesTotal === engineBytes
    const reader = original(io, state => {
        try {procedure(state)} catch (error) {
            if (!isEngine) {throw error}
            onThrow(`the engine state's read threw: ${error instanceof Error ? `${error.message} ${error.stack ?? ""}` : String(error)}`.slice(0, 800))
        }
    })
    if (isEngine) {engine = {reader, flags: new Uint8Array(reader.buffer)}}
    return reader
}

export const channelState = (): ChannelState | null => engine === null ? null : Flags[Atomics.load(engine.flags, 0)] ?? null

// A stall's repair from the page's side: a flag left "reading" is handed back to the engine, and a state the engine
// wrote but nothing read is read now. "read" (the engine stopped writing) and "writing" can't be fixed from here.
export const unstick = (): string | null => {
    const state = channelState()
    if (engine === null || state === null) {return null}
    if (state === "reading") {
        Atomics.store(engine.flags, 0, Flags.indexOf("read"))
        return "the page's read had stopped midway (the flag left at reading): handed back to the engine"
    }
    if (state === "written") {
        engine.reader.tryRead()
        return "the engine had written a state nothing read (openDAW's frame loop stopped reading): read it"
    }
    return null
}

// `make state-probe` only: leave the flag at "reading", as a read that threw midway did before the wrap.
export const stickForProbe = (): void => {if (engine !== null) {Atomics.store(engine.flags, 0, Flags.indexOf("reading"))}}
