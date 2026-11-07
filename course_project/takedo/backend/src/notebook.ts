import {mkdirSync, readFileSync, writeFileSync} from "node:fs"
import {join} from "node:path"

// The agent's own state, outside its model context (decided 2026-11-07): notes on the conversation and the producer,
// planned changes, clips and sounds it made, scripts worth reusing, and the project as it was before the agents
// first changed it this session. Kept per project on disk, so the model's context can be cleared during a session (it
// sees the list of entries with each message and recalls what it needs), and so later fast paths (Jev) can act on
// named things ("the sweep", "the bridge chords").

export const Kinds = ["note", "plan", "clip", "sound", "script", "state"] as const
export type Kind = typeof Kinds[number]
export type Entry = { key: string, kind: Kind, summary: string, value: string, t: number }

const fileName = (project: string): string => `${project.replace(/[^\w.-]+/g, "_").slice(0, 80) || "untitled"}.json`

export class Notebook {
    readonly #file: string
    readonly #entries = new Map<string, Entry>()

    constructor(dir: string, project: string) {
        mkdirSync(dir, {recursive: true})
        this.#file = join(dir, fileName(project))
        try {
            const stored = JSON.parse(readFileSync(this.#file, "utf8")) as Entry[]
            stored.forEach(entry => this.#entries.set(entry.key, entry))
        } catch {/* a new project, or an unreadable file: start empty */}
    }

    has(key: string): boolean {return this.#entries.has(key)}

    // What the model sees with each message: every entry but its value.
    list(): Array<{ key: string, kind: Kind, summary: string }> {
        return [...this.#entries.values()].sort((a, b) => a.t - b.t).map(({key, kind, summary}) => ({key, kind, summary}))
    }

    get(key: string): Entry | null {return this.#entries.get(key) ?? null}

    set(key: string, kind: Kind, summary: string, value: string): void {
        this.#entries.set(key, {key, kind, summary, value, t: Date.now()})
        this.#save()
    }

    delete(key: string): boolean {
        const deleted = this.#entries.delete(key)
        if (deleted) {this.#save()}
        return deleted
    }

    #save(): void {writeFileSync(this.#file, JSON.stringify([...this.#entries.values()], null, 1))}
}
