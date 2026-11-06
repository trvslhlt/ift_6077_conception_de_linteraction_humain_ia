import {readFileSync} from "node:fs"
import type {Snapshot} from "../../shared/protocol.ts"

// The device catalog (STRATEGY.md, "What agents know"), in two files keyed alike, by device type as the snapshot
// names it: catalog/generated.json, read from openDAW by `make catalog` (names, descriptions, parameters, whether
// agents may add it), and catalog/devices.json, written by hand (what a producer weighs when choosing it).

export type DeviceNotes = {
    kind: "instrument" | "midi effect" | "audio effect"
    sound: string, roles: string[], genres: string[], evokes: string[], words: string[], limits: string
    opaque?: boolean
}
export type CatalogParameter = {
    path: string, name: string, min: string, max: string, default: string, stepped: boolean, values?: string[]
    range: [number, number], value: number           // in the parameter's own units, as requests write them
}
export type GeneratedDevice = {
    key: string, factory: string, kind: DeviceNotes["kind"], name: string, brief: string, description: string,
    manualPage: string, allowed: boolean, parameters: CatalogParameter[], settings: string[]
}
// What a model gets about a device in its context: openDAW's name and descriptions, then the hand-written notes.
// Parameters stay out (Tubular alone is ~5k tokens); they come from a lookup.
export type DeviceSummary = Pick<GeneratedDevice, "name" | "brief" | "description" | "allowed"> & Partial<DeviceNotes>
export type Catalog = {
    summary(key: string): DeviceSummary | null
    device(key: string): GeneratedDevice | null
    devices(): GeneratedDevice[]
    opendaw: string
}

const Fields = ["kind", "sound", "roles", "genres", "evokes", "words", "limits"] as const

// Throws on a malformed note or on the halves disagreeing about which devices exist, so a bad edit or a stale
// generated file shows at startup rather than as a vague overview.
export const loadCatalog = (notesPath: string, generatedPath: string): Catalog => {
    const notes = (JSON.parse(readFileSync(notesPath, "utf8")) as { devices: Record<string, DeviceNotes> }).devices
    const generated = JSON.parse(readFileSync(generatedPath, "utf8")) as
        { opendaw: string, devices: Record<string, GeneratedDevice> }
    for (const [key, entry] of Object.entries(notes)) {
        const missing = Fields.filter(field => entry[field] === undefined)
        if (missing.length > 0) {throw new Error(`catalog ${notesPath}: ${key} lacks ${missing.join(", ")}`)}
    }
    const unmatched = [...Object.keys(notes).filter(key => !(key in generated.devices)).map(key => `${key} (notes only)`),
        ...Object.keys(generated.devices).filter(key => !(key in notes)).map(key => `${key} (no notes)`)]
    if (unmatched.length > 0) {throw new Error(`catalog halves disagree: ${unmatched.join(", ")}`)}
    const summary = (key: string): DeviceSummary | null => {
        const device = generated.devices[key]
        if (device === undefined) {return null}
        const {name, brief, description, allowed} = device
        return {name, brief, description, allowed, ...notes[key]}
    }
    return {summary, device: key => generated.devices[key] ?? null, devices: () => Object.values(generated.devices),
        opendaw: generated.opendaw}
}

// The summaries of every device in the project, by key, for a model's context. Unknown keys get null, so the model
// knows the catalog has nothing on them.
export const summariesForProject = (catalog: Catalog, snapshot: Snapshot): Record<string, DeviceSummary | null> => {
    const keys = new Set<string>()
    snapshot.tracks.forEach(track => {
        if (track.device !== null) {keys.add(track.device.key)}
        track.midiEffects.forEach(device => keys.add(device.key))
        track.effects.forEach(device => keys.add(device.key))
    })
    snapshot.master.effects.forEach(device => keys.add(device.key))
    return Object.fromEntries([...keys].sort().map(key => [key, catalog.summary(key)]))
}
