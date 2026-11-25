// TakeDo's own sample collections, served by the studio from samples/ (`make samples`, pinned sources; the folder is
// bind-mounted at /sample-collections). openDAW keeps the samples a project uses in the browser's storage (OPFS) and, when
// one is missing, asks its sample provider; opendaw.patch puts this first in that chain, so a TakeDo sample comes back
// from samples/ whenever the browser has lost it (another origin, cleared site data, a new machine): reinstallable at
// any time. They're listed in openDAW's sample browser too. Fixed UUIDs (knowledge/import/samples.mjs).
import {UUID} from "@opendaw/lib-std"
import {type AudioData, WavFile} from "@opendaw/lib-dsp"
import type {Sample} from "@opendaw/studio-adapters"

export type TakeDoSample = {
    uuid: string, file: string, collection: string, machine: string | null, role: string | null, name: string,
    sample_rate: number, duration: number
}

const Root = "/sample-collections"
let manifest: Promise<ReadonlyArray<TakeDoSample>> | null = null

export const takedoSamples = (): Promise<ReadonlyArray<TakeDoSample>> => {
    manifest ??= fetch(`${Root}/manifest.json`)
        .then(response => response.ok ? response.json() : {samples: []})
        .then(json => (json.samples ?? []) as ReadonlyArray<TakeDoSample>)
        .catch(() => [])
    return manifest
}

const asSample = (sample: TakeDoSample): Sample => ({
    uuid: sample.uuid as Sample["uuid"], name: sample.name, bpm: 0, duration: sample.duration,
    sample_rate: sample.sample_rate, origin: "import", custom: `takedo:${sample.file}`
})

// For openDAW's sample browser (FactoryCatalog), next to its own.
export const takedoSampleList = async (): Promise<ReadonlyArray<Sample>> => (await takedoSamples()).map(asSample)

// The sample with this UUID if it's one of TakeDo's, decoded; null to let openDAW's own provider look for it.
export const loadTakedoSample = async (uuid: UUID.Bytes, progress: (value: number) => void): Promise<[AudioData, Sample] | null> => {
    const id = UUID.toString(uuid)
    const sample = (await takedoSamples()).find(candidate => candidate.uuid === id)
    if (sample === undefined) {return null}
    const response = await fetch(`${Root}/${sample.file.split("/").map(encodeURIComponent).join("/")}`)
    if (!response.ok) {throw new Error(`TakeDo sample ${sample.file}: ${response.status} (run make samples)`)}
    const audio = WavFile.decodeFloats(await response.arrayBuffer())
    progress(1)
    return [audio, {...asSample(sample), duration: audio.numberOfFrames / audio.sampleRate, sample_rate: audio.sampleRate}]
}
