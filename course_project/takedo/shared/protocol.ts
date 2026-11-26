// Messages between the page (adapter, team view) and the backend (coordinator, members), over one WebSocket.
// Plain JSON, one object per frame, discriminated by `type`. The TakeDoAPI's structures (project_plan/TAKEDO_API.md)
// are added here as they're built; names and shapes follow that document.
//
// Shared by the page (Vite, mounted at src/takedo_shared) and the backend (Node, run with type stripping), so this
// directory holds erasable TypeScript only: types and plain functions, no enums, no parameter properties.
import type {Touched} from "./touched.ts"

export const ProtocolVersion = 6
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
    lanes: string[]                                 // refs of its parameters (mix, effects) that have an automation lane
    sends?: Array<{ bus: string, gain: number, pan: number }>   // its sends to return buses (gain in dB)
    regions: Region[]
}
// position: the playhead in pulses. played: pulses played since the page began following this project, counting each
// pass of the loop; with position, an anchor that bars of playing can be counted from (When's from).
export type Playback = { playing: boolean, pos: string, bar: number, loop: { on: boolean, from: string, to: string },
    position: number, played: number }
export type Snapshot = {
    // seq: the adapter's change counter this snapshot reflects. revision: counts every update to the project, including
    // kinds not yet reported as changes (tracks, regions, notes), so "has anything changed since" can be answered.
    at: { t: number, pos: string, seq: number, revision: number }
    detail: Detail
    playing: boolean
    playback: Playback
    // tempoLane: the tempo automation, when on, as a fingerprint (its events) and its last tempo: a script that rewrites it
    // leaves bpm as it is until the playhead gets there, and still changed the tempo (shared/touched.ts).
    timeline: { bpm: number, tempoAutomated?: boolean, tempoLane?: { sig: string, last: number }, signature: [number, number], length: string }
    tracks: Track[]
    master: { volume: number, effects: Device[] }
}

// Requests (TAKEDO_API.md, "Requests"): the coordinator plans, the adapter applies. Values are in the parameter's own
// units (dB for volume, -1..1 for pan, 0/1 for mute and other switches).
// from: the playback a plan is timed from (a task's start). In a loop, its bars then count from there, not from the
// playhead when each request arrives (a bar inside the loop: its next pass after from; past the end: bars of playing),
// so steps scheduled seconds apart keep their order and spacing.
export type When = { at: "asap" } | { at: "next", unit: "beat" | "bar" }
    | { at: "bar", bar: number, from?: { position: number, played: number } }
export type RampPlan = { op: "ramp", ref: string, to: number, beats: number }
export type SetPlan = { op: "set", ref: string, to: number }
// Appended to the chain, with settings (parameter paths, as the catalog lists them) applied in the same edit.
export type AddEffectPlan = { op: "add_effect", track: string, device: string, factory: string,
    settings: Array<{ param: string, value: number }> }
export type RemoveEffectPlan = { op: "remove_effect", ref: string }
// A track's send to a return bus (2026-11-25, style mix profiles: a style's space is shared reverb and delay): the bus,
// an aux track named bus, is made if it isn't there, with effect on it (fully wet); the send is made at silence if the
// track has none to it. Its level is then ramped like any parameter: \`${track}.send.${bus}.gain\` (and .pan).
export type SendPlan = { op: "send", track: string, bus: string,
    effect: { factory: string, settings: Array<{ param: string, value: number }> } }
