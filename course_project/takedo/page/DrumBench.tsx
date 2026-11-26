import {createElement} from "@opendaw/lib-jsx"
import type {Lifecycle} from "@opendaw/lib-std"
import type {Adapter as AdapterType} from "./Adapter"
import type {Connection} from "./Connection"
import {
    DefaultDrumTuning, type DrumEntry, type DrumPiece, DrumPieces, type DrumTuning, type LibraryDrum
, type Genre, Genres, type Mood, Moods} from "@/takedo_shared/protocol"

// The Sounds tab's drums (2026-11-26, the producer: a lofi change came out as 80s gated drums). Step through the drum
// machines' samples for one piece of a kit: each plays in a beat that features it, on a kit made exactly as an agent
// would make it, with the producer's kept samples (else its own machine's) around it, or alone. Keep or reject it, tune
// it on its pad (level, pitch, length, tone), tag it, or move it to another piece. Agents build kits from kept samples,
// tuned, and never use a rejected one. Keys as the instruments': ↑/↓, K, R, space.

type Construct = { lifecycle: Lifecycle, connection: Connection, adapter: () => AdapterType | null }
type Status = "unheard" | "kept" | "rejected" | "all"

const statusOf = (drum: LibraryDrum): Exclude<Status, "all"> => drum.entry?.verdict ?? "unheard"
const label = {fontSize: "11px", opacity: "0.7"}
const row = {display: "flex", alignItems: "center", columnGap: "0.5em", flexWrap: "wrap"}
const pieceName = (piece: string): string => piece.replace("_", " ")
const toHz = (slider: number, low: number, high: number): number => Math.round(low * Math.pow(high / low, slider / 1000))
const toSlider = (hz: number, low: number, high: number): number => Math.round(1000 * Math.log(hz / low) / Math.log(high / low))

