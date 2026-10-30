# Synthesis: granular

## Scope
The granular instrument. Shared rules are in `synthesis-conventions.md`; voices in `audio-engine-core.md`; the lookahead timer in `midi-playback-scheduling.md`.

## Flow per grain
`AudioBufferSourceNode(sourceBuffer, offset, playbackRate) → Gain(window) → voice bus Gain(env) → output`

## Parameters
| Param | Range | Default | Unit | Scale |
|---|---|---|---|---|
| source | 'saw', 'noise', 'chord', 'sample' (shown as "File") | saw | generated buffer or the user's sample | radio |
| position | 0 – 1 | 0.5 | where grains are centred in the buffer | lin, step 0.01 |
| grain size | 0.01 – 0.25 | 0.06 | s | log |
| density | 2 – 60 | 20 | grains/s per voice | log |
| spray | 0 – 1 | 0.2 | fraction of buffer randomised | lin |
| pitch spread | 0 – 1200 | 0 | cents; each grain detuned by up to ± this | lin, step 1 |
| attack | 0.002 – 2 | 0.05 | s (voice bus) | pow3 |
| release | 0.01 – 4 | 0.4 | s (voice bus) | pow3 |

## Generated source
- At widget creation, a 2-second mono `AudioBuffer` at `ctx.sampleRate` is filled with one of: a sawtooth at 261.63 Hz (C4), white noise (seeded `mulberry32`), or a summed triad.
- The sawtooth is naive (not alias-free).

## User sample
- Selecting the "File" source shows "Load File…" under Source, which opens a file picker (`audio/*`). The row is hidden for the other sources; a loaded sample is kept while they are selected.
- `decodeSample` (`src/audio/sample.js`) decodes it with `OfflineAudioContext.decodeAudioData` (48 kHz; no running context needed), then `conditionSample` makes it safe and comparable to the generated sources (`audio-safety.md` "User samples"):
  - files over 4 MB are refused; audio past 20 s is dropped;
  - channels are mixed to mono, non-finite samples become 0;
  - DC is removed (mean, then a 10 Hz one-pole high-pass);
  - 5 ms fades at both ends;
  - the level is set to peak 1, but lowered so the RMS never exceeds 1/√3 (a full-scale saw or noise); a file whose peak is under −80 dBFS is refused as silent.
- The sample is treated as pitched at C4, like the saw.
- The buffer lives on the widget (`widget.sample = { name, buffer, seconds }`), survives remove/undo and patch undo, and is used by offline render. It is never written to patches; a patch stores `sampleName` only, and loading it asks for the file again (`patch-format.md`).
- With "File" selected and no sample loaded, the widget is silent and the card says "No file loaded: silent".

## Pitch
`playbackRate = f / 261.63`. The noise source ignores pitch; only spray and density shape it. Pitch spread multiplies each grain's rate by `2^(r · spread / 1200)` with `r` uniform in [−1, 1]; the extra random draw happens only when spread > 0, so spread 0 leaves every other grain's random values unchanged.

## Scheduling
- Grains are scheduled by the transport's lookahead timer, or per window by `scheduleRange` in offline mode (`midi-playback-scheduling.md`).
- Each held voice emits grains at intervals of `1/density`, jittered ±20%.
- Jitter and offset randomness use the widget's seeded `mulberry32` (`rand()` below), so offline renders are reproducible.
- Each grain: `src.start(t, offset, size)`, with a triangular window (each side ≥ 2 ms; guaranteed by the 10 ms minimum grain size): `gain.setValueAtTime(0,t); linearRampToValueAtTime(1, t+size/2); linearRampToValueAtTime(0, t+size)`.
- Offset: `position · (bufferDuration − size) + (rand()−0.5) · spray · bufferDuration`, clamped to `[0, bufferDuration − size]`. Position 0.5 is the buffer centre.

## Density limits (project limits)
- Concurrent grains per voice ≈ `density × size` (60 × 0.25 = 15).
- Concurrent grains per widget are capped at 64. Past the cap, new grains are skipped; existing grains are not stolen.
- Voice cap for this type: 4.
- Each grain creates 2 nodes; 64 concurrent grains means 1000+ node creations per second. This is the highest CPU load in the app, most significant on mobile.

## Voice envelope
- The voice bus gain uses the attack and release params (defaults 0.05 s and 0.4 s).
- Grains continue until the release completes.

## Pitfalls
- Grains that fall inside the lookahead window but after noteOff + release are not scheduled.
- `start()` with an offset beyond the buffer plays nothing; offsets are clamped.

## Sources
- MDN, AudioBufferSourceNode.start (https://developer.mozilla.org/en-US/docs/Web/API/AudioBufferSourceNode/start)
- C. Roads, Microsound (MIT Press, 2001)
