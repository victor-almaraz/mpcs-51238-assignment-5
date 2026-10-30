# AudioWorklet

## Scope
AudioWorklet processors: file layout, loading in a static Next.js export, real-time rules, and the pluck processor (`ks-processor`). The pluck DSP algorithm is in `synthesis-pluck.md`.

| Processor | File | Spec |
|---|---|---|
| `safety-limiter` | `public/worklets/safety-limiter.js` | `audio-safety.md` |
| `ks-processor` | `public/worklets/ks-processor.js` | this doc, `synthesis-pluck.md` |
| `recorder` | `public/worklets/recorder.js` | `recording.md` |

## Availability
- `AudioWorklet` and `AudioWorkletNode` ship in all current engines (Safari since 14.1).
- `BaseAudioContext.audioWorklet` is **only exposed in secure contexts**:
  - Vercel serves HTTPS, and `http://localhost` counts as secure.
  - A LAN IP (`http://192.168.x.x`) is not secure; phones are tested on the Vercel preview URL.
- WebKit bug 274507 (iPadOS 17.5 regression): distortion with a 44100 Hz context plus an AudioWorklet. `sampleRate` is not forced (`audio-engine-core.md`).

## File placement in Next.js (static export)
- Next.js bundlers (Turbopack/webpack) do not emit worklet modules cleanly, so processors live **outside the bundle** in `public/worklets/`, served at `/worklets/<name>.js`. `output: 'export'` copies them into `out/`.
- Modules are loaded once per context, `AudioContext` and `OfflineAudioContext` alike. `safety-limiter` loads first; no widget connects to the master bus until it is ready (`audio-safety.md`).
```ts
// src/audio/worklet-loader.js
const MODULES = ['safety-limiter', 'ks-processor', 'recorder'] as const;
const VERSION = 1;
const loaded = new WeakMap<BaseAudioContext, Promise<void>>();

export function loadWorklets(ctx: BaseAudioContext): Promise<void> {
  let p = loaded.get(ctx);
  if (!p) {
    p = MODULES.reduce(
      (chain, name) => chain.then(() => ctx.audioWorklet.addModule(`/worklets/${name}.js?v=${VERSION}`)),
      Promise.resolve(),
    );
    loaded.set(ctx, p);
  }
  return p;
}
```
- With a `basePath` in `next.config`, URLs carry the prefix. `addModule` resolves relative to the document, so paths are absolute.
- `VERSION` is incremented whenever a processor changes, because Vercel caches static assets.
- Failure handling:
  - `safety-limiter` fails: the fallback stage is used (`audio-safety.md`).
  - `ks-processor` fails: the Pluck option is disabled in the Add Synth menu with "Pluck unavailable in this browser"; other widgets work.
  - `recorder` fails: Record is disabled with the reason; offline render is unaffected.
- The Pluck widget shows "Loading pluck engine…" until loading resolves.

## Module format
- Processor files are plain JavaScript. ES module syntax is allowed; the files have no imports.
- Processor files are not under `src/`, where Next would compile them (`repo-structure.md`).

## Pluck processor structure
```js
// public/worklets/ks-processor.js
const MAX_VOICES = 16;
class KSProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'damping',    defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'brightness', defaultValue: 0.7, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }
  constructor() {
    super();
    // `sampleRate` and `currentFrame`/`currentTime` are globals in AudioWorkletGlobalScope
    const maxLen = Math.ceil(sampleRate / 20) + 4;       // lowest note ≈ 20 Hz
    this.voices = Array.from({ length: MAX_VOICES }, () => ({
      buf: new Float32Array(maxLen), M: 0, idx: 0, C: 0, apX1: 0, apY1: 0, rho: 0,
      active: false, startFrame: 0, releaseFrame: Infinity, pitch: -1, source: 'file', age: 0, dcX1: 0, dcY1: 0,
    }));
    this.queue = [];                                       // pending note events, small
    this.port.onmessage = (e) => this.queue.push(e.data);  // {type:'on'|'off'|'allOff', pitch, vel, time, decay, source}
  }
  process(inputs, outputs, parameters) {
    const out = outputs[0][0];
    const n = out.length;                                  // don't hard-code 128
    // 1) drain queue entries whose frame falls in [currentFrame, currentFrame+n)
    // 2) render each active voice sample-by-sample, starting at its startFrame offset
    // 3) copy channel 0 into other channels if outputChannelCount > 1
    return true;                                           // keep alive; node is long-lived
  }
}
registerProcessor('ks-processor', KSProcessor);
```
- Node creation: `new AudioWorkletNode(ctx, 'ks-processor', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] })`, connected to the widget's output gain.
- **One node per Pluck widget**, polyphonic inside. One node per voice would add node setup and a message round-trip to every note.

