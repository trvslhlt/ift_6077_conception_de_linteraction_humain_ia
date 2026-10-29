// Smoke test: boots the studio in headless Chromium, opens a new project and checks the engine plays.
// Run via `make test`; it shares the app container's network, so the page is at localhost.
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

try {
    const response = await page.goto(URL, {waitUntil: "networkidle", timeout: 2 * TIMEOUT})
    check("page loads", response?.ok() === true, `HTTP ${response?.status()}`)
    const headers = response?.headers() ?? {}
    check("COOP header", headers["cross-origin-opener-policy"] === "same-origin")
    check("COEP header", headers["cross-origin-embedder-policy"] === "require-corp")
    check("cross-origin isolated", await page.evaluate(() => crossOriginIsolated))

    await page.getByText("New Project", {exact: true}).click()
    await page.waitForURL("**/create")
    await page.getByText("Add instrument").first().waitFor()
    check("new project opens", true)

    await page.evaluate(() => window.opendaw.engine.play())
    const start = await page.evaluate(() => window.opendaw.engine.position())
    await page.waitForTimeout(3000)
    const end = await page.evaluate(() => window.opendaw.engine.position())
    check("engine plays", await page.evaluate(() => window.opendaw.engine.isPlaying()) === true)
    check("playhead advances", end > start, `${start} -> ${end}`)
    await page.evaluate(() => window.opendaw.engine.stop())

    check("no page errors or failed requests", problems.length === 0, problems.slice(0, 5).join("; "))
} catch (error) {
    check("unexpected error", false, error.message.split("\n")[0])
} finally {
    await browser.close()
}

console.log(failures.length === 0 ? "\nsmoke test passed" : `\nsmoke test failed: ${failures.join(", ")}`)
process.exit(failures.length === 0 ? 0 : 1)
