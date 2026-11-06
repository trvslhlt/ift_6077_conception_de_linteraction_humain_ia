// Messages between the page (adapter, team view) and the backend (coordinator, members), over one WebSocket.
// Plain JSON, one object per frame, discriminated by `type`. The TakeDoAPI's structures (project_plan/TAKEDO_API.md)
// are added here as they're built.
//
// Shared by the page (Vite, mounted at src/takedo_shared) and the backend (Node, run with type stripping), so this
// directory holds erasable TypeScript only: types and plain functions, no enums, no parameter properties.

export const ProtocolVersion = 1
export const SocketPath = "/takedo"

export type PageToBackend =
    | { type: "hello", client: "page", protocol: number }
    | { type: "ping", id: number, sent: number }          // sent: the page's performance.now()

export type BackendToPage =
    | { type: "welcome", session: string, protocol: number, startedAt: string }
    | { type: "pong", id: number, sent: number }          // sent: echoed back unchanged
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
