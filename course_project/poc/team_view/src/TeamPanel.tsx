import {createElement} from "@opendaw/lib-jsx"
import {Lifecycle, Terminator} from "@opendaw/lib-std"
import {DeleteUpdate, NewUpdate, PointerUpdate, PrimitiveUpdate, Update} from "@opendaw/lib-box"
import {PPQN} from "@opendaw/lib-dsp"
import {NoteClipBox, NoteRegionBox} from "@opendaw/studio-boxes"
import {AudioUnitBoxAdapter, InstrumentFactories, NoteClipBoxAdapter, NoteRegionBoxAdapter} from "@opendaw/studio-adapters"
import type {Project} from "@opendaw/studio-core"
import type {StudioService} from "@/service/StudioService"

// Team view POC: logs every change to the open project, tagged with who made it, makes changes itself, and reads
// state on demand (Read notes), the way agents will query the project in addition to having changes pushed.
// Every edit, from any panel, goes through project.editing and shows up in boxGraph.subscribeToAllUpdates.
// Updates fire synchronously inside the transaction, so a flag set around our own modify() tells them apart.

type Construct = { lifecycle: Lifecycle, service: StudioService }
type Source = "team" | "daw"
type NoteOwner = { kind: "region", adapter: NoteRegionBoxAdapter } | { kind: "clip", adapter: NoteClipBoxAdapter }

const MaxLogEntries = 200
const TempoStep = 5
const DemoPitches = [60, 64, 67, 72] // C major arpeggio, one note per beat
const NoteNames = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
const NotesPrompt = "Click Read notes to query the project."

export const TeamPanel = ({lifecycle, service}: Construct): HTMLElement => {
    const status: HTMLElement = <p data-testid="team-status">No project open.</p>
    const bpm: HTMLElement = <span data-testid="team-bpm">-</span>
    const tempoUp: HTMLButtonElement = (
        <button data-testid="team-tempo-up" disabled>Tempo +{TempoStep} BPM</button>
    )
    const addDemoClip: HTMLButtonElement = (
        <button data-testid="team-add-demo-clip" disabled>Add demo clip</button>
    )
    const readNotesButton: HTMLButtonElement = (
        <button data-testid="team-read-notes" disabled>Read notes</button>
    )
    const notesView: HTMLElement = (
        <pre data-testid="team-notes"
             style={{margin: "0", maxHeight: "35%", overflow: "auto", fontSize: "11px", whiteSpace: "pre-wrap"}}>
            {NotesPrompt}
        </pre>
    )
    const log: HTMLElement = (
        <ol data-testid="team-log" reversed
            style={{flex: "1 0 0", overflow: "auto", margin: "0", fontFamily: "monospace", fontSize: "11px"}}/>
    )
    let source: Source = "daw"

    const append = (entrySource: Source, text: string): void => {
        const item: HTMLElement = (
            <li data-source={entrySource} style={{color: entrySource === "team" ? "#7fd" : "inherit"}}>
                {`${new Date().toLocaleTimeString()} [${entrySource}] ${text}`}
            </li>
        )
        log.prepend(item)
        while (log.childElementCount > MaxLogEntries) {log.lastElementChild!.remove()}
    }

    const projectRuntime = lifecycle.own(new Terminator())
    lifecycle.own(service.projectProfileService.catchupAndSubscribe(optProfile => {
        projectRuntime.terminate()
        optProfile.match({
            none: () => {
                status.textContent = "No project open."
                bpm.textContent = "-"
                notesView.textContent = NotesPrompt
                for (const button of [tempoUp, addDemoClip, readNotesButton]) {
                    button.disabled = true
                    button.onclick = null
                }
            },
            some: ({project, meta}) => {
                const showBpm = () => bpm.textContent = project.timelineBox.bpm.getValue().toFixed(2)
                const asTeam = (edit: () => void): void => {
                    source = "team"
                    try {
                        project.editing.modify(edit)
                    } finally {
                        source = "daw"
                    }
                }
                status.textContent = `Project '${meta.name}'`
                showBpm()
                notesView.textContent = NotesPrompt
                for (const button of [tempoUp, addDemoClip, readNotesButton]) {button.disabled = false}
                tempoUp.onclick = () => asTeam(() =>
                    project.timelineBox.bpm.setValue(project.timelineBox.bpm.getValue() + TempoStep))
                addDemoClip.onclick = () => asTeam(() => {
                    const {trackBox} = project.api.createInstrument(InstrumentFactories.Vaporisateur)
                    const region = project.api.createNoteRegion({trackBox, position: 0, duration: PPQN.Bar, name: "Demo"})
                    DemoPitches.forEach((pitch, index) => project.api.createNoteEvent(
                        {owner: region, position: index * PPQN.Quarter, duration: PPQN.Quarter, pitch, velocity: 0.8}))
                })
                readNotesButton.onclick = () =>
                    notesView.textContent = `Read at ${new Date().toLocaleTimeString()}\n${readNotes(project)}`
                projectRuntime.own(project.boxGraph.subscribeToAllUpdates({
                    onUpdate: (update: Update) => {
                        append(source, describe(project, update))
                        showBpm()
                    }
                }))
            }
        })
    }))

    return (
        <div data-testid="team-panel"
             style={{flex: "1 0 0", display: "flex", flexDirection: "column", rowGap: "0.5em", padding: "1em",
                 minWidth: "0", minHeight: "0", overflow: "hidden"}}>
            <h3 style={{margin: "0"}}>Team view</h3>
            {status}
            <p style={{margin: "0"}}>Tempo: {bpm} BPM {tempoUp}</p>
            <p style={{margin: "0"}}>{addDemoClip} {readNotesButton}</p>
            {notesView}
            <p style={{margin: "0"}}>Project changes (newest first):</p>
            {log}
        </div>
    )
}

