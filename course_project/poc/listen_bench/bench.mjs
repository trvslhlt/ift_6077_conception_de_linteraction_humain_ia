// Runs the listening judgments twice, with summaries as raw numbers and in words, and compares.
// Usage: node --env-file=... bench.mjs [selfcheck] [problems] [explain]
import { mkdirSync, writeFileSync } from "node:fs";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import Anthropic from "@anthropic-ai/sdk";
import { BASE, SELFCHECK, selfcheckQuestions, PROBLEMS, problemQuestions, EXPLAIN, EXPLAIN_SYSTEM, wordSummary, wordDiff, rawDiff } from "./cases.mjs";

for (const k of ["TYPESAFE_API_KEY", "ANTHROPIC_API_KEY"]) if (!process.env[k]) { console.error(`${k} is not set (see README.md).`); process.exit(1); }
const parts = process.argv.slice(2).length ? process.argv.slice(2) : ["selfcheck", "problems", "explain"];
const MODES = ["raw", "words"];
const jev = new TypeSafeClient(), claude = new Anthropic();
const any = v => (Array.isArray(v) ? v : [v]);
const rows = [];
const timed = async fn => { const t0 = performance.now(); const r = await fn(); return [r, performance.now() - t0]; };
const line = (ok, label, got, ms) => console.log(`${ok ? "✓" : "✗"} ${label.padEnd(50)} ${got.padEnd(44)} ${Math.round(ms)} ms`);

if (parts.includes("selfcheck")) for (const mode of MODES) {
    console.log(`\n== self-check, summaries as ${mode}`);
    for (const c of SELFCHECK) {
        const change = mode === "raw" ? rawDiff(BASE, c.after) : wordDiff(BASE, c.after);
        const [res, ms] = await timed(() => jev.systemOne({ state: { member: c.member, intent: c.intent, did: c.did, change }, questions: selfcheckQuestions() }));
        const a = res.answers, achieved = a.achieved.noul > 0.5, noticed = a.noticed.noul > 0.5;
        const ok = achieved === c.achieved && any(c.noticed).includes(noticed);
        line(ok, c.name, `achieved ${a.achieved.noul.toFixed(2)}, noticed ${a.noticed.noul.toFixed(2)}`, ms);
        rows.push({ part: "selfcheck", mode, case: c.name, ok, ms, tokens: res.usage.input_tokens, answers: a });
    }
}

if (parts.includes("problems")) for (const mode of MODES) {
    console.log(`\n== problems, summaries as ${mode}`);
    for (const c of PROBLEMS) {
        const mix = mode === "raw" ? c.s : wordSummary(c.s);
        const [res, ms] = await timed(() => jev.systemOne({ state: { mix }, questions: problemQuestions() }));
        const a = res.answers, ok = a.issue.choice === c.issue && (!c.track || any(c.track).includes(a.track.choice));
        line(ok, c.name, `${a.issue.choice} (${a.issue.confidence.toFixed(2)})${c.track ? `, ${a.track.choice}` : ""}`, ms);
        rows.push({ part: "problems", mode, case: c.name, ok, ms, tokens: res.usage.input_tokens, answers: a });
    }
}

if (parts.includes("explain")) for (const mode of MODES) {
    console.log(`\n== explaining (claude-haiku-5-5, low effort), summaries as ${mode}`);
    for (const c of EXPLAIN) {
        const summary = mode === "raw" ? JSON.stringify(c.s) : wordSummary(c.s);
        const [res, ms] = await timed(() => claude.messages.create({ model: "claude-haiku-5-5", max_tokens: 2000, output_config: { effort: "low" },
            system: EXPLAIN_SYSTEM, messages: [{ role: "user", content: `Summary: ${summary}\n\nProducer: ${c.q}` }] }));
        const text = res.content.filter(b => b.type === "text").map(b => b.text).join(" ").trim();
        const ok = c.must.every(re => re.test(text));
        line(ok, `"${c.q}"`, "", ms);
        console.log(`    ${text}`);
        rows.push({ part: "explain", mode, case: c.q, ok, ms, tokens: res.usage.input_tokens, text });
    }
}

console.log("\npart        mode    right   ms p50");
for (const part of parts) for (const mode of MODES) {
    const rs = rows.filter(r => r.part === part && r.mode === mode); if (!rs.length) continue;
    const ms = rs.map(r => r.ms).sort((a, b) => a - b)[Math.floor(rs.length / 2)];
    console.log(`${part.padEnd(11)} ${mode.padEnd(6)} ${String(rs.filter(r => r.ok).length).padStart(2)}/${rs.length}   ${Math.round(ms)}`);
}
mkdirSync("results", { recursive: true });
const file = `results/${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
writeFileSync(file, JSON.stringify({ rows }, null, 2));
console.log(`wrote ${file}`);
