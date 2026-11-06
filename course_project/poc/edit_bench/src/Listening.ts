import {Option, UUID} from "@opendaw/lib-std"
import {FFT, PPQN, RenderQuantum} from "@opendaw/lib-dsp"
import {AudioUnitBox, NoteEventBox, VaporisateurDeviceBox} from "@opendaw/studio-boxes"
import {EngineAddresses, ExportConfiguration} from "@opendaw/studio-adapters"
import {OfflineEngineRenderer, type Project} from "@opendaw/studio-core"
import {createRig, Log, PerfProbe, PerfReport, playFromStart, Rig, round, sleep, stats} from "./Bench"
import {gaps, OutputTap} from "./OutputTap"

// Experiment F from project_plan/EXPERIMENTS.md: what the bus can hear. Run with `make experiment EXPERIMENT=F`.
//
// 1. Live readings: how often the engine's meters (master peaks, loudness, spectrum; each channel's peaks) arrive
//    on the main thread, what subscribing costs the audio thread, and how far a channel's meter lags the output.
// 2. Offline renders during playback: a copy of the project rendered in its own worker (how openDAW exports and
//    freezes) while the live project plays. Wall time per render size, and whether playback or meters suffer.
// 3. Summaries from the renders: code computes level, peak and bands per part, and code rules flag problems. Each
//    case sets the project up so a known problem is present (or not) and checks the rule's verdict.

const Bars = 128
const Notes = {
    kick: [[0, 36], [1, 36], [2, 36], [3, 36]],
    bass: [[0, 31], [0.5, 33], [1, 35], [1.5, 36], [2, 38], [2.5, 40], [3, 38], [3.5, 35]],
    keys: [[0, 60], [0, 64], [0, 67], [0, 71], [2, 62], [2, 65], [2, 69], [2, 72]],
    hats: [[0, 96], [0.5, 96], [1, 96], [1.5, 96], [2, 96], [2.5, 96], [3, 96], [3.5, 96]]
} as const
type Part = keyof typeof Notes
const Parts: ReadonlyArray<Part> = ["kick", "bass", "keys", "hats"]
// Note length in quarters, filter cutoff in Hz, release in seconds.
const Voicing: Record<Part, { length: number, cutoff: number, release: number }> = {
    kick: {length: 0.25, cutoff: 2000, release: 0.05},
    bass: {length: 0.5, cutoff: 120, release: 0.05},
    keys: {length: 2, cutoff: 6000, release: 0.2},
    hats: {length: 0.125, cutoff: 20000, release: 0.02}
}

type Band = "sub" | "low" | "low_mid" | "mid" | "high"
const Bands: ReadonlyArray<[Band, number, number]> =
    [["sub", 0, 60], ["low", 60, 250], ["low_mid", 250, 1000], ["mid", 1000, 4000], ["high", 4000, Infinity]]

export type Summary = {
    rms_db: number
    peak_db: number
    bands_db: Record<Band, number>
    below_150hz_pct: number
}
export type Flag = { rule: "silent" | "clipping" | "below_150hz" | "crowding", parts: ReadonlyArray<string> }

export type ListeningResult = {
    live: unknown
    renders: unknown
    summaries: unknown
}

export const runListening = async (project: Project, sampleRate: number, log: Log): Promise<ListeningResult> => {
    const rigs = createParts(project)
    const tap = OutputTap.create()
    tap.start()
    try {
        const live = await liveReadings(project, sampleRate, rigs, tap, log)
        const renders = await rendersDuringPlayback(project, sampleRate, rigs, tap, log)
        project.engine.stop()
        const summaries = await summaryCases(project, sampleRate, rigs, log)
        return {live, renders, summaries}
    } finally {
        project.engine.stop()
        tap.stop()
    }
}

