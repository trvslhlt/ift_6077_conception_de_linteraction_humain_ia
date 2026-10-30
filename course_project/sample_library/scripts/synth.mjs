// Synthesizes the library's own sounds: the Circuit drum kit, bass and synth one-shots, loops at known tempo and
// key, and impulse responses for Convolver. Each entry in sources.json with `source.synth` names a recipe here.
// Every recipe is seeded, so a rebuild writes the same files. Usage: node scripts/synth.mjs (from sample_library/).
import {mkdirSync, readFileSync} from "node:fs"
import {dirname} from "node:path"
import {biquad, hzOf, midiOf, normalize, random, RATE, writeWav} from "./audio.mjs"

const frames = seconds => Math.round(seconds * RATE)
const signal = seconds => new Float32Array(frames(seconds))
const mix = (target, source, at = 0, gain = 1) => {
    for (let i = 0; i < source.length; i++) {target[(at + i) % target.length] += source[i] * gain} // wraps: loops stay seamless
    return target
}
const noise = (seconds, seed) => {
    const next = random(seed)
    return signal(seconds).map(() => next())
}
const envelope = (data, decay, attack = 0.001) => data.map((value, i) => {
    const t = i / RATE
    return value * Math.min(1, t / attack) * Math.exp(-t / decay)
})
// A sine whose frequency glides from `from` to `to` with time constant `glide`.
const sweep = (seconds, from, to, glide) => {
    const out = signal(seconds)
    let phase = 0
    for (let i = 0; i < out.length; i++) {
        phase += 2 * Math.PI * (to + (from - to) * Math.exp(-i / RATE / glide)) / RATE
        out[i] = Math.sin(phase)
    }
    return out
}
// Band-limited enough for our purposes: a sum of the first harmonics.
const saw = (seconds, hz, detune = 0) => {
    const out = signal(seconds), f = hz * 2 ** (detune / 1200)
    for (let h = 1; h * f < RATE / 2 && h <= 40; h++) {
        for (let i = 0; i < out.length; i++) {out[i] += Math.sin(2 * Math.PI * f * h * i / RATE) / h * 0.5}
    }
    return out
}
const square = (seconds, hz) => signal(seconds).map((_, i) => Math.sign(Math.sin(2 * Math.PI * hz * i / RATE)))
const mono = data => [data]

// --- Circuit kit (electronic drums)

const kick808 = () => envelope(sweep(1.2, 120, 46, 0.04), 0.45)
const kickPunch = () => {
    const body = envelope(sweep(0.5, 210, 55, 0.025), 0.16)
    return mix(body, envelope(biquad(noise(0.01, 1), "highpass", 3000), 0.002), 0, 0.5).map(Math.tanh)
}
const snare = () => {
    const tone = mix(envelope(sweep(0.4, 240, 180, 0.02), 0.07), envelope(sweep(0.4, 400, 330, 0.02), 0.05), 0, 0.6)
    return mix(tone, envelope(biquad(noise(0.4, 2), "highpass", 1200), 0.12), 0, 0.9)
}
const clap = () => {
    const out = signal(0.5), burst = biquad(noise(0.5, 3), "bandpass", 1200, 0.8)
    for (const [at, decay] of [[0, 0.006], [0.011, 0.006], [0.022, 0.006], [0.033, 0.16]]) {
        mix(out, envelope(burst.slice(frames(at)), decay), frames(at))
    }
    return out
}
const rim = () => mix(envelope(sweep(0.08, 1700, 1700, 1), 0.012), envelope(sweep(0.08, 820, 820, 1), 0.02), 0, 0.7)
const metal = (seconds, seed) => {
    const out = signal(seconds)
    for (const hz of [205.3, 304.4, 369.6, 522.7, 540, 800]) {mix(out, square(seconds, hz * 1.7), 0, 1 / 6)}
    return mix(biquad(out, "highpass", 7000), biquad(noise(seconds, seed), "highpass", 8000), 0, 0.3)
}
const hatClosed = () => envelope(metal(0.2, 4), 0.035)
const hatOpen = () => envelope(metal(0.9, 5), 0.3)
const tom = (from, to) => () => envelope(sweep(0.8, from, to, 0.05), 0.22)
const cowbell = () => envelope(biquad(mix(square(0.5, 540), square(0.5, 800)), "bandpass", 700, 2), 0.12)
const crash = () => envelope(mix(metal(2.5, 6), biquad(noise(2.5, 7), "highpass", 4000), 0, 0.6), 0.8, 0.002)

// --- Bass and synth one-shots

