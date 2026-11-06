// Runs every case in families.mjs against Jev, one request at a time, and reports accuracy, confidence and latency.
// Usage: node --env-file=.env bench.mjs [family ...]
import { mkdirSync, writeFileSync } from "node:fs";
import { TypeSafeClient, choice } from "@typesafe-ai/sdk";
import { FAMILIES } from "./families.mjs";

const REPEATS = Number(process.env.REPEATS ?? 1);   // >1 to get steadier latency figures
const CONFIDENT = 0.7;                              // the cut-off reported as "accuracy when confident"

if (!process.env.TYPESAFE_API_KEY) {
    console.error("TYPESAFE_API_KEY is not set: put it in .env (see README.md).");
    process.exit(1);
}
const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(FAMILIES);
const unknown = names.filter(n => !FAMILIES[n]);
if (unknown.length) { console.error(`Unknown family: ${unknown.join(", ")}. Known: ${Object.keys(FAMILIES).join(", ")}`); process.exit(1); }

const client = new TypeSafeClient();

// One untimed request first, so connection setup doesn't land on the first case.
await client.systemOne({ state: { text: "warm-up" }, questions: { q: choice("Is this a warm-up?", { yes: null, no: null }) } });

async function one(request) {
    const t0 = performance.now();
    const res = await client.systemOne(request);
    return { answers: res.answers, ms: performance.now() - t0, model: res.model, inputTokens: res.usage.input_tokens,
        questions: Object.keys(request.questions).length, requests: 1 };
}

const rows = [];
let model = "";
for (const name of names) {
    const fam = FAMILIES[name];
    console.log(`\n== ${name}: ${fam.describe}`);
    for (const c of fam.cases) {
        const label = c.name ?? c.msg;
        for (let r = 0; r < REPEATS; r++) {
            const t0 = performance.now();
            try {
                // A family either builds one request, or runs its own chain of requests (`run`).
                const res = fam.run ? await fam.run(client, c) : await one(fam.build(c));
                const ms = res.ms;
                model = res.model;
                const g = fam.grade(c, res.answers);
                rows.push({ family: name, case: label, ...g, ms, questions: res.questions, requests: res.requests,
                    inputTokens: res.inputTokens, answers: res.answers });
                console.log(`${g.ok ? "✓" : "✗"} ${label.padEnd(52)} ${String(g.got).padEnd(28)} conf ${g.conf.toFixed(2)}  ${Math.round(ms)} ms`);
            } catch (e) {
                const ms = performance.now() - t0;
                rows.push({ family: name, case: label, ok: false, error: String(e), ms });
                console.log(`! ${label.padEnd(52)} ${e.name}: ${e.message}`);
                if (e.status === 401 || e.status === 403) process.exit(1);
            }
        }
    }
}

const q = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const f2 = x => (Number.isNaN(x) ? "  -" : x.toFixed(2));

console.log(`\nmodel ${model}, ${REPEATS} run(s) per case, "confident" = confidence ≥ ${CONFIDENT}\n`);
console.log("family      cases  right  conf(right)  conf(wrong)  confident: n right   ms p50   ms p90   questions  tokens");
const summary = {};
for (const name of names) {
    const rs = rows.filter(r => r.family === name), ok = rs.filter(r => r.ok), bad = rs.filter(r => !r.ok && !r.error);
    const sure = rs.filter(r => r.conf >= CONFIDENT), ms = rs.filter(r => !r.error).map(r => r.ms);
    const s = summary[name] = {
        cases: rs.length, right: ok.length, errors: rs.filter(r => r.error).length,
        confRight: mean(ok.map(r => r.conf)), confWrong: mean(bad.map(r => r.conf)),
        confident: sure.length, confidentRight: sure.filter(r => r.ok).length,
        p50: q(ms, 0.5), p90: q(ms, 0.9), questions: rs[0]?.questions, tokens: mean(rs.filter(r => r.inputTokens).map(r => r.inputTokens)),
    };
    console.log(`${name.padEnd(11)} ${String(s.cases).padStart(5)}  ${String(s.right).padStart(5)}  ${f2(s.confRight).padStart(11)}  ${f2(s.confWrong).padStart(11)}  `
        + `${String(s.confident).padStart(11)} ${String(s.confidentRight).padStart(5)}  ${String(Math.round(s.p50)).padStart(7)}  ${String(Math.round(s.p90)).padStart(7)}  `
        + `${String(s.questions).padStart(9)}  ${String(Math.round(s.tokens)).padStart(6)}`);
}

mkdirSync("results", { recursive: true });
const file = `results/${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
writeFileSync(file, JSON.stringify({ model, repeats: REPEATS, sdk: "0.7.0", summary, rows }, null, 2));
console.log(`\nwrote ${file}`);
