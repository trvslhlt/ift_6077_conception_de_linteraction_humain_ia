import {choice, noul, score} from "@typesafe-ai/sdk"
import type {Snapshot} from "../../shared/protocol.ts"
import type {Gateway, ModelLog} from "./gateway.ts"
import {type Knowledge, serves, shortlist, Strata} from "./knowledge.ts"

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

// ---------- the knowledge route ----------

// KNOWLEDGE.md, "Round two": one Jev request asks what kind of change the message wants and which shortlisted entry
// does it (plus the part and how much, to fill the entry's params). Kind and pick agreeing, the kind at KindTop or more
// and the pick at PickTop or more: the backend applies the entry with no model. Otherwise the utility gets the
// candidates, which saves it the search. Thresholds from the bench (KNOWLEDGE.md, round three): the pick's own
// confidence separates right from wrong; the kind's only needs to rule out a guess.
const KindTop = 0.5, PickTop = 0.7
const KnowledgeList = 12
const Candidates = 5

// confidence: the lower of Jev's confidence in the kind of change and in the pick; pick: what it picked, whatever the path.
type Judged = { wants: string, confidence: number, judged: { pick: string | null, wants: number, pick_confidence: number } }
export type KnowledgePick =
    | Judged & { path: "apply", key: string, args: Record<string, unknown> }
    | Judged & { path: "hint", candidates: Array<{ key: string, summary: string }> }
    | Judged & { path: "none" }

const Drums = /drum|beat|kit|perc|playfield/i
const Bass = /bass|sub|808/i
const Chordal = /key|piano|rhodes|pad|chord|organ|synth|string|tubular|vaporisateur|epiano|e-piano/i
const describe = (track: Snapshot["tracks"][number]): string => `${track.name} ${track.instrument ?? ""}`

// The track refs a plan's params name, from the part Jev judged and the tracks' names and instruments.
const fill = (knowledge: Knowledge, key: string, snapshot: Snapshot, part: string, amount: number): Record<string, unknown> | null => {
    const params = knowledge.params(key)
    if (params === null) {return null}
    const notes = snapshot.tracks.filter(track => track.kind === "notes")
    const drums = notes.find(track => Drums.test(describe(track)))?.ref ?? null
    const chordal = (track: Snapshot["tracks"][number]) => !Drums.test(describe(track)) && !Bass.test(track.name)
    const asked = snapshot.tracks.find(track => track.ref === part)
    const keys = (asked !== undefined && chordal(asked) ? asked.ref : null)
        ?? notes.find(track => chordal(track) && Chordal.test(describe(track)))?.ref ?? notes.find(chordal)?.ref ?? null
    const stratum = knowledge.stratum(key)
    const args: Record<string, unknown> = {}
    for (const [name, param] of Object.entries(params)) {
        if (param.type === "amount") {args[name] = Math.round(Math.max(0, Math.min(3, amount)))}
        else if (name === "drums") {args[name] = drums}
        else if (name === "keys") {args[name] = keys}
        else if (param.type === "track" && name === "track") {
            // A pattern goes on its part; a sound replaces the voice of a part with the same instrument, else a new
            // track; an effect goes where the message points (the whole mix: the master).
            args[name] = stratum === "drums" ? drums : stratum === "chords" ? keys
                : stratum === "sound" ? (asked !== undefined && knowledge.devices(key).some(device => asked.instrument?.includes(device)) ? asked.ref : null)
                : part === "whole_mix" ? "master" : asked?.ref ?? null
        }
        if ((args[name] === null || args[name] === undefined) && param.optional !== true && param.type !== "amount" && param.type !== "key") {return null}
    }
    return args
}

export const pickKnowledge = async (gateway: Gateway, log: ModelLog, knowledge: Knowledge, snapshot: Snapshot,
                                    message: string): Promise<KnowledgePick> => {
    const lines = shortlist(knowledge.applicable(), message, KnowledgeList).map(({line}) => line)
    const parts: Record<string, string> = Object.fromEntries(snapshot.tracks.map(track =>
        [track.ref, `the ${track.name}${track.instrument ? ` (${track.instrument})` : ""}`]))
    parts.whole_mix = "the whole track, all parts together"
    const options: Record<string, string> = Object.fromEntries(lines.map((line, at) => [`e${at + 1}`,
        `${line.key}: ${line.label ? `${line.label}; ` : ""}${line.summary} (${line.tags.join(", ")})`]))
    options.none = "None of these: no entry fits, or the message isn't asking for one (a level, tempo, arrangement or chat)"
    // Two requests at once: the part and amount in the same request as the pick lowered its confidence (bench, round
    // three), and in parallel they cost no extra time.
    const state = {project: projectState(snapshot), message}
    const [answers, where] = await Promise.all([
        gateway.judge("fast_path", state, {
            wants: choice(`${Premise}What kind of change does the message ask for?`, Strata),
            pick: choice(`${Premise}Which knowledge-base entry, applied now, would do what the message asks?`, options)
        }, log),
        gateway.judge("fast_path", state, {
            part: choice(`${Premise}Which part of the track is it about?`, parts),
            amount: score(`${Premise}How large a change do they want?`, Amount)
        }, log)
    ])
    const wants = answers.wants.choice
    const key = answers.pick.choice === "none" ? null : lines[Number(answers.pick.choice.slice(1)) - 1]?.key ?? null
    const confidence = Math.min(answers.wants.confidence, answers.pick.confidence)
    const judged = {pick: key, wants: answers.wants.confidence, pick_confidence: answers.pick.confidence}
    if (wants === "other") {return {path: "none", wants, confidence: answers.wants.confidence, judged}}
    if (key !== null && serves(wants, knowledge.stratum(key)) && answers.wants.confidence >= KindTop && answers.pick.confidence >= PickTop) {
        const args = fill(knowledge, key, snapshot, where.part.choice, where.amount.score)
        if (args !== null) {return {path: "apply", key, args, confidence, wants, judged}}
    }
    // Not sure enough, or params it can't fill: the pick first, then the kind's best shortlisted entries.
    const ranked = [...(key !== null ? lines.filter(line => line.key === key) : []),
        ...lines.filter(line => line.key !== key && serves(wants, knowledge.stratum(line.key)))].slice(0, Candidates)
    return ranked.length === 0 ? {path: "none", wants, confidence, judged}
        : {path: "hint", wants, confidence, judged, candidates: ranked.map(line => ({key: line.key, summary: line.summary}))}
}
