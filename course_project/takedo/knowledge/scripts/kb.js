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
    const writeNotes = (trackBox, trackAdapter, notes) => {
        const beat = ppqn("1.2.1") - ppqn("1.1.1")
        const position = (notes.from_bar - 1) * bar, duration = notes.bars * bar
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
        tempo(args) {
            api.setBpm(args.bpm)
            return {bpm: project.timelineBox.bpm.getValue()}
        }
    }
})()
