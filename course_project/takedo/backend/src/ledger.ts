// The activity ledger (decided 2026-11-24, ARCHITECTURE.md "Ownership"): every agent edit that landed, with the piece
// and direction it belongs to and what it changed (shared/touched.ts), values with what they replaced. Dials are views
// over directions (the one that offered the dial, and each move of it). It's what lets a dial's move take back only
// its own work (max A, max B, min A keeps B) and, later, a row of the activity be rolled back. Recorded only, for now.
// One file per opening of a project, archived with its notebook.
import {existsSync, readFileSync, writeFileSync} from "node:fs"
import type {Actor, Plan, Status} from "../../shared/protocol.ts"
import {nothingTouched, type Touched} from "../../shared/touched.ts"

// Where a request belongs: its direction (a producer's message or a dial move), the piece (job) and the board's step.
export type Activity = { direction: string, job?: string, step?: string }
export type Entry = { request: string, t: number, agent: Actor, says: string, op: Plan["op"], touched: Touched } & Activity

const none = (): Touched => ({values: [], notes: [], regions: [], tracks: [], effects: [], switches: []})

// What a landed request changed: a script says (the page compares the project before and after); a fixed operation's
// result has its value's from and to, or the effect it added or removed.
export const touchedBy = (plan: Plan, status: Status): Touched => {
    const result = status.result
    if (result?.touched !== undefined) {return result.touched}
    const touched = none()
    if ((plan.op === "set" || plan.op === "ramp") && result?.from !== undefined && result.to !== undefined) {
        touched.values.push({ref: result.ref, from: result.from, to: result.to})
    }
    if (plan.op === "add_effect" && result !== undefined) {touched.effects.push({ref: result.ref, change: "added"})}
    if (plan.op === "remove_effect") {touched.effects.push({ref: plan.ref, change: "removed"})}
    return touched
}

// What a set of entries owns, by kind and ref: "notes t1", "value t2.mix.volume", "effect t1.fx2", "tempo", "loop".
export const ownedBy = (entries: ReadonlyArray<Entry>): Set<string> => {
    const owned = new Set<string>()
    entries.forEach(({touched}) => {
        touched.values.forEach(({ref}) => owned.add(`value ${ref}`))
        touched.notes.forEach(({track}) => owned.add(`notes ${track}`))
        touched.regions.forEach(({track}) => owned.add(`regions ${track}`))
        touched.tracks.forEach(({ref}) => owned.add(`track ${ref}`))
        touched.effects.forEach(({ref}) => owned.add(`effect ${ref}`))
        touched.switches.forEach(({ref}) => owned.add(`switch ${ref}`))
        if (touched.tempo !== undefined) {owned.add("tempo")}
        if (touched.loop !== undefined) {owned.add("loop")}
    })
    return owned
}

export class Ledger {
    readonly #file: string | null
    #entries: Entry[] = []
    #dials: Record<string, string[]> = {}       // a dial's ref → its directions

    readonly #log: (data: Record<string, unknown>) => void

    constructor(file: string | null, log: (data: Record<string, unknown>) => void = () => {}) {
        this.#file = file
        this.#log = log
        if (file === null || !existsSync(file)) {return}
        try {
            const stored = JSON.parse(readFileSync(file, "utf8")) as { entries: Entry[], dials: Record<string, string[]> }
            this.#entries = stored.entries
            this.#dials = stored.dials
        } catch {/* unreadable: start empty */}
    }

    // An edit that landed; nothing recorded when it changed nothing.
    record(entry: Entry): boolean {
        if (nothingTouched(entry.touched)) {return false}
        this.#entries.push(entry)
        this.#save()
        return true
    }

    dial(ref: string, direction: string): void {
        const directions = this.#dials[ref] ?? []
        if (directions.includes(direction)) {return}
        this.#dials[ref] = [...directions, direction]
        this.#log({dial: ref, direction})
        this.#save()
    }

    entries(directions?: ReadonlyArray<string>): Entry[] {
        return directions === undefined ? [...this.#entries] : this.#entries.filter(entry => directions.includes(entry.direction))
    }

    directionsOf(dial: string): string[] {return [...this.#dials[dial] ?? []]}
    get dials(): Record<string, string[]> {return {...this.#dials}}

    #save(): void {
        if (this.#file !== null) {writeFileSync(this.#file, JSON.stringify({entries: this.#entries, dials: this.#dials}))}
    }
}
