// The fast-tier jobs we'd give Jev, each as a family of graded cases. A case's `want` lists every acceptable answer.
// The project, roles and directions are the interaction prototype's (../interaction_prototype/).
import { choice, noul, score } from "@typesafe-ai/sdk";

const any = v => (Array.isArray(v) ? v : [v]);
const pick = (a, want) => ({ ok: any(want).includes(a.choice), got: a.choice, conf: a.confidence });

const PROJECT = {
    name: "lofi_sketch", key: "A minor", tempo: 96, meter: "4/4", length_bars: 32,
    playback: { playing: true, bar: 9 },
    tracks: {
        t1: { name: "Drums", instrument: "Playfield, dusty kit", pattern: "boom_bap_swung", volume_db: -4, muted: false },
        t2: { name: "Keys", instrument: "Vaporisateur, Rhodes patch", volume_db: -6, muted: false,
              effects: { fx1: { device: "Crusher", bits: 12, mix: 0.4 }, fx2: { device: "Filter", cutoff_pct: 35, resonance_pct: 20 } } },
        t3: { name: "Bass", instrument: "Vaporisateur, sub", volume_db: -5, muted: false },
        t4: { name: "Vinyl", instrument: "Sample, vinyl crackle", volume_db: -14, muted: false },
    },
};

// ---------- 1. Routing a message to the Team Lead ----------

const ROLES = {
    team_lead: "Team Lead: questions about the session, the team, or who is doing what; not about the music itself",
    composer: "Composer: harmony, chords, melody, note choice",
    drum_programmer: "Drum programmer: drum patterns, fills, which drum sounds play",
    bass_programmer: "Bass programmer: the bass line's notes and rhythm",
    arranger: "Arranger: song structure over time; sections, what plays when, builds and drops",
    instrument_designer: "Instrument designer: how instruments sound; synth patches, presets, layering",
    effect_designer: "Effect designer: effects on a sound, and effect sounds such as risers, sweeps and impacts",
    mix_engineer: "Mix engineer: balance between parts; levels, EQ, compression, sidechain, mud and clashes in frequency",
    groove: "Groove: timing and feel across all parts; swing, humanizing, push and pull against the grid",
    researcher: "Researcher: looks up a reference song, artist, genre or technique and summarizes it for the team",
    critic: "Critic: listens and gives an opinion on what works; makes no edits",
    tutor: "Tutor: teaches the producer how to do something themselves",
    team: "The whole team: a general direction about the overall feel or style that touches several areas at once",
};

const routing = {
    describe: "message to the Team Lead → which member handles it",
    build: c => ({
        state: { project: PROJECT, message: c.msg },
        questions: {
            who: choice("The producer sent `message` to the Team Lead of their AI music team while working on `project`. Which team member should handle it?", ROLES),
        },
    }),
    grade: (c, a) => pick(a.who, c.want),
    cases: [
        { msg: "the kick is too loud", want: "mix_engineer" },
        { msg: "make the hats busier", want: "drum_programmer" },
        { msg: "this pad sounds too modern", want: "instrument_designer" },
        { msg: "can we get a riser into bar 17", want: "effect_designer" },
        { msg: "the bass should bounce more", want: "bass_programmer" },
        { msg: "make it darker", want: "team" },
        { msg: "what do you think so far?", want: "critic" },
        { msg: "jazzier chords please", want: "composer" },
        { msg: "drop everything but the drums at bar 9", want: "arranger" },
        { msg: "how do I set up sidechain myself?", want: "tutor" },
        { msg: "more swing", want: ["groove", "drum_programmer"] },
        { msg: "it's getting muddy down low", want: "mix_engineer" },
        { msg: "who's working on the synths right now?", want: "team_lead" },
        { msg: "find me something like Burial's drums", want: "researcher" },
        { msg: "the keys and bass are clashing", want: ["composer", "mix_engineer"] },
        { msg: "the filter sweep you added is too long", want: "effect_designer" },
    ],
};

