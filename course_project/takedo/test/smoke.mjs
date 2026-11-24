// TakeDo smoke test: boots the studio in headless Chromium, opens a new project and the team view, and checks the
// page reaches the backend (welcome, ping, reconnecting), the Team Lead's overview, one message through the captain
// and a worker, and the page's own guarantees for edits (sent straight to it, no model).
// Run via `make test`; it shares the studio container's network, so the page is at localhost.
import {readFileSync} from "node:fs"
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
        const box = testid => document.querySelector(`[data-testid=${testid}]`).getBoundingClientRect()
        const [activity, team, chat] = ["takedo-column-activity", "takedo-column-team", "takedo-column-chat"].map(box)
        return {view: view.width / innerWidth, tall: view.height / innerHeight,
            ordered: activity.right <= team.left && team.right <= chat.left,
            widths: [activity, team, chat].map(column => column.width / view.width)}
    })
    check("team view fills the window: activity, team and chat in three columns",
        layout.view > 0.9 && layout.tall > 0.7 && layout.ordered && layout.widths.every(width => width > 0.25),
        `view ${Math.round(layout.view * 100)}% × ${Math.round(layout.tall * 100)}%, columns ${layout.widths.map(width => `${Math.round(width * 100)}%`).join(" / ")}`)

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

    // ---------- one message through the team: chat → captain → a worker → claim → ramp in the page → reply ----------
    const volume = name => page.evaluate(name =>
        window.takedo.adapter.snapshot().tracks.find(track => track.name === name).mix.volume, name)
    const agentLines = (agent = "team_lead") => page.locator(`[data-testid=takedo-chat] li[data-from="agent:${agent}"]`)
    const track = name => page.evaluate(name => window.takedo.adapter.snapshot().tracks.find(track => track.name === name), name)
    await page.evaluate(() => window.opendaw.engine.play())
    const drumsBefore = await volume("Drums")
    const before = await agentLines().count()
    const start = Date.now()
    await page.getByTestId("takedo-input").fill("the drums are too loud")
    await page.getByTestId("takedo-input").press("Enter")
    await page.waitForFunction(count => document.querySelectorAll('[data-testid=takedo-chat] li[data-from="agent:team_lead"]').length > count,
        before, {timeout: 60000})
    const reply = await agentLines().last().textContent()
    // The captain replies as it hands the piece out; the worker's edit lands after.
    await page.waitForFunction(before => window.takedo.adapter.snapshot().tracks.find(track => track.name === "Drums").mix.volume < before - 0.5,
        drumsBefore, {timeout: 120000}).catch(() => {})
    const drumsAfter = await volume("Drums")
    check("a message through the Team Lead: drums turned down during playback", drumsAfter < drumsBefore - 0.5,
        `${drumsBefore} → ${drumsAfter.toFixed(1)} dB in ${Date.now() - start} ms: "${reply}"`)
    check("engine kept playing", await page.evaluate(() => window.opendaw.engine.isPlaying()))
    const speakers = await page.evaluate(() => [...new Set([...document.querySelectorAll("[data-testid=takedo-chat] li")]
        .map(line => line.dataset.from).filter(from => from !== "user"))])
    check("only the Team Lead speaks in the chat", speakers.every(from => from === "agent:team_lead"), speakers.join(", "))

    // ---------- the page's guarantees, sent straight to it (no model) ----------
    // An edit as a worker sends it; resolves with its last status (applied, dropped or failed).
    const apply = (plan, when = {at: "asap"}) => page.evaluate(([plan, when]) => new Promise(resolve => {
        const {adapter} = window.takedo
        const id = crypto.randomUUID()
        const subscription = adapter.subscribeActivity(({request, status}) => {
            if (request.id !== id || !["applied", "dropped", "failed"].includes(status.state)) {return}
            subscription.terminate()
            resolve(status)
        })
        adapter.apply({id, from: "agent:utility", plan, when, seq: adapter.snapshot().at.seq})
        setTimeout(() => {subscription.terminate(); resolve({state: "timeout"})}, 30000)
    }), [plan, when])
    const ref = name => page.evaluate(name => window.takedo.adapter.snapshot().tracks.find(track => track.name === name).ref, name)
    const [drums, keys] = [await ref("Drums"), await ref("Keys")]

    // One undo step for a whole ramp. openDAW's shortcut needs focus outside the chat input.
    const rampBefore = await volume("Drums")
    const ramped = await apply({op: "ramp", ref: `${drums}.mix.volume`, to: rampBefore - 6, beats: 2})
    await page.waitForTimeout(1500)
    const rampAfter = await volume("Drums")
    await page.locator("body").click({position: {x: 400, y: 300}})
    await page.locator("body").press("ControlOrMeta+z")
    await page.waitForTimeout(200)
    const undone = await volume("Drums")
    check("one undo restores a whole ramp", ramped.state === "applied" && rampAfter < rampBefore - 3 && Math.abs(undone - rampBefore) < 0.05,
        `${rampBefore} → ${rampAfter.toFixed(1)} → ${undone.toFixed(1)} dB`)

    // The producer holds the Drums fader: an edit on it is dropped, and so is a script that touches it.
    await page.evaluate(() => {
        const project = window.takedo.service.projectProfileService.getValue().unwrap().project
        const unit = project.rootBoxAdapter.audioUnits.adapters().find(unit => unit.label === "Drums")
        window.__drumsVolume = unit.namedParameter.volume
        document.dispatchEvent(new CustomEvent("parameter-hold", {detail: {parameter: window.__drumsVolume, held: true}}))
    })
    const heldBefore = await volume("Drums")
    const held = await apply({op: "set", ref: `${drums}.mix.volume`, to: heldBefore - 3})
    check("held fader: an edit on it is dropped", held.state === "dropped" && held.reason === "held" && await volume("Drums") === heldBefore,
        JSON.stringify(held))
    const heldScript = await apply({op: "script", description: "drums to -20 by script", code: `
        const unit = project.rootBoxAdapter.audioUnits.adapters().find(unit => unit.label === "Drums")
        unit.box.volume.setValue(-20)`})
    check("held fader: a script touching it is undone", heldScript.state === "dropped" && await volume("Drums") === heldBefore,
        `${heldScript.state}: ${heldScript.detail ?? ""}`)
    await page.evaluate(() =>
        document.dispatchEvent(new CustomEvent("parameter-hold", {detail: {parameter: window.__drumsVolume, held: false}})))

    // ---------- recording: openDAW records the agents' live value changes as automation by itself ----------
    await page.evaluate(async () => {
        const project = window.takedo.service.projectProfileService.getValue().unwrap().project
        project.startRecording(false)
        // openDAW reads the engine's state on animation frames; if they stop, this never turns (the stall), so give up.
        const deadline = Date.now() + 10000
        while (!project.engine.isRecording.getValue()) {
            if (Date.now() > deadline) {throw new Error("recording never started: the engine's state stopped updating (playhead frozen?)")}
            await new Promise(resolve => setTimeout(resolve, 20))
        }
    })
    const recorded = await apply({op: "ramp", ref: `${keys}.mix.volume`, to: (await volume("Keys")) - 4, beats: 2})
    await page.waitForTimeout(1500)
    await page.evaluate(async () => {
        const project = window.takedo.service.projectProfileService.getValue().unwrap().project
        project.stopRecording()
        const deadline = Date.now() + 10000
        while (project.engine.isRecording.getValue()) {
            if (Date.now() > deadline) {throw new Error("recording never stopped: the engine's state stopped updating (playhead frozen?)")}
            await new Promise(resolve => setTimeout(resolve, 20))
        }
        if (!project.engine.isPlaying.getValue()) {window.opendaw.engine.play()}
    })
    const keysLanes = (await track("Keys")).lanes
    check("while recording, an agent's change is recorded as automation", recorded.state === "applied" && keysLanes.length === 1,
        `lanes ${JSON.stringify(keysLanes)}`)
    const afterTake = await apply({op: "ramp", ref: `${keys}.mix.volume`, to: 0, beats: 2})
    check("after the take, its lane is left alone (no live write over automation)",
        afterTake.state === "failed" && /automation/.test(afterTake.detail ?? ""), JSON.stringify(afterTake))

    // ---------- mentions: autocomplete from the team, styled in the input ----------
    await page.getByTestId("takedo-input").fill("")
    await page.getByTestId("takedo-input").pressSequentially("@")
    const options = await page.getByTestId("takedo-mention-option").evaluateAll(items => items.map(item => item.dataset.role))
    check("@ lists the Team Lead, without the utility", options.includes("team_lead") && !options.includes("utility"), options.join(", "))
    await page.getByTestId("takedo-input").pressSequentially("te")
    await page.getByTestId("takedo-input").press("Tab")
    const completed = await page.getByTestId("takedo-input").inputValue()
    check("autocomplete completes a mention", completed === "@team_lead ", `"${completed}"`)
    check("mention styled while typing", await page.locator("[data-testid=takedo-mention][data-role=team_lead]").count() === 1)
    await page.getByTestId("takedo-input").fill("")

    // ---------- the open path: an effect by fixed operation, a track by script, faded in by a ramp ----------
    const reverbed = await apply({op: "add_effect", track: keys, device: "DattorroReverb", factory: "DattorroReverb", settings: []})
    const keysEffects = (await track("Keys")).effects
    check("add_effect: a reverb on the keys", reverbed.state === "applied" && keysEffects.some(effect => effect.key === "DattorroReverb"),
        `${reverbed.state}: ${keysEffects.map(effect => effect.key).join(", ") || "none"}`)
    const made = await apply({op: "script", description: "a Lead track at -30 dB", code: `
        const made = api.createInstrument(lib.adapters.InstrumentFactories.Vaporisateur)
        made.instrumentBox.label.setValue("Lead"); made.audioUnitBox.volume.setValue(-30)
        const region = api.createNoteRegion({trackBox: made.trackBox, position: 0, duration: bar, name: "Lead"})
        api.createNoteEvent({owner: region, position: 0, duration: 960, pitch: 72, velocity: 0.6})`})
    const leadRef = made.state === "applied" ? await ref("Lead") : null
    const faded = leadRef === null ? {state: "no track"} : await apply({op: "ramp", ref: `${leadRef}.mix.volume`, to: 0, beats: 4})
    await page.waitForTimeout(2500)
    const lead = await track("Lead")
    check("a scripted track, faded in by a fixed operation", lead !== undefined && faded.state === "applied" && lead.mix.volume > -1,
        `${lead === undefined ? `no Lead track (${made.state}: ${made.detail ?? ""})` : `Lead at ${lead.mix.volume.toFixed(1)} dB`}`)

    // A sidechain by the knowledge base's page helper, sent as the backend sends chain/sidechain-duck: the keys keyed from
    // the drums. Checked by where the compressor's side-chain input points, read back from the project.
    const kbScript = readFileSync("/knowledge-scripts/kb.js", "utf8")
    const ducked = await apply({op: "script", description: "keys duck under the drums",
        code: `const args = ${JSON.stringify({track: keys, source: drums, threshold: -30, ratio: 6, attack: 1, release: 120})};\n${kbScript}\nreturn kb.sidechain(args)`})
    const wired = await apply({op: "script", description: "read the keys' sidechain", code: `
        const compressor = ref("${keys}").box.audioEffects.pointerHub.incoming().map(pointer => pointer.box).find(box => box.sideChain !== undefined)
        if (compressor === undefined) {return "no compressor"}
        return {keyedFromDrums: compressor.sideChain.targetVertex.mapOr(vertex => vertex.box === ref("${drums}").box, false),
            automakeup: compressor.automakeup.getValue(), threshold: compressor.threshold.getValue()}`})
    const wiring = typeof wired.result?.value === "string" ? wired.result.value : JSON.stringify(wired.result?.value ?? wired.detail ?? "")
    check("a sidechain from the knowledge base: the keys' compressor keyed from the drums",
        ducked.state === "applied" && /"keyedFromDrums":true/.test(wiring) && /"automakeup":false/.test(wiring),
        `${ducked.state}${ducked.detail ? ` (${ducked.detail})` : ""}: ${wiring}`)

    // The transport is the producer's (decided 2026-11-24): a script that stops playback or moves the playhead is refused
    // and rolled back, and so is a loop that would leave the playhead outside it.
    const stopped = await apply({op: "script", description: "stop playback", code: `project.engine.stop(true)`})
    const jumped = await apply({op: "script", description: "move the playhead", code: `project.engine.setPosition(0)`})
    const away = await apply({op: "script", description: "loop far from the playhead", code: `
        const {loopArea} = project.timelineBox
        loopArea.enabled.setValue(true); loopArea.from.setValue(ppqn("90.1.1")); loopArea.to.setValue(ppqn("94.1.1"))`})
    const loopNow = await page.evaluate(() => window.takedo.adapter.snapshot().playback.loop)
    const playingNow = await page.evaluate(() => window.opendaw.engine.isPlaying())
    check("agents can't stop playback, move the playhead or loop away from it",
        stopped.state === "failed" && jumped.state === "failed" && away.state === "failed" && playingNow && loopNow.from !== "90.1.1",
        JSON.stringify({stopped: stopped.detail, jumped: jumped.detail, away: away.detail, playingNow, loopNow}))

    // Landing in a loop, sent straight to the page (no model): on the loop's start, which the playhead only reaches by
    // wrapping, and past the loop's end, which counts bars of playing.
    const landed = await page.evaluate(async () => {
        const {adapter, service} = window.takedo
        const {project} = service.projectProfileService.getValue().unwrap()
        const {loopArea} = project.timelineBox
        const bar = 3840
        const saved = [loopArea.enabled.getValue(), loopArea.from.getValue(), loopArea.to.getValue()]
        project.editing.modify(() => {loopArea.enabled.setValue(true); loopArea.from.setValue(0); loopArea.to.setValue(2 * bar)})
        window.opendaw.engine.play()
        project.engine.setPosition(bar / 2)                 // in the loop's first bar, as when it's been playing a while
        await new Promise(resolve => setTimeout(resolve, 300))
        const pad = adapter.snapshot().tracks.find(track => track.name === "Pad").ref   // Keys has a lane from the take
        const send = (bar, to) => new Promise(resolve => {
            const id = crypto.randomUUID()
            const start = performance.now()
            const states = []
            const subscription = adapter.subscribeActivity(({request, status}) => {
                if (request.id !== id) {return}
                states.push([status.state, status.landsAt, status.detail].filter(Boolean).join(" "))
                if (["applied", "dropped", "failed"].includes(status.state)) {
                    subscription.terminate()
                    resolve({state: status.state, ms: Math.round(performance.now() - start), states})
                }
            })
            adapter.apply({id, from: "agent:utility", plan: {op: "set", ref: `${pad}.mix.volume`, to},
                when: {at: "bar", bar}, seq: Number.MAX_SAFE_INTEGER})
            setTimeout(() => {subscription.terminate(); resolve({state: "timeout", states})}, 20000)
        })
        const results = await Promise.all([send(1, -1), send(5, -2)])
        project.editing.modify(() => {loopArea.enabled.setValue(saved[0]); loopArea.from.setValue(saved[1]); loopArea.to.setValue(saved[2])})
        return results
    })
    check("in a loop, an edit on the loop's start lands as it wraps", landed[0].state === "applied", JSON.stringify(landed[0]))
    check("in a loop, an edit past its end lands after that many bars of playing",
        landed[1].state === "applied" && landed[1].ms > landed[0].ms, JSON.stringify(landed[1]))
    const activityRows = await page.locator("[data-testid='takedo-activity'] li[data-agent='agent:utility']").count()
    check("the activity lists the agents' edits and where they are", activityRows > 0, `${activityRows} rows`)

    // A script writing values outside openDAW's ranges (resonance 0 made a Vaporisateur write NaN and crashed the
    // engine, 2026-11-07) gets them corrected inside its edit, and the engine keeps playing.
    const guarded = await page.evaluate(() => new Promise(resolve => {
        const {adapter} = window.takedo
        const id = crypto.randomUUID()
        const subscription = adapter.subscribeActivity(({request, status}) => {
            if (request.id !== id || !["applied", "failed", "dropped"].includes(status.state)) {return}
            subscription.terminate()
            resolve(status)
        })
        const code = `const made = api.createInstrument(lib.adapters.InstrumentFactories.Vaporisateur)
            made.instrumentBox.label.setValue("Guarded"); made.audioUnitBox.volume.setValue(-60)
            made.instrumentBox.resonance.setValue(0); made.instrumentBox.unisonCount.setValue(2)
            made.instrumentBox.cutoff.setValue(NaN)
            const region = api.createNoteRegion({trackBox: made.trackBox, position: 0, duration: bar, name: "Guarded"})
            api.createNoteEvent({owner: region, position: 0, duration: 960, pitch: 60, velocity: 0.5})`
        adapter.apply({id, from: "agent:utility", plan: {op: "script", code, description: "out-of-range synth"}, when: {at: "asap"},
            seq: adapter.snapshot().at.seq})
    }))
    await page.waitForTimeout(1500)
    const stillPlaying = await page.evaluate(() => window.takedo.service.engine.isPlaying.getValue())
    check("out-of-range values in a script are corrected, engine keeps playing",
        guarded.state === "applied" && (guarded.result?.corrected?.length ?? 0) === 3 && stillPlaying,
        JSON.stringify(guarded.result?.corrected ?? guarded))

    // Tempo automation written in normalized values, not BPM (the script from a 2026-11-23 run, which set the tempo to
    // 0.33 BPM: the playhead all but stopped for 6 minutes). Refused and rolled back; the playhead keeps its speed.
    const tempoScript = await page.evaluate(() => new Promise(resolve => {
        const {adapter} = window.takedo
        const id = crypto.randomUUID()
        const subscription = adapter.subscribeActivity(({request, status}) => {
            if (request.id !== id || !["applied", "failed", "dropped"].includes(status.state)) {return}
            subscription.terminate()
            resolve(status)
        })
        const code = `const coll = project.timelineBox.tempoTrack.events.targetVertex.unwrap().box;
            const adapter = project.boxAdapters.adapterFor(coll, lib.adapters.ValueEventCollectionBoxAdapter);
            const norm = b => (b - 60) / 180;
            adapter.createEvent({position: 0, index: 0, value: norm(119), interpolation: {type: "linear"}});
            adapter.createEvent({position: 16 * bar, index: 0, value: norm(82), interpolation: {type: "none"}});
            return "ok";`
        adapter.apply({id, from: "agent:utility", plan: {op: "script", code, description: "normalized tempo"}, when: {at: "asap"},
            seq: adapter.snapshot().at.seq})
    }))
    const pulsesPerSecond = await page.evaluate(async () => {
        const before = window.takedo.adapter.playback().played, start = performance.now()
        await new Promise(resolve => setTimeout(resolve, 2000))
        return (window.takedo.adapter.playback().played - before) / ((performance.now() - start) / 1000)
    })
    const bpm = await page.evaluate(() => window.takedo.adapter.snapshot().timeline.bpm)
    check("tempo events outside openDAW's BPM range are refused, playhead keeps its speed",
        tempoScript.state === "failed" && /tempo events are in BPM/.test(tempoScript.detail ?? "") && pulsesPerSecond > bpm * 16 * 0.8,
        `${tempoScript.state}: ${tempoScript.detail ?? ""}; ${Math.round(pulsesPerSecond)} pulses/s at ${bpm} BPM`)

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
        await apply({op: "ramp", ref: `${keys}.mix.volume`, to: before - 3, beats: 1})
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

    // A crash on purpose, last (it logs errors): with the guard off, a script gives a playing synth resonance 0, which
    // makes it write NaN, and openDAW's engine stops and offers to restart. On the restart the script, still the latest
    // undo step, is undone first, so the new engine doesn't crash again, and the Team Lead says so.
    await page.evaluate(() => window.opendaw.engine.play())
    await page.evaluate(() => {
        const {adapter} = window.takedo
        adapter.guarding = false
        const code = `const made = api.createInstrument(lib.adapters.InstrumentFactories.Vaporisateur)
            made.instrumentBox.label.setValue("Crash"); made.audioUnitBox.volume.setValue(-30)
            made.instrumentBox.resonance.setValue(0)
            const region = api.createNoteRegion({trackBox: made.trackBox, position: 0, duration: 64 * bar, loopDuration: bar, name: "Crash"})
            for (let beat = 0; beat < 4; beat++) api.createNoteEvent({owner: region, position: beat * 960, duration: 480, pitch: 60, velocity: 0.8})`
        adapter.apply({id: crypto.randomUUID(), from: "agent:utility", plan: {op: "script", code, description: "crash on purpose"},
            when: {at: "asap"}, seq: adapter.snapshot().at.seq})
    })
    const restart = page.getByText("Restart Engine")
    const crashed = await restart.waitFor({timeout: 15000}).then(() => true, () => false)
    await page.evaluate(() => {window.takedo.adapter.guarding = true})
    // Pressed in the page: Playwright's click on the label timed out (2026-11-07).
    if (crashed) {
        await page.evaluate(() => {   // openDAW's buttons are an <input type="button"> named by a <label for>
            const label = [...document.querySelectorAll("label")].find(label => /Restart Engine/.test(label.textContent ?? ""))
            document.getElementById(label?.htmlFor ?? "")?.click()
        })
    }
    const told = await page.waitForFunction(() => [...document.querySelectorAll("[data-testid=takedo-chat] li")]
        .some(line => /audio engine crashed/i.test(line.textContent ?? "")), null, {timeout: 15000}).then(() => true, () => false)
    await page.waitForTimeout(2000)
    const crashTrack = await page.evaluate(() => window.takedo.adapter.snapshot().tracks.some(track => track.name === "Crash"))
    await page.evaluate(() => window.opendaw.engine.play())
    const startPos = await page.evaluate(() => window.opendaw.engine.position())
    await page.waitForTimeout(3000)
    const moved = await page.evaluate(start => window.opendaw.engine.position() !== start, startPos)
    const crashedAgain = await restart.isVisible()
    check("an engine crash from an agent's script: undone on restart, the producer told, no second crash",
        crashed && told && !crashTrack && moved && !crashedAgain,
        JSON.stringify({crashed, told, crashTrackLeft: crashTrack, playingAfter: moved, crashedAgain}))
    await page.evaluate(() => window.opendaw.engine.stop())
} catch (error) {
    check("unexpected error", false, error.message.split("\n")[0])
} finally {
    await browser.close()
}

console.log(failures.length === 0 ? "\nTakeDo smoke test passed" : `\nTakeDo smoke test failed: ${failures.join(", ")}`)
process.exit(failures.length === 0 ? 0 : 1)
