import {createElement} from "@opendaw/lib-jsx"
import type {Lifecycle} from "@opendaw/lib-std"
import type {Adapter as AdapterType} from "./Adapter"
import type {Connection} from "./Connection"
import {DrumBench} from "./DrumBench"
import {
    DefaultTuning, type LibraryEntry, type LibrarySound, type SoundRole, SoundRoles, type SoundTuning
, type Genre, Genres, type Mood, Moods} from "@/takedo_shared/protocol"

// The Sounds tab (2026-11-26, the producer: the agents' sound choices were the worst so far; they filter, tune and tag
// the instruments by ear). Step through the sounds for a role: each plays its role's phrase in the project's key, on a
// track made exactly as an agent would make it with the tuning shown. Keep or reject it, tune it (level, octave,
// register, tone, a character effect), tag it. Agents never use a rejected sound and pick kept ones first, tuned.
// Keys: ↑/↓ the next sound (it plays), K keep, R reject (both move on), space stops or plays again.

type Construct = { lifecycle: Lifecycle, connection: Connection, adapter: () => AdapterType | null }
type Status = "unheard" | "kept" | "rejected" | "all"

const statusOf = (sound: LibrarySound): Exclude<Status, "all"> => sound.entry?.verdict ?? "unheard"
const label = {fontSize: "11px", opacity: "0.7"}
const row = {display: "flex", alignItems: "center", columnGap: "0.5em", flexWrap: "wrap"}
const midiName = (pitch: number): string => `${["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"][pitch % 12]}${Math.floor(pitch / 12) - 2}`
// Log scale for the cut knobs: 0..1000 on the slider.
const toHz = (slider: number, low: number, high: number): number => Math.round(low * Math.pow(high / low, slider / 1000))
const toSlider = (hz: number, low: number, high: number): number => Math.round(1000 * Math.log(hz / low) / Math.log(high / low))

