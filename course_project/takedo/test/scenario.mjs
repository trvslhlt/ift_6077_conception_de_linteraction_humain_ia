// A scenario: a fixed project and a fixed list of producer messages, played to TakeDo in headless Chromium while the
// project plays. Records the project before and after (notes included), each message's replies and how long its edits
// took to land, and the backend's session id; `make scenario` then writes the report from that and the session log.
// Run via `make scenario SCENARIO=<name>` (scenarios/<name>.json); shares the studio container's network like smoke.mjs.
// A message may carry restart_after_ms: the backend is killed that long after it's sent (the Makefile does it when this
// drops scenarios/.restart), and its reply is the one after the page has reconnected.
// A step may move a control instead of sending text: {"control": "<ref, or omitted for the first one shown>", "value": 0..1};
// A message with "no_settle": true moves on as soon as it's answered, without waiting for its edits to land.
// or change a parameter in openDAW as the producer would, with no reply expected: {"set": "t1.mix.volume", "value": -20}.
// {"wait_ms": 30000} just lets the project play (a probe with no agents: only set and wait steps).
import {chromium} from "playwright"
import {mkdirSync, readFileSync, writeFileSync} from "node:fs"
import {basename, dirname, join} from "node:path"
import {setTimeout as sleep} from "node:timers/promises"

const URL = process.env.URL ?? "http://localhost:8080/"
const [file] = process.argv.slice(2)
if (file === undefined) {throw new Error("usage: node scenario.mjs <scenario.json>")}
const scenario = JSON.parse(readFileSync(file, "utf8"))
const name = basename(file, ".json")
const bundle = readFileSync(join(dirname(file), "projects", scenario.project)).toString("base64")
// An edit is still landing while its row says so; a message is settled when none is, or after this long.
const SettleMs = scenario.settle_ms ?? 300000
const ReplyMs = scenario.reply_ms ?? 240000

const browser = await chromium.launch({args: ["--autoplay-policy=no-user-gesture-required"]})
const page = await (await browser.newContext({viewport: {width: 1440, height: 900}})).newPage()
page.setDefaultTimeout(60000)
const problems = []
page.on("pageerror", error => problems.push(`pageerror: ${error.message}`))
// The page's warnings and errors, timed (a stall's cause may show here).
const consoleLines = []
page.on("console", message => {
    if (["warning", "error"].includes(message.type()) && consoleLines.length < 300) {consoleLines.push({t: Date.now(), type: message.type(), text: message.text().slice(0, 300)})}
})

const agentLines = () => page.evaluate(() => [...document.querySelectorAll("[data-testid=takedo-chat] li")]
    .map(line => ({from: line.dataset.from, shown: line.dataset.shown, text: line.lastElementChild?.textContent ?? ""})))
const full = () => page.evaluate(() => window.takedo.adapter.snapshot("full"))
// Still going: edits waiting or under way, or the Team Lead with jobs running or a turn in progress (workers plan in the
// background after the captain has replied, and their edits only show once they've planned).
const landing = () => page.evaluate(() => document.querySelectorAll(
    "[data-testid=takedo-activity] li[data-state=scheduled], [data-testid=takedo-activity] li[data-state=running], [data-testid=takedo-activity] li[data-state=queued]").length
    + (/running|thinking|heard/.test(document.querySelector('[data-agent="agent:team_lead"] [data-testid=takedo-card-doing]')?.textContent ?? "") ? 1 : 0))

