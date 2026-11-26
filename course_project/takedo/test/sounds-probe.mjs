// The Sounds tab (page/SoundBench.tsx), driven headless: the library loads, a sound auditions on a track the agents
// don't see, a tuning knob remakes it, keep writes the producer's entry, forget clears it. Run: make sounds-probe.
import {chromium} from "playwright"
import {readFileSync} from "node:fs"
import {setTimeout as sleep} from "node:timers/promises"

const URL = process.env.URL ?? "http://localhost:8080/"
const bundle = readFileSync("/scenarios/projects/01_good_base.odb").toString("base64")
const browser = await chromium.launch({args: ["--autoplay-policy=no-user-gesture-required"]})
const page = await (await browser.newContext({viewport: {width: 1440, height: 900}})).newPage()
page.setDefaultTimeout(60000)
const errors = []
page.on("pageerror", error => errors.push(error.message))
const results = []
const check = (name, ok, detail = "") => {results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`)}
const units = () => page.evaluate(() => window.takedo.service.projectProfileService.getValue().unwrap().project.rootBoxAdapter.audioUnits.adapters()
    .map(unit => ({label: unit.label, solo: unit.namedParameter.solo.getValue(), effects: unit.audioEffects.mapOr(effects => effects.adapters().map(effect => effect.box.name), [])})))
try {
    await page.goto(URL, {waitUntil: "networkidle", timeout: 180000})
    await page.waitForFunction(() => window.takedo?.debug?.openBundle !== undefined)
    await page.evaluate(base64 => window.takedo.debug.openBundle(base64, "sounds-probe"), bundle)
    await page.waitForFunction(() => window.takedo.adapter !== null)
    if (await page.getByText("Welcome to openDAW").waitFor({timeout: 5000}).then(() => true, () => false)) {await page.keyboard.press("Escape")}
    await page.getByTestId("takedo-toggle").click()
    await page.waitForFunction(() => document.querySelector("[data-testid=takedo-status]")?.dataset.status === "open")
    await page.evaluate(() => window.opendaw.engine.play())
    await page.getByTestId("takedo-tab-sounds").click()
    await page.waitForFunction(() => document.querySelectorAll("[data-testid=takedo-sounds-list] li").length > 0)
    const shown = await page.locator("[data-testid=takedo-sounds-list] li").count()
    check("the library loads, bass sounds listed", shown >= 8, `${shown} shown`)
    const before = (await units()).length
    await page.locator("[data-testid=takedo-sounds-list] li[data-id='GeneralUser GS/Finger Bass']").click()
    await page.waitForFunction(() => /playing/.test(document.querySelector("[data-testid=takedo-sounds-message]")?.textContent ?? ""), null, {timeout: 20000})
        .catch(() => {})
    const message = await page.getByTestId("takedo-sounds-message").textContent()
    const during = await units()
    const snapshotNames = await page.evaluate(() => window.takedo.adapter.snapshot().tracks.map(track => track.name))
    check("a click auditions it on a new track", during.length === before + 1 && /playing/.test(message), `${message}; ${during.map(unit => unit.label).join(", ")}`)
    check("the agents don't see the audition track", !snapshotNames.some(name => name.startsWith("Audition")), snapshotNames.join(", "))
    await sleep(3000)
    const playing = await page.evaluate(() => window.takedo.adapter.playback().playing)
    check("playback goes on", playing)
    // A high cut and a character effect: the audition is made again with a Revamp and the chain's effect.
    await page.evaluate(() => {
        const sliders = [...document.querySelectorAll("[data-testid=takedo-sounds] input[type=range]")]
        sliders[3].value = "300"; sliders[3].dispatchEvent(new Event("change"))
        const select = [...document.querySelectorAll("[data-testid=takedo-sounds] select")].find(element => [...element.options].some(option => option.value === "chain/saturate"))
        select.value = "chain/saturate"; select.dispatchEvent(new Event("change"))
    })
    await sleep(2500)
    const tuned = (await units()).find(unit => unit.label.startsWith("Audition"))
    check("a knob remakes it with the tuning", tuned !== undefined && tuned.effects.includes("RevampDeviceBox") && tuned.effects.includes("WaveshaperDeviceBox"),
        JSON.stringify(tuned))
    await page.getByTestId("takedo-sounds").press("k")
    await sleep(1500)
    const stored = JSON.parse(readFileSync("/knowledge/sound-library.json", "utf8")).sounds["GeneralUser GS/Finger Bass"]
    check("keep writes the producer's entry with the tuning", stored?.verdict === "kept" && Array.isArray(stored.styles) && stored.tuning.tone.high_cut < 20000 && stored.tuning.effect?.chain === "chain/saturate",
        JSON.stringify(stored))
    const moved = await page.evaluate(() => document.querySelector("[data-testid=takedo-sounds] div[style*='15px']")?.textContent)
    check("keep moves on to the next sound", moved !== "GeneralUser GS/Finger Bass", moved)
    await page.locator("[data-testid=takedo-sounds-list] li[data-id='GeneralUser GS/Finger Bass']").click()
    await page.locator("[data-testid=takedo-sounds]").getByText("forget").click()
    await sleep(1500)
    const forgotten = JSON.parse(readFileSync("/knowledge/sound-library.json", "utf8")).sounds["GeneralUser GS/Finger Bass"]
    check("forget clears it", forgotten === undefined)
    // The drums section: a sample plays in a beat on a kit, its tuning on its pad; keep writes it under drums; forget clears it.
    await page.getByTestId("takedo-sounds-drums").click()
    await page.waitForFunction(() => document.querySelectorAll("[data-testid=takedo-drums-list] li").length > 0)
    check("the drums section lists snares", await page.locator("[data-testid=takedo-drums-list] li").count() >= 50)
    const drum = "AkaiMPC60/sd/Snare 2"
    await page.locator(`[data-testid=takedo-drums-list] li[data-id='${drum}']`).click()
    await page.waitForFunction(() => /playing/.test(document.querySelector("[data-testid=takedo-drums-message]")?.textContent ?? ""), null, {timeout: 20000})
        .catch(() => {})
    check("a drum sample auditions", /playing/.test(await page.getByTestId("takedo-drums-message").textContent()),
        await page.getByTestId("takedo-drums-message").textContent())
    await page.evaluate(() => {
        const sliders = [...document.querySelectorAll("[data-testid=takedo-drums] input[type=range]")]
        sliders[2].value = "0.4"; sliders[2].dispatchEvent(new Event("change"))
        sliders[4].value = "400"; sliders[4].dispatchEvent(new Event("change"))
    })
    await sleep(2500)
    const pads = await page.evaluate(() => {
        const unit = window.takedo.service.projectProfileService.getValue().unwrap().project.rootBoxAdapter.audioUnits.adapters()
            .find(adapter => adapter.label.startsWith("Audition"))
        const device = unit?.box.input.pointerHub.incoming().at(0)?.box
        return device === undefined ? null : device.samples.pointerHub.incoming().map(pointer => pointer.box).map(box => ({
            note: box.index.getValue(), volume: box.volume.getValue(), end: box.sampleEnd.getValue(), effects: box.audioEffects.pointerHub.incoming().length}))
    })
    const snarePad = pads?.find(pad => pad.note === 60)
    check("the kit has the sample and its backing, its tuning on its pad", pads !== null && pads.length >= 3 && Math.abs((snarePad?.end ?? 0) - 0.4) < 1e-6 && snarePad.effects === 1
        && pads.filter(pad => pad.note !== 60).every(pad => pad.effects === 0), JSON.stringify(pads))
    await page.getByTestId("takedo-drums").press("k")
    await sleep(1500)
    const keptDrum = JSON.parse(readFileSync("/knowledge/sound-library.json", "utf8")).drums?.[drum]
    check("keep writes the drum entry with its tuning", keptDrum?.verdict === "kept" && Array.isArray(keptDrum.styles) && keptDrum.piece === "snare" && keptDrum.tuning.length === 0.4, JSON.stringify(keptDrum))
    await page.locator(`[data-testid=takedo-drums-list] li[data-id='${drum}']`).click()
    await page.locator("[data-testid=takedo-drums]").getByText("forget").click()
    await sleep(1500)
    check("forget clears the drum entry", JSON.parse(readFileSync("/knowledge/sound-library.json", "utf8")).drums?.[drum] === undefined)
    await page.getByTestId("takedo-tab-team").click()
    await sleep(1000)
    check("leaving the tab ends the audition", !(await units()).some(unit => unit.label.startsWith("Audition")))
    check("no page errors", errors.length === 0, errors.join("; "))
} finally {
    await browser.close()
}
process.exit(results.every(Boolean) ? 0 : 1)
