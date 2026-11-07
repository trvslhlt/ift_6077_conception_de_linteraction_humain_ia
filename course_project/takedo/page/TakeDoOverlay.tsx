import {createElement} from "@opendaw/lib-jsx"
import {DefaultObservableValue, Lifecycle} from "@opendaw/lib-std"
import {IconSymbol} from "@opendaw/studio-enums"
import {Icon} from "@/ui/components/Icon"
import type {StudioService} from "@/service/StudioService"
import {TakeDoPanel} from "./TakeDoPanel"

// Floats above the whole studio, outside openDAW's layout: a robot button that opens and closes TakeDo's team view, with
// a small button on each of its corners that moves it to that corner of the window. The team view fills the window
// beside it, translucent, so the DAW's activity shows through. The corner survives reloads (localStorage, per browser); the
// view starts closed.

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
const StorageKey = "takedo-view"

const load = (): State => {
    try {
        const stored = JSON.parse(localStorage.getItem(StorageKey) ?? "null")
        // Always closed on load: the studio comes first; the robot button opens the view.
        if (Corners.includes(stored?.corner)) {return {corner: stored.corner, open: false}}
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

// The view fills the window inside the insets, short of the robot's corner on its side, so the robot stays clickable.
const fill = (element: HTMLElement, corner: Corner): void => {
    const [vertical] = sides(corner)
    Object.assign(element.style, {top: `${Inset.top}px`, bottom: `${Inset.bottom}px`, left: `${Inset.left}px`,
        right: `${Inset.right}px`})
    element.style[vertical] = `${Inset[vertical] + WidgetSize + Gap}px`
}

export const TakeDoOverlay = ({lifecycle, service}: Construct): HTMLElement => {
    const state = load()
    const visible = lifecycle.own(new DefaultObservableValue<boolean>(state.open))
    const robot: HTMLButtonElement = (
        <button data-testid="takedo-toggle" title="TakeDo"
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
            <button data-testid={`takedo-move-${corner}`} title={`Move to ${corner.replace("-", " ")}`}
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
        <div data-testid="takedo-widget"
             style={{position: "fixed", zIndex: ZIndex, width: `${WidgetSize}px`, height: `${WidgetSize}px`}}>
            {robot}
            {moveButtons}
        </div>
    )
    const view: HTMLElement = (
        <div data-testid="takedo-view"
             style={{
                 position: "fixed", zIndex: ZIndex, flexDirection: "column",
                 background: "rgba(22, 25, 29, 0.82)", border: "1px solid #444", borderRadius: "8px",
                 boxShadow: "0 8px 32px rgba(0, 0, 0, 0.6)", color: "#cfd8dc"
             }}>
            <TakeDoPanel lifecycle={lifecycle} service={service} visible={visible}/>
        </div>
    )
    robot.onclick = () => {
        state.open = !state.open
        update()
    }
    const update = (): void => {
        place(widget, state.corner, 0)
        fill(view, state.corner)
        view.style.display = state.open ? "flex" : "none"
        visible.setValue(state.open)
        robot.style.border = state.open ? "2px solid #7fd" : "2px solid #555"
        moveButtons.forEach((button, index) =>
            button.style.visibility = Corners[index] === state.corner ? "hidden" : "visible")
        save(state)
    }
    update()
    return (<div style={{display: "contents"}}>{widget}{view}</div>)
}
