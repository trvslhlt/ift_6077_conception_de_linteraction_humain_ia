import type {Genre, Snapshot, Track} from "../../shared/protocol.ts"
import type {Catalog} from "./catalog.ts"
import type {Library} from "./library.ts"
import {roleOf} from "./mixProfiles.ts"
import {genresIn, guessWords} from "./soundStyles.ts"

// Whether each part's sound is for a style (2026-11-26, the producer: a lofi session kept a 303 acid bass to the end,
// "warmed" by a filter; a style change must look at every part's sound, not only its notes). What a part's sound is
// good for: the producer's library entry for the sound it's named after, else words in its name ("Rhodes", "acid"),
// with its device's genres from the catalog unless the device plays any sound (soundfonts, samplers).

export type SoundFit = { ref: string, name: string, role: string, sound: string, for: Genre[], confirmed: boolean }

const AnySound = new Set(["Soundfont", "Nano", "Playfield", "Tape", "InstrumentComposite", "Apparat", "MIDIOutput", "WclapInstrument"])

export const soundOf = (track: Track, catalog: Catalog, library: Library | null): SoundFit | null => {
    if (track.kind === "bus" || track.device === null || track.instrument === null) {return null}
    const role = roleOf(track)
    const device = track.device.name, key = track.instrument
    const sound = `${key}${device !== "" && device !== key ? ` "${device}"` : ""}`
    const base = {ref: track.ref, name: track.name, role, sound}
    const entry = library?.named([track.name, device]) ?? null
    if (entry !== null && library !== null) {
        const {styles, confirmed} = library.styles(entry)
        return {...base, sound: entry.id, for: styles, confirmed}
    }
    const names = `${track.name} ${device}`
    if (AnySound.has(key)) {
        const words = guessWords(names)
        return words === null ? null : {...base, for: words.styles, confirmed: false}
    }
    const genres = catalog.summary(key)?.genres ?? []
    const words = guessWords(names, false)
    const styles = [...new Set([...genresIn(genres.join(", ")), ...(words?.styles ?? [])])]
    return styles.length === 0 ? null : {...base, for: styles, confirmed: false}
}

// The pitched parts playing (not muted, not drums) whose sound isn't for the style, as lines for the Team Lead.
export const soundsAgainst = (style: Genre, snapshot: Snapshot, catalog: Catalog, library: Library | null): string[] =>
    snapshot.tracks.filter(track => !track.mix.mute).flatMap(track => {
        const fit = soundOf(track, catalog, library)
        if (fit === null || fit.role === "drums" || fit.role === "perc" || fit.for.includes(style)) {return []}
        return [`${fit.ref} ${fit.name} (${fit.role}): ${fit.sound} is for ${fit.for.join(", ")}${fit.confirmed ? " (the producer says)" : ""}, not ${style}`]
    })
