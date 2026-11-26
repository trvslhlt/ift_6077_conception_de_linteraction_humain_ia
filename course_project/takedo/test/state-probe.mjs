// The engine's state channel (page/EngineState.ts): does the playhead survive what we think stalls it? No models.
// A) a playhead subscriber throws once inside the engine state's read (before the wrap: the flag stuck at "reading",
// the playhead frozen for good); B) the flag is left at "reading" by hand: the watchdog should hand it back within a
// few seconds. Run via `make state-probe`.
import {chromium} from "playwright"

const URL = process.env.URL ?? "http://localhost:8080/"
const browser = await chromium.launch({args: ["--autoplay-policy=no-user-gesture-required"]})
const page = await (await browser.newContext({viewport: {width: 1440, height: 900}})).newPage()
page.setDefaultTimeout(180000)
let failed = false
try {
    await page.goto(URL, {waitUntil: "networkidle"})
    await page.getByText("New Project", {exact: true}).click()
    await page.getByText("Add instrument").first().waitFor()
    await page.getByText("Welcome to openDAW").waitFor()
    await page.keyboard.press("Escape")
    await page.waitForFunction(() => window.takedo?.adapter !== null && window.takedo?.adapter !== undefined)
    const result = await page.evaluate(async () => {
        const {service, debug} = window.takedo
        const {project} = service.projectProfileService.getValue().unwrap()
        debug.addSynth("Probe", [[0, 48, 4], [4, 52, 4], [8, 55, 4]])
        window.opendaw.engine.play()
        const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
        const watch = async (seconds, label) => {
            const rows = []
            for (let second = 1; second <= seconds; second++) {
                const before = project.engine.position.getValue()
                await wait(1000)
                rows.push({label: `${label} ${second} s`, moved: project.engine.position.getValue() !== before, channel: debug.engineState.channel()})
            }
            return rows
        }
        await wait(2000)
        const subscription = project.engine.position.subscribe(() => {subscription.terminate(); throw new Error("state-probe: a subscriber throws")})
        const thrown = await watch(5, "A, after a subscriber threw")
        debug.engineState.stick()
        const stuck = await watch(10, "B, after the flag was left at reading")
        return {thrown, stuck}
    })
    for (const row of [...result.thrown, ...result.stuck]) {console.log(`${row.label.padEnd(42)} ${row.moved ? "moving" : "FROZEN"}  channel ${row.channel}`)}
    const a = result.thrown.slice(1).every(row => row.moved)
    const b = result.stuck.slice(-3).every(row => row.moved)
    console.log(`\nA: ${a ? "the playhead kept moving after the throw" : "the playhead froze after the throw"}`)
    console.log(`B: ${b ? "the watchdog handed the flag back and the playhead moves again" : "the playhead stayed frozen"}`)
    failed = !a || !b
} finally {
    await browser.close()
}
process.exit(failed ? 1 : 0)
