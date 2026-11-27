import type {Control, Device} from "../../shared/protocol.ts"

// An effect's panel (2026-11-26, the producer: other control types, several dials in one control, a vintage control
// with more than one dial; toggles): the few settings a producer rides on that device, each a direct dial bound to its
// parameter between musical ends (not the parameter's whole range), and a switch that bypasses it. They share a group,
// shown as one panel on the card, and count as one control towards the card's limit.

type Knob = { param: string, label: string, low: string, high: string, from: number, to: number }
const Knobs: Record<string, Knob[]> = {
    Crusher: [{param: "crush", label: "Crunch", low: "clean", high: "crushed", from: 0, to: 0.9},
        {param: "bits", label: "Bits", low: "hi-fi", high: "lo-fi", from: 16, to: 4},
        {param: "mix", label: "Mix", low: "dry", high: "all", from: 0, to: 1}],
    Reverb: [{param: "wet", label: "Wet", low: "dry", high: "wet", from: -40, to: -4},
        {param: "decay", label: "Size", low: "small", high: "huge", from: 0.2, to: 0.95}],
    DattorroReverb: [{param: "wet", label: "Wet", low: "dry", high: "wet", from: -40, to: -4},
        {param: "decay", label: "Decay", low: "short", high: "long", from: 0.2, to: 0.95}],
    Delay: [{param: "wet", label: "Wet", low: "dry", high: "wet", from: -40, to: -4},
        {param: "feedback", label: "Repeats", low: "one", high: "many", from: 0, to: 0.8}],
    Waveshaper: [{param: "inputGain", label: "Drive", low: "clean", high: "driven", from: 0, to: 30},
        {param: "mix", label: "Mix", low: "dry", high: "all", from: 0, to: 1}],
    Tidal: [{param: "depth", label: "Depth", low: "steady", high: "pulsing", from: 0, to: 1}],
    Compressor: [{param: "threshold", label: "Squash", low: "light", high: "squashed", from: 0, to: -30},
        {param: "ratio", label: "Ratio", low: "gentle", high: "hard", from: 1.5, to: 8}],
    Revamp: [{param: "lowPass/frequency", label: "Tone", low: "dark", high: "open", from: 1500, to: 20000},
        {param: "highPass/frequency", label: "Low cut", low: "full", high: "thin", from: 20, to: 400},
        {param: "highShelf/gain", label: "Top", low: "dark", high: "bright", from: -12, to: 6},
        {param: "lowShelf/gain", label: "Body", low: "thin", high: "warm", from: -6, to: 6}]
}
export const MaxGroup = 4
// What the producer reads for a device (openDAW's names aren't musicians' words: Revamp is an EQ).
const Plain: Record<string, string> = {Revamp: "EQ", Tidal: "Tremolo", Waveshaper: "Drive", DattorroReverb: "Reverb", Maximizer: "Limiter"}
export const plainName = (device: Device): string => Plain[device.key] ?? device.name

// The device's dials (only settings it has; an EQ band only when it's switched on) and its bypass, for a card.
export const effectPanel = (device: Device, where: string): Array<Omit<Control, "owner">> => {
    const ref = device.ref
    if (ref === undefined) {return []}
    const params = device.params ?? []
    const value = (name: string): number | undefined => params.find(param => param.ref === `${ref}.${name}`)?.value
    const on = (name: string): boolean => !name.includes("/") || (value(`${name.split("/")[0]}/enabled`) ?? 0) >= 0.5
    const known = (Knobs[device.key] ?? []).filter(knob => value(knob.param) !== undefined && on(knob.param))
    // A device without a panel of its own: its wet or mix, if it has one.
    const amount = params.find(param => /\.(wet|mix)$/.test(param.ref))
    const knobs = known.length > 0 ? known : amount === undefined ? [] : [amount.ref.endsWith(".wet")
        ? {param: "wet", label: "Wet", low: "dry", high: "wet", from: -40, to: 0}
        : {param: "mix", label: "Mix", low: "dry", high: "all", from: 0, to: 1}]
    const name = plainName(device)
    const group = `${name} on ${where}`.slice(0, 40)
    const id = ref.replace(/\./g, "_")
    const dials = knobs.slice(0, MaxGroup - 1).map((knob): Omit<Control, "owner"> => ({
        ref: `c:${id}_${knob.param.replace(/\W/g, "_").toLowerCase()}`, kind: "direct", widget: "dial", group, label: knob.label,
        low: knob.low, high: knob.high, meaning: `The ${name}'s ${knob.label.toLowerCase()} on ${where}`,
        value: Math.max(0, Math.min(1, (value(knob.param)! - knob.from) / (knob.to - knob.from))),
        bind: [{ref: `${ref}.${knob.param}`, from: knob.from, to: knob.to}]}))
    const bypass: Omit<Control, "owner"> = {ref: `c:${id}_on`, kind: "direct", widget: "switch", group, label: "On",
        low: "off", high: "on", meaning: `The ${name} on ${where} switched on or bypassed`, value: device.enabled ? 1 : 0,
        bind: [{ref: `${ref}.enabled`, from: 0, to: 1}]}
    return [...dials, bypass]
}

// A card's controls counted as the producer sees them: a group is one.
export const slots = (controls: ReadonlyArray<Control>): number => new Set(controls.map(control => control.group ?? control.ref)).size
