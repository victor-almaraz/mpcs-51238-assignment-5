# Modulation

## Scope
Modulation sources (LFOs and data values), routes, the normalized modulation model, evaluation for effect and synth parameters, determinism, limits and the engine API. Effect parameters are listed in `effects.md`; synth parameters in `synthesis-*.md`.

## Terms
| Term | Meaning |
|---|---|
| Base value | A parameter's value set by `setParam`, `setFxParam` or a `follow` binding |
| Source | A signal in −1 to 1: an LFO or a data value |
| Route | One connection from a source to a target parameter with a depth |
| Target | A parameter address: `<instrumentId>.<param>` or `<slotId>.<param>` |
| Depth | Route strength in normalized units, −1 to 1 |
| Modulated value | The value the parameter takes after all routes apply |

## Model
Every modulatable parameter has a `ParamDef` with `min`, `max` and `scale` (`lin`, `log`, `pow3`). Modulation sums in normalized space:
```
u = clamp01( toNorm(def, base) + Σ depthᵢ · sourceᵢ )
modulated = fromNorm(def, u)
```
- Equal depth gives equal perceived change across a parameter's range. On a log parameter spanning 10 octaves (20 Hz–20 kHz), depth 0.1 moves one octave.
- The modulated value never leaves `[min, max]`.
- A route with negative depth inverts its source.
- Parameters marked `down` (`effects.md`; synth defs with `mod.dir: 'down'`) use `u = toNorm(base) − Σ |depthᵢ| · (sourceᵢ + 1)/2`, clamped to `[0, toNorm(base)]`. Modulation of these parameters only lowers the value.
- `enum` parameters and array parameters (additive `harmonics`) are not route targets.

## Source classes
| Class | Engine source | Origin |
|---|---|---|
| LFO | `LfoSpec` | Defined in the piece; computed by the engine |
| VLFO | Data value | Orbital motion, computed in the browser by the orbit propagator and posted with `postModValue` at 2 Hz (`piece-dsl.md`, Orbits) |
| Random walk | Data value | Space weather values, posted when they change |
| Step function | Data value | Element, approach and launch fields, posted when they change |

Triggers are events, not modulation sources; they play notes through bindings. The engine receives every non-LFO class as a data value and applies the same smoothing and model to each.

## Sources
### LFOs
| Field | Values | Default |
|---|---|---|
| `id` | `lfo<n>` | |
| `shape` | `sine`, `triangle`, `square`, `saw`, `random`, `smooth` | `sine` |
| `rate` | 0.01–20 Hz; or a sync value from the `delay.sync` options except `off` | 0.1 Hz |
| `phase` | 0–1 cycle | 0 |
| `retrigger` | `true` restarts the LFO per voice at `noteOn` (synth targets only) | `false` |
| `smooth` | 0–1; one-pole smoothing of `random` and `smooth` steps, as a fraction of the step period | 0.5 for `smooth`, 0 otherwise |

- Bipolar output: `sine`, `triangle`, `square` and `saw` span −1 to 1.
- `random` draws one value per cycle and holds it for the cycle. `smooth` is `random` with smoothing applied.
- A free-running LFO's phase at time `t` is `phase + rate · (t − t₀)`, where `t₀` is the engine start time in context seconds. Chain worklets compute `t` from frames processed. Every instance of one LFO, in any chain or synth route, therefore shares one phase.
- `rate` may itself be a data source mapped to Hz (Data values). Phase accumulates continuously when the rate changes.

### Data values
- A data source has an `id` (`dat<n>`) and a value in −1 to 1, supplied by the binding runtime through `postModValue` at up to 30 Hz.
- The receiver smooths each data source with a one-pole filter, time constant `smoothMs / 3` (default `smoothMs` 250).
- A value outside −1 to 1 is clamped. A non-finite value is ignored.
- VLFO values arrive every 500 ms; their default `smoothMs` of 500 turns the 2 Hz samples into a continuous curve. Their periods (about 90 minutes for low orbits, 12 hours for GPS) are far below the 0.01 Hz minimum LFO rate.