// Four synth parts, each a one-bar pattern looped over the whole timeline.
const createParts = (project: Project): Record<Part, Rig> => {
    const rigs = Object.fromEntries(Parts.map(part => [part, createRig(project, `bench: F ${part}`, Bars, 1)])) as Record<Part, Rig>
    project.editing.modify(() => {
        for (const part of Parts) {
            const {length, cutoff, release} = Voicing[part]
            const synth = vaporisateur(rigs[part])
            synth.cutoff.setValue(cutoff)
            synth.attack.setValue(0.002)
            synth.release.setValue(release)
            for (const [quarter, pitch] of Notes[part]) {
                project.api.createNoteEvent({owner: rigs[part].region, position: quarter * PPQN.Quarter,
                    duration: length * PPQN.Quarter, pitch, velocity: 0.8})
            }
        }
    })
    return rigs
}

const vaporisateur = (rig: Rig): VaporisateurDeviceBox => {
    if (!(rig.instrumentBox instanceof VaporisateurDeviceBox)) {throw new Error("rig is not a Vaporisateur")}
    return rig.instrumentBox
}

// ---------- 1. Live readings ----------

const SteadyMs = 5000
const LagTrials = 8
const Audible = 0.01

const liveReadings = async (project: Project, sampleRate: number, rigs: Record<Part, Rig>, tap: OutputTap, log: Log) => {
    const {liveStreamReceiver: receiver} = project
    await playFromStart(project)
    await sleep(500)
    const probe = new PerfProbe(project, sampleRate)
    probe.start()
    await sleep(SteadyMs)
    const unsubscribed = probe.stop()

    const streams: Record<string, { address: typeof EngineAddresses.PEAKS }> = {
        master_peaks: {address: EngineAddresses.PEAKS}, loudness: {address: EngineAddresses.LOUDNESS},
        spectrum: {address: EngineAddresses.SPECTRUM},
        ...Object.fromEntries(Parts.map(part => [`${part}_peaks`, {address: rigs[part].audioUnitBox.address}]))
    }
    const seen: Record<string, { count: number, length: number, handlerMs: number, last: Float32Array | null }> = {}
    const subscriptions = Object.entries(streams).map(([name, {address}]) => {
        seen[name] = {count: 0, length: 0, handlerMs: 0, last: null}
        return receiver.subscribeFloats(address, values => {
            const started = performance.now()
            const entry = seen[name]
            entry.count++
            entry.length = values.length
            entry.last = values.slice()
            entry.handlerMs += performance.now() - started
        })
    })
    await sleep(500)
    for (const entry of Object.values(seen)) {entry.count = 0}
    probe.start()
    await sleep(SteadyMs)
    const subscribed = probe.stop()
    const rates = Object.fromEntries(Object.entries(seen).map(([name, entry]) =>
        [name, {perSecond: round(entry.count / (SteadyMs / 1000), 1), floats: entry.length}]))
    log(`experiment F: live readings: ${JSON.stringify(rates)}`)

    // Lag: unmute the keys (alone) and compare the first audible output chunk with the first keys meter reading
    // and master reading that show it, all on the audio clock.
    let keysMeter: number | null = null, masterMeter: number | null = null, armed = false
    const lagSubscriptions = [
        receiver.subscribeFloats(rigs.keys.audioUnitBox.address, values => {
            if (armed && keysMeter === null && Math.max(values[0], values[1]) >= Audible) {keysMeter = tap.now()}
        }),
        receiver.subscribeFloats(EngineAddresses.PEAKS, values => {
            if (armed && masterMeter === null && Math.max(values[0], values[1]) >= Audible) {masterMeter = tap.now()}
        })
    ]
    const setMuted = (muted: Partial<Record<Part, boolean>>) => project.editing.modify(() =>
        Parts.forEach(part => rigs[part].audioUnitBox.mute.setValue(muted[part] ?? true)))
    const lags: Array<{ channelMs: number | null, masterMs: number | null }> = []
    for (let trial = 0; trial < LagTrials; trial++) {
        setMuted({})
        await sleep(1500 + Math.random() * 250)
        keysMeter = masterMeter = null
        armed = true
        const since = tap.now()
        setMuted({keys: false})
        await sleep(1000)
        armed = false
        const heard = tap.between(since, since + 1).find(chunk => chunk.peak >= Audible)
        lags.push({
            channelMs: heard && keysMeter !== null ? round((keysMeter - heard.time) * 1000, 1) : null,
            masterMs: heard && masterMeter !== null ? round((masterMeter - heard.time) * 1000, 1) : null
        })
    }
    setMuted({kick: false, bass: false, keys: false, hats: false})
    lagSubscriptions.forEach(subscription => subscription.terminate())
    subscriptions.forEach(subscription => subscription.terminate())

    // What the spectrum stream can resolve: AudioAnalyser's bins are linear up to Nyquist.
    const bins = seen.spectrum.length
    const binHz = round(sampleRate / 2 / Math.max(1, bins), 1)
    const loudness = seen.loudness.last
    return {
        rates,
        handlerMsTotal: round(Object.values(seen).reduce((sum, entry) => sum + entry.handlerMs, 0)),
        audioThread: {unsubscribed, subscribed},
        lagMs: {
            channel: stats(lags.flatMap(lag => lag.channelMs === null ? [] : [lag.channelMs])),
            master: stats(lags.flatMap(lag => lag.masterMs === null ? [] : [lag.masterMs])),
            trials: lags
        },
        spectrum: {bins, binHz, binsBelow150Hz: Math.floor(150 / binHz)},
        loudnessSample: loudness === null ? null : Array.from(loudness).map(value => round(value, 1))
    }
}

