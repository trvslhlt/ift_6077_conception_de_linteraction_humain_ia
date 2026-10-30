import {createElement} from "@opendaw/lib-jsx"
import {Lifecycle} from "@opendaw/lib-std"
import {IconSymbol} from "@opendaw/studio-enums"
import {Icon} from "@/ui/components/Icon"
import type {StudioService} from "@/service/StudioService"
import {BenchPanel} from "./BenchPanel"

// Floats above the whole studio, outside openDAW's layout: a robot button that opens and closes the team view, with
// a small button on each of its corners that moves it to that corner of the window. The team view opens beside it,
// on top of the DAW. Corner and open state survive reloads (localStorage, per browser).

type Construct = { lifecycle: Lifecycle, service: StudioService }
type Vertical = "top" | "bottom"
type Horizontal = "left" | "right"
type Corner = `${Vertical}-${Horizontal}`
type State = { corner: Corner, open: boolean }

const Corners: ReadonlyArray<Corner> = ["top-left", "top-right", "bottom-left", "bottom-right"]
const Arrows: Record<Corner, string> = {"top-left": "↖", "top-right": "↗", "bottom-left": "↙", "bottom-right": "↘"}
// Distance from the window edges, clear of openDAW's header (top) and footer (bottom).
const Inset: Record<Vertical | Horizontal, number> = {top: 52, bottom: 32, left: 12, right: 12}
const WidgetSize = 64
const Gap = 8
const ZIndex = "5001" // above openDAW's chat overlay (5000)
const StorageKey = "team-view"

const load = (): State => {
    try {
        const stored = JSON.parse(localStorage.getItem(StorageKey) ?? "null")
        if (Corners.includes(stored?.corner)) {return {corner: stored.corner, open: stored.open === true}}
    } catch {/* no storage: defaults */}
    return {corner: "bottom-right", open: false}
}

const save = (state: State): void => {
    try {localStorage.setItem(StorageKey, JSON.stringify(state))} catch {/* no storage: not remembered */}
}

const sides = (corner: Corner) => corner.split("-") as [Vertical, Horizontal]

const place = (element: HTMLElement, corner: Corner, offset: number): void => {
    const [vertical, horizontal] = sides(corner)
    Object.assign(element.style, {top: "", bottom: "", left: "", right: ""})
    element.style[vertical] = `${Inset[vertical] + offset}px`
    element.style[horizontal] = `${Inset[horizontal]}px`
}

export const TeamOverlay = ({lifecycle, service}: Construct): HTMLElement => {
    const state = load()
    const robot: HTMLButtonElement = (
        <button data-testid="team-toggle" title="Team view"
                style={{
                    width: "100%", height: "100%", borderRadius: "50%", cursor: "pointer", fontSize: "30px",
                    display: "flex", alignItems: "center", justifyContent: "center", padding: "0",
                    background: "#1b1e22", color: "#cfd8dc", boxShadow: "0 4px 16px rgba(0, 0, 0, 0.5)"
                }}>
            <Icon symbol={IconSymbol.Robot} style={{width: "1em", height: "1em"}}/>
        </button>
    )
    const moveButtons = Corners.map(corner => {
        const [vertical, horizontal] = sides(corner)
        const button: HTMLButtonElement = (
            <button data-testid={`team-move-${corner}`} title={`Move to ${corner.replace("-", " ")}`}
                    style={{
                        position: "absolute", [vertical]: "-6px", [horizontal]: "-6px",
                        width: "20px", height: "20px", padding: "0", borderRadius: "50%", cursor: "pointer",
                        fontSize: "12px", lineHeight: "18px", background: "#2a2f35", color: "#cfd8dc",
                        border: "1px solid #555"
                    }}>{Arrows[corner]}</button>
        )
        button.onclick = () => {
            state.corner = corner
            update()
        }
        return button
    })
    const widget: HTMLElement = (
        <div data-testid="team-widget"
             style={{position: "fixed", zIndex: ZIndex, width: `${WidgetSize}px`, height: `${WidgetSize}px`}}>
            {robot}
            {moveButtons}
        </div>
    )
    const view: HTMLElement = (
        <div data-testid="team-view"
             style={{
                 position: "fixed", zIndex: ZIndex, flexDirection: "column",
                 width: "min(560px, calc(100vw - 24px))",
                 height: `min(60vh, calc(100vh - ${Inset.top + Inset.bottom + WidgetSize + Gap}px))`,
                 background: "rgba(22, 25, 29, 0.97)", border: "1px solid #444", borderRadius: "8px",
                 boxShadow: "0 8px 32px rgba(0, 0, 0, 0.6)", color: "#cfd8dc"
             }}>
            <BenchPanel lifecycle={lifecycle} service={service}/>
        </div>
    )
    robot.onclick = () => {
        state.open = !state.open
        update()
    }
    const update = (): void => {
        place(widget, state.corner, 0)
        place(view, state.corner, WidgetSize + Gap)
        view.style.display = state.open ? "flex" : "none"
        robot.style.border = state.open ? "2px solid #7fd" : "2px solid #555"
        moveButtons.forEach((button, index) =>
            button.style.visibility = Corners[index] === state.corner ? "hidden" : "visible")
        save(state)
    }
    update()
    return (<div style={{display: "contents"}}>{widget}{view}</div>)
}
