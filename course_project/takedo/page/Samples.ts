// TakeDo's own sample collections, served by the studio from samples/ (`make samples`, pinned sources; the folder is
// bind-mounted at /sample-collections). openDAW keeps the samples a project uses in the browser's storage (OPFS) and, when
// one is missing, asks its sample provider; opendaw.patch puts this first in that chain, so a TakeDo sample comes back
// from samples/ whenever the browser has lost it (another origin, cleared site data, a new machine): reinstallable at
// any time. They're listed in openDAW's sample browser too. Fixed UUIDs (knowledge/import/samples.mjs).
import {UUID} from "@opendaw/lib-std"
import {type AudioData, WavFile} from "@opendaw/lib-dsp"
import type {Sample, Soundfont, SoundfontMetaData} from "@opendaw/studio-adapters"

export type TakeDoSample = {
    uuid: string, file: string, collection: string, machine: string | null, role: string | null, name: string,
    sample_rate: number, duration: number
}

const Root = "/sample-collections"
export type TakeDoSoundfont = { uuid: string, file: string, name: string, about: string, size: number }

let manifest: Promise<{ samples: ReadonlyArray<TakeDoSample>, soundfonts: ReadonlyArray<TakeDoSoundfont> }> | null = null
const loaded = () => {
    manifest ??= fetch(`${Root}/manifest.json`)
        .then(response => response.ok ? response.json() : {})
        .then(json => ({samples: json.samples ?? [], soundfonts: json.soundfonts ?? []}))
        .catch(() => ({samples: [], soundfonts: []}))
    return manifest
}

export const takedoSamples = async (): Promise<ReadonlyArray<TakeDoSample>> => (await loaded()).samples
const fileUrl = (file: string) => `${Root}/${file.split("/").map(encodeURIComponent).join("/")}`

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
    const response = await fetch(fileUrl(sample.file))
    if (!response.ok) {throw new Error(`TakeDo sample ${sample.file}: ${response.status} (run make samples)`)}
    const audio = WavFile.decodeFloats(await response.arrayBuffer())
    progress(1)
    return [audio, {...asSample(sample), duration: audio.numberOfFrames / audio.sampleRate, sample_rate: audio.sampleRate}]
}

// Soundfonts (GeneralUser GS, and copies of openDAW's own under their UUIDs), the same way: listed in openDAW's
// soundfont browser, and loaded from samples/ before openDAW's servers are asked.
const asSoundfont = (font: TakeDoSoundfont): Soundfont => ({uuid: font.uuid as Soundfont["uuid"], name: font.name, size: font.size,
    url: fileUrl(font.file), license: font.about, origin: "import"})

export const takedoSoundfontList = async (): Promise<ReadonlyArray<Soundfont>> => (await loaded()).soundfonts.map(asSoundfont)

export const loadTakedoSoundfont = async (uuid: UUID.Bytes, progress: (value: number) => void): Promise<[ArrayBuffer, SoundfontMetaData] | null> => {
    const id = UUID.toString(uuid)
    const font = (await loaded()).soundfonts.find(candidate => candidate.uuid === id)
    if (font === undefined) {return null}
    const response = await fetch(fileUrl(font.file))
    if (!response.ok) {return null}
    const buffer = await response.arrayBuffer()
    progress(1)
    const {uuid: _uuid, ...meta} = asSoundfont(font)
    return [buffer, meta]
}