// ---------- 2. Offline renders during playback ----------

type Rendered = { channels: Array<Float32Array>, createMs: number, renderMs: number }

// Renders bars [from, from + bars) of a copy of the project: the given parts as stereo stems, or the master mix
// when parts is null. Drives the renderer directly: start() and renderSection() toggle their source's loop area.
const render = async (project: Project, sampleRate: number, parts: ReadonlyArray<AudioUnitBox> | null,
                      from: number, bars: number): Promise<Rendered> => {
    const config: Option<ExportConfiguration> = parts === null ? Option.None : Option.wrap({
        stems: Object.fromEntries(parts.map(box => [UUID.toString(box.address.uuid), {
            includeAudioEffects: true, includeSends: false, useInstrumentOutput: false,
            fileName: UUID.toString(box.address.uuid)
        }]))
    })
    // A copy, as openDAW's freeze does: the renderer connects its source's meter receiver, which the live engine holds.
    const started = performance.now()
    const copy = project.copy()
    const renderer = await OfflineEngineRenderer.create(copy, config, sampleRate).catch(error => {
        copy.terminate()
        throw error
    })
    const created = performance.now()
    try {
        await renderer.waitForLoading()
        renderer.setPosition(from * PPQN.Bar)
        await renderer.play()
        await renderer.waitForLoading()
        const seconds = project.tempoMap.intervalToSeconds(from * PPQN.Bar, (from + bars) * PPQN.Bar)
        const total = Math.ceil(seconds * sampleRate / RenderQuantum) * RenderQuantum
        const channels = Array.from({length: renderer.numberOfChannels}, () => new Float32Array(total))
        for (let rendered = 0; rendered < total;) {
            const samples = Math.min(RenderQuantum * 375, total - rendered)
            const step = await renderer.step(samples)
            step.forEach((channel, index) => channels[index].set(channel.subarray(0, samples), rendered))
            rendered += samples
        }
        return {channels, createMs: round(created - started), renderMs: round(performance.now() - created)}
    } finally {
        renderer.terminate()
        copy.terminate()
    }
}

const RenderTrials = 3

