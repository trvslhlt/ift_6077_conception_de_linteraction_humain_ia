import type {Overview, Snapshot} from "../../shared/protocol.ts"
import {analyse} from "./analysis.ts"
import {type Catalog, summariesForProject} from "./catalog.ts"
import type {Gateway, ModelLog} from "./gateway.ts"

// The project overview shown when the team view opens (FEATURES.md, "Project overview"; the playback line is the
// page's, live). Splitting a direction among the members lived here too, until the ROSTER=team path was retired
// (2026-11-23): the captain (captain.ts) does that now.

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
