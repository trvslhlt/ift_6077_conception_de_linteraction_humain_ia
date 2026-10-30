// Team view test: boots the studio in headless Chromium, opens a new project, moves the floating robot button and
// opens the team view over the DAW, then checks both directions: the team changes the project, and a change made in
// the DAW (undo) shows up in the team log.
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

const bpm = async () => Number(await page.getByTestId("team-bpm").textContent())
const logEntries = source => page.locator(`[data-testid=team-log] li[data-source=${source}]`)

try {
    // The dev server transforms modules on first request, so the first load is slow.
    const response = await page.goto(URL, {waitUntil: "networkidle", timeout: 3 * TIMEOUT})
    check("page loads", response?.ok() === true, `HTTP ${response?.status()}`)
    check("cross-origin isolated", await page.evaluate(() => crossOriginIsolated))

    await page.getByText("New Project", {exact: true}).click()
    await page.waitForURL("**/create")
    await page.getByText("Add instrument").first().waitFor()
    check("new project opens", true)

    // A fresh browser gets the "Welcome to openDAW" tour dialog, which blocks the page. Clicking "Not now" never
    // lands in headless Chromium; Escape closes it.
    await page.getByText("Welcome to openDAW").waitFor()
    await page.keyboard.press("Escape")
    await page.getByText("Welcome to openDAW").waitFor({state: "hidden"})
    // The floating robot widget (mounted by opendaw.patch) starts bottom right and moves with its corner buttons.
    const widget = page.getByTestId("team-widget")
    const viewport = page.viewportSize()
    const startBox = await widget.boundingBox()
    check("robot floats bottom right", startBox.x > viewport.width / 2 && startBox.y > viewport.height / 2)
    await page.getByTestId("team-move-top-left").click()
    const movedBox = await widget.boundingBox()
    check("robot moves to top left", movedBox.x < viewport.width / 2 && movedBox.y < viewport.height / 2)

    const workspace = await page.locator("main, .workspace, body > *").first().boundingBox()
    await page.getByTestId("team-toggle").click()
    await page.getByTestId("team-panel").waitFor()
    check("team view opens", true)
    const view = page.getByTestId("team-view")
    check("team view floats over the DAW", await view.evaluate(element => getComputedStyle(element).position) === "fixed"
        && JSON.stringify(await page.locator("main, .workspace, body > *").first().boundingBox()) === JSON.stringify(workspace))

    await page.evaluate(() => window.opendaw.engine.play())
    const before = await bpm()
    await page.getByTestId("team-tempo-up").click()
    const after = await bpm()
    check("team changes the project", after === before + 5, `${before} -> ${after} BPM`)
    check("team change is logged as team",
        (await logEntries("team").filter({hasText: "TimelineBox:bpm"}).count()) === 1)
    check("engine keeps playing", await page.evaluate(() => window.opendaw.engine.isPlaying()) === true)

    // A change made in the DAW itself: undo, via openDAW's own keyboard shortcut.
    await page.locator("body").press("ControlOrMeta+z")
    await logEntries("daw").filter({hasText: "TimelineBox:bpm"}).first().waitFor({timeout: 5000})
    check("DAW change is observed as daw", true)
    check("undo restores the tempo", (await bpm()) === before, `${await bpm()} BPM`)

    // Reading state on demand: the team view only sees the notes when it asks for them.
    const notesView = page.getByTestId("team-notes")
    await page.getByTestId("team-add-demo-clip").click()
    check("notes are not pushed", (await notesView.textContent()).startsWith("Click Read notes"))
    await page.getByTestId("team-read-notes").click()
    const notes = await notesView.textContent()
    check("reads the clip's notes on demand",
        notes.includes("4 notes") && [/C4\s+\(60\)/, /E4\s+\(64\)/, /G4\s+\(67\)/, /C5\s+\(72\)/].every(note => note.test(notes)),
        notes.split("\n")[1])
    await page.evaluate(() => window.opendaw.engine.stop())

    check("no page errors or failed requests", problems.length === 0, problems.slice(0, 5).join("; "))
} catch (error) {
    check("unexpected error", false, error.message.split("\n")[0])
} finally {
    await browser.close()
}

console.log(failures.length === 0 ? "\nteam view test passed" : `\nteam view test failed: ${failures.join(", ")}`)
process.exit(failures.length === 0 ? 0 : 1)
