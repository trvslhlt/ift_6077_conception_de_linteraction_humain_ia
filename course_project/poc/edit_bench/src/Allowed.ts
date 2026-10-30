import {InstrumentFactories, InstrumentFactory} from "@opendaw/studio-adapters"
import {EffectFactories, EffectFactory} from "@opendaw/studio-core"

// The devices agents may add, as decided in project_plan/STRATEGY.md ("Agents change devices"): every device whose
// use agents can learn from openDAW's manual and the catalog. Left out, since what they do depends on something
// undocumented: WebCLAP (third-party plugins), MIDI Output (external hardware), Apparat, Spielwerk and Werkstatt
// (user scripts) and Tone3000 (amp models downloaded from tone3000.com).

export const AllowedInstruments: ReadonlyArray<InstrumentFactory> = [InstrumentFactories.Tubular,
    InstrumentFactories.Neon, InstrumentFactories.Cubed, InstrumentFactories.Korpus, InstrumentFactories.Nano,
    InstrumentFactories.Playfield, InstrumentFactories.Soundfont, InstrumentFactories.Tape,
    InstrumentFactories.InstrumentComposite, InstrumentFactories.Vaporisateur]

export const AllowedMidiEffects: ReadonlyArray<EffectFactory> = [EffectFactories.Arpeggio, EffectFactories.Pitch,
    EffectFactories.Velocity, EffectFactories.Zeitgeist]

export const AllowedAudioEffects: ReadonlyArray<EffectFactory> = [EffectFactories.StereoTool, EffectFactories.Delay,
    EffectFactories.Reverb, EffectFactories.DattorroReverb, EffectFactories.Compressor, EffectFactories.Crusher,
    EffectFactories.Tidal, EffectFactories.Autotune, EffectFactories.Fold, EffectFactories.Gate,
    EffectFactories.Maximizer, EffectFactories.Revamp, EffectFactories.Waveshaper, EffectFactories.Convolver,
    EffectFactories.Vocoder, EffectFactories.Sink, EffectFactories.AudioEffectComposite,
    EffectFactories.StereoComposite, EffectFactories.FrequencySplit]

// Allowed, but silent or empty until given content: samples (from an index agents can read), layers or a
// destination. Check 7 swaps only through the other instruments, ending on Vaporisateur for its lane case.
export const NeedsContent: ReadonlyArray<InstrumentFactory> = [InstrumentFactories.Nano, InstrumentFactories.Playfield,
    InstrumentFactories.Soundfont, InstrumentFactories.Tape, InstrumentFactories.InstrumentComposite]

export const isAllowed = (factory: InstrumentFactory | EffectFactory): boolean =>
    [...AllowedInstruments, ...AllowedMidiEffects, ...AllowedAudioEffects].includes(factory)
