import {Box, Field, PrimitiveField} from "@opendaw/lib-box"
import {AutomatableParameterFieldAdapter, DeviceFactory, Devices, InstrumentFactories, InstrumentFactory}
    from "@opendaw/studio-adapters"
import {EffectFactories, EffectFactory, type Project} from "@opendaw/studio-core"
import {createRig, Log} from "./Bench"
import {isAllowed} from "./Allowed"

// Check 8: a catalog of every device openDAW offers, read from openDAW itself, as agents would get it. Each device
// is created in the project, read and deleted again (the engine can stay stopped):
// - from its factory: name, the short and long descriptions, the manual page, and whether agents may add it
//   (Allowed.ts);
// - from its adapter: each automatable parameter, with its address path in the box, display name, range and default
//   as the UI prints them, the default being the value a new device starts with (and every value, for a parameter
//   with few steps);
// - settings: the box's other values (not deprecated ones), which agents could set but not automate.
// A device that can't be created or read is listed under failures.

export type CatalogParameter = {
    path: string, name: string, min: string, max: string, default: string, stepped: boolean,
    values?: ReadonlyArray<string>
}
export type CatalogDevice = {
    key: string, kind: "instrument" | "audio effect" | "midi effect", name: string, brief: string,
    description: string, manualPage: string, allowed: boolean, parameters: ReadonlyArray<CatalogParameter>,
    settings: ReadonlyArray<string>
}
export type CatalogResult = {
    devices: ReadonlyArray<CatalogDevice>
    failures: ReadonlyArray<{ key: string, error: string }>
}

const MaxSteps = 32
// Fields every device has, for the UI or for wiring rather than for sound.
const Bookkeeping = new Set(["label", "icon", "enabled", "minimized", "index"])

export const runCatalog = async (project: Project, log: Log): Promise<CatalogResult> => {
    project.engine.stop()
    const devices: Array<CatalogDevice> = []
    const failures: Array<{ key: string, error: string }> = []
    const attempt = (key: string, read: () => CatalogDevice): void => {
        try {
            const device = read()
            devices.push(device)
            log(`catalog: ${device.kind} ${device.name}: ${device.parameters.length} parameters, `
                + `${device.settings.length} settings`)
        } catch (error) {
            failures.push({key, error: error instanceof Error ? error.message : String(error)})
            log(`catalog: ${key} failed: ${failures[failures.length - 1].error}`)
        }
    }
    const instruments: ReadonlyArray<[string, InstrumentFactory]> = Object.entries(InstrumentFactories.Named)
    for (const [key, factory] of instruments) {
        attempt(key, () => {
            const {audioUnitBox, instrumentBox} = project.editing.modify(() =>
                project.api.createInstrument(factory)).unwrap()
            try {
                return describe(project, key, "instrument", factory, instrumentBox)
            } finally {
                project.editing.modify(() => project.api.deleteAudioUnit(audioUnitBox))
            }
        })
    }
    const host = createRig(project, "bench: catalog host", 1)
    const effects: ReadonlyArray<[string, EffectFactory]> = [
        ...Object.entries(EffectFactories.MidiNamed), ...Object.entries(EffectFactories.AudioNamed)]
    for (const [key, factory] of effects) {
        attempt(key, () => {
            const field = factory.type === "audio" ? host.audioUnitBox.audioEffects : host.audioUnitBox.midiEffects
            const box = project.editing.modify(() => project.api.insertEffect(field, factory)).unwrap()
            try {
                return describe(project, key, factory.type === "audio" ? "audio effect" : "midi effect", factory, box)
            } finally {
                project.editing.modify(() =>
                    Devices.deleteEffectDevices([project.boxAdapters.adapterFor(box, Devices.isEffect)]))
            }
        })
    }
    project.editing.modify(() => project.api.deleteAudioUnit(host.audioUnitBox))
    return {devices, failures}
}

const describe = (project: Project, key: string, kind: CatalogDevice["kind"], factory: DeviceFactory,
                  box: Box): CatalogDevice => {
    const allowed = isAllowed(factory as InstrumentFactory | EffectFactory)
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
    return {key, kind, name: factory.defaultName, brief: factory.briefDescription,
        description: factory.description, manualPage: factory.manualPage, allowed, parameters, settings}
}

const primitives = (fields: ReadonlyArray<Field>): Array<PrimitiveField> =>
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
        stepped, ...(steps === null ? {} : {values: steps.map(print)})}
}
