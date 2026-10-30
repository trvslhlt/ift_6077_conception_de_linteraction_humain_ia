// Shared by the library scripts: WAV reading and writing, and the few DSP pieces they need (a seeded random source,
// biquad filters, an FFT). Audio is an array of Float32Array channels at RATE.
import {readFileSync, writeFileSync} from "node:fs"

export const RATE = 48000

// 16-bit PCM or 32-bit float, any channel count.
export const readWav = path => {
    const buffer = readFileSync(path)
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    let offset = 12, format, channels, rate, bits
    while (offset < buffer.length) {
        const id = buffer.toString("ascii", offset, offset + 4)
        const size = view.getUint32(offset + 4, true)
        if (id === "fmt ") {
            format = view.getUint16(offset + 8, true)
            channels = view.getUint16(offset + 10, true)
            rate = view.getUint32(offset + 12, true)
            bits = view.getUint16(offset + 22, true)
        } else if (id === "data") {
            const bytes = bits / 8
            const frames = Math.floor(size / (bytes * channels))
            const data = Array.from({length: channels}, () => new Float32Array(frames))
            for (let frame = 0; frame < frames; frame++) {
                for (let channel = 0; channel < channels; channel++) {
                    const at = offset + 8 + (frame * channels + channel) * bytes
                    data[channel][frame] = format === 3 ? view.getFloat32(at, true) : view.getInt16(at, true) / 32768
                }
            }
            return {rate, channels: data}
        }
        offset += 8 + size + (size % 2)
    }
    throw new Error(`${path}: no data chunk`)
}

// 16-bit PCM.
export const writeWav = (path, channels) => {
    const frames = channels[0].length
    const buffer = Buffer.alloc(44 + frames * channels.length * 2)
    const view = new DataView(buffer.buffer)
    buffer.write("RIFF", 0, "ascii")
    view.setUint32(4, 36 + frames * channels.length * 2, true)
    buffer.write("WAVEfmt ", 8, "ascii")
    view.setUint32(16, 16, true)
    view.setUint16(20, 1, true)
    view.setUint16(22, channels.length, true)
    view.setUint32(24, RATE, true)
    view.setUint32(28, RATE * channels.length * 2, true)
    view.setUint16(32, channels.length * 2, true)
    view.setUint16(34, 16, true)
    buffer.write("data", 36, "ascii")
    view.setUint32(40, frames * channels.length * 2, true)
    for (let frame = 0; frame < frames; frame++) {
        for (let channel = 0; channel < channels.length; channel++) {
            const value = Math.max(-1, Math.min(1, channels[channel][frame]))
            view.setInt16(44 + (frame * channels.length + channel) * 2, Math.round(value * 32767), true)
        }
    }
    writeFileSync(path, buffer)
}

export const peak = channels => channels.reduce((max, data) => data.reduce((m, v) => Math.max(m, Math.abs(v)), max), 0)

// Scales to a peak of `db` dBFS.
export const normalize = (channels, db = -1) => {
    const gain = 10 ** (db / 20) / (peak(channels) || 1)
    return channels.map(data => data.map(value => value * gain))
}

// Mulberry32: the same sequence for the same seed, so synthesized samples are reproducible.
export const random = seed => () => {
    seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296 * 2 - 1
}

// RBJ cookbook biquad, run over a whole signal.
export const biquad = (data, type, frequency, q = Math.SQRT1_2) => {
    const w = 2 * Math.PI * frequency / RATE, alpha = Math.sin(w) / (2 * q), cos = Math.cos(w)
    const [b0, b1, b2] = type === "lowpass" ? [(1 - cos) / 2, 1 - cos, (1 - cos) / 2]
        : type === "highpass" ? [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2]
            : [alpha, 0, -alpha] // bandpass, 0 dB peak
    const a0 = 1 + alpha, a1 = -2 * cos, a2 = 1 - alpha
    const out = new Float32Array(data.length)
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0
    for (let i = 0; i < data.length; i++) {
        const y = (b0 * data[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0
        x2 = x1; x1 = data[i]; y2 = y1; y1 = y
        out[i] = y
    }
    return out
}

// In-place radix-2 FFT; re and im have a power-of-two length.
export const fft = (re, im) => {
    const n = re.length
    for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1
        for (; j & bit; bit >>= 1) {j ^= bit}
        j ^= bit
        if (i < j) {[re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]}
    }
    for (let size = 2; size <= n; size <<= 1) {
        const angle = -2 * Math.PI / size
        for (let start = 0; start < n; start += size) {
            for (let k = 0; k < size / 2; k++) {
                const c = Math.cos(angle * k), s = Math.sin(angle * k)
                const a = start + k, b = a + size / 2
                const tr = re[b] * c - im[b] * s, ti = re[b] * s + im[b] * c
                re[b] = re[a] - tr; im[b] = im[a] - ti
                re[a] += tr; im[a] += ti
            }
        }
    }
}

export const NoteNames = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
// MIDI note number from a name like "C3" or "F#2", in openDAW's naming: C3 = MIDI 60 (middle C, 261.6 Hz).
export const midiOf = name => {
    const [, letter, octave] = name.match(/^([A-G]#?)(-?\d)$/)
    return NoteNames.indexOf(letter) + (Number(octave) + 2) * 12
}
export const nameOf = midi => `${NoteNames[midi % 12]}${Math.floor(midi / 12) - 2}`
export const hzOf = midi => 440 * 2 ** ((midi - 69) / 12)
