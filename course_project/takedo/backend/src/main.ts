import {createServer} from "node:http"
import {randomUUID} from "node:crypto"
import {join} from "node:path"
import {WebSocketServer, type WebSocket} from "ws"
import {
    type BackendToPage, decode, encode, type PageToBackend, ProtocolVersion, SocketPath
} from "../../shared/protocol.ts"
import {Coordinator} from "./coordinator.ts"
import {loadCatalog} from "./catalog.ts"
import {Gateway, loadConfig} from "./gateway.ts"
import {SessionLog} from "./sessionLog.ts"
import {Source} from "./source.ts"

// The TakeDo backend. The page reaches it through Vite's proxy at SocketPath, so the socket is same-origin for the
// cross-origin-isolated studio page. Each page connection is one session, with its own coordinator and log.
// GET /health answers the container healthcheck.

const Port = Number(process.env.PORT ?? 8787)
const SessionsDir = process.env.SESSIONS_DIR ?? "../sessions"
const NotebooksDir = join(SessionsDir, "notebooks")
const source = new Source(process.env.OPENDAW_SOURCE ?? "../.opendaw")
const ModelsConfig = process.env.MODELS_CONFIG ?? "../config/models.json"
const CatalogDir = process.env.CATALOG_DIR ?? "../catalog"

const gateway = new Gateway(loadConfig(ModelsConfig))
const catalog = loadCatalog(`${CatalogDir}/devices.json`, `${CatalogDir}/generated.json`)

const log = (event: string, detail: object = {}): void =>
    console.log(JSON.stringify({t: new Date().toISOString(), event, ...detail}))

const send = (socket: WebSocket, message: BackendToPage): void => socket.send(encode(message))

const server = createServer((request, response) => {
    if (request.url === "/health") {
        response.writeHead(200, {"Content-Type": "application/json"})
        response.end(JSON.stringify({ok: true, pages: sockets.clients.size, jev: gateway.available("fast_path")}))
        return
    }
    response.writeHead(404).end()
})

const sockets = new WebSocketServer({noServer: true})

server.on("upgrade", (request, socket, head) => {
    if (request.url !== SocketPath) {
        socket.destroy()
        return
    }
    sockets.handleUpgrade(request, socket, head, client => sockets.emit("connection", client))
})

sockets.on("connection", (socket: WebSocket) => {
    const session = randomUUID()
    let coordinator: Coordinator | null = null
    log("connected", {session})
    socket.on("message", data => {
        const message = decode<PageToBackend>(data.toString())
        if (message === null) {
            send(socket, {type: "error", detail: "not a TakeDo message"})
            return
        }
        switch (message.type) {
            case "hello": {
                if (message.protocol !== ProtocolVersion) {
                    send(socket, {type: "error", detail: `protocol ${message.protocol}, expected ${ProtocolVersion}: reload the page`})
                    socket.close()
                    return
                }
                const stamp = new Date().toISOString().replace(/[:.]/g, "-")
                const sessionLog = new SessionLog(join(SessionsDir, `${stamp}_${session.slice(0, 8)}`), session,
                    {protocol: ProtocolVersion, jev: gateway.available("fast_path")})
                coordinator = new Coordinator(reply => send(socket, reply), gateway, catalog, sessionLog, NotebooksDir, source)
                send(socket, {type: "welcome", session, protocol: ProtocolVersion, startedAt: new Date().toISOString()})
                coordinator.start()
                log("hello", {session, client: message.client})
                return
            }
            case "ping":
                send(socket, {type: "pong", id: message.id, sent: message.sent})
                return
            default:
                if (coordinator === null) {
                    send(socket, {type: "error", detail: "say hello first"})
                    return
                }
                coordinator.receive(message)
        }
    })
    socket.on("close", () => log("disconnected", {session}))
})

server.listen(Port, () => log("listening", {port: Port, jev: gateway.available("fast_path")}))
