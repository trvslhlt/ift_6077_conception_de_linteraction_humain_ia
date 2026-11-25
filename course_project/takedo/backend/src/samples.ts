import {existsSync, readFileSync} from "node:fs"
import {join} from "node:path"

// TakeDo's sample collections (`make samples`: samples/manifest.json, knowledge/import/samples.mjs), as agents name
// them: "<machine>/<folder code>/<file stem>" ("RolandTR808/bd/BD0010"). The page loads a sample by its UUID from the
// studio's /sample-collections (page/Samples.ts), so a project naming one can always get it back.
export type Sample = {
    id: string, uuid: string, file: string, machine: string | null, role: string | null, name: string,
    duration: number, sample_rate: number
}
// A soundfont's preset: a sampled instrument (GeneralUser GS's 287 General MIDI sounds, openDAW's own). Named
// "<soundfont>/<preset>" ("GeneralUser GS/Fingered Bass"); index is openDAW's preset index.
export type Sound = { id: string, soundfont: string, uuid: string, file: string, preset: string, index: number, bank: number, program: number }
export type Samples = {
    readonly size: number
    readonly sounds: ReadonlyArray<Sound>
    sound(id: string): Sound | null
    // Sounds whose name has all these words ("fingered bass", "electric piano"); General MIDI's bank 0 first.
    searchSounds(words: string, limit: number): Sound[]
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
    const manifest = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as {
        samples: Array<Omit<Sample, "id">>,
        soundfonts?: Array<{ uuid: string, file: string, name: string, presets: Array<{ index: number, name: string, bank: number, program: number }> }>
    } : {samples: [], soundfonts: []}
    const list: Sample[] = manifest.samples.map(sample => ({...sample, id: idOf(sample.file, sample.machine)}))
    const sounds: Sound[] = (manifest.soundfonts ?? []).flatMap(font => font.presets.map(preset => ({id: `${font.name}/${preset.name}`,
        soundfont: font.name, uuid: font.uuid, file: font.file, preset: preset.name, index: preset.index, bank: preset.bank, program: preset.program})))
    const soundsById = new Map(sounds.map(sound => [sound.id.toLowerCase(), sound]))
    const byId = new Map(list.map(sample => [sample.id.toLowerCase(), sample]))
    const has = (text: string | null, part: string): boolean => (text ?? "").toLowerCase().includes(part.toLowerCase())
    return {
        get size() {return list.length},
        sounds,
        sound: id => soundsById.get(id.toLowerCase()) ?? sounds.find(sound => sound.preset.toLowerCase() === id.toLowerCase() && sound.bank === 0) ?? null,
        searchSounds: (words, limit) => {
            const terms = words.toLowerCase().split(/\s+/).filter(term => term.length > 0)
            // A term matches a word it contains or starts with ("fingered" finds "Finger", "pianos" finds "Piano").
            const matches = (id: string, term: string) => id.includes(term) || id.split(/[\s/&-]+/).some(word => word.length >= 4 && term.startsWith(word))
            return sounds.filter(sound => terms.every(term => matches(sound.id.toLowerCase(), term)))
                .sort((a, b) => Number(a.bank !== 0) - Number(b.bank !== 0)).slice(0, limit)
        },
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
