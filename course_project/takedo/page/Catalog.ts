import {Box, Field, PrimitiveField} from "@opendaw/lib-box"
import {
    AutomatableParameterFieldAdapter, DeviceFactory, Devices, InstrumentFactories, InstrumentFactory
} from "@opendaw/studio-adapters"
import {EffectFactories, EffectFactory, type Project} from "@opendaw/studio-core"
import {deviceKey} from "./Adapter"

// The generated half of the device catalog (STRATEGY.md, "What agents know"), read from openDAW itself: each device is
// created in the open project, read and deleted again (the engine is stopped first). From its factory: name,
// descriptions, manual page, and whether agents may add it. From its adapter: each automatable parameter with its
// path, name, range and default as the UI prints them (every value, for one with few steps). Settings: the box's
// other values, which agents could set but not automate. Ported from poc/edit_bench (src/Catalog.ts, Allowed.ts).
// `make catalog` runs it in a fresh project and writes catalog/generated.json; catalog/devices.json is the
// hand-written half, keyed the same way (the box name without "DeviceBox" or "Box", as snapshots name devices).

// min, max, default: as the UI prints them. range, value: in the parameter's own units, as requests write them.
export type CatalogParameter = {
    path: string, name: string, min: string, max: string, default: string, stepped: boolean,
    values?: ReadonlyArray<string>, range: [number, number], value: number
}
export type CatalogDevice = {
    key: string, factory: string, kind: "instrument" | "audio effect" | "midi effect", name: string, brief: string,
    description: string, manualPage: string, allowed: boolean, parameters: ReadonlyArray<CatalogParameter>,
    settings: ReadonlyArray<string>
}
export type CatalogResult = {
    devices: ReadonlyArray<CatalogDevice>
    failures: ReadonlyArray<{ factory: string, error: string }>
}

const MaxSteps = 32
// In the parameter's own units, finite (JSON has no infinity): -∞ dB becomes -96.
export const numeric = (value: unknown): number => {
    const number = typeof value === "boolean" ? (value ? 1 : 0) : Number(value)
    return Number.isFinite(number) ? number : number < 0 ? -96 : 96
}
// Fields every device has, for the UI or for wiring rather than for sound.
const Bookkeeping = new Set(["label", "icon", "enabled", "minimized", "index"])

// Off limits, since what they do depends on something undocumented (STRATEGY.md, "Agents change devices"): plugins,
// external hardware, user scripts and downloaded amp models.
const OffLimits: ReadonlyArray<DeviceFactory> = [InstrumentFactories.Apparat, InstrumentFactories.MIDIOutput,
    EffectFactories.Spielwerk, EffectFactories.Werkstatt, EffectFactories.NeuralAmp,
    ...[InstrumentFactories.Named, EffectFactories.MidiNamed, EffectFactories.AudioNamed].flatMap(named =>
        Object.entries(named).filter(([name]) => name.startsWith("Wclap")).map(([, factory]) => factory))]

export const generateCatalog = (project: Project): CatalogResult => {
    project.engine.stop()
    const devices: Array<CatalogDevice> = []
    const failures: Array<{ factory: string, error: string }> = []
    const attempt = (factory: string, read: () => CatalogDevice): void => {
        try {
            devices.push(read())
        } catch (error) {
            failures.push({factory, error: error instanceof Error ? error.message : String(error)})
        }
    }
    const instruments: ReadonlyArray<[string, InstrumentFactory]> = Object.entries(InstrumentFactories.Named)
    for (const [name, factory] of instruments) {
        attempt(name, () => {
            const {audioUnitBox, instrumentBox} = project.editing.modify(() =>
                project.api.createInstrument(factory)).unwrap()
            try {
                return describe(project, name, "instrument", factory, instrumentBox)
            } finally {
                project.editing.modify(() => project.api.deleteAudioUnit(audioUnitBox))
            }
        })
    }
    const host = project.editing.modify(() => project.api.createInstrument(InstrumentFactories.Vaporisateur)).unwrap()
    const effects: ReadonlyArray<[string, EffectFactory]> = [
        ...Object.entries(EffectFactories.MidiNamed), ...Object.entries(EffectFactories.AudioNamed)]
    for (const [name, factory] of effects) {
        attempt(name, () => {
            const field = factory.type === "audio" ? host.audioUnitBox.audioEffects : host.audioUnitBox.midiEffects
            const box = project.editing.modify(() => project.api.insertEffect(field, factory)).unwrap()
            try {
                return describe(project, name, factory.type === "audio" ? "audio effect" : "midi effect", factory, box)
            } finally {
                project.editing.modify(() =>
                    Devices.deleteEffectDevices([project.boxAdapters.adapterFor(box, Devices.isEffect)]))
            }
        })
    }
    project.editing.modify(() => project.api.deleteAudioUnit(host.audioUnitBox))
    return {devices, failures}
}

const describe = (project: Project, factoryName: string, kind: CatalogDevice["kind"], factory: DeviceFactory,
                  box: Box): CatalogDevice => {
    project.boxAdapters.adapterFor(box, Devices.isAny) // its parameters register when the adapter is made
    const parameters: Array<CatalogParameter> = []
    const settings: Array<string> = []
    for (const field of primitives(box.fields())) {
        const path = box.mapFields(field => field.fieldName, ...field.address.fieldKeys).join("/")
        project.parameterFieldAdapters.opt(field.address).match({
            none: () => {if (!Bookkeeping.has(path)) {settings.push(path)}},
            some: adapter => parameters.push(parameter(path, adapter))
        })
    }
    return {key: deviceKey(box), factory: factoryName, kind, name: factory.defaultName, brief: factory.briefDescription,
        description: factory.description, manualPage: factory.manualPage, allowed: !OffLimits.includes(factory),
        parameters, settings}
}

export const primitives = (fields: ReadonlyArray<Field>): Array<PrimitiveField> =>
    fields.flatMap(field => field.accept<Array<PrimitiveField>>({
        visitPrimitiveField: field => field.deprecated ? [] : [field],
        visitArrayField: field => primitives(field.fields()),
        visitObjectField: field => primitives(field.fields())
    }) ?? [])

const parameter = (path: string, adapter: AutomatableParameterFieldAdapter): CatalogParameter => {
    const {valueMapping, stringMapping} = adapter
    const print = (value: unknown): string => {
        const {value: text, unit} = stringMapping.x(value as never)
        return unit === "" ? text : `${text} ${unit}`
    }
    const min = valueMapping.y(0), max = valueMapping.y(1)
    const stepped = !valueMapping.floating()
    const steps = typeof min === "boolean" ? [false, true]
        : typeof min === "number" && typeof max === "number" && stepped && max - min <= MaxSteps
            ? Array.from({length: max - min + 1}, (_, index) => min + index) : null
    return {path, name: adapter.name, min: print(min), max: print(max), default: print(adapter.getValue()),
        stepped, ...(steps === null ? {} : {values: steps.map(print)}), range: [numeric(min), numeric(max)],
        value: numeric(adapter.getValue())}
}
