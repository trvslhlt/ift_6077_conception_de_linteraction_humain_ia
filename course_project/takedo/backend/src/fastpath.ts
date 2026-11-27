import type {Device, Snapshot} from "../../shared/protocol.ts"
import type {Step} from "./members.ts"
import type {Triage} from "./triage.ts"
import {playing} from "./blend.ts"
import {hitOf, morphNotes} from "./generate.ts"
import {rolesOf, vary} from "./variants.ts"

// The mix fast path (2026-11-25): a producer's message that Jev judges to be one mixer move on one part (triage.ts) is
// done by code, with no Team Lead turn: about 100 ms for Jev, against seconds for a model. Only when Jev is sure of the
// path, the part and the move (Sure, from `make triage-bench`: at 0.6 to 0.8 the one wrong pick was an exact value),
// and the message names no number (an exact value, a bar count: code can't fill those from Jev's answers, so the Team
// Lead takes them), and it isn't for later (a named bar or phrase). Everything else goes to the Team Lead as before.

// The path at 0.8 (with the chat before a message as context, a complaint, "its still muted", read as "unmute it" at 0.76);
// the part and the move at 0.7 ("undo that" after a pan: the move at 0.72).
// An effect's part at 0.9: an effect lands on a part and is harder to take back than a level ("add a tremolo after the
// limiter", referring to an earlier "that track", was put on the master at 0.84).
export const SurePath = 0.8, Sure = 0.7, SurePart = 0.9
const MinDb = -60, MaxDb = 6
const VolumeSteps = [2, 4, 8]           // dB by Jev's amount: subtle, moderate, big; "all the way" is silence (or +6 dB)
const PanSteps = [0.25, 0.5, 0.75]      // of the way to one side; "all the way" is hard left or right
const Smooth = 2                        // beats: a volume or pan move glides, so it doesn't click
const Fade = 8                          // beats: "gradually", a fade

// also: steps landing with it (a compressor's threshold and ratio); panel: the device whose panel goes on the card after.
export type FastMix = { step: Step, says: string, also?: Step[], panel?: string }

// previous: each mix control's value before its latest change (a ref such as t1.mix.volume → its from), for "back".
export const fastMix = (judged: Triage, message: string, snapshot: Snapshot,
                        previous: Record<string, number> = {}): FastMix | null => {
    if (judged.path !== "mix" || judged.pathP < SurePath || Math.min(judged.partP, judged.moveP) < Sure) {return null}
    if (/\d/.test(message) || judged.when === "later") {return null}
    const track = snapshot.tracks.find(track => track.ref === judged.part)
    const master = judged.part === "whole_mix"
    if (track === undefined && !master) {return null}
    const name = master ? "the whole track" : track!.name
    const prefix = master ? "master" : track!.ref
    const level = Math.round(Math.max(0, Math.min(3, judged.amount)))
    const beats = judged.when === "gradual" ? Fade : Smooth
    const step = (plan: Step["plan"], says: string): FastMix => ({step: {plan, when: {at: "asap"}, says}, says})
    switch (judged.move) {
        case "back": {
            // The part's control changed last, back to where it was (a glide; a mute is a step).
            const control = ["volume", "pan", "mute"].map(name => `${prefix}.mix.${name}`).filter(ref => ref in previous).at(-1)
            if (control === undefined) {return null}
            const to = previous[control]
            const what = control.endsWith("volume") ? "level" : control.endsWith("pan") ? "pan" : "mute"
            return step(control.endsWith("mute") ? {op: "set", ref: control, to} : {op: "ramp", ref: control, to, beats},
                `${capital(name)} back to its earlier ${what}.`)
        }
        case "quieter": case "louder": {
            const now = master ? snapshot.master.volume : track!.mix.volume
            const down = judged.move === "quieter"
            const to = level === 3 ? (down ? MinDb : MaxDb)
                : Math.max(MinDb, Math.min(MaxDb, now + (down ? -1 : 1) * VolumeSteps[level]))
            if (Math.abs(to - now) < 0.5) {return null}
            const how = to <= MinDb ? "out" : `${down ? "down" : "up"} ${Math.abs(to - now).toFixed(0)} dB`
            return step({op: "ramp", ref: `${prefix}.mix.volume`, to, beats},
                `${capital(name)} ${how}${beats === Fade ? ` over ${Fade} beats` : ""}.`)
        }
        case "mute": case "unmute": {
            if (master) {return null}
            const to = judged.move === "mute" ? 1 : 0
            if (track!.mix.mute === (to === 1)) {return null}
            return step({op: "set", ref: `${prefix}.mix.mute`, to}, `${capital(name)} ${to === 1 ? "muted" : "back in"}.`)
        }
        case "pan_left": case "pan_right": case "center": {
            if (master) {return null}
            const now = track!.mix.pan
            const to = judged.move === "center" ? 0
                : Math.round(100 * Math.max(-1, Math.min(1, level === 3 ? (judged.move === "pan_left" ? -1 : 1)
                    : now + (judged.move === "pan_left" ? -1 : 1) * PanSteps[level]))) / 100
            if (Math.abs(to - now) < 0.05) {return null}
            const where = to === 0 ? "centred" : `panned ${Math.round(Math.abs(to) * 100)}% ${to < 0 ? "left" : "right"}`
            return step({op: "ramp", ref: `${prefix}.mix.pan`, to, beats}, `${capital(name)} ${where}.`)
        }
    }
}

