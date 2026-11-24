import {createElement} from "@opendaw/lib-jsx"
import {Lifecycle, ObservableValue, Option, Terminator} from "@opendaw/lib-std"
import {PPQN} from "@opendaw/lib-dsp"
import {AudioUnitBoxAdapter, InstrumentFactories, type InstrumentFactory} from "@opendaw/studio-adapters"
import {ProjectBundle} from "@opendaw/studio-core"
import type {StudioService} from "@/service/StudioService"
import type {Activity, Adapter as AdapterType} from "./Adapter"
import {Adapter} from "./Adapter"
import {type CatalogResult, generateCatalog} from "./Catalog"
import {Connection, type ConnectionState} from "./Connection"
import type {Actor, BackendToPage, ChatLine, Control, MemberCard, Playback, TeamMember} from "@/takedo_shared/protocol"
import {MentionInput, withMentions} from "./Mentions"

// The team view's content, in three columns: activity (the connection, the Team Lead's overview of the project, and
// every edit with where it is), the team (a card per member: what it's doing and the controls it offers the producer),
// and the chat with the team.
// The interaction prototype's team view (poc/interaction_prototype) replaces this layout as the pieces arrive.
// Also owns the page's Adapter, one per open project. window.takedo exposes both for tests and live sessions.

type Construct = { lifecycle: Lifecycle, service: StudioService, visible: ObservableValue<boolean> }

