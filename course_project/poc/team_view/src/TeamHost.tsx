import {createElement} from "@opendaw/lib-jsx"
import {Lifecycle, Terminator} from "@opendaw/lib-std"
import type {StudioService} from "@/service/StudioService"
import {TeamPanel} from "./TeamPanel"

// The only module openDAW imports (see ../opendaw.patch). Keep it stable: when TeamPanel or anything it imports
// changes, Vite swaps the panel inside every mounted host instead of reloading the page, so the open project and
// playback keep going. Editing this file itself triggers a full reload.

type Construct = { lifecycle: Lifecycle, service: StudioService }
type Mount = { element: HTMLElement, service: StudioService, runtime: Terminator }

let currentPanel = TeamPanel
const mounts = new Set<Mount>()

const render = (mount: Mount): void => {
    mount.runtime.terminate()
    mount.element.replaceChildren(currentPanel({lifecycle: mount.runtime, service: mount.service}))
}

export const TeamHost = ({lifecycle, service}: Construct) => {
    const mount: Mount = {
        element: <div style={{flex: "1 0 0", display: "flex", minWidth: "0", minHeight: "0"}}/>,
        service,
        runtime: lifecycle.own(new Terminator())
    }
    mounts.add(mount)
    lifecycle.own({terminate: () => mounts.delete(mount)})
    render(mount)
    return mount.element
}

if (import.meta.hot) {
    import.meta.hot.accept("./TeamPanel", module => {
        if (module === undefined) {return}
        currentPanel = module.TeamPanel
        mounts.forEach(render)
        console.debug(`[team] hot-swapped panel in ${mounts.size} host(s)`)
    })
}