## Message protocol
- Main thread to processor: `node.port.postMessage({ type: 'on', pitch, vel, time, decay, source })`. `source` is `'file'` or `'live'`; `off` matches voices by pitch and source. `time` is in AudioContext seconds.
- `on`:
  - The processor converts with `frame = Math.round(time * sampleRate)` and starts the voice when `currentFrame + i === frame` (sample-accurate).
  - Messages arrive asynchronously; the 100 ms scheduler lookahead absorbs the delay in realtime.
  - **Offline renders need a barrier.** An `OfflineAudioContext` renders faster than real time and can finish before the messages arrive, which leaves notes posted before the render silent. `{type:'ping', id}` makes the processor reply `{type:'pong', id}` from `onmessage`; ports are ordered, so the pong proves that every message sent before the ping is queued. `Pluck.flush()` / `Engine.flush()` resolve on the pong (or after 1 s, so a missing reply never hangs), and every offline render awaits it before `startRendering()` and before each `resume()` after a `suspend()` (`offline-render.js`, the safety and core test pages).
  - Late events (`frame < currentFrame`) start at offset 0.
- `off` (with `release`): sets `releaseFrame`; from then on the loop gain is `min(ρ, 10^(−3/(release·f)))` (`synthesis-pluck.md`).
- `allOff`: deactivates all voices at the next block (sent by `allNotesOff`).
- Parameters:
  - `damping` and `brightness` are AudioParams: `node.parameters.get('damping').setTargetAtTime(...)`.
  - Per-note values (decay, pick position; release on note-off) travel in the message.
  - k-rate params arrive as `parameters.damping[0]`.
  - An a-rate param's array may have length 1 when the value is constant for the block, or the block length otherwise; k-rate arrays always have length 1. Code handles both lengths.

## Real-time safety rules
These rules apply to every processor.
- No allocation in `process()`: no `new`, array or object literals, closures, `push` or string building. Buffers are preallocated in the constructor. Exceptions: `postMessage` on rare state changes, and chunk transfer in `recorder` (`recording.md`).
- Incoming messages are queued in `onmessage`, outside `process()`, and drained in `process()` with index loops.
- No `console.log` in `process()` outside debugging.
- Block length is read from the output array, never hard-coded to 128.
- Noise uses `mulberry32` seeded from `processorOptions.seed` (`audio-engine-core.md`); `Math.random()` is not used.
- Denormals: state values below 1e-20 are flushed to 0. A pluck voice whose peak stays below 1e-6 for a full loop pass becomes inactive; its buffer is zeroed on reuse.
- Non-finite samples: `ks-processor` zeroes its delay lines and posts `{type:'fault'}` (`audio-safety.md`).
- An exception in `process()` silences the node permanently and fires `processorerror`. Every node has an `onprocessorerror` handler that shows the error state.
- `process()` returns `true`; nodes are long-lived.

## Debugging
- Chrome and Firefox DevTools show worklet `console` output and support breakpoints in the worklet script.
- Processor output depends only on state, inputs and seeded noise, so `OfflineAudioContext` renders are reproducible.

## Sources
- MDN, Using AudioWorklet (https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API/Using_AudioWorklet)
- MDN, AudioWorkletNode (secure-context note) (https://developer.mozilla.org/en-US/docs/Web/API/AudioWorkletNode)
- MDN, Worklet.addModule (https://developer.mozilla.org/en-US/docs/Web/API/Worklet/addModule)
- mdn/browser-compat-data issue #17550, Safari AudioWorklet 14.1 (https://github.com/mdn/browser-compat-data/issues/17550)
- Next.js docs, Static Exports (https://nextjs.org/docs/pages/guides/static-exports)
- WebKit bug 274507 (https://bugs.webkit.org/show_bug.cgi?id=274507)
