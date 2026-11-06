// The slow tier's two jobs, as prompts, schemas and graded cases. Project, roles and directions are the interaction
// prototype's (../interaction_prototype/) and the Jev test's (../jev_bench/).
import { z } from "zod";

export const PROJECT = {
    name: "lofi_sketch", key: "A minor", tempo: 96, meter: "4/4", length_bars: 32,
    chords: "Am7 | Dm9 | G7 | Cmaj7, two bars each, looping",
    playback: { playing: true, bar: 9 },
    tracks: {
        t1: { name: "Drums", instrument: "Playfield, dusty kit", pattern: "boom_bap_swung", volume_db: -4, muted: false },
        t2: { name: "Keys", instrument: "Vaporisateur, Rhodes patch", volume_db: -6, muted: false,
              effects: { fx1: { device: "Crusher", bits: 12, mix: 0.4 }, fx2: { device: "Filter", cutoff_pct: 35, resonance_pct: 20 } } },
        t3: { name: "Bass", instrument: "Vaporisateur, sub", volume_db: -5, muted: false },
        t4: { name: "Vinyl", instrument: "Sample, vinyl crackle", volume_db: -14, muted: false },
    },
};

export const ROLES = {
    composer: "Composer: harmony, chords, melody, note choice",
    drum_programmer: "Drum programmer: drum patterns, fills, which drum sounds play",
    bass_programmer: "Bass programmer: the bass line's notes and rhythm",
    arranger: "Arranger: song structure over time; sections, what plays when, builds and drops",
    instrument_designer: "Instrument designer: how instruments sound; synth patches, presets, layering",
    effect_designer: "Effect designer: effects on a sound, and effect sounds such as risers, sweeps and impacts",
    mix_engineer: "Mix engineer: balance between parts; levels, EQ, compression, sidechain",
    groove: "Groove: timing and feel across all parts; swing, humanizing, push and pull against the grid",
    researcher: "Researcher: looks up a reference song, artist, genre or technique and summarizes it for the team",
    critic: "Critic: listens and gives an opinion on what works; makes no edits",
};

// ---------- 1. Team Lead: split a direction among members ----------

export const LEAD_SYSTEM = `You are the Team Lead of an AI music production team working live with a producer in openDAW, usually while the track plays.

You are the front door. You take the producer's direction, split it among the team members whose areas it touches, and tell the producer who is doing what. You do no musical work yourself and don't plan the members' edits; each member turns its piece into edits.

- Give each member one piece: a short instruction in that member's area, specific to this project.
- Bring in only the members the direction needs. A narrow request goes to one member.
- If the direction is ambiguous in a way that would send the team in different directions, bring in no one and ask one short question instead.
- The producer reads your reply at a glance while playing: one or two short sentences.`;

export const LeadPlan = z.object({
    reply: z.string().describe("What the producer reads: one or two short sentences"),
    members: z.array(z.object({
        role: z.enum(Object.keys(ROLES)),
        piece: z.string().describe("This member's part of the direction, one sentence"),
    })),
});

export const leadInput = c => JSON.stringify({ project: PROJECT, team: ROLES, direction: c.direction });

// `need`: groups of roles, one of each group must be brought in. `max`: most members that still makes sense.
export const LEAD_CASES = [
    { direction: { text: "Slowly evolve this from a lo-fi beat into a house track", control: { label: "Pace", value: 30, low_end: "slow", high_end: "fast" } },
      need: [["drum_programmer", "groove"], ["instrument_designer"], ["bass_programmer", "mix_engineer"]], max: 6 },
    { direction: { text: "make it darker" }, need: [["instrument_designer", "composer", "effect_designer", "mix_engineer"]], min: 2, max: 4 },
    { direction: { text: "jazzier chords please" }, need: [["composer"]], max: 2 },
    { direction: { text: "build up to a drop at bar 17" }, need: [["arranger"]], max: 4 },
    { direction: { text: "make it sound more like Burial" }, need: [["researcher", "drum_programmer", "instrument_designer"]], max: 6 },
    { direction: { text: "the kick is too loud" }, need: [["mix_engineer"]], max: 1 },
    { direction: { text: "strip it back for the next 8 bars" }, need: [["arranger"]], max: 2 },
    { direction: { text: "make it better" }, need: [], max: 4, askOk: true },
];

