# Audio effects

## Scope
Effect types, their parameters, the effect chain worklet, its placement in the engine graph, its message protocol, slot safety rules and limits. The effect kernels come from assignment 3 (`victor-almaraz/mpcs-51238-assignment-3`, `src/dsp/effects/`). Modulation of effect parameters is specified in `modulation.md`.

## Components
| Component | Job | Location |
|---|---|---|
| Effect kernel | Processes one stereo block in place for one effect type | `src/audio/fx/effects/<type>.js` |
| Effect registry | Maps an effect type to its `ParamDef` list and kernel class | `src/audio/fx/effects/registry.js` |
| `EffectSlot` | Wraps one kernel with bypass crossfade and fault detection | `src/audio/fx/effects/chain.js` |
| Chain processor | Runs up to 8 slots and the modulation matrix for one chain | `public/worklets/fx-chain.js`, processor name `fx-chain` |
| Engine FX API | Creates, configures and tears down chains | `src/audio/engine.js` |

Kernels, `EffectSlot` and the registry are plain JavaScript with no Web Audio dependency. Node tests run them directly.

## Effect types
Values are plain units. `scale` determines normalization (`modulation.md`). Parameters marked "set only" accept `setFxParam` and `follow` bindings but not modulation routes. Parameters marked "down" accept modulation that lowers the value only.

### `eq3`
Low shelf, peak and high shelf biquads in series (RBJ cookbook, transposed direct form II).

| Param | Range | Default | Unit | Scale | Modulation |
|---|---|---|---|---|---|
| `lowFreq` | 30–500 | 120 | Hz | log | yes |
| `lowGain` | −18–18 | 0 | dB | lin | yes |
| `midFreq` | 200–8000 | 1000 | Hz | log | yes |
| `midGain` | −18–18 | 0 | dB | lin | yes |
| `midQ` | 0.3–8 | 0.7 | | log | yes |
| `highFreq` | 2000–16000 | 8000 | Hz | log | yes |
| `highGain` | −18–18 | 0 | dB | lin | yes |

### `filter`
Topology-preserving-transform state-variable filter per channel. A mode change crossfades outputs over the smoothing time constant.

| Param | Range | Default | Unit | Scale | Modulation |
|---|---|---|---|---|---|
| `mode` | `lowpass`, `highpass`, `bandpass` | `lowpass` | | enum | set only |
| `cutoff` | 20–20000 | 2000 | Hz | log | yes |
| `resonance` | 0.5–12 | 0.707 | Q | log | yes |

### `compressor`
Feed-forward, log-domain, stereo-linked, soft knee 6 dB.

| Param | Range | Default | Unit | Scale | Modulation |
|---|---|---|---|---|---|
| `threshold` | −60–0 | −18 | dB | lin | yes |
| `ratio` | 1–20 | 4 | :1 | log | yes |
| `attack` | 0.1–100 | 10 | ms | log | yes |
| `release` | 10–1000 | 120 | ms | log | yes |
| `makeup` | 0–24 | 0 | dB | lin | down |

### `saturation`
`tanh` with first-order antiderivative anti-aliasing (ADAA) and a one-pole tone lowpass.

| Param | Range | Default | Unit | Scale | Modulation |
|---|---|---|---|---|---|
| `drive` | 0–36 | 6 | dB | lin | yes |
| `tone` | 1000–16000 | 8000 | Hz | log | yes |
| `mix` | 0–1 | 1 | fraction | lin | yes |
| `output` | −24–6 | −3 | dB | lin | down |

### `distortion`
Waveshaper with first-order ADAA, a tone lowpass and a 10 Hz DC blocker. `|f| ≤ 1` for every curve.

| Param | Range | Default | Unit | Scale | Modulation |
|---|---|---|---|---|---|
| `mode` | `softclip`, `hardclip`, `foldback` | `softclip` | | enum | set only |
| `drive` | 0–48 | 12 | dB | lin | yes |
| `bias` | −0.5–0.5 | 0 | | lin | yes |
| `tone` | 500–16000 | 6000 | Hz | log | yes |
| `mix` | 0–1 | 1 | fraction | lin | yes |
| `output` | −36–0 | −6 | dB | lin | down |

### `delay`
Stereo feedback delay with interpolated read, one-pole high-cut in the loop and 2 s ring buffer. Delay time is smoothed with τ = 50 ms.

| Param | Range | Default | Unit | Scale | Modulation |
|---|---|---|---|---|---|
| `time` | 1–2000 | 375 | ms | log | yes |
| `sync` | `off`, `1/32` … `1/1` with dotted (`d`) and triplet (`t`) variants | `off` | | enum | set only |
| `feedback` | 0–0.9 | 0.35 | fraction | lin | yes |
| `highCut` | 1000–20000 | 8000 | Hz | log | yes |
| `mix` | 0–1 | 0.3 | fraction | lin | yes |

When `sync` is not `off`, delay time is `beats · 60 / tempo`, capped at 2000 ms. `tempo` is a chain setting (protocol below).

### `reverb`
Freeverb: 8 parallel lowpass-feedback combs into 4 series allpasses per channel, with pre-delay.

