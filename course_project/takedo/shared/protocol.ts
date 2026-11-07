// Messages between the page (adapter, team view) and the backend (coordinator, members), over one WebSocket.
// Plain JSON, one object per frame, discriminated by `type`. The TakeDoAPI's structures (project_plan/TAKEDO_API.md)
// are added here as they're built; names and shapes follow that document.
//
// Shared by the page (Vite, mounted at src/takedo_shared) and the backend (Node, run with type stripping), so this
// directory holds erasable TypeScript only: types and plain functions, no enums, no parameter properties.

export const ProtocolVersion = 5
export const SocketPath = "/takedo"

// ---------- TakeDoAPI subset ----------

export type Actor = "user" | `agent:${string}` | "bus"
export type Via = "edit" | "gesture" | "undo" | "redo" | "recording" | "control" | "load"

// State: the snapshot (TAKEDO_API.md, "Snapshot"). "outline" leaves out notes; "full" has them. Devices have no refs
// yet (no operation targets them); they get them with the first device operation.
export type Detail = "outline" | "full"
// A parameter as agents see it: value in the parameter's own units (dB, Hz, 0..1, an index for stepped ones), display
// as the UI prints it.
export type ParamState = { ref: string, name: string, value: number, display: string, min: number, max: number,
    stepped: boolean }
// key: the device type ("Vaporisateur"). Effects have a ref (t1.fx1, master.fx1) and their parameters.
export type Device = { key: string, name: string, enabled: boolean, ref?: string, params?: ParamState[] }
export type Content =                               // what a note triggers
    | { pads: Array<{ note: number, name: string }> }       // Playfield: MIDI note → sample
    | { script: string }                            // a script device: named, not described
export type Note = [pos: string, pitch: number, sixteenths: number, velocity: number]   // pos relative to the region
export type Region = {
    ref: string, name: string, from: string, to: string, muted: boolean
    loop: number | null                             // the loop length in bars when the region repeats
    kind: "notes" | "audio", sample?: string        // sample: an audio region's file
    notes?: Note[]                                  // "full" only; once, not per repeat
}
export type Track = {
    ref: string, name: string, kind: "notes" | "audio" | "bus"
    instrument: string | null                       // the instrument device's key, kept for the fast path
    device: (Device & { content?: Content }) | null
    midiEffects: Device[], effects: Device[]
    mix: { volume: number, pan: number, mute: boolean, solo: boolean }  // volume in dB, pan -1..1
    bars: { from: number, to: number } | null       // the bars its regions cover, if any
    lanes: string[]                                 // refs of its mix parameters that have an automation lane
    regions: Region[]
}
export type Playback = { playing: boolean, pos: string, bar: number, loop: { on: boolean, from: string, to: string } }
export type Snapshot = {
    // seq: the adapter's change counter this snapshot reflects. revision: counts every update to the project, including
    // kinds not yet reported as changes (tracks, regions, notes), so "has anything changed since" can be answered.
    at: { t: number, pos: string, seq: number, revision: number }
    detail: Detail
    playing: boolean
    playback: Playback
    timeline: { bpm: number, signature: [number, number], length: string }
    tracks: Track[]
    master: { volume: number, effects: Device[] }
}

// Requests (TAKEDO_API.md, "Requests"): the coordinator plans, the adapter applies. Values are in the parameter's own
// units (dB for volume, -1..1 for pan, 0/1 for mute and other switches).
export type When = { at: "asap" } | { at: "next", unit: "beat" | "bar" } | { at: "bar", bar: number }
export type RampPlan = { op: "ramp", ref: string, to: number, beats: number }
export type SetPlan = { op: "set", ref: string, to: number }
// Appended to the chain, with settings (parameter paths, as the catalog lists them) applied in the same edit.
export type AddEffectPlan = { op: "add_effect", track: string, device: string, factory: string,
    settings: Array<{ param: string, value: number }> }
export type RemoveEffectPlan = { op: "remove_effect", ref: string }
// The open path (STRATEGY.md, "Keep the open path"): a function body run with `takedo` in scope inside one edit (one
// undo step, attributed); it may return a JSON-able value. Rolled back if it throws, undone if it touched a held control.
export type ScriptPlan = { op: "script", code: string, description: string }
export type Plan = RampPlan | SetPlan | AddEffectPlan | RemoveEffectPlan | ScriptPlan
export type Apply = { id: string, from: Actor, plan: Plan, when: When, seq: number, reason?: string }

// What a plan changes, for claims: a parameter, an effect, or a track's effect chain (adding to it).
export const target = (plan: Plan): string =>
    plan.op === "add_effect" ? `${plan.track}.effects` : plan.op === "script" ? "project.script" : plan.ref

export type FailReason = "invalid_args" | "unknown_ref" | "not_allowed" | "held" | "out_of_range"
    | "value_not_taken" | "too_late" | "too_large" | "conflict" | "stale" | "opendaw_error"
export type Status = {
    request: string, t: number, pos: string
    state: "scheduled" | "queued" | "running" | "applied" | "dropped" | "failed"   // running: a ramp under way
    landsAt?: string
    // device: one just added. value: what a script returned; updates: how many changes it made.
    result?: { ref: string, label: string, from?: number, to?: number, device?: Device, value?: string, updates?: number }
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
// Who's on the team, for the team view (mentions, autocomplete). role: the @name.
export type TeamMember = { role: string, name: string, area: string }
// The project overview (FEATURES.md, "Project overview"): labelled lines from the Team Lead's model; the page adds the
// playback line itself, live. revision: the snapshot's it was written from, so the page can offer a refresh after edits.
export type Overview = { revision: number, t: number, lines: Array<{ label: string, text: string }> }

// ---------- Messages ----------

export type PageToBackend =
    | { type: "hello", client: "page", protocol: number }
    | { type: "ping", id: number, sent: number }          // sent: the page's performance.now()
    | { type: "project", open: boolean, name?: string }   // a project opened or closed in the studio
    | { type: "view", open: boolean }                     // the team view was shown or hidden
    | { type: "overview" }                                // the producer asked for a fresh overview
    | { type: "chat", text: string }                      // the producer typed in the team view
    | { type: "result", id: number, snapshot: Snapshot | null }   // answer to a query; null: no project open
    | { type: "status", status: Status }
    | { type: "change", event: ChangeEvent }
    | { type: "looked", id: number, ok: boolean, value: string }   // a look's result (JSON, truncated) or its error

export type BackendToPage =
    | { type: "welcome", session: string, protocol: number, startedAt: string }
    | { type: "pong", id: number, sent: number }          // sent: echoed back unchanged
    | { type: "query", id: number, query: "snapshot", detail: Detail }
    | { type: "look", id: number, code: string }          // read-only JavaScript, an async function body, `takedo` in scope
    | { type: "apply", request: Apply }
    | { type: "chat", line: ChatLine }
    | { type: "card", card: MemberCard }
    // aliases: agents the producer sees as another (the utility appears as the Team Lead; FEATURES.md, "The team")
    | { type: "team", members: TeamMember[], aliases: Record<string, Actor> }
    | { type: "overview", state: "writing" } | { type: "overview", state: "done", overview: Overview }
    | { type: "overview", state: "failed", detail: string }
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
