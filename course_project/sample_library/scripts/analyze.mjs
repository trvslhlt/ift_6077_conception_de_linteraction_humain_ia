// Measures every sample and writes library.json: sources.json's hand-written metadata plus a `measured` block per
// sample. It also checks the hand-written claims it can: a pitched sound's note (within 50 cents), a loop's length
// (bpm and bars), and "bright"/"dark" tags against the measured brightness; it exits 1 if one fails. Usage: node scripts/analyze.mjs (from sample_library/).
import {readFileSync, statSync, writeFileSync} from "node:fs"
import {fft, hzOf, midiOf, nameOf, RATE, readWav} from "./audio.mjs"

const sources = JSON.parse(readFileSync("sources.json", "utf8"))
const db = value => value <= 0 ? -Infinity : Math.round(20 * Math.log10(value) * 10) / 10
const round = (value, digits = 0) => Math.round(value * 10 ** digits) / 10 ** digits

// Peak of each 1 ms block, over all channels.
const envelopeOf = channels => {
    const block = RATE / 1000, out = []
    for (let at = 0; at < channels[0].length; at += block) {
        let max = 0
        for (const data of channels) {for (let i = at; i < Math.min(at + block, data.length); i++) {max = Math.max(max, Math.abs(data[i]))}}
        out.push(max)
    }
    return out
}

// Energy-weighted spectral centroid over the first 2 s.
const centroid = data => {
    const size = 2048
    let weighted = 0, total = 0
    for (let at = 0; at + size <= Math.min(data.length, 2 * RATE); at += size / 2) {
        const re = new Float64Array(size), im = new Float64Array(size)
        for (let i = 0; i < size; i++) {re[i] = data[at + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / size))}
        fft(re, im)
        for (let bin = 1; bin < size / 2; bin++) {
            const power = re[bin] ** 2 + im[bin] ** 2
            weighted += power * bin * RATE / size
            total += power
        }
    }
    return total === 0 ? 0 : weighted / total
}
const brightnessOf = hz => hz < 600 ? "dark" : hz < 1500 ? "warm" : hz < 3500 ? "balanced" : "bright"

// Fundamental frequency from the spectrum of 0.7 s starting at `at`: the strongest peak below 4 kHz, or the lowest
// subharmonic (1/2, 1/3, repeatedly) within 12 dB of it, as for sounds whose fundamental isn't the strongest partial.
const pitchOf = (data, at) => {
    const size = 32768, re = new Float64Array(size), im = new Float64Array(size)
    for (let i = 0; i < size && at + i < data.length; i++) {re[i] = data[at + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / size))}
    fft(re, im)
    const magnitude = Array.from({length: size / 2}, (_, bin) => Math.hypot(re[bin], im[bin]))
    const binOf = hz => Math.round(hz * size / RATE)
    // Parabolic interpolation around the largest bin within 3% of `hz`.
    const peakNear = hz => {
        let best = binOf(hz)
        for (let bin = binOf(hz * 0.97); bin <= binOf(hz * 1.03); bin++) {if (magnitude[bin] > magnitude[best]) {best = bin}}
        const [a, b, c] = [magnitude[best - 1], magnitude[best], magnitude[best + 1]]
        return {hz: (best + 0.5 * (a - c) / (a - 2 * b + c || 1)) * RATE / size, magnitude: b}
    }
    let strongest = binOf(30)
    for (let bin = binOf(30); bin < binOf(4000); bin++) {if (magnitude[bin] > magnitude[strongest]) {strongest = bin}}
    const top = peakNear(strongest * RATE / size)
    let pitch = top.hz
    for (let lower = true; lower;) {
        lower = false
        for (const divisor of [3, 2]) {
            const candidate = peakNear(pitch / divisor)
            if (candidate.hz > 30 && candidate.magnitude >= top.magnitude / 4) {
                pitch = candidate.hz
                lower = true
                break
            }
        }
    }
    return pitch
}

