# Audio engine core

## Scope
AudioContext lifecycle, engine construction, the widget interface, voices, envelopes and smoothing. The output stage is in `audio-safety.md`. The synthesis algorithms are in `synthesis-conventions.md` and the per-type `synthesis-*.md` docs.

## Creating the AudioContext in Next.js
- During `next build` with `output: 'export'`, every page is prerendered in Node, where `AudioContext` and `window` do not exist. `new AudioContext()` never runs at module scope or during render.
- The engine lives in modules imported only by `'use client'` components. The context is created **lazily, inside a user-gesture handler**.
- The context is not created in `useEffect`:
  - Effects run without a gesture, so the context typically starts `suspended` under autoplay policy. Chrome may allow it based on prior engagement; Firefox follows the user's autoplay settings. Code does not rely on either outcome.
  - React Strict Mode runs effects twice in dev, which creates two contexts.
```ts
// src/audio/context.js — imported only from client components
let ctx: AudioContext | null = null;
export function ensureRunning({ latencyHint = 'interactive' } = {}): Promise<AudioContext> {
  if (!ctx) {
    if ('audioSession' in navigator) (navigator as any).audioSession.type = 'playback'; // iOS 17+: bypass ringer switch
    ctx = new AudioContext({ latencyHint });
  }
  const resumed = ctx.state !== 'running' ? ctx.resume() : Promise.resolve(); // called synchronously in the gesture
  return resumed.then(() => ctx);
}
```
- `ensureRunning()` only creates and resumes the context. It does not build the master bus: the caller builds exactly one bus per context with `buildMasterBus(ctx, { realtime: true, masterGain: 0 })` (`audio-safety.md`), keeps it for the life of the context, and calls `bus.fadeIn(level)` once the engine exists (and again after each resume), because a realtime bus starts with `masterGain` at 0.
- `ensureRunning()` is called from the first Add Synth, Play, Connect MIDI Device or Play with Keyboard click. `resume()` is called before any `await`, which keeps user activation.
- The start notice and master fade-in in `audio-safety.md` apply to the first start.
- `ctx.onstatechange`:
  - When the state becomes `suspended` or `interrupted`, the UI shows the error state "Audio paused — tap to resume" with a button that calls `resume()`.
  - `interrupted` is defined in the Web Audio spec. Safari uses it on iOS (e.g. a phone call or screen lock); Chrome 136+ uses it on desktop, Android and WebView (e.g. exclusive audio access by a VoIP app, laptop lid closed). `resume()` may not succeed until the interruption ends; the button stays available.
- **iOS ringer switch:**
  - Web Audio plays on the "ambient" channel, which the silent switch mutes.
  - Setting `navigator.audioSession.type = 'playback'` moves it to the playback channel. `navigator.audioSession` shipped in Safari 16.4; the silent-switch bypass with `'playback'` is documented from iOS 17. Chrome and Firefox do not implement the API.
  - It is set **before** the context is created, behind feature detection.
  - On iOS ≤ 16 there is no workaround; the UI states that the silent switch mutes audio.

## Sample rate
- `sampleRate` is not passed. The context uses the hardware default; code reads `ctx.sampleRate` (commonly 44100 or 48000).
- WebKit has a history of resampling and distortion bugs when the context rate differs from the hardware rate:
  - Bug 154538: distortion after the sample rate changes.
  - Bug 274507: iPadOS 17.5 regression, distortion with a 44100 Hz context plus an AudioWorklet.
  - Bug 219201: poor resampling quality with the `sampleRate` option.
- Every algorithm derives its constants (delay lengths, grain sizes) from `ctx.sampleRate`. 44100 is never hard-coded.

## Render quantum
- The default is 128 frames per block (2.67 ms at 48 kHz).
- Web Audio 1.1 adds a `renderSizeHint` option, shipping in Chrome 153. It is not passed, so the quantum stays at the 128-frame default; worklets still read the actual array length (`audioworklet.md`).