let sampler
const run = {scenario: name, project: scenario.project, started: new Date().toISOString(), messages: [], problems}
try {
    await page.goto(URL, {waitUntil: "networkidle", timeout: 180000})
    await page.waitForFunction(() => window.takedo?.debug?.openBundle !== undefined)
    // Its own name: the backend keeps a notebook per project name, cleared by `make scenario` before each run.
    await page.evaluate(([base64, name]) => window.takedo.debug.openBundle(base64, name), [bundle, `scenario-${name}`])
    await page.waitForFunction(() => window.takedo.adapter !== null)
    // A fresh browser gets the welcome tour when a project opens; Escape closes it.
    if (await page.getByText("Welcome to openDAW").waitFor({timeout: 5000}).then(() => true, () => false)) {
        await page.keyboard.press("Escape")
    }
    await page.getByTestId("takedo-toggle").click()
    await page.waitForFunction(() => document.querySelector("[data-testid=takedo-status]")?.dataset.status === "open")
    const sessionShown = async () => (await page.getByTestId("takedo-session").textContent()).replace("session ", "")
    run.session = await sessionShown()
    run.sessions = [run.session]
    run.before = await full()
    await page.evaluate(() => window.opendaw.engine.play())
    // How far the playhead has gone, against the clock: a stalled engine shows as too few pulses played (the report checks).
    const clock = async () => ({t: Date.now(), played: await page.evaluate(() => window.takedo.adapter.playback().played)})
    run.clock = {start: await clock()}
    // Every 2 s: the playhead's pulses, the audio clock, the engine's CPU load, the page's main-thread lag (the
    // longest a 100 ms timer ran late since the last sample), animation frames, visibility and the engine's own
    // position, so a stall shows which of them stopped.
    // COUNT_FRAMES=0 leaves the frame counter out: its own animation-frame loop may keep headless Chromium's frames
    // coming, and so hide a stall (2026-11-23: 10 runs in a row without one after it was added).
    await page.evaluate(countFrames => {
        window.__lag = {max: 0, last: performance.now()}
        // Animation frames since the last sample: openDAW reads the engine's state (position, playing) only on them.
        window.__frames = null
        if (countFrames) {
            window.__frames = 0
            const frame = () => {window.__frames++; requestAnimationFrame(frame)}
            requestAnimationFrame(frame)
        }
        setInterval(() => {
            const now = performance.now()
            window.__lag.max = Math.max(window.__lag.max, now - window.__lag.last - 100)
            window.__lag.last = now
        }, 100)
    }, process.env.COUNT_FRAMES !== "0")
    run.samples = []
    sampler = setInterval(() => {
        page.evaluate(async () => {
            const service = window.takedo?.service, engine = service?.engine
            // Whether the engine says everything (samples, instruments) has loaded; null if it doesn't answer in 0.5 s.
            const loaded = await Promise.race([engine?.queryLoadingComplete?.() ?? Promise.resolve(null),
                new Promise(resolve => setTimeout(() => resolve(null), 500))])
            const lag = window.__lag.max, frames = window.__frames
            window.__lag.max = 0
            if (window.__frames !== null) {window.__frames = 0}
            return {played: window.takedo.adapter?.playback().played ?? null, ctx: service?.audioContext?.currentTime ?? null,
                state: service?.audioContext?.state ?? null, cpu: engine?.cpuLoad?.getValue?.() ?? null, lag: Math.round(lag),
                frames, visible: document.visibilityState, engine: window.opendaw?.engine?.position?.() ?? null, loaded}
        }).then(sample => run.samples.push({t: Date.now(), ...sample}), () => {})
    }, 2000)
    for (const step of scenario.messages) {
        // restart_replies: agent lines to wait for after a restart (2: "picking it back up" and the reply; 1 when the
        // backend is killed after the reply, while its edits wait for their bars).
        const {restart_after_ms: restartAfter, restart_replies: restartReplies = 2} = step
        let text = step.text
        const seen = (await agentLines()).length
        const start = Date.now()
        // The user's own line (none for a control move), then at least one reply (two after a restart).
        let replies = 1
        if (step.wait_ms !== undefined) {
            await page.waitForTimeout(step.wait_ms)
            continue
        }
        if (step.set !== undefined) {
            const ok = await page.evaluate(([ref, value]) => window.takedo.adapter.setAsProducer(ref, value), [step.set, step.value])
            await page.waitForTimeout(2000)   // the page folds a gesture before reporting it
            text = `(the producer set ${step.set} to ${step.value} in openDAW${ok ? "" : ": no such parameter"})`
            run.messages.push({text, set: {ref: step.set, value: step.value, ok}, replyMs: 0, settledMs: 0, settled: true, replies: []})
            console.log(`> ${text}`)
            continue
        }
        if (step.control !== undefined) {
            const selector = step.control === "" ? "[data-testid=takedo-control]" : `[data-testid=takedo-control][data-ref="${step.control}"]`
            const found = await page.waitForSelector(selector, {timeout: 5000}).then(() => true, () => false)
            const label = found ? await page.evaluate(([selector, value]) => {
                const control = document.querySelector(selector)
                const input = control.querySelector("input")
                input.value = String(Math.round(value * 100))
                input.dispatchEvent(new Event("change"))
                return `${control.dataset.ref} (${control.firstElementChild.textContent})`
            }, [selector, step.value]) : null
            text = label === null ? `(no control to move${step.control === "" ? "" : ` ${step.control}`})` : `(moved ${label} to ${step.value})`
            if (label === null) {
                run.messages.push({text, control: true, replyMs: 0, settledMs: 0, settled: true, replies: []})
                console.log(`> ${text}`)
                continue
            }
            replies = 0
        } else {
            await page.getByTestId("takedo-input").fill(text)
            await page.getByTestId("takedo-input").press("Enter")
        }
        if (restartAfter !== undefined) {
            await sleep(restartAfter)
            writeFileSync(join(dirname(file), ".restart"), "")
            // The page reconnects to a new backend session; then "picking it back up", then the reply.
            await page.waitForFunction(old => {
                const shown = document.querySelector("[data-testid=takedo-session]")?.textContent ?? ""
                return document.querySelector("[data-testid=takedo-status]")?.dataset.status === "open" && !shown.endsWith(old)
            }, run.sessions.at(-1), {timeout: 120000})
            run.sessions.push(await sessionShown())
            console.log(`  (backend restarted ${(restartAfter / 1000).toFixed(0)} s in; session ${run.sessions.at(-1)})`)
            replies = restartReplies
        }
        await page.waitForFunction(([seen, replies]) => document.querySelectorAll("[data-testid=takedo-chat] li").length > seen + replies,
            [seen, replies], {timeout: ReplyMs}).catch(() => {})
        const replyMs = Date.now() - start
        // Replies can keep coming while the utility works; wait for its edits to land.
        const settleStart = Date.now()
        let quiet = 0
        while (step.no_settle !== true && Date.now() - settleStart < SettleMs && quiet < 3) {
            await page.waitForTimeout(1000)
            quiet = await landing() === 0 ? quiet + 1 : 0
        }
        const lines = (await agentLines()).slice(seen).filter(line => line.from !== "user")
        run.messages.push({text, ...(step.control !== undefined ? {control: true} : {}), ...(restartAfter !== undefined ? {restartAfterMs: restartAfter, restartReplies} : {}), replyMs, settledMs: Date.now() - start, settled: quiet >= 3, replies: lines})
        console.log(`> ${text}\n${lines.map(line => `  ${line.shown ?? line.from}: ${line.text}`).join("\n")}\n  (${(replyMs / 1000).toFixed(1)} s to reply, ${((Date.now() - start) / 1000).toFixed(1)} s to settle)`)
    }
    run.controls = await page.evaluate(() => [...document.querySelectorAll("[data-testid=takedo-control]")].map(control => ({
        ref: control.dataset.ref, label: control.firstElementChild.textContent, value: Number(control.querySelector("input").value) / 100})))
    run.after = await full()
    run.playing = await page.evaluate(() => window.opendaw.engine.isPlaying())
    run.clock.end = await clock()
} catch (error) {
    problems.push(`runner: ${error.message}`)
    console.error(error)
} finally {
    clearInterval(sampler)
    run.finished = new Date().toISOString()
    run.console = consoleLines
    const out = join(dirname(file), "runs", `${run.started.replace(/[:.]/g, "-")}_${name}`)
    mkdirSync(out, {recursive: true})
    writeFileSync(join(out, "run.json"), JSON.stringify(run, null, 1))
    console.log(`run written to ${out}`)
    await browser.close()
}
