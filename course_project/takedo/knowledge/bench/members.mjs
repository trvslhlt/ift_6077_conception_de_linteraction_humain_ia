// Producer messages labelled with the team member a direction lands with and the kind of control it merits, read by
// backend/src/members.bench.ts (`make members-bench`). The members are project_plan/TEAM.md's; the goal (2026-11-26,
// the producer): directions land with specific members, and members offer different types of controls for tuning
// those directions, not a control for every direction, and a limited number of them.
//
//   msg      what the producer typed (old @mentions of retired agents kept: the words, not the name, decide)
//   member   composer | performer | sound_designer | mix_engineer | conductor: the one it lands with;
//            team: a style or broad direction several members share; none: not a direction (a question, a report that
//            something's broken or inaudible, an approval, chat). A list when either is right.
//   control  dial (how far: an amount to ride) | choice (a few alternatives to pick between) | switch (on/off: in or out)
//            | button (a one-shot to trigger) | none (a one-off fix, an exact request, a correction, a plain mixer move).
//            A list when either is right.
//   recent   the chat just before, oldest first
//   src      observed (takedo/sessions logs, 2026-11-20..26) | simulated
//
// Labels are judgments, so review them. Rules used: notes added, removed or rewritten (busier, ghost notes, an
// octave, a melody) are the composer's; how the same notes are played (swing, feel, dynamics) the performer's; what a
// part sounds like (instrument, tone, character effects) the sound designer's; level, pan, space, ducking and the
// master the mix engineer's; tempo, form and energy over time (build, drop out, extend, fills on cue) the conductor's.
// A control is labelled when the producer asked for one, or when the direction is a matter of degree or of taste among
// a few options worth riding; a correction or an exact ask gets none.

export {Project} from "./triage.mjs"

const m = (msg, member, control, src = "observed", recent = []) => ({msg, member, control, src, recent})
const said = (user, team_lead) => [{from: "user", text: user}, {from: "team_lead", text: team_lead}]

