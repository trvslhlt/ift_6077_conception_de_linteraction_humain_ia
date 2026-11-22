// A scenario: a fixed project and a fixed list of producer messages, played to TakeDo in headless Chromium while the
// project plays. Records the project before and after (notes included), each message's replies and how long its edits
// took to land, and the backend's session id; `make scenario` then writes the report from that and the session log.
// Run via `make scenario SCENARIO=<name>` (scenarios/<name>.json); shares the studio container's network like smoke.mjs.
import {chromium} from "playwright"
import {mkdirSync, readFileSync, writeFileSync} from "node:fs"
import {basename, dirname, join} from "node:path"

const URL = process.env.URL ?? "http://localhost:8080/"
const [file] = process.argv.slice(2)
if (file === undefined) {throw new Error("usage: node scenario.mjs <scenario.json>")}
const scenario = JSON.parse(readFileSync(file, "utf8"))
const name = basename(file, ".json")
const bundle = readFileSync(join(dirname(file), "projects", scenario.project)).toString("base64")
// An edit is still landing while its row says so; a message is settled when none is, or after this long.
const SettleMs = scenario.settle_ms ?? 150000
const ReplyMs = scenario.reply_ms ?? 240000

const browser = await chromium.launch({args: ["--autoplay-policy=no-user-gesture-required"]})
const page = await (await browser.newContext({viewport: {width: 1440, height: 900}})).newPage()
page.setDefaultTimeout(60000)
const problems = []
page.on("pageerror", error => problems.push(`pageerror: ${error.message}`))

const agentLines = () => page.evaluate(() => [...document.querySelectorAll("[data-testid=takedo-chat] li")]
    .map(line => ({from: line.dataset.from, shown: line.dataset.shown, text: line.lastElementChild?.textContent ?? ""})))
const full = () => page.evaluate(() => window.takedo.adapter.snapshot("full"))
const landing = () => page.evaluate(() => document.querySelectorAll(
    "[data-testid=takedo-activity] li[data-state=scheduled], [data-testid=takedo-activity] li[data-state=running], [data-testid=takedo-activity] li[data-state=queued]").length)

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
    run.session = (await page.getByTestId("takedo-session").textContent()).replace("session ", "")
    run.before = await full()
    await page.evaluate(() => window.opendaw.engine.play())
    for (const {text} of scenario.messages) {
        const seen = (await agentLines()).length
        const start = Date.now()
        await page.getByTestId("takedo-input").fill(text)
        await page.getByTestId("takedo-input").press("Enter")
        // The user's own line, then at least one reply.
        await page.waitForFunction(seen => document.querySelectorAll("[data-testid=takedo-chat] li").length > seen + 1,
            seen, {timeout: ReplyMs}).catch(() => {})
        const replyMs = Date.now() - start
        // Replies can keep coming while the utility works; wait for its edits to land.
        const settleStart = Date.now()
        let quiet = 0
        while (Date.now() - settleStart < SettleMs && quiet < 3) {
            await page.waitForTimeout(1000)
            quiet = await landing() === 0 ? quiet + 1 : 0
        }
        const lines = (await agentLines()).slice(seen).filter(line => line.from !== "user")
        run.messages.push({text, replyMs, settledMs: Date.now() - start, settled: quiet >= 3, replies: lines})
        console.log(`> ${text}\n${lines.map(line => `  ${line.shown ?? line.from}: ${line.text}`).join("\n")}\n  (${(replyMs / 1000).toFixed(1)} s to reply, ${((Date.now() - start) / 1000).toFixed(1)} s to settle)`)
    }
    run.after = await full()
    run.playing = await page.evaluate(() => window.opendaw.engine.isPlaying())
} catch (error) {
    problems.push(`runner: ${error.message}`)
    console.error(error)
} finally {
    run.finished = new Date().toISOString()
    const out = join(dirname(file), "runs", `${run.started.replace(/[:.]/g, "-")}_${name}`)
    mkdirSync(out, {recursive: true})
    writeFileSync(join(out, "run.json"), JSON.stringify(run, null, 1))
    console.log(`run written to ${out}`)
    await browser.close()
}
