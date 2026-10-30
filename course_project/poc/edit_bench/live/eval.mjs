// Runs JavaScript in an open edit bench tab over the Chrome DevTools Protocol, so a person can work in a project
// while someone at the terminal (or an agent) edits it. Chrome must be started with remote debugging:
//   open -na "Google Chrome" --args --remote-debugging-port=9222 --user-data-dir="$HOME/.chrome-opendaw-live" http://localhost:8080
// Usage: node live/eval.mjs '<expression>'   (or a file: node live/eval.mjs -f script.js)
// The expression runs as the body of an async function with `bench` (window.editBench: project, lib, checks) in
// scope; its return value is printed as JSON. No dependencies: Node's own fetch and WebSocket.
import {readFileSync} from "node:fs"

const [flag, value] = process.argv.slice(2)
const body = flag === "-f" ? readFileSync(value, "utf8") : flag
if (!body) {throw new Error("usage: node live/eval.mjs '<expression>' | -f <file>")}
const port = process.env.CDP_PORT ?? 9222
const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const tab = tabs.find(tab => tab.type === "page" && tab.url.startsWith(process.env.URL ?? "http://localhost:8080"))
if (tab === undefined) {throw new Error(`no openDAW tab among: ${tabs.map(tab => tab.url).join(", ")}`)}
const socket = new WebSocket(tab.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {socket.onopen = resolve; socket.onerror = reject})
const expression = `(async () => {
    const bench = window.editBench
    if (bench === undefined) {throw new Error("no project open (or the bench isn't loaded)")}
    ${body}
})()`
socket.send(JSON.stringify({id: 1, method: "Runtime.evaluate", params: {expression, awaitPromise: true, returnByValue: true}}))
const reply = await new Promise(resolve => socket.onmessage = event => resolve(JSON.parse(event.data)))
socket.close()
const {result, exceptionDetails} = reply.result
if (exceptionDetails !== undefined) {
    console.error(exceptionDetails.exception?.description ?? exceptionDetails.text)
    process.exit(1)
}
console.log(JSON.stringify(result.value, null, 2) ?? "undefined")