// ---------- the effect path ----------

// One effect on one part (Jev's path "effect"): added with settings by Jev's amount (openDAW's defaults are often
// inaudible: a Waveshaper at 0 dB of drive, a Crusher at 0% crush), taken out (parked, fading), or made more or less of
// by its main control. Each entry: the device, its settings at each amount (subtle, moderate, big, extreme), and the
// control "more" and "less" move, by how much (none: those go to the Team Lead).
type EffectPlan = { device: string, at: (level: number) => Array<{ param: string, value: number }>, main?: { param: string, step: number, min: number, max: number } }
const EffectPlans: Record<string, EffectPlan> = {
    reverb: {device: "Reverb", at: level => [{param: "decay", value: [0.4, 0.5, 0.65, 0.8][level]}, {param: "wet", value: [-18, -12, -8, -4][level]}],
        main: {param: "wet", step: 5, min: -40, max: 0}},
    delay: {device: "Delay", at: level => [{param: "feedback", value: [0.25, 0.4, 0.5, 0.65][level]}, {param: "wet", value: [-18, -12, -8, -4][level]}],
        main: {param: "wet", step: 5, min: -40, max: 0}},
    distortion: {device: "Waveshaper", at: level => [{param: "inputGain", value: [6, 12, 20, 30][level]}, {param: "outputGain", value: [-3, -6, -10, -14][level]}],
        main: {param: "inputGain", step: 6, min: 0, max: 30}},
    crusher: {device: "Crusher", at: level => [{param: "crush", value: [0.2, 0.4, 0.6, 0.8][level]}, {param: "bits", value: [12, 10, 8, 6][level]}],
        main: {param: "crush", step: 0.2, min: 0, max: 0.9}},
    compressor: {device: "Compressor", at: level => [{param: "threshold", value: [-12, -18, -24, -30][level]}, {param: "ratio", value: [2, 3, 4, 8][level]}]},
    limiter: {device: "Maximizer", at: level => [{param: "threshold", value: [-2, -4, -6, -10][level]}]},
    tremolo: {device: "Tidal", at: level => [{param: "depth", value: [0.3, 0.5, 0.75, 1][level]}]}
}

