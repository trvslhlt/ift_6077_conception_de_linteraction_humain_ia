// Messages between the page (adapter, team view) and the backend (coordinator, members), over one WebSocket.
// Plain JSON, one object per frame, discriminated by `type`. The TakeDoAPI's structures (project_plan/TAKEDO_API.md)
// are added here as they're built; names and shapes follow that document.
//
// Shared by the page (Vite, mounted at src/takedo_shared) and the backend (Node, run with type stripping), so this
// directory holds erasable TypeScript only: types and plain functions, no enums, no parameter properties.

export const ProtocolVersion = 2
export const SocketPath = "/takedo"

// ---------- TakeDoAPI subset ----------

export type Actor = "user" | `agent:${string}` | "bus"
export type Via = "edit" | "gesture" | "undo" | "redo" | "recording" | "control" | "load"

// State: the outline snapshot (TAKEDO_API.md, "Snapshot"), tracks and mix only for now.
export type Track = {
    ref: string, name: string, kind: "notes" | "audio" | "bus"
    instrument: string | null                       // the instrument device's name
    mix: { volume: number, mute: boolean, solo: boolean }   // volume in dB
    lanes: string[]                                 // refs of its mix parameters that have an automation lane
}
export type Snapshot = {
    at: { t: number, pos: string, seq: number }     // seq: the adapter's change counter this snapshot reflects
    playing: boolean
    timeline: { bpm: number, signature: [number, number] }
    tracks: Track[]
    master: { volume: number }
}

// Requests (TAKEDO_API.md, "Requests"): the coordinator plans, the adapter applies.
export type When = { at: "asap" } | { at: "next", unit: "beat" | "bar" }
export type RampPlan = { op: "ramp", ref: string, to: number, beats: number }   // to: display value (dB for volume)
export type Plan = RampPlan
export type Apply = { id: string, from: Actor, plan: Plan, when: When, seq: number, reason?: string }

export type FailReason = "invalid_args" | "unknown_ref" | "not_allowed" | "held" | "out_of_range"
    | "value_not_taken" | "too_late" | "too_large" | "conflict" | "stale" | "opendaw_error"
export type Status = {
    request: string, t: number, pos: string
    state: "scheduled" | "queued" | "applied" | "dropped" | "failed"
    landsAt?: string
    result?: { ref: string, label: string, from: number, to: number }
    reason?: FailReason
    detail?: string
}

// Changes (TAKEDO_API.md, "Changes"): value changes on refs, a gesture folded into one event.
export type Change = { kind: "value", ref: string, label: string, from: number, to: number }
export type ChangeEvent = { seq: number, t: number, pos: string, playing: boolean, actor: Actor, via: Via,
    request?: string, changes: Change[] }

// The team view.
export type ChatLine = { id: string, t: number, from: Actor, to?: Actor, text: string }
export type MemberCard = { agent: Actor, name: string, doing: string }

// ---------- Messages ----------

export type PageToBackend =
    | { type: "hello", client: "page", protocol: number }
    | { type: "ping", id: number, sent: number }          // sent: the page's performance.now()
    | { type: "project", open: boolean, name?: string }   // a project opened or closed in the studio
    | { type: "chat", text: string }                      // the producer typed in the team view
    | { type: "result", id: number, snapshot: Snapshot | null }   // answer to a query; null: no project open
    | { type: "status", status: Status }
    | { type: "change", event: ChangeEvent }

export type BackendToPage =
    | { type: "welcome", session: string, protocol: number, startedAt: string }
    | { type: "pong", id: number, sent: number }          // sent: echoed back unchanged
    | { type: "query", id: number, query: "snapshot" }
    | { type: "apply", request: Apply }
    | { type: "chat", line: ChatLine }
    | { type: "card", card: MemberCard }
    | { type: "error", detail: string }

export const encode = (message: PageToBackend | BackendToPage): string => JSON.stringify(message)

// Parses one frame; returns null for anything that isn't an object with a string `type`.
export const decode = <T extends { type: string }>(data: string): T | null => {
    try {
        const message = JSON.parse(data)
        return typeof message === "object" && message !== null && typeof message.type === "string" ? message : null
    } catch {
        return null
    }
}