// Pulls every note in every MIDI region (timeline) and clip (clip launcher) at the moment it is called, through the
// adapters openDAW's own UI reads from. Note positions are relative to the region or clip start.
const readNotes = (project: Project): string => {
    const {boxGraph, boxAdapters} = project
    const owners = boxGraph.boxes().flatMap((box): Array<NoteOwner> =>
        box instanceof NoteRegionBox ? [{kind: "region", adapter: boxAdapters.adapterFor(box, NoteRegionBoxAdapter)}]
            : box instanceof NoteClipBox ? [{kind: "clip", adapter: boxAdapters.adapterFor(box, NoteClipBoxAdapter)}]
                : [])
    if (owners.length === 0) {return "No MIDI regions or clips in this project."}
    return owners.map(owner => {
        const {adapter} = owner
        const instrument = adapter.trackBoxAdapter.mapOr(track =>
            boxAdapters.adapterFor(track.audioUnit, AudioUnitBoxAdapter).input.label.unwrapOrElse("?"), "?")
        const where = owner.kind === "region" ? ` at ${PPQN.toString(owner.adapter.position)}` : ""
        const notes = adapter.optCollection.mapOr(collection => collection.events.asArray(), [])
        const lines = notes.map(note => `  ${pitchName(note.pitch).padEnd(3)} (${note.pitch})`
            + `  at ${PPQN.toString(note.position)}  length ${note.duration}  velocity ${note.velocity.toFixed(2)}`)
        return [`${instrument}: ${owner.kind} '${adapter.label}'${where}, ${notes.length} notes`, ...lines].join("\n")
    }).join("\n")
}

const pitchName = (pitch: number): string => `${NoteNames[pitch % 12]}${Math.floor(pitch / 12) - 1}`

const fieldLabel = (project: Project, update: PrimitiveUpdate | PointerUpdate): string =>
    project.boxGraph.findVertex(update.address).match({
        none: () => update.address.toString(),
        some: vertex => vertex.isField() ? vertex.debugPath : vertex.box.name
    })

const describe = (project: Project, update: Update): string => {
    if (update instanceof PrimitiveUpdate) {
        return `${fieldLabel(project, update)}: ${update.oldValue} -> ${update.newValue}`
    } else if (update instanceof PointerUpdate) {
        return `${fieldLabel(project, update)}: pointer changed`
    } else if (update instanceof NewUpdate) {
        return `+ ${update.name}`
    } else if (update instanceof DeleteUpdate) {
        return `- ${update.name}`
    }
    return String(update)
}