// ---------- 2. A chat message that changes a Team Lead direction (#tag) ----------

const AMEND = {
    up: "Turn the direction up: the producer wants more of it, or wants it faster or stronger; what it asks for stays the same",
    down: "Turn the direction down: the producer wants less of it, or wants it slower or gentler; what it asks for stays the same",
    cancel: "Cancel the direction: the producer wants the team to stop working on it altogether",
    reword: "Change what the direction asks for: a different target, a new condition, or a limit on where it applies",
    keep: "No change: the producer approves or is only commenting; the team keeps going as it is",
    unrelated: "The message is not about this direction at all",
};
const GOAL = { tag: "slowly_evolve_this", text: "Slowly evolve this from a lo-fi beat into a house track",
    control: { label: "Pace", value: 30, low_end: "slow", high_end: "fast", meaning: "how often each member changes something" } };
const JAZZ = { tag: "jazzier_chords_please", text: "jazzier chords please",
    control: { label: "Strength", value: 50, low_end: "a hint", high_end: "a lot", meaning: "how much the direction should show" } };

const amend = {
    describe: "message about #direction → up / down / cancel / reword / keep",
    build: c => ({
        state: { direction: c.dir, message: c.msg },
        questions: {
            change: choice("The producer sent `message` to their AI music team about the direction in `direction`. What do they want done with that direction?", AMEND),
        },
    }),
    grade: (c, a) => pick(a.change, c.want),
    cases: [
        { dir: GOAL, msg: "speed it up", want: "up" },
        { dir: GOAL, msg: "let's not rush this", want: "down" },
        { dir: GOAL, msg: "forget it", want: "cancel" },
        { dir: GOAL, msg: "actually aim for techno instead of house", want: "reword" },
        { dir: GOAL, msg: "sounds great, keep going", want: "keep" },
        { dir: GOAL, msg: "go faster but keep the dusty keys", want: ["up", "reword"] },
        { dir: GOAL, msg: "less drastic changes please", want: "down" },
        { dir: GOAL, msg: "the kick is too loud", want: "unrelated" },
        { dir: JAZZ, msg: "make it less jazzy", want: "down" },
        { dir: JAZZ, msg: "way more", want: "up" },
        { dir: JAZZ, msg: "stop with the chords", want: "cancel" },
        { dir: JAZZ, msg: "jazzier but only on the Dm", want: "reword" },
        { dir: JAZZ, msg: "that's perfect", want: "keep" },
        { dir: JAZZ, msg: "more", want: "up" },
    ],
};

// ---------- 3. Picking an operation and filling its arguments ----------
// The cookbook's function-calling pattern: every argument is asked in the same request, under the premise that the
// operation needs it; code reads only the chosen operation's arguments. Numbers come from fixed candidates or a Score.

const OPS = {
    ramp_param: "Move a parameter gradually to a new value over some bars",
    set_param: "Set a parameter to a new value at once",
    swap_preset: "Replace a track's instrument sound with a different preset",
    set_pattern: "Replace the drum track's pattern",
    mute: "Silence a track",
    unmute: "Bring a muted track back",
    add_part: "Add a new track with a new instrument sound",
    none: "Not a request to change the project: a question or a comment",
};
const PARAMS = {
    "t1.mix.volume": "Drums volume",
    "t2.mix.volume": "Keys volume",
    "t3.mix.volume": "Bass volume",
    "t4.mix.volume": "Vinyl crackle volume",
    "t2.fx1.bits": "Keys Crusher bit depth: fewer bits sound harsher and more crunchy, more bits sound cleaner",
    "t2.fx1.mix": "Keys Crusher wet/dry mix",
    "t2.fx2.cutoff": "Keys low-pass filter cutoff: higher is brighter and more open, lower is darker and more muffled",
    "t2.fx2.resonance": "Keys filter resonance",
};
const TRACKS = { t1: "Drums", t2: "Keys", t3: "Bass", t4: "Vinyl crackle sample" };
const DIRECTION = { up: "raise the parameter's value", down: "lower the parameter's value" };
const LENGTH = { instant: "immediately, no ramp", "1_bar": "over 1 bar", "2_bars": "over 2 bars", "4_bars": "over 4 bars",
    "8_bars": "over 8 bars", "16_bars": "over 16 bars" };
