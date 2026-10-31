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

- Bipolar output: `sine`, `triangle`, `square` and `saw` span −1 to 1. With `p` the fractional part of the phase: `sine` = sin 2πp; `triangle` = 4·|((p − 0.25) mod 1) − 0.5| − 1 (0 at p = 0, rising); `square` = 1 for p < 0.5, else −1; `saw` = 2·((p + 0.5) mod 1) − 1 (0 at p = 0, rising).
- `random` draws one value per cycle and holds it for the cycle. `smooth` is `random` with smoothing applied. Both shapes apply `smooth`; they differ only in its default.
- The value of cycle `k` (the integer part of the phase) is `2 · hash32(seed, lfoIndex, k) / 2³² − 1` (`src/audio/fx/core/prng.js`). With `smooth` = s > 0 the output is a one-pole filter of the held values with a time constant of s cycles: within cycle k, `y = v_k + (y_k − v_k) · e^(−p/s)`, where `y_k` is the filter state at the start of cycle k, computed from the 8 preceding cycles. The value depends only on the phase, so every instance of one LFO agrees.
- A free-running LFO's phase at time `t` is `phase + rate · (t − t₀)`, where `t₀` is the engine start time in context seconds. Chain worklets compute `t` from frames processed (`currentFrame`). Every instance of one LFO, in any chain or synth route, therefore shares one phase.
- The engine keeps each LFO's phase as an anchor `(anchorT, anchorPhase, hz)`: phase(t) = `anchorPhase + hz · (t − anchorT)`. A rate change re-anchors at the time of the change, so phase accumulates continuously. A tempo change re-anchors synced LFOs at the `at` time of the `tempo` message on the main thread and in every chain, so they stay in phase.
- A synced rate is `bpm / 60 / beats`, with `beats` the length of the sync value in quarter notes (as for `delay.sync`).
- `rate` may itself be a data source mapped to Hz (Data values): `hz = min + (value + 1) / 2 · (max − min)`, with `0.01 ≤ min < max ≤ 20`. The main thread re-anchors such an LFO at every `pump()`; each chain integrates its phase per 32-frame sub-block from the anchor it received with `lfos`. Before the first value arrives the data value is 0 (the midpoint rate). Instances of a data-rate LFO therefore agree only approximately.

### Data values
- A data source has an `id` (`dat<n>`) and a value in −1 to 1, supplied by the binding runtime through `postModValue` at up to 30 Hz. A post that arrives less than 1/30 s (context time) after the previous forwarded post of the same source is held, and the latest held value is forwarded by the next `pump()`; values are never dropped, only coalesced.
- Before the first post a data source is 0. A chain created later receives the current smoothed value, then the current target.
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
- **Audio rate.** The source node (`OscillatorNode` for periodic LFOs, `ConstantSourceNode` for `random`, `smooth` and data sources) feeds a `GainNode` whose gain is the route depth converted to the target's native unit, and the gain node connects to the target `AudioParam` in each voice. `target` names the voice's node and parameter, for example `filter.detune` for the voice's `filter` node.
  - Log parameters are modulated through a `detune` parameter in cents: `gain = depth · log2(max / min) · 1200`.
  - Linear parameters: `gain = depth · (max − min)`.
  - `pow3` parameters and `dir: 'down'` parameters are not audio-rate targets; the engine uses the control path for them even when their `ModDef` says `audio`.
  - The native path cannot clamp the summed signal. The instrument limits each route's gain so that `toNorm(base) ± Σ |depthᵢ|` stays within 0–1: with `S = Σ |depthᵢ|` and `h = min(u₀, 1 − u₀)`, `u₀ = toNorm(base)`, every depth is scaled by `min(1, h / S)`. The limit is recomputed when the base value or a depth changes. A base at either end of the range therefore leaves no room for audio-rate modulation. Where the instrument itself raises the parameter, the upper headroom is measured from that peak: subtractive `cutoff` uses `h = min(u₀, 1 − toNorm(peak))` with `peak = cutoff · 2^(envelope octaves)`, the filter envelope's top, and recomputes the limit when `envAmount` changes. An envelope that already reaches `max` leaves no room for cutoff routes.
  - Periodic LFOs use a `PeriodicWave` of the shape's Fourier series (64 harmonics), shifted to the LFO's phase at the oscillator's start time and scaled so its peak is 1. The band-limited square and saw have rounded edges compared with the chain worklets' exact shapes.
  - `random` and `smooth` sources are `ConstantSourceNode`s whose `offset` is scheduled by `pump()` up to its lookahead: `setValueAtTime(v_k, t_k)` at each cycle start `t_k`, or `setTargetAtTime(v_k, t_k, s / hz)` when `smooth` = s > 0, which is the same one-pole curve.
  - Data sources are `ConstantSourceNode`s whose `offset` follows each post with `setTargetAtTime(value, now, smoothMs / 3000)`.
  - The engine creates one source node per source used by an audio-rate route and shares it among instruments; each instrument holds one route gain per route.