## Evaluation
### Effect targets
- The chain processor evaluates every route of its slots once per 32-frame sub-block and passes the modulated value to `kernel.setParam`.
- The kernel's own smoothing (12 ms, or the `ParamDef` `smoothMs`; delay time 50 ms) applies after modulation. Modulation faster than the smoothing is attenuated.
- LFOs and data sources used by a chain are evaluated inside that chain's processor.

### Synth targets
Each synth `PARAM_DEFS` entry declares how it is modulated:
```ts
type ModDef =
  | { rate: 'audio'; target: string; dir?: 'both' | 'down' }   // native AudioParam path, e.g. 'filter.detune'
  | { rate: 'control'; dir?: 'both' | 'down' }                  // applied in pump()
  | null;                                                       // not modulatable
```
- **Audio rate.** The source node (`OscillatorNode` for periodic LFOs, `ConstantSourceNode` for `random`, `smooth` and data sources) feeds a `GainNode` whose gain is the route depth converted to the target's native unit, and the gain node connects to the target `AudioParam` in each voice.
  - Log parameters are modulated through a `detune` parameter in cents: `gain = depth · log2(max / min) · 1200`.
  - Linear parameters: `gain = depth · (max − min)`.
  - `pow3` parameters are not audio-rate targets; they use the control path.
  - The native path cannot clamp the summed signal. The instrument limits each route's gain so that `toNorm(base) ± Σ |depthᵢ|` stays within 0–1, and recomputes the limit when the base value or a depth changes.
- **Control rate.** `pump()` evaluates the model above every 25 ms and applies the result as the parameter's current value. Granular `density`, `spray` and `pitchSpread`, and pluck worklet parameters, use this path.
- **Voices.** Free-running sources live on the instrument. A voice connects its target parameters to the instrument's route gains at `noteOn` and disconnects them when it ends. A `retrigger` LFO creates one oscillator per voice, started at the voice's `noteOn` time.

### Reports
Each chain processor posts `{ t: 'report', values }` at most every 100 ms, with the modulated value of every routed effect parameter in route order. The engine computes synth targets' modulated values from the model on request. `modulatedValue(target)` returns the latest of either.

## Determinism
- Periodic LFO output depends only on `rate`, `phase` and `t − t₀`.
- `random` and `smooth` draw from `mulberry32(hash32(seed, ownerIndex, lfoIndex))`, where `ownerIndex` is the instrument or chain index in the IR and `lfoIndex` the LFO's index.
- Data values are inputs. A replay of recorded sky changes posts the same values at the same context times, so offline renders of a replay match the live output.

## Limits
| Item | Limit |
|---|---|
| LFOs per piece | 16 |
| `retrigger` LFOs per instrument | 2 |
| Routes per piece | 32 |
| Routes per target | 4 |
| Depth | −1 to 1 |
| LFO rate | 0.01–20 Hz |
| Data value updates | 30 per second per source |

The engine rejects a configuration over any limit and throws `ModLimitError` naming the limit.

## Engine API
```ts
type LfoSpec = { id: string; shape: LfoShape; rate: number | { sync: string } | { data: string; min: number; max: number };
                 phase: number; retrigger: boolean; smooth: number };
type RouteSpec = { target: string; source: string; depth: number };   // source: an lfo or dat id

interface EngineMod {
  setLfos(lfos: LfoSpec[]): void;
  setMods(routes: RouteSpec[]): void;
  postModValue(sourceId: string, value: number, smoothMs?: number): void;
  modulatedValue(target: string): number | null;
}
```
- `setLfos` and `setMods` replace the whole configuration. Sources and routes with unchanged ids and fields keep their phase and state.
- `postModValue` forwards to every chain and synth route that uses the source.
- A route whose target does not exist, or whose target is `enum`, array or `ModDef: null`, throws `ModTargetError`.

## Sources
- MDN, AudioParam (value computation from connected inputs): https://developer.mozilla.org/en-US/docs/Web/API/AudioParam
- MDN, ConstantSourceNode: https://developer.mozilla.org/en-US/docs/Web/API/ConstantSourceNode
- MDN, BiquadFilterNode.detune: https://developer.mozilla.org/en-US/docs/Web/API/BiquadFilterNode/detune
- Assignment 3 repository: `src/dsp/core/params.js` (`toNorm`, `fromNorm`), `docs/automation.md` (32-frame sub-block evaluation)
