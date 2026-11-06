// Audio summaries as the bus would make them (EXPERIMENTS.md, F), and the judgments agents make from them.
// The summaries here are constructed, not measured: this tests the judging, not the measuring.
// Every family runs twice: `raw` gives the numbers as JSON, `words` gives sentences code writes from them.
import { choice, noul } from "@typesafe-ai/sdk";

// Energy in dB per band: sub < 60 Hz, low 60–250, low_mid 250–1k, mid 1–4k, high > 4k.
const BANDS = { sub: "sub (below 60 Hz)", low: "lows (60–250 Hz)", low_mid: "low mids (250 Hz–1 kHz)", mid: "mids (1–4 kHz)", high: "highs (above 4 kHz)" };
const track = (name, lufs, peak, [sub, low, low_mid, mid, high], below150, extra = {}) =>
    ({ name, lufs, peak_db: peak, bands_db: { sub, low, low_mid, mid, high }, below_150hz_pct: below150, clipping: false, silent: false, ...extra });

// The prototype's project, bars 9–16.
export const BASE = {
    window: "bars 9–16", style: "lo-fi hip hop, 96 BPM",
    tracks: {
        t1: track("Drums", -16, -5, [-24, -18, -20, -19, -22], 35),
        t2: track("Keys", -20, -10, [-45, -30, -21, -22, -30], 3),
        t3: track("Bass", -19, -7, [-16, -24, -40, -55, -70], 92),
        t4: track("Vinyl", -32, -24, [-60, -50, -42, -36, -30], 2),
    },
    master: { lufs: -14, peak_db: -1.5, clipping: false },
    crowding: [],
};
const patch = (base, fn) => { const s = structuredClone(base); fn(s); return s; };

// ---------- in words ----------
const loudest = t => Object.entries(t.bands_db).sort((a, b) => b[1] - a[1])[0][0];
export function wordSummary(s) {
    const lines = Object.values(s.tracks).map(t => t.silent ? `${t.name}: silent.` :
        `${t.name}: ${t.lufs} LUFS, peak ${t.peak_db} dB${t.clipping ? ", clipping" : ""}; most energy in the ${BANDS[loudest(t)]}; `
        + `${t.below_150hz_pct}% of it below 150 Hz${t.below_150hz_pct >= 70 ? ", which laptop speakers barely play" : ""}.`);
    lines.push(`Whole track: ${s.master.lufs} LUFS, peak ${s.master.peak_db} dB${s.master.clipping ? ", clipping" : ""}.`);
    for (const c of s.crowding) lines.push(`${c.a} and ${c.b} crowd the same band, the ${BANDS[c.band]}, within ${c.within_db} dB of each other.`);
    return `${s.style}, ${s.window}. ${s.note ? s.note + " " : ""}` + lines.join(" ");
}
// Before → after, per track: bands that moved more than 1 dB, level, and the share below 150 Hz.
export function wordDiff(before, after) {
    const out = [];
    for (const [ref, a] of Object.entries(after.tracks)) {
        const b = before.tracks[ref];
        if (a.silent && !b.silent) { out.push(`${a.name}: went silent.`); continue; }
        const moved = Object.keys(BANDS).map(k => [k, a.bands_db[k] - b.bands_db[k]]).filter(([, d]) => Math.abs(d) > 1)
            .map(([k, d]) => `${BANDS[k]} ${Math.abs(d).toFixed(1)} dB ${d > 0 ? "louder" : "quieter"}`);
        const lv = a.lufs - b.lufs, share = a.below_150hz_pct - b.below_150hz_pct;
        if (Math.abs(lv) > 0.5) moved.unshift(`level ${Math.abs(lv).toFixed(1)} dB ${lv > 0 ? "louder" : "quieter"}`);
        if (Math.abs(share) >= 10) moved.push(`share below 150 Hz from ${b.below_150hz_pct}% to ${a.below_150hz_pct}%`);
        else if (moved.length && a.below_150hz_pct >= 70) moved.push(`still ${a.below_150hz_pct}% below 150 Hz, which laptop speakers barely play`);
        out.push(`${a.name}: ${moved.length ? moved.join(", ") : "no change (within 1 dB)"}.`);
    }
    return out.join(" ");
}
export const rawDiff = (before, after) => ({ before, after });

// ---------- 1. Self-check: did my edit do what I meant? ----------
const edit = (fn) => patch(BASE, fn);
const dB = (t, deltas) => { for (const [k, d] of Object.entries(deltas)) t.bands_db[k] += d; };