const rendersDuringPlayback = async (project: Project, sampleRate: number, rigs: Record<Part, Rig>, tap: OutputTap,
                                     log: Log) => {
    const sizes: ReadonlyArray<{ name: string, parts: ReadonlyArray<Part> | null, bars: number }> = [
        {name: "1 part, 8 bars", parts: ["bass"], bars: 8},
        {name: "4 parts, 8 bars", parts: Parts, bars: 8},
        {name: "1 part, 32 bars", parts: ["bass"], bars: 32},
        {name: "master mix, 8 bars", parts: null, bars: 8}
    ]
    await playFromStart(project)
    await sleep(500)
    const rows: Array<{ name: string, trial: number, createMs: number, renderMs: number, audioSeconds: number,
        realtime: number, perf: PerfReport, outputGaps: ReturnType<typeof gaps> }> = []
    for (const size of sizes) {
        for (let trial = 0; trial < RenderTrials; trial++) {
            const probe = new PerfProbe(project, sampleRate)
            const since = tap.now()
            probe.start()
            const result = await render(project, sampleRate,
                size.parts === null ? null : size.parts.map(part => rigs[part].audioUnitBox), 0, size.bars)
            const perf = probe.stop()
            const audioSeconds = round(result.channels[0].length / sampleRate)
            rows.push({
                name: size.name, trial, createMs: result.createMs, renderMs: result.renderMs, audioSeconds,
                realtime: round(audioSeconds * 1000 / (result.createMs + result.renderMs), 1), perf,
                outputGaps: gaps(tap.between(since, tap.now()))
            })
            await sleep(300)
        }
        const mine = rows.filter(row => row.name === size.name)
        log(`experiment F: render ${size.name}: total ${JSON.stringify(stats(mine.map(row => row.createMs + row.renderMs)))} ms, `
            + `overruns ${mine.map(row => row.perf.overruns).join("/")}`)
    }

    // Meter disturbance: render a silent stretch (after the regions end) while the live project plays. If the
    // offline engine's meters reach the live receiver, the master meter reads silence during the render.
    const master: Array<{ time: number, peak: number }> = []
    const subscription = project.liveStreamReceiver.subscribeFloats(EngineAddresses.PEAKS, values =>
        master.push({time: tap.now(), peak: Math.max(values[0], values[1])}))
    await sleep(1000)
    const since = tap.now()
    const silent = await render(project, sampleRate, null, Bars + 8, 32)
    const until = tap.now()
    await sleep(500)
    subscription.terminate()
    const before = master.filter(reading => reading.time < since)
    const during = master.filter(reading => reading.time >= since && reading.time <= until)
    const meters = {
        renderMs: round(silent.createMs + silent.renderMs),
        renderedPeak: round(peak(silent.channels), 4),
        liveOutputRms: round(tap.between(since, until).reduce((sum, chunk) => sum + chunk.rms, 0)
            / Math.max(1, tap.between(since, until).length), 4),
        readingsPerSecondBefore: round(before.length / Math.max(0.001, since - (before[0]?.time ?? since)), 1),
        readingsPerSecondDuring: round(during.length / Math.max(0.001, until - since), 1),
        minPeakBefore: round(Math.min(...before.map(reading => reading.peak)), 4),
        minPeakDuring: during.length === 0 ? null : round(Math.min(...during.map(reading => reading.peak)), 4),
        silentReadingsDuring: during.filter(reading => reading.peak < 1e-4).length
    }
    log(`experiment F: meters during a render: ${JSON.stringify(meters)}`)
    project.engine.stop()
    const bySize = sizes.map(size => {
        const mine = rows.filter(row => row.name === size.name)
        return {
            name: size.name,
            createMs: stats(mine.map(row => row.createMs)),
            renderMs: stats(mine.map(row => row.renderMs)),
            realtime: stats(mine.map(row => row.realtime)),
            overruns: mine.map(row => row.perf.overruns),
            maxBlockMs: Math.max(...mine.map(row => row.perf.maxBlockMs)),
            longTaskMs: mine.map(row => row.perf.longTaskMs),
            outputGaps: mine.map(row => row.outputGaps.count)
        }
    })
    return {bySize, meters, rows}
}

// ---------- 3. Summaries and code rules ----------

const FrameSize = 4096
const fft = new FFT(FrameSize)
const hann = Float32Array.from({length: FrameSize}, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / FrameSize))

const peak = (channels: ReadonlyArray<Float32Array>): number =>
    channels.reduce((max, channel) => channel.reduce((m, value) => Math.max(m, Math.abs(value)), max), 0)

