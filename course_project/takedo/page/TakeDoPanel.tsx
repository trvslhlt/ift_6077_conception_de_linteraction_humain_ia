import {createElement} from "@opendaw/lib-jsx"
import {Lifecycle} from "@opendaw/lib-std"
import type {StudioService} from "@/service/StudioService"
import {Connection, type ConnectionState} from "./Connection"

// The team view's content. For now: the connection to the backend and a round-trip check. The interaction
// prototype's team view (poc/interaction_prototype) replaces this as the pieces arrive.
// window.takedo exposes the connection for tests and live sessions.

type Construct = { lifecycle: Lifecycle, service: StudioService }

declare global {
    interface Window { takedo?: { connection: Connection } }
}

const Labels: Record<ConnectionState["status"], string> = {
    connecting: "Connecting to the backend…",
    open: "Connected",
    closed: "Backend unreachable, retrying…"
}

export const TakeDoPanel = ({lifecycle}: Construct): HTMLElement => {
    const connection = lifecycle.own(new Connection())
    window.takedo = {connection}
    lifecycle.own({terminate: () => {if (window.takedo?.connection === connection) {delete window.takedo}}})

    const status: HTMLElement = <p data-testid="takedo-status" style={{margin: "0"}}/>
    const session: HTMLElement = <p data-testid="takedo-session" style={{margin: "0", fontSize: "11px", opacity: "0.7"}}/>
    const roundTrip: HTMLElement = <span data-testid="takedo-rtt">-</span>
    const ping: HTMLButtonElement = <button data-testid="takedo-ping">Ping</button>
    ping.onclick = () => connection.ping().catch(() => {/* shown by the status line */})

    const show = (state: ConnectionState): void => {
        status.textContent = state.error === null ? Labels[state.status] : `${Labels[state.status]} (${state.error})`
        status.dataset.status = state.status
        session.textContent = state.session === null ? "" : `session ${state.session}`
        roundTrip.textContent = state.roundTripMs === null ? "-" : `${state.roundTripMs.toFixed(1)} ms`
        ping.disabled = state.status !== "open"
    }
    lifecycle.own(connection.subscribe(show))
    show(connection.state)

    return (
        <div data-testid="takedo-panel"
             style={{flex: "1 0 0", display: "flex", flexDirection: "column", rowGap: "0.5em", padding: "1em",
                 minHeight: "0", fontSize: "13px"}}>
            <h3 style={{margin: "0"}}>TakeDo</h3>
            {status}
            {session}
            <p style={{margin: "0"}}>{ping} round trip: {roundTrip}</p>
        </div>
    )
}
