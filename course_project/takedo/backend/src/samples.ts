import {existsSync, readFileSync} from "node:fs"
import {join} from "node:path"

// TakeDo's sample collections (`make samples`: samples/manifest.json, knowledge/import/samples.mjs), as agents name
// them: "<machine>/<folder code>/<file stem>" ("RolandTR808/bd/BD0010"). The page loads a sample by its UUID from the
// studio's /sample-collections (page/Samples.ts), so a project naming one can always get it back.
export type Sample = {
    id: string, uuid: string, file: string, machine: string | null, role: string | null, name: string,
    duration: number, sample_rate: number
}
// An instrument sound to start a part from. A soundfont's preset: a sampled instrument (GeneralUser GS's 287 General
// MIDI sounds, openDAW's own), named "<soundfont>/<preset>" ("GeneralUser GS/Fingered Bass"), index openDAW's preset
// index. Or one of openDAW's factory presets for its synths (source "preset": samples/presets/, presets.mjs), named
// "openDAW/<preset>" ("openDAW/House Bass"), device the instrument it's for, about its own line.
export type Sound = { id: string, source: "soundfont" | "preset", soundfont: string, uuid: string, file: string, preset: string,
    index: number, bank: number, program: number, device?: string, about?: string }
// One of openDAW's factory effect presets ("Large Plate": a DattorroReverb set as a large plate).
export type EffectPreset = { id: string, uuid: string, name: string, device: string, about: string }
export type Samples = {
    readonly size: number
    readonly sounds: ReadonlyArray<Sound>
    readonly effects: ReadonlyArray<EffectPreset>
    effect(name: string): EffectPreset | null
    sound(id: string): Sound | null
    // Sounds whose name or description has all these words ("fingered bass", "electric piano"); openDAW's presets, then General MIDI's bank 0, first.
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
        soundfonts?: Array<{ uuid: string, file: string, name: string, presets: Array<{ index: number, name: string, bank: number, program: number }> }>,
        presets?: Array<{ uuid: string, file: string, name: string, category: string, device: string, about: string }>
    } : {samples: [], soundfonts: [], presets: []}
    const list: Sample[] = manifest.samples.map(sample => ({...sample, id: idOf(sample.file, sample.machine)}))
    const sounds: Sound[] = [...(manifest.soundfonts ?? []).flatMap(font => font.presets.map(preset => ({id: `${font.name}/${preset.name}`,
        source: "soundfont" as const, soundfont: font.name, uuid: font.uuid, file: font.file, preset: preset.name, index: preset.index,
        bank: preset.bank, program: preset.program}))),
        ...(manifest.presets ?? []).filter(preset => preset.category === "instrument").map(preset => ({id: `openDAW/${preset.name}`,
            source: "preset" as const, soundfont: "openDAW", uuid: preset.uuid, file: preset.file, preset: preset.name, index: 0, bank: 0,
            program: -1, device: preset.device, about: preset.about}))]
    const effects: EffectPreset[] = (manifest.presets ?? []).filter(preset => preset.category === "audio-effect")
        .map(({uuid, name, device, about}) => ({id: `openDAW/${name}`, uuid, name, device, about}))
    const soundsById = new Map(sounds.map(sound => [sound.id.toLowerCase(), sound]))
    const byId = new Map(list.map(sample => [sample.id.toLowerCase(), sample]))
    const has = (text: string | null, part: string): boolean => (text ?? "").toLowerCase().includes(part.toLowerCase())
    return {
        get size() {return list.length},
        sounds,
        effects,
        effect: name => effects.find(effect => [effect.name, effect.id].some(text => text.toLowerCase() === name.toLowerCase())) ?? null,
        sound: id => soundsById.get(id.toLowerCase()) ?? sounds.find(sound => sound.preset.toLowerCase() === id.toLowerCase() && sound.bank === 0) ?? null,
        searchSounds: (words, limit) => {
            const terms = words.toLowerCase().split(/\s+/).filter(term => term.length > 0)
            const synthy = terms.some(term => /^(synth|fm|80s|retro|analog|analogue|cz|pad|pads|pluck|arp|chiptune|8bit)/.test(term))
            // A term matches a word it contains or starts with ("fingered" finds "Finger", "pianos" finds "Piano").
            const matches = (id: string, term: string) => id.includes(term) || id.split(/[\s/&-]+/).some(word => word.length >= 4 && term.startsWith(word))
            // A factory preset is a synth sound, whatever its line says; a Rhodes or e-piano is an electric piano.
            const text = (sound: Sound): string => {
                const own = `${sound.id} ${sound.device ?? ""} ${sound.about ?? ""}`.toLowerCase()
                return sound.source !== "preset" ? own : `${own} synth${/rhodes|e-piano/.test(own) ? " electric piano" : ""}`
            }
            return sounds.filter(sound => terms.every(term => matches(text(sound), term)))
                // Words asking for a synth sound: openDAW's factory presets first (each made for its synth); otherwise the
                // sampled instruments first ("piano", "strings": the real thing). General MIDI's bank 0 before its variations.
                .sort((a, b) => (synthy ? Number(a.source !== "preset") - Number(b.source !== "preset") : Number(a.source === "preset") - Number(b.source === "preset"))
                    || Number(a.bank !== 0) - Number(b.bank !== 0)).slice(0, limit)
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
