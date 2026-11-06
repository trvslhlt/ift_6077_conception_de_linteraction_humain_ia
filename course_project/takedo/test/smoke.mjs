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
const context = await browser.newContext({viewport: {width: 1440, height: 900}})
const page = await context.newPage()
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

    // ---------- one message through B: chat → Jev → mix engineer → claim → ramp in the page → reply ----------
    await page.evaluate(() => {
        window.takedo.debug.addSynth("Drums")
        window.takedo.debug.addSynth("Keys")
    })
    const volume = name => page.evaluate(name =>
        window.takedo.adapter.snapshot().tracks.find(track => track.name === name).mix.volume, name)
    const memberLines = () => page.locator(`[data-testid=takedo-chat] li[data-from="agent:mix_engineer"]`)
    const say = async text => {
        const before = await memberLines().count()
        const start = Date.now()
        await page.getByTestId("takedo-input").fill(text)
        await page.getByTestId("takedo-input").press("Enter")
        await page.waitForFunction(count =>
            document.querySelectorAll(`[data-testid=takedo-chat] li[data-from="agent:mix_engineer"]`).length > count,
            before, {timeout: 20000})
        return {text: await memberLines().last().textContent(), ms: Date.now() - start}
    }
    await page.evaluate(() => window.opendaw.engine.play())
    const drumsBefore = await volume("Drums")
    const quieter = await say("@mix_engineer the drums are too loud")
    const drumsAfter = await volume("Drums")
    check("@mix_engineer: drums turned down during playback", drumsAfter < drumsBefore - 0.5,
        `${drumsBefore} → ${drumsAfter.toFixed(1)} dB in ${quieter.ms} ms: "${quieter.text}"`)
    check("engine kept playing", await page.evaluate(() => window.opendaw.engine.isPlaying()))
    check("member card shows the change",
        (await page.getByTestId("takedo-card-agentmix_engineer").textContent()).includes("done"))

    // One undo step for the whole ramp. openDAW's shortcut needs focus outside the chat input.
    await page.locator("body").click({position: {x: 400, y: 300}})
    await page.locator("body").press("ControlOrMeta+z")
    await page.waitForTimeout(200)
    const undone = await volume("Drums")
    check("one undo restores the volume", Math.abs(undone - drumsBefore) < 0.05, `${undone} dB`)

    const keysBefore = await volume("Keys")
    const louder = await say("the keys are a bit too quiet")
    const keysAfter = await volume("Keys")
    check("unaddressed message routed to the mix engineer, keys up", keysAfter > keysBefore + 0.5,
        `${keysBefore} → ${keysAfter.toFixed(1)} dB in ${louder.ms} ms: "${louder.text}"`)

    // The producer holds the Drums fader: the request is dropped, not applied.
    await page.evaluate(() => {
        const project = window.takedo.service.projectProfileService.getValue().unwrap().project
        const unit = project.rootBoxAdapter.audioUnits.adapters().find(unit => unit.label === "Drums")
        window.__drumsVolume = unit.namedParameter.volume
        document.dispatchEvent(new CustomEvent("parameter-hold", {detail: {parameter: window.__drumsVolume, held: true}}))
    })
    const heldBefore = await volume("Drums")
    const held = await say("@mix_engineer drums down a little")
    check("held fader: request dropped", held.text.includes("holding") && await volume("Drums") === heldBefore,
        `"${held.text}"`)
    await page.evaluate(() =>
        document.dispatchEvent(new CustomEvent("parameter-hold", {detail: {parameter: window.__drumsVolume, held: false}})))

    // A hidden tab: animation frames stop, so landing and ramping must not depend on them (page/Clock.ts).
    // The message is sent from the backend's side of things, as typed before switching: fill, switch, then Enter.
    const other = await page.context().newPage()
    await other.goto("about:blank")
    await other.bringToFront()
    const hidden = await page.evaluate(() => document.visibilityState)
    if (hidden !== "hidden") {
        console.log(`SKIP  edit lands while the tab is hidden  (headless reports the tab as ${hidden})`)
    } else {
        const before = await volume("Keys")
        const start = Date.now()
        await page.evaluate(() => window.takedo.connection.send({type: "chat", text: "@mix_engineer keys down a bit"}))
        await page.waitForFunction(before =>
            window.takedo.adapter.snapshot().tracks.find(track => track.name === "Keys").mix.volume < before - 0.5,
            before, {timeout: 10000, polling: 100}).catch(() => {})
        const after = await volume("Keys")
        check("edit lands while the tab is hidden", after < before - 0.5,
            `${before.toFixed(1)} → ${after.toFixed(1)} dB in ${Date.now() - start} ms`)
    }
    await other.close()
    await page.bringToFront()
    await page.evaluate(() => window.opendaw.engine.stop())

    check("no page errors or failed requests", problems.length === 0, problems.slice(0, 5).join("; "))
} catch (error) {
    check("unexpected error", false, error.message.split("\n")[0])
} finally {
    await browser.close()
}

console.log(failures.length === 0 ? "\nTakeDo smoke test passed" : `\nTakeDo smoke test failed: ${failures.join(", ")}`)
process.exit(failures.length === 0 ? 0 : 1)
