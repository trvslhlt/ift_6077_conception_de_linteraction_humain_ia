// Does a recorded jam with the loop off keep going past the song's end (2026-11-24: jam runs stopped at bar 17-22 with the
// audio clock still running)? No models: a new project with a few 8-bar tracks, the timeline cut to 8 bars, loop off,
// recording on, then position, timeline length, the parts' end and the engine's flags watched each second. Run via
// `make jam-probe`.
import {chromium} from "playwright"
import {readFileSync} from "node:fs"
import probeEffects from "./probe-effects.mjs"

const URL = process.env.URL ?? "http://localhost:8080/"
const SECONDS = Number(process.env.SECONDS ?? 40)
// PROJECT=01_good_base.odb opens that scenario project instead (as `make scenario` does): played first, then loop off and record.
const PROJECT = process.env.PROJECT ?? ""

const browser = await chromium.launch({args: ["--autoplay-policy=no-user-gesture-required"]})
const page = await (await browser.newContext({viewport: {width: 1440, height: 900}})).newPage()
page.setDefaultTimeout(240000)
page.on("console", message => {if (message.type() === "error" || message.type() === "warning") {console.log(`console ${message.type()}: ${message.text()}`)}})
page.on("pageerror", error => console.log(`page error: ${error.message}`))

try {
    await page.goto(URL, {waitUntil: "networkidle"})
    if (PROJECT === "") {
        await page.getByText("New Project", {exact: true}).click()
        await page.getByText("Add instrument").first().waitFor()
    } else {
        await page.waitForFunction(() => window.takedo?.debug?.openBundle !== undefined)
        await page.evaluate(([base64, name]) => window.takedo.debug.openBundle(base64, name),
            [readFileSync(`/scenarios/projects/${PROJECT}`).toString("base64"), "jam-probe"])
    }
    await page.waitForFunction(() => window.takedo?.adapter !== null && window.takedo?.adapter !== undefined)
    if (await page.getByText("Welcome to openDAW").waitFor({timeout: 5000}).then(() => true, () => false)) {
        await page.keyboard.press("Escape")
    }
    // PANEL=1 connects TakeDo's panel to the backend, as a scenario does.
    if (process.env.PANEL === "1") {
        await page.getByTestId("takedo-toggle").click()
        await page.waitForFunction(() => document.querySelector("[data-testid=takedo-status]")?.dataset.status === "open")
    }
    const result = await page.evaluate(async ([seconds, bundled, edits, loop, rampMs, effectPlans, noRecord, drags]) => {
        const {service} = window.takedo
        const {project} = service.projectProfileService.getValue().unwrap()
        const {timelineBox, engine} = project
        const bar = 3840
        if (bundled) {
            window.opendaw.engine.play()
            await new Promise(resolve => setTimeout(resolve, 2000))
            // LOOP=1 keeps the project's loop on (TakeDo's extension then does nothing: openDAW alone).
            if (!loop) {project.editing.modify(() => timelineBox.loopArea.enabled.setValue(false))}
        } else {
            for (let index = 0; index < 3; index++) {
                window.takedo.debug.addSynth(`Probe ${index + 1}`, [[0, 48 + index * 4, 4], [4, 52 + index * 4, 4], [8, 55 + index * 4, 4]])
            }
            project.editing.modify(() => {timelineBox.loopArea.enabled.setValue(false); timelineBox.durationInPulses.setValue(8 * bar)})
        }
        const regions = () => project.rootBoxAdapter.audioUnits.adapters().flatMap(unit => unit.tracks.values().flatMap(track => track.regions.collection.asArray()))
        const ends = () => regions().map(region => Math.round(region.complete / bar * 100) / 100)
        const samples = [{label: "set up", ends: ends(), length: timelineBox.durationInPulses.getValue() / bar}]
        if (!noRecord) {project.startRecording(false)}
        const start = performance.now()
        while (!engine.isRecording.getValue() && performance.now() - start < 10000) {await new Promise(resolve => setTimeout(resolve, 50))}
        // EDITS=notes|tempo|both: from bar 16 on, every 2 bars, a stage's edit as the agents make it: every note of the
        // first notes region deleted and written again, and/or the tempo stepped down 4 BPM.
        let added = false
        const edit = second => {
            // EDITS=track: one new instrument with a part, as the chord bed is added, once past bar 15.
            if (edits === "track") {
                if (added || engine.position.getValue() < 14 * bar) {return null}
                added = true
                window.takedo.debug.addSynth("Probe keys", [[0, 52, 4], [4, 55, 4], [8, 59, 4], [12, 57, 4]])
                return "added a track"
            }
            // EDITS=effects: once past bar 5, the effects a frozen jam added (test/probe-effects.mjs, its add_effect plans
            // with their settings) through the page's own path, then the probe watches.
            if (edits === "effects") {
                if (added || engine.position.getValue() < 4 * bar) {return null}
                added = true
                const {adapter} = window.takedo
                effectPlans.forEach(plan => adapter.apply({id: crypto.randomUUID(), from: "agent:utility", plan, when: {at: "asap"},
                    seq: adapter.snapshot().at.seq}))
                return `added ${effectPlans.length} effects`
            }
            // EDITS=split: from bar 3, every 2 bars, an agent's script (the page's path: splits the part where the playhead
            // is) rewriting the first part's notes, a velocity changed each time, as a stage does.
            if (edits === "split") {
                if (engine.position.getValue() < 2 * bar || second % 4 !== 0) {return null}
                const {adapter} = window.takedo
                const pastRef = adapter.snapshot().tracks[0].regions.at(-1).ref
                const code = `const collection = ref("${pastRef}").optCollection.unwrap()
                    collection.events.asArray().slice().forEach(event => event.box.delete())
                    for (let step = 0; step < 16; step++) {api.createNoteEvent({owner: ref("${pastRef}").box, position: step * 240, duration: 120, pitch: 36 + (step % 4), velocity: 0.3 + 0.4 * Math.random()})}`
                adapter.apply({id: crypto.randomUUID(), from: "agent:utility", plan: {op: "script", code, description: "stage"}, when: {at: "asap"},
                    seq: adapter.snapshot().at.seq})
                return `stage on ${pastRef}`
            }
            // EDITS=ramp: from bar 14, every 2 bars, each part's volume ramped over 2 s as the page's ramps write it
            // (through openDAW's parameter adapter, a write per tick, unmarked): during a recording, written as automation.
            if (edits === "ramp") {
                if ((loop ? second < 26 : engine.position.getValue() < 14 * bar) || second % 4 !== 0) {return null}
                const units = project.rootBoxAdapter.audioUnits.adapters()
                const target = second % 8 === 0 ? -6 : 0
                units.forEach(unit => {
                    const parameter = unit.namedParameter.volume
                    const from = parameter.getValue(), start = performance.now()
                    project.editing.mark()
                    const step = () => {
                        const progress = Math.min(1, (performance.now() - start) / 2000)
                        project.editing.modify(() => parameter.setValue(from + (target - from) * progress), false)
                        if (progress < 1) {setTimeout(step, rampMs)} else {project.editing.mark()}
                    }
                    step()
                })
                return `ramping ${units.length} volumes to ${target}`
            }
            // EDITS=lanes: from bar 6, every 2 bars, agents' ramps through the page (window.takedo.adapter.apply): with the
            // loop off, each is written into its automation lane (Adapter #automate, 2026-11-25). Every part's volume, and
            // two ramps at once on one parameter (a later one cuts the earlier's region), as a stalled jam had them.
            if (edits === "lanes") {
                if (engine.position.getValue() < 6 * bar || second % 4 !== 0) {return null}
                const {adapter} = window.takedo
                const snapshot = adapter.snapshot()
                const ramp = (ref, to) => adapter.apply({id: crypto.randomUUID(), from: "agent:utility", plan: {op: "ramp", ref, to, beats: 16},
                    when: {at: "asap"}, seq: snapshot.at.seq})
                const target = second % 8 === 0 ? -6 : -1
                snapshot.tracks.forEach(track => ramp(`${track.ref}.mix.volume`, target))
                ramp("master.mix.volume", target / 2)
                ramp("master.mix.volume", target / 3)
                return `lane ramps on ${snapshot.tracks.length + 2} volumes to ${target}`
            }
            // EDITS=ride: from bar 4, a hand riding one knob without letting go (2026-11-25: a producer riding a tremolo's
            // symmetry while recording broke the engine): the first part's volume, a write every RAMP_MS, a slow wobble.
            if (edits === "ride") {
                if (added || engine.position.getValue() < 3 * bar) {return null}
                added = true
                const parameter = project.rootBoxAdapter.audioUnits.adapters()[0].namedParameter.volume
                const start = performance.now()
                const step = () => {
                    const t = (performance.now() - start) / 1000
                    project.editing.modify(() => parameter.setValue(-12 + 6 * Math.sin(t * 2) + Math.random()), false)
                    // DRAGS=1: let go every half second, as separate gestures (one undo step each).
                    if (drags && Math.floor(t * 2) !== Math.floor((t - rampMs / 1000) * 2)) {project.editing.mark()}
                    setTimeout(step, rampMs)
                }
                step()
                return "riding the first part's volume"
            }
            // EDITS=reverb: a Dattorro Reverb on every unit once past bar 14, then its decay and wet moved every 2 bars.
            if (edits === "reverb") {
                if (engine.position.getValue() < 14 * bar) {return null}
                const {api, lib} = window.takedo.adapter.env
                if (!added) {
                    added = true
                    project.editing.modify(() => project.rootBoxAdapter.audioUnits.adapters().forEach(unit =>
                        api.insertEffect(unit.box.audioEffects, lib.core.EffectFactories.AudioNamed.DattorroReverb)))
                    return "added reverbs"
                }
                if (second % 4 !== 0) {return null}
                const reverbs = project.rootBoxAdapter.audioUnits.adapters().flatMap(unit => unit.audioEffects.mapOr(effects => effects.adapters(), []))
                    .filter(effect => effect.box.name === "DattorroReverbDeviceBox")
                project.editing.modify(() => reverbs.forEach(reverb => {
                    reverb.box.decay.setValue(0.5 + 0.4 * Math.random())
                    reverb.box.wet.setValue(-30 + 20 * Math.random())
                }))
                return `moved ${reverbs.length} reverbs`
            }
            // EDITS=hand: from bar 3, every 4 s, the producer's hand dragging a direct control on a card (the panel's path:
            // adapter.setAsProducer, unmarked writes between two marks) on the next part's volume, then let go (2026-11-27:
            // a 15-minute recorded jam's box updates and dropouts climbed with each dial the producer touched).
            if (edits === "hand") {
                if (engine.position.getValue() < 2 * bar || second % 4 !== 0) {return null}
                const {adapter} = window.takedo
                const refs = [...adapter.snapshot().tracks.map(track => `${track.ref}.mix.volume`), "master.mix.volume"]
                const ref = refs[(second / 4 - 1) % refs.length]
                adapter.gestureMark()
                for (let step = 0; step <= 10; step++) {adapter.setAsProducer(ref, -8 + step * 0.3, false)}
                adapter.gestureMark()
                return `hand on ${ref}`
            }
            if (edits === "" || engine.position.getValue() < 15 * bar || second % 4 !== 0) {return null}
            const region = regions().find(region => region.optCollection?.nonEmpty?.())
            const did = []
            project.editing.modify(() => {
                if (edits !== "tempo" && region !== undefined) {
                    const collection = region.optCollection.unwrap()
                    const notes = collection.events.asArray().map(event => [event.position, event.pitch, event.duration, event.velocity])
                    collection.events.asArray().slice().forEach(event => event.box.delete())
                    notes.forEach(([position, pitch, duration, velocity]) => project.api.createNoteEvent({owner: region.box, position, duration, pitch, velocity}))
                    did.push(`notes ${notes.length}`)
                }
                if (edits !== "notes") {
                    project.api.setBpm(timelineBox.bpm.getValue() - 4)
                    did.push(`bpm ${timelineBox.bpm.getValue()}`)
                }
            })
            return did.join(", ")
        }
        let revision = window.takedo.adapter.revision
        for (let second = 1; second <= seconds; second++) {
            await new Promise(resolve => setTimeout(resolve, 1000))
            const edited = edit(second)
            const updates = window.takedo.adapter.revision - revision
            revision = window.takedo.adapter.revision
            samples.push({label: `${second} s`, bar: Math.round(engine.position.getValue() / bar * 100) / 100 + 1,
                playing: engine.isPlaying.getValue(), recording: engine.isRecording.getValue(),
                length: timelineBox.durationInPulses.getValue() / bar, ends: ends(), ctx: Number(service.audioContext.currentTime.toFixed(1)), updates, edited})
        }
        return samples
    }, [SECONDS, PROJECT !== "", process.env.EDITS ?? "", process.env.LOOP === "1", Number(process.env.RAMP_MS ?? 20), probeEffects,
        process.env.NOREC === "1", process.env.DRAGS === "1"])
    result.forEach(sample => console.log(JSON.stringify(sample)))
} finally {
    await browser.close()
}
