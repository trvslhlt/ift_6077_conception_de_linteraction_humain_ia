import {existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync} from "node:fs"
import {join} from "node:path"

// The agent's own state, outside its model context (decided 2026-11-07): notes on the conversation and the producer,
// planned changes, clips and sounds it made, scripts worth reusing, and the project as it was before the agents
// first changed it this session. Kept per project on disk, so the model's context can be cleared during a session (it
// sees the list of entries with each message and recalls what it needs), and so later fast paths (Jev) can act on
// named things ("the sweep", "the bridge chords").

export const Kinds = ["note", "plan", "clip", "sound", "script", "state"] as const
export type Kind = typeof Kinds[number]
export type Entry = { key: string, kind: Kind, summary: string, value: string, t: number }
// The utility's agent session for this project (decided 2026-11-22, STRATEGY.md): the SDK keeps the conversation on
// disk; this says which one, and the producer's message it was in the middle of, so a restarted backend resumes both.
// Kept beside the notebook, not in it: the model sees the notebook's entries.
export type AgentState = { session: string, pending: { message: string, t: number } | null }

const fileName = (project: string): string => `${project.replace(/[^\w.-]+/g, "_").slice(0, 80) || "untitled"}.json`

export class Notebook {
    readonly #file: string
    readonly #agentFile: string
    readonly #entries = new Map<string, Entry>()

    // opening: the page's id for this opening of the project. Another opening is a new working session, which starts
    // empty (2026-11-24: a project reopened from its file got the last session's notebook, board and Team Lead, which
    // planned around edits the file didn't have); the old files go to archive/. Undefined: carry on.
    constructor(dir: string, project: string, opening?: string) {
        mkdirSync(dir, {recursive: true})
        this.#file = join(dir, fileName(project))
        this.#agentFile = this.#file.replace(/\.json$/, ".agent.json")
        const openingFile = this.#file.replace(/\.json$/, ".opening")
        const previous = existsSync(openingFile) ? readFileSync(openingFile, "utf8").trim() : null
        if (opening !== undefined && previous !== opening) {
            const kept = [this.#file, this.#agentFile, this.boardFile, this.takesFile, this.ledgerFile].filter(file => existsSync(file))
            if (kept.length > 0) {
                const archive = join(dir, "archive", `${fileName(project).replace(/\.json$/, "")}-${new Date().toISOString().replace(/[:.]/g, "-")}`)
                mkdirSync(archive, {recursive: true})
                kept.forEach(file => renameSync(file, join(archive, file.slice(dir.length + 1))))
            }
            writeFileSync(openingFile, opening)
        }
        try {
            const stored = JSON.parse(readFileSync(this.#file, "utf8")) as Entry[]
            stored.forEach(entry => this.#entries.set(entry.key, entry))
        } catch {/* a new project, or an unreadable file: start empty */}
    }

    // The board's file (board.ts), beside the notebook.
    get boardFile(): string {return this.#file.replace(/\.json$/, ".board.json")}

    // The takes' file (takes.ts), beside the notebook.
    get takesFile(): string {return this.#file.replace(/\.json$/, ".takes.json")}

    // The activity ledger's file (ledger.ts), beside the notebook.
    get ledgerFile(): string {return this.#file.replace(/\.json$/, ".ledger.json")}

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

    agentState(): AgentState | null {
        try {return JSON.parse(readFileSync(this.#agentFile, "utf8")) as AgentState} catch {return null}
    }

    setAgentState(state: AgentState | null): void {
        if (state === null) {rmSync(this.#agentFile, {force: true})} else {writeFileSync(this.#agentFile, JSON.stringify(state))}
    }

    #save(): void {writeFileSync(this.#file, JSON.stringify([...this.#entries.values()], null, 1))}
}
