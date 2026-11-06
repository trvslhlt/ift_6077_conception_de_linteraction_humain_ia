// TakeDo smoke test: boots the studio in headless Chromium, opens a new project and the team view, and checks the
// page reaches the backend: welcome, a ping round trip, and reconnecting after the socket drops.
// Run via `make test`; it shares the studio container's network, so the page is at localhost.
import {chromium} from "playwright"

const URL = process.env.URL ?? "http://localhost:8080/"
const TIMEOUT = 60000

const failures = []
const check = (name, ok, detail = "") => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`)
    if (!ok) failures.push(name)
}

const browser = await chromium.launch({args: ["--autoplay-policy=no-user-gesture-required"]})
const page = await browser.newPage({viewport: {width: 1440, height: 900}})
page.setDefaultTimeout(TIMEOUT)

const problems = []
page.on("pageerror", error => problems.push(`pageerror: ${error.message}`))
page.on("console", message => {if (message.type() === "error") problems.push(`console: ${message.text()}`)})
page.on("response", response => {if (response.status() >= 400) problems.push(`http ${response.status()}: ${response.url()}`)})

const waitForStatus = (value, timeout = 10000) => page.waitForFunction(
    value => document.querySelector("[data-testid=takedo-status]")?.dataset.status === value, value, {timeout})

try {
    // The dev server transforms modules on first request, so the first load is slow.
    const response = await page.goto(URL, {waitUntil: "networkidle", timeout: 3 * TIMEOUT})
    check("page loads", response?.ok() === true, `HTTP ${response?.status()}`)
    check("cross-origin isolated", await page.evaluate(() => crossOriginIsolated))

    await page.getByText("New Project", {exact: true}).click()
    await page.getByText("Add instrument").first().waitFor()
    // A fresh browser gets the welcome tour dialog; Escape closes it.
    await page.getByText("Welcome to openDAW").waitFor()
    await page.keyboard.press("Escape")
    await page.getByText("Welcome to openDAW").waitFor({state: "hidden"})
    check("new project opens", true)

    await page.getByTestId("takedo-toggle").click()
    await page.getByTestId("takedo-panel").waitFor()
    check("team view opens", true)

    await waitForStatus("open")
    const session = await page.getByTestId("takedo-session").textContent()
    check("backend welcomes the page", /session [0-9a-f-]{36}/.test(session), session)

    const trips = []
    for (let i = 0; i < 20; i++) {trips.push(await page.evaluate(() => window.takedo.connection.ping()))}
    trips.sort((a, b) => a - b)
    const median = trips[10]
    check("ping round trip", median < 50, `median ${median.toFixed(1)} ms, max ${trips[19].toFixed(1)} ms`)

    // Drop the socket from the page side; the connection should come back on its own with a new session.
    await page.evaluate(() => {
        const original = WebSocket.prototype.send
        window.__closeTakeDo = () => new Promise(resolve => {
            WebSocket.prototype.send = function (data) {
                WebSocket.prototype.send = original
                this.close()
                resolve()
            }
            window.takedo.connection.ping().catch(() => {})
        })
    })
    await page.evaluate(() => window.__closeTakeDo())
    // Closing is asynchronous and the retry comes 250 ms later, so wait for a different session, not for "open".
    await page.waitForFunction(previous => {
        const text = document.querySelector("[data-testid=takedo-session]")?.textContent ?? ""
        return text.startsWith("session ") && text !== previous
    }, session, {timeout: 10000}).catch(() => {})
    const again = await page.getByTestId("takedo-session").textContent()
    check("reconnects after the socket drops", again !== session && /session /.test(again), again)

    check("engine still plays", await page.evaluate(async () => {
        window.opendaw.engine.play()
        await new Promise(resolve => setTimeout(resolve, 500))
        const playing = window.opendaw.engine.isPlaying()
        window.opendaw.engine.stop()
        return playing
    }))

    check("no page errors or failed requests", problems.length === 0, problems.slice(0, 5).join("; "))
} catch (error) {
    check("unexpected error", false, error.message.split("\n")[0])
} finally {
    await browser.close()
}

console.log(failures.length === 0 ? "\nTakeDo smoke test passed" : `\nTakeDo smoke test failed: ${failures.join(", ")}`)
process.exit(failures.length === 0 ? 0 : 1)