// The open path (STRATEGY.md, "Keep the open path"): a function body run with `takedo` in scope inside one edit (one
// undo step, attributed); it may return a JSON-able value. Rolled back if it throws, undone if it touched a held control.
export type ScriptPlan = { op: "script", code: string, description: string }
// The producer's sound library (backend/src/library.ts, the Sounds tab): their verdict on an instrument sound, the roles
// and tags they gave it, and its tuning, which agents apply when they use it.
// drums and percussion: a whole kit as one instrument (General MIDI's drum kits), playing General MIDI drum notes.
export type SoundRole = "bass" | "keys" | "pad" | "lead" | "strings" | "guitar" | "brass" | "bells" | "drums" | "percussion" | "other"
export const SoundRoles: SoundRole[] = ["bass", "keys", "pad", "lead", "strings", "guitar", "brass", "bells", "drums", "percussion", "other"]
// level_db: the track's volume. octave: added to every note it plays. register: the MIDI range it sounds good in (null:
// any). tone: a high-pass and low-pass on the track in Hz (20 and 20000: open). effect: a knowledge chain ("chain/saturate")
// at an amount 0-3, or null.
export type SoundTuning = { level_db: number, octave: number, register: [number, number] | null,
    tone: { low_cut: number, high_cut: number }, effect: { chain: string, amount: number } | null }
// What a sound is good for: styles (the style mix profiles' genres) and moods. Guessed for every sound (guess) until the
// producer saves their own with a verdict; entries saved before these existed have none (the guess stands).
export type Genre = "lofi" | "boombap" | "jazz" | "trap" | "house" | "techno" | "dnb" | "synthwave" | "ambient" | "pop"
export const Genres: Genre[] = ["lofi", "boombap", "jazz", "trap", "house", "techno", "dnb", "synthwave", "ambient", "pop"]
export type Mood = "warm" | "mellow" | "bright" | "dark" | "dreamy" | "gritty" | "punchy" | "clean" | "vintage" | "cheesy"
export const Moods: Mood[] = ["warm", "mellow", "bright", "dark", "dreamy", "gritty", "punchy", "clean", "vintage", "cheesy"]
export type StyleGuess = { styles: Genre[], moods: Mood[] }
export type LibraryEntry = { verdict: "kept" | "rejected", roles: SoundRole[], tags: string[], tuning: SoundTuning, note: string, t: number,
    styles?: Genre[], moods?: Mood[] }
export type LibrarySound = { id: string, source: "soundfont" | "preset", family: string, bank: number, roles: SoundRole[], entry: LibraryEntry | null,
    guess: StyleGuess }
export const OpenTone = {low_cut: 20, high_cut: 20000}
export const DefaultTuning: SoundTuning = {level_db: -6, octave: 0, register: null, tone: OpenTone, effect: null}
// The producer's drum samples (the Sounds tab's drums): their verdict on one sample of TakeDo's drum machines, the piece
// it plays in a kit (a drum role, knowledge.ts DrumRoles; other: effects and oddities, played as perc), and its tuning on
// its pad: level_db the pad's volume, pitch in semitones, length the part of the sample played (1: all of it; less cuts a
// long tail), tone a high- and low-pass on the pad.
export type DrumPiece = "kick" | "snare" | "rim" | "clap" | "closed_hat" | "open_hat" | "ride" | "crash" | "tom_low" | "tom_mid"
    | "tom_high" | "shaker" | "perc" | "other"
export const DrumPieces: DrumPiece[] = ["kick", "snare", "rim", "clap", "closed_hat", "open_hat", "ride", "crash", "tom_low", "tom_mid",
    "tom_high", "shaker", "perc", "other"]
export type DrumTuning = { level_db: number, pitch: number, length: number, tone: { low_cut: number, high_cut: number } }
export const DefaultDrumTuning: DrumTuning = {level_db: 0, pitch: 0, length: 1, tone: OpenTone}
export type DrumEntry = { verdict: "kept" | "rejected", piece: DrumPiece, tags: string[], tuning: DrumTuning, note: string, t: number,
    styles?: Genre[], moods?: Mood[] }
export type LibraryDrum = { id: string, machine: string, piece: DrumPiece, duration: number, entry: DrumEntry | null, guess: StyleGuess }

export type Plan = RampPlan | SetPlan | AddEffectPlan | RemoveEffectPlan | SendPlan | ScriptPlan
// Who decided an edit (2026-11-25, the activity view's icons): a model's turn, Jev (a fast judgment, code filling it
// in), or code alone (a rule: a dial's blend, a recall). Every edit is carried out by code; this is what chose it.
export type Decided = { by: "model" | "jev" | "code", ms?: number }
export type Apply = { id: string, from: Actor, plan: Plan, when: When, seq: number, reason?: string, decided?: Decided }