const PATTERNS = { boom_bap_swung: "swung hip hop beat, kick and snare", four_on_floor: "kick on every beat, as in house and techno",
    offbeat_hats: "open hi-hats between the kicks", clap_2_4: "clap on beats 2 and 4", breakbeat: "chopped breakbeat, as in jungle and breaks",
    half_time: "half-time feel, snare on beat 3" };
const PRESETS = { rhodes: "Rhodes electric piano", dx7_epiano: "glassy FM electric piano", juno_strings: "warm analog string pad",
    m1_piano_stab: "bright digital house piano stab", m1_organ: "house organ bass", hoover: "detuned rave hoover",
    supersaw: "big detuned supersaw pad", sub_bass: "clean sine sub bass", acid_303: "squelchy acid bassline synth" };
const WHEN = { next_beat: "on the next beat", next_bar: "at the start of the next bar", next_phrase: "at the start of the next 8-bar phrase" };
for (let b = 10; b <= 32; b++) WHEN[`bar_${b}`] = `at the start of bar ${b}`;
const AMOUNT = ["A subtle touch that is barely noticeable", "A clear, moderate change", "A big, obvious change",
    "All the way to the extreme of the parameter's range"];

const operation = {
    describe: "request to a member → operation + closed-set arguments",
    build: c => {
        const project = structuredClone(PROJECT);
        if (c.muted) project.tracks[c.muted].muted = true;
        const premise = what => `The producer asked their AI music team for \`request\` while working on \`project\`. Assuming the request is carried out by an operation that needs ${what}, `;
        return {
            state: { project, request: c.msg },
            questions: {
                op: choice("The producer asked their AI music team for `request` while working on `project`. Which operation carries it out?", OPS),
                param: choice(premise("a parameter") + "which parameter?", PARAMS),
                direction: choice(premise("a parameter") + "should the parameter's value go up or down?", DIRECTION),
                amount: score(premise("a parameter") + "how large a change does the producer want?", AMOUNT),
                length: choice(premise("a duration") + "over how long should the change happen?", LENGTH),
                track: choice(premise("a track") + "which track?", TRACKS),
                pattern: choice(premise("a drum pattern") + "which pattern?", PATTERNS),
                preset: choice(premise("an instrument preset") + "which preset?", PRESETS),
                when: choice(premise("a start time") + "when should it happen? The playhead is at the bar in `project.playback.bar`.", WHEN),
            },
        };
    },
    // Right only if the operation and every argument the case names are right; confidence is the least certain of those.
    grade: (c, a) => {
        const misses = [], confs = [];
        for (const [k, want] of Object.entries(c.want)) {
            const ans = a[k];
            if (k === "amount") { if (ans.score < want[0] || ans.score > want[1]) misses.push(`amount=${ans.score.toFixed(2)}`); }
            else if (!any(want).includes(ans.choice)) misses.push(`${k}=${ans.choice}`);
            confs.push(ans.confidence);
        }
        return { ok: !misses.length, got: misses.length ? misses.join(" ") : a.op.choice, conf: Math.min(...confs) };
    },
    cases: [
        { msg: "open the filter on the keys over the next 4 bars", want: { op: "ramp_param", param: "t2.fx2.cutoff", direction: "up", length: "4_bars" } },
        { msg: "crush the keys hard, right now", want: { op: "set_param", param: "t2.fx1.bits", direction: "down", amount: [1.5, 3] } },
        { msg: "bring the vinyl down a little", want: { op: ["set_param", "ramp_param"], param: "t4.mix.volume", direction: "down", amount: [0, 1.3] } },
        { msg: "switch the keys to an M1 piano stab at bar 17", want: { op: "swap_preset", track: "t2", preset: "m1_piano_stab", when: "bar_17" } },
        { msg: "four on the floor from the next phrase", want: { op: "set_pattern", pattern: "four_on_floor", when: ["next_phrase", "bar_17"] } },
        { msg: "kill the bass", want: { op: "mute", track: "t3" } },
        { msg: "bring the bass back on the next bar", muted: "t3", want: { op: "unmute", track: "t3", when: ["next_bar", "bar_10"] } },
        { msg: "add a hoover pad", want: { op: "add_part", preset: "hoover" } },
        { msg: "slowly fade the drums out over 8 bars", want: { op: "ramp_param", param: "t1.mix.volume", direction: "down", length: "8_bars" } },
        { msg: "what key are we in?", want: { op: "none" } },
        { msg: "make the keys less crunchy", want: { op: ["set_param", "ramp_param"], param: "t2.fx1.bits", direction: "up" } },
        { msg: "offbeat hats please", want: { op: "set_pattern", pattern: "offbeat_hats" } },
    ],
};

