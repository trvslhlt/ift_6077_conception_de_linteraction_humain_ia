import {existsSync, readFileSync} from "node:fs"
import {join} from "node:path"

// TakeDo's sample collections (`make samples`: samples/manifest.json, knowledge/import/samples.mjs), as agents name
// them: "<machine>/<folder code>/<file stem>" ("RolandTR808/bd/BD0010"). The page loads a sample by its UUID from the
// studio's /sample-collections (page/Samples.ts), so a project naming one can always get it back.
export type Sample = {
    id: string, uuid: string, file: string, machine: string | null, role: string | null, name: string,
    duration: number, sample_rate: number
}
export type Samples = {
    readonly size: number
    find(id: string): Sample | null
    // Samples matching all of: a machine (any part of its name), a role (kick, snare, closed hat, ...), words in the id.
    search(query: { machine?: string, role?: string, words?: string }, limit: number): Sample[]
    machines(): Array<{ machine: string, count: number, roles: string[] }>
}

const idOf = (file: string, machine: string | null): string => {
    const parts = file.replace(/\.wav$/i, "").split("/").slice(1)   // drop the collection
    if (machine !== null && parts.length >= 3 && parts[1].toLowerCase().startsWith(`${machine.toLowerCase()}-`)) {parts[1] = parts[1].slice(machine.length + 1)}
    return parts.join("/")
}

export const loadSamples = (dir: string): Samples => {
    const path = join(dir, "manifest.json")
    const list: Sample[] = existsSync(path)
        ? (JSON.parse(readFileSync(path, "utf8")).samples as Array<Omit<Sample, "id">>).map(sample => ({...sample, id: idOf(sample.file, sample.machine)}))
        : []
    const byId = new Map(list.map(sample => [sample.id.toLowerCase(), sample]))
    const has = (text: string | null, part: string): boolean => (text ?? "").toLowerCase().includes(part.toLowerCase())
    return {
        get size() {return list.length},
        find: id => byId.get(id.toLowerCase()) ?? null,
        search: ({machine, role, words}, limit) => {
            const terms = (words ?? "").toLowerCase().split(/\s+/).filter(term => term.length > 0)
            return list.filter(sample => (machine === undefined || machine === "" || has(sample.machine, machine))
                && (role === undefined || role === "" || (sample.role ?? "").toLowerCase() === role.toLowerCase())
                && terms.every(term => has(sample.id, term) || has(sample.role, term))).slice(0, limit)
        },
        machines: () => {
            const machines = new Map<string, { count: number, roles: Set<string> }>()
            list.forEach(sample => {
                const key = sample.machine ?? "other"
                if (!machines.has(key)) {machines.set(key, {count: 0, roles: new Set()})}
                const entry = machines.get(key)!
                entry.count++
                if (sample.role !== null) {entry.roles.add(sample.role)}
            })
            return [...machines].map(([machine, {count, roles}]) => ({machine, count, roles: [...roles].sort()}))
        }
    }
}