const failures = []
const samples = sources.samples.map(sample => {
    const path = `samples/${sample.file}`
    const {rate, channels} = readWav(path)
    if (rate !== RATE) {failures.push(`${sample.id}: ${rate} Hz`)}
    const frames = channels[0].length
    const mono = Float32Array.from({length: frames}, (_, i) => channels.reduce((sum, data) => sum + data[i], 0) / channels.length)
    const envelope = envelopeOf(channels)
    const top = Math.max(...envelope), topAt = envelope.indexOf(top)
    const attackMs = envelope.findIndex(value => value >= top * 0.9)
    const lastLoud = envelope.length - 1 - [...envelope].reverse().findIndex(value => value >= top / 100)
    const rms = Math.sqrt(mono.reduce((sum, value) => sum + value * value, 0) / frames)
    const brightnessHz = round(centroid(mono))
    const measured = {
        durationSeconds: round(frames / RATE, 3), channels: channels.length, sampleRate: rate,
        sizeKb: round(statSync(path).size / 1024), peakDb: db(top), rmsDb: db(rms),
        ...(["loop", "texture"].includes(sample.kind) ? {} : {attackMs}), // until 90% of the peak
        decaySeconds: round((lastLoud - topAt) / 1000, 2), // from the peak until 40 dB below it
        brightnessHz, brightness: brightnessOf(brightnessHz)
    }
    if (sample.note !== undefined && !["pad", "chord stab"].includes(sample.category)) {
        const hz = pitchOf(mono, Math.min(frames - 1, (attackMs + 60) * RATE / 1000))
        const midi = 69 + 12 * Math.log2(hz / 440)
        const cents = round((midi - midiOf(sample.note)) * 100)
        measured.pitch = {hz: round(hz, 1), note: nameOf(Math.round(midi)), centsFromNote: cents}
        if (Math.abs(cents) > 50) {failures.push(`${sample.id}: measured ${nameOf(Math.round(midi))} (${hz.toFixed(1)} Hz), declared ${sample.note}`)}
    }
    if (sample.tags.includes("bright") && measured.brightness === "dark" || sample.tags.includes("dark") && measured.brightness === "bright") {
        failures.push(`${sample.id}: tagged ${sample.tags.includes("bright") ? "bright" : "dark"}, measured ${measured.brightness}`)
    }
    if (sample.bpm !== undefined) {
        const expected = sample.bars * 4 * 60 / sample.bpm
        measured.loopSeconds = round(expected, 3)
        if (Math.abs(frames / RATE - expected) > 0.001) {failures.push(`${sample.id}: ${frames / RATE} s, expected ${expected} s`)}
    }
    const {source, ...described} = sample
    return {
        ...described, ...(sample.note === undefined ? {} : {midiNote: midiOf(sample.note)}), file: path,
        source: source.vcsl !== undefined
            ? {origin: "VCSL", license: sources.vcsl.license, path: source.vcsl,
                url: `${sources.vcsl.repo}/blob/${sources.vcsl.commit}/${source.vcsl.split("/").map(encodeURIComponent).join("/")}`}
            : {origin: "synthesized", license: "CC0-1.0", recipe: `scripts/synth.mjs: ${source.synth}`},
        measured
    }
})

const library = {
    about: "Sample library for the agents: each sound's description (hand-written, sources.json) and measurements (scripts/analyze.mjs). "
        + "measured.brightness is the spectral centroid: dark < 600 Hz, warm < 1500, balanced < 3500, bright above. "
        + "decaySeconds runs from the peak until 40 dB below it. Notes are sounding pitch in openDAW's naming, C3 = MIDI 60 = 261.6 Hz "
        + "(measured.pitch checks them). Every sound is CC0.",
    sampleRate: RATE,
    samples
}
writeFileSync("library.json", JSON.stringify(library, null, 2) + "\n")
for (const sample of samples) {
    const {measured: m} = sample
    console.log(`${sample.id.padEnd(22)} ${String(m.durationSeconds).padStart(6)} s  ${String(m.rmsDb).padStart(6)} dB rms  `
        + `attack ${String(m.attackMs ?? "-").padStart(4)} ms  ${m.brightness.padEnd(8)} ${m.pitch ? `${m.pitch.note} ${m.pitch.centsFromNote}c` : ""}`)
}
console.log(`\n${samples.length} samples written to library.json`)
if (failures.length > 0) {
    console.log(`\nFAILED:\n  ${failures.join("\n  ")}`)
    process.exit(1)
}