| Param | Range | Default | Unit | Scale | Modulation |
|---|---|---|---|---|---|
| `size` | 0–1 | 0.75 | fraction | lin | yes |
| `decay` | 0.2–10 | 2 | s | log | yes |
| `damping` | 0–1 | 0.5 | fraction | lin | yes |
| `preDelay` | 0–200 | 10 | ms | lin | yes |
| `mix` | 0–1 | 0.25 | fraction | lin | yes |

Each kernel's header comment in `src/audio/fx/effects/` states its equations.

## Graph
```
voice → widget.output → [insert chain] → mixBus → [master chain] → masterGain → safety stage → destination
```
- Each instrument has at most one insert chain, connected between its widget output and `mixBus`. An instrument without effects has no chain node.
- The master chain sits between `mixBus` and `masterGain`. The safety stage (`audio-safety.md`) follows every chain.
- Each chain is one `AudioWorkletNode` with `numberOfInputs: 1`, `numberOfOutputs: 1`, `outputChannelCount: [2]`, `channelCount: 2`, `channelCountMode: 'explicit'`, `channelInterpretation: 'speakers'`. A mono input is up-mixed to both channels.
- All AudioWorklet nodes of a context render on one audio thread. Separate chain nodes add graph overhead and no parallelism.
- `buildEngine` loads `/worklets/fx-chain.js` with `ctx.audioWorklet.addModule` before creating chains. The offline render (`recording.md`) loads the same module into its `OfflineAudioContext`, so live and offline output match.

## Chain processor
### Real-time rules
The chain processor follows the real-time rules of assignment 3's `a3-audio-implementation.md`:
1. `process()` and everything it calls allocate nothing. Message handlers may allocate; they build structures that `process()` swaps in at the next quantum.
2. Frames are processed in chunks of at most `BLOCK` (128). The frame count comes from `outputs[0][0].length`.
3. Per-sample code calls no `Math.pow`, `Math.exp`, `Math.log` or `Math.tan`, except where a kernel's header documents it.
4. Recursive state is flushed below `1e-15` at block end.
5. No kernel or processor reads wall-clock time. State depends only on frames processed and messages applied.
6. Randomness comes only from `mulberry32`, seeded through `hash32(seed, chainIndex, salt)`.
7. `process()` returns `true`.

### Messages from the engine
| `t` | Fields | Effect |
|---|---|---|
| `slots` | `slots: [{ id, type, params, bypass }]` | Replaces the slot list. `params` holds every parameter of the type (enum values as option indices). Slots with an unchanged `id` and `type` keep their kernel and state; their params move to the given values through smoothing. Other slots are created, with smoothers snapped to the given values; in a chain that has already processed audio a new slot fades in from dry over 10 ms. |
| `param` | `slot`, `name`, `value` | Sets one base value. The kernel clamps it through its `ParamDef`. |
| `bypass` | `slot`, `on` | Bypasses or activates a slot with a 10 ms crossfade |
| `tempo` | `bpm` (20–300), `at` (context seconds) | Sets the tempo used by `sync` params and synced LFOs; synced LFO phases re-anchor at `at` |
| `lfos` | `seed`, `lfos: [{ id, index, shape, rate, phase, smooth, anchorT, anchorPhase, hz }]` | LFO definitions with the engine's phase anchor (`modulation.md`, Sources) |
| `mods` | `routes: [{ slot, name, source, depth }]` | Routes whose target is a slot of this chain, in piece route order |
| `modValue` | `id`, `value` (−1 to 1), `smoothMs`, `snap` | New data value for a data source (`modulation.md`, Data values); `snap: true` also sets the smoothed value, used to start a new chain at the current value |
| `reset` | | Resets every kernel; used by panic |
| `ping` | `id` | Replies `{ t: 'pong', id }` from the message handler; offline renders await it (`audioworklet.md`, Message protocol) |

The engine validates every message before posting it. The processor validates again and ignores invalid messages, reporting `{ t: 'error', code }` once per code.

### Messages to the engine
| `t` | Fields | Meaning |
|---|---|---|
| `fault` | `slot` | The slot reset and bypassed itself (slot rules) |
| `report` | `values: Float32Array` | Current modulated value of every route target of the chain, in the order of the `mods` routes, posted at most every 100 ms (`modulation.md`) |
| `error` | `code` | An invalid message was ignored |
| `pong` | `id` | Reply to `ping` |

### Structure
The processor logic lives in `ChainCore` (`src/audio/fx/chain-core.js`), plain JavaScript that Node tests drive directly. `src/audio/fx/worklet.js` wraps it in the `fx-chain` `AudioWorkletProcessor`. Message handlers run on the audio thread between quanta; they may allocate and they replace the structures `process()` reads.

