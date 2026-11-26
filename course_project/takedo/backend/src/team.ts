import type {Actor, TeamMember} from "../../shared/protocol.ts"

// The team's members (project_plan/TEAM.md): cut by what they do to the music, not by instrument. A direction lands
// with one of them (Jev names it, triage.ts; the Team Lead decides), its worker runs as that member, and the member
// offers the controls for tuning that direction on its own card (2026-11-26, the producer: directions land with
// specific members, and members offer different types of controls for tuning them; not a control for every
// direction, and a limited number).
export const MemberNames = ["composer", "performer", "sound_designer", "mix_engineer", "conductor"] as const
export type MemberName = typeof MemberNames[number]

export type MemberSpec = { name: string, area: string, hears: string, protects: string, controls: string }
export const Members: Record<MemberName, MemberSpec> = {
    composer: {name: "Composer", area: "which notes play: parts, melodies, chords, patterns",
        hears: "which notes there are: rhythm patterns, chords and voicings, lines and their contour, how the parts fit (the low end under the harmony, a counter-line answering the lead), density",
        protects: "the key, each part's function and register, the loop's length",
        controls: "a choice between a few versions of a new part or melody; a dial for density (sparse to busy)"},
    performer: {name: "Performer", area: "how the notes are played: feel, timing, dynamics",
        hears: "how the notes are played: time feel (straight, swung, behind or ahead of the beat), dynamics and accents, articulation (short, long, legato), human variation",
        protects: "the notes themselves: pitches and the pattern stay; the downbeat",
        controls: "a dial for swing, looseness or dynamics"},
    sound_designer: {name: "Sound designer", area: "what each part sounds like: instruments, tone, character",
        hears: "timbre: warm, bright, dusty, glassy, thin, full; instrument choice; effects that are part of a sound (a crusher on a beat, a chorus on a pad)",
        protects: "the part's function and register; its loudness (a sound change shouldn't jump in level)",
        controls: "a choice between a few sounds for a part; a dial for character (clean to dirty, dark to bright)"},
    mix_engineer: {name: "Mix engineer", area: "the balance: levels, space, the master",
        hears: "the whole: balance, space and depth, the low end shared by parts, stereo width, loudness, the master",
        protects: "the producer's held and hand-set controls; headroom",
        controls: "a direct knob on what the producer wants under their hand (a reverb's wet, a master effect); a dial for space"},
    conductor: {name: "Conductor", area: "time and form: tempo, energy, parts in and out",
        hears: "time and form: tempo and its changes, which parts play when, energy over the piece",
        protects: "the downbeat and the loop; changes landing on phrase boundaries",
        controls: "a dial for energy or tempo; a switch to drop a part out and back; a button for a fill or a drop"}
}
// Controls on one card, and on all cards together (2026-11-26, the producer: a limit on the controls).
export const MaxControls = 3
export const MaxTotalControls = 6

export const memberActor = (member: MemberName): Actor => `agent:${member}`
export const memberOf = (actor: Actor): MemberName | null => MemberNames.find(member => actor === `agent:${member}`) ?? null

// For the team view: the Team Lead, then the members.
export const TeamList: TeamMember[] = [{role: "team_lead", name: "Team lead", area: "takes your directions and hands them out"},
    ...MemberNames.map(member => ({role: member, name: Members[member].name, area: Members[member].area}))]

// What a worker running as a member is told about itself (its first message).
export const memberBrief = (member: MemberName): string => {
    const spec = Members[member]
    return `You are the team's ${spec.name.toLowerCase()}. You listen for ${spec.hears}. You protect ${spec.protects}. ` +
        "Do the piece through whatever openDAW needs, but judge it as this member would."
}
