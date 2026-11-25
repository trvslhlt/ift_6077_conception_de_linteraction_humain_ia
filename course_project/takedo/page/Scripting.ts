import * as Std from "@opendaw/lib-std"
import {PPQN, ppqn} from "@opendaw/lib-dsp"
import * as Adapters from "@opendaw/studio-adapters"
import * as Core from "@opendaw/studio-core"
import type {Project} from "@opendaw/studio-core"

// The open path's environment (STRATEGY.md, "Keep the open path"): what a script or a look gets as `takedo`. The
// project and openDAW's libraries as they are, plus TakeDo's refs and bar arithmetic, so scripts and the snapshot
// speak the same language. Looks run outside any edit, so openDAW refuses their writes.

export type ScriptEnv = {
    project: Project
    api: Project["api"]
    lib: { std: typeof Std, dsp: { PPQN: typeof PPQN }, adapters: typeof Adapters, core: typeof Core }
    ref(ref: string): unknown                       // t1 → its AudioUnitBoxAdapter, t1.fx1 → the effect's adapter, r1 → the region's adapter
    bar: ppqn                                       // pulses per bar (960 per quarter note)
    ppqn(pos: string): ppqn                         // "5.1.1" → pulses
    pos(position: ppqn): string                     // pulses → "5.1.1"
    snapshot(): unknown                             // the outline snapshot agents read
}

const MaxChars = 6000

// A script's or look's result as JSON for the model: cycles cut, class instances named rather than walked (an
// adapter's graph is huge), long output truncated.
export const serialize = (value: unknown): string => {
    const seen = new WeakSet<object>()
    const text = JSON.stringify(value, function (_key, entry: unknown) {
        if (typeof entry === "bigint") {return entry.toString()}
        if (typeof entry === "function") {return "[function]"}
        if (entry instanceof Uint8Array) {return "[bytes]"}
        if (entry === null || typeof entry !== "object") {return entry}
        if (seen.has(entry)) {return "[cycle]"}
        seen.add(entry)
        const name = entry.constructor?.name
        if (name !== undefined && name !== "Object" && name !== "Array") {return `[${name}]`}
        return entry
    })
    if (text === undefined) {return "undefined"}
    return text.length > MaxChars ? `${text.slice(0, MaxChars)}… (truncated, ${text.length} chars)` : text
}

// The transport is the producer's (decided 2026-11-24): play, stop, record and the playhead. A script or a look gets the
// project with those calls refused, so one that tries fails (a script is rolled back) and the agent hears why. Looks
// need it too: the transport isn't a project edit, so openDAW wouldn't refuse it outside one.
const EngineTransport = new Set(["play", "stop", "setPosition", "prepareRecordingState", "stopRecording", "restart"])
const ProjectTransport = new Set(["startRecording", "stopRecording", "restartRecording"])
const refuse = (name: string) => (): never => {
    throw new Error(`not applied: ${name} is the producer's: play, stop, recording and the playhead's position stay theirs`)
}
const bound = (target: object, key: string | symbol): unknown => {
    const value = Reflect.get(target, key, target)
    return typeof value === "function" ? value.bind(target) : value
}
// A part taken out is parked, not deleted (decided 2026-11-25, the producer: create new elements and park unused ones):
// a dial or a later request can bring it back, and a take keeps it. So the project's API refuses deleting a track.
const parkInstead = (): never => {
    throw new Error("not applied: parts aren't deleted, they're parked so they can come back: mute the track " +
        "(ref(\"t3\").namedParameter.mute.setValue(true)) and switch off its instrument and effects " +
        "(ref(\"t3\").inputAdapter.ifSome(input => input.box.enabled.setValue(false)); ref(\"t3.fx1\").enabledField.setValue(false))")
}
export const withoutDeleting = (api: Project["api"]): Project["api"] => new Proxy(api, {get: (target, key) =>
    key === "deleteAudioUnit" ? parkInstead : bound(target, key)})
export const withoutTransport = (project: Project): Project => {
    const engine = new Proxy(project.engine, {get: (target, key) =>
        typeof key === "string" && EngineTransport.has(key) ? refuse(`engine.${key}`) : bound(target, key)})
    const api = withoutDeleting(project.api)
    return new Proxy(project, {get: (target, key) => key === "engine" ? engine : key === "api" ? api
        : typeof key === "string" && ProjectTransport.has(key) ? refuse(`project.${key}`) : bound(target, key)})
}

export const scriptEnv = (project: Project, resolve: (ref: string) => unknown, snapshot: () => unknown,
                          bar: () => ppqn, pos: (position: ppqn) => string): ScriptEnv => ({
    project: withoutTransport(project), api: withoutDeleting(project.api),
    lib: {std: Std, dsp: {PPQN}, adapters: Adapters, core: Core},
    ref: resolve,
    get bar() {return bar()},
    ppqn: (text: string) => {
        const [bars, beats = 1, sixteenths = 1] = text.split(".").map(Number)
        const [nominator, denominator] = [project.timelineBox.signature.nominator.getValue(),
            project.timelineBox.signature.denominator.getValue()]
        return (bars - 1) * PPQN.fromSignature(nominator, denominator) + (beats - 1) * PPQN.fromSignature(1, denominator)
            + (sixteenths - 1) * PPQN.SemiQuaver
    },
    pos,
    snapshot
})

// Runs a function body with `takedo` in scope, and its parts as plain names too (project, api, lib, ref, bar, ppqn,
// pos, snapshot), since models write either, in a block of their own so a script may declare those names itself.
// Async for looks (they may await); scripts are synchronous, since they run inside one edit.
const Names = ["takedo", "project", "api", "lib", "ref", "bar", "ppqn", "pos", "snapshot"]
const values = (env: ScriptEnv) => [env, env.project, env.api, env.lib, env.ref, env.bar, env.ppqn, env.pos, env.snapshot]
export const runLook = (code: string, env: ScriptEnv): Promise<unknown> =>
    new Function(...Names, `return (async () => {\n${code}\n})()`)(...values(env))
export const runScript = (code: string, env: ScriptEnv): unknown => new Function(...Names, `{\n${code}\n}`)(...values(env))
