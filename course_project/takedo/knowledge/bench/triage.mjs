// Producer messages labelled with the path each needs in front of the Team Lead (backend/src/triage.ts), read by
// backend/src/triage.bench.ts (`make triage-bench`).
//
//   msg    what the producer typed (@mentions kept: older sessions addressed members by name)
//   path   mix: one mixer move, code can do it (part and move below) | effect: one audio effect on one part | team: the Team Lead
//   part   for mix and effect: the track ref (Project, below), or whole_mix; null when the message doesn't say
//   move   for mix: quieter | louder | mute | unmute | pan_left | pan_right | center
//   src    observed (takedo/sessions logs, 2026-11-20..25) | simulated
//
// Labels are judgments, so review them. The rule: mix and effect are single, clear moves a fast path could do with no
// model; anything with two moves, an exact value, a timing beyond "now" or "gradually", or a complaint is team.

export const Project = {
    tempo: 88,
    tracks: {
        t1: {name: "Drums", instrument: "Playfield", effects: [], volume_db: -4, muted: false, pan: 0},
        t2: {name: "Keys", instrument: "Tubular", effects: ["Reverb"], volume_db: -6, muted: false, pan: 0},
        t3: {name: "Bass", instrument: "Vaporisateur", effects: ["Delay"], volume_db: -5, muted: false, pan: 0},
        t4: {name: "Pad", instrument: "Vaporisateur", effects: [], volume_db: -12, muted: false, pan: 0},
        t5: {name: "Synth", instrument: "Vaporisateur", effects: [], volume_db: -8, muted: true, pan: 0},
        t6: {name: "Guitar", instrument: "Soundfont", effects: ["Waveshaper"], volume_db: -9, muted: false, pan: 0.2}
    }
}

const mix = (msg, part, move, src = "observed") => ({msg, path: "mix", part, move, src})
const effect = (msg, part, src = "observed") => ({msg, path: "effect", part, src})
const team = (msg, src = "observed") => ({msg, path: "team", src})

