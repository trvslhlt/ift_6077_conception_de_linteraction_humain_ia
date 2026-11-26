import {type Genre, Genres, type Mood} from "../../shared/protocol.ts"
import type {Sample, Sound} from "./samples.ts"

// Guessed styles and moods for every sound and drum sample (2026-11-26, the producer: put in default guesses for the
// styles, genres and moods, they'll correct them in the Sounds tab). Guesses only: the producer's own, once saved, win.
// Instruments by General MIDI program (GeneralUser GS and its variations), else by words in the name and description;
// drum samples by their machine.

export type Guess = { styles: Genre[], moods: Mood[] }
const guess = (text: string): Guess => {
    const [styles, moods] = text.split("|")
    return {styles: styles.trim().split(/\s+/).filter(word => word !== "") as Genre[], moods: (moods ?? "").trim().split(/\s+/).filter(word => word !== "") as Mood[]}
}

// The 128 General MIDI programs, in order: "styles | moods".
const GeneralMidi: string[] = [
    "jazz lofi pop ambient | warm mellow clean", "pop | bright clean", "pop synthwave | bright vintage", "pop | bright cheesy",
    "lofi jazz boombap house pop | warm mellow vintage", "synthwave pop house | bright clean", " | bright vintage cheesy", "boombap pop | punchy vintage",
    "lofi ambient pop | bright dreamy", "lofi pop ambient | bright", "lofi ambient | dreamy mellow", "jazz lofi | mellow warm",
    "house pop lofi | mellow warm", "pop | bright", "ambient | bright dreamy", " | bright",
    "jazz house boombap | warm vintage", "jazz house | bright vintage", " | gritty vintage", "ambient | dark dreamy",
    " | vintage cheesy", " | vintage cheesy", "boombap | vintage", " | vintage cheesy",
    "lofi jazz boombap | warm mellow", "pop lofi | bright clean", "jazz lofi | warm mellow", "lofi pop house | clean mellow",
    "pop house | punchy clean", " | gritty", " | gritty", "ambient | bright dreamy",
    "jazz lofi boombap | warm mellow", "lofi boombap pop house | warm", "pop | punchy", "lofi jazz | warm mellow",
    "pop | punchy cheesy", "pop | punchy cheesy", "house techno synthwave dnb | punchy", "house techno synthwave | punchy bright",
    "ambient pop | warm", "ambient | warm", "ambient lofi | warm dark", "ambient | dark",
    "ambient trap | dark", "pop | bright", "lofi ambient jazz | dreamy mellow", "trap | dark punchy",
    "ambient pop trap | warm", "ambient pop | warm mellow", "synthwave house ambient | warm vintage", "synthwave | warm vintage",
    "ambient trap | dreamy dark", "lofi ambient | dreamy mellow", "synthwave | dreamy cheesy", "boombap house | punchy vintage cheesy",
    "jazz boombap | bright", "jazz boombap | warm", " | warm", "jazz lofi | mellow",
    "ambient trap | warm dark", "boombap pop | bright punchy", "synthwave house | bright vintage", "synthwave | bright vintage",
    "jazz | bright", "jazz lofi boombap | warm mellow", "jazz boombap lofi | warm", "jazz | warm dark",
    "ambient | mellow", "ambient | mellow", " | warm", "jazz lofi | mellow warm",
    " | bright", "lofi jazz trap ambient | mellow dreamy", " | mellow cheesy", "ambient lofi | dreamy mellow",
    "ambient | dreamy", "lofi ambient | dreamy mellow", " | bright cheesy", "ambient | mellow",
    "synthwave techno house dnb | bright", "synthwave trap techno house dnb | bright", " | cheesy", "synthwave | bright",
    "synthwave | gritty", "synthwave | dreamy", "synthwave techno | bright", "synthwave techno dnb | punchy",
    "ambient | dreamy", "ambient lofi synthwave | warm mellow", "synthwave house | warm vintage", "ambient | dreamy",
    "ambient | dark dreamy", "ambient | dark", "ambient synthwave lofi | dreamy bright", "ambient synthwave | dreamy",
    "ambient | dark", "ambient | dark dreamy", "ambient | bright dreamy", "ambient | dreamy",
    "ambient | bright", " | dark cheesy", "ambient | dreamy dark", "ambient | dark cheesy",
    " | bright", " | bright cheesy", " | bright", "lofi ambient | mellow",
    "lofi ambient | mellow warm", " | cheesy", " | bright", " | cheesy",
    "ambient | bright", " | bright", " | bright cheesy", " | bright",
    "trap | punchy dark", " | punchy", "synthwave | punchy cheesy", "trap | dark",
    "", "", "", "", "", "", "", ""
]