export const Messages = [
    // ---------- composer: which notes ----------
    m("add a lead melody", "composer", "choice"),
    m("add a complementaty counterpoint", "composer", "choice"),
    m("add a simple melody in the original key. keep it low in the mix", "composer", "none"),
    m("add some ghost notes on the snare", "composer", "dial"),
    m("more ghost notes on the snare", "composer", "dial"),
    m("make the drums busier", "composer", "dial"),
    m("simplify the bass line", "composer", "dial"),
    m("drop the bass an octave", "composer", "none"),
    m("less busy, and more related to the base melody", "composer", "dial"),
    m("double the length of the piano lead and slightly change the melody in the new portion", "composer", "none"),
    m("now add a playful lead melody", "composer", "choice"),
    m("add some soft strings underneath", "composer", "choice"),
    m("add a soft synth pad playing long chords", "composer", "choice"),
    m("the keys should have a slower more sustained pattern", "composer", "none"),
    m("reuse the original adic baseline as a main melody on a different instrument", "composer", "none"),
    m("make the drums more like a trap beat", "composer", "dial"),
    m("ok now update the drum pattern", "composer", "choice"),
    m("change the chords to something jazzier", "composer", "choice", "simulated"),
    m("give the bass line more movement", "composer", "dial", "simulated"),

    // ---------- performer: how the notes are played ----------
    m("give the beat more swing", "performer", "dial"),
    m("make the drums feel more laid back", "performer", "dial", "simulated"),
    m("tighten up the hats, they feel sloppy", "performer", "dial", "simulated"),
    m("play the keys softer", "performer", "dial", "simulated"),
    m("make the bass more staccato", "performer", "dial", "simulated"),
    m("more human, it's too robotic", "performer", "dial", "simulated"),
    m("accent the off beats on the hats", "performer", ["dial", "none"], "simulated"),
    m("push the snare a little ahead of the beat", "performer", "dial", "simulated"),

    // ---------- sound designer: what a part sounds like ----------
    m("make the base more analog, less rubbery", "sound_designer", "choice"),
    m("no, choose a rounder bass", "sound_designer", "none"),
    m("that instrument is attrocious. pick something cooler", "sound_designer", "choice"),
    m("switch that walking melody instrument for something more soothing", "sound_designer", "choice"),
    m("switch the drum kit to an 808", "sound_designer", "none"),
    m("replace that annoying synth sound with a muted guitar", "sound_designer", "none"),
    m("the keys are way too bright and have too much attack for lofi", "sound_designer", "none"),
    m("the pads are too harsh", "sound_designer", "none"),
    m("now destroy that sound with lots of effects", "sound_designer", "dial"),
    m("add distortion and delay to the guitar", "sound_designer", "dial"),
    m("make the lead instrument more distorted, lower in the mix and more percussive like a piano or marimba", "sound_designer", "none"),
    m("closer to sine", "sound_designer", "none", "observed", said("make the bass rounder", "The bass is now a softer, rounder synth.")),
    m("make the bass sound livelierand more complex", "sound_designer", ["dial", "choice"]),
    m("find a more distinctive sound for the counterpoint", "sound_designer", "choice"),
    m("the bass should be lower. it sounds like a slap bass now", "sound_designer", "none"),
    m("give the pad a warmer, darker tone", "sound_designer", "dial", "simulated"),

    // ---------- mix engineer: level, pan, space, the master ----------
    m("lower the drums", "mix_engineer", "none"),
    m("the bass is a bit too loud", "mix_engineer", "none"),
    m("pan the bass a little to the left", "mix_engineer", "none"),
    m("more reverb", "mix_engineer", "dial"),
    m("put a reverb on the keys and give me a knob for how wet it is, I want to ride it myself", "mix_engineer", "dial"),
    m("put the drums and the bass in a shared reverb, and a bit of delay on the bass", "mix_engineer", "dial"),
    m("have the base drums duck behind the syncopated drums", "mix_engineer", "dial"),
    m("lower it's level and feedback a little. its swamping master", "mix_engineer", "none"),
    m("put a limiter on that track so it doesn't eat all the headroom", "mix_engineer", "none"),
    m("give me a degrading effect on master i can control", ["mix_engineer", "sound_designer"], "dial"),
    m("give me a control for the master effects", "mix_engineer", "dial"),
    m("apply a procounced effect chain on master to make the result sound like a 1940s recording", ["mix_engineer", "sound_designer"], "dial"),
    m("keep the musical elements but give it dub effects", ["mix_engineer", "sound_designer"], "dial"),
    m("make it wider", "mix_engineer", "dial", "simulated"),

    // ---------- conductor: tempo, form, energy over time ----------
    m("and lower the tempo", "conductor", "dial"),
    m("shouldn't it be a little slower?", "conductor", "dial"),
    m("actually, keep the tempo where it is now: drop the tempo changes that haven't happened yet", "conductor", "none"),
    m("@arranger drop the keys out at the next bar and bring them back two bars later", "conductor", "none"),
    m("also give me a switch to drop the drums out and back in, and a button I can hit for a drum fill", "conductor", ["switch", "button"]),
    m("give me a button for triggering a drum fill", "conductor", "button"),
    m("now slowly build it up: busier drums and more energy", "conductor", "dial"),
    m("fade the track out", ["conductor", "mix_engineer"], "none"),
    m("keep extending the clips so we can work on it indeffinitely. when we are close to the end add more", "conductor", "none"),
    m("bring the drums back and fade them in over 2 bars", ["conductor", "mix_engineer"], "none"),
    m("build to a drop in 8 bars", "conductor", "button", "simulated"),
    m("strip it back to just the drums and bass for a breakdown", "conductor", "switch", "simulated"),

    // ---------- team: a style or a broad direction ----------
    m("Slowly evolve this into a lush lofi girl beat over the next 16 bars", "team", "dial"),
    m("make it trap", "team", "dial"),
    m("now turn it into house", "team", "dial"),
    m("now evolve into a ndb track with multiple melodic layers", "team", "dial"),
    m("much better. now transform the song into a krautrock motorik beat. like neu! halogalo", "team", "dial"),
    m("i like the base idea i have but want to make it sound bigger and more detailed", "team", "dial"),
    m("add a bunch of things to make the crowd go wild", "team", "dial"),
    m("make it into heavy techno with a bpm of 180", "team", "dial"),

    // ---------- none: not a direction ----------
    m("i dont hear the synth...", "none", "none"),
    m("its still muted", "none", "none"),
    m("the mute button is stuck", "none", "none"),
    m("if i take it out of loop will it work?", "none", "none"),
    m("much better", "none", "none", "observed", said("the bass is way too loud and boomy for lofi", "The bass is down and rolled off below 80 Hz.")),
    m("do all the steps! go for it!", "none", "none"),
    m("all of the original parts are missing", "none", "none"),
    m("the chords and pads you added are not audible", "none", "none")
]