const toDb = (gain: number): number => gain > 0 ? round(20 * Math.log10(gain), 1) : -120

// Level, peak and energy per band of one stereo pair, from its mono sum.
export const summarize = (left: Float32Array, right: Float32Array, sampleRate: number): Summary => {
    let sum = 0
    const mono = new Float32Array(left.length)
    for (let i = 0; i < left.length; i++) {
        mono[i] = (left[i] + right[i]) / 2
        sum += (left[i] * left[i] + right[i] * right[i]) / 2
    }
    const rms = Math.sqrt(sum / Math.max(1, left.length))
    const power = new Float64Array(FrameSize / 2)
    const real = new Float32Array(FrameSize), imag = new Float32Array(FrameSize)
    for (let start = 0; start + FrameSize <= mono.length; start += FrameSize) {
        for (let i = 0; i < FrameSize; i++) {real[i] = mono[start + i] * hann[i]}
        imag.fill(0)
        fft.process(real, imag)
        for (let bin = 1; bin < FrameSize / 2; bin++) {power[bin] += real[bin] * real[bin] + imag[bin] * imag[bin]}
    }
    const binHz = sampleRate / FrameSize
    const total = power.reduce((s, p) => s + p, 0)
    const share = (lo: number, hi: number) => {
        let s = 0
        for (let bin = 1; bin < power.length; bin++) {if (bin * binHz >= lo && bin * binHz < hi) {s += power[bin]}}
        return total > 0 ? s / total : 0
    }
    const rmsDb = toDb(rms)
    const bands = Object.fromEntries(Bands.map(([band, lo, hi]) => {
        const fraction = share(lo, hi)
        return [band, fraction > 0 && rms > 0 ? round(rmsDb + 10 * Math.log10(fraction), 1) : -120]
    })) as Record<Band, number>
    return {rms_db: rmsDb, peak_db: toDb(peak([left, right])), bands_db: bands,
        below_150hz_pct: Math.round(share(0, 150) * 100)}
}

const loudestBand = (summary: Summary): Band =>
    (Object.entries(summary.bands_db) as Array<[Band, number]>).sort((a, b) => b[1] - a[1])[0][0]

// The thresholds listen_bench's words used: silent below -60 dB peak, clipping above 0 dB, "laptop speakers barely
// play it" at 70% below 150 Hz, crowding when two parts' loudest bands match within 3 dB.
export const rules = (parts: Record<string, Summary>, master: Summary | null): Array<Flag> => {
    const flags: Array<Flag> = []
    const sounding = Object.entries(parts).filter(([, summary]) => summary.peak_db > -60)
    for (const [name, summary] of Object.entries(parts)) {
        if (summary.peak_db <= -60) {flags.push({rule: "silent", parts: [name]})}
        else if (summary.below_150hz_pct >= 70) {flags.push({rule: "below_150hz", parts: [name]})}
        if (summary.peak_db > 0) {flags.push({rule: "clipping", parts: [name]})}
    }
    if (master !== null && master.peak_db > 0) {flags.push({rule: "clipping", parts: ["master"]})}
    for (let i = 0; i < sounding.length; i++) {
        for (let j = i + 1; j < sounding.length; j++) {
            const [a, sa] = sounding[i], [b, sb] = sounding[j]
            const band = loudestBand(sa)
            if (band === loudestBand(sb) && Math.abs(sa.bands_db[band] - sb.bands_db[band]) <= 3) {
                flags.push({rule: "crowding", parts: [a, b]})
            }
        }
    }
    return flags
}

const flagName = (flag: Flag): string => `${flag.rule}(${flag.parts.join(",")})`

type Setup = { volume?: Partial<Record<Part, number>>, cutoff?: Partial<Record<Part, number>>,
    transpose?: Partial<Record<Part, number>>, muted?: ReadonlyArray<Part> }
type Case = { name: string, setup: Setup, expect: ReadonlyArray<string>, absent: ReadonlyArray<string> }