// Words in a sound's name or description, for openDAW's factory presets and the other soundfonts.
const Words: Array<[RegExp, string]> = [
    [/rhodes|e-?piano|soft piano/i, "lofi jazz boombap house | warm mellow vintage"],
    [/upright piano|piano/i, "lofi jazz pop ambient | warm mellow"],
    [/harp/i, "lofi ambient | dreamy mellow"],
    [/organ|leslie|b3|drawbar/i, "jazz house boombap | warm vintage"],
    [/classical guitar|steel string|guitar/i, "lofi jazz pop | warm mellow"],
    [/xylophone|vibra|glas|bimmel|dingl|hollow/i, "lofi ambient pop | bright"],
    [/house bass/i, "house techno | punchy"],
    [/square bass|woofer/i, "house techno dnb synthwave | punchy"],
    [/303|tb-|acid/i, "techno house | gritty"],
    [/bass|dream|galaxy|glenda/i, "house synthwave lofi | warm"],
    [/pad|shimmer|curved air|ice|thoughts|wow|string/i, "ambient synthwave lofi | dreamy warm"],
    [/brass/i, "synthwave house | bright vintage"],
    [/pan ?pipe|flute/i, "lofi ambient | mellow dreamy"],
    [/square|retro|zelda|bounce|pluck/i, "synthwave | bright cheesy"],
    [/lead|stoned/i, "synthwave techno | bright"],
]

export const guessSound = (sound: Sound): Guess => {
    if (sound.source === "soundfont" && sound.soundfont === "GeneralUser GS") {
        if (sound.bank >= 120) {
            const name = sound.preset.toLowerCase()
            return guess(/808|909|electronic/.test(name) ? "trap house techno synthwave dnb | punchy"
                : /dance/.test(name) ? "house techno | punchy" : /jazz|brush/.test(name) ? "jazz lofi | warm mellow"
                : /room/.test(name) ? "lofi boombap jazz | warm vintage" : /power/.test(name) ? "pop synthwave | punchy"
                : /orchestra/.test(name) ? "ambient | dark" : /sfx/.test(name) ? " | cheesy" : "pop boombap | clean")
        }
        if (sound.program >= 0 && sound.program < 128) {return guess(GeneralMidi[sound.program])}
    }
    const text = `${sound.preset} ${sound.about ?? ""}`
    const found = Words.find(([words]) => words.test(text))
    return found === undefined ? {styles: [], moods: []} : guess(found[1])
}

// Drum machines by name: what they're known for.
const Machines: Array<[RegExp, string]> = [
    [/TR808|TR-808/i, "trap boombap synthwave | punchy dark"],
    [/TR909/i, "house techno | punchy bright"],
    [/TR707|TR727|TR626|TR505/i, "house synthwave pop | punchy vintage"],
    [/TR606|MC303|MC202|R70|R8\b|D110|D70|JD990|MT32|S50|DDR30|SH09|System100/i, "techno house pop | clean"],
    [/MPC60|SP12|SP1200|MPC1000|MPC2000|MPC3000|S950|S900/i, "boombap lofi | gritty vintage"],
    [/Linn|LM1|LM2|DMX|Drumulator|Emu/i, "synthwave pop | punchy vintage"],
    [/Compurhythm|CR78|CR-78|Minipops|RhythmAce|KR55|KPR77|Rhythm/i, "lofi synthwave | vintage warm"],
    [/CasioRZ1|CasioSK1|CasioVL1|Casio/i, "lofi | vintage cheesy"],
    [/Alesis|HR16|SR16|DR550|DR660|DR220|DR110|DR55|Boss/i, "pop boombap | clean"],
    [/Korg|M1|T3|Poly800|DDM110|KRZ/i, "house pop | clean"],
    [/XR10|AJK|MFB|Doepfer|Moog|Oberheim/i, "techno synthwave | punchy"],
]
export const guessDrum = (sample: Sample): Guess => {
    const machine = sample.machine ?? ""
    const found = Machines.find(([words]) => words.test(machine))
    const base = found === undefined ? {styles: [], moods: []} : guess(found[1])
    // A long kick is a boomy 808-style one, for trap.
    if (sample.role === "kick" && sample.duration > 1 && !base.styles.includes("trap")) {base.styles = [...base.styles, "trap"]}
    return base
}

// The styles a knowledge entry's tags name ("lo-fi", "boom bap", "80s").
const Synonyms: Record<string, Genre> = {lofihiphop: "lofi", boombap: "boombap", hiphop: "boombap", drumandbass: "dnb", drill: "trap",
    "80s": "synthwave", synthpop: "synthwave", deephouse: "house", ambient: "ambient"}
export const genresOf = (tags: string[]): Genre[] => [...new Set(tags.flatMap(tag => {
    const plain = tag.toLowerCase().replace(/[^a-z0-9]/g, "")
    const genre = Genres.find(one => one === plain) ?? Synonyms[plain]
    return genre === undefined ? [] : [genre]
}))]

// The styles a piece of text names ("evolve this into a lofi girl beat", "boom-bap drums").
export const genresIn = (text: string): Genre[] => {
    const plain = text.toLowerCase().replace(/lo[- ]?fi/g, "lofi").replace(/boom[- ]?bap/g, "boombap").replace(/drum (and|&|n) bass|d&b/g, "dnb")
        .replace(/synth[- ]?wave|synth[- ]?pop/g, "synthwave")
    return genresOf(plain.split(/[^a-z0-9&]+/))
}
