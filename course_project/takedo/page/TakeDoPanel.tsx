import {createElement} from "@opendaw/lib-jsx"
import {Lifecycle, ObservableValue, Terminator} from "@opendaw/lib-std"
import {PPQN} from "@opendaw/lib-dsp"
import {AudioUnitBoxAdapter, InstrumentFactories, type InstrumentFactory} from "@opendaw/studio-adapters"
import type {StudioService} from "@/service/StudioService"
import type {Adapter as AdapterType} from "./Adapter"
import {Adapter} from "./Adapter"
import {type CatalogResult, generateCatalog} from "./Catalog"
import {Connection, type ConnectionState} from "./Connection"
import type {BackendToPage, ChatLine, MemberCard, Playback, TeamMember} from "@/takedo_shared/protocol"
import {MentionInput, withMentions} from "./Mentions"

// The team view's content: the connection, the Team Lead's overview of the project, the chat with the team, and a card
// per member that has done something.
// The interaction prototype's team view (poc/interaction_prototype) replaces this layout as the pieces arrive.
// Also owns the page's Adapter, one per open project. window.takedo exposes both for tests and live sessions.

type Construct = { lifecycle: Lifecycle, service: StudioService, visible: ObservableValue<boolean> }

// A note for debug.addSynth: [start, pitch, length], start and length in sixteenths, all in the first bar.
type DebugNote = [number, number, number]
type Debug = {
    addSynth(name: string, notes?: ReadonlyArray<DebugNote>, instrument?: InstrumentKey): void
    catalog(): CatalogResult | null                 // `make catalog`: creates and deletes every device in the project
}
type InstrumentKey = keyof typeof InstrumentFactories.Named

declare global {
    interface Window {
        takedo?: { connection: Connection, adapter: AdapterType | null, service: StudioService, debug: Debug }
    }
}

// For tests and live sessions: a named track (Vaporisateur unless another instrument is named), with a one-bar region
// of notes if given, made as the producer would (not tagged as an agent).
const debugFor = (service: StudioService): Debug => ({
    addSynth: (name: string, notes: ReadonlyArray<DebugNote> = [], instrument: InstrumentKey = "Vaporisateur") =>
        service.projectProfileService.getValue().ifSome(({project}) =>
            project.editing.modify(() => {
                const {audioUnitBox, trackBox} = project.api.createInstrument(InstrumentFactories.Named[instrument] as InstrumentFactory)
                project.boxAdapters.adapterFor(audioUnitBox, AudioUnitBoxAdapter).inputAdapter
                    .ifSome(input => input.labelField.setValue(name))
                if (notes.length === 0) {return}
                const region = project.api.createNoteRegion({trackBox, position: 0, duration: PPQN.Bar, name})
                notes.forEach(([start, pitch, length]) => project.api.createNoteEvent({owner: region,
                    position: start * PPQN.SemiQuaver, duration: length * PPQN.SemiQuaver, pitch, velocity: 0.8}))
            })),
    catalog: () => service.projectProfileService.getValue().mapOr(({project}) => generateCatalog(project), null)
})

const Labels: Record<ConnectionState["status"], string> = {
    connecting: "Connecting to the backend…",
    open: "Connected",
    closed: "Backend unreachable, retrying…"
}

const PlaybackMs = 250

const playbackText = ({playing, pos, loop}: Playback): string =>
    `${playing ? "playing" : "stopped"} at ${pos}${loop.on ? `, looping ${loop.from} to ${loop.to}` : ""}`

const speaker = (actor: string): string =>
    actor === "user" ? "You" : actor.replace(/^agent:/, "").replace(/_/g, " ")

