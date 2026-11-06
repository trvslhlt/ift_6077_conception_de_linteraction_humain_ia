import {appendFileSync, mkdirSync, writeFileSync} from "node:fs"
import {join} from "node:path"

// The session record's log (TAKEDO_API.md, "Session record"): sessions/<id>/log.jsonl, one JSON object per line, in
// arrival order. Lines the backend adds carry the latest page seq they had seen. Checkpoint and raw updates come later.

export type LogType = "session" | "project" | "chat" | "route" | "claim" | "request" | "status" | "change" | "model"
    | "card" | "view" | "overview" | "wish"

export class SessionLog {
    readonly #file: string
    #seq = 0          // the latest page seq seen

    constructor(dir: string, session: string, meta: object) {
        mkdirSync(dir, {recursive: true})
        this.#file = join(dir, "log.jsonl")
        writeFileSync(join(dir, "session.json"), JSON.stringify({id: session, started: new Date().toISOString(), ...meta}, null, 2))
        this.write("session", {id: session})
    }

    seen(seq: number): void {this.#seq = Math.max(this.#seq, seq)}

    write(type: LogType, data: object): void {
        appendFileSync(this.#file, JSON.stringify({t: Date.now(), seq: this.#seq, type, ...data}) + "\n")
    }
}
