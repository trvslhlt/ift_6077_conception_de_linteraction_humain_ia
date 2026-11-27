import type {Plan, Track} from "../../shared/protocol.ts"
import {roleOf} from "./mixProfiles.ts"

// A playing part's strip, there before anyone asks (2026-11-27, the producer: add the effects common for the instrument
// up front, a swing MIDI effect for drums, EQ, compressors, so slow requests become quick ones): what's there is a
// knob or a fast path away, not a member's turn. Kept small by what it costs (make strip-bench, 16 tracks: a Zeitgeist
// about free, an EQ 0.008-0.017 ms a block, a compressor 0.014-0.022 ms, an instrument 0.045-0.05 ms; bypassed costs
// as much as on): a Zeitgeist on drums, an EQ on every part, a compressor on drums and bass. Each goes in sounding like
// nothing (openDAW's defaults don't: a 40 Hz low cut, a compressor at -10 dB and 2:1, a 0.6 shuffle), so the song
// doesn't change and every later move glides from there.

// A groove's amount where it plays straight (moebiusEase at 0.5 is the identity; openDAW's default 0.6 swings).
export const StraightGroove = 0.5
export const HeavyShuffle = 0.85        // the swing dial's shuffled end
export const StripEq = [{param: "highPass/enabled", value: 1}, {param: "highPass/frequency", value: 20},
    {param: "lowPass/enabled", value: 1}, {param: "lowPass/frequency", value: 20000},
    {param: "lowShelf/enabled", value: 1}, {param: "lowShelf/gain", value: 0},
    {param: "highShelf/enabled", value: 1}, {param: "highShelf/gain", value: 0}]
export const StripCompressor = [{param: "threshold", value: 0}, {param: "ratio", value: 1}, {param: "automakeup", value: 0}]

// What a track still needs of its strip, as plans: nothing for a bus, a muted (parked) part, or what it already has.
export const stripPlans = (track: Track): Plan[] => {
    if (track.kind === "bus" || track.mix.mute) {return []}
    const role = roleOf(track)
    const has = (key: string) => track.effects.some(effect => effect.key === key)
    const plans: Plan[] = []
    const drums = role === "drums" || role === "perc"
    if (drums && track.kind === "notes" && !track.midiEffects.some(effect => effect.key === "Zeitgeist")) {
        plans.push({op: "script", description: `Swing on ${track.name} (a Zeitgeist, playing straight)`,
            code: `const box = api.insertEffect(ref(${JSON.stringify(track.ref)}).box.midiEffects, lib.core.EffectFactories.MidiNamed.Zeitgeist)\n` +
                `box.groove.targetVertex.unwrap().box.amount.setValue(${StraightGroove})`})
    }
    if (!has("Revamp")) {plans.push({op: "add_effect", track: track.ref, device: "Revamp", factory: "Revamp", settings: StripEq})}
    if ((drums || role === "bass") && !has("Compressor")) {
        plans.push({op: "add_effect", track: track.ref, device: "Compressor", factory: "Compressor", settings: StripCompressor})
    }
    return plans
}
