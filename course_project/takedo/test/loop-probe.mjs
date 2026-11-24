// Does widening the loop while playing freeze openDAW's engine in headless Chromium (2026-11-24: four scenario runs froze
// a few seconds after the Team Lead widened a 4-bar loop to 16)? No models and no agents: a new project with a few
// tracks, the loop widened as set_loop does (from, to, enabled in one edit), then the playhead watched. Optionally the
// same with no tracks, or the loop widened by openDAW's own fields one at a time. Run via `make loop-probe`.
import {chromium} from "playwright"

const URL = process.env.URL ?? "http://localhost:8080/"
const TRACKS = Number(process.env.TRACKS ?? 3)

const browser = await chromium.launch({args: ["--autoplay-policy=no-user-gesture-required"]})
const page = await (await browser.newContext({viewport: {width: 1440, height: 900}})).newPage()
page.setDefaultTimeout(180000)

try {
    await page.goto(URL, {waitUntil: "networkidle"})
    await page.getByText("New Project", {exact: true}).click()
    await page.getByText("Add instrument").first().waitFor()
    await page.getByText("Welcome to openDAW").waitFor()
    await page.keyboard.press("Escape")
    await page.waitForFunction(() => window.takedo?.adapter !== null && window.takedo?.adapter !== undefined)
    const result = await page.evaluate(async tracks => {
        const {service} = window.takedo
        const {project} = service.projectProfileService.getValue().unwrap()
        const {loopArea} = project.timelineBox
        const bar = 3840
        for (let index = 0; index < tracks; index++) {
            window.takedo.debug.addSynth(`Probe ${index + 1}`, [[0, 48 + index * 4, 4], [4, 52 + index * 4, 4], [8, 55 + index * 4, 4]])
        }
        project.editing.modify(() => {loopArea.from.setValue(0); loopArea.to.setValue(4 * bar); loopArea.enabled.setValue(true)})
        window.opendaw.engine.play()
        const samples = []
        const sample = label => samples.push({t: Math.round(performance.now()), position: Math.round(project.engine.position.getValue()),
            ctx: Number(service.audioContext.currentTime.toFixed(2)), label})
        // Wait until the playhead is in the loop's last bar, as when the Team Lead widened it, then widen to 16 bars.
        const start = performance.now()
        while (project.engine.position.getValue() < 3 * bar + bar / 2 && performance.now() - start < 30000) {
            await new Promise(resolve => setTimeout(resolve, 20))
        }
        sample("before widening")
        project.editing.modify(() => {loopArea.from.setValue(0); loopArea.to.setValue(16 * bar); loopArea.enabled.setValue(true)})
        sample("widened to 16 bars")
        for (let second = 1; second <= 30; second++) {
            await new Promise(resolve => setTimeout(resolve, 1000))
            sample(`${second} s after`)
        }
        return samples
    }, TRACKS)
    let frozen = null
    result.forEach((sample, index) => {
        const previous = result[index - 1]
        const moved = previous === undefined ? "" : sample.position === previous.position ? "  FROZEN" : ""
        if (moved !== "" && frozen === null) {frozen = sample.label}
        console.log(`${sample.label.padEnd(20)} position ${String(sample.position).padStart(7)}  audio clock ${sample.ctx}${moved}`)
    })
    console.log(frozen === null ? "\nThe playhead kept moving after the loop was widened." : `\nThe playhead froze (first seen ${frozen}).`)
} finally {
    await browser.close()
}