export const fastEffect = (judged: Triage, message: string, snapshot: Snapshot): FastMix | null => {
    if (judged.path !== "effect" || judged.pathP < SurePath || judged.partP < SurePart || Math.min(judged.effectP, judged.actionP) < Sure) {return null}
    if (/\d/.test(message) || judged.when === "later" || judged.effect === "other") {return null}
    const plan = EffectPlans[judged.effect]
    const master = judged.part === "whole_mix"
    const track = snapshot.tracks.find(track => track.ref === judged.part)
    if (plan === undefined || (track === undefined && !master)) {return null}
    const name = master ? "the master" : track!.name
    const effects = master ? snapshot.master.effects : track!.effects
    const existing = effects.filter(effect => effect.key === plan.device && effect.enabled && effect.ref !== undefined).at(-1)
    const level = Math.round(Math.max(0, Math.min(3, judged.amount)))
    const step = (plan: Step["plan"], says: string): FastMix => ({step: {plan, when: {at: "asap"}, says}, says})
    // "More reverb" on a part with none adds one; "give it a reverb" when it has one is still an add (a second, by the amount).
    const action = judged.action === "more" && existing === undefined ? "add" : judged.action
    // A compressor already there (strips.ts: drums and bass have one, flat) is set, not doubled: "compress the bass" on a
    // flat one brings it in mild, "more" or "less" squash moves its threshold and ratio together.
    if (judged.effect === "compressor" && existing !== undefined && action !== "remove") {return squash(existing, action, level, name, step)}
    switch (action) {
        case "add":
            // A second limiter (the master has its safety one) is the Team Lead's call.
            if (judged.effect === "limiter" && existing !== undefined) {return null}
            // It enters mild (2026-11-26, the producer: not at full blast): at most the moderate setting, the subtle
            // one on the master, whatever the words ("damage"); its knob takes it further.
            return step({op: "add_effect", track: master ? "master" : track!.ref, device: plan.device, factory: plan.device, settings: plan.at(Math.min(level, master ? 0 : 1))},
                `Adding a ${judged.effect} on ${name}.`)
        case "remove":
            if (existing === undefined) {return null}
            return step({op: "remove_effect", ref: existing.ref!}, `Taking the ${judged.effect} off ${name}.`)
        case "more": case "less": {
            const main = plan.main
            const param = existing?.params?.find(param => param.ref === `${existing.ref}.${main?.param}`)
            if (main === undefined || param === undefined) {return null}
            const to = Math.max(main.min, Math.min(main.max, param.value + (action === "more" ? 1 : -1) * main.step * (level + 1) / 2))
            if (Math.abs(to - param.value) < 1e-3) {return null}
            return step({op: "ramp", ref: param.ref, to, beats: Smooth}, `${action === "more" ? "More" : "Less"} ${judged.effect} on ${name}.`)
        }
    }
}

const squash = (device: Device, action: Triage["action"], level: number, name: string,
                step: (plan: Step["plan"], says: string) => FastMix): FastMix | null => {
    const value = (param: string) => device.params?.find(candidate => candidate.ref === `${device.ref}.${param}`)?.value
    const threshold = value("threshold"), ratio = value("ratio")
    if (threshold === undefined || ratio === undefined) {return null}
    const flat = ratio <= 1.05
    if (action === "less" && flat) {return null}
    const [toThreshold, toRatio] = action === "add" || flat
        ? EffectPlans.compressor.at(Math.min(level, 1)).map(({value}) => value)
        : action === "more" ? [Math.max(-40, threshold - 6), Math.min(8, ratio + 1)] : [Math.min(0, threshold + 6), Math.max(1, ratio - 1)]
    if (Math.abs(toThreshold - threshold) < 0.5 && Math.abs(toRatio - ratio) < 0.05) {return null}
    const glide = (param: string, to: number): Step => ({plan: {op: "ramp", ref: `${device.ref}.${param}`, to, beats: Smooth}, when: {at: "asap"}, says: ""})
    const says = action === "less" ? `Less squash on ${name}.` : `${flat ? "Compressing" : "More squash on"} ${name}${flat ? " with its compressor" : ""}.`
    return {...step(glide("threshold", toThreshold).plan, says), also: [glide("ratio", toRatio)], panel: device.ref}
}

// ---------- the tone path ----------