const subBass = note => () => envelope(sweep(2, hzOf(midiOf(note)), hzOf(midiOf(note)), 1), 0.9, 0.005).map(v => Math.tanh(v * 1.5))
const sawBass = note => () => {
    // A filter that closes over the note: three one-pole lowpasses, cutoff falling from ~3300 to 300 Hz.
    const raw = saw(1.5, hzOf(midiOf(note))), out = signal(1.5), state = [0, 0, 0]
    for (let i = 0; i < raw.length; i++) {
        const cutoff = 300 + 3000 * Math.exp(-i / RATE / 0.12)
        const k = 1 - Math.exp(-2 * Math.PI * cutoff / RATE)
        let value = raw[i]
        for (let pole = 0; pole < 3; pole++) {value = state[pole] += k * (value - state[pole])}
        out[i] = value
    }
    return envelope(out, 0.5, 0.003)
}
const pluck = note => () => {
    // Karplus-Strong.
    const period = Math.round(RATE / hzOf(midiOf(note))), out = signal(2), next = random(8)
    const line = Float32Array.from({length: period}, () => next())
    for (let i = 0; i < out.length; i++) {
        const value = line[i % period]
        out[i] = value
        line[i % period] = 0.497 * (value + line[(i + 1) % period])
    }
    return out
}
const pad = (notes, seconds = 4) => () => {
    const left = signal(seconds), right = signal(seconds)
    for (const note of notes) {
        mix(left, saw(seconds, hzOf(midiOf(note)), -7), 0, 1 / notes.length)
        mix(right, saw(seconds, hzOf(midiOf(note)), 7), 0, 1 / notes.length)
    }
    const shape = data => biquad(data, "lowpass", 1800).map((v, i) => {
        const t = i / RATE
        return v * Math.min(1, t / 0.6) * Math.min(1, (seconds - t) / 0.8)
    })
    return [shape(left), shape(right)]
}
const stab = notes => () => {
    const out = signal(1)
    for (const note of notes) {mix(out, saw(1, hzOf(midiOf(note))), 0, 1 / notes.length)}
    return envelope(biquad(out, "lowpass", 2500, 1.2), 0.18, 0.002)
}

// --- Loops: a pattern of hits on a grid of sixteenth notes, wrapped so the loop repeats seamlessly.

const loop = (bpm, bars, steps) => () => {
    const sixteenth = 60 / bpm / 4, out = signal(bars * 16 * sixteenth)
    for (const [sound, pattern, gain = 1] of steps) {
        const hit = sound()
        pattern.forEach((step, index) => {if (step) {mix(out, hit, frames(index * sixteenth), gain * step)}})
    }
    return out
}
const grid = (bars, text) => text.repeat(bars).split("").map(c => c === "x" ? 1 : c === "o" ? 0.6 : 0)
const notesLoop = (bpm, bars, voice, notes) => () => {
    const sixteenth = 60 / bpm / 4, out = signal(bars * 16 * sixteenth)
    for (const [step, note, length] of notes) {
        const hit = voice(note, length * sixteenth)
        mix(out, hit, frames(step * sixteenth))
    }
    return out
}
const bassVoice = (note, seconds) => {
    const raw = biquad(saw(seconds + 0.05, hzOf(midiOf(note))), "lowpass", 900, 3)
    return raw.map((v, i) => v * Math.min(1, i / frames(0.003)) * Math.min(1, (raw.length - i) / frames(0.03)) * Math.exp(-i / RATE / 0.4))
}
const chordLoop = (bpm, chords) => () => {
    const bar = 60 / bpm * 4, left = signal(bar * chords.length), right = signal(bar * chords.length)
    chords.forEach((notes, index) => {
        const [l, r] = pad(notes, bar + 0.4)()
        mix(left, l, frames(index * bar)); mix(right, r, frames(index * bar))
    })
    return [left, right]
}

// --- Impulse responses: noise in three bands decaying at different rates (highs die first), stereo.

const ir = (seconds, rt60, {early = [], bright = 1, predelay = 0} = {}) => () => [11, 12].map(seed => {
    const out = signal(seconds), source = noise(seconds, seed)
    const decay = rt => source.map((v, i) => v * Math.exp(-6.9 * i / RATE / rt))
    mix(out, biquad(decay(rt60), "lowpass", 500), frames(predelay))
    mix(out, biquad(decay(rt60 * 0.75), "bandpass", 2000, 0.5), frames(predelay), 0.8 * bright)
    mix(out, biquad(decay(rt60 * 0.45 * bright), "highpass", 5000), frames(predelay), 0.5 * bright)
    out[0] = 1
    for (const [at, gain] of early) {out[frames(at + (seed === 12 ? 0.0013 : 0))] += gain}
    return out
})
const cabinet = () => {
    const click = signal(0.03)
    click[0] = 1
    return mono(biquad(biquad(biquad(click, "highpass", 90), "lowpass", 4200, 1.4), "bandpass", 1800, 0.7)
        .map((v, i) => v + click[i] * 0.2))
}