// ---------- 4. Reading a gesture on a knob ----------
// The log is what the bus records: playhead position and value per move. Its length and range are code's job; only
// the shape and the likely intent are asked.

const SHAPES = {
    rise: "moves up and stays up",
    fall: "moves down and stays down",
    swell: "goes up, then comes back down to about where it started",
    dip: "goes down, then comes back up to about where it started",
    oscillate: "goes back and forth several times, like a wobble",
    jump: "one sudden jump to a new value, then stays there",
    nudge: "only small, hesitant adjustments with no clear movement",
};
const PURPOSE = {
    build: "builds tension or energy toward a point",
    release: "releases tension: opens up or calms after a peak",
    accent: "accents a single moment or hit",
    movement: "adds ongoing movement or texture",
    set_level: "just sets the sound to a new level",
};

let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const posOf = bar => {
    const b = Math.floor(bar), beats = (bar - b) * 4, beat = Math.floor(beats);
    return `${b}.${beat + 1}.${Math.floor((beats - beat) * 4) + 1}`;
};
// Moves every eighth of a bar from `start` for `bars`, following f(t) for t in [0, 1], with a little hand noise.
function gesture(start, bars, f, noise = 2, lo = 0, hi = 100) {
    const log = [];
    for (let i = 0; i <= bars * 8; i++) {
        const v = f(i / (bars * 8)) + (rand() - 0.5) * 2 * noise;
        log.push({ at: posOf(start + i / 8), value: Math.round(Math.min(hi, Math.max(lo, v))) });
    }
    return log;
}
const CUTOFF = "Keys filter cutoff, in percent (0 = dark, 100 = bright)";
const BITS = "Keys Crusher bit depth (1 = harshest, 16 = clean)";