## Slot rules
- **Bypass:** a bypass change crossfades between dry and wet over 10 ms. A fully bypassed slot does not run its kernel. Leaving full bypass resets the kernel.
- **Fault:** after each chunk the slot computes `e = Σ wet²` over both channels. If `e` is not finite or exceeds `1e12`, the slot resets its kernel, bypasses at once, outputs the dry signal for that chunk, and reports `fault` once. A faulted slot stays bypassed until a `bypass` message with `on: false`.
- **Non-finite input:** a chunk whose input is already non-finite is silenced without running the kernel or reporting a fault, so one bad source does not fault every later slot.
- **Feedback:** every feedback path has loop gain below 1, enforced by parameter ranges (`delay.feedback ≤ 0.9`, reverb comb gain ≤ 0.98).
- **Level:** distortion output is at most 0 dB with `|f| ≤ 1`. Modulation never raises `output` or `makeup` above their base values (`modulation.md`). Their `ParamDef`s carry `mod: { dir: 'down' }`.
- **Removal:** `setFx(owner, [])` bypasses every slot (10 ms crossfade), and 30 ms later reconnects the owner directly and disconnects the chain node. A `setFx` for the same owner within those 30 ms reuses the node.

## Limits
| Item | Limit | `FxLimitError.limit` |
|---|---|---|
| Slots per chain | 8 | `slots` |
| Insert chains | One per instrument (16) | `insert chains` |
| Master chain | 1 | |
| `reverb` slots per piece | 4 | `reverbs` |
| Slot ids | Unique across all chains | `slot ids` |
| Tempo | 20–300 BPM, default 120 | `tempo` |

The engine rejects a configuration over any limit and throws `FxLimitError` (`src/audio/errors.js`) naming the limit. It validates the whole new configuration before changing anything, so a rejected `setFx` leaves every chain as it was. A malformed slot (unknown type, unknown parameter, non-finite value, non-boolean bypass) throws `TypeError`.

## Engine API
```ts
interface FxSlotSpec { id: string; type: EffectType; params: Record<string, number>; bypass: boolean }

interface EngineFx {
  /** Replaces the chain of `owner` ('master' or an instrument id). An empty list removes the chain node. */
  setFx(owner: string, slots: FxSlotSpec[]): void;
  /** Sets one base parameter value of a slot. */
  setFxParam(slotId: string, name: string, value: number): void;
  setFxBypass(slotId: string, on: boolean): void;
  setTempo(bpm: number): void;
  /** Registers a handler for slot faults. */
  onFxFault(fn: (owner: string, slotId: string) => void): void;
}
```
- Slot ids are unique across all chains.
- `params` may omit parameters; omitted ones take their defaults. An enum value is an option index or an option name.
- `setFx` with an unchanged list posts nothing.
- `setFx` for an instrument id that the engine does not have yet stores the chain; the instrument's output connects to it when `sync` creates the instrument. When `sync` removes an instrument, its chain is removed with it.
- `setFxParam` and `setFxBypass` throw `Error` for an unknown slot id. `setFxParam` ignores a non-finite value.
- `engine.panic(t)` releases every voice and posts `reset` to every chain 30 ms later, after the voice fade.
- `dispose` disconnects and closes every chain node and restores `mixBus → masterGain`, so a new engine can reuse the master bus.
- Without the `fx-chain` module (no `audioWorklet`, or loading failed), `setFx` validates and stores the configuration but creates no node; the signal passes dry and `onError` receives one error.

## Porting
Copy from assignment 3 into `src/audio/fx/`:
- `src/dsp/effects/`: `biquad.js`, `chain.js`, `compressor.js`, `delay.js`, `distortion.js`, `eq3.js`, `filter.js`, `registry.js`, `reverb.js`, `saturation.js`, `svf.js`
- `src/dsp/core/`: `constants.js`, `math.js`, `params.js`, `prng.js`, `smoother.js`
- `tests/dsp/effects.test.js`, with import paths adjusted

The effect `ParamDef` format (`id`, `min`, `max`, `default`, `unit`, `scale`, `options`, `step`, `smoothMs`) stays as defined in `src/audio/fx/core/params.js`. `toNorm` and `fromNorm` read only `min`, `max`, `scale` and `step`, so they also accept synth `PARAM_DEFS` entries (`synthesis-conventions.md`).

`public/worklets/fx-chain.js` is a bundled module built from `src/audio/fx/worklet.js` by `node scripts/build-worklets.mjs`. The output is committed; `node scripts/build-worklets.mjs --check` fails when it differs from a fresh build (`audioworklet.md`, Module format).

## Sources
- Assignment 3 repository: `src/dsp/effects/`, `docs/a3-audio-implementation.md` (Real-time rules, Effects), `docs/audio-safety.md`
- R. Bristow-Johnson, Audio EQ Cookbook: https://www.w3.org/TR/audio-eq-cookbook/
- V. Zavalishin, *The Art of VA Filter Design*: https://www.native-instruments.com/fileadmin/ni_media/downloads/pdf/VAFilterDesign_2.1.0.pdf
- J. Parker, V. Zavalishin, E. Le Bivic, "Reducing the Aliasing of Nonlinear Waveshaping Using Continuous-Time Convolution", DAFx-16
- Freeverb (Jezar at Dreampoint), as described by J. O. Smith: https://ccrma.stanford.edu/~jos/pasp/Freeverb.html
- MDN, AudioWorkletNode: https://developer.mozilla.org/en-US/docs/Web/API/AudioWorkletNode