export function gradeLead(c, plan) {
    const roles = plan.members.map(m => m.role), issues = [];
    if (!roles.length && !c.askOk) issues.push("brought in no one");
    for (const group of c.need) if (roles.length && !group.some(r => roles.includes(r))) issues.push(`missing ${group.join("|")}`);
    if (roles.length > c.max) issues.push(`${roles.length} members (max ${c.max})`);
    if (c.min && roles.length && roles.length < c.min) issues.push(`${roles.length} members (min ${c.min})`);
    if (new Set(roles).size !== roles.length) issues.push("a role twice");
    if (plan.reply.split(/[.!?](\s|$)/).filter(s => s.trim()).length > 3) issues.push("reply over 3 sentences");
    return issues;
}

// ---------- 2. A member: plan edits as operation calls ----------

export const memberSystem = (role, brief) => `You are the ${role} on an AI music production team working live in openDAW with a producer, while the track plays. Your area: ${brief}.

The Team Lead has given you a piece of the producer's direction. Plan your next edits for it as operation calls, using the tools.
- Each call is one edit that lands at the start of a bar you choose. Land edits ahead of the playhead: never before \`playback.bar + 1\`.
- Make 1 to 4 calls, only in your own area.
- If no operation can do what your piece needs, make no call and say in one sentence what is missing.
- Don't explain your plan; the calls are the plan.`;

const PARAMS = {
    "t1.mix.volume": "Drums volume, dB (-60 to +6)", "t2.mix.volume": "Keys volume, dB (-60 to +6)",
    "t3.mix.volume": "Bass volume, dB (-60 to +6)", "t4.mix.volume": "Vinyl crackle volume, dB (-60 to +6)",
    "t2.fx1.bits": "Keys Crusher bit depth (1 to 16; fewer is harsher)", "t2.fx1.mix": "Keys Crusher wet/dry (0 to 1)",
    "t2.fx2.cutoff": "Keys low-pass cutoff, percent (0 dark to 100 bright)", "t2.fx2.resonance": "Keys filter resonance, percent (0 to 100)",
};
export const PARAM_RANGE = { volume: [-60, 6], bits: [1, 16], mix: [0, 1], cutoff: [0, 100], resonance: [0, 100] };
const PATTERNS = { boom_bap_swung: "swung hip hop beat", four_on_floor: "kick on every beat", four_on_floor_offbeat_hats: "kick on every beat, open hats between",
    house_full: "kick on every beat, offbeat open hats, clap on 2 and 4", breakbeat: "chopped breakbeat", half_time: "half-time, snare on 3" };
const PRESETS = { rhodes: "Rhodes electric piano", dx7_epiano: "glassy FM electric piano", juno_strings: "warm analog string pad",
    m1_piano_stab: "bright digital house piano stab", m1_organ: "house organ bass", hoover: "detuned rave hoover",
    supersaw: "big detuned supersaw pad", sub_bass: "clean sine sub bass", acid_303: "squelchy acid bassline synth" };
const list = o => Object.entries(o).map(([k, v]) => `${k}: ${v}`).join("; ");
const atBar = { type: "integer", description: "The bar the edit lands on (its downbeat)" };
const tool = (name, description, properties) => ({
    name, description, strict: true,
    input_schema: { type: "object", properties, required: Object.keys(properties), additionalProperties: false },
});