export const SoundBench = ({lifecycle, connection, adapter}: Construct) => {
    let sounds: LibrarySound[] = []
    let chains: Array<{ key: string, summary: string }> = []
    let selected: string | null = null
    let tuning: SoundTuning = DefaultTuning
    let playing = false
    const role: HTMLSelectElement = <select>{["all", ...SoundRoles].map(name => <option value={name}>{name}</option>)}</select>
    role.value = "bass"
    const status: HTMLSelectElement = <select>{(["unheard", "kept", "rejected", "all"] as Status[]).map(name => <option value={name}>{name}</option>)}</select>
    status.value = "all"
    const search: HTMLInputElement = <input type="search" placeholder="search" style={{width: "10em"}}/>
    const counts: HTMLElement = <div style={label}/>
    const list: HTMLElement = <ol data-testid="takedo-sounds-list" style={{listStyle: "none", margin: "0", padding: "0", overflow: "auto",
        flex: "1 0 0", fontSize: "12px"}}/>
    const title: HTMLElement = <div style={{fontSize: "15px", fontWeight: "600"}}/>
    const family: HTMLElement = <div style={label}/>
    const message: HTMLElement = <div data-testid="takedo-sounds-message" style={{...label, minHeight: "1.2em"}}/>
    const playAs: HTMLSelectElement = <select>{SoundRoles.map(name => <option value={name}>{name}</option>)}</select>
    const solo: HTMLInputElement = <input type="checkbox"/>
    const playButton: HTMLButtonElement = <button>▶ play</button>
    const stopButton: HTMLButtonElement = <button>■ stop</button>
    const slider = (min: number, max: number, step: number): HTMLInputElement => <input type="range" min={String(min)} max={String(max)} step={String(step)} style={{flex: "1 0 8em"}}/>
    const level = slider(-30, 6, 0.5), octave = slider(-2, 2, 1), lowCut = slider(0, 1000, 1), highCut = slider(0, 1000, 1), amount = slider(0, 3, 0.1)
    const levelText: HTMLElement = <span/>, octaveText: HTMLElement = <span/>, lowText: HTMLElement = <span/>, highText: HTMLElement = <span/>, amountText: HTMLElement = <span/>
    const effect: HTMLSelectElement = <select/>
    const registerLow: HTMLInputElement = <input type="number" min="0" max="127" placeholder="any" style={{width: "4em"}}/>
    const registerHigh: HTMLInputElement = <input type="number" min="0" max="127" placeholder="any" style={{width: "4em"}}/>
    const registerText: HTMLElement = <span style={label}/>
    const roleBoxes = new Map<SoundRole, HTMLInputElement>(SoundRoles.map(name => [name, <input type="checkbox"/> as HTMLInputElement]))
    const tags: HTMLInputElement = <input placeholder="warm, dusty, lofi, round…" style={{flex: "1 0 12em"}}/>
    const note: HTMLInputElement = <input placeholder="a note for yourself or the agents" style={{flex: "1 0 12em"}}/>
    const styleBoxes = new Map<Genre, HTMLInputElement>(Genres.map(name => [name, <input type="checkbox"/> as HTMLInputElement]))
    const moodBoxes = new Map<Mood, HTMLInputElement>(Moods.map(name => [name, <input type="checkbox"/> as HTMLInputElement]))
    const guessed: HTMLElement = <span style={{...label, fontStyle: "italic"}}/>
    const styleFilter: HTMLSelectElement = <select>{["any style", ...Genres].map(name => <option value={name}>{name}</option>)}</select>
    // What it's good for: the producer's once saved, else the guess (theirs to correct).
    const stylesOf = (item: LibrarySound) => ({styles: item.entry?.styles ?? item.guess.styles, moods: item.entry?.moods ?? item.guess.moods})
    const keepButton: HTMLButtonElement = <button style={{background: "#24414a", color: "#cfd8dc"}}>keep (K)</button>
    const rejectButton: HTMLButtonElement = <button style={{background: "#4a2424", color: "#cfd8dc"}}>reject (R)</button>
    const forgetButton: HTMLButtonElement = <button>forget</button>

    const visible = (): LibrarySound[] => {
        const words = search.value.toLowerCase().split(/\s+/).filter(word => word !== "")
        return sounds.filter(sound => (role.value === "all" || sound.roles.includes(role.value as SoundRole))
            && (styleFilter.value === "any style" || stylesOf(sound).styles.includes(styleFilter.value as Genre))
            && (status.value === "all" || statusOf(sound) === status.value)
            && words.every(word => `${sound.id} ${sound.family} ${sound.entry?.tags.join(" ") ?? ""}`.toLowerCase().includes(word)))
            // Kept first, then unheard, rejected last; General MIDI's main bank before its variations.
            .sort((a, b) => ["kept", "unheard", "rejected"].indexOf(statusOf(a)) - ["kept", "unheard", "rejected"].indexOf(statusOf(b))
                || a.bank - b.bank || a.id.localeCompare(b.id))
    }
    const drawList = (): void => {
        const shown = visible()
        list.replaceChildren(...shown.map(sound => {
            const state = statusOf(sound)
            const item: HTMLElement = <li data-id={sound.id} style={{padding: "0.25em 0.4em", cursor: "pointer", borderRadius: "4px",
                background: sound.id === selected ? "rgba(127, 221, 221, 0.18)" : "transparent",
                opacity: state === "rejected" ? "0.45" : "1"}}>
                <span style={{color: state === "kept" ? "#7fd" : state === "rejected" ? "#e88" : "#cfd8dc"}}>{state === "kept" ? "✓ " : state === "rejected" ? "✗ " : "· "}</span>
                {sound.id.replace(/^GeneralUser GS\//, "")}
                <span style={{...label, marginLeft: "0.5em"}}>{sound.family}{sound.entry?.tags.length ? ` · ${sound.entry.tags.join(", ")}` : ""}{stylesOf(sound).styles.length ? ` · ${stylesOf(sound).styles.join(" ")}` : ""}</span>
            </li>
            item.onclick = () => select(sound.id, true)
            return item
        }))
        list.querySelector(`[data-id="${CSS.escape(selected ?? "")}"]`)?.scrollIntoView({block: "nearest"})
        const kept = SoundRoles.map(name => `${name} ${sounds.filter(sound => sound.entry?.verdict === "kept" && sound.roles.includes(name)).length}`)
        counts.textContent = `${shown.length} shown · kept: ${kept.join(", ")}`
    }
    const showTuning = (): void => {
        level.value = String(tuning.level_db)
        levelText.textContent = `${tuning.level_db} dB`
        octave.value = String(tuning.octave)
        octaveText.textContent = tuning.octave === 0 ? "as written" : `${tuning.octave > 0 ? "+" : ""}${tuning.octave}`
        lowCut.value = String(toSlider(tuning.tone.low_cut, 20, 1000))
        lowText.textContent = tuning.tone.low_cut <= 20 ? "off" : `${tuning.tone.low_cut} Hz`
        highCut.value = String(toSlider(tuning.tone.high_cut, 1000, 20000))
        highText.textContent = tuning.tone.high_cut >= 20000 ? "off" : `${tuning.tone.high_cut} Hz`
        effect.replaceChildren(<option value="">none</option>, ...chains.map(chain => <option value={chain.key} title={chain.summary}>{chain.key.replace("chain/", "")}</option>))
        effect.value = tuning.effect?.chain ?? ""
        amount.value = String(tuning.effect?.amount ?? 1)
        amountText.textContent = tuning.effect === null ? "" : `${tuning.effect.amount.toFixed(1)}`
        amount.disabled = tuning.effect === null
        registerLow.value = tuning.register === null ? "" : String(tuning.register[0])
        registerHigh.value = tuning.register === null ? "" : String(tuning.register[1])
        registerText.textContent = tuning.register === null ? "its role's usual range" : `${midiName(tuning.register[0])}–${midiName(tuning.register[1])} (openDAW's C3 = 60)`
    }
    const readTuning = (): SoundTuning => {
        const low = Number(registerLow.value), high = Number(registerHigh.value)
        return {
            level_db: Number(level.value), octave: Number(octave.value),
            register: registerLow.value !== "" && registerHigh.value !== "" && low < high ? [low, high] : null,
            tone: {low_cut: Number(lowCut.value) <= 0 ? 20 : toHz(Number(lowCut.value), 20, 1000),
                high_cut: Number(highCut.value) >= 1000 ? 20000 : toHz(Number(highCut.value), 1000, 20000)},
            effect: effect.value === "" ? null : {chain: effect.value, amount: Number(amount.value)}
        }
    }
    const current = (): LibrarySound | undefined => sounds.find(sound => sound.id === selected)
    const play = (): void => {
        const sound = current()
        if (sound === undefined) {return}
        if (adapter() === null) {message.textContent = "Open a project first."; return}
        playing = true
        message.textContent = "making it…"
        connection.send({type: "audition", id: sound.id, role: playAs.value as SoundRole, tuning})
    }
    const stop = (): void => {
        playing = false
        adapter()?.endAudition()
        message.textContent = "stopped"
    }
    const select = (id: string, andPlay: boolean): void => {
        selected = id
        const sound = current()
        if (sound === undefined) {return}
        tuning = sound.entry?.tuning ?? DefaultTuning
        title.textContent = sound.id
        family.textContent = `${sound.family}${sound.bank > 0 ? ` (bank ${sound.bank}, a variation)` : ""} · ${statusOf(sound)}`
        playAs.value = role.value !== "all" && sound.roles.includes(role.value as SoundRole) ? role.value : sound.roles[0] ?? "other"
        roleBoxes.forEach((box, name) => box.checked = sound.roles.includes(name))
        tags.value = sound.entry?.tags.join(", ") ?? ""
        note.value = sound.entry?.note ?? ""
        const good = stylesOf(sound)
        styleBoxes.forEach((box, name) => box.checked = good.styles.includes(name))
        moodBoxes.forEach((box, name) => box.checked = good.moods.includes(name))
        guessed.textContent = sound.entry?.styles === undefined ? "guessed: correct them, they're saved with keep or reject" : ""
        showTuning()
        drawList()
        if (andPlay) {play()}
    }
    const step = (by: number): void => {
        const shown = visible()
        if (shown.length === 0) {return}
        const index = shown.findIndex(sound => sound.id === selected)
        select(shown[Math.max(0, Math.min(shown.length - 1, index < 0 ? 0 : index + by))].id, true)
    }
    const save = (verdict: LibraryEntry["verdict"] | null): void => {
        const sound = current()
        if (sound === undefined) {return}
        const next = visible().filter(other => other.id !== sound.id)
        const after = next[Math.min(next.length - 1, Math.max(0, visible().findIndex(other => other.id === sound.id)))]
        const roles = SoundRoles.filter(name => roleBoxes.get(name)!.checked)
        connection.send({type: "library_set", id: sound.id, entry: verdict === null ? null : {verdict, roles, tuning,
            tags: tags.value.split(",").map(tag => tag.trim().toLowerCase()).filter(tag => tag !== ""), note: note.value.trim(), t: Date.now(),
            styles: Genres.filter(name => styleBoxes.get(name)!.checked), moods: Moods.filter(name => moodBoxes.get(name)!.checked)}})
        message.textContent = verdict === null ? "forgotten: unheard again" : `${verdict}`
        if (verdict !== null && after !== undefined && status.value === "unheard") {select(after.id, true)}
        else if (verdict !== null && after !== undefined) {step(1)}
    }
    // A knob let go: the tuning changes and, while it's playing, the sound is made again with it.
    const retune = (): void => {
        tuning = readTuning()
        showTuning()
        if (playing) {play()}
    }
    ;[level, octave, lowCut, highCut, amount, effect, registerLow, registerHigh].forEach(input => input.onchange = retune)
    ;[level, octave, lowCut, highCut, amount].forEach(input => input.oninput = () => {tuning = readTuning(); showTuning()})
    playAs.onchange = () => {if (playing) {play()}}
    solo.onchange = () => {if (playing) {play()}}
    playButton.onclick = play
    stopButton.onclick = stop
    keepButton.onclick = () => save("kept")
    rejectButton.onclick = () => save("rejected")
    forgetButton.onclick = () => save(null)
    role.onchange = status.onchange = styleFilter.onchange = search.oninput = () => drawList()

    const element: HTMLElement = (
        <div data-testid="takedo-sounds" tabIndex={0} style={{flex: "1 0 0", display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1.3fr)",
            columnGap: "1.5em", padding: "1em", minHeight: "0", fontSize: "13px", outline: "none"}}>
            <div style={{display: "flex", flexDirection: "column", rowGap: "0.5em", minHeight: "0"}}>
                <div style={row}><span style={label}>role</span>{role}{styleFilter}<span style={label}>showing</span>{status}{search}</div>
                {counts}
                {list}
            </div>
            <div style={{display: "flex", flexDirection: "column", rowGap: "0.8em", minHeight: "0", overflow: "auto"}}>
                {title}
                {family}
                <div style={row}>{playButton}{stopButton}<span style={label}>plays a</span>{playAs}<span style={label}>part</span>
                    <label style={label}>{solo} solo</label></div>
                {message}
                <div style={label}>Press play in openDAW to hear it. It plays on a track made exactly as the agents would make it, with this tuning.</div>
                <div style={row}><span style={{...label, width: "6em"}}>level</span>{level}{levelText}</div>
                <div style={row}><span style={{...label, width: "6em"}}>octave</span>{octave}{octaveText}</div>
                <div style={row}><span style={{...label, width: "6em"}}>low cut</span>{lowCut}{lowText}</div>
                <div style={row}><span style={{...label, width: "6em"}}>high cut</span>{highCut}{highText}</div>
                <div style={row}><span style={{...label, width: "6em"}}>character</span>{effect}{amount}{amountText}</div>
                <div style={row}><span style={{...label, width: "6em"}}>register</span>{registerLow}<span style={label}>to</span>{registerHigh}{registerText}</div>
                <div style={row}><span style={{...label, width: "6em"}}>roles</span>
                    {SoundRoles.map(name => <label style={label}>{roleBoxes.get(name)!} {name}</label>)}</div>
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
            sounds = received.sounds
            chains = received.chains
            drawList()
            if (selected === null) {
                const first = visible()[0]
                if (first !== undefined) {select(first.id, false)}
            } else {
                const sound = current()
                if (sound !== undefined) {family.textContent = `${sound.family}${sound.bank > 0 ? ` (bank ${sound.bank}, a variation)` : ""} · ${statusOf(sound)}`}
            }
        }
        if (received.type === "audition" && received.id === selected && playing) {
            if ("error" in received) {message.textContent = `couldn't make it: ${received.error}`; return}
            const open = adapter()
            const problem = open === null ? "Open a project first." : open.audition(received.code, solo.checked)
            message.textContent = problem ?? `playing ${received.id.split("/").pop()} as a ${playAs.value} part`
        }
    }))
    lifecycle.own({terminate: () => adapter()?.endAudition()})
    // Two sections: instruments (above) and the drum machines' samples (DrumBench.tsx), one shown at a time.
    const drumBench = DrumBench({lifecycle, connection, adapter})
    let section: "instruments" | "drums" = "instruments"
    const sectionButton = (name: typeof section, text: string): HTMLButtonElement =>
        <button data-testid={`takedo-sounds-${name}`} style={{fontSize: "12px"}}>{text}</button>
    const instrumentsButton = sectionButton("instruments", "instruments"), drumsButton = sectionButton("drums", "drum samples")
    const showSection = (name: typeof section): void => {
        if (name !== section) {
            if (section === "instruments" && playing) {stop()}
            if (section === "drums") {drumBench.stop()}
        }
        section = name
        element.style.display = name === "instruments" ? "grid" : "none"
        drumBench.element.style.display = name === "drums" ? "grid" : "none"
        instrumentsButton.style.fontWeight = name === "instruments" ? "700" : "400"
        drumsButton.style.fontWeight = name === "drums" ? "700" : "400"
        if (name === "instruments") {element.focus()} else {drumBench.focus()}
    }
    instrumentsButton.onclick = () => showSection("instruments")
    drumsButton.onclick = () => showSection("drums")
    const outer: HTMLElement = (
        <div style={{flex: "1 0 0", display: "flex", flexDirection: "column", minHeight: "0"}}>
            <div style={{...row, padding: "0.6em 1em 0"}}>{instrumentsButton}{drumsButton}</div>
            {element}
            {drumBench.element}
        </div>
    )
    showSection("instruments")
    return {
        element: outer,
        // The tab shown: the library fetched (fresh each time), keys going to the list; hidden: the audition stops.
        show: (shown: boolean): void => {
            if (shown) {
                connection.send({type: "library"})
                showSection(section)
            } else {
                if (playing) {stop()}
                drumBench.stop()
            }
        }
    }
}
