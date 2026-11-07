import {choice, noul, score} from "@typesafe-ai/sdk"
import type {Snapshot} from "../../shared/protocol.ts"
import type {Gateway, ModelLog} from "./gateway.ts"

// The fast path (STRATEGY.md, "Responsiveness"; measured in poc/jev_bench, family `fastpath`): one Jev request scores
// which members a message needs and judges its hints (which part, what change, how much, how soon). One member
// clearly needed → it gets the producer's words plus the hints. A message addressed to a member (@mix_engineer)
// skips the member scores and asks only the hints.

export const Roster = {
    composer: "harmony, chords, melody; can write chord and melody notes on the keys and on added parts",
    drum_programmer: "drum patterns; can change the drum pattern from a bar on",
    bass_programmer: "the bass line; can write the bass notes and swap the bass sound",
    arranger: "song structure over time, builds and drops; can mute and unmute tracks at chosen bars",
    instrument_designer: "how instruments sound; can swap the keys' sound for a preset and add new parts with a preset",
    effect_designer: "effects on a sound; can add or remove reverb, delay, EQ, filter, distortion, crushing, compression or tremolo on any track and set or ramp their settings",
    mix_engineer: "balance between parts; can set or ramp each track's volume and pan",
    researcher: "looks up a reference song, artist or genre and summarizes it for the team; makes no edits",
    critic: "listens and gives an opinion; makes no edits",
    utility: "anything openDAW can do that the others' fast operations don't cover, such as extending or duplicating clips, adding tracks or regions, or reworking notes; works on the project directly with code",
} as const
export type Role = keyof typeof Roster
export const isRole = (name: string): name is Role => Object.hasOwn(Roster, name)

const FastTop = 0.8, FastRest = 0.5
const Changes = {
    quieter: "quieter, less of it, or gone", louder: "louder, more of it", darker: "darker, duller, more muffled",
    brighter: "brighter, more open", harsher: "harsher, crunchier, dirtier", cleaner: "cleaner, less dirty or dusty",
    busier: "busier, more notes or hits", sparser: "sparser, fewer notes or hits", other: "some other kind of change"
} as const
const Soon = {
    now: "right away, on the next beat or bar", gradual: "gradually, over a few bars",
    later: "at a later point: the next phrase, section or a named bar", unspecified: "the message doesn't say when"
} as const
const Amount = ["A subtle touch that is barely noticeable", "A clear, moderate change", "A big, obvious change",
    "All the way to the extreme of the parameter's range"]
const Premise = "The producer sent `message` to their AI music team while working on `project`. "

export type Hints = {
    part: string, partConfidence: number            // a track ref, or "whole_mix"
    change: keyof typeof Changes, changeConfidence: number
    amount: number                                  // 0..3 on Amount's scale
    when: keyof typeof Soon
}
export type Route =
    | { path: "fast", member: Role, scores: Record<string, number>, hints: Hints }
    | { path: "slow", scores: Record<string, number> }

// What Jev sees of the project: names and instruments, no internal ids beyond the track refs.
const projectState = (snapshot: Snapshot) => ({
    tempo: snapshot.timeline.bpm, playing: snapshot.playing,
    tracks: Object.fromEntries(snapshot.tracks.map(track => [track.ref,
        {name: track.name, instrument: track.instrument, volume_db: Number(track.mix.volume.toFixed(1)), muted: track.mix.mute}]))
})

export const route = async (gateway: Gateway, log: ModelLog, snapshot: Snapshot, message: string,
                            addressed: Role | null): Promise<Route> => {
    const parts: Record<string, string> = Object.fromEntries(snapshot.tracks.map(track =>
        [track.ref, `the ${track.name}${track.instrument ? ` (${track.instrument})` : ""}`]))
    parts.whole_mix = "the whole track, all parts together"
    const memberQuestions = addressed !== null ? {} : Object.fromEntries(Object.keys(Roster).map(role =>
        [role, noul(`${Premise}Does carrying it out need work from the ${role.replace(/_/g, " ")} (\`team.${role}\`)?`)]))
    const answers = await gateway.judge("fast_path", {project: projectState(snapshot), team: Roster, message}, {
        ...memberQuestions,
        part: choice(`${Premise}Which part of the track is it about?`, parts),
        change: choice(`${Premise}What kind of change to that part do they want?`, Changes),
        amount: score(`${Premise}How large a change do they want?`, Amount),
        when: choice(`${Premise}When should the change happen?`, Soon)
    }, log)
    const scores: Record<string, number> = {}
    for (const role of Object.keys(memberQuestions)) {
        scores[role] = (answers as unknown as Record<string, { noul: number }>)[role].noul
    }
    const hints: Hints = {
        part: answers.part.choice, partConfidence: answers.part.confidence,
        change: answers.change.choice as Hints["change"], changeConfidence: answers.change.confidence,
        amount: answers.amount.score, when: answers.when.choice as Hints["when"]
    }
    if (addressed !== null) {return {path: "fast", member: addressed, scores, hints}}
    const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1])
    const [top, next] = ranked
    if (top[1] >= FastTop && next[1] <= FastRest && isRole(top[0])) {return {path: "fast", member: top[0], scores, hints}}
    return {path: "slow", scores}
}
