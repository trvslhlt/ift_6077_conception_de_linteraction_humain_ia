import type {Overview, Snapshot} from "../../shared/protocol.ts"
import {analyse} from "./analysis.ts"
import {type Catalog, summariesForProject} from "./catalog.ts"
import type {Gateway, ModelLog} from "./gateway.ts"
import {type Member, projectFor} from "./members.ts"

// The Team Lead's language-model work (the slow tier, STRATEGY.md, "Responsiveness"): the project overview shown when
// the team view opens (FEATURES.md, "Project overview"; the playback line is the page's, live), and splitting a
// direction among the members (poc/llm_bench, round two: with a roster of what each can do, and what nobody can).

const OverviewSystem = `You describe a music project in openDAW to the producer working on it, as the opening overview of their AI team's view. They know music production; write as a fellow producer would.

Write exactly three lines, about 50 words in all, each starting with its label in bold:
**Music:** key, tempo, meter, length, and the musical idea: how the parts relate (rhythm, harmony, register).
**Style:** genre or reference in a few words, the feel (groove, dynamics, density), and how finished it sounds.
**Tracks:** each track's name and instrument with what kind of instrument it is in a few words from its catalog entry ("Bass on Cubed, a 303-style acid synth"), then any effects; no levels unless one stands out.

Rules:
- Use only the snapshot, the analysis and the catalog entries. A device's sound depends on its settings, which you can't hear: give its typical character from its catalog entry ("Cubed, a 303-style acid synth"), and never describe a device whose entry is null or marked opaque; name it instead.
- The catalog's genres are where a device is common, not evidence of this project's style; judge the style from the notes, tempo and kit first.
- Prefer musical terms over technical ones ("snare on 2 and 4", not "note 61 at 1.2.1").
- Positions are bars.beats.sixteenths, 1-based; note positions are relative to their region. A region with a loop length repeats; its notes are listed once.
- Pitches are MIDI numbers; openDAW names MIDI 60 "C3". The analysis's key is computed from durations; trust it unless the notes clearly say otherwise.
- One style label, the most specific you can defend from the notes, tempo and kit; no hedging lists. If there are no notes yet, say it's empty or a sketch, not a genre.
- Mention something missing only if it is an obvious next step.
- Nothing before or after the three lines.`

// The snapshot as the model reads it: no internal bookkeeping.
const forModel = (snapshot: Snapshot) => ({
    timeline: snapshot.timeline,
    tracks: snapshot.tracks.map(({lanes: _lanes, instrument: _instrument, ...track}) => track),
    master: snapshot.master
})

export const parseOverview = (text: string): Overview["lines"] => text.split("\n").flatMap(line => {
    const match = /^\s*(?:[-*]\s*)?\*\*([^*:]+):?\*\*:?\s*(.+)$/.exec(line)
    return match === null ? [] : [{label: match[1].trim(), text: match[2].trim()}]
})

export const writeOverview = async (gateway: Gateway, catalog: Catalog, log: ModelLog,
                                    snapshot: Snapshot): Promise<Overview> => {
    const user = [
        `Snapshot (JSON):\n${JSON.stringify(forModel(snapshot))}`,
        `Analysis (JSON, computed in code):\n${JSON.stringify(analyse(snapshot))}`,
        `Catalog entries for the devices used (JSON, by device key):\n${JSON.stringify(summariesForProject(catalog, snapshot))}`
    ].join("\n\n")
    const text = await gateway.write("overview", OverviewSystem, user, log, "agent:team_lead")
    const lines = parseOverview(text)
    if (lines.length === 0) {throw new Error(`no labelled lines in the model's reply: ${text.slice(0, 200)}`)}
    return {revision: snapshot.at.revision, t: Date.now(), lines}
}

// ---------- splitting a direction ----------

// not_built: what the direction needs that falls in a role's area but has no operation yet (the team's wishlist,
// FEATURES.md, "Naming what's missing").
export type LeadPlan = { reply: string, members: Array<{ role: string, piece: string }>,
    not_built: Array<{ role: string, needs: string }> }

const LeadSystem = `You are the Team Lead of an AI music production team working live with a producer in openDAW, usually while the track plays.

You are the front door. You take the producer's direction, split it among the team members whose areas it touches, and tell the producer who is doing what. You do no musical work yourself and don't plan the members' edits; each member turns its piece into edits.

- \`team\` lists each member's area (what the role covers) and \`can_now\` (the operations built for it so far). \`not_on_the_team\` lists roles that aren't built at all, with their areas.
- Give each member only what it can do now. The utility does what nobody else can do yet, directly in openDAW with code: when the direction, or part of it, needs an operation no member has (lengthening clips, new tracks, rewriting notes...), give that part to the utility, and list it in \`not_built\` with the role whose area it is, so it can become that role's own operation later. Prefer a member with the operation; the utility is slower (seconds to tens of seconds). The utility is your own hands and the producer doesn't know it exists: when you give it work, say you'll do it yourself ("I'll extend the clips"), never mention the utility.
- Only things openDAW itself can't do are impossible (hearing the result, outside services); say so plainly.
- Give each member one piece: a short instruction in that member's area, specific to this project (name tracks and bars).
- Bring in only the members the direction needs. A narrow request goes to one member.
- If the direction is ambiguous in a way that would send the team in different directions, bring in no one and ask one short question instead.
- If it's a question or a remark rather than a direction, answer it in the reply and bring in no one.
- The producer reads your reply at a glance while playing: one or two short sentences. Don't mention bar numbers or the playhead unless the producer did.`

export const lead = async (gateway: Gateway, log: ModelLog, snapshot: Snapshot, message: string,
                           team: ReadonlyArray<Member>, notOnTeam: Record<string, string>): Promise<LeadPlan> => {
    const schema = {
        type: "object", additionalProperties: false, required: ["reply", "members", "not_built"],
        properties: {
            reply: {type: "string", description: "What the producer reads: one or two short sentences"},
            members: {type: "array", items: {type: "object", additionalProperties: false, required: ["role", "piece"],
                properties: {role: {type: "string", enum: team.map(member => member.role)},
                    piece: {type: "string", description: "This member's part of the direction, one sentence"}}}},
            not_built: {type: "array", items: {type: "object", additionalProperties: false, required: ["role", "needs"],
                properties: {role: {type: "string", description: "The role whose area it is"},
                    needs: {type: "string", description: "The operation that would do it, e.g. lengthen a track's regions"}}}}
        }
    }
    const user = JSON.stringify({
        project: projectFor(snapshot, false),
        team: Object.fromEntries(team.map(member => [member.role, {area: member.area, can_now: member.can}])),
        not_on_the_team: notOnTeam,
        direction: message
    })
    return gateway.structured<LeadPlan>("team_lead", LeadSystem, user, schema, log, "agent:team_lead")
}
