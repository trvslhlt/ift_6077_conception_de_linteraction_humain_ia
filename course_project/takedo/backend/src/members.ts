import type {Actor, Snapshot, When} from "../../shared/protocol.ts"
import type {Coordinator, Member} from "./coordinator.ts"
import type {Hints, Route} from "./router.ts"

// Team members. For now one, the mix engineer, whose job is one operation (a ramp on a track's volume), so it runs
// entirely on the fast path: Jev's hints are its arguments and code turns them into numbers. No language model.

const MinDb = -60, MaxDb = 6

const db = (value: number): string => value <= MinDb ? "-inf dB" : `${value > 0 ? "+" : ""}${value.toFixed(1)} dB`

// Amount (0..3 on the router's scale) to a step in dB: subtle 1.5, moderate 3, big 6, extreme 12.
const stepDb = (amount: number): number => Math.min(18, Math.max(1, 1.5 * 2 ** amount))

const timing = (hints: Hints, beatsPerBar: number): { when: When, beats: number, note: string } => {
    switch (hints.when) {
        case "gradual": return {when: {at: "next", unit: "bar"}, beats: 2 * beatsPerBar, note: "over two bars"}
        case "later": return {when: {at: "next", unit: "bar"}, beats: 1, note: "from the next bar (I can't wait for a section yet)"}
        default: return {when: {at: "next", unit: "beat"}, beats: 1, note: "on the next beat"}
    }
}

export class MixEngineer implements Member {
    readonly agent: Actor = "agent:mix_engineer"
    readonly name = "Mix engineer"

    async handle(context: Coordinator, _message: string, route: Extract<Route, { path: "fast" }>,
                 snapshot: Snapshot): Promise<void> {
        const {hints} = route
        if (hints.change !== "quieter" && hints.change !== "louder") {
            context.card({agent: this.agent, name: this.name, doing: "idle"})
            return context.say(this.agent, `I can only change levels so far, and that sounds like "${hints.change}".`)
        }
        const target = hints.part === "whole_mix" ? "master.mix.volume" : `${hints.part}.mix.volume`
        const claimed = context.claim(this.agent, [target], `${hints.change} ${hints.part}`)
        if (!claimed.ok) {
            return context.say(this.agent, `${claimed.holder.replace("agent:", "")} is working on that right now.`)
        }
        try {
            let current = snapshot
            for (let attempt = 0; attempt < 2; attempt++) {
                const track = current.tracks.find(track => track.ref === hints.part)
                const label = track?.name ?? "the mix"
                const from = track?.mix.volume ?? current.master.volume
                const sign = hints.change === "quieter" ? -1 : 1
                const to = Math.min(MaxDb, Math.max(MinDb, from + sign * stepDb(hints.amount)))
                const {when, beats, note} = timing(hints, current.timeline.signature[0])
                context.card({agent: this.agent, name: this.name, doing: `${label}: ${db(from)} → ${db(to)}, ${note}`})
                let landsAt = ""
                const status = await context.request(this.agent, {op: "ramp", ref: target, to, beats}, when,
                    current.at.seq, `${hints.change} ${label}`, update => {landsAt = update.landsAt ?? landsAt})
                if (status.state === "applied" && status.result !== undefined) {
                    const {from: was, to: now} = status.result
                    context.card({agent: this.agent, name: this.name, doing: `${label}: ${db(was)} → ${db(now)} (done)`})
                    return context.say(this.agent,
                        `${label} ${hints.change}: ${db(was)} → ${db(now)}${landsAt ? `, from ${landsAt}` : ""}.`)
                }
                if (status.state === "failed" && status.reason === "stale" && attempt === 0) {
                    const fresh = await context.snapshot()
                    if (fresh === null) {break}
                    current = fresh
                    continue
                }
                context.card({agent: this.agent, name: this.name, doing: `${label}: not changed (${status.reason ?? status.state})`})
                return context.say(this.agent, status.state === "dropped"
                    ? `You're holding the ${label} volume, so I left it.`
                    : `I couldn't change ${label}: ${status.reason}${status.detail ? ` (${status.detail})` : ""}.`)
            }
            context.say(this.agent, "The project changed under me twice; I've left it.")
        } finally {
            context.release(this.agent, [target])
        }
    }
}
