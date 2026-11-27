import {appendFileSync, closeSync, mkdirSync, openSync, writeFileSync, writeSync} from "node:fs"
import {join} from "node:path"

// The session record's log (TAKEDO_API.md, "Session record"): sessions/<id>/log.jsonl, one JSON object per line, in
// arrival order. Lines the backend adds carry the latest page seq they had seen. Checkpoint and raw updates come later.

export type LogType = "session" | "project" | "chat" | "route" | "claim" | "request" | "status" | "change" | "model"
    | "card" | "view" | "overview" | "by_hand" | "look" | "engine" | "unsaid"
    | "agent_session" | "controls" | "control" | "board" | "take" | "activity" | "blend" | "blend_failed" | "triage" | "library" | "tweak_dial" | "heartbeat" | "strip"

// One descriptor held open, each line written at its own offset (2026-11-27: appending by reopening the file, through the
// Docker bind mount, now and then wrote at a stale end of file and overwrote lines: a status lost mid-line, a scenario
// report reading an applied edit as scheduled).
export class SessionLog {
    readonly #file: string
    #fd: number | null
    #seq = 0          // the latest page seq seen

    constructor(dir: string, session: string, meta: object) {
        mkdirSync(dir, {recursive: true})
        this.#file = join(dir, "log.jsonl")
        this.#fd = openSync(this.#file, "w")
        writeFileSync(join(dir, "session.json"), JSON.stringify({id: session, started: new Date().toISOString(), ...meta}, null, 2))
        this.write("session", {id: session})
    }

    seen(seq: number): void {this.#seq = Math.max(this.#seq, seq)}

    write(type: LogType, data: object): void {
        const line = JSON.stringify({t: Date.now(), seq: this.#seq, type, ...data}) + "\n"
        // A line after the session closed (a timer still running) is appended, as before.
        if (this.#fd === null) {appendFileSync(this.#file, line)} else {writeSync(this.#fd, line)}
    }

    close(): void {
        if (this.#fd !== null) {closeSync(this.#fd)}
        this.#fd = null
    }
}