## Engine construction
```
voice → widget.output (volume × mute/solo × polyGain) → [insert chain] → mixBus → [master chain] → masterGain → safety stage → destination
```
- `buildMasterBus(ctx)` builds `mixBus`, `masterGain` and the safety stage; values and the full chain are in `audio-safety.md`.
- Insert and master effect chains are `fx-chain` AudioWorklet nodes (`effects.md`). Parameter modulation is specified in `modulation.md`.
- `buildEngine(ctx: BaseAudioContext, seed: number)` (`src/audio/engine.js`) builds the master bus and one instrument per widget from rack state. The offline render (`recording.md`) uses it; the live page builds the bus itself and constructs `new Engine(ctx, bus, opts)` (`bindings.md`, Audio host). Both paths create the same graph.
- `seed` initializes every `mulberry32` PRNG (`src/audio/random.js`) used by instruments. Audio code does not call `Math.random()`.
- Per-voice headroom: velocity gain ≤ 0.3 before widget volume.
- The engine caps each widget's `volumeDb` at 0 dB itself (non-numbers count as Off), so no caller can boost an instrument above unity.
- `latencyHint` is `'interactive'` by default; `ensureRunning({ latencyHint })` chooses another value. `'playback'` increases output latency in exchange for fewer dropouts, which delays live parameter changes and live input. The hint applies when the context is created; a call that finds the context already open keeps its hint until `closeContext()`.