const reading = {
    describe: "knob log → gesture shape + likely intent",
    build: c => ({
        state: { control: c.control, playing: true, moves: c.log },
        questions: {
            shape: choice("The producer moved the control in `control` during playback; `moves` lists each value with its playhead position (bar.beat.sixteenth). What shape does the movement have overall?", SHAPES),
            purpose: choice("The producer moved the control in `control` during playback; `moves` lists each value with its playhead position (bar.beat.sixteenth). What is the movement most likely for, musically?", PURPOSE),
        },
    }),
    grade: (c, a) => {
        const s = pick(a.shape, c.shape), p = pick(a.purpose, c.purpose);
        return { ok: s.ok && p.ok, got: `${s.got}/${p.got}`, conf: Math.min(s.conf, p.conf), shapeOk: s.ok };
    },
    cases: [
        { name: "rise 30→85 over 2 bars", control: CUTOFF, log: gesture(9, 2, t => 30 + 55 * t), shape: "rise", purpose: ["build", "set_level"] },
        { name: "fall 80→20 over 4 bars", control: CUTOFF, log: gesture(9, 4, t => 80 - 60 * t), shape: "fall", purpose: ["release", "set_level"] },
        { name: "swell 30→90→30 over 4 bars", control: CUTOFF, log: gesture(9, 4, t => 30 + 60 * Math.sin(Math.PI * t)), shape: "swell", purpose: ["build", "movement", "release"] },
        { name: "dip 70→10→70 over 2 bars", control: CUTOFF, log: gesture(9, 2, t => 70 - 60 * Math.sin(Math.PI * t)), shape: "dip", purpose: ["accent", "movement", "release"] },
        { name: "wobble 40±25, 4 cycles", control: CUTOFF, log: gesture(9, 4, t => 40 + 25 * Math.sin(8 * Math.PI * t)), shape: "oscillate", purpose: "movement" },
        { name: "jump 30→80 at 9.3", control: CUTOFF, log: gesture(9, 1, t => (t < 0.5 ? 30 : 80), 0.5), shape: "jump", purpose: ["accent", "set_level"] },
        { name: "nudges around 50", control: CUTOFF, log: gesture(9, 1, () => 50, 3), shape: "nudge", purpose: "set_level" },
        { name: "rise with overshoot 30→90→80", control: CUTOFF, log: gesture(9, 2, t => (t < 0.7 ? 30 + 60 * t / 0.7 : 90 - 10 * (t - 0.7) / 0.3), 3), shape: "rise", purpose: ["build", "set_level"] },
        // FEATURES.md "Requests by demonstration": a dive into bar 5, back to 8, sinking to 2 by bar 8, clean at the restart.
        { name: "bits: dive, recover, sink, snap back (FEATURES.md)", control: BITS, shape: ["dip"], purpose: ["build"],
          log: gesture(4.5, 4.5, t => (t < 0.11 ? 12 - 11 * t / 0.11 : t < 0.2 ? 1 + 7 * (t - 0.11) / 0.09 : t < 0.95 ? 8 - 6 * (t - 0.2) / 0.75 : 12), 0.4, 1, 16) },
    ],
};

// ---------- 5. Reading an intent dial: choosing among candidates ----------

const ERA_SOUNDS = { rhodes: "vintage Rhodes electric piano", dx7_epiano: "glassy FM electric piano", juno_strings: "warm, chorus-heavy analog string pad",
    m1_piano_stab: "bright digital-workstation house piano stab", m1_organ: "digital-workstation organ bass", acid_303: "squelchy acid bassline synth",
    hoover: "detuned rave hoover lead", supersaw: "big detuned supersaw trance pad" };
const VOICINGS = { triad: "plain three-note triads", seventh: "seventh chords", ninth: "ninth chords",
    extended: "eleventh and thirteenth chords, with alterations", cluster: "dense tone clusters" };
const MIX_MOVES = { add_crackle: "add more vinyl crackle and tape hiss", lofi_eq: "roll off the highs for a muffled, old sound",
    neutral: "leave the character as it is", clean_highs: "cut the crackle and open up the top end" };

const era = v => ({ member: "Instrument designer", candidates: ERA_SOUNDS, control: { label: "Era", min: 1980, max: 2000, value: v, meaning: "which era the next sounds come from" } });
const harmony = v => ({ member: "Composer", candidates: VOICINGS, control: { label: "Harmony", min: 0, max: 100, value: v, low_end: "plain", high_end: "jazzy", meaning: "how rich the chord voicings are" } });
const character = v => ({ member: "Mix engineer", candidates: MIX_MOVES, control: { label: "Character", min: 0, max: 100, value: v, low_end: "dusty", high_end: "clean", meaning: "how worn or clean the mix sounds" } });