// One part's tone on its EQ (2026-11-27, the producer: the strip's effects there up front so slow requests become
// quick ones; strips.ts gives every playing part a flat Revamp). Jev's tone answer moves one band, by its amount:
// darker closes the low-pass, brighter opens it (or lifts the top shelf once it's open), thinner raises the low cut,
// fuller lowers it (or lifts the low shelf once it's down). Only when Jev is sure of the tone and the part, the path
// isn't a mixer move, the notes aren't what's asked (a composer's or performer's "darker chords"), no number, not later.
// At 0.9 (`make triage-bench`, 2026-11-27: the 13 tones right, all but one at 0.95 or more; the nearest wrong at 0.84,
// "that bass is mostly midrange. it should be much lower" as fuller, and "more bass", a level, as fuller).
export const SureTone = 0.9
const Octaves = [1, 2, 3, 4]            // a filter's move by amount: subtle, moderate, big, extreme
const ShelfDb = [2, 4, 6, 9]            // a shelf's lift by amount (the page caps an EQ's gain at 12 dB)
const MaxShelf = 9
const OpenTop = 15000, LowestTop = 300, OpenBottom = 30, HighestCut = 1000

export const fastTone = (judged: Triage, message: string, snapshot: Snapshot): FastMix | null => {
    if (judged.tone === "none" || judged.toneP < SureTone || judged.partP < SurePart || judged.path === "mix") {return null}
    if (/\d/.test(message) || judged.when === "later" || judged.newPart >= 0.5) {return null}
    if (["composer", "performer"].includes(judged.member) && judged.memberP >= 0.5) {return null}
    const master = judged.part === "whole_mix"
    const track = snapshot.tracks.find(track => track.ref === judged.part)
    if (track === undefined && !master) {return null}
    const name = master ? "the whole track" : track!.name
    const eq = (master ? snapshot.master.effects : track!.effects).filter(effect => effect.key === "Revamp" && effect.enabled && effect.ref !== undefined).at(-1)
    if (eq === undefined) {return null}
    const value = (param: string) => eq.params?.find(candidate => candidate.ref === `${eq.ref}.${param}`)?.value
    const on = (band: string) => (value(`${band}/enabled`) ?? 0) >= 0.5
    const level = Math.round(Math.max(0, Math.min(3, judged.amount)))
    const beats = judged.when === "gradual" ? Fade : Smooth
    const glide = (param: string, to: number, says: string): FastMix | null => {
        const now = value(param)
        if (now === undefined || Math.abs(to - now) < (param.endsWith("gain") ? 0.5 : now * 0.05)) {return null}
        return {step: {plan: {op: "ramp", ref: `${eq.ref}.${param}`, to: Math.round(to), beats}, when: {at: "asap"}, says}, says, panel: eq.ref}
    }
    const top = value("lowPass/frequency"), bottom = value("highPass/frequency")
    const hz = (value: number) => value >= 1000 ? `${Number((value / 1000).toFixed(1))} kHz` : `${Math.round(value)} Hz`
    switch (judged.tone) {
        case "darker": {
            if (!on("lowPass") || top === undefined) {return null}
            const to = Math.max(LowestTop, Math.min(top, OpenTop) / 2 ** Octaves[level])
            return glide("lowPass/frequency", to, `${capital(name)} darker: its EQ's top down to ${hz(to)}.`)
        }
        case "brighter": {
            if (on("lowPass") && top !== undefined && top < OpenTop) {
                const to = Math.min(20000, top * 2 ** Octaves[level])
                return glide("lowPass/frequency", to, `${capital(name)} brighter: its EQ's top opened to ${hz(to)}.`)
            }
            const gain = value("highShelf/gain")
            if (!on("highShelf") || gain === undefined) {return null}
            return glide("highShelf/gain", Math.min(MaxShelf, gain + ShelfDb[level]), `${capital(name)} brighter: its EQ's top lifted ${ShelfDb[level]} dB.`)
        }
        case "thinner": {
            if (!on("highPass") || bottom === undefined) {return null}
            const to = Math.min(HighestCut, Math.max(bottom, 40) * 2 ** Octaves[level])
            return glide("highPass/frequency", to, `${capital(name)} thinner: its low cut up to ${hz(to)}.`)
        }
        case "fuller": {
            if (on("highPass") && bottom !== undefined && bottom > OpenBottom) {
                const to = Math.max(20, bottom / 2 ** Octaves[level])
                return glide("highPass/frequency", to, `${capital(name)} fuller: its low cut down to ${hz(to)}.`)
            }
            const gain = value("lowShelf/gain")
            if (!on("lowShelf") || gain === undefined) {return null}
            return glide("lowShelf/gain", Math.min(MaxShelf, gain + ShelfDb[level]), `${capital(name)} fuller: its EQ's low end lifted ${ShelfDb[level]} dB.`)
        }
    }
}