export const TOOLS = [
    tool("ramp_param", "Move a parameter gradually from its current value to a new one, starting at a bar.", {
        param: { type: "string", enum: Object.keys(PARAMS), description: list(PARAMS) },
        to: { type: "number", description: "Target value, in the parameter's units" },
        over_bars: { type: "integer", enum: [1, 2, 4, 8, 16] }, at_bar: atBar }),
    tool("set_param", "Set a parameter to a new value at a bar.", {
        param: { type: "string", enum: Object.keys(PARAMS), description: list(PARAMS) },
        to: { type: "number", description: "New value, in the parameter's units" }, at_bar: atBar }),
    tool("swap_preset", "Replace a track's instrument sound with a preset, from a bar on.", {
        track: { type: "string", enum: ["t2", "t3"] }, preset: { type: "string", enum: Object.keys(PRESETS), description: list(PRESETS) }, at_bar: atBar }),
    tool("set_pattern", "Replace the drum pattern on t1 from a bar on.", {
        pattern: { type: "string", enum: Object.keys(PATTERNS), description: list(PATTERNS) }, at_bar: atBar }),
    tool("set_mute", "Mute or unmute a track from a bar on.", {
        track: { type: "string", enum: ["t1", "t2", "t3", "t4"] }, muted: { type: "boolean" }, at_bar: atBar }),
    tool("add_part", "Add a new track with an instrument preset; write notes to it with write_notes, using its name as the track.", {
        name: { type: "string" }, preset: { type: "string", enum: Object.keys(PRESETS), description: list(PRESETS) }, at_bar: atBar }),
    tool("write_notes", "Replace the notes of a track between two bars.", {
        track: { type: "string", description: "t2, t3, or the name of a part added with add_part" },
        from_bar: { type: "integer" }, to_bar: { type: "integer", description: "Last bar written, inclusive" },
        notes: { type: "array", items: { type: "object", additionalProperties: false, required: ["at", "pitch", "sixteenths", "velocity"], properties: {
            at: { type: "string", description: "Start, as bar.beat.sixteenth, e.g. 17.1.1" },
            pitch: { type: "integer", description: "MIDI note number; 57 is A3 in openDAW's naming" },
            sixteenths: { type: "integer", description: "Length in sixteenth notes" },
            velocity: { type: "integer", description: "1 to 127" } } } } }),
];

const intent = (label, value, low_end, high_end, meaning) => ({ label, value, low_end, high_end, meaning });
export const memberInput = c => JSON.stringify({ project: PROJECT, piece: c.piece, ...(c.control ? { your_control: c.control } : {}) });

// `ops`: at least one call must be one of these; `none`: a correct plan makes no call; `check(calls)`: extra issues.
const A_MINOR = new Set([9, 11, 0, 2, 4, 5, 7]);
export const MEMBER_CASES = [
    { role: "drum_programmer", piece: "Straighten the groove toward a four-on-the-floor house beat, one step at a time.", ops: ["set_pattern"] },
    { role: "instrument_designer", piece: "Move the keys toward a late-80s house sound.", control: intent("Era", 1988, "1980", "2000", "which era the next sounds come from"),
      ops: ["swap_preset", "add_part"], check: calls => calls.some(c => ["m1_piano_stab", "m1_organ"].includes(c.input.preset)) ? [] : ["no late-80s preset"] },
    { role: "mix_engineer", piece: "Make room in the low end for a heavier kick.", ops: ["set_param", "ramp_param"], noneOk: true },
    { role: "effect_designer", piece: "A riser into bar 17.", ops: ["ramp_param"],
      check: calls => calls.some(c => c.name === "ramp_param" && c.input.at_bar + c.input.over_bars === 17) ? [] : ["no ramp ending at bar 17"] },
    { role: "arranger", piece: "Strip back for bars 17 to 24, drums and bass only, then everything back at bar 25.", ops: ["set_mute"],
      check: calls => {
          const m = (t, muted, bar) => calls.some(c => c.name === "set_mute" && c.input.track === t && c.input.muted === muted && c.input.at_bar === bar);
          return [m("t2", true, 17) || "keys not muted at 17", m("t2", false, 25) || "keys not back at 25"].filter(x => x !== true);
      } },
    { role: "bass_programmer", piece: "An octave-bouncing house bassline for bars 17 to 24 that follows the chords.", ops: ["write_notes"],
      check: calls => notesIssues(calls, { track: "t3", from: 17, to: 24, lo: 24, hi: 60, scale: 0.85 }) },
    { role: "composer", piece: "Jazzier chord voicings on the keys from bar 17 to 24.", ops: ["write_notes"],
      check: calls => notesIssues(calls, { track: "t2", from: 17, to: 24, lo: 36, hi: 96, scale: 0.6 }) },
    { role: "composer", piece: "Re-harmonize the vocal in the chorus.", none: true },
    { role: "instrument_designer", piece: "Add a new pad from the 90s palette, coming in at bar 17.", control: intent("Era", 1995, "1980", "2000", "which era the next sounds come from"),
      ops: ["add_part"], check: calls => calls.some(c => c.name === "add_part" && ["hoover", "supersaw"].includes(c.input.preset)) ? [] : ["no 90s preset"] },
];

