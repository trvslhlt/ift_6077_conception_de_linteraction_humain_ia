import {readdirSync, readFileSync, statSync} from "node:fs"
import {join, relative} from "node:path"

// openDAW's source, readable by the utility (EXPERIMENTS.md, G: reading it made the difference when Claude Code worked
// live). The pinned, patched tree the studio runs, copied out by `make types` and mounted read-only. Indexed in memory
// on first use: ~2,200 TypeScript files and the manual's pages, ~11 MB.

const Extensions = /\.(ts|tsx|md)$/
const Skipped = new Set(["node_modules", "dist", ".git", "coverage"])
const MaxMatches = 40
const MaxLineLength = 220
const MaxReadLines = 150

type File = { path: string, lines: string[] }

export class Source {
    readonly #root: string
    #files: File[] | null = null

    constructor(root: string) {this.#root = root}

    available(): boolean {
        try {return statSync(this.#root).isDirectory()} catch {return false}
    }

    #index(): File[] {
        if (this.#files !== null) {return this.#files}
        const files: File[] = []
        const walk = (dir: string): void => {
            for (const entry of readdirSync(dir, {withFileTypes: true})) {
                if (Skipped.has(entry.name)) {continue}
                const path = join(dir, entry.name)
                if (entry.isDirectory()) {walk(path)} else if (Extensions.test(entry.name)) {
                    files.push({path: relative(this.#root, path), lines: readFileSync(path, "utf8").split("\n")})
                }
            }
        }
        walk(this.#root)
        this.#files = files
        return files
    }

    // Lines matching a regular expression (case-insensitive), in files whose path contains `within`.
    search(pattern: string, within: string): string {
        if (!this.available()) {return "openDAW's source isn't available here (run `make types`)."}
        let regex: RegExp
        try {regex = new RegExp(pattern, "i")} catch (error) {return `Not a valid regular expression: ${String(error)}`}
        const matches: string[] = []
        let total = 0
        for (const file of this.#index()) {
            if (within !== "" && !file.path.includes(within)) {continue}
            file.lines.forEach((line, index) => {
                if (!regex.test(line)) {return}
                total++
                if (matches.length < MaxMatches) {matches.push(`${file.path}:${index + 1}: ${line.trim().slice(0, MaxLineLength)}`)}
            })
        }
        if (total === 0) {return "No matches."}
        return `${matches.join("\n")}${total > MaxMatches ? `\n… ${total - MaxMatches} more; narrow the pattern or the path` : ""}`
    }

    // Lines of one file, numbered, from a 1-based line.
    read(path: string, from: number, count: number): string {
        if (!this.available()) {return "openDAW's source isn't available here (run `make types`)."}
        const file = this.#index().find(file => file.path === path) ?? this.#index().find(file => file.path.endsWith(path))
        if (file === undefined) {return `No file ${path}; search for it first.`}
        const start = Math.max(1, from), end = Math.min(file.lines.length, start + Math.min(MaxReadLines, Math.max(1, count)) - 1)
        const body = file.lines.slice(start - 1, end).map((line, index) => `${start + index}: ${line}`).join("\n")
        return `${file.path} (lines ${start}–${end} of ${file.lines.length})\n${body}`
    }
}