const dial = {
    describe: "intent dial value → which candidate fits",
    build: c => ({
        state: { member: c.s.member, control: c.s.control },
        questions: {
            next: choice("A member of an AI music team, `member`, is choosing its next move. The producer set the dial in `control` to `control.value`. Which option fits the dial's setting best?", c.s.candidates),
        },
    }),
    grade: (c, a) => pick(a.next, c.want),
    cases: [
        { name: "era 1982", s: era(1982), want: ["juno_strings", "dx7_epiano"] },
        { name: "era 1985", s: era(1985), want: ["dx7_epiano", "juno_strings"] },
        { name: "era 1989", s: era(1989), want: ["m1_piano_stab", "m1_organ", "acid_303"] },
        { name: "era 1993", s: era(1993), want: ["hoover", "m1_piano_stab", "m1_organ"] },
        { name: "era 1999", s: era(1999), want: "supersaw" },
        { name: "harmony 5", s: harmony(5), want: "triad" },
        { name: "harmony 45", s: harmony(45), want: ["seventh", "ninth"] },
        { name: "harmony 95", s: harmony(95), want: ["extended", "ninth"] },
        { name: "character 10", s: character(10), want: ["add_crackle", "lofi_eq"] },
        { name: "character 90", s: character(90), want: "clean_highs" },
    ],
};

// ---------- Second round: code turns numbers into words before asking ----------
// Round one missed where Jev had to relate a number to its meaning: "less crunchy" means more bits; a dial at 10
// on dusty..clean is dusty; 1989 among sounds described without years.

// operation_v2: the pattern question asks what the producer names, not what plays; up/down is a second request
// whose options are worded for the chosen parameter, so code maps the sound to the value's direction.
const EFFECT = {
    "t2.fx2.cutoff": { up: "brighter, more open", down: "darker, more muffled" },
    "t2.fx1.bits": { up: "cleaner, less crunchy", down: "harsher, more crunchy" },
    "t2.fx1.mix": { up: "more of the crushed sound", down: "more of the dry sound" },
    "t2.fx2.resonance": { up: "a sharper, whistling peak", down: "a smoother tone" },
};
const effectOf = param => EFFECT[param] ?? { up: "louder", down: "quieter" };
const operation_v2 = {
    describe: "as operation; pattern reworded, up/down asked second, worded for the chosen parameter",
    async run(client, c) {
        const first = operation.build(c);
        delete first.questions.direction;
        first.questions.pattern = choice("The producer asked their AI music team for `request` while working on `project`. Assuming the request names a drum pattern to play, which pattern from this list did they ask for?", PATTERNS);
        const t0 = performance.now();
        const a1 = await client.systemOne(first);
        const fx = effectOf(a1.answers.param.choice);
        const a2 = await client.systemOne({ state: first.state, questions: {
            direction: choice(`The producer asked their AI music team for \`request\` while working on \`project\`. How should the sound change?`,
                { up: `It should sound ${fx.up}`, down: `It should sound ${fx.down}` }),
        } });
        return { answers: { ...a1.answers, ...a2.answers }, ms: performance.now() - t0, model: a1.model,
            inputTokens: a1.usage.input_tokens + a2.usage.input_tokens, questions: Object.keys(first.questions).length + 1, requests: 2 };
    },
    grade: operation.grade,
    cases: operation.cases,
};

// dial_v2: the dial's value as words: where it sits between its named ends, and the era as a period.
const where = ({ value, min, max, low_end, high_end }) => {
    const p = (value - min) / (max - min);
    return p < 0.15 ? `all the way toward "${low_end}"` : p < 0.4 ? `toward "${low_end}"` : p <= 0.6 ? "in the middle"
        : p < 0.85 ? `toward "${high_end}"` : `all the way toward "${high_end}"`;
};
const period = y => `the ${["early", "early", "early", "mid", "mid", "mid", "mid", "late", "late", "late"][y % 10]} ${y - (y % 10)}s`;
const dial_v2 = {
    describe: "as dial; the value given in words by code",
    build: c => {
        const ctl = c.s.control;
        const setting = ctl.label === "Era" ? `sounds from ${period(ctl.value)}` : `${ctl.label}: ${where(ctl)} (${ctl.meaning})`;
        return {
            state: { member: c.s.member, setting },
            questions: {
                next: choice("A member of an AI music team, `member`, is choosing its next move. The producer asked for `setting`. Which option fits best?", c.s.candidates),
            },
        };
    },
    grade: dial.grade,
    cases: dial.cases,
};

