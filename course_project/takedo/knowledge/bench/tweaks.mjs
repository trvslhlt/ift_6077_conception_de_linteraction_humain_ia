// Producer messages labelled with the musical tweak each asks of one part, read by backend/src/tweaks.bench.ts
// (`make tweak-bench`): can Jev name the tweak, the part and how much, so code (backend/src/variants.ts) makes it with no
// model writing notes (the music-library plan, step 3; the fast path on it is step 4).
//
//   msg    what the producer typed
//   tweak  one of variants.ts's Tweaks, or none (a style change, a new part, two things, not about notes); a list when
//          either is right
//   part   the track ref (Project, in triage.mjs: the jam project); null for none
//   amount 0..3 (subtle, clear, big, all the way), when it says; null when it doesn't matter
//   recent the chat just before, oldest first; src observed (takedo/sessions, 2026-11-20..25) | simulated
//
// Labels are judgments: review them. The rule: a tweak is one change to one part's notes that code can make from the
// notes already there; a new pattern in a style, a new part or sound, or two changes at once is none.

export {Project} from "./triage.mjs"

const tweak = (msg, part, kind, amount = null, src = "simulated", recent = []) => ({msg, tweak: kind, part, amount, src, recent})
const none = (msg, src = "simulated", recent = []) => ({msg, tweak: "none", part: null, amount: null, src, recent})
const said = (user, team_lead) => [{from: "user", text: user}, {from: "team_lead", text: team_lead}]

export const Messages = [
    // ---------- drums ----------
    tweak("now slowly make the drums busier", "t1", "busier", 1, "observed"),
    tweak("make the drums busier and more energetic", "t1", "busier", 2, "observed"),
    tweak("more ghost notes on the snare", "t1", "ghost_notes", 1, "observed"),
    tweak("simplify the drums", "t1", "sparser", 2, "observed"),
    tweak("the drums are too busy", "t1", "sparser", 1),
    tweak("strip the drums back to just kick and snare", "t1", "sparser", 3),
    tweak("thin out the hats a bit", "t1", "sparser", 1),
    tweak("make the drums feel more relaxed", "t1", ["swing_more", "softer"], 1, "observed"),
    tweak("give the beat more swing", "t1", "swing_more", 1),
    tweak("swing the drums way more", "t1", "swing_more", 2),
    tweak("straighten the groove out, it's too swung", "t1", "straighten", 2),
    tweak("make the drums less swung", "t1", "straighten", 1),
    tweak("put the drums in half time", "t1", "halftime", null),
    tweak("halftime feel on the beat", "t1", "halftime", null),
    tweak("double time the drums", "t1", "double_time", null),
    tweak("add a fill at the end of every 4 bars", "t1", "fill", null),
    tweak("give me a drum fill going into the next section", "t1", "fill", null),
    tweak("hit the drums harder", "t1", "harder", 1),
    tweak("the drums sound too timid, make them punchier", "t1", "harder", 1),
    tweak("play the drums softer", "t1", "softer", 1),
    tweak("lighter touch on the drums", "t1", "softer", 1),
    tweak("a bit more", "t1", "busier", 1, "simulated", said("make the drums busier", "TR-808 gets busier over the next 4 bars.")),
    tweak("even more swing", "t1", "swing_more", 1, "simulated", said("give the beat more swing", "Swinging the TR-808 more.")),

    // ---------- bass and pitched parts ----------
    tweak("make the bass line simpler", "t3", "sparser", 1),
    tweak("the bass is too busy", "t3", "sparser", 1),
    tweak("make the bass busier", "t3", "busier", 1),
    tweak("that bass is mostly midrange. it should be much lower", "t3", "octave_down", null, "observed"),
    tweak("drop the bass an octave", "t3", "octave_down", null),
    tweak("bring the keys up an octave", "t2", "octave_up", null),
    tweak("the pad is too low, move it up", "t4", "octave_up", null),
    tweak("make the keys more staccato", "t2", "shorter", 2),
    tweak("shorter, punchier keys stabs", "t2", "shorter", 2),
    tweak("let the pad notes ring out longer", "t4", "longer", 2),
    tweak("make the keys more legato", "t2", "longer", 1),
    tweak("less busy, and more related to the base melody", "t5", "sparser", 1, "observed"),
    tweak("play the guitar softer", "t6", "softer", 1),
    tweak("dig in harder on the bass", "t3", "harder", 1),
    tweak("swing the bass line a bit", "t3", "swing_more", 1),
    tweak("simplify the synth part", "t5", "sparser", 1),
    tweak("lower", "t2", "octave_down", null, "simulated", said("bring the keys up an octave", "Keys up an octave.")),

    // ---------- none: a style, a new part or sound, two things, the mix, not notes ----------
    none("make the drums more characteristically dnb", "observed"),
    none("make the drums more like a trap beat", "observed"),
    none("now turn it into house", "observed"),
    none("add a lead melody", "observed"),
    none("bring in another percussion layer", "observed"),
    none("make the bass more analog, less rubbery", "observed"),
    none("add sparse sweet lead melody. also simplify the drums", "observed"),
    none("double the length of the piano lead and slightly change the melody in the new portion", "observed"),
    none("the drums are too loud", "observed"),
    none("put a reverb on the keys"),
    none("lower the tempo", "observed"),
    none("give me a button for triggering a drum fill", "observed"),
    none("make the bass busier and the drums simpler"),
    none("replace the hats with a shaker"),
    none("keep going", "observed")
]
