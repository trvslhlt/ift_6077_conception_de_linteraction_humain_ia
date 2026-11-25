import {choice, score} from "@typesafe-ai/sdk"
import type {Snapshot} from "../../shared/protocol.ts"
import type {Gateway, ModelLog} from "./gateway.ts"

// Jev in front of the Team Lead (2026-11-25, the user: Jev sits in front of every model call, the Team Lead's and each
// worker's). One request, its questions answered in parallel: what path the producer's message needs, and, in case
// it's a mixer move, which part, which move, how much and when. Code reads the mix answers only when the path is mix.
// Judged on knowledge/bench/triage.mjs (`make triage-bench`) before anything acts on it.

export const Paths = {
    mix: "One mixer move on one part, or on the whole track, and nothing else: louder or quieter, muted or unmuted, " +
        "panned left, right or back to the centre, faded in or out.",
    effect: "One audio effect on one part, or on the whole track, and nothing else: add one (reverb, echo or delay, " +
        "distortion, filter, compressor, limiter, chorus, tremolo), take one out, or make one stronger or weaker.",
    team: "Anything else, or more than one thing: a style or direction, new parts, sounds or instruments, notes, " +
        "patterns or melodies, the tempo, the arrangement (parts dropping out at a bar and coming back), a control on " +
        "the card, an exact value, a question, a complaint that something isn't working, feedback or chat."
} as const
export const Moves = {
    quieter: "quieter, down, less of it, or fading out", louder: "louder, up, more of it, or fading in",
    mute: "muted, cut, silenced", unmute: "unmuted, brought back in", pan_left: "panned to the left",
    pan_right: "panned to the right", center: "panned back to the centre"
} as const
export const When = {
    now: "right away, on the next beat or bar", gradual: "gradually, over a few beats or bars (a fade)",
    later: "at a later point: the next phrase, a section or a named bar", unspecified: "the message doesn't say when"
} as const
const Amounts = ["A subtle touch that is barely noticeable", "A clear, moderate change", "A big, obvious change",
    "All the way: silent, or hard left or right"]
const Premise = "The producer sent `message` to their AI music team while working on `project`, during playback. "

// What Jev sees of the project: each part by its name, instrument, effects and mix.
export type TriageTrack = { name: string, instrument: string | null, effects: string[], volume_db: number, muted: boolean, pan: number }
export type TriageState = { tempo: number, tracks: Record<string, TriageTrack> }
export const triageState = (snapshot: Snapshot): TriageState => ({
    tempo: snapshot.timeline.bpm,
    tracks: Object.fromEntries(snapshot.tracks.map(track => [track.ref, {name: track.name, instrument: track.instrument,
        effects: track.effects.map(effect => effect.name), volume_db: Number(track.mix.volume.toFixed(1)), muted: track.mix.mute,
        pan: Number(track.mix.pan.toFixed(2))}]))
})

export type Triage = {
    path: keyof typeof Paths, pathP: number
    part: string, partP: number                   // a track ref, or "whole_mix"
    move: keyof typeof Moves, moveP: number
    amount: number                                // 0..3 on Amounts' scale
    when: keyof typeof When
    ms: number
}

export const triage = async (gateway: Gateway, log: ModelLog, state: TriageState, message: string): Promise<Triage> => {
    const parts: Record<string, string> = Object.fromEntries(Object.entries(state.tracks).map(([ref, track]) =>
        [ref, `the ${track.name}${track.instrument ? ` (${track.instrument})` : ""}`]))
    parts.whole_mix = "the whole track, all parts together (the master)"
    const start = performance.now()
    const answers = await gateway.judge("fast_path", {project: state, message}, {
        path: choice(`${Premise}What does the message ask for?`, Paths),
        part: choice(`${Premise}Which part of the track is it about?`, parts),
        move: choice(`${Premise}If it asks for a mixer move, which one?`, Moves),
        amount: score(`${Premise}How large a change do they want?`, Amounts),
        when: choice(`${Premise}When should the change happen?`, When)
    }, log)
    const p = (answer: { choice: string, probabilities: Record<string, number> }) => answer.probabilities[answer.choice] ?? 0
    return {
        path: answers.path.choice as Triage["path"], pathP: p(answers.path),
        part: answers.part.choice, partP: p(answers.part),
        move: answers.move.choice as Triage["move"], moveP: p(answers.move),
        amount: answers.amount.score, when: answers.when.choice as Triage["when"],
        ms: Math.round(performance.now() - start)
    }
}