function notesIssues(calls, { track, from, to, lo, hi, scale }) {
    const w = calls.filter(c => c.name === "write_notes" && c.input.track === track);
    if (!w.length) return [`no write_notes on ${track}`];
    const notes = w.flatMap(c => c.input.notes), issues = [];
    if (notes.length < 8) issues.push(`only ${notes.length} notes`);
    const bars = notes.map(n => Number(n.at.split(".")[0]));
    if (bars.some(b => b < from || b > to)) issues.push(`notes outside bars ${from}-${to}`);
    if (notes.some(n => n.pitch < lo || n.pitch > hi)) issues.push(`pitch outside ${lo}-${hi}`);
    if (notes.some(n => !/^\d+\.[1-4]\.[1-4]$/.test(n.at))) issues.push("malformed position");
    const inKey = notes.filter(n => A_MINOR.has(n.pitch % 12)).length / (notes.length || 1);
    if (inKey < scale) issues.push(`${Math.round(inKey * 100)}% in A minor`);
    return issues;
}

// ---------- Round two: a roster of what each member can do, and ownership of targets ----------
// The Team Lead (and Jev) read the roster as members read the operations; each member gets only its own tools.

const VOLUMES = ["t1.mix.volume", "t2.mix.volume", "t3.mix.volume", "t4.mix.volume"];
const KEYS_FX = ["t2.fx1.bits", "t2.fx1.mix", "t2.fx2.cutoff", "t2.fx2.resonance"];
export const ROSTER = {
    composer: { can: "write chord and melody notes on the keys (t2) and on added parts", ops: ["write_notes"], notes: ["t2", "*"] },
    drum_programmer: { can: "change the drum pattern from a bar on", ops: ["set_pattern"] },
    bass_programmer: { can: "write the bass notes (t3) and swap the bass sound", ops: ["write_notes", "swap_preset"], tracks: ["t3"], notes: ["t3"] },
    arranger: { can: "mute and unmute tracks from a bar on", ops: ["set_mute"] },
    instrument_designer: { can: "swap the keys' sound for a preset, and add new parts with a preset", ops: ["swap_preset", "add_part"], tracks: ["t2"] },
    effect_designer: { can: "set or ramp the keys' Crusher (bits, mix) and Filter (cutoff, resonance)", ops: ["ramp_param", "set_param"], params: KEYS_FX },
    mix_engineer: { can: "set or ramp each track's volume", ops: ["ramp_param", "set_param"], params: VOLUMES },
    groove: { can: "nothing yet: there is no swing, quantize or timing operation", ops: [] },
    researcher: { can: "nothing in the project: it summarizes a reference for the team", ops: [] },
    critic: { can: "nothing in the project: it gives notes", ops: [] },
};
export const TEAM_CANNOT = "change the tempo; change swing or timing; EQ, compression or sidechain; reverb or delay; add samples or recordings; change single drum sounds within the kit";