export const DrumBench = ({lifecycle, connection, adapter}: Construct) => {
    let drums: LibraryDrum[] = []
    let selected: string | null = null
    let tuning: DrumTuning = DefaultDrumTuning
    let playing = false
    const piece: HTMLSelectElement = <select>{["all", ...DrumPieces].map(name => <option value={name}>{pieceName(name)}</option>)}</select>
    piece.value = "snare"
    const machine: HTMLSelectElement = <select><option value="all">all machines</option></select>
    const status: HTMLSelectElement = <select>{(["unheard", "kept", "rejected", "all"] as Status[]).map(name => <option value={name}>{name}</option>)}</select>
    status.value = "all"
    const search: HTMLInputElement = <input type="search" placeholder="search" style={{width: "9em"}}/>
    const counts: HTMLElement = <div style={label}/>
    const list: HTMLElement = <ol data-testid="takedo-drums-list" style={{listStyle: "none", margin: "0", padding: "0", overflow: "auto",
        flex: "1 0 0", fontSize: "12px"}}/>
    const title: HTMLElement = <div data-testid="takedo-drums-title" style={{fontSize: "15px", fontWeight: "600"}}/>
    const about: HTMLElement = <div style={label}/>
    const message: HTMLElement = <div data-testid="takedo-drums-message" style={{...label, minHeight: "1.2em"}}/>
    const alone: HTMLInputElement = <input type="checkbox"/>
    const solo: HTMLInputElement = <input type="checkbox"/>
    const playButton: HTMLButtonElement = <button>▶ play</button>
    const stopButton: HTMLButtonElement = <button>■ stop</button>
    const slider = (min: number, max: number, step: number): HTMLInputElement => <input type="range" min={String(min)} max={String(max)} step={String(step)} style={{flex: "1 0 8em"}}/>
    const level = slider(-24, 6, 0.5), pitch = slider(-12, 12, 1), length = slider(0.05, 1, 0.01), lowCut = slider(0, 1000, 1), highCut = slider(0, 1000, 1)
    const levelText: HTMLElement = <span/>, pitchText: HTMLElement = <span/>, lengthText: HTMLElement = <span/>, lowText: HTMLElement = <span/>, highText: HTMLElement = <span/>
    const pieceAs: HTMLSelectElement = <select>{DrumPieces.map(name => <option value={name}>{pieceName(name)}</option>)}</select>
    const tags: HTMLInputElement = <input placeholder="dusty, punchy, soft, 90s…" style={{flex: "1 0 12em"}}/>
    const note: HTMLInputElement = <input placeholder="a note for yourself or the agents" style={{flex: "1 0 12em"}}/>
    const styleBoxes = new Map<Genre, HTMLInputElement>(Genres.map(name => [name, <input type="checkbox"/> as HTMLInputElement]))
    const moodBoxes = new Map<Mood, HTMLInputElement>(Moods.map(name => [name, <input type="checkbox"/> as HTMLInputElement]))
    const guessed: HTMLElement = <span style={{...label, fontStyle: "italic"}}/>
    const styleFilter: HTMLSelectElement = <select>{["any style", ...Genres].map(name => <option value={name}>{name}</option>)}</select>
    // What it's good for: the producer's once saved, else the guess (theirs to correct).
    const stylesOf = (item: LibraryDrum) => ({styles: item.entry?.styles ?? item.guess.styles, moods: item.entry?.moods ?? item.guess.moods})
    const keepButton: HTMLButtonElement = <button style={{background: "#24414a", color: "#cfd8dc"}}>keep (K)</button>
    const rejectButton: HTMLButtonElement = <button style={{background: "#4a2424", color: "#cfd8dc"}}>reject (R)</button>
    const forgetButton: HTMLButtonElement = <button>forget</button>

    const visible = (): LibraryDrum[] => {
        const words = search.value.toLowerCase().split(/\s+/).filter(word => word !== "")
        return drums.filter(drum => (piece.value === "all" || drum.piece === piece.value)
            && (machine.value === "all" || drum.machine === machine.value)
            && (styleFilter.value === "any style" || stylesOf(drum).styles.includes(styleFilter.value as Genre))
            && (status.value === "all" || statusOf(drum) === status.value)
            && words.every(word => `${drum.id} ${drum.entry?.tags.join(" ") ?? ""}`.toLowerCase().includes(word)))
            .sort((a, b) => ["kept", "unheard", "rejected"].indexOf(statusOf(a)) - ["kept", "unheard", "rejected"].indexOf(statusOf(b))
                || a.id.localeCompare(b.id))
    }
    const drawList = (): void => {
        const shown = visible()
        list.replaceChildren(...shown.map(drum => {
            const state = statusOf(drum)
            const item: HTMLElement = <li data-id={drum.id} style={{padding: "0.25em 0.4em", cursor: "pointer", borderRadius: "4px",
                background: drum.id === selected ? "rgba(127, 221, 221, 0.18)" : "transparent", opacity: state === "rejected" ? "0.45" : "1"}}>
                <span style={{color: state === "kept" ? "#7fd" : state === "rejected" ? "#e88" : "#cfd8dc"}}>{state === "kept" ? "✓ " : state === "rejected" ? "✗ " : "· "}</span>
                {drum.id}
                <span style={{...label, marginLeft: "0.5em"}}>{piece.value === "all" ? `${pieceName(drum.piece)} · ` : ""}{drum.duration.toFixed(2)} s{drum.entry?.tags.length ? ` · ${drum.entry.tags.join(", ")}` : ""}{stylesOf(drum).styles.length ? ` · ${stylesOf(drum).styles.join(" ")}` : ""}</span>
            </li>
            item.onclick = () => select(drum.id, true)
            return item
        }))
        list.querySelector(`[data-id="${CSS.escape(selected ?? "")}"]`)?.scrollIntoView({block: "nearest"})
        const kept = DrumPieces.filter(name => name !== "other")
            .map(name => `${pieceName(name)} ${drums.filter(drum => drum.entry?.verdict === "kept" && drum.piece === name).length}`)
        counts.textContent = `${shown.length} shown · kept: ${kept.join(", ")}`
    }
    const showTuning = (): void => {
        level.value = String(tuning.level_db)
        levelText.textContent = `${tuning.level_db} dB`
        pitch.value = String(tuning.pitch)
        pitchText.textContent = tuning.pitch === 0 ? "as recorded" : `${tuning.pitch > 0 ? "+" : ""}${tuning.pitch} st`
        length.value = String(tuning.length)
        lengthText.textContent = tuning.length >= 1 ? "all of it" : `${Math.round(tuning.length * 100)}%`
        lowCut.value = String(toSlider(tuning.tone.low_cut, 20, 1000))
        lowText.textContent = tuning.tone.low_cut <= 20 ? "off" : `${tuning.tone.low_cut} Hz`
        highCut.value = String(toSlider(tuning.tone.high_cut, 1000, 20000))
        highText.textContent = tuning.tone.high_cut >= 20000 ? "off" : `${tuning.tone.high_cut} Hz`
    }
    const readTuning = (): DrumTuning => ({
        level_db: Number(level.value), pitch: Number(pitch.value), length: Number(length.value),
        tone: {low_cut: Number(lowCut.value) <= 0 ? 20 : toHz(Number(lowCut.value), 20, 1000),
            high_cut: Number(highCut.value) >= 1000 ? 20000 : toHz(Number(highCut.value), 1000, 20000)}
    })
    const current = (): LibraryDrum | undefined => drums.find(drum => drum.id === selected)
    const describe = (drum: LibraryDrum): string => `${drum.machine} · ${pieceName(drum.piece)} · ${drum.duration.toFixed(2)} s · ${statusOf(drum)}`
    const play = (): void => {
        const drum = current()
        if (drum === undefined) {return}
        if (adapter() === null) {message.textContent = "Open a project first."; return}
        playing = true
        message.textContent = "making it…"
        connection.send({type: "drum_audition", id: drum.id, piece: pieceAs.value as DrumPiece, tuning, alone: alone.checked})
    }
    const stop = (): void => {
        playing = false
        adapter()?.endAudition()
        message.textContent = "stopped"
    }
    const select = (id: string, andPlay: boolean): void => {
        selected = id
        const drum = current()
        if (drum === undefined) {return}
        tuning = drum.entry?.tuning ?? DefaultDrumTuning
        title.textContent = drum.id
        about.textContent = describe(drum)
        pieceAs.value = drum.piece
        tags.value = drum.entry?.tags.join(", ") ?? ""
        note.value = drum.entry?.note ?? ""
        const good = stylesOf(drum)
        styleBoxes.forEach((box, name) => box.checked = good.styles.includes(name))
        moodBoxes.forEach((box, name) => box.checked = good.moods.includes(name))
        guessed.textContent = drum.entry?.styles === undefined ? "guessed: correct them, they're saved with keep or reject" : ""
        showTuning()
        drawList()
        if (andPlay) {play()}
    }
    const step = (by: number): void => {
        const shown = visible()
        if (shown.length === 0) {return}
        const index = shown.findIndex(drum => drum.id === selected)
        select(shown[Math.max(0, Math.min(shown.length - 1, index < 0 ? 0 : index + by))].id, true)
    }
    const save = (verdict: DrumEntry["verdict"] | null): void => {
        const drum = current()
        if (drum === undefined) {return}
        const shown = visible(), at = shown.findIndex(other => other.id === drum.id)
        const next = shown.filter(other => other.id !== drum.id)
        const after = next[Math.min(next.length - 1, Math.max(0, at))]
        connection.send({type: "drum_set", id: drum.id, entry: verdict === null ? null : {verdict, piece: pieceAs.value as DrumPiece, tuning,
            tags: tags.value.split(",").map(tag => tag.trim().toLowerCase()).filter(tag => tag !== ""), note: note.value.trim(), t: Date.now(),
            styles: Genres.filter(name => styleBoxes.get(name)!.checked), moods: Moods.filter(name => moodBoxes.get(name)!.checked)}})
        message.textContent = verdict === null ? "forgotten: unheard again" : verdict
        if (verdict !== null && after !== undefined && status.value === "unheard") {select(after.id, true)}
        else if (verdict !== null && after !== undefined) {step(1)}
    }
    const retune = (): void => {
        tuning = readTuning()
        showTuning()
        if (playing) {play()}
    }
    ;[level, pitch, length, lowCut, highCut].forEach(input => {
        input.onchange = retune
        input.oninput = () => {tuning = readTuning(); showTuning()}
    })
    pieceAs.onchange = alone.onchange = solo.onchange = () => {if (playing) {play()}}
    playButton.onclick = play
    stopButton.onclick = stop
    keepButton.onclick = () => save("kept")
    rejectButton.onclick = () => save("rejected")
    forgetButton.onclick = () => save(null)
    piece.onchange = machine.onchange = status.onchange = styleFilter.onchange = search.oninput = () => drawList()

    const element: HTMLElement = (
        <div data-testid="takedo-drums" tabIndex={0} style={{flex: "1 0 0", display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1.3fr)",
            columnGap: "1.5em", padding: "1em", minHeight: "0", fontSize: "13px", outline: "none"}}>
            <div style={{display: "flex", flexDirection: "column", rowGap: "0.5em", minHeight: "0"}}>
                <div style={row}><span style={label}>piece</span>{piece}{machine}{styleFilter}</div>
                <div style={row}><span style={label}>showing</span>{status}{search}</div>
                {counts}
                {list}
            </div>
            <div style={{display: "flex", flexDirection: "column", rowGap: "0.8em", minHeight: "0", overflow: "auto"}}>
                {title}
                {about}
                <div style={row}>{playButton}{stopButton}<label style={label}>{alone} alone</label><label style={label}>{solo} solo</label></div>
                {message}
                <div style={label}>Press play in openDAW to hear it. It plays in a beat on a kit made exactly as the agents would make it,
                    with your kept samples (else its machine's) around it, and this tuning on its pad.</div>
                <div style={row}><span style={{...label, width: "6em"}}>level</span>{level}{levelText}</div>
                <div style={row}><span style={{...label, width: "6em"}}>pitch</span>{pitch}{pitchText}</div>
                <div style={row}><span style={{...label, width: "6em"}}>length</span>{length}{lengthText}</div>
                <div style={row}><span style={{...label, width: "6em"}}>low cut</span>{lowCut}{lowText}</div>
                <div style={row}><span style={{...label, width: "6em"}}>high cut</span>{highCut}{highText}</div>
                <div style={row}><span style={{...label, width: "6em"}}>piece</span>{pieceAs}<span style={label}>what it plays in a kit</span></div>
                <div style={row}><span style={{...label, width: "6em"}}>good for</span>
                    {Genres.map(name => <label style={label}>{styleBoxes.get(name)!} {name}</label>)}</div>
                <div style={row}><span style={{...label, width: "6em"}}>mood</span>
                    {Moods.map(name => <label style={label}>{moodBoxes.get(name)!} {name}</label>)}</div>
                {guessed}
                <div style={row}><span style={{...label, width: "6em"}}>tags</span>{tags}</div>
                <div style={row}><span style={{...label, width: "6em"}}>note</span>{note}</div>
                <div style={row}>{keepButton}{rejectButton}{forgetButton}</div>
            </div>
        </div>
    )
    element.onkeydown = (event: KeyboardEvent) => {
        if (event.target instanceof HTMLInputElement && event.target.type !== "range" && event.target.type !== "checkbox") {return}
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {step(event.key === "ArrowDown" ? 1 : -1)}
        else if (event.key === "k" || event.key === "K") {save("kept")}
        else if (event.key === "r" || event.key === "R") {save("rejected")}
        else if (event.key === " ") {if (playing) {stop()} else {play()}}
        else {return}
        event.preventDefault()
    }
    lifecycle.own(connection.subscribeMessages(received => {
        if (received.type === "library") {
            drums = received.drums
            const machines = [...new Set(drums.map(drum => drum.machine))].sort()
            const chosen = machine.value
            machine.replaceChildren(<option value="all">all machines</option>, ...machines.map(name => <option value={name}>{name}</option>))
            machine.value = machines.includes(chosen) ? chosen : "all"
            drawList()
            const drum = current()
            if (drum === undefined) {
                const first = visible()[0]
                if (first !== undefined) {select(first.id, false)}
            } else {
                about.textContent = describe(drum)
            }
        }
        if (received.type === "audition" && received.id === selected && playing) {
            if ("error" in received) {message.textContent = `couldn't make it: ${received.error}`; return}
            const open = adapter()
            const problem = open === null ? "Open a project first." : open.audition(received.code, solo.checked)
            message.textContent = problem ?? `playing ${received.id.split("/").pop()} as the ${pieceName(pieceAs.value)}${alone.checked ? ", alone" : ""}`
        }
    }))
    return {
        element,
        focus: (): void => element.focus(),
        stop: (): void => {if (playing) {stop()}}
    }
}