export const Messages = [
    // ---------- mix: one mixer move ----------
    mix("the drums are too loud", "t1", "quieter"),
    mix("@mix_engineer the drums are too loud", "t1", "quieter"),
    mix("@mix_engineer drums down a little", "t1", "quieter"),
    mix("the keys are a bit too quiet", "t2", "louder"),
    mix("@mix_engineer the keys are too loud", "t2", "quieter"),
    mix("@mix_engineer the keys are a bit too quiet", "t2", "louder"),
    mix("bring the bass down a bit", "t3", "quieter"),
    mix("the bass is a bit too loud", "t3", "quieter"),
    mix("mute the drums", "t1", "mute"),
    mix("pan the bass a little to the left", "t3", "pan_left"),
    mix("fade the track out", "whole_mix", "quieter"),
    mix("unmute the keys", "t2", "unmute", "simulated"),
    mix("turn the pad up", "t4", "louder", "simulated"),
    mix("pan the guitar to the right", "t6", "pan_right", "simulated"),
    mix("can you make the synth quieter", "t5", "quieter", "simulated"),
    mix("everything is way too loud", "whole_mix", "quieter", "simulated"),
    mix("put the guitar back in the middle", "t6", "center", "simulated"),
    mix("bring the synth back in", "t5", "unmute", "simulated"),
    mix("kill the pad", "t4", "mute", "simulated"),
    mix("slowly fade the drums out", "t1", "quieter", "simulated"),
    mix("more bass", "t3", "louder", "simulated"),
    mix("the guitar is drowning everything", "t6", "quieter", "simulated"),

    // ---------- effect: one audio effect on one part ----------
    effect("@effect_designer give the keys a big lush reverb", "t2"),
    effect("put a big plate reverb on the keys", "t2"),
    effect("take the echo out of the bass", "t3"),
    effect("put a limiter on that track so it doesn't eat all the headroom", null),
    effect("add a tremolo after the limiter with a rhythm matching the project", null),
    effect("less reverb on the keys", "t2", "simulated"),
    effect("put some delay on the pad", "t4", "simulated"),
    effect("add a low-pass filter to the whole thing", "whole_mix", "simulated"),

    // ---------- team: everything else ----------
    team("Slowly, and without sudden large changes, evolve this into a lofi girl beat"),
    team("keep going"),
    team("lower the tempo"),
    team("actually, keep the tempo where it is now: drop the tempo changes that haven't happened yet"),
    team("@arranger drop the keys out at the next bar and bring them back two bars later"),
    team("@team_lead bring the drums down a bit and put an echo on the keys"),
    team("@team_lead extend all the clips so they run for 16 bars"),
    team("@utility add a new Vaporisateur track called Lead with a bar of notes at -30 dB, then fade it up to 0 dB over 8 beats"),
    team("@utility with a script, set the Drums volume to -20 dB"),
    team("Slowly evolve this into a lush lofi girl beat over the next 16 bars"),
    team("now slowly build it up: busier drums and more energy"),
    team("keep going, and make the drums feel more relaxed"),
    team("now turn it into drum n bass"),
    team("now slowly make the drums busier and more energetic"),
    team("Slowly evolve this into a trap hip hop beat"),
    team("make it trap"),
    team("now turn it into house"),
    team("turn this into an 80s synth-pop groove: a new synth bass, bright FM keys and some brass stabs"),
    team("remove the synth"),
    team("also give me a switch to drop the drums out and back in, and a button I can hit for a drum fill"),
    team("why does the tempostay 119?"),
    team("and lower the tempo"),
    team("now turn it into drum n bass with melodic layers"),
    team("make the drums more characteristically dnb"),
    team("add a lead melody"),
    team("bring the drums back and fade them in over 2 bars"),
    team("make the base more analog, less rubbery"),
    team("now add a playful lead melody"),
    team("make the lead instrument more distorted, lower in the mix and more percussive like a piano or marimba"),
    team("it should have slowed down more and added more key elements"),
    team("the chords and pads you added are not audible"),
    team("add sparse sweet lead melody. also simplify the drums"),
    team("make it dnb style"),
    team("more ghost notes on the snare"),
    team("make it into a hip hop beat"),
    team("make the bass more characteristically hip hop"),
    team("make the drums more like a trap beat"),
    team("bring in a new synth"),
    team("make it into electronic dance music"),
    team("make it into heavy techno with a bpm of 180"),
    team("i muted the synth. can you make it less annoying and unmute it?"),
    team("i dont hear the synth..."),
    team("still cant hear it"),
    team("its still muted"),
    team("the mute button is stuck"),
    team("no"),
    team("add a bunch of things to make the crowd go wild"),
    team("add a soft synth pad playing long chords"),
    team("bring back the same bass pattern but use a more analog bass sound"),
    team("that bass is mostly midrange. it should be much lower"),
    team("great, now warm it up a little bit. maybe add some distortion so it is more prominent"),
    team("add a simple melody in the original key. keep it low in the mix"),
    team("bring back the original bassline as a piano lead"),
    team("bring in another percussion layer"),
    team("keep the musical elements but give it dub effects"),
    team("add a complementaty counterpoint"),
    team("less busy, and more related to the base melody"),
    team("find a more distinctive sound for the counterpoint"),
    team("now destroy that sound with lots of effects"),
    team("lower it's level and feedback a little. its swamping master"),
    team("double the length of the piano lead and slightly change the melody in the new portion"),
    team("more difference"),
    team("turn this into a neo-soul groove: new keys and a new bass, warm and played"),
    team("add some soft strings underneath"),
    team("put a reverb on the keys and give me a knob for how wet it is, I want to ride it myself"),
    team("the 808 bass sounds more miderange than sub"),
    team("it still sounds more like a tom than a kick or bass"),
    team("much better. now transform the song into a krautrock motorik beat. like neu! halogalo"),
    team("replace that annoying synth sound with a muted guitar"),
    team("add distortion and delay to the guitar"),
    team("give me a button for triggering a drum fill"),
    team("sure"),
    team("add a slow sparse lead melody low in the mix. choose a recognizable instrument and add complex processing to it")
]
