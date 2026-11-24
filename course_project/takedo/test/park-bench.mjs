// What a parked part costs the audio engine (2026-11-24): is a muted track cheaper than a playing one, and a track with
// its instrument and effects disabled cheaper still? openDAW's engine times each 128-sample block when the
// debug.dspLoadMeasurement preference is on (engine.perfBuffer, ms per block); this reads those times for a few seconds
// in each state. Run via `make park-bench`; it shares the studio container's network, like the smoke test.
import {chromium} from "playwright"

const URL = process.env.URL ?? "http://localhost:8080/"
const TRACKS = Number(process.env.TRACKS ?? 8)
const SECONDS = Number(process.env.SECONDS ?? 6)

const browser = await chromium.launch({args: ["--autoplay-policy=no-user-gesture-required"]})
const page = await (await browser.newContext({viewport: {width: 1440, height: 900}})).newPage()
page.setDefaultTimeout(180000)

const script = (code, description) => page.evaluate(([code, description]) => new Promise(resolve => {
    const {adapter} = window.takedo
    const id = crypto.randomUUID()
    const subscription = adapter.subscribeActivity(({request, status}) => {
        if (request.id !== id || !["applied", "dropped", "failed"].includes(status.state)) {return}
        subscription.terminate()
        resolve(status)
    })
    adapter.apply({id, from: "agent:utility", plan: {op: "script", code, description}, when: {at: "asap"}, seq: Number.MAX_SAFE_INTEGER})
}), [code, description])

// Per-block engine times over a few seconds, after a settling second: mean, 95th percentile and max, in ms and as a
// share of the block's budget (128 samples at the context's rate).
const measure = async label => {
    await page.waitForTimeout(1500)
    const result = await page.evaluate(seconds => new Promise(resolve => {
        const {engine} = window.takedo.service
        const times = []
        let last = engine.perfIndex
        const timer = setInterval(() => {
            const buffer = engine.perfBuffer, index = engine.perfIndex
            while (last !== index) {
                times.push(buffer[last])
                last = (last + 1) % buffer.length
            }
        }, 50)
        setTimeout(() => {
            clearInterval(timer)
            times.sort((a, b) => a - b)
            const mean = times.reduce((sum, time) => sum + time, 0) / Math.max(1, times.length)
            resolve({blocks: times.length, mean, p95: times[Math.floor(times.length * 0.95)] ?? 0, max: times.at(-1) ?? 0,
                budget: 128 / engine.sampleRate * 1000, playing: engine.isPlaying.getValue()})
        }, seconds * 1000)
    }), SECONDS)
    const share = ms => `${(ms / result.budget * 100).toFixed(1)}%`
    console.log(`${label.padEnd(44)} mean ${result.mean.toFixed(3)} ms (${share(result.mean)})  p95 ${result.p95.toFixed(3)} ms (${share(result.p95)})  max ${result.max.toFixed(3)} ms  [${result.blocks} blocks${result.playing ? "" : ", NOT PLAYING"}]`)
    return result
}

try {
    await page.goto(URL, {waitUntil: "networkidle"})
    await page.getByText("New Project", {exact: true}).click()
    await page.getByText("Add instrument").first().waitFor()
    await page.getByText("Welcome to openDAW").waitFor()
    await page.keyboard.press("Escape")
    await page.waitForFunction(() => window.takedo?.adapter !== null && window.takedo?.adapter !== undefined)
    await page.evaluate(() => {window.takedo.service.engine.preferences.settings.debug.dspLoadMeasurement = true})
    await page.evaluate(() => window.opendaw.engine.play())
    console.log(`${TRACKS} tracks of Vaporisateur (4-note chords, held) into a Dattorro reverb, a 4-bar loop; ${SECONDS} s per state`)
    await measure("empty project, playing")

    const made = await script(`
        const {loopArea} = project.timelineBox
        loopArea.from.setValue(0); loopArea.to.setValue(4 * bar); loopArea.enabled.setValue(true)
        const chords = [[48, 55, 60, 64], [45, 52, 57, 60], [41, 48, 53, 57], [43, 50, 55, 59]]
        for (let index = 0; index < ${TRACKS}; index++) {
            const made = api.createInstrument(lib.adapters.InstrumentFactories.Vaporisateur)
            made.instrumentBox.label.setValue("Bench " + (index + 1)); made.audioUnitBox.volume.setValue(-24)
            api.insertEffect(made.audioUnitBox.audioEffects, lib.core.EffectFactories.AudioNamed.DattorroReverb)
            const region = api.createNoteRegion({trackBox: made.trackBox, position: 0, duration: 4 * bar, name: "Bench"})
            chords.forEach((chord, at) => chord.forEach(pitch => api.createNoteEvent({owner: region, position: at * bar, duration: bar, pitch: pitch + (index % 3) * 12, velocity: 0.5})))
        }
        return ${TRACKS}`, "bench tracks")
    if (made.state !== "applied") {throw new Error(`couldn't make the tracks: ${made.detail}`)}
    const units = `project.rootBoxAdapter.audioUnits.adapters().filter(unit => unit.label.startsWith("Bench "))`
    const playing = await measure(`${TRACKS} tracks playing`)

    await script(`${units}.forEach(unit => unit.box.mute.setValue(true))`, "mute")
    const muted = await measure(`${TRACKS} tracks muted`)

    await script(`${units}.forEach(unit => {
        unit.box.mute.setValue(false)
        unit.tracks.values().forEach(track => track.regions.collection.asArray().forEach(region => region.box.mute.setValue(true)))
    })`, "regions muted")
    const regions = await measure(`${TRACKS} tracks, their regions muted`)

    await script(`${units}.forEach(unit => {
        unit.box.mute.setValue(true)
        unit.tracks.values().forEach(track => track.regions.collection.asArray().forEach(region => region.box.mute.setValue(false)))
        unit.inputAdapter.ifSome(instrument => instrument.box.enabled.setValue(false))
        unit.audioEffects.mapOr(effects => effects.adapters(), []).forEach(effect => effect.box.enabled.setValue(false))
    })`, "disabled")
    const disabled = await measure(`${TRACKS} tracks muted, instrument+fx disabled`)

    const saving = (from, to) => `${((1 - to.mean / from.mean) * 100).toFixed(0)}%`
    console.log(`\nAgainst playing: muted saves ${saving(playing, muted)}, regions muted ${saving(playing, regions)}, disabled ${saving(playing, disabled)} of the mean block time.`)
} finally {
    await browser.close()
}