export const SELFCHECK = [
    { name: "darker keys: highs down 6 dB", member: "Effect designer", intent: "make the keys darker", did: "ramped the keys' filter cutoff from 35% to 20%",
      after: edit(s => { dB(s.tracks.t2, { mid: -2, high: -6 }); s.tracks.t2.lufs -= 1; }), achieved: true, noticed: true },
    { name: "darker keys: nothing changed", member: "Effect designer", intent: "make the keys darker", did: "ramped the keys' filter cutoff from 35% to 20%",
      after: edit(() => {}), achieved: false, noticed: false },
    { name: "bass audible on laptops: louder, still all sub", member: "Mix engineer", intent: "make the bass audible on laptop speakers", did: "raised the bass volume by 4 dB",
      after: edit(s => { dB(s.tracks.t3, { sub: 4, low: 4, low_mid: 4, mid: 4, high: 4 }); s.tracks.t3.lufs += 4; }), achieved: false, noticed: false },
    { name: "bass audible on laptops: up an octave", member: "Bass programmer", intent: "make the bass audible on laptop speakers", did: "moved the bass line up an octave",
      after: edit(s => { dB(s.tracks.t3, { sub: -10, low: 8, low_mid: 14, mid: 6 }); s.tracks.t3.below_150hz_pct = 40; }), achieved: true, noticed: true },
    { name: "room for the kick: bass lows down 3 dB", member: "Mix engineer", intent: "make room in the low end for the kick", did: "lowered the bass by 3 dB",
      after: edit(s => { dB(s.tracks.t3, { sub: -3, low: -3, low_mid: -3, mid: -3, high: -3 }); s.tracks.t3.lufs -= 3; }), achieved: true, noticed: [true, false] },
    { name: "strip to drums and bass: done", member: "Arranger", intent: "strip back to drums and bass only", did: "muted the keys and the vinyl",
      after: edit(s => { s.tracks.t2.silent = true; s.tracks.t4.silent = true; }), achieved: true, noticed: true },
    { name: "strip to drums and bass: keys still playing", member: "Arranger", intent: "strip back to drums and bass only", did: "muted the keys and the vinyl",
      after: edit(s => { s.tracks.t4.silent = true; }), achieved: false, noticed: true },
    { name: "kick down 2 dB: moved 0.2 dB", member: "Mix engineer", intent: "bring the drums down 2 dB", did: "lowered the drums' volume",
      after: edit(s => { s.tracks.t1.lufs -= 0.2; }), achieved: false, noticed: false },
    { name: "whole track darker", member: "Effect designer", intent: "make the whole track darker", did: "closed the keys' filter and lowered the vinyl",
      after: edit(s => { dB(s.tracks.t2, { mid: -3, high: -6 }); dB(s.tracks.t4, { mid: -4, high: -5 }); }), achieved: true, noticed: true },
    { name: "louder vinyl: vinyl +6 dB", member: "Mix engineer", intent: "bring the vinyl crackle up so it's clearly there", did: "raised the vinyl by 6 dB",
      after: edit(s => { dB(s.tracks.t4, { sub: 6, low: 6, low_mid: 6, mid: 6, high: 6 }); s.tracks.t4.lufs += 6; }), achieved: true, noticed: true },
];

export const selfcheckQuestions = () => ({
    achieved: noul("A member of an AI music team, `member`, made the edit in `did` to carry out `intent`. `change` is how the audio changed from before the edit to after it. Did the edit do what was intended, as heard?"),
    noticed: noul("A member of an AI music team made the edit in `did`. `change` is how the audio changed from before the edit to after it. Would a producer listening on laptop speakers notice the change?"),
});

// ---------- 2. Spotting the main problem in a mix ----------
const ISSUES = {
    none: "nothing stands out as a problem for this style",
    clipping: "the track or a part is clipping",
    inaudible_on_laptops: "a part's energy sits mostly where laptop speakers can't play it",
    crowding: "two parts crowd the same frequency band and mask each other",
    too_loud: "one part is too loud for its role in this style",
    silent: "a part that should be playing is silent",
};
const healthy = patch(BASE, s => { dB(s.tracks.t3, { sub: -6, low: 6, low_mid: 12 }); s.tracks.t3.below_150hz_pct = 45; });
export const PROBLEMS = [
    { name: "base: bass mostly sub", s: BASE, issue: "inaudible_on_laptops", track: "t3" },
    { name: "master clipping", s: patch(healthy, s => { s.master.peak_db = 0.4; s.master.clipping = true; }), issue: "clipping" },
    { name: "kick and bass crowd the lows", s: patch(healthy, s => { s.crowding = [{ a: "Drums", b: "Bass", band: "low", within_db: 1.5 }]; dB(s.tracks.t1, { low: 6 }); }), issue: "crowding", track: ["t1", "t3"] },
    { name: "vinyl louder than the keys", s: patch(healthy, s => { s.tracks.t4.lufs = -12; dB(s.tracks.t4, { mid: 20, high: 20, low_mid: 20 }); }), issue: "too_loud", track: "t4" },
    { name: "healthy mix", s: healthy, issue: "none" },
    { name: "keys silent", s: patch(healthy, s => { s.tracks.t2.silent = true; s.note = "The keys carry the chords throughout this section."; }), issue: "silent", track: "t2" },
    { name: "quiet vinyl is normal", s: patch(healthy, s => { s.tracks.t4.lufs = -36; }), issue: "none" },
];
export const problemQuestions = () => ({
    issue: choice("`mix` summarizes how a section of a track sounds. What is the main problem with it, if any, for its style?", ISSUES),
    track: choice("`mix` summarizes how a section of a track sounds. Assuming one part has a problem, which part?",
        { t1: "Drums", t2: "Keys", t3: "Bass", t4: "Vinyl" }),
});

// ---------- 3. Explaining to the producer (Haiku) ----------
export const EXPLAIN_SYSTEM = `You are the Mix engineer on an AI music team working live with a producer in openDAW. Answer the producer's question about how the track sounds in one or two short sentences, from the summary of what the audio measures (you can't hear it yourself). Say what you'd do about it, if anything.`;
export const EXPLAIN = [
    { q: "why can't I hear the bass?", s: BASE, must: [/150|laptop|speaker|low|sub/i, /octave|higher|harmonic|saturat|up/i] },
    { q: "why does the low end sound muddy?", s: PROBLEMS[2].s, must: [/kick|drum/i, /bass/i] },
    { q: "is anything clipping?", s: PROBLEMS[1].s, must: [/yes|clip|0\.4|over/i] },
    { q: "is anything clipping?", s: healthy, must: [/\bno\b|not|nothing|-1\.5|headroom/i] },
    { q: "is the vinyl too loud?", s: PROBLEMS[3].s, must: [/yes|too loud|louder|-12/i] },
];
