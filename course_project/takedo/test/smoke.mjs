// TakeDo smoke test: boots the studio in headless Chromium, opens a new project and the team view, and checks the
// page reaches the backend (welcome, ping, reconnecting), the Team Lead's overview, and the mix engineer's edits.
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
// Requests to other origins are openDAW's own (e.g. api.opendaw.studio's user count) and fail with the network; not ours.
const ours = url => url === undefined || url === "" || url.startsWith(new globalThis.URL(URL).origin)
page.on("console", message => {
    const url = message.location().url
    if (message.type() === "error" && ours(url)) {problems.push(`console: ${message.text()} ${url ?? ""}`)}
})
page.on("response", response => {
    if (response.status() >= 400 && ours(response.url())) {problems.push(`http ${response.status()}: ${response.url()}`)}
})

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

    // Two parts with a bar of notes each, before the view opens: Keys (Tubular, FM) play Am then F, Drums four on the floor.
    await page.evaluate(() => {
        window.takedo.debug.addSynth("Drums", [[0, 36, 1], [4, 36, 1], [8, 36, 1], [12, 36, 1]])
        window.takedo.debug.addSynth("Keys", [[0, 57, 8], [0, 60, 8], [0, 64, 8], [8, 53, 8], [8, 57, 8], [8, 60, 8]], "Tubular")
    })

    const overviewStarted = Date.now()
    await page.getByTestId("takedo-toggle").click()
    await page.getByTestId("takedo-panel").waitFor()
    check("team view opens", true)
    const layout = await page.evaluate(() => {
        const view = document.querySelector("[data-testid=takedo-view]").getBoundingClientRect()
        const chat = document.querySelector("[data-testid=takedo-chat]").getBoundingClientRect()
        const overview = document.querySelector("[data-testid=takedo-status]").getBoundingClientRect()
        return {view: view.width / innerWidth, tall: view.height / innerHeight, chatBeside: chat.left > overview.right,
            chat: chat.width / view.width}
    })
    check("team view fills the window, chat in its own column",
        layout.view > 0.9 && layout.tall > 0.7 && layout.chatBeside && layout.chat > 0.5,
        `view ${Math.round(layout.view * 100)}% × ${Math.round(layout.tall * 100)}%, chat ${Math.round(layout.chat * 100)}% of it`)

    await waitForStatus("open")
    const session = await page.getByTestId("takedo-session").textContent()
    check("backend welcomes the page", /session [0-9a-f-]{36}/.test(session), session)

    // The Team Lead's overview (one Claude call): Music, Style and Tracks lines, plus the page's live playback line.
    const overviewLines = () => page.evaluate(() =>
        [...document.querySelectorAll("[data-testid=takedo-overview-body] [data-testid=takedo-overview-line]")]
            .map(line => ({label: line.dataset.label, text: line.textContent})))
    const waitForOverview = () => page.waitForFunction(() =>
        ["done", "failed"].includes(document.querySelector("[data-testid=takedo-overview]")?.dataset.state),
        null, {timeout: 60000})
    await waitForOverview()
    const lines = await overviewLines()
    const tracksLine = lines.find(line => line.label === "Tracks")?.text ?? ""
    check("overview written when the view opens",
        ["Music", "Style", "Tracks"].every(label => lines.some(line => line.label === label))
            && tracksLine.includes("Drums") && tracksLine.includes("Keys"),
        `${Date.now() - overviewStarted} ms`)
    // Only the catalog says Tubular is an FM synth (openDAW's brief and our notes); the snapshot just names the device.
    check("overview uses the device catalog", /\bFM\b|DX7/.test(tracksLine), tracksLine)
    lines.forEach(line => console.log(`      ${line.text}`))
    await page.getByTestId("takedo-overview-playback").filter({hasText: "stopped"}).waitFor({timeout: 2000})
    check("overview shows live playback", true)

    // A change since the overview offers a refresh; the refreshed overview includes it.
    await page.evaluate(() => window.takedo.debug.addSynth("Pad", [[0, 69, 16], [0, 72, 16]]))
    await page.getByTestId("takedo-overview-refresh").waitFor({state: "visible", timeout: 2000})
    await page.getByTestId("takedo-overview-refresh").click()
    await page.waitForFunction(() =>
        document.querySelector("[data-testid=takedo-overview]")?.dataset.state === "writing", null, {timeout: 2000})
    await waitForOverview()
    const refreshed = (await overviewLines()).find(line => line.label === "Tracks")?.text ?? ""
    check("refreshed overview includes a new track", refreshed.includes("Pad"), refreshed)

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
    const volume = name => page.evaluate(name =>
        window.takedo.adapter.snapshot().tracks.find(track => track.name === name).mix.volume, name)
    const memberLines = (agent = "mix_engineer") => page.locator(`[data-testid=takedo-chat] li[data-from="agent:${agent}"]`)
    // Sends a message and waits for the next line from each of the given members (their reply, after their edits).
    const say = async (text, agents = ["mix_engineer"], timeout = 20000) => {
        const before = await Promise.all(agents.map(agent => memberLines(agent).count()))
        const start = Date.now()
        await page.getByTestId("takedo-input").fill(text)
        await page.getByTestId("takedo-input").press("Enter")
        await Promise.all(agents.map((agent, index) => page.waitForFunction(([agent, count]) =>
            document.querySelectorAll(`[data-testid=takedo-chat] li[data-from="agent:${agent}"]`).length > count,
            [agent, before[index]], {timeout})))
        const texts = await Promise.all(agents.map(agent => memberLines(agent).last().textContent()))
        return {text: texts.join(" | "), ms: Date.now() - start}
    }
    const track = name => page.evaluate(name => window.takedo.adapter.snapshot().tracks.find(track => track.name === name), name)
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

    // ---------- recording: openDAW records the agents' live value changes as automation by itself ----------
    await page.evaluate(async () => {
        const project = window.takedo.service.projectProfileService.getValue().unwrap().project
        project.startRecording(false)
        while (!project.engine.isRecording.getValue()) {await new Promise(resolve => setTimeout(resolve, 20))}
    })
    const recorded = await say("@mix_engineer the keys are too loud")
    await page.evaluate(async () => {
        const project = window.takedo.service.projectProfileService.getValue().unwrap().project
        project.stopRecording()
        while (project.engine.isRecording.getValue()) {await new Promise(resolve => setTimeout(resolve, 20))}
        if (!project.engine.isPlaying.getValue()) {window.opendaw.engine.play()}
    })
    const keysLanes = (await track("Keys")).lanes
    check("while recording, the agent's change is recorded as automation", keysLanes.length === 1,
        `lanes ${JSON.stringify(keysLanes)}: "${recorded.text}"`)
    const afterTake = await say("@mix_engineer the keys are a bit too quiet")
    check("after the take, its lane is left alone (no live write over automation)",
        afterTake.text.includes("not_allowed"), `"${afterTake.text}"`)

    // ---------- mentions: autocomplete from the team, styled in the input and in the chat ----------
    await page.getByTestId("takedo-input").fill("")
    await page.getByTestId("takedo-input").pressSequentially("@")
    const options = await page.getByTestId("takedo-mention-option").evaluateAll(items => items.map(item => item.dataset.role))
    check("@ lists the team, without the utility",
        ["team_lead", "mix_engineer", "arranger", "effect_designer"].every(role => options.includes(role))
            && !options.includes("utility"), options.join(", "))
    await page.getByTestId("takedo-input").pressSequentially("ar")
    const narrowed = await page.getByTestId("takedo-mention-option").evaluateAll(items => items.map(item => item.dataset.role))
    await page.getByTestId("takedo-input").press("Tab")
    const completed = await page.getByTestId("takedo-input").inputValue()
    check("autocomplete completes a mention", narrowed.length === 1 && completed === "@arranger ",
        `${narrowed.join(", ")} → "${completed}"`)
    check("mention styled while typing",
        await page.locator("[data-testid=takedo-mention][data-role=arranger]").count() === 1)

    // ---------- the arranger (Claude): mute at the next bar, back two bars later ----------
    await page.evaluate(() => {
        window.__keysMuted = false
        window.__muteWatch = setInterval(() => {
            if (window.takedo.adapter.snapshot().tracks.find(track => track.name === "Keys").mix.mute) {window.__keysMuted = true}
        }, 50)
    })
    const arranged = await say("@arranger drop the keys out at the next bar and bring them back two bars later",
        ["arranger"], 40000)
    const keysMuted = await page.evaluate(() => {
        clearInterval(window.__muteWatch)
        return window.__keysMuted
    })
    check("@arranger: keys dropped out and came back", keysMuted && !(await track("Keys")).mix.mute,
        `${arranged.ms} ms: "${arranged.text}"`)
    check("mention styled in the chat",
        await page.locator("[data-testid=takedo-chat] li[data-from=user] [data-testid=takedo-mention][data-role=arranger]").count() > 0)

    // ---------- the effect designer (Claude, with the catalog): an effect chosen by sound ----------
    const reverbed = await say("@effect_designer give the keys a big lush reverb", ["effect_designer"], 40000)
    const keysEffects = (await track("Keys")).effects
    check("@effect_designer: reverb added to the keys",
        keysEffects.some(effect => ["DattorroReverb", "Reverb", "Convolver"].includes(effect.key)),
        `${keysEffects.map(effect => effect.key).join(", ") || "none"} in ${reverbed.ms} ms: "${reverbed.text}"`)

    // ---------- the Team Lead (Claude) splits one direction between two members ----------
    const drumsBeforeLead = await volume("Drums")
    const led = await say("@team_lead bring the drums down a bit and put an echo on the keys",
        ["team_lead", "mix_engineer", "effect_designer"], 60000)
    const keysAfterLead = (await track("Keys")).effects.map(effect => effect.key)
    check("@team_lead: drums down and a delay on the keys",
        await volume("Drums") < drumsBeforeLead - 0.5 && keysAfterLead.includes("Delay"),
        `${led.ms} ms: "${led.text}"`)

    // The open path: something no member has an operation for goes to the utility, which does it with a script.
    const extended = await say("@team_lead extend all the clips so they run for 16 bars", ["team_lead", "utility"], 120000)
    const ends = (await page.evaluate(() => window.takedo.adapter.snapshot().tracks.map(track => [track.name, track.bars?.to ?? 0])))
    check("@team_lead → utility: every clip extended to 16 bars by script",
        ends.every(([, to]) => to >= 16), `${ends.map(([name, to]) => `${name} to bar ${to}`).join(", ")} in ${extended.ms} ms: "${extended.text}"`)
    const utilityShown = await memberLines("utility").last().evaluate(line =>
        ({speaker: line.firstElementChild.textContent, shownAs: line.dataset.shown}))
    const chatText = await page.getByTestId("takedo-chat").textContent()
    check("the utility appears as the Team Lead, never by name",
        utilityShown.speaker === "team lead" && !/utility/i.test(chatText.replace(/@utility/g, "")),
        `shown as "${utilityShown.speaker}"`)
    // Script and fixed operation together: a script makes a track, the next round fades it in with the mix engineer's
    // volume tool (which a script can't do: it changes things at one instant).
    const made = await say("@utility add a new Vaporisateur track called Lead with a bar of notes at -30 dB, then fade it up to 0 dB over 8 beats",
        ["utility"], 120000)
    const lead = await track("Lead")
    check("@utility: a scripted track, faded in by a fixed operation",
        lead !== undefined && lead.mix.volume > -1, `${lead === undefined ? "no Lead track" : `Lead at ${lead.mix.volume.toFixed(1)} dB`} in ${made.ms} ms: "${made.text}"`)

    // A script that changes a control the producer holds is undone, whatever the code does.
    await page.evaluate(() =>
        document.dispatchEvent(new CustomEvent("parameter-hold", {detail: {parameter: window.__drumsVolume, held: true}})))
    const heldScriptBefore = await volume("Drums")
    const heldScript = await say("@utility with a script, set the Drums volume to -20 dB", ["utility"], 120000)
    check("@utility: a script touching a held control is undone",
        await volume("Drums") === heldScriptBefore, `${heldScriptBefore} → ${await volume("Drums")} dB: "${heldScript.text}"`)
    await page.evaluate(() =>
        document.dispatchEvent(new CustomEvent("parameter-hold", {detail: {parameter: window.__drumsVolume, held: false}})))

    if (process.env.SCREENSHOT) {await page.screenshot({path: process.env.SCREENSHOT})}

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
