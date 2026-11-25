import type {Snapshot} from "../../shared/protocol.ts"
import type {Step} from "./members.ts"
import type {Triage} from "./triage.ts"

// The mix fast path (2026-11-25): a producer's message that Jev judges to be one mixer move on one part (triage.ts) is
// done by code, with no Team Lead turn: about 100 ms for Jev, against seconds for a model. Only when Jev is sure of the
// path, the part and the move (Sure, from `make triage-bench`: at 0.6 to 0.8 the one wrong pick was an exact value),
// and the message names no number (an exact value, a bar count: code can't fill those from Jev's answers, so the Team
// Lead takes them), and it isn't for later (a named bar or phrase). Everything else goes to the Team Lead as before.

// The path at 0.8 (with the chat before a message as context, a complaint, "its still muted", read as "unmute it" at 0.76);
// the part and the move at 0.7 ("undo that" after a pan: the move at 0.72).
export const SurePath = 0.8, Sure = 0.7
const MinDb = -60, MaxDb = 6
const VolumeSteps = [2, 4, 8]           // dB by Jev's amount: subtle, moderate, big; "all the way" is silence (or +6 dB)
const PanSteps = [0.25, 0.5, 0.75]      // of the way to one side; "all the way" is hard left or right
const Smooth = 2                        // beats: a volume or pan move glides, so it doesn't click
const Fade = 8                          // beats: "gradually", a fade

export type FastMix = { step: Step, says: string }

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

const capital = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1)