export const LEAD_SYSTEM_V2 = `${LEAD_SYSTEM}
- Each member can do only what \`team.<role>.can\` says. Give a member only work it can carry out.
- If part of the direction needs something the team can't do (\`team_cannot\`), leave it out of the pieces and say so in a few words in the reply.`;
export const leadInputV2 = c => JSON.stringify({ project: PROJECT,
    team: Object.fromEntries(Object.entries(ROSTER).map(([r, x]) => [r, { area: ROLES[r], can: x.can }])), team_cannot: TEAM_CANNOT, direction: c.direction });

// A member's tools: only its operations, narrowed to its targets.
export function toolsFor(role) {
    const r = ROSTER[role];
    return TOOLS.filter(t => r.ops.includes(t.name)).map(t => {
        const t2 = structuredClone(t), p = t2.input_schema.properties;
        if (p.param && r.params) p.param.enum = r.params;
        if (p.track?.enum && r.tracks) p.track.enum = r.tracks;
        if (t.name === "write_notes") p.track.description = r.notes.includes("*") ? "t2, or the name of a part added with add_part" : r.notes.join(" or ");
        return t2;
    });
}

// What an edit touches: the unit of ownership. The first member to touch a target owns it for the direction.
const targetOf = k => ({ ramp_param: k.input.param, set_param: k.input.param, swap_preset: `${k.input.track}.instrument`, set_pattern: "t1.pattern",
    set_mute: `${k.input.track}.mute`, add_part: `part:${k.input.name}`, write_notes: `${k.input.track}.notes` })[k.name];
export function conflicts(members) {
    const owner = {}, out = new Set();
    for (const { role, calls } of members) for (const k of calls) {
        const t = targetOf(k);
        if (owner[t] && owner[t] !== role) out.add(`${t}: ${owner[t]} and ${role}`); else owner[t] = role;
    }
    return [...out];
}
export function outOfRole(role, k) {
    const r = ROSTER[role];
    if (!r.ops.includes(k.name)) return true;
    if (r.params && k.input.param && !r.params.includes(k.input.param)) return true;
    if (r.tracks && k.input.track && k.name === "swap_preset" && !r.tracks.includes(k.input.track)) return true;
    if (k.name === "write_notes" && !r.notes.includes("*") && !r.notes.includes(k.input.track)) return true;
    if (k.name === "write_notes" && r.notes.includes("*") && ["t1", "t3", "t4"].includes(k.input.track)) return true;
    return false;
}
// Work handed to a member that no operation offers (crude: by keyword in the pieces).
export const IMPOSSIBLE = /tempo|bpm|swing|shuffle|groove feel|sidechain|reverb|delay|\beq\b|compress|rain|ambien|impact|vocal|crash/i;

export function gradeMember(c, calls, text) {
    const issues = [];
    if (c.none) return calls.length ? [`made ${calls.length} call(s), expected none`] : [];
    if (!calls.length) return c.noneOk ? [] : [`no calls (${text.slice(0, 80)})`];
    if (!calls.some(k => c.ops.includes(k.name))) issues.push(`none of ${c.ops.join("|")}`);
    if (calls.length > 4) issues.push(`${calls.length} calls`);
    for (const k of calls) {
        const bar = k.input.at_bar ?? k.input.from_bar;
        if (bar !== undefined && (bar < PROJECT.playback.bar + 1 || bar > 33)) issues.push(`${k.name} at bar ${bar}`);
        if ("to" in k.input && k.input.param) {
            const [lo, hi] = PARAM_RANGE[k.input.param.split(".").pop()];
            if (k.input.to < lo || k.input.to > hi) issues.push(`${k.input.param} to ${k.input.to}`);
        }
    }
    return [...issues, ...(c.check ? c.check(calls) : [])];
}
