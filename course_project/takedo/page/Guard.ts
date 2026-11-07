import {Constraints, Float32Field, Int32Field, type Vertex} from "@opendaw/lib-box"

// Keeps agents' edits inside the ranges openDAW declares for each field. openDAW declares them (box schemas) but
// doesn't enforce them yet (Constraints.clampFloat32/clampInt32 are stubs), and a value outside one can crash the audio
// engine: a Vaporisateur filter with resonance 0 wrote NaN and stopped all sound (2026-11-07). A script's writes are
// checked inside its edit, before it commits; an out-of-range value is brought into range, a non-finite one restored.

export type Correction = { field: string, from: number, to: number }

const finite = (value: number, fallback: number): number => Number.isFinite(value) ? value : fallback

export const fixFloat = (constraints: Constraints.Float32, value: number, previous: number): number => {
    // -Infinity is silence for a decibel field; anything else non-finite goes back to what it was
    if (Number.isNaN(value) || value === Infinity) {return previous}
    if (constraints === "any") {return finite(value, previous)}
    if (constraints === "unipolar") {return Math.min(1, Math.max(0, finite(value, previous)))}
    if (constraints === "bipolar") {return Math.min(1, Math.max(-1, finite(value, previous)))}
    if (constraints === "decibel") {return value}   // a gain: openDAW's UI allows boost, so only non-finite is wrong
    if (constraints === "non-negative") {return Math.max(0, finite(value, previous))}
    if (constraints === "positive") {return value > 0 ? finite(value, previous) : (previous > 0 ? previous : Number.EPSILON)}
    if (constraints.scaling === "decibel" && value === -Infinity) {return value}
    return Math.min(constraints.max, Math.max(constraints.min, finite(value, previous)))
}

export const fixInt = (constraints: Constraints.Int32, value: number, previous: number): number => {
    if (!Number.isFinite(value)) {return previous}
    const whole = Math.round(value)
    if (constraints === "any") {return whole}
    if (constraints === "non-negative" || constraints === "index") {return Math.max(0, whole)}
    if (constraints === "positive") {return Math.max(1, whole)}
    if ("values" in constraints) {
        return constraints.values.reduce((best, option) => Math.abs(option - whole) < Math.abs(best - whole) ? option : best)
    }
    if ("length" in constraints) {return Math.min(constraints.length - 1, Math.max(0, whole))}
    return Math.min(constraints.max, Math.max(constraints.min, whole))
}

// Brings one field into its range; returns the correction made, or null if it was fine.
export const guardField = (vertex: Vertex, previous: unknown): Correction | null => {
    const before = typeof previous === "number" ? previous : 0
    if (vertex instanceof Float32Field) {
        const value = vertex.getValue(), fixed = fixFloat(vertex.constraints, value, before)
        if (Object.is(fixed, value)) {return null}
        vertex.setValue(fixed)
        return {field: vertex.address.toString(), from: value, to: fixed}
    }
    if (vertex instanceof Int32Field) {
        const value = vertex.getValue(), fixed = fixInt(vertex.constraints, value, before)
        if (fixed === value) {return null}
        vertex.setValue(fixed)
        return {field: vertex.address.toString(), from: value, to: fixed}
    }
    return null
}