// Volumes in dB on each part's channel strip. The base mix keeps the kick 12 dB under the bass, so they don't crowd.
const Base: Setup = {volume: {kick: -12, bass: 0, keys: -6, hats: -18}}
const Cases: ReadonlyArray<Case> = [
    {name: "base: bass at 49-82 Hz, filter at 120 Hz", setup: Base,
        expect: ["below_150hz(bass)"], absent: ["below_150hz(keys)", "below_150hz(hats)", "clipping(master)"]},
    {name: "bass up an octave, filter at 1 kHz", setup: {...Base, transpose: {bass: 12}, cutoff: {bass: 1000}},
        expect: [], absent: ["below_150hz(bass)"]},
    {name: "kick and bass crowd the lows",
        setup: {...Base, transpose: {bass: 12}, cutoff: {bass: 1000}, volume: {...Base.volume, kick: 0}},
        expect: ["crowding(kick,bass)"], absent: []},
    {name: "keys' filter closed to 600 Hz", setup: {...Base, cutoff: {keys: 600}},
        expect: [], absent: []},
    {name: "master clipping: every part +12 dB", setup: {volume: {kick: 0, bass: 12, keys: 6, hats: -6}},
        expect: ["clipping(master)"], absent: []},
    {name: "keys muted", setup: {...Base, muted: ["keys"]},
        expect: ["silent(keys)"], absent: ["silent(bass)", "silent(kick)", "silent(hats)"]}
]
const SummaryBars = 8

const summaryCases = async (project: Project, sampleRate: number, rigs: Record<Part, Rig>, log: Log) => {
    const pitches = Object.fromEntries(Parts.map(part => [part, notesOf(rigs[part]).map(note => note.pitch.getValue())]))
    const apply = (setup: Setup) => project.editing.modify(() => Parts.forEach(part => {
        const {audioUnitBox} = rigs[part]
        audioUnitBox.volume.setValue(setup.volume?.[part] ?? 0)
        audioUnitBox.mute.setValue(setup.muted?.includes(part) ?? false)
        vaporisateur(rigs[part]).cutoff.setValue(setup.cutoff?.[part] ?? Voicing[part].cutoff)
        notesOf(rigs[part]).forEach((note, index) => note.pitch.setValue(pitches[part][index] + (setup.transpose?.[part] ?? 0)))
    }))
    const rows = []
    let baseKeys: Summary | null = null
    for (const c of Cases) {
        apply(c.setup)
        const stems = await render(project, sampleRate, Parts.map(part => rigs[part].audioUnitBox), 0, SummaryBars)
        const mix = await render(project, sampleRate, null, 0, SummaryBars)
        const started = performance.now()
        const parts = Object.fromEntries(Parts.map((part, index) =>
            [part, summarize(stems.channels[index * 2], stems.channels[index * 2 + 1], sampleRate)]))
        const master = summarize(mix.channels[0], mix.channels[1], sampleRate)
        const flags = rules(parts, master).map(flagName)
        const analysisMs = round(performance.now() - started)
        const ok = c.expect.every(flag => flags.includes(flag)) && c.absent.every(flag => !flags.includes(flag))
        if (c.name.startsWith("base")) {baseKeys = parts.keys}
        // The closed filter is a before/after question: the keys' highs and mids against the base case.
        const keysChange = baseKeys === null || c.name.startsWith("base") ? null : Object.fromEntries(Bands.map(([band]) =>
            [band, round(parts.keys.bands_db[band] - baseKeys!.bands_db[band], 1)]))
        log(`experiment F: ${ok ? "ok" : "MISS"} ${c.name}: ${flags.join(" ") || "no flags"}`)
        rows.push({case: c.name, ok, flags, expect: c.expect, absent: c.absent, parts, master, keysChange, analysisMs,
            renderMs: round(stems.createMs + stems.renderMs + mix.createMs + mix.renderMs)})
    }
    apply(Base)
    return rows
}

const notesOf = (rig: Rig) => rig.region.events.targetVertex.unwrap().box.pointerHub.incoming()
    .map(pointer => pointer.box)
    .filter((box): box is NoteEventBox => box instanceof NoteEventBox)
