import {createElement} from "@opendaw/lib-jsx"
import {Lifecycle, Terminator} from "@opendaw/lib-std"
import {AudioUnitBoxAdapter, InstrumentFactories} from "@opendaw/studio-adapters"
import type {StudioService} from "@/service/StudioService"
import type {Adapter as AdapterType} from "./Adapter"
import {Adapter} from "./Adapter"
import {Connection, type ConnectionState} from "./Connection"
import type {ChatLine, MemberCard} from "@/takedo_shared/protocol"

// The team view's content: the connection, the chat with the team, and a card per member that has done something.
// The interaction prototype's team view (poc/interaction_prototype) replaces this layout as the pieces arrive.
// Also owns the page's Adapter, one per open project. window.takedo exposes both for tests and live sessions.

type Construct = { lifecycle: Lifecycle, service: StudioService }

type Debug = { addSynth(name: string): void }

declare global {
    interface Window {
        takedo?: { connection: Connection, adapter: AdapterType | null, service: StudioService, debug: Debug }
    }
}

// For tests and live sessions: a named Vaporisateur track, made as the producer would (not tagged as an agent).
const debugFor = (service: StudioService): Debug => ({
    addSynth: (name: string) => service.projectProfileService.getValue().ifSome(({project}) =>
        project.editing.modify(() => {
            const {audioUnitBox} = project.api.createInstrument(InstrumentFactories.Vaporisateur)
            project.boxAdapters.adapterFor(audioUnitBox, AudioUnitBoxAdapter).inputAdapter
                .ifSome(input => input.labelField.setValue(name))
        }))
})

const Labels: Record<ConnectionState["status"], string> = {
    connecting: "Connecting to the backend…",
    open: "Connected",
    closed: "Backend unreachable, retrying…"
}

const speaker = (actor: string): string =>
    actor === "user" ? "You" : actor.replace(/^agent:/, "").replace(/_/g, " ")

export const TakeDoPanel = ({lifecycle, service}: Construct): HTMLElement => {
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
                display: "flex", flexDirection: "column", rowGap: "0.4em"}}/>
    )
    const input: HTMLInputElement = (
        <input data-testid="takedo-input" type="text" placeholder="Message the team (@mix_engineer …)"
               style={{width: "100%", boxSizing: "border-box", padding: "0.5em", background: "#101214",
                   color: "inherit", border: "1px solid #444", borderRadius: "4px"}}/>
    )

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
            <li data-from={line.from} style={{alignSelf: fromUser ? "flex-end" : "flex-start", maxWidth: "85%",
                padding: "0.4em 0.6em", borderRadius: "6px", background: fromUser ? "#24414a" : "#2a2f35"}}>
                <div style={{fontSize: "10px", opacity: "0.7"}}>{speaker(line.from)}</div>
                <div>{line.text}</div>
            </li>
        )
        chat.scrollTop = chat.scrollHeight
    }
    const showCard = (card: MemberCard): void => {
        const id = card.agent.replace(/[^a-z_]/g, "")
        const element: HTMLElement = (
            <div data-testid={`takedo-card-${id}`} data-agent={card.agent}
                 style={{flex: "1 1 45%", padding: "0.5em", border: "1px solid #444", borderRadius: "6px"}}>
                <div style={{fontWeight: "bold"}}>{card.name}</div>
                <div data-testid="takedo-card-doing" style={{fontSize: "11px"}}>{card.doing}</div>
            </div>
        )
        const existing = cards.querySelector(`[data-agent="${card.agent}"]`)
        if (existing === null) {cards.append(element)} else {existing.replaceWith(element)}
    }
    input.onkeydown = (event: KeyboardEvent) => {
        if (event.key !== "Enter" || input.value.trim() === "") {return}
        connection.send({type: "chat", text: input.value.trim()})
        input.value = ""
    }

    lifecycle.own(connection.subscribe(show))
    show(connection.state)
    lifecycle.own(connection.subscribeMessages(message => {
        if (message.type === "chat") {addLine(message.line)}
        if (message.type === "card") {showCard(message.card)}
    }))

    // The adapter follows the open project, and the backend hears when one opens or closes (also after reconnecting).
    const projectRuntime = lifecycle.own(new Terminator())
    const announce = (): void => {
        const name = service.projectProfileService.getValue().mapOr(({meta}) => meta.name, null)
        connection.send(name === null ? {type: "project", open: false} : {type: "project", open: true, name})
    }
    lifecycle.own(service.projectProfileService.catchupAndSubscribe(optProfile => {
        projectRuntime.terminate()
        handle.adapter = null
        optProfile.ifSome(({project}) => {
            handle.adapter = projectRuntime.own(new Adapter(project, connection))
        })
        announce()
    }))
    let wasOpen = connection.state.status === "open"
    lifecycle.own(connection.subscribe(state => {
        const open = state.status === "open"
        if (open && !wasOpen) {announce()}
        wasOpen = open
    }))

    return (
        <div data-testid="takedo-panel"
             style={{flex: "1 0 0", display: "flex", flexDirection: "column", rowGap: "0.6em", padding: "1em",
                 minHeight: "0", fontSize: "13px"}}>
            {status}
            {cards}
            {chat}
            {input}
        </div>
    )
}