const capital = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1)

// The musical fast path (2026-11-25, the music-library plan, step 4): a message Jev judges to be one tweak of one part's
// notes (variants.ts: busier, sparser, more swing, an octave down...) is made by code from the part's notes, with no model
// writing notes. At 0.8 for the tweak and the part (`make tweak-bench`: 38 of 40 taken, the one wrong a request for a
// button, which the tweak question now counts as none); only when the path is the Team Lead's (a mixer move or an effect
// is theirs), with no number and not for later. Two stages, a bar apart from the next bar line, so it moves, not jumps.
export const SureTweak = 0.8
const TweakStages = 2
const TweakSays: Record<string, string> = {busier: "busier", sparser: "simpler", ghost_notes: "with ghost notes on the snare",
    swing_more: "with more swing", straighten: "straighter", halftime: "in half time", double_time: "in double time",
    fill: "with a fill at the end of the loop", harder: "played harder", softer: "played softer", octave_up: "an octave up",
    octave_down: "an octave down", shorter: "shorter, more staccato", longer: "longer, more legato"}

export type FastSteps = { steps: Step[], says: string }

// script: a page helper call as code (knowledge.ts, script), for kb.replaceNotes.
export const fastTweak = (judged: Triage, message: string, full: Snapshot, script: (call: string, args: unknown) => string | null): FastSteps | null => {
    if (judged.tweak === "none" || judged.path !== "team" || Math.min(judged.tweakP, judged.partP) < SureTweak) {return null}
    if (/\d/.test(message) || judged.when === "later" || judged.newPart >= 0.5) {return null}
    // A tweak of the notes is the composer's or the performer's: "add some space on the lead" (2026-11-26) was judged
    // sparser, but the mix engineer's (a reverb), and the lead lost notes.
    if (!["composer", "performer"].includes(judged.member) && judged.memberP >= 0.5) {return null}
    const track = full.tracks.find(candidate => candidate.ref === judged.part)
    const region = track === undefined ? null : playing(track, full)
    if (track === undefined || region === null || region.notes === undefined) {return null}
    const beatsPerBar = full.timeline.signature[0]
    const at = (pos: string) => hitOf([pos, 0, 0, 0], beatsPerBar)[0]
    const beats = region.loop !== null ? region.loop * beatsPerBar : at(region.to) - at(region.from)
    const from = region.notes.map(note => hitOf(note, beatsPerBar))
    const varied = vary(judged.tweak, {hits: from, beats, beatsPerBar, ...rolesOf(track)}, Math.round(judged.amount))
    if (typeof varied === "string") {return null}         // the Team Lead can say why, or find another way
    const fromBar = {position: full.playback.position, played: full.playback.played}
    const label = `${track.name} ${TweakSays[judged.tweak]}`
    const steps: Step[] = []
    for (const [index, notes] of morphNotes(from, varied, TweakStages).entries()) {
        const code = script("replaceNotes", {region: region.ref, notes})
        if (code === null) {return null}
        steps.push({plan: {op: "script", code, description: `${label} (${index + 1} of ${TweakStages})`},
            when: {at: "bar", bar: index + 1, from: fromBar}, says: index === TweakStages - 1 ? label : ""})
    }
    return {steps, says: `${label}, over the next ${TweakStages} bars.`}
}
