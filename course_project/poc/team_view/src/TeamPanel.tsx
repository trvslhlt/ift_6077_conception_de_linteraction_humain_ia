import {createElement} from "@opendaw/lib-jsx"
import {Lifecycle, Terminator} from "@opendaw/lib-std"
import {DeleteUpdate, NewUpdate, PointerUpdate, PrimitiveUpdate, Update} from "@opendaw/lib-box"
import type {Project} from "@opendaw/studio-core"
import type {StudioService} from "@/service/StudioService"

// Team view POC: logs every change to the open project, tagged with who made it, and makes one change itself.
// Every edit, from any panel, goes through project.editing and shows up in boxGraph.subscribeToAllUpdates.
// Updates fire synchronously inside the transaction, so a flag set around our own modify() tells them apart.

type Construct = { lifecycle: Lifecycle, service: StudioService }
type Source = "team" | "daw"

const MaxLogEntries = 200
const TempoStep = 5

export const TeamPanel = ({lifecycle, service}: Construct): HTMLElement => {
    const status: HTMLElement = <p data-testid="team-status">No project open.</p>
    const bpm: HTMLElement = <span data-testid="team-bpm">-</span>
    const tempoUp: HTMLButtonElement = (
        <button data-testid="team-tempo-up" disabled>Tempo +{TempoStep} BPM</button>
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
                tempoUp.disabled = true
                tempoUp.onclick = null
            },
            some: ({project, meta}) => {
                const showBpm = () => bpm.textContent = project.timelineBox.bpm.getValue().toFixed(2)
                status.textContent = `Project '${meta.name}'`
                showBpm()
                tempoUp.disabled = false
                tempoUp.onclick = () => {
                    source = "team"
                    try {
                        project.editing.modify(() =>
                            project.timelineBox.bpm.setValue(project.timelineBox.bpm.getValue() + TempoStep))
                    } finally {
                        source = "daw"
                    }
                }
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
                 minWidth: "0", color: "var(--color-dark)", overflow: "hidden"}}>
            <h3 style={{margin: "0"}}>Team view</h3>
            {status}
            <p>Tempo: {bpm} BPM {tempoUp}</p>
            <p style={{margin: "0"}}>Project changes (newest first):</p>
            {log}
        </div>
    )
}

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
