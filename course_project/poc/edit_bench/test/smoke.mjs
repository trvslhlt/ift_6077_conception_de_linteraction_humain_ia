// Edit bench test: boots the studio in headless Chromium, opens a new project and the bench, and runs the checks
// from project_plan/OPENDAW.md ("Checks") through window.editBench:
//   8.   the device catalog (saved to results/catalog.json);
//   4+5. an agent editing every 250 ms while a knob is dragged (direct, append, queue), and the held signal;
//   3.   automation written during playback; 7. effects and instruments changed during playback; 10. open
//        behaviour questions; 2. lead time;
//   1.   edit rate (EDIT_RATE_SECONDS per case).
// Checks with an expected outcome PASS or FAIL; measurements are printed and saved to results/ (bind-mounted).
// Headless numbers are indicative only: run the bench from its buttons in a real browser for the figures we report.
// Run via `make test`; it shares the studio container's network, so the page is at localhost.
import {chromium} from "playwright"
import {mkdirSync, writeFileSync} from "node:fs"
import {openBench} from "./studio.mjs"

const URL = process.env.URL ?? "http://localhost:8080/"
const TIMEOUT = 60000
const EDIT_RATE_SECONDS = Number(process.env.EDIT_RATE_SECONDS ?? 3)

const failures = []
const check = (name, ok, detail = "") => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`)
    if (!ok) failures.push(name)
}
mkdirSync("results", {recursive: true})
const results = {startedAt: new Date().toISOString(), editRateSeconds: EDIT_RATE_SECONDS}

const browser = await chromium.launch({args: ["--autoplay-policy=no-user-gesture-required", "--enable-precise-memory-info"]})
const page = await browser.newPage({viewport: {width: 1440, height: 900}})
page.setDefaultTimeout(TIMEOUT)

// Some devices (WebCLAP, Soundfont, presets) fetch openDAW's online asset indexes, which the test container can't
// reach: those are listed in results.remoteAssets, not counted as problems.
const RemoteAssets = "https://assets.opendaw.studio/"
const problems = []
const remoteAssets = new Set()
const remote = url => {
    if (!url?.startsWith(RemoteAssets)) {return false}
    remoteAssets.add(url.split("?")[0])
    return true
}
page.on("pageerror", error => problems.push(`pageerror: ${error.message}`))
page.on("console", message => {
    if (message.type() === "error" && !remote(message.location().url)) {problems.push(`console: ${message.text()}`)}
})
page.on("requestfailed", request => {
    if (!remote(request.url())) {problems.push(`request failed: ${request.url()} (${request.failure()?.errorText})`)}
})
page.on("response", response => {if (response.status() >= 400) problems.push(`http ${response.status()}: ${response.url()}`)})

// Holds a knob of the newest instrument still for HOLD_MS, then drags it down (down: volume has more range below
// its default than above), then releases. Returns the held label seen before the first movement.
const HOLD_MS = 300
const dragKnob = async () => {
    const knob = await page.locator("[class*=knob]").first().boundingBox()
    const x = knob.x + knob.width / 2, y = knob.y + knob.height / 2
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.waitForTimeout(HOLD_MS)
    const heldStill = await page.getByTestId("bench-held").textContent()
    for (let step = 1; step <= 20; step++) {
        await page.mouse.move(x, y + step * 2)
        await page.waitForTimeout(100)
    }
    await page.mouse.up()
    await page.waitForTimeout(400)
    return heldStill
}

try {
    const response = await openBench(page, URL, TIMEOUT)
    check("page loads", response?.ok() === true, `HTTP ${response?.status()}`)
    check("bench opens", true)

    console.log("\n8. device catalog")
    const catalog = await page.evaluate(() => window.editBench.catalog())
    writeFileSync("results/catalog.json", JSON.stringify(catalog, null, 2))
    for (const kind of ["instrument", "midi effect", "audio effect"]) {
        const ofKind = catalog.devices.filter(device => device.kind === kind)
        console.log(`      ${kind}s (${ofKind.length}): `
            + ofKind.map(device => `${device.name} ${device.parameters.length}/${device.settings.length}`).join(", "))
    }
    const allowed = catalog.devices.filter(device => device.allowed)
    console.log(`      allowed for agents (${allowed.length}, ${allowed.reduce((sum, device) => sum + device.parameters.length, 0)} `
        + `parameters): ${allowed.map(device => device.name).join(", ")}`)
    console.log("      (parameters/settings per device; full catalog in results/catalog.json)")
    for (const failure of catalog.failures) {console.log(`      failed: ${failure.key}: ${failure.error}`)}
    check("every device can be created and read", catalog.failures.length === 0,
        catalog.failures.map(failure => failure.key).join(", "))
    check("every parameter has a name and a printable range", catalog.devices.every(device => device.parameters
        .every(parameter => parameter.name !== "" && parameter.min !== "" && parameter.max !== "")))

    console.log("\n4+5. agent edits during a knob drag, held signal")
    results.drag = {}
    for (const strategy of ["direct", "append", "queue"]) {
        await page.evaluate(name => window.editBench.startAgent(name), strategy)
        await page.waitForTimeout(400)
        const heldStill = await dragKnob()
        const heldAfter = await page.getByTestId("bench-held").textContent()
        const result = await page.evaluate(() => window.editBench.stopAgent())
        results.drag[strategy] = result
        console.log(`      ${strategy}: ${result.agentEdits} agent edits, ${result.queuedDuringDrag} queued; undo steps: `
            + `${result.agentOnly} agent only, ${result.userOnly} user only, ${result.mixed} mixed`)
        if (strategy === "direct") {
            check("held fires on a grab without movement", heldStill !== "none", heldStill)
            check("held clears on release", heldAfter === "none", heldAfter)
            check("direct: agent edits fold the drag into their undo steps", result.mixed > 0, `${result.mixed} mixed`)
        } else if (strategy === "queue") {
            check("queue: no mixed undo steps, the drag is its own step", result.mixed === 0 && result.userOnly >= 1,
                `${result.mixed} mixed, ${result.userOnly} user only`)
        }
    }
    const holds = await page.evaluate(() => window.editBench.holds())
    results.holds = holds
    check("held parameter's address matches its updates' address",
        holds.length > 0 && holds.every(hold => hold.matchingUpdates > 0),
        holds.map(hold => `${hold.label} ${hold.matchingUpdates}/${hold.updates}`).join(", "))

    console.log("\n3. automation written during playback")
    results.automation = await page.evaluate(() => window.editBench.automation())
    for (const entry of results.automation) {
        check(`${entry.name}: ${entry.expected}`, entry.followed === (entry.expected === "followed"),
            entry.samples.map(({at, value}) => `${at}:${value}`).join(" "))
    }

    console.log("\n7. effects and instruments changed during playback")
    const devices = await page.evaluate(() => window.editBench.devices())
    results.devices = devices
    console.log(`      baseline: ${devices.baseline.gaps} gaps (longest ${devices.baseline.longestGapMs} ms); `
        + `${devices.unobservedMs} ms of output unobserved`)
    console.log("      edit                              modify ms  heard ms  gaps  longest ms  overruns")
    for (const row of devices.effects) {
        console.log(`      ${row.name.padEnd(33)} ${String(row.modifyMs).padEnd(10)} ${String(row.msToHeard ?? "-").padEnd(9)} `
            + `${String(row.gaps).padEnd(5)} ${String(row.longestGapMs).padEnd(11)} ${row.overruns}/${row.blocks}`)
    }
    console.log("      swap to        modify ms  next note ms  silent from ms  sound from ms  overruns")
    for (const row of devices.swaps) {
        console.log(`      ${row.to.padEnd(14)} ${String(row.modifyMs).padEnd(10)} ${String(row.msToNextNote).padEnd(13)} `
            + `${String(row.msToSilence ?? "-").padEnd(15)} ${String(row.msToSound ?? "never").padEnd(14)} ${row.overruns}/${row.blocks}`)
    }
    for (const change of devices.changes) {
        console.log(`      change by ${change.method}: ${change.gaps} gaps (longest ${change.longestGapMs} ms), deepest dip `
            + `${change.dipDb} dB (between notes: ${change.normalDipDb} dB), new heard ${change.newHeard}`
            + (change.oldNoteAfter50Ms === null ? "" : `, old note on after 50 ms ${change.oldNoteAfter50Ms}, after 300 ms ${change.oldNoteAfter300Ms}`))
        for (const step of change.steps) {
            console.log(`        ${step.name.padEnd(48)} modify ${String(step.modifyMs).padEnd(6)} ms  gap ${String(step.gapMs).padEnd(6)} ms  overruns ${step.overruns}/${step.blocks}`)
        }
    }
    check("prewrapped layers and new track change the instrument without a gap",
        devices.changes.filter(change => ["layers, prewrapped", "new track"].includes(change.method))
            .every(change => change.gaps === 0 && change.newHeard),
        devices.changes.map(change => `${change.method}: ${change.gaps} gaps`).join(", "))
    for (const lane of devices.lanes) {console.log(`      lane, ${lane.name}: kept ${lane.laneKept}, undo restores ${lane.undoRestores}`)}
    const level = devices.effects.filter(row => row.name.includes("Stereo Tool"))
    check("inserted and removed effects are heard within 1 s", level.every(row => row.msToHeard !== null),
        level.map(row => `${row.name}: ${row.msToHeard} ms`).join(", "))
    check("every swapped instrument sounds within 1.5 s", devices.swaps.every(row => row.msToSound !== null),
        devices.swaps.filter(row => row.msToSound === null).map(row => row.to).join(", "))
    check("one undo restores a device and its lane", devices.lanes.every(lane => lane.undoRestores))

    console.log("\n10. open questions")
    const questions = await page.evaluate(() => window.editBench.questions())
    results.questions = questions
    const rec = questions.recording
    console.log(`      recording: automation recording on by default ${rec.automationEnabledByDefault}; adapter writes -> `
        + `${rec.adapterWrites.regions} region(s), ${rec.adapterWrites.events} points; field writes -> lane ${rec.fieldWrites.lane}`)
    console.log(`      recording over an agent lane: before ${rec.overLane.before.join(", ")}; after ${rec.overLane.after.join(", ")}`)
    console.log(`      timeline end (${questions.timelineEnd.endBar}): playing after ${questions.timelineEnd.playingAfter}, at ${questions.timelineEnd.positionAfter}`)
    for (const row of questions.loopBoundary) {console.log(`      note ${row.note}: heard ${row.heard}`)}
    for (const row of questions.samplers) {console.log(`      ${row.device}: sound after ${row.msToSound ?? "never"} ms, ${row.gaps} gaps (longest ${row.longestGapMs} ms)`)}
    check("open questions ran", true)

    console.log("\n2. lead time (ms ahead of engine.position as the main thread sees it)")
    const lead = await page.evaluate(() => window.editBench.leadTime())
    results.leadTime = lead
    console.log(`      sounding notes are reported at the ${lead.noteAddress} address`)
    for (const {kind, byLead, minReliableMs} of lead.summary) {
        console.log(`      ${kind.padEnd(6)} ${byLead.map(({leadMs, heard, trials}) => `${leadMs}:${heard}/${trials}`).join(" ")}`)
        check(`${kind}: heard reliably at some lead <= 300 ms`, minReliableMs !== null, `from ${minReliableMs} ms`)
    }

    console.log(`\n1. edit rate (${EDIT_RATE_SECONDS} s per case)`)
    results.editRate = await page.evaluate(seconds => window.editBench.editRate(seconds), EDIT_RATE_SECONDS)
    console.log("      load                         /s     modify mean/p95/max ms   overruns   long tasks  heap MB")
    for (const row of results.editRate) {
        console.log(`      ${row.load.padEnd(28)} ${String(row.perSecond).padStart(5)}   `
            + `${`${row.modifyMs.mean}/${row.modifyMs.p95}/${row.modifyMs.max}`.padEnd(24)} `
            + `${`${row.overruns}/${row.blocks}`.padEnd(10)} ${String(row.longTasks).padEnd(11)} ${row.heapDeltaMb ?? "n/a"}`)
    }
    check("edit rate ran every case", results.editRate.length === 9)

    check("no page errors or failed requests", problems.length === 0, problems.slice(0, 5).join("; "))
} catch (error) {
    check("unexpected error", false, error.message.split("\n")[0])
} finally {
    await browser.close()
}

results.failures = failures
results.problems = problems
results.remoteAssets = [...remoteAssets]
console.log(`\nremote asset indexes requested (unreachable here): ${results.remoteAssets.join(", ") || "none"}`)
const file = `results/headless-${results.startedAt.replace(/[:.]/g, "-")}.json`
writeFileSync(file, JSON.stringify(results, null, 2))
console.log(`\nresults saved to ${file}`)
console.log(failures.length === 0 ? "edit bench test passed" : `edit bench test failed: ${failures.join(", ")}`)
process.exit(failures.length === 0 ? 0 : 1)
