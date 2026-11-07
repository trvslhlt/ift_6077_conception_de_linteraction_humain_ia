// Runs JavaScript in the open TakeDo tab over the Chrome DevTools Protocol, so an agent at the terminal (Claude Code)
// can work on the project the way the utility does, for comparison (copied from poc/edit_bench/live/eval.mjs).
// Chrome must be started with remote debugging:
//   open -na "Google Chrome" --args --remote-debugging-port=9222 --user-data-dir="$HOME/.chrome-opendaw-live" http://localhost:8080
// Usage: node live/eval.mjs '<body>'   (or a file: node live/eval.mjs -f script.js)
// The body runs as an async function with the utility's names in scope (takedo, project, api, lib, ref, bar, ppqn, pos,
// snapshot) plus `adapter` and `apply(plan, when, {wait})`: the utility's fixed operations and scripts, through the
// adapter, landing on bars ({at: "bar", bar: 5}, {at: "next", unit: "bar"}, {at: "asap"}). apply resolves with the
// status once scheduled, or once finished with wait: true. Its return value is printed as JSON. No dependencies.
import {readFileSync} from "node:fs"

const [flag, value] = process.argv.slice(2)
const body = flag === "-f" ? readFileSync(value, "utf8") : flag
if (!body) {throw new Error("usage: node live/eval.mjs '<body>' | -f <file>")}
const port = process.env.CDP_PORT ?? 9222
const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const tab = tabs.find(tab => tab.type === "page" && tab.url.startsWith(process.env.URL ?? "http://localhost:8080"))
if (tab === undefined) {throw new Error(`no openDAW tab among: ${tabs.map(tab => tab.url).join(", ")}`)}
const socket = new WebSocket(tab.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {socket.onopen = resolve; socket.onerror = reject})
const expression = `(async () => {
    const adapter = window.takedo?.adapter
    if (adapter == null) {throw new Error("no project open (or TakeDo isn't loaded)")}
    const takedo = adapter.env
    const {project, api, lib, ref, ppqn, pos, snapshot} = takedo
    const bar = takedo.bar
    const apply = (plan, when = {at: "asap"}, {wait = false} = {}) => new Promise(resolve => {
        const id = crypto.randomUUID()
        const subscription = adapter.subscribeActivity(({request, status}) => {
            if (request.id !== id) {return}
            const terminal = ["applied", "dropped", "failed"].includes(status.state)
            if (terminal) {subscription.terminate()}
            if (terminal || (!wait && status.state === "scheduled")) {resolve(status)}
        })
        adapter.apply({id, from: "agent:live", plan, when, seq: adapter.snapshot().at.seq, reason: "live"})
    })
    const result = await (async () => {
        ${body}
    })()
    return JSON.stringify(result === undefined ? null : result)
})()`
socket.send(JSON.stringify({id: 1, method: "Runtime.evaluate", params: {expression, awaitPromise: true, returnByValue: true}}))
const reply = await new Promise(resolve => socket.onmessage = event => resolve(JSON.parse(event.data)))
socket.close()
const {result, exceptionDetails} = reply.result
if (exceptionDetails !== undefined) {
    console.error(exceptionDetails.exception?.description ?? exceptionDetails.text)
    process.exit(1)
}
console.log(result.value)
