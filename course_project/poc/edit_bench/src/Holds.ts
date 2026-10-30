import {Notifier, Observer, Subscription, Terminable, Terminator} from "@opendaw/lib-std"
import {PrimitiveUpdate} from "@opendaw/lib-box"
import {AutomatableParameterFieldAdapter} from "@opendaw/studio-adapters"
import type {Project} from "@opendaw/studio-core"

// Check 5: the "held" signal. opendaw.patch makes openDAW's knob and fader drags dispatch a bubbling
// "parameter-hold" DOM event on pointer-down (held: true, before any movement) and when the drag ends
// (held: false). This tracks which parameters are held, and records, for each hold, whether the parameter's address
// matches the addresses of the updates that arrive while it is held (the address agents will use).

export type HoldRecord = {
    address: string
    label: string
    beganAt: number
    endedAt: number | null
    updates: number
    matchingUpdates: number
}

type HoldDetail = { parameter: unknown, held: boolean }

const isHoldDetail = (detail: unknown): detail is HoldDetail =>
    typeof detail === "object" && detail !== null && Object.hasOwn(detail, "parameter") && Object.hasOwn(detail, "held")

export class Holds implements Terminable {
    readonly #terminator = new Terminator()
    readonly #held = new Map<string, HoldRecord>()
    readonly #records: Array<HoldRecord> = []
    readonly #notifier = new Notifier<Holds>()
    #last: AutomatableParameterFieldAdapter | null = null

    constructor(project: Project) {
        const listener = (event: Event): void => {
            if (!(event instanceof CustomEvent) || !isHoldDetail(event.detail)) {return}
            const {parameter, held} = event.detail
            if (!(parameter instanceof AutomatableParameterFieldAdapter)) {return}
            const address = parameter.address.toString()
            if (held) {
                const record: HoldRecord = {
                    address, label: parameter.name, beganAt: performance.now(), endedAt: null,
                    updates: 0, matchingUpdates: 0
                }
                this.#held.set(address, record)
                this.#records.push(record)
                this.#last = parameter
            } else {
                const record = this.#held.get(address)
                if (record !== undefined) {record.endedAt = performance.now()}
                this.#held.delete(address)
            }
            this.#notifier.notify(this)
        }
        document.addEventListener("parameter-hold", listener)
        this.#terminator.own({terminate: () => document.removeEventListener("parameter-hold", listener)})
        this.#terminator.own(project.boxGraph.subscribeToAllUpdates({
            onUpdate: update => {
                if (!(update instanceof PrimitiveUpdate)) {return}
                const address = update.address.toString()
                this.#held.forEach(record => {
                    record.updates++
                    if (record.address === address) {record.matchingUpdates++}
                })
            }
        }))
    }

    any(): boolean {return this.#held.size > 0}
    held(): ReadonlyArray<HoldRecord> {return [...this.#held.values()]}
    records(): ReadonlyArray<HoldRecord> {return this.#records}
    last(): AutomatableParameterFieldAdapter | null {return this.#last}
    subscribe(observer: Observer<Holds>): Subscription {return this.#notifier.subscribe(observer)}
    terminate(): void {this.#terminator.terminate()}
}
