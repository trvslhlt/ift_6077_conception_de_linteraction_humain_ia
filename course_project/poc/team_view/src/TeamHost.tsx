import {createElement} from "@opendaw/lib-jsx"
import {Lifecycle, Terminator} from "@opendaw/lib-std"
import type {StudioService} from "@/service/StudioService"
import {TeamOverlay} from "./TeamOverlay"

// The only module openDAW imports (see ../opendaw.patch), mounted once by the studio's App. Keep it stable: when
// TeamOverlay or anything it imports changes, Vite swaps the overlay in place instead of reloading the page, so the
// open project and playback keep going. Editing this file itself triggers a full reload.

type Construct = { lifecycle: Lifecycle, service: StudioService }
type Mount = { element: HTMLElement, service: StudioService, runtime: Terminator }

let currentOverlay = TeamOverlay
const mounts = new Set<Mount>()

const render = (mount: Mount): void => {
    mount.runtime.terminate()
    mount.element.replaceChildren(currentOverlay({lifecycle: mount.runtime, service: mount.service}))
}

export const TeamHost = ({lifecycle, service}: Construct) => {
    const mount: Mount = {
        // Takes no space in openDAW's layout; the overlay positions itself over the window.
        element: <div style={{display: "contents"}}/>,
        service,
        runtime: lifecycle.own(new Terminator())
    }
    mounts.add(mount)
    lifecycle.own({terminate: () => mounts.delete(mount)})
    render(mount)
    return mount.element
}

if (import.meta.hot) {
    import.meta.hot.accept("./TeamOverlay", module => {
        if (module === undefined) {return}
        currentOverlay = module.TeamOverlay
        mounts.forEach(render)
        console.debug(`[team] hot-swapped overlay in ${mounts.size} host(s)`)
    })
}