// The overview (FEATURES.md, "Project overview"): the Team Lead's lines, then a playback line the page keeps live, and
// a refresh button once the project has changed since the overview was written.
const OverviewBox = (lifecycle: Lifecycle, connection: Connection, adapter: () => AdapterType | null) => {
    const body: HTMLElement = <div data-testid="takedo-overview-body"/>
    const playback: HTMLElement = <div data-testid="takedo-overview-playback"/>
    const refresh: HTMLButtonElement = (
        <button data-testid="takedo-overview-refresh" style={{fontSize: "10px", display: "none"}}>refresh</button>
    )
    const element: HTMLElement = (
        <section data-testid="takedo-overview" data-state="none"
                 style={{padding: "0.5em 0.6em", border: "1px solid #444", borderRadius: "6px", fontSize: "13px",
                     background: "rgba(22, 25, 29, 0.95)",
                     lineHeight: "1.4", display: "none"}}>
            <div style={{display: "flex", justifyContent: "space-between", fontSize: "10px", opacity: "0.7"}}>
                <span>team lead · the project</span>{refresh}
            </div>
            {body}
            {playback}
        </section>
    )
    let revision: number | null = null
    refresh.onclick = () => connection.send({type: "overview"})
    const line = (label: string, text: string): HTMLElement => (
        <div data-testid="takedo-overview-line" data-label={label}><b>{label}:</b> {text}</div>
    )
    const show = (message: Extract<BackendToPage, { type: "overview" }>): void => {
        element.style.display = "block"
        element.dataset.state = message.state
        if (message.state === "writing") {
            refresh.style.display = "none"
            body.replaceChildren(<div style={{opacity: "0.7"}}>Reading the project…</div>)
        } else if (message.state === "failed") {
            body.replaceChildren(<div style={{opacity: "0.7"}}>{message.detail}</div>)
            refresh.style.display = "inline"
        } else {
            revision = message.overview.revision
            body.replaceChildren(...message.overview.lines.map(({label, text}) => line(label, text)))
        }
    }
    const clear = (): void => {
        element.style.display = "none"
        element.dataset.state = "none"
        revision = null
        body.replaceChildren()
    }
    const timer = setInterval(() => {
        const current = adapter()
        if (current === null || element.style.display === "none") {return}
        playback.replaceChildren(line("Playback", playbackText(current.playback())))
        if (revision !== null) {refresh.style.display = current.revision > revision ? "inline" : "none"}
    }, PlaybackMs)
    lifecycle.own({terminate: () => clearInterval(timer)})
    return {element, show, clear}
}

