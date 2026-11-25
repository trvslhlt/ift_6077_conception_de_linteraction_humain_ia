import type {Overview, Snapshot} from "../../shared/protocol.ts"
import {analyse} from "./analysis.ts"
import {type Catalog, summariesForProject} from "./catalog.ts"
import type {Gateway, ModelLog} from "./gateway.ts"

// The project overview shown when the team view opens (FEATURES.md, "Project overview"; the playback line is the
// page's, live). Splitting a direction among the members lived here too, until the ROSTER=team path was retired
// (2026-11-23): the captain (captain.ts) does that now.

const OverviewSystem = `You describe a music project in openDAW to the producer working on it, as the opening overview of their AI team's view. They know music production; write as a fellow producer would.

Write exactly three lines, about 50 words in all, each starting with its label in bold (and a fourth, **Names:**, only when asked below):
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
- If the user message lists tracks named only after their instrument, add a fourth line, **Names:**, giving each a short name for its role and sound as a producer would label the track, by ref: "**Names:** t2 = Acid Bass; t4 = Warm Pad". Use what the notes and the catalog entry say (a 303-style synth playing low notes is an acid bass); two or three words; no device names.
- Nothing before or after these lines.`

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

// Tracks still named after their instrument, as openDAW names a new one ("Cubed", "Vaporisateur 2"): the overview
// names them for their role and sound (2026-11-25, the producer: "I don't know what 'Cubed' means, but I know what
// 'acid bass' is"), and the coordinator renames them. A name anyone chose is kept.
export const deviceNamed = (catalog: Catalog, snapshot: Snapshot): Array<{ ref: string, name: string }> =>
    snapshot.tracks.filter(track => {
        if (track.device === null) {return false}
        const name = track.name.replace(/\s+\d+$/, "").trim().toLowerCase()
        return [track.device.key, catalog.summary(track.device.key)?.name ?? ""].some(device => device.toLowerCase() === name)
    }).map(track => ({ref: track.ref, name: track.name}))

export const writeOverview = async (gateway: Gateway, catalog: Catalog, log: ModelLog,
                                    snapshot: Snapshot): Promise<{ overview: Overview, names: Record<string, string> }> => {
    const unnamed = deviceNamed(catalog, snapshot)
    const user = [
        `Snapshot (JSON):\n${JSON.stringify(forModel(snapshot))}`,
        `Analysis (JSON, computed in code):\n${JSON.stringify(analyse(snapshot))}`,
        `Catalog entries for the devices used (JSON, by device key):\n${JSON.stringify(summariesForProject(catalog, snapshot))}`,
        ...(unnamed.length === 0 ? [] : [`Tracks named only after their instrument (JSON): ${JSON.stringify(unnamed)}`])
    ].join("\n\n")
    const text = await gateway.write("overview", OverviewSystem, user, log, "agent:team_lead")
    const all = parseOverview(text)
    const lines = all.filter(line => line.label.toLowerCase() !== "names")
    if (lines.length === 0) {throw new Error(`no labelled lines in the model's reply: ${text.slice(0, 200)}`)}
    const asked = new Set(unnamed.map(track => track.ref))
    const names = Object.fromEntries((all.find(line => line.label.toLowerCase() === "names")?.text ?? "").split(";")
        .map(pair => /^\s*(t\d+)\s*[=:]\s*(.+?)\s*\.?\s*$/.exec(pair)).filter(match => match !== null)
        .map(match => [match![1], match![2].replace(/["*]/g, "").slice(0, 40)]).filter(([ref, name]) => asked.has(ref) && name !== ""))
    return {overview: {revision: snapshot.at.revision, t: Date.now(), lines}, names}
}
