import {choice, score} from "@typesafe-ai/sdk"
import type {Snapshot} from "../../shared/protocol.ts"
import type {Gateway, ModelLog} from "./gateway.ts"
import {isDrums} from "./analysis.ts"
import {Tweaks} from "./variants.ts"

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
    pan_right: "panned to the right", center: "panned back to the centre",
    back: "put back the way it was before the last change to it (undo a mixer move just made)"
} as const
export const Effects = {
    reverb: "reverb, a room, hall or plate, space", delay: "delay or echo, repeats", distortion: "distortion, drive, overdrive, saturation, grit",
    crusher: "a bit crusher, lo-fi crunch, sample-rate reduction", compressor: "a compressor, glue, squash, punch",
    limiter: "a limiter, so it doesn't clip or take the headroom", tremolo: "tremolo, a pulsing volume",
    other: "another effect (a filter, an EQ, chorus, phaser, a gate...), or no effect at all"
} as const
export const Actions = {
    add: "add it", remove: "take it out", more: "more of it (wetter, stronger)", less: "less of it (drier, gentler)"
} as const
export const When = {
    now: "right away, on the next beat or bar", gradual: "gradually, over a few beats or bars (a fade)",
    later: "at a later point: the next phrase, a section or a named bar", unspecified: "the message doesn't say when"
} as const
// Who a direction lands with (project_plan/TEAM.md's members, cut by what they do to the music) and the kind of control
// it merits (2026-11-26, the producer: directions land with specific members, and members offer different types of
// controls for tuning them; not a control for every direction, and a limited number). Judged on
// knowledge/bench/members.mjs (`make members-bench`).
export const Members = {
    composer: "The composer: which notes play. A new part, melody, counter-line, chords or drum pattern; busier or sparser, " +
        "simpler, ghost notes, a line's octave or rhythm, the chords changed.",
    performer: "The performer: how the notes already there are played, the notes themselves kept. Swing, timing (laid back, " +
        "pushed, tighter, looser, more human), dynamics and accents (softer, harder), articulation (staccato, legato).",
    sound_designer: "The sound designer: what one part sounds like. Its instrument or sound swapped, its tone (warmer, " +
        "brighter, darker, rounder, more analog), effects that are part of its character (distortion, crusher, chorus).",
    mix_engineer: "The mix engineer: how the parts sit together. Levels, pan, mutes, space (reverb, delay, sends), " +
        "ducking and sidechain, width, headroom and limiting, the master's sound.",
    conductor: "The conductor: time and form. The tempo, energy over time (build up, break down, a drop), parts " +
        "dropping out and coming back at bars, fills on cue, how long the song runs.",
    team: "Several members at once: a style or genre change, or a broad direction about the whole song (bigger, more " +
        "detailed, make the crowd go wild).",
    none: "Not a direction for the music: a question, a report that something is broken, missing or inaudible, an " +
        "approval or thanks, chat."
} as const
export const Controls = {
    dial: "A dial: a new direction that is a matter of degree the producer will want to keep riding (how much swing, how " +
        "wet, how far into the style, how much energy, how slow), or a knob they asked for.",
    choice: "A choice: something new made where taste decides between a few alternatives (a new melody, part or chords; " +
        "a new sound when they didn't name one).",
    switch: "A switch: a part or effect they want to drop out and bring back in by hand.",
    button: "A button: a one-shot they want to trigger on cue (a fill, a drop).",
    none: "No control: a correction of something that sounds wrong now (too harsh, too bright, too loud, closer to sine), " +
        "an exact or fully specified request (a named instrument, an octave, a bar, a value), a plain level, pan or fade " +
        "move, a question, or a report that something is broken or inaudible."
} as const
const Amounts = ["A subtle touch that is barely noticeable", "A clear, moderate change", "A big, obvious change",
    "All the way: silent, or hard left or right"]
const Premise = "The producer sent `message` to their AI music team while working on `project`, during playback; `recent` is " +
    "the conversation just before it, oldest first, for what the message refers to (\"them\", \"it\", \"more\"). "

