// What a default strip on every track would cost the audio engine (2026-11-27, the producer: would it be prohibitively
// expensive to add the common effects to tracks up front, a swing MIDI effect on drums, EQ, compressors, so slow requests
// become quick ones?): tracks dry, then each with a strip (Zeitgeist, Revamp EQ, Compressor) on, then bypassed, against
// one reverb each for scale, then all muted, which the page parks (Adapter #watchParking). openDAW's engine times each
// 128-sample block with debug.dspLoadMeasurement on (engine.perfBuffer); read for a few seconds per state, as
// park-bench.mjs does. Run via `make strip-bench`.
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
    await script(`const {loopArea} = project.timelineBox
        loopArea.from.setValue(0); loopArea.to.setValue(4 * bar); loopArea.enabled.setValue(true)`, "the loop")
    await page.evaluate(() => window.opendaw.engine.play())
    console.log(`${TRACKS} tracks of Vaporisateur (4-note chords, held), a 4-bar loop; ${SECONDS} s per state`)
    await measure("empty project, playing")
    const made = await script(`
        const chords = [[48, 55, 60, 64], [45, 52, 57, 60], [41, 48, 53, 57], [43, 50, 55, 59]]
        for (let index = 0; index < ${TRACKS}; index++) {
            const made = api.createInstrument(lib.adapters.InstrumentFactories.Vaporisateur)
            made.instrumentBox.label.setValue("Bench " + (index + 1)); made.audioUnitBox.volume.setValue(-24)
            const region = api.createNoteRegion({trackBox: made.trackBox, position: 0, duration: 4 * bar, name: "Bench"})
            chords.forEach((chord, at) => chord.forEach(pitch => api.createNoteEvent({owner: region, position: at * bar, duration: bar, pitch: pitch + (index % 3) * 12, velocity: 0.5})))
        }
        return ${TRACKS}`, "bench tracks")
    if (made.state !== "applied") {throw new Error(`couldn't make the tracks: ${made.detail}`)}
    const units = `project.rootBoxAdapter.audioUnits.adapters().filter(unit => unit.label.startsWith("Bench "))`
    const dry = await measure(`${TRACKS} tracks playing, dry`)
    // One device at a time, so each one's share shows.
    const add = async (chain, factory, label) => {
        const added = await script(`${units}.forEach(unit => api.insertEffect(unit.box.${chain}, lib.core.EffectFactories.${factory}))`, label)
        if (added.state !== "applied") {throw new Error(`couldn't add ${label}: ${added.detail}`)}
        return measure(`+ ${label} each`)
    }
    const zeitgeist = await add("midiEffects", "MidiNamed.Zeitgeist", "a Zeitgeist (swing)")
    const eq = await add("audioEffects", "AudioNamed.Revamp", "a Revamp EQ")
    const on = await add("audioEffects", "AudioNamed.Compressor", "a compressor")
    await script(`${units}.forEach(unit => {
        unit.midiEffects.mapOr(effects => effects.adapters(), []).forEach(effect => effect.box.enabled.setValue(false))
        unit.audioEffects.mapOr(effects => effects.adapters(), []).forEach(effect => effect.box.enabled.setValue(false))
    })`, "bypassed")
    const bypassed = await measure(`  the strips bypassed`)
    await script(`${units}.forEach(unit => {
        unit.midiEffects.mapOr(effects => effects.adapters(), []).forEach(effect => effect.box.enabled.setValue(true))
        unit.audioEffects.mapOr(effects => effects.adapters(), []).forEach(effect => effect.box.enabled.setValue(true))
        api.insertEffect(unit.box.audioEffects, lib.core.EffectFactories.AudioNamed.DattorroReverb)
    })`, "reverbs")
    const reverb = await measure(`  strips on + a Dattorro reverb each`)
    await script(`${units}.forEach(unit => unit.box.mute.setValue(true))`, "mute")
    await page.waitForTimeout(3000)
    const parked = await page.evaluate(() => window.takedo.adapter.snapshot().tracks.filter(track => track.name.startsWith("Bench ")).every(track => track.device?.enabled === false && track.effects.every(effect => !effect.enabled)))
    const muted = await measure(`  all muted (the page parks them: ${parked ? "instrument and effects off" : "NOT PARKED"})`)
    const share = (part, whole) => `${(part / whole.budget * 100).toFixed(1)}% of a block`
    const each = (from, to) => ((to.mean - from.mean) / TRACKS).toFixed(4)
    console.log(`\nPer track and device: a Zeitgeist ${each(dry, zeitgeist)} ms, an EQ ${each(zeitgeist, eq)} ms, a compressor ${each(eq, on)} ms (a block is ${on.budget.toFixed(2)} ms).`)
    console.log(`Per track: an instrument ${((dry.mean) / TRACKS).toFixed(4)} ms; the strip on ${((on.mean - dry.mean) / TRACKS).toFixed(4)} ms, bypassed ${((bypassed.mean - dry.mean) / TRACKS).toFixed(4)} ms; a Dattorro reverb ${((reverb.mean - on.mean) / TRACKS).toFixed(4)} ms.`)
    console.log(`All ${TRACKS} strips on: ${share(on.mean - dry.mean, on)} on average (p95 ${share(on.p95 - dry.p95, on)}); parked: ${share(muted.mean, muted)} in all, against ${share(reverb.mean, reverb)} playing.`)
} finally {
    await browser.close()
}