export const TakeDoPanel = ({lifecycle, service, visible}: Construct): HTMLElement => {
    const connection = lifecycle.own(new Connection())
    const handle = {connection, adapter: null as AdapterType | null, service, debug: debugFor(service)}
    window.takedo = handle
    lifecycle.own({terminate: () => {if (window.takedo === handle) {delete window.takedo}}})

    const status: HTMLElement = <p data-testid="takedo-status" style={{margin: "0", fontSize: "11px", opacity: "0.7"}}/>
    const session: HTMLElement = <span data-testid="takedo-session"/>
    const roundTrip: HTMLElement = <span data-testid="takedo-rtt">-</span>
    const ping: HTMLButtonElement = <button data-testid="takedo-ping" style={{fontSize: "10px"}}>ping</button>
    ping.onclick = () => connection.ping().catch(() => {/* shown by the status line */})
    const cards: HTMLElement = <div data-testid="takedo-cards" style={{display: "flex", flexWrap: "wrap", gap: "0.5em"}}/>
    const chat: HTMLElement = (
        <ol data-testid="takedo-chat"
            style={{flex: "1 0 0", overflow: "auto", margin: "0", padding: "0", listStyle: "none",
                display: "flex", flexDirection: "column", rowGap: "0.6em", paddingRight: "0.4em"}}/>
    )
    let team: ReadonlyArray<TeamMember> = []
    const composer = MentionInput({team: () => team, onSend: text => connection.send({type: "chat", text})})
    const {input} = composer

    const show = (state: ConnectionState): void => {
        const text = state.error === null ? Labels[state.status] : `${Labels[state.status]} (${state.error})`
        status.firstChild?.replaceWith(document.createTextNode(`${text} `))
        status.dataset.status = state.status
        session.textContent = state.session === null ? "" : `session ${state.session}`
        roundTrip.textContent = state.roundTripMs === null ? "-" : `${state.roundTripMs.toFixed(1)} ms`
        ping.disabled = state.status !== "open"
        input.disabled = state.status !== "open"
    }
    status.append(document.createTextNode(""), session, " · ", ping, " ", roundTrip)

    const addLine = (line: ChatLine): void => {
        const fromUser = line.from === "user"
        chat.append(
            <li data-from={line.from} style={{alignSelf: fromUser ? "flex-end" : "flex-start", maxWidth: "80%",
                padding: "0.5em 0.75em", borderRadius: "8px", fontSize: "15px", lineHeight: "1.45",
                background: fromUser ? "rgba(36, 65, 74, 0.95)" : "rgba(42, 47, 53, 0.95)"}}>
                <div style={{fontSize: "11px", opacity: "0.7", marginBottom: "2px"}}>{speaker(line.from)}</div>
                <div>{withMentions(line.text, team)}</div>
            </li>
        )
        chat.scrollTop = chat.scrollHeight
    }
    const showCard = (card: MemberCard): void => {
        const id = card.agent.replace(/[^a-z_]/g, "")
        const element: HTMLElement = (
            <div data-testid={`takedo-card-${id}`} data-agent={card.agent}
                 style={{flex: "1 1 45%", padding: "0.5em", border: "1px solid #444", borderRadius: "6px",
                     background: "rgba(22, 25, 29, 0.95)"}}>
                <div style={{fontWeight: "bold"}}>{card.name}</div>
                <div data-testid="takedo-card-doing" style={{fontSize: "11px"}}>{card.doing}</div>
            </div>
        )
        const existing = cards.querySelector(`[data-agent="${card.agent}"]`)
        if (existing === null) {cards.append(element)} else {existing.replaceWith(element)}
    }

    lifecycle.own(connection.subscribe(show))
    show(connection.state)
    const overview = OverviewBox(lifecycle, connection, () => handle.adapter)
    lifecycle.own(connection.subscribeMessages(message => {
        if (message.type === "chat") {addLine(message.line)}
        if (message.type === "card") {showCard(message.card)}
        if (message.type === "overview") {overview.show(message)}
        if (message.type === "team") {
            team = message.members
            composer.refresh()
        }
    }))

    // The adapter follows the open project, and the backend hears when one opens or closes (also after reconnecting).
    const projectRuntime = lifecycle.own(new Terminator())
    const announce = (): void => {
        const name = service.projectProfileService.getValue().mapOr(({meta}) => meta.name, null)
        connection.send(name === null ? {type: "project", open: false} : {type: "project", open: true, name})
        connection.send({type: "view", open: visible.getValue()})
    }
    lifecycle.own(visible.subscribe(owner => connection.send({type: "view", open: owner.getValue()})))
    lifecycle.own(service.projectProfileService.catchupAndSubscribe(optProfile => {
        projectRuntime.terminate()
        handle.adapter = null
        overview.clear()
        optProfile.ifSome(({project}) => {
            handle.adapter = projectRuntime.own(new Adapter(project, connection))
        })
        announce()
    }))
    let wasOpen = connection.state.status === "open"
    lifecycle.own(connection.subscribe(state => {
        const open = state.status === "open"
        if (open && !wasOpen) {
            overview.clear()
            announce()
        }
        wasOpen = open
    }))

    return (
        <div data-testid="takedo-panel"
             style={{flex: "1 0 0", display: "grid", gridTemplateColumns: "minmax(260px, 1fr) minmax(360px, 2fr)",
                 columnGap: "1em", padding: "1em", minHeight: "0", fontSize: "13px"}}>
            <div style={{display: "flex", flexDirection: "column", rowGap: "0.6em", minHeight: "0", overflow: "auto"}}>
                {status}
                {overview.element}
                {cards}
            </div>
            <div style={{display: "flex", flexDirection: "column", rowGap: "0.6em", minHeight: "0"}}>
                {chat}
                {composer.element}
            </div>
        </div>
    )
}