// What Jev sees of the project: each part by its name, its role, instrument, effects and mix. The role is from its notes
// (a "full" snapshot), as the project's facts say it (Coordinator, keepFacts): a part's name often doesn't (2026-11-25:
// the bass of the jam project is "Cubed", and "bring the bass down a bit" was judged the drums').
export type Role = "drums" | "bass" | "pitched" | "no notes"
export type TriageTrack = { name: string, role?: Role, instrument: string | null, effects: string[], volume_db: number, muted: boolean, pan: number }
export type TriageState = { tempo: number, tracks: Record<string, TriageTrack> }
const roleOf = (track: Snapshot["tracks"][number]): Role | undefined => {
    if (track.regions.every(region => region.notes === undefined)) {return isDrums(track) ? "drums" : undefined}
    const pitches = track.regions.flatMap(region => region.notes ?? []).map(([, pitch]) => pitch)
    return pitches.length === 0 ? "no notes" : isDrums(track) ? "drums" : Math.max(...pitches) < 60 ? "bass" : "pitched"
}
export const triageState = (snapshot: Snapshot): TriageState => ({
    tempo: snapshot.timeline.bpm,
    tracks: Object.fromEntries(snapshot.tracks.map(track => [track.ref, {name: track.name, role: roleOf(track), instrument: track.instrument,
        effects: track.effects.map(effect => effect.name), volume_db: Number(track.mix.volume.toFixed(1)), muted: track.mix.mute,
        pan: Number(track.mix.pan.toFixed(2))}]))
})

export type Triage = {
    path: keyof typeof Paths, pathP: number
    part: string, partP: number                   // a track ref, or "whole_mix"
    move: keyof typeof Moves, moveP: number
    effect: keyof typeof Effects, effectP: number
    action: keyof typeof Actions, actionP: number
    tweak: keyof typeof Tweaks | "none", tweakP: number   // a musical tweak of the part's notes (variants.ts)
    amount: number                                // 0..3 on Amounts' scale
    when: keyof typeof When
    member: keyof typeof Members, memberP: number
    control: keyof typeof Controls, controlP: number
    ms: number
}

// The last lines of the chat before the message (2026-11-25: "bring them back up", after "lower the drums", couldn't be
// placed without them).
export type Line = { from: string, text: string }
export const RecentLines = 4

export const triage = async (gateway: Gateway, log: ModelLog, state: TriageState, message: string,
                             recent: Line[] = []): Promise<Triage> => {
    const parts: Record<string, string> = Object.fromEntries(Object.entries(state.tracks).map(([ref, track]) =>
        [ref, `the ${track.name}${track.role !== undefined ? `, the ${track.role === "pitched" ? "melodic or chordal part" : track.role === "no notes" ? "silent part" : track.role}` : ""}` +
            `${track.instrument ? ` (${track.instrument})` : ""}`]))
    parts.whole_mix = "the whole track, all parts together (the master)"
    const start = performance.now()
    const answers = await gateway.judge("fast_path", {project: state, recent: recent.slice(-RecentLines), message}, {
        path: choice(`${Premise}What does the message ask for?`, Paths),
        part: choice(`${Premise}Which part of the track is it about?`, parts),
        move: choice(`${Premise}If it asks for a mixer move, which one?`, Moves),
        effect: choice(`${Premise}If it asks about an audio effect, which kind?`, Effects),
        action: choice(`${Premise}If it asks about an audio effect, what should happen to it?`, Actions),
        tweak: choice(`${Premise}If it's one change to how one part's notes are played, made from the notes it already plays, which?`,
            {...Tweaks, none: "none of these: a new style or pattern, a new part or sound, two changes at once, the mix, effects " +
                "or tempo, a button, knob or control to play, or not about the notes"}),
        amount: score(`${Premise}How large a change do they want?`, Amounts),
        when: choice(`${Premise}When should the change happen?`, When),
        member: choice(`${Premise}Which member of the team does it land with?`, Members),
        control: choice(`${Premise}What control, if any, should the team offer the producer for tuning this direction afterwards? ` +
            "If the message asks for a control (a knob, a switch, a button), that one.", Controls)
    }, log)
    const p = (answer: { choice: string, probabilities: Record<string, number> }) => answer.probabilities[answer.choice] ?? 0
    return {
        path: answers.path.choice as Triage["path"], pathP: p(answers.path),
        part: answers.part.choice, partP: p(answers.part),
        move: answers.move.choice as Triage["move"], moveP: p(answers.move),
        effect: answers.effect.choice as Triage["effect"], effectP: p(answers.effect),
        action: answers.action.choice as Triage["action"], actionP: p(answers.action),
        tweak: answers.tweak.choice as Triage["tweak"], tweakP: p(answers.tweak),
        amount: answers.amount.score, when: answers.when.choice as Triage["when"],
        member: answers.member.choice as Triage["member"], memberP: p(answers.member),
        control: answers.control.choice as Triage["control"], controlP: p(answers.control),
        ms: Math.round(performance.now() - start)
    }
}

