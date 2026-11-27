import {createElement} from "@opendaw/lib-jsx"
import {channelState, stickForProbe} from "./EngineState"
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
import {SoundBench} from "./SoundBench"

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
    engineState: { channel: typeof channelState, stick(): void }  // `make state-probe`: the engine's state channel (EngineState.ts)
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
    engineState: {channel: channelState, stick: stickForProbe},
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
    // Not everything is a slider: a dial (a range between its ends), a switch (two states), a choice (a few options) or
    // a button (a press). An intent control's release, flip, pick or press is sent to its owner; a direct one also sets
    // the parameters it's bound to as the producer's own hand while it moves (one undo step a gesture).
    // A direct control's move is the producer's own edit, not a request, so it's put in the activity too (2026-11-27, the
    // producer: the swing dial's change wasn't in the activity log), once a gesture ends.
    const send = (control: Control, value: number): void => {
        connection.send({type: "control", ref: control.ref, value})
        if (control.kind === "direct") {showHand(control, value)}
    }
    const showHand = (control: Control, value: number): void => {
        const where = control.widget === "switch" ? (value >= 0.5 ? control.high : control.low)
            : `${Math.round(value * 100)}% (${control.low} to ${control.high})`
        activityList.prepend(<li data-hand={control.ref} data-agent="producer" data-decided="producer">
            <span title="your hand: set at once by code" style={{cursor: "default"}}>⚡</span>{" "}
            <span style={{color: "#8fd18f", fontWeight: "bold"}}>●</span> <span style={{opacity: "0.7"}}>You</span>
            {" · "}{control.label}: {where}
        </li>)
        while (activityList.children.length > MaxActivity) {activityList.lastElementChild?.remove()}
    }
    const direct = (control: Control, value: number, mark: boolean): void => {
        const adapter = handle.adapter
        if (control.kind !== "direct" || adapter === null) {return}
        ;(control.bind ?? []).forEach(({ref, from, to}) => adapter.setAsProducer(ref, from + (to - from) * value, mark))
    }
    // What a move does, with the activity's icons (2026-11-26, the producer: the same icons in the controls, not text):
    // ⚡ code, at once (a direct control, or a dial gliding between its two takes); 🐢 a model's turn (the Team Lead).
    const movesIcon = (control: Control): HTMLElement => (
        <span data-testid="takedo-control-moves" title={control.moves === "code"
            ? "⚡ code: a move sets it at once, no model (a dial past its versions' ends goes to the Team Lead)" : "🐢 a model: a move is a direction to the Team Lead"}
              style={{fontWeight: "normal", cursor: "default"}}>{control.moves === "code" ? " ⚡" : " 🐢"}</span>
    )
    // ✓ keeps the setting and takes the control off; ✗ undoes what it did and takes it off (2026-11-26, the producer).
    // On a panel, once for all of it.
    const doneButtons = (control: Control): HTMLElement => {
        const button = (text: string, keep: boolean, title: string): HTMLButtonElement => {
            const element: HTMLButtonElement = <button data-done={keep ? "keep" : "undo"} data-testid={`takedo-control-${keep ? "keep" : "undo"}`}
                title={title} style={{fontSize: "11px", lineHeight: "1", padding: "0.15em 0.35em", cursor: "pointer", borderRadius: "4px",
                    border: "1px solid #555", color: keep ? "#8fd18f" : "#e08a8a", background: "rgba(40, 44, 50, 0.95)"}}>{text}</button>
            element.onclick = event => {
                event.stopPropagation()
                connection.send({type: "control_done", ref: control.ref, keep})
            }
            return element
        }
        return <span style={{display: "inline-flex", columnGap: "0.25em", marginLeft: "auto"}}>
            {button("✓", true, "Keep it as it is, and take the control off")}{button("✗", false, "Undo what it did, and take the control off")}
        </span>
    }
    // A control on a part that's out is dimmed, with why (Control.idle): it still moves, but nothing is heard.
    const shell = (control: Control, body: HTMLElement, ends: boolean): HTMLElement => (
        <div data-testid="takedo-control" data-ref={control.ref} data-widget={control.widget} data-kind={control.kind}
             data-idle={control.idle ?? ""} title={control.idle !== undefined ? `${control.idle}: not heard now. ${control.meaning}` : control.meaning}
             style={{opacity: control.idle !== undefined ? "0.45" : "1", display: "flex", flexDirection: "column"}}>
            <div data-role="head" style={{display: "flex", alignItems: "center", columnGap: "0.2em", fontWeight: "bold"}}>
                <span data-role="label">{control.label}</span>{movesIcon(control)}{control.idle !== undefined ? <span style={{fontWeight: "normal",
                fontStyle: "italic"}}> · {control.idle}</span> : null}{control.group === undefined ? doneButtons(control) : null}</div>
            {body}
            {ends ? <div style={{display: "flex", justifyContent: "space-between", columnGap: "0.4em", opacity: "0.6", fontSize: "10px"}}>
                <span>{control.low}</span><span>{control.high}</span>
            </div> : null}
        </div>
    )
    const chip = (text: string, on: boolean, press: () => void, testid: string): HTMLButtonElement => {
        const button: HTMLButtonElement = (
            <button data-testid={testid} data-on={String(on)} style={{fontSize: "11px", padding: "0.15em 0.6em", cursor: "pointer",
                borderRadius: "4px", border: "1px solid #555", color: "inherit",
                background: on ? "rgba(70, 120, 140, 0.9)" : "rgba(40, 44, 50, 0.95)"}}>{text}</button>
        )
        button.onclick = press
        return button
    }
    // The browser's range is a few pixels tall to grab (2026-11-26, the producer: the sliders are hard to use, a small
    // click height): a 24 px tall hit area with a thick track and a big thumb, styled once for the page.
    if (document.getElementById("takedo-dial-style") === null) {
        const style = document.createElement("style")
        style.id = "takedo-dial-style"
        const track = "height: 6px; border-radius: 3px; background: rgba(120, 130, 140, 0.45);"
        const thumb = "width: 18px; height: 18px; border-radius: 50%; background: rgb(110, 170, 190); border: 2px solid rgb(30, 34, 40); cursor: grab;"
        style.textContent = `input.takedo-dial { -webkit-appearance: none; appearance: none; width: 100%; height: 24px; margin: 0.1em 0; background: transparent; cursor: pointer; touch-action: none; }
input.takedo-dial::-webkit-slider-runnable-track { ${track} }
input.takedo-dial::-moz-range-track { ${track} }
input.takedo-dial::-webkit-slider-thumb { -webkit-appearance: none; ${thumb} margin-top: -6px; }
input.takedo-dial::-moz-range-thumb { ${thumb} }
input.takedo-dial:active::-webkit-slider-thumb { cursor: grabbing; background: rgb(150, 205, 225); }`
        document.head.append(style)
    }
    // A slider where the dial crossfades the song between two versions (the Team Lead's: the song before a style and the
    // style); a knob everywhere else, for an amount (2026-11-26, the producer: dials preferred over sliders, sliders where
    // they're the best fit).
    const slider = (control: Control): HTMLElement => {
        const input: HTMLInputElement = (
            <input type="range" min="0" max="100" step="1" value={String(Math.round(control.value * 100))} className="takedo-dial"
                   data-testid="takedo-control-input" aria-label={`${control.label}, from ${control.low} to ${control.high}`}/>
        )
        if (control.kind === "direct") {
            input.onpointerdown = () => handle.adapter?.gestureMark()
            input.oninput = () => direct(control, Number(input.value) / 100, false)
        }
        input.onchange = () => {
            if (control.kind === "direct") {handle.adapter?.gestureMark()}
            send(control, Number(input.value) / 100)
        }
        return shell(control, input, true)
    }
    const SvgNs = "http://www.w3.org/2000/svg"
    const svg = (tag: string, attributes: Record<string, string>): SVGElement => {
        const element = document.createElementNS(SvgNs, tag)
        Object.entries(attributes).forEach(([name, value]) => element.setAttribute(name, value))
        return element
    }
    // A knob: drag up or down (or the arrow keys); 270 degrees from its low end to its high. A range input under it,
    // hidden, carries the value (for keyboards, screen readers and the scenarios), so a knob moves as a slider does.
    const Size = 44, Sweep = 270
    const knob = (control: Control): HTMLElement => {
        const input: HTMLInputElement = (
            <input type="range" min="0" max="100" step="1" value={String(Math.round(control.value * 100))}
                   data-testid="takedo-control-input" aria-label={`${control.label}, from ${control.low} to ${control.high}`}
                   style={{position: "absolute", opacity: "0", width: "1px", height: "1px", pointerEvents: "none"}}/>
        )
        const r = Size / 2 - 5, c = Size / 2
        const point = (f: number) => {
            const angle = (-Sweep / 2 + Sweep * f - 90) * Math.PI / 180
            return [c + r * Math.cos(angle), c + r * Math.sin(angle)]
        }
        const arc = (f: number) => {
            const [x0, y0] = point(0), [x1, y1] = point(Math.max(0.0001, f))
            return `M ${x0} ${y0} A ${r} ${r} 0 ${Sweep * f > 180 ? 1 : 0} 1 ${x1} ${y1}`
        }
        const face = svg("svg", {width: String(Size), height: String(Size), viewBox: `0 0 ${Size} ${Size}`})
        const track = svg("path", {d: arc(1), fill: "none", stroke: "rgba(120, 130, 140, 0.45)", "stroke-width": "4", "stroke-linecap": "round"})
        const level = svg("path", {fill: "none", stroke: "rgb(110, 170, 190)", "stroke-width": "4", "stroke-linecap": "round"})
        const cap = svg("circle", {cx: String(c), cy: String(c), r: String(r - 6), fill: "rgb(40, 44, 50)", stroke: "#555"})
        const needle = svg("line", {stroke: "rgb(150, 205, 225)", "stroke-width": "2", "stroke-linecap": "round"})
        face.append(track, level, cap, needle)
        const draw = (f: number) => {
            level.setAttribute("d", arc(f))
            const [x, y] = point(f), inner = (r - 6) / r
            needle.setAttribute("x1", String(c)); needle.setAttribute("y1", String(c))
            needle.setAttribute("x2", String(c + (x - c) * inner)); needle.setAttribute("y2", String(c + (y - c) * inner))
        }
        let value = control.value
        draw(value)
        const set = (next: number, live: boolean) => {
            value = Math.max(0, Math.min(1, next))
            input.value = String(Math.round(value * 100))
            draw(value)
            if (live) {direct(control, value, false)}
        }
        const holder: HTMLElement = <div tabIndex={0} data-testid="takedo-control-knob" style={{position: "relative", width: `${Size}px`,
            height: `${Size}px`, cursor: "ns-resize", touchAction: "none", alignSelf: "center", outline: "none"}}>{face}{input}</div>
        let start: { y: number, value: number } | null = null
        holder.onpointerdown = event => {
            holder.setPointerCapture(event.pointerId)
            holder.dataset.dragging = "true"
            start = {y: event.clientY, value}
            if (control.kind === "direct") {handle.adapter?.gestureMark()}
        }
        holder.onpointermove = event => {
            if (start === null) {return}
            set(start.value + (start.y - event.clientY) / (event.shiftKey ? 600 : 150), control.kind === "direct")
        }
        const release = () => {
            if (start === null) {return}
            start = null
            delete holder.dataset.dragging
            if (control.kind === "direct") {handle.adapter?.gestureMark()}
            send(control, value)
        }
        holder.onpointerup = release
        holder.onpointercancel = release
        holder.onkeydown = event => {
            const step = event.key === "ArrowUp" || event.key === "ArrowRight" ? 0.05 : event.key === "ArrowDown" || event.key === "ArrowLeft" ? -0.05 : 0
            if (step === 0) {return}
            event.preventDefault()
            set(value + step, control.kind === "direct")
            if (control.kind === "direct") {handle.adapter?.gestureMark()}
            send(control, value)
        }
        // The hidden input moved by a keyboard or a scenario: the knob follows.
        input.oninput = () => set(Number(input.value) / 100, control.kind === "direct")
        input.onchange = () => {
            set(Number(input.value) / 100, false)
            if (control.kind === "direct") {handle.adapter?.gestureMark()}
            send(control, value)
        }
        // The ends under the knob, not across the card.
        const element = shell(control, holder, true)
        element.style.minWidth = "4.5em"
        if (control.group === undefined) {
            const body: HTMLElement = <div style={{display: "flex", flexDirection: "column", width: "9em"}}/>
            const ends = element.lastElementChild as HTMLElement
            body.append(holder, ends)
            element.append(body)
        }
        return element
    }
    const dial = (control: Control): HTMLElement =>
        control.kind === "intent" && control.owner === "agent:team_lead" && control.group === undefined ? slider(control) : knob(control)
    // A switch is one toggle (2026-11-26, the producer: toggles): it shows its state's name and flips on a click.
    const toggle = (control: Control): HTMLElement => {
        let on = control.value >= 0.5
        const lit = (button: HTMLButtonElement) => {
            button.dataset.on = String(on)
            button.textContent = `${on ? "●" : "○"} ${on ? control.high || "on" : control.low || "off"}`
            button.style.background = on ? "rgba(70, 120, 140, 0.9)" : "rgba(40, 44, 50, 0.95)"
        }
        const button = chip("", on, () => {
            on = !on
            lit(button)
            direct(control, on ? 1 : 0, true)
            send(control, on ? 1 : 0)
        }, "takedo-control-toggle")
        button.style.minWidth = "4.5em"
        button.style.padding = "0.3em 0.7em"
        lit(button)
        const body: HTMLElement = <div style={{display: "flex", alignItems: "center", columnGap: "0.5em", margin: "0.2em 0"}}>{button}</div>
        return shell(control, body, false)
    }
    const choice = (control: Control): HTMLElement => {
        const row: HTMLElement = <div style={{display: "flex", flexWrap: "wrap", gap: "0.3em", margin: "0.2em 0"}}/>
        const options = control.options ?? []
        options.forEach((option, index) => row.append(chip(option, Math.round(control.value) === index, () => {
            send(control, index)
            row.querySelectorAll("button").forEach((button, other) => {
                button.dataset.on = String(other === index)
                button.style.background = other === index ? "rgba(70, 120, 140, 0.9)" : "rgba(40, 44, 50, 0.95)"
            })
        }, "takedo-control-option")))
        return shell(control, row, false)
    }
    const press = (control: Control): HTMLElement => {
        const button = chip(control.label, false, () => {
            send(control, 1)
            button.style.background = "rgba(70, 120, 140, 0.9)"
            setTimeout(() => button.style.background = "rgba(40, 44, 50, 0.95)", 300)
        }, "takedo-control-press")
        const element = shell(control, <div style={{margin: "0.2em 0"}}>{button}</div>, false)
        element.querySelector("[data-role=label]")?.remove()
        return element
    }
    const widgets: Record<Control["widget"], (control: Control) => HTMLElement> = {dial, switch: toggle, choice, button: press}
    const showControls = (agent: string, controls: ReadonlyArray<Control>): void => {
        const box = controlsBox(agent)
        // A dial being dragged stays as it is; it reports when it's let go.
        if (box.querySelector("input:active, [data-dragging=true]") !== null) {return}
        // A panel (controls sharing a group): one framed box under its title, in the place of its first control.
        const drawn: HTMLElement[] = []
        const panels = new Map<string, HTMLElement>()
        for (const control of controls) {
            const element = (widgets[control.widget] ?? dial)(control)
            if (control.group === undefined) {drawn.push(element); continue}
            const panel: HTMLElement = panels.get(control.group) ?? <div data-testid="takedo-control-panel" data-group={control.group} style={{border: "1px solid #444",
                    borderRadius: "6px", padding: "0.35em 0.5em", display: "flex", flexWrap: "wrap", gap: "0.4em 0.6em", alignItems: "flex-start"}}>
                    <div style={{flexBasis: "100%", display: "flex", alignItems: "center", fontWeight: "bold"}}>
                        <span style={{opacity: "0.85"}}>{control.group}</span>{doneButtons(control)}</div>
                </div> as HTMLElement
            if (!panels.has(control.group)) {
                panels.set(control.group, panel)
                drawn.push(panel)
            }
            panel.append(element)
        }
        box.replaceChildren(...(controls.length === 0 ? [<div style={{opacity: "0.5"}}>No controls yet</div>] : drawn))
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
                <div data-testid="takedo-card-doing" title={card.doing || "idle"} style={{fontSize: "11px", marginTop: "0.3em",
                    whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis"}}>{card.doing || "idle"}</div>
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
    // Every edit of a session, not the last few (2026-11-26: a session's 56 edits, the first ones gone from the list).
    const MaxActivity = 500
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
    // Who decided each edit (protocol.ts, Decided): 🐢 a model's turn, 🐇 Jev (a judgment in about 100 ms, code filling
    // it in), ⚡ code alone (a rule). Every edit is carried out by code; the icon is what chose it.
    const decidedBy = ({request}: Activity): [string, string] => {
        const decided = request.decided ?? {by: "model"}
        switch (decided.by) {
            case "jev": return ["🐇", `Jev decided this${decided.ms !== undefined ? ` (${decided.ms} ms)` : ""}, code did it`]
            case "code": return ["⚡", "code decided this, no model"]
            default: return ["🐢", "a model (an agent's turn) decided this"]
        }
    }
    const showActivity = (activity: Activity): void => {
        const agent = shown(activity.request.from)
        if (cards.querySelector(`[data-agent="${agent}"]`) === null) {
            showCard({agent: activity.request.from, name: speaker(agent), doing: ""})
        }
        const [text, color] = stateText(activity)
        const row: HTMLElement = (
            <li data-request={activity.request.id} data-state={activity.status.state} data-agent={agent}
                data-decided={activity.request.decided?.by ?? "model"}>
                <span title={decidedBy(activity)[1]} style={{cursor: "default"}}>{decidedBy(activity)[0]}</span>{" "}
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
    // Two tabs: the team view, and the Sounds tab where the producer filters, tunes and tags instruments (SoundBench).
    const bench = SoundBench({lifecycle, connection, adapter: () => handle.adapter})
    const tab = (name: string): HTMLButtonElement => <button data-testid={`takedo-tab-${name.toLowerCase()}`} style={{fontSize: "11px",
        padding: "0.2em 0.8em", borderRadius: "4px", border: "1px solid #555", cursor: "pointer"}}>{name}</button>
    const teamTab = tab("Team"), soundsTab = tab("Sounds")
    const teamView: HTMLElement = (
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
    const showTab = (sounds: boolean): void => {
        teamView.style.display = sounds ? "none" : "grid"
        bench.element.style.display = sounds ? "flex" : "none"
        teamTab.style.background = sounds ? "transparent" : "#2a3a40"
        soundsTab.style.background = sounds ? "#2a3a40" : "transparent"
        bench.show(sounds)
    }
    teamTab.onclick = () => showTab(false)
    soundsTab.onclick = () => showTab(true)
    showTab(false)
    return (
        <div style={{flex: "1 0 0", display: "flex", flexDirection: "column", minHeight: "0"}}>
            <div style={{display: "flex", columnGap: "0.4em", padding: "0.6em 1em 0"}}>{teamTab}{soundsTab}</div>
            {teamView}
            {bench.element}
        </div>
    )
}