// ---------- fanout: which members a Team Lead direction needs, one yes/no per member ----------
// The roster is ../llm_bench/cases.mjs's: each member's area and what its operations can do. All questions go in one
// request; code takes every member above 0.5. Graded like the Claude Team Lead's member set (llm_bench LEAD_CASES).

const ROSTER = {
    composer: "harmony, chords, melody; can write chord and melody notes on the keys and on added parts",
    drum_programmer: "drum patterns; can change the drum pattern from a bar on",
    bass_programmer: "the bass line; can write the bass notes and swap the bass sound",
    arranger: "song structure over time, builds and drops; can mute and unmute tracks from a bar on",
    instrument_designer: "how instruments sound; can swap the keys' sound for a preset and add new parts with a preset",
    effect_designer: "effects on a sound, risers and sweeps; can set or ramp the keys' Crusher and Filter",
    mix_engineer: "balance between parts; can set or ramp each track's volume",
    researcher: "looks up a reference song, artist or genre and summarizes it for the team; makes no edits",
    critic: "listens and gives an opinion; makes no edits",
};
const fanout = {
    describe: "Team Lead direction → which members it needs (a yes/no per member)",
    build: c => ({
        state: { project: PROJECT, direction: c.direction, team: ROSTER },
        questions: Object.fromEntries(Object.entries(ROSTER).map(([role]) => [role,
            noul(`The producer gave their AI music team the direction in \`direction\` while working on \`project\`. Does carrying it out need work from the ${role.replace(/_/g, " ")} (\`team.${role}\`)?`)])),
    }),
    grade: (c, a) => {
        const roles = Object.keys(ROSTER).filter(r => a[r].noul > 0.5), issues = [];
        for (const g of c.need) if (!g.some(r => roles.includes(r))) issues.push(`missing ${g.join("|")}`);
        if (roles.length > c.max) issues.push(`${roles.length} members`);
        if (c.min && roles.length < c.min) issues.push(`${roles.length} members`);
        // Confidence: how far the closest call is from 0.5, scaled to 0..1.
        const conf = Math.min(...Object.keys(ROSTER).map(r => Math.abs(a[r].noul - 0.5) * 2));
        return { ok: !issues.length, got: roles.join(",") + (issues.length ? ` (${issues.join("; ")})` : ""), conf };
    },
    // As llm_bench LEAD_CASES, minus "make it better" (Claude asks a question there; this question can't).
    cases: [
        { name: "evolve lo-fi into house", direction: "Slowly evolve this from a lo-fi beat into a house track", need: [["drum_programmer"], ["instrument_designer", "effect_designer"], ["bass_programmer", "mix_engineer"]], max: 6 },
        { name: "make it darker", direction: "make it darker", need: [["instrument_designer", "composer", "effect_designer", "mix_engineer"]], min: 2, max: 4 },
        { name: "jazzier chords please", direction: "jazzier chords please", need: [["composer"]], max: 2 },
        { name: "build up to a drop at bar 17", direction: "build up to a drop at bar 17", need: [["arranger"]], max: 4 },
        { name: "make it sound more like Burial", direction: "make it sound more like Burial", need: [["researcher", "drum_programmer", "instrument_designer"]], max: 6 },
        { name: "the kick is too loud", direction: "the kick is too loud", need: [["mix_engineer"]], max: 1 },
        { name: "strip it back for the next 8 bars", direction: "strip it back for the next 8 bars", need: [["arranger"]], max: 2 },
    ],
};

export const FAMILIES = { routing, amend, operation, reading, dial, operation_v2, dial_v2, fanout };