// What a plan changes, for claims: a parameter, an effect, or a track's effect chain (adding to it).
export const target = (plan: Plan): string =>
    plan.op === "add_effect" ? `${plan.track}.effects` : plan.op === "send" ? `${plan.track}.send.${plan.bus}` : plan.op === "script" ? "project.script" : plan.ref

// cancelled: an agent took back a request still waiting for its bar (state dropped).
export type FailReason = "invalid_args" | "unknown_ref" | "not_allowed" | "held" | "cancelled" | "out_of_range"
    | "value_not_taken" | "too_late" | "too_large" | "conflict" | "stale" | "opendaw_error"
export type Status = {
    request: string, t: number, pos: string
    state: "scheduled" | "queued" | "running" | "applied" | "dropped" | "failed"   // running: a ramp under way
    landsAt?: string
    // device: one just added. value: what a script returned; updates: how many changes it made; corrected: values it
    // wrote outside openDAW's declared ranges, brought back in (page/Guard.ts).
    result?: { ref: string, label: string, from?: number, to?: number, device?: Device, value?: string, updates?: number,
        corrected?: string[], touched?: Touched }
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
// A member's control on its card (TAKEDO_API.md, "Controls"; INTERACTION.md's A2UI note): data only, drawn by the page
// with a widget of its own, so no agent writes UI. Not everything is a slider (2026-11-25):
// - widget: a dial (a range between low and high), a switch (one of two states, low or high: value 0 or 1), a choice
//   (one of options: value its index) or a button (pressed: a one-shot, "a fill", "drop it"; value stays 0).
// - kind, its speed: an intent control's move is a direction to its owner (who reads meaning and the position), never a
//   change to the project by itself: a dial or switch between two kept takes is played by code at once, anything else
//   waits for the owner's turn. A direct control is bound to parameters (bind) the page sets itself as the producer's
//   own hand, instantly, each from its from to its to across the control (a macro knob; a switch for a mute); no agent
//   turn, and the owner later sees it as the producer's change. Only dials and switches are direct.
export type ControlWidget = "dial" | "switch" | "choice" | "button"
export type Control = { ref: string, owner: Actor, kind: "intent" | "direct", widget: ControlWidget, label: string,
    low: string, high: string, meaning: string, value: number
    group?: string                                              // a panel's title: controls sharing it show together, one on the card's limit
    idle?: string                                               // why it can't be heard now ("TR-808 is out"): shown dimmed (page only)
    moves?: "code" | "model"                                    // page only: what a move of it does: code at once (⚡: a direct control,
                                                                //   or a dial gliding between its takes), or a model's turn (🐢)
    origin?: number                                             // where it was first offered: ✗ puts a direct control back there
    options?: string[]                                          // choice: its options, in order
    bind?: Array<{ ref: string, from: number, to: number }>     // direct: the parameters it sets (t2.mix.volume, t3.fx1.wet)
    transitions?: Record<string, "handover" | "crossfade"> }   // per track ref, how a part in one end only comes and goes (blend.ts)
// Who's on the team, for the team view (mentions, autocomplete). role: the @name.
export type TeamMember = { role: string, name: string, area: string }
// The project overview (FEATURES.md, "Project overview"): labelled lines from the Team Lead's model; the page adds the
// playback line itself, live. revision: the snapshot's it was written from, so the page can offer a refresh after edits.
export type Overview = { revision: number, t: number, lines: Array<{ label: string, text: string }> }

// ---------- Messages ----------

export type PageToBackend =
    | { type: "hello", client: "page", protocol: number }
    | { type: "ping", id: number, sent: number }          // sent: the page's performance.now()
    // A project opened or closed in the studio. opening: the page's id for this opening of it, sent again when the
    // page reconnects (a backend restart resumes the work); a new one when a project is opened anew.
    | { type: "project", open: boolean, name?: string, opening?: string }
    | { type: "view", open: boolean }                     // the team view was shown or hidden
    | { type: "overview" }                                // the producer asked for a fresh overview
    | { type: "chat", text: string }                      // the producer typed in the team view
    | { type: "control", ref: string, value: number }     // the producer let go of a control at this value
    // The producer's ✓ (keep: the setting stays, the control goes) or ✗ (undo what it did, and the control goes), on a
    // control or a whole panel (any of its refs).
    | { type: "control_done", ref: string, keep: boolean }
    | { type: "library" }                                  // the Sounds tab asks for the sound library
    | { type: "library_set", id: string, entry: LibraryEntry | null }   // the producer's verdict and tuning for a sound
    | { type: "audition", id: string, role: SoundRole, tuning: SoundTuning }   // the Sounds tab wants to hear a sound
    | { type: "drum_set", id: string, entry: DrumEntry | null }   // the producer's verdict and tuning for a drum sample
    | { type: "drum_audition", id: string, piece: DrumPiece, tuning: DrumTuning, alone: boolean }   // a drum sample in a beat
    // After (re)connecting: the requests still waiting for their bar or under way (they outlive a backend restart).
    | { type: "waiting", requests: string[] }
    | { type: "result", id: number, snapshot: Snapshot | null }   // answer to a query; null: no project open
    | { type: "status", status: Status }
    | { type: "change", event: ChangeEvent }
    | { type: "looked", id: number, ok: boolean, value: string }   // a look's result (JSON, truncated) or its error
    | { type: "engine", undone: string | null }          // the audio engine crashed and is restarting; undone: the agent edit taken back
    // The page's watchdog (2026-11-25: an engine break in a live session left no trace): the playhead stopped while
    // playing, or openDAW's crash dialog showed; detail: what the page saw (the dialog's text, CPU load).
    // page_error: an uncaught error on the page (logged only). One thrown in a frame callback that reads the engine's state
    // leaves its shared buffer mid-read for good, so the playhead stops while the audio plays on (a "stall").
    | { type: "engine_health", state: "stalled" | "crashed" | "recovered" | "page_error", detail: string }
    // Every few seconds (page/Meter.ts): the engine's output (peak, samples at full scale, NaNs), frames drawn and the
    // longest gap, long tasks, the tab's visibility, the JS heap; for the session log.
    | { type: "heartbeat", pos: string, playing: boolean, cpu: number, audio: string, frames: number, longestFrameMs: number,
        visible: boolean, peak: number, clipped: number, nan: number, heapMb: number | null, longTasks: number, longestTaskMs: number }

export type BackendToPage =
    | { type: "welcome", session: string, protocol: number, startedAt: string }
    | { type: "pong", id: number, sent: number }          // sent: echoed back unchanged
    | { type: "query", id: number, query: "snapshot", detail: Detail }
    | { type: "look", id: number, code: string }          // read-only JavaScript, an async function body, `takedo` in scope
    | { type: "apply", request: Apply }
    | { type: "cancel", request: string }                 // take back a request still waiting for its bar
    | { type: "chat", line: ChatLine }
    | { type: "card", card: MemberCard }
    | { type: "controls", controls: Control[] }            // every member's controls, replacing those shown
    // aliases: agents the producer sees as another (the utility appears as the Team Lead; FEATURES.md, "The team")
    | { type: "team", members: TeamMember[], aliases: Record<string, Actor> }
    | { type: "overview", state: "writing" } | { type: "overview", state: "done", overview: Overview }
    | { type: "overview", state: "failed", detail: string }
    | { type: "library", sounds: LibrarySound[], drums: LibraryDrum[], chains: Array<{ key: string, summary: string }> }   // the sound library, with the character effects
    | { type: "audition", id: string, code: string } | { type: "audition", id: string, error: string }   // the track to audition, as agents would make it
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
