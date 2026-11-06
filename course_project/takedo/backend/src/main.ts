import {createServer} from "node:http"
import {randomUUID} from "node:crypto"
import {WebSocketServer, type WebSocket} from "ws"
import {
    type BackendToPage, decode, encode, type PageToBackend, ProtocolVersion, SocketPath
} from "../../shared/protocol.ts"

// The TakeDo backend: for now only the socket the page connects to. The page reaches it through Vite's proxy at
// SocketPath, so the socket is same-origin for the cross-origin-isolated studio page.
// GET /health answers the container healthcheck.

const Port = Number(process.env.PORT ?? 8787)

const log = (event: string, detail: object = {}): void =>
    console.log(JSON.stringify({t: new Date().toISOString(), event, ...detail}))

const send = (socket: WebSocket, message: BackendToPage): void => socket.send(encode(message))

const server = createServer((request, response) => {
    if (request.url === "/health") {
        response.writeHead(200, {"Content-Type": "application/json"})
        response.end(JSON.stringify({ok: true, pages: sockets.clients.size}))
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
    log("connected", {session})
    socket.on("message", data => {
        const message = decode<PageToBackend>(data.toString())
        if (message === null) {
            send(socket, {type: "error", detail: "not a TakeDo message"})
            return
        }
        switch (message.type) {
            case "hello":
                if (message.protocol !== ProtocolVersion) {
                    send(socket, {type: "error", detail: `protocol ${message.protocol}, expected ${ProtocolVersion}`})
                    socket.close()
                    return
                }
                send(socket, {type: "welcome", session, protocol: ProtocolVersion, startedAt: new Date().toISOString()})
                log("hello", {session, client: message.client})
                return
            case "ping":
                send(socket, {type: "pong", id: message.id, sent: message.sent})
                return
            default:
                send(socket, {type: "error", detail: `unknown type ${(message as { type: string }).type}`})
        }
    })
    socket.on("close", () => log("disconnected", {session}))
})

server.listen(Port, () => log("listening", {port: Port}))
