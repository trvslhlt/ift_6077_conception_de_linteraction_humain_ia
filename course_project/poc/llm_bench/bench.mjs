// Runs the slow tier's jobs against Claude and reports checks, latency, tokens and cost.
// Usage: node --env-file=... bench.mjs [lead] [member] [e2e]     MODEL, EFFORT, BUDGET (dollars) from the environment.
import { mkdirSync, writeFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { LEAD_SYSTEM, LeadPlan, leadInput, LEAD_CASES, gradeLead, memberSystem, memberInput, TOOLS, MEMBER_CASES, gradeMember, ROLES,
    LEAD_SYSTEM_V2, leadInputV2, toolsFor, conflicts, outOfRole, IMPOSSIBLE } from "./cases.mjs";

// Haiku at low effort did the jobs about as well as Opus at a fortieth of the cost (README.md, round three).
const MODEL = process.env.MODEL ?? "claude-haiku-5-5";
const EFFORT = process.env.EFFORT ?? "low";
const ROSTERED = process.env.ROSTER !== "0";   // the Team Lead reads the roster; members get only their own tools. ROSTER=0: round one
const BUDGET = Number(process.env.BUDGET ?? 5);
const PRICE = { "claude-opus-5-5": [4, 20], "claude-sonnet-5-5": [2, 10], "claude-haiku-5-5": [0.1, 0.5] }[MODEL];  // $ per MTok in/out
if (!PRICE) { console.error(`No price for ${MODEL}; add it to PRICE.`); process.exit(1); }
if (!process.env.ANTHROPIC_API_KEY) { console.error("ANTHROPIC_API_KEY is not set (see README.md)."); process.exit(1); }

const parts = process.argv.slice(2).length ? process.argv.slice(2) : ["lead", "member", "e2e"];
const client = new Anthropic();
// Opus and Sonnet can decline on a safety classifier; "default" fallbacks retry such a request on a fallback model.
// Haiku has no server-side fallback.
const COMMON = { model: MODEL, max_tokens: 16000,
    ...(MODEL.includes("haiku") ? {} : { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" }) };

let spent = 0;
const rows = [];
async function call(kind, params) {
    if (spent >= BUDGET) throw new Error(`budget of $${BUDGET} reached`);
    const t0 = performance.now();
    const res = await (kind === "parse" ? client.beta.messages.parse(params) : client.beta.messages.create(params));
    const ms = performance.now() - t0, u = res.usage;
    const cost = (u.input_tokens * PRICE[0] + u.output_tokens * PRICE[1]) / 1e6;
    spent += cost;
    if (res.stop_reason === "refusal") throw new Error(`refused: ${res.stop_details?.category}`);
    if (res.stop_reason === "max_tokens") throw new Error("hit max_tokens");
    return { res, ms, inTok: u.input_tokens, outTok: u.output_tokens, cost };
}

const roleName = r => ROLES[r].split(":")[0];

async function lead(c) {
    const r = await call("parse", { ...COMMON, system: ROSTERED ? LEAD_SYSTEM_V2 : LEAD_SYSTEM, output_config: { effort: EFFORT, format: betaZodOutputFormat(LeadPlan) },
        messages: [{ role: "user", content: (ROSTERED ? leadInputV2 : leadInput)(c) }] });
    return { ...r, plan: r.res.parsed_output };
}
async function member(c) {
    const tools = ROSTERED ? toolsFor(c.role) : TOOLS;
    const r = await call("create", { ...COMMON, system: memberSystem(roleName(c.role), ROLES[c.role]), ...(tools.length ? { tools } : {}),
        output_config: { effort: EFFORT }, messages: [{ role: "user", content: memberInput(c) }] });
    const calls = r.res.content.filter(b => b.type === "tool_use").map(b => ({ name: b.name, input: b.input }));
    const text = r.res.content.filter(b => b.type === "text").map(b => b.text).join(" ").trim();
    return { ...r, calls, text };
}

const meta = r => `${(r.ms / 1000).toFixed(1)} s, ${r.inTok}→${r.outTok} tok, $${r.cost.toFixed(3)}`;
const showCall = k => k.name === "write_notes"
    ? `write_notes ${k.input.track} bars ${k.input.from_bar}-${k.input.to_bar}: ${k.input.notes.length} notes, e.g. ${k.input.notes.slice(0, 4).map(n => `${n.at}/${n.pitch}`).join(" ")}`
    : `${k.name} ${JSON.stringify(k.input)}`;
const verdict = issues => (issues.length ? `✗ ${issues.join("; ")}` : "✓");

if (parts.includes("lead")) {
    console.log(`\n== Team Lead: split a direction (${MODEL}, effort ${EFFORT})`);
    for (const c of LEAD_CASES) {
        const r = await lead(c), issues = gradeLead(c, r.plan);
        console.log(`\n"${c.direction.text}"  ${verdict(issues)}  (${meta(r)})\n  reply: ${r.plan.reply}`);
        for (const m of r.plan.members) console.log(`  - ${roleName(m.role)}: ${m.piece}${IMPOSSIBLE.test(m.piece) ? "  [asks for something no operation offers?]" : ""}`);
        rows.push({ part: "lead", case: c.direction.text, ok: !issues.length, issues, ms: r.ms, inTok: r.inTok, outTok: r.outTok, cost: r.cost, plan: r.plan });
    }
}

if (parts.includes("member")) {
    console.log(`\n== Members: plan edits as operation calls (${MODEL}, effort ${EFFORT})`);
    for (const c of MEMBER_CASES) {
        const r = await member(c), issues = gradeMember(c, r.calls, r.text);
        console.log(`\n${roleName(c.role)}: "${c.piece}"  ${verdict(issues)}  (${meta(r)})`);
        for (const k of r.calls) console.log(`  - ${showCall(k)}`);
        if (r.text) console.log(`  says: ${r.text}`);
        rows.push({ part: "member", case: `${c.role}: ${c.piece}`, ok: !issues.length, issues, ms: r.ms, inTok: r.inTok, outTok: r.outTok, cost: r.cost, calls: r.calls, text: r.text });
    }
}

// From a direction to every member's planned edits: the Team Lead, then its members in parallel.
if (parts.includes("e2e")) {
    console.log(`\n== Direction to planned edits, end to end (${MODEL}, effort ${EFFORT})`);
    for (const c of LEAD_CASES.slice(0, 4)) {
        const t0 = performance.now();
        const l = await lead(c);
        const ms = await Promise.all(l.plan.members.map(async m => {
            const r = await member({ role: m.role, piece: m.piece });
            return { m, r, issues: gradeMember({ ops: TOOLS.map(t => t.name), noneOk: m.role === "critic" || m.role === "researcher" }, r.calls, r.text) };
        }));
        const total = performance.now() - t0, slowest = Math.max(0, ...ms.map(x => x.r.ms));
        const clash = conflicts(ms.map(x => ({ role: x.m.role, calls: x.r.calls })));
        const stray = ms.flatMap(x => x.r.calls.filter(k => outOfRole(x.m.role, k)).map(k => `${x.m.role} ${k.name}`));
        console.log(`\n"${c.direction.text}": ${(total / 1000).toFixed(1)} s in all (lead ${(l.ms / 1000).toFixed(1)} s, slowest member ${(slowest / 1000).toFixed(1)} s)`
            + `\n  conflicts: ${clash.join("; ") || "none"}\n  outside a member's role: ${stray.join("; ") || "none"}`);
        for (const { m, r, issues } of ms) {
            console.log(`  ${roleName(m.role)} ${verdict(issues)} (${meta(r)}): ${m.piece}`);
            for (const k of r.calls) console.log(`    - ${showCall(k)}`);
            if (r.text) console.log(`    says: ${r.text}`);
        }
        rows.push({ part: "e2e", case: c.direction.text, ms: total, leadMs: l.ms, slowestMemberMs: slowest, conflicts: clash, outOfRole: stray,
            cost: l.cost + ms.reduce((s, x) => s + x.r.cost, 0), members: ms.map(({ m, r, issues }) => ({ ...m, calls: r.calls, text: r.text, ms: r.ms, issues })) });
    }
}

const q = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
console.log(`\n${MODEL}, effort ${EFFORT}`);
for (const part of ["lead", "member", "e2e"]) {
    const rs = rows.filter(r => r.part === part); if (!rs.length) continue;
    const ok = rs.filter(r => r.ok).length, ms = rs.map(r => r.ms / 1000);
    console.log(`${part.padEnd(7)} ${part === "e2e" ? "" : `${ok}/${rs.length} pass  `}p50 ${q(ms, 0.5).toFixed(1)} s  max ${Math.max(...ms).toFixed(1)} s  $${rs.reduce((s, r) => s + r.cost, 0).toFixed(2)}`);
}
console.log(`spent $${spent.toFixed(2)} of the $${BUDGET} cap`);

mkdirSync("results", { recursive: true });
const file = `results/${MODEL}-${EFFORT}${ROSTERED ? "-roster" : ""}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
writeFileSync(file, JSON.stringify({ model: MODEL, effort: EFFORT, roster: ROSTERED, sdk: "1.1.0", spent, rows }, null, 2));
console.log(`wrote ${file}`);