// A note for debug.addSynth: [start, pitch, length], start and length in sixteenths, all in the first bar.
type DebugNote = [number, number, number]
type Debug = {
    addSynth(name: string, notes?: ReadonlyArray<DebugNote>, instrument?: InstrumentKey): void
    catalog(): CatalogResult | null                 // `make catalog`: creates and deletes every device in the project
    openBundle(base64: string, name?: string): Promise<void>  // `make scenario`: opens an .odb bundle, renamed if a name is given
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
    catalog: () => service.projectProfileService.getValue().mapOr(({project}) => generateCatalog(project), null),
    // Not saved to the browser's storage: a scenario starts from the bundle every time.
    // Renamed, the project gets its own notebook on the backend (kept per project name).
    openBundle: async (base64: string, name?: string) => {
        const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0))
        const profile = await ProjectBundle.decode(service, bytes.buffer)
        if (name !== undefined) {profile.updateMetaData("name", name)}
        service.projectProfileService.setValue(Option.wrap(profile))
    }
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
    const cards: HTMLElement = <div data-testid="takedo-cards" style={{display: "flex", flexDirection: "column", rowGap: "0.5em"}}/>
    const activityList: HTMLElement = (
        <ul data-testid="takedo-activity" style={{listStyle: "none", margin: "0", padding: "0", fontSize: "11px",
            display: "flex", flexDirection: "column", rowGap: "0.3em"}}/>
    )
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

    // Agents the producer sees as another (the utility as the Team Lead): shown under that name and in its card.
    let aliases: Record<string, string> = {}
    const shown = (actor: string): string => aliases[actor] ?? actor
    const addLine = (line: ChatLine): void => {
        const fromUser = line.from === "user"
        chat.append(
            <li data-from={line.from} data-shown={shown(line.from)} style={{alignSelf: fromUser ? "flex-end" : "flex-start", maxWidth: "80%",
                padding: "0.5em 0.75em", borderRadius: "8px", fontSize: "15px", lineHeight: "1.45",
                background: fromUser ? "rgba(36, 65, 74, 0.95)" : "rgba(42, 47, 53, 0.95)"}}>
                <div style={{fontSize: "11px", opacity: "0.7", marginBottom: "2px"}}>{speaker(shown(line.from))}</div>
                <div>{withMentions(line.text, team)}</div>
            </li>
        )
        chat.scrollTop = chat.scrollHeight
    }
    // A member's controls, drawn from the data the backend sends with widgets the page owns (INTERACTION.md's A2UI
    // note): a dial is a range input between its two named ends. Letting go sends the position, a direction to the
    // member. One element per agent, kept across card refreshes so a refresh never interrupts a drag.
    const controlBoxes = new Map<string, HTMLElement>()     // shown agent → its controls
    const controlsBox = (agent: string): HTMLElement => {
        const existing = controlBoxes.get(agent)
        if (existing !== undefined) {return existing}
        const box: HTMLElement = <div data-testid="takedo-card-controls" style={{fontSize: "11px", marginTop: "0.4em",
            display: "flex", flexDirection: "column", rowGap: "0.5em"}}/>
        controlBoxes.set(agent, box)
        showControls(agent, [])
        return box
    }
    const dial = (control: Control): HTMLElement => {
        const input: HTMLInputElement = (
            <input type="range" min="0" max="100" step="1" value={String(Math.round(control.value * 100))}
                   data-testid="takedo-control-input" aria-label={`${control.label}, from ${control.low} to ${control.high}`}
                   style={{width: "100%", margin: "0.2em 0"}}/>
        )
        input.onchange = () => connection.send({type: "control", ref: control.ref, value: Number(input.value) / 100})
        return (
            <div data-testid="takedo-control" data-ref={control.ref} title={control.meaning}>
                <div style={{fontWeight: "bold"}}>{control.label}</div>
                {input}
                <div style={{display: "flex", justifyContent: "space-between", opacity: "0.6", fontSize: "10px"}}>
                    <span>{control.low}</span><span>{control.high}</span>
                </div>
            </div>
        )
    }
    const showControls = (agent: string, controls: ReadonlyArray<Control>): void => {
        const box = controlsBox(agent)
        // A dial being dragged stays as it is; it reports when it's let go.
        if (box.contains(document.activeElement) && box.querySelector("input:active") !== null) {return}
        box.replaceChildren(...(controls.length === 0
            ? [<div style={{opacity: "0.5"}}>No controls yet</div>]
            : controls.filter(control => control.widget === "dial").map(dial)))
    }
    // Each card: the member, its area, what it says it's doing, and the controls it offers the producer. One per
    // roster member from the start; an agent outside the roster gets one when it acts.
    const areas = new Map<string, string>()                 // shown agent → its area, from the roster
    const showCard = (card: MemberCard): void => {
        const agent = shown(card.agent)
        const name = agent === card.agent ? card.name : speaker(agent).replace(/^./, letter => letter.toUpperCase())
        const id = agent.replace(/[^a-z_]/g, "")
        const area = areas.get(agent)
        const element: HTMLElement = (
            <div data-testid={`takedo-card-${id}`} data-agent={agent} data-actual={card.agent}
                 style={{padding: "0.5em", border: "1px solid #444", borderRadius: "6px",
                     background: "rgba(22, 25, 29, 0.95)"}}>
                <div style={{fontWeight: "bold"}}>{name}</div>
                {area === undefined ? null : <div style={{fontSize: "11px", opacity: "0.6"}}>{area}</div>}
                <div data-testid="takedo-card-doing" style={{fontSize: "11px", marginTop: "0.3em"}}>{card.doing || "idle"}</div>
                {controlsBox(agent)}
            </div>
        )
        const existing = cards.querySelector(`[data-agent="${agent}"]`)
        if (existing === null) {cards.append(element)} else {existing.replaceWith(element)}
    }
    const showTeam = (members: ReadonlyArray<TeamMember>): void => {
        members.forEach(({role, name, area}) => {
            const agent: Actor = `agent:${role}`
            areas.set(agent, area)
            const doing = cards.querySelector(`[data-agent="${agent}"] [data-testid=takedo-card-doing]`)?.textContent ?? ""
            showCard({agent, name, doing: doing === "idle" ? "" : doing})
        })
    }
    // Every edit, newest first, with who made it and where it is (waiting for a bar, under way, done, not done), live
    // from the page's adapter, so a wait or a refusal shows instead of silence.
    const MaxActivity = 40
    const stateText = ({status}: Activity): [string, string] => {
        switch (status.state) {
            case "scheduled": return [`waits for ${status.landsAt ?? "its bar"}`, "#d8b45a"]
            case "queued": return ["waits: you're holding a control", "#d8b45a"]
            case "running": return ["under way", "#7fc8f8"]
            case "applied": return ["done", "#7fbf7f"]
            case "dropped": return status.reason === "cancelled" ? ["cancelled", "#999999"] : ["not done: you're holding it", "#e08080"]
            case "failed": return [`not done: ${status.detail ?? status.reason ?? "failed"}`, "#e08080"]
        }
    }
    const showActivity = (activity: Activity): void => {
        const agent = shown(activity.request.from)
        if (cards.querySelector(`[data-agent="${agent}"]`) === null) {
            showCard({agent: activity.request.from, name: speaker(agent), doing: ""})
        }
        const [text, color] = stateText(activity)
        const row: HTMLElement = (
            <li data-request={activity.request.id} data-state={activity.status.state} data-agent={agent}>
                <span style={{color, fontWeight: "bold"}}>●</span> <span style={{opacity: "0.7"}}>{speaker(agent)}</span>
                {" · "}{activity.label}: <span style={{color}}>{text}</span>
            </li>
        )
        const existing = activityList.querySelector(`[data-request="${activity.request.id}"]`)
        if (existing === null) {activityList.prepend(row)} else {existing.replaceWith(row)}
        while (activityList.children.length > MaxActivity) {activityList.lastElementChild?.remove()}
    }

    lifecycle.own(connection.subscribe(show))
    show(connection.state)
    const overview = OverviewBox(lifecycle, connection, () => handle.adapter)
    lifecycle.own(connection.subscribeMessages(message => {
        if (message.type === "chat") {addLine(message.line)}
        if (message.type === "card") {showCard(message.card)}
        if (message.type === "controls") {
            const owners = new Set([...controlBoxes.keys(), ...message.controls.map(control => shown(control.owner))])
            owners.forEach(agent => {
                const own = message.controls.filter(control => shown(control.owner) === agent)
                if (own.length > 0 && cards.querySelector(`[data-agent="${agent}"]`) === null) {
                    showCard({agent: own[0].owner, name: speaker(agent), doing: ""})
                }
                showControls(agent, own)
            })
        }
        if (message.type === "overview") {overview.show(message)}
        if (message.type === "team") {
            team = message.members
            aliases = message.aliases
            composer.refresh()
            showTeam(message.members)
        }
    }))

    // The adapter follows the open project, and the backend hears when one opens or closes (also after reconnecting).
    const projectRuntime = lifecycle.own(new Terminator())
    let opening = crypto.randomUUID()
    const announce = (): void => {
        const name = service.projectProfileService.getValue().mapOr(({meta}) => meta.name, null)
        connection.send(name === null ? {type: "project", open: false} : {type: "project", open: true, name, opening})
        // What happened while the backend was away, then the edits still coming: in that order, so one that landed
        // meanwhile isn't taken for lost.
        connection.flush()
        if (handle.adapter !== null) {connection.send({type: "waiting", requests: handle.adapter.waiting()})}
        connection.send({type: "view", open: visible.getValue()})
    }
    lifecycle.own(visible.subscribe(owner => connection.send({type: "view", open: owner.getValue()})))
    lifecycle.own(service.projectProfileService.catchupAndSubscribe(optProfile => {
        projectRuntime.terminate()
        handle.adapter = null
        overview.clear()
        opening = crypto.randomUUID()
        optProfile.ifSome(({project}) => {
            const adapter = projectRuntime.own(new Adapter(project, connection))
            projectRuntime.own(adapter.subscribeActivity(showActivity))
            handle.adapter = adapter
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

    const heading = (text: string): HTMLElement => (
        <div style={{fontSize: "10px", letterSpacing: "0.08em", textTransform: "uppercase", opacity: "0.6"}}>{text}</div>
    )
    const column = {display: "flex", flexDirection: "column", rowGap: "0.6em", minHeight: "0", minWidth: "0"}
    return (
        <div data-testid="takedo-panel"
             style={{flex: "1 0 0", display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
                 columnGap: "1em", padding: "1em", minHeight: "0", fontSize: "13px"}}>
            <div data-testid="takedo-column-activity" style={{...column, overflow: "auto"}}>
                {heading("Activity")}
                {status}
                {overview.element}
                {activityList}
            </div>
            <div data-testid="takedo-column-team" style={{...column, overflow: "auto"}}>
                {heading("Team")}
                {cards}
            </div>
            <div data-testid="takedo-column-chat" style={column}>
                {heading("Chat")}
                {chat}
                {composer.element}
            </div>
        </div>
    )
}
