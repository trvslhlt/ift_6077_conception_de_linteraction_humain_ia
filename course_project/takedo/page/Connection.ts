import {Notifier, Observer, Subscription, Terminable} from "@opendaw/lib-std"
import {
    type BackendToPage, decode, encode, type PageToBackend, ProtocolVersion, SocketPath
} from "@/takedo_shared/protocol"

// The page's end of the socket to the backend. Same origin as the studio (Vite proxies SocketPath to the backend),
// so cross-origin isolation doesn't get in the way. Reconnects on its own: the backend restarts whenever its code
// changes.

export type ConnectionState = {
    status: "connecting" | "open" | "closed"
    session: string | null      // from the backend's welcome
    roundTripMs: number | null  // the last ping's
    error: string | null
}

const RetryMs = [250, 500, 1000, 2000, 5000]

export class Connection implements Terminable {
    readonly #notifier = new Notifier<ConnectionState>()
    readonly #pings = new Map<number, (ms: number) => void>()
    #state: ConnectionState = {status: "connecting", session: null, roundTripMs: null, error: null}
    #socket: WebSocket | null = null
    #retries = 0
    #retryTimer: ReturnType<typeof setTimeout> | null = null
    #nextPing = 0
    #terminated = false

    constructor() {this.#open()}

    get state(): ConnectionState {return this.#state}

    subscribe(observer: Observer<ConnectionState>): Subscription {return this.#notifier.subscribe(observer)}

    // Resolves with the round trip in ms; rejects if the socket isn't open or closes first.
    ping(): Promise<number> {
        const socket = this.#socket
        if (socket === null || this.#state.status !== "open") {return Promise.reject(new Error("not connected"))}
        const id = ++this.#nextPing
        return new Promise((resolve, reject) => {
            this.#pings.set(id, resolve)
            socket.addEventListener("close", () => {
                if (this.#pings.delete(id)) {reject(new Error("closed"))}
            }, {once: true})
            this.#send({type: "ping", id, sent: performance.now()})
        })
    }

    terminate(): void {
        this.#terminated = true
        if (this.#retryTimer !== null) {clearTimeout(this.#retryTimer)}
        this.#socket?.close()
        this.#socket = null
    }

    #open(): void {
        const scheme = location.protocol === "https:" ? "wss" : "ws"
        const socket = new WebSocket(`${scheme}://${location.host}${SocketPath}`)
        this.#socket = socket
        this.#update({status: "connecting"})
        socket.onopen = () => {
            this.#retries = 0
            this.#send({type: "hello", client: "page", protocol: ProtocolVersion})
        }
        socket.onmessage = event => {
            const message = decode<BackendToPage>(String(event.data))
            if (message === null) {return}
            switch (message.type) {
                case "welcome":
                    this.#update({status: "open", session: message.session, error: null})
                    return
                case "pong": {
                    const ms = performance.now() - message.sent
                    this.#pings.get(message.id)?.(ms)
                    this.#pings.delete(message.id)
                    this.#update({roundTripMs: ms})
                    return
                }
                case "error":
                    this.#update({error: message.detail})
                    return
            }
        }
        socket.onclose = () => {
            if (this.#socket !== socket) {return}
            this.#socket = null
            this.#update({status: "closed", session: null})
            if (this.#terminated) {return}
            const delay = RetryMs[Math.min(this.#retries++, RetryMs.length - 1)]
            this.#retryTimer = setTimeout(() => this.#open(), delay)
        }
    }

    #send(message: PageToBackend): void {this.#socket?.send(encode(message))}

    #update(change: Partial<ConnectionState>): void {
        this.#state = {...this.#state, ...change}
        this.#notifier.notify(this.#state)
    }
}