- **Control rate.** `pump()` evaluates the model above every 25 ms and applies the result as the parameter's current value, through the instrument's `applyParam` (so sounding voices follow where the parameter applies to them). The base value stays the one `setParam` set: `getParams()` returns base values. When the last route to a parameter is removed, the parameter returns to its base value. Granular `density`, `spray` and `pitchSpread`, and pluck worklet parameters, use this path.
- **Voices.** A voice connects its target parameters to the instrument's route gains at `noteOn` and disconnects them when it ends. A `retrigger` LFO creates one source per voice (an oscillator, or a scheduled constant source for `random` and `smooth`), started at the voice's `noteOn` time with the LFO's `phase`, feeding a per-voice gain with the route's gain. On a control-rate target a `retrigger` LFO restarts at the instrument's latest `noteOn`.
- **Per-voice values.** `setVoiceMod(source, mods)` (`bindings.md`, Instrument contracts) takes values in −1 to 1 keyed by the name of an audio-rate parameter, and adds `value` in normalized units to that parameter for the voice tagged `source`, through a per-voice `ConstantSourceNode` converted like a route depth. The offset is clamped so the voice's value, with every route at full depth, stays within the range (measured from the envelope peak where one applies, as above). Other names, and every name on instruments without audio-rate parameters, are ignored.

### Reports
Each chain processor posts `{ t: 'report', values }` at most every 100 ms, with the modulated value of every routed effect parameter in route order. The engine computes synth targets' modulated values from the model on request. `modulatedValue(target)` returns the latest of either; for a valid target without routes it returns the base value, and for an unknown target `null`.

## Determinism
- Periodic LFO output depends only on `rate`, `phase` and `t − t₀`.
- `random` and `smooth` values come from `hash32(seed, lfoIndex, k)` for cycle `k`, where `lfoIndex` is the LFO's index in the `setLfos` list. They depend on the phase only, not on which chain or instrument evaluates them.
- Data values are inputs. A replay of recorded sky changes posts the same values at the same context times, so offline renders of a replay match the live output.

## Limits
| Item | Limit | `ModLimitError.limit` |
|---|---|---|
| LFOs per piece | 16 | `lfos` |
| `retrigger` LFOs per instrument | 2 | `retrigger` |
| Routes per piece | 32 | `routes` |
| Routes per target | 4 | `routes_per_target` |
| Depth | −1 to 1 | `depth` |
| LFO rate | 0.01–20 Hz | `rate` |
| Data value updates | 30 per second per source | (coalesced, see Data values) |

The engine rejects a configuration over any limit and throws `ModLimitError` (`src/audio/errors.js`) naming the limit. A malformed LFO or route (unknown shape, unknown sync value, duplicate LFO id, a source that is neither an LFO id nor `dat<n>`) throws `TypeError`. A rejected call leaves the previous configuration in place.

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
- `setLfos` and `setMods` replace the whole configuration. Sources and routes with unchanged ids and fields keep their phase and state. A route whose LFO is missing after `setLfos` reads 0 until `setMods` replaces it.
- Routes are resolved against the engine's current instruments and slots; the engine re-resolves them after every `sync` and `setFx`, and a route whose target has disappeared is inactive until it exists again.
- `postModValue` forwards to every chain and synth route that uses the source.
- A route whose target does not exist, or whose target is `enum`, array or `ModDef: null`, throws `ModTargetError`.

## Sources
- MDN, AudioParam (value computation from connected inputs): https://developer.mozilla.org/en-US/docs/Web/API/AudioParam
- MDN, ConstantSourceNode: https://developer.mozilla.org/en-US/docs/Web/API/ConstantSourceNode
- MDN, BiquadFilterNode.detune: https://developer.mozilla.org/en-US/docs/Web/API/BiquadFilterNode/detune
- Assignment 3 repository: `src/dsp/core/params.js` (`toNorm`, `fromNorm`), `docs/automation.md` (32-frame sub-block evaluation)
