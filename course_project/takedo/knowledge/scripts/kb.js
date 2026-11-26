// The knowledge base's page-side helpers (project_plan/KNOWLEDGE.md, "apply"). The backend prepends this to every
// script it builds from an entry, after `const args = …`, and then calls one helper: `return kb.dx7(args)`. It runs as
// a `run` script does: synchronously, inside one edit, with `takedo` in scope (and its parts: project, api, lib, ref,
// bar, ppqn, pos). The music is worked out in the backend (knowledge.ts): what arrives here is pitches, bytes and
// field values, already checked against the catalog's ranges.
//
// Written 2026-11-12 against openDAW 652e6ca's source, not yet run in the studio.
const kb = (() => {
    const NotesTrack = 1   // TrackType.Notes (studio-adapters/src/timeline/TrackType.ts)
    const unitOf = name => {
        const unit = ref(name)
        if (unit === undefined || unit === null) {throw new Error(`no track ${name}`)}
        return unit
    }
    const deviceOf = unit => unit.inputAdapter.unwrap(`${unit.label} has no instrument`)
    // A nested field by the catalog's path ("oscillators/0/waveform"): arrays of fields are indexed.
    const fieldOf = (box, path) => path.split("/").reduce((node, part) => {
        if (node === undefined) {return undefined}
        return /^\d+$/.test(part) ? node.fields()[Number(part)] : node[part]
    }, box)
    const setFields = (box, settings) => {
        const missing = []
        Object.entries(settings ?? {}).forEach(([path, value]) => {
            const field = fieldOf(box, path)
            if (field === undefined || typeof field.setValue !== "function") {missing.push(path)} else {field.setValue(value)}
        })
        return missing
    }
    const newInstrument = (factory, name, volumeDb) => {
        const make = lib.adapters.InstrumentFactories[factory]
        if (make === undefined) {throw new Error(`no instrument factory ${factory}`)}
        const product = api.createInstrument(make)
        if (name) {product.instrumentBox.label.setValue(name)}
        if (volumeDb !== undefined && volumeDb !== null) {product.audioUnitBox.volume.setValue(volumeDb)}
        return product
    }
    // A new region over [from_bar, from_bar + bars) whose content (loop_bars long) repeats, after clearing that range
    // of the track (openDAW's own clip resolver: regions in the way are cut or removed, as when the user drops one).
    // No from_bar (a jam with the loop off): it starts on the bar the edit lands on (`here`), its pattern from the top.
    const writeNotes = (trackBox, trackAdapter, notes) => {
        const beat = ppqn("1.2.1") - ppqn("1.1.1")
        const position = typeof notes.from_bar === "number" ? (notes.from_bar - 1) * bar : here, duration = notes.bars * bar
        if (trackAdapter !== null) {
            const resolver = lib.core.RegionClipResolver
            if (resolver !== undefined) {
                resolver.fromRange(trackAdapter, position, position + duration)()
            } else if (trackAdapter.regions.collection.asArray().some(r => r.position < position + duration && r.complete > position)) {
                throw new Error("the track has regions in those bars, and this openDAW build doesn't export RegionClipResolver to clear them")
            }
        }
        const region = api.createNoteRegion({trackBox, position, duration,
            loopDuration: Math.min(duration, notes.loop_bars * bar), name: notes.name ?? ""})
        notes.notes.forEach(([start, pitch, length, velocity]) => api.createNoteEvent({owner: region,
            position: Math.round(start * beat), duration: Math.max(1, Math.round(length * beat)), pitch, velocity}))
        return {from: pos(position), bars: notes.bars, notes: notes.notes.length}
    }
    const notesTrackOf = unit => {
        const track = unit.tracks.values().find(candidate => candidate.type === NotesTrack)
        if (track === undefined) {throw new Error(`${unit.label} has no notes track`)}
        return track
    }
    // A sound's tuning (the producer's, from their sound library): effects at the end of the new track's chain, each set
    // by field path; a switch takes 0 or 1. Made with the track, so it never plays untuned.
    const tune = (audioUnitBox, effects) => (effects ?? []).map(({device, settings}) => {
        const factory = lib.core.EffectFactories.AudioNamed[device]
        if (factory === undefined) {throw new Error(`no audio effect ${device}`)}
        const box = api.insertEffect(audioUnitBox.audioEffects, factory)
        Object.entries(settings).forEach(([path, value]) => {
            const field = fieldOf(box, path)
            if (field === undefined || typeof field.setValue !== "function") {return}
            field.setValue(typeof field.getValue() === "boolean" ? value !== 0 : value)
        })
        return device
    })
    const isTubular = box => box.operators !== undefined && box.voiceLoad !== undefined
    return {
        // A DX7 voice (155 bytes) on a track's Tubular, or on a new Tubular track; optionally with notes, written in
        // the same edit so the new part is never heard half-made.
        dx7(args) {
            const preset = lib.adapters.TubularPreset
            if (preset === undefined) {throw new Error("this openDAW build doesn't export TubularPreset")}
            const voice = Uint8Array.from(args.voice)
            if (args.track) {
                const unit = unitOf(args.track), device = deviceOf(unit)
                if (!isTubular(device.box)) {throw new Error(`${unit.label}'s instrument isn't a Tubular: leave track out to add a new Tubular track`)}
                preset.apply(device.box, voice)
                if (args.name) {device.box.label.setValue(args.name)}
                return {track: args.track, voice: args.voice_name, ...(args.notes ? {notes: writeNotes(notesTrackOf(unit).box, notesTrackOf(unit), args.notes)} : {})}
            }
            const {trackBox, instrumentBox} = newInstrument("Tubular", null, args.volume_db)
            preset.apply(instrumentBox, voice)
            instrumentBox.label.setValue(args.name || args.voice_name)
            return {track: "new", name: instrumentBox.label.getValue(), voice: args.voice_name,
                ...(args.notes ? {notes: writeNotes(trackBox, null, args.notes)} : {})}
        },
        // Field settings on a track's instrument, or a new instrument track with them (and optionally notes).
        instrument(args) {
            if (args.track) {
                const unit = unitOf(args.track), device = deviceOf(unit)
                const missing = setFields(device.box, args.settings)
                if (args.name) {device.labelField.setValue(args.name)}
                return {track: args.track, ...(missing.length > 0 ? {not_found: missing} : {}),
                    ...(args.notes ? {notes: writeNotes(notesTrackOf(unit).box, notesTrackOf(unit), args.notes)} : {})}
            }
            const {trackBox, instrumentBox} = newInstrument(args.factory, args.name, args.volume_db)
            const missing = setFields(instrumentBox, args.settings)
            return {track: "new", name: args.name, ...(missing.length > 0 ? {not_found: missing} : {}),
                ...(args.notes ? {notes: writeNotes(trackBox, null, args.notes)} : {})}
        },
        // Notes onto an existing track, replacing what was in those bars.
        pattern(args) {
            const unit = unitOf(args.track), track = notesTrackOf(unit)
            return writeNotes(track.box, track, args.notes)
        },
        // A notes region's notes rewritten in place (generate.ts, morphNotes: one stage of a part changing), so a loop
        // that never reaches a later region still hears it. A region mirrored elsewhere changes there too.
        replaceNotes(args) {
            const region = ref(args.region)
            if (region === null || region === undefined || region.optCollection === undefined) {throw new Error(`no notes region ${args.region}`)}
            const beat = ppqn("1.2.1") - ppqn("1.1.1")
            const collection = region.optCollection.unwrap(`${args.region} has no notes`)
            collection.events.asArray().slice().forEach(event => event.box.delete())
            args.notes.forEach(([start, pitch, length, velocity]) => api.createNoteEvent({owner: region.box,
                position: Math.round(start * beat), duration: Math.max(1, Math.round(length * beat)), pitch, velocity}))
            return {region: args.region, notes: args.notes.length}
        },
        // A compressor on a track keyed from another track's output, so the track ducks when the source plays
        // (openDAW 652e6ca: CompressorDeviceBox's side-chain pointer, as in its AudioUnitFreeze test). Auto makeup
        // off, or it lifts the part back up and undoes the duck.
        sidechain(args) {
            const unit = unitOf(args.track), source = unitOf(args.source)
            if (unit === source) {throw new Error("a track can't duck under itself: give another source")}
            const compressor = api.insertEffect(unit.box.audioEffects, lib.core.EffectFactories.AudioNamed.Compressor)
            compressor.sideChain.refer(source.box)
            compressor.automakeup.setValue(false)
            compressor.threshold.setValue(args.threshold)
            compressor.ratio.setValue(args.ratio)
            compressor.attack.setValue(args.attack)
            compressor.release.setValue(args.release)
            return {track: args.track, keyed_from: args.source, threshold: args.threshold, ratio: args.ratio}
        },
        // A new drum kit track: a Playfield whose pads are TakeDo samples (UUIDs from samples/manifest.json; the studio
        // reloads them from /sample-collections when the browser hasn't got them), optionally with notes. Pads at 60, 61, ...
        kit(args) {
            const uuid = lib.std.UUID.parse
            const product = api.createInstrument(lib.adapters.InstrumentFactories.Playfield, {name: args.name,
                attachment: args.pads.map(pad => ({note: pad.note, uuid: uuid(pad.uuid), name: pad.name,
                    durationInSeconds: pad.duration, exclude: pad.exclude}))})
            if (args.volume_db !== null && args.volume_db !== undefined) {product.audioUnitBox.volume.setValue(args.volume_db)}
            // The producer's tuning per pad (their drum samples): its volume, pitch in cents, how much of the sample plays,
            // and its tone as a Revamp on the pad.
            const padBoxes = product.instrumentBox.samples.pointerHub.incoming().map(pointer => pointer.box)
            args.pads.forEach(pad => {
                const box = padBoxes.find(candidate => candidate.index.getValue() === pad.note)
                if (box === undefined || !pad.tuning) {return}
                box.volume.setValue(pad.tuning.volume)
                box.pitch.setValue(pad.tuning.pitch)
                box.sampleEnd.setValue(pad.tuning.sample_end)
                tune(box, pad.tuning.effects)
            })
            return {track: "new", name: product.instrumentBox.label.getValue(), pads: args.pads.map(pad => `${pad.note} ${pad.name}`),
                ...(args.notes ? {notes: writeNotes(product.trackBox, null, args.notes)} : {})}
        },
        // A new sampler track: a Nano playing one TakeDo sample across the keys, at its own pitch on root_key (an 808 bass
        // is a long TR-808 kick played as notes).
        sampler(args) {
            const id = lib.std.UUID.parse(args.uuid)
            const file = project.boxGraph.findBox(id).unwrapOrElse(() => project.boxGraph.createBox("AudioFileBox", id, box => {
                box.fileName.setValue(args.file_name)
                box.endInSeconds.setValue(args.duration)
            }))
            const product = api.createInstrument(lib.adapters.InstrumentFactories.Nano, {name: args.name, attachment: file})
            product.instrumentBox.rootKey.setValue(args.root_key)
            const missing = setFields(product.instrumentBox, args.settings)
            if (args.volume_db !== null && args.volume_db !== undefined) {product.audioUnitBox.volume.setValue(args.volume_db)}
            return {track: "new", name: product.instrumentBox.label.getValue(), root_key: args.root_key,
                ...(missing.length > 0 ? {not_found: missing} : {}),
                ...(args.notes ? {notes: writeNotes(product.trackBox, null, args.notes)} : {})}
        },
        // A new track on openDAW's Soundfont device playing one preset (index as openDAW lists the file's presets), the
        // file one of TakeDo's (the studio reloads it from /sample-collections) or openDAW's own.
        soundfont(args) {
            const id = lib.std.UUID.parse(args.uuid)
            const file = project.boxGraph.findBox(id).unwrapOrElse(() => project.boxGraph.createBox("SoundfontFileBox", id, box => box.fileName.setValue(args.file_name)))
            const product = api.createInstrument(lib.adapters.InstrumentFactories.Soundfont, {name: args.name, attachment: file})
            product.instrumentBox.presetIndex.setValue(args.preset)
            if (args.volume_db !== null && args.volume_db !== undefined) {product.audioUnitBox.volume.setValue(args.volume_db)}
            const tuned = tune(product.audioUnitBox, args.effects)
            return {track: "new", name: product.instrumentBox.label.getValue(), sound: args.preset_name, ...(tuned.length > 0 ? {effects: tuned} : {}),
                ...(args.notes ? {notes: writeNotes(product.trackBox, null, args.notes)} : {})}
        },
        // One of openDAW's factory presets as a new track (Tubular's FM Rhodes, Neon's house bass): its device made, then
        // the preset's instrument and its own effects put in, the track kept for the notes.
        preset(args) {
            const bytes = takedo.preset(args.uuid)
            if (bytes === null) {throw new Error(`the preset ${args.preset_name} isn't loaded in the page yet; try again in a moment`)}
            const product = newInstrument(args.device, args.name, args.volume_db)
            const attempt = lib.adapters.PresetDecoder.replaceAudioUnit(bytes, product.audioUnitBox, {keepTimeline: true})
            if (attempt.isFailure()) {throw new Error(`the preset ${args.preset_name} didn't apply: ${attempt.failureReason()}`)}
            const input = product.audioUnitBox.input.pointerHub.incoming().at(0)?.box
            if (input !== undefined && args.name) {input.label.setValue(args.name)}
            const tuned = tune(product.audioUnitBox, args.effects)
            return {track: "new", name: args.name, sound: args.preset_name, ...(tuned.length > 0 ? {effects: tuned} : {}),
                ...(args.notes ? {notes: writeNotes(product.trackBox, null, args.notes)} : {})}
        },
        // One of openDAW's effect presets (Large Plate, Soft Wall, Vocal EQ) at the end of a track's effects.
        effectPreset(args) {
            const bytes = takedo.preset(args.uuid)
            if (bytes === null) {throw new Error(`the preset ${args.preset_name} isn't loaded in the page yet; try again in a moment`)}
            const unit = unitOf(args.track)
            const field = unit.box.audioEffects
            const index = field.pointerHub.incoming().length
            const attempt = lib.adapters.PresetDecoder.insertEffectChain(bytes, field, index, lib.adapters.PresetHeader.ChainKind.Audio)
            if (attempt.isFailure()) {throw new Error(`the preset ${args.preset_name} didn't apply: ${attempt.failureReason()}`)}
            return {track: args.track, effect: args.preset_name, at: index + 1}
        },
        tempo(args) {
            api.setBpm(args.bpm)
            return {bpm: project.timelineBox.bpm.getValue()}
        }
    }
})()