## Common widget interface
```ts
interface Instrument {
  readonly type: 'subtractive' | 'fm' | 'additive' | 'pluck' | 'granular';
  readonly output: GainNode;                        // connected to mixBus by the rack
  noteOn(pitch: number, velocity: number, time: number, source: string): void;
  noteOff(pitch: number, time: number, source: string): void;  // may be called with a future time
  allNotesOff(time: number): void;                  // fast release, also cancels future-start voices
  setParam(name: string, value: number | number[] | string): void; // value already validated/clamped
  getParams(): Record<string, unknown>;
  dispose(): void;                                  // stop + disconnect everything
  // Voice control (bindings.md, Instrument contracts); absent on pluck
  setVoicePitch?(source: string, pitch: number, glideMs: number): void;
  setVoicePan?(source: string, pan: number): void;
  setVoiceMod?(source: string, mods: Record<string, number>): void;
  /** Envelope value 0–1 (relative to the velocity peak) of the newest voice tagged `source` at `time` (default now), or null. */
  voiceEnv(source: string, time?: number): number | null;
}
```
- `source` is an opaque string tag compared with `===`. The binding runtime uses `sky:<bindingId>:<objectId>` and `trig:<bindingId>` (`bindings.md`, Voice identity).
- `setVoicePitch` glides the newest unreleased voice tagged `source` to `pitch` (plus the instrument's tuning shift, clamped to 0–127) through the oscillator `detune` with `setTargetAtTime(cents, now, glideMs / 3000)`; FM glides carrier and modulator together and rescales the index depth. Granular voices change pitch at the next grain. The voice keeps its played pitch for `noteOff` matching.
- `setVoicePan` inserts a `StereoPannerNode` (equal power) between the voice's envelope and `polyNode` on the first call, then moves `pan` with τ = 10 ms. An unpanned voice is up-mixed to both channels at full level; a panned voice at the centre is 3 dB lower per channel.
- `setVoiceMod` is specified in `modulation.md` (Per-voice values).
- Pluck voices live in one worklet node, so pluck implements none of the three; the binding runtime uses its fallbacks. Pluck `voiceEnv` follows the T60 decay and release model.
- `noteOff(pitch, time, source)` releases the **oldest active voice with that pitch and source** that started before `time` and has no release scheduled yet. Retriggered same-pitch notes scheduled in advance therefore release in order.
- Voices are tagged with `source`, so a live note and a file note on the same pitch in the same widget release independently.
- `setParam` applies to new voices and, for continuous parameters, to sounding voices through smoothing (below).
- Mute, solo, volume, part and live arming belong to the rack layer, not the instrument (`midi-playback-scheduling.md`, `live-input.md`).
- Instruments accept any `BaseAudioContext`, so the same code renders in an `OfflineAudioContext` (`recording.md`).

## Voices, polyphony, stealing
- A voice is a short-lived subgraph (sources plus an envelope gain):
  - Created at `noteOn`, destroyed after release.
  - Source nodes are single-use: `start()` can be called only once.
- Pluck is the exception: its voices live inside one AudioWorkletNode (`audioworklet.md`).
- Caps (project limits):
  - Max 16 voices per widget. Granular: 4 voices (`synthesis-granular.md`).
  - Max 64 voices globally.
- Stealing order:
  1. The oldest voice in release.
  2. The oldest held voice.
- A stolen voice gets a 5 ms fade (`setTargetAtTime(0, t, 0.0015)`) and `stop(t + 0.02)`.
- Occupancy is computed from scheduled note-on and note-off times, not from `ctx.currentTime`, so allocation behaves the same in offline renders.
- Each widget output applies `polyGain` (`audio-safety.md`).
- Cleanup:
  - `src.onended = () => { src.disconnect(); env.disconnect(); voices.delete(v) }`.
  - Nodes that are neither connected nor playing are garbage-collected. Long-lived connections that are not disconnected leak memory.

## Click-free envelopes
- `.value` is never set directly while audio is playing; all changes are scheduled automation.
- Attack:
  - `g.setValueAtTime(0, t); g.linearRampToValueAtTime(peak, t + attack)`.
  - Minimum attack 0.002 s.
- Decay and sustain (subtractive, FM and additive; ADSR):
  - With sustain < 1, `g.setTargetAtTime(sustain * peak, t + attack, decay / 3)` follows the attack. Sustain 1 (the default) is the plain AR shape.
  - Sustain is clamped to [0, 1], so the peak is always the velocity gain; decay only lowers the level.
  - The envelope model adds `sustain` and `decayTau`; `envValueAt` returns `s·peak + (peak − s·peak)·e^(−(t − tA)/decayTau)` after the attack, so a release during the decay starts from the right level in the Firefox fallback too.
  - Granular and pluck keep their own shapes (AR bus envelope; T60 decay and release in the worklet).
- Release:
  - `setTargetAtTime(0, tOff, release / 3)`. Each time constant moves another 63.2% toward the target; a third of the desired duration gets ~95% of the way.
  - Then `stop(tOff + release * 1.5 + 0.05)`.
  - Minimum release 0.01 s.
- `exponentialRampToValueAtTime` with a target of 0 throws `RangeError`. Ramping from 0 (or across a sign change) does not throw: the value holds until the end time, then jumps. Exponential ramps therefore start and end at a floor of `0.0001`, or `setTargetAtTime` is used instead.
- **`cancelAndHoldAtTime`:**
  - Supported in Chromium (since M57) and Safari.
  - **Not implemented in Firefox** (Mozilla bug 1308431); MDN lists the method as not Baseline.
  - It is feature-detected before use.
  - `cancelScheduledValues(t)` + `setValueAtTime(param.value, t)` is incorrect for a future `t`: `param.value` is the current value, not the value at `t`.
  - The fallback computes the envelope value at `t` from the voice's envelope model (attack start, peak, attack time).
  - `cancelScheduledValues(t)` also removes a linear ramp that ends after `t`. When `t` falls inside the attack, the fallback re-creates the ramp with `linearRampToValueAtTime(valueAtT, t)` instead of `setValueAtTime`, so the level follows the attack up to `t` rather than holding the earlier value and jumping.
```ts
function holdAt(p: AudioParam, t: number, valueAtT: number) {
  if (typeof (p as any).cancelAndHoldAtTime === 'function') (p as any).cancelAndHoldAtTime(t);
  else { p.cancelScheduledValues(t); p.setValueAtTime(valueAtT, t); }
}
function envValueAt(v: Voice, t: number) {          // before a release (see envelope.js)
  const x = (t - v.start) / v.attack;
  if (x < 1) return Math.max(0, x) * v.peak;           // linear attack
  const s = v.sustain ?? 1;
  if (s >= 1) return v.peak;
  return s * v.peak + (1 - s) * v.peak * Math.exp(-(t - v.start - v.attack) / v.decayTau);
}
// release:
holdAt(v.env.gain, tOff, envValueAt(v, tOff));
v.env.gain.setTargetAtTime(0, tOff, v.release / 3);
```

## Parameter smoothing
- Live changes (cutoff, FM index, volume) use `param.setTargetAtTime(value, ctx.currentTime, 0.01)`, a 10 ms time constant that avoids zipper noise.
- Slider `input` events are coalesced: the latest value is applied once per animation frame.
- `setValueCurveAtTime` is not used for live changes; it throws when it overlaps other automation events.

## Engine interface
`Engine` (`src/audio/engine.js`) is constructed as `new Engine(ctx, bus, { seed, realtime, lookahead, maxTime, ks, onFault, onError })`.

| Method | Effect |
|---|---|
| `sync(widgets, { rampIn })` | Creates, updates and removes instruments to match the widget list; re-resolves effect wiring and modulation routes |
| `get(id)` | The instrument for a widget id, or `null` |
| `pump(until)` | Granular grain scheduling, control-rate modulation, scheduled LFO sources and held data posts; call every 25 ms |
| `releaseAll(t)`, `fadeOutAll(t)`, `panic(t)` | Release every voice; fade widget outputs; release and reset every effect chain |
| `flush()` | Resolves when pluck and chain worklets have received every earlier message (offline renders) |
| `rebuild(type)` | Recreates instruments (and resets effect chains) after a fault |
| `setTempo`, `setFx`, `setFxParam`, `setFxBypass`, `onFxFault` | `effects.md`, Engine API |
| `setLfos`, `setMods`, `postModValue`, `modulatedValue` | `modulation.md`, Engine API |
| `level(id)`, `spectrum(id, bands)`, `voiceEnv(id, source)` | Analysis taps (below) |
| `dispose()` | Stops and disconnects everything the engine created and restores `mixBus → masterGain` |

### Analysis taps
- `level(id)` returns the RMS level of the instrument's output (after volume and mute, before its insert chain) as `clamp((20·log10(rms) + 60) / 60, 0, 1)`: −60 dBFS and below is 0, 0 dBFS is 1. It returns `null` for an unknown id or an instrument that could not be built.
- `spectrum(id, bands)` returns `bands` values (rounded and clamped to 4–32) in 0–1: the mean `getByteFrequencyData` value / 255 over log-spaced bands from 40 Hz to min(16 kHz, fs / 2), using the analyser's default −100…−30 dB scale. A band narrower than one bin reads the nearest bin.
- `voiceEnv(id, source)` returns the instrument's `voiceEnv(source)`.
- The first `level` or `spectrum` call for an instrument creates one `AnalyserNode` (`fftSize` 1024, `smoothingTimeConstant` 0.5) connected from its output. The analyser is a sink: it is not connected onward, so it does not change the signal path, and the safety stage still follows every output. An instrument has at most one analyser; it moves to a rebuilt instrument and is disconnected when the instrument is removed.
- Reads are cached per instrument and recomputed at most once per 16 ms of context time, so callers may ask every animation frame without extra cost.

## Teardown
- Widget removal: `allNotesOff(now)`, then `dispose()` after 50 ms (disconnect the output; `port.close()` on worklets).
- The context stays open for the session. It is closed only by "Restart Audio" after a safety-stage error (`audio-safety.md`); the next gesture creates a new one.

## Sources
- MDN, AudioParam.cancelAndHoldAtTime (https://developer.mozilla.org/en-US/docs/Web/API/AudioParam/cancelAndHoldAtTime)
- Mozilla Bugzilla 1308431, "Implement cancelAndHoldAtTime" (https://bugzilla.mozilla.org/show_bug.cgi?id=1308431)
- MDN, setTargetAtTime / exponentialRampToValueAtTime (https://developer.mozilla.org/en-US/docs/Web/API/AudioParam/setTargetAtTime)
- MDN, Navigator.audioSession and AudioSession.type (https://developer.mozilla.org/en-US/docs/Web/API/Navigator/audioSession)
- W3C Audio Session API explainer (https://github.com/w3c/audio-session/blob/main/explainer.md)
- W3C Web Audio API 1.1 (https://www.w3.org/TR/webaudio-1.1/)
- WebKit bugs 154538, 274507, 219201 (https://bugs.webkit.org/)