// --- Vinyl: hiss, crackle and the odd pop, seamless (filtered over two passes, the second one kept), stereo.

const vinyl = seconds => () => {
    const length = frames(seconds)
    const twice = data => Float32Array.from({length: length * 2}, (_, i) => data[i % length])
    const seamless = (data, filter) => filter(twice(data)).slice(length)
    const events = (rate, seed) => {
        const next = random(seed), out = signal(seconds)
        for (let i = 0; i < length; i++) {if (Math.abs(next()) < rate / RATE) {out[i] = next() * Math.abs(next()) ** 2}}
        return out
    }
    const crackle = seamless(events(22, 21), data => biquad(biquad(data, "highpass", 1500), "lowpass", 9000))
    const pops = seamless(events(0.6, 22), data => biquad(data, "lowpass", 900, 2))
    return [31, 32].map((seed, channel) => {
        const hiss = seamless(noise(seconds, seed), data => biquad(biquad(data, "highpass", 400), "lowpass", 7000))
        const pan = channel === 0 ? 0.8 : 1.2 // a little width, crackle mostly centred
        return hiss.map((value, i) => value * 0.035 + crackle[i] * 2.5 * pan + pops[i] * 4 * (2 - pan))
    })
}

const BPM = 120, BoomBap = 90
const recipes = {
    kick808: () => mono(kick808()), kickPunch: () => mono(kickPunch()), snare: () => mono(snare()),
    clap: () => mono(clap()), rim: () => mono(rim()), hatClosed: () => mono(hatClosed()), hatOpen: () => mono(hatOpen()),
    tomLow: () => mono(tom(130, 85)()), tomMid: () => mono(tom(180, 120)()), tomHigh: () => mono(tom(260, 175)()),
    cowbell: () => mono(cowbell()), crash: () => mono(crash()),
    subBassC1: () => mono(subBass("C1")()), sawBassC1: () => mono(sawBass("C1")()), pluckC3: () => mono(pluck("C3")()),
    padC2: pad(["C2", "G2", "C3", "E3"]), stabCm7: () => mono(stab(["C2", "D#2", "G2", "A#2"])()),
    drums120: () => mono(loop(BPM, 2, [
        [kickPunch, grid(2, "x...x...x...x...")],
        [clap, grid(2, "....x.......x...")],
        [hatClosed, grid(2, "x.o.x.o.x.o.x.o."), 0.5],
        [hatOpen, grid(2, "..x...x...x...x."), 0.35]])()),
    drums90: () => mono(loop(BoomBap, 2, [
        [kick808, [...grid(1, "x.....x...x....."), ...grid(1, "x.......x.x.....")]],
        [snare, grid(2, "....x.......x...")],
        [hatClosed, grid(2, "x.x.x.x.x.x.x.xo"), 0.45]])()),
    perc120: () => mono(loop(BPM, 2, [
        [rim, grid(2, "..x..x....x..x..")],
        [cowbell, [...grid(1, "x.......x......."), ...grid(1, "x.......x...x...")], 0.5],
        [tom(260, 175), grid(2, "...........x...."), 0.6],
        [tom(180, 120), grid(2, ".............x.."), 0.6]])()),
    bass120: () => mono(notesLoop(BPM, 2, bassVoice, [
        [0, "A0", 3], [3, "A0", 1], [6, "A1", 2], [8, "A0", 2], [11, "C1", 2], [14, "E1", 2],
        [16, "F0", 3], [19, "F0", 1], [22, "F1", 2], [24, "G0", 2], [27, "G0", 2], [30, "B0", 2]])()),
    chords120: chordLoop(BPM, [["A1", "E2", "A2", "C3"], ["F1", "C2", "F2", "A2"], ["C2", "G2", "C3", "E3"],
        ["G1", "D2", "G2", "B2"]]),
    irRoom: ir(0.8, 0.45, {early: [[0.007, 0.5], [0.013, 0.35], [0.019, 0.25], [0.029, 0.15]]}),
    irPlate: ir(2.5, 1.8, {bright: 1.4}),
    irHall: ir(4, 2.8, {early: [[0.021, 0.3], [0.037, 0.2]], bright: 0.8, predelay: 0.02}),
    irCabinet: cabinet,
    vinyl: vinyl(8)
}

const sources = JSON.parse(readFileSync("sources.json", "utf8"))
for (const sample of sources.samples.filter(sample => sample.source.synth !== undefined)) {
    const recipe = recipes[sample.source.synth]
    if (recipe === undefined) {throw new Error(`${sample.id}: no recipe '${sample.source.synth}'`)}
    const path = `samples/${sample.file}`
    mkdirSync(dirname(path), {recursive: true})
    writeWav(path, normalize(recipe(), sample.kind === "impulse response" ? -0.1 : -1))
    console.log(`synth  ${path}`)
}
