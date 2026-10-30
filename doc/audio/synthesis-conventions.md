# Synthesis: shared conventions

## Scope
Rules shared by all five instrument types. Each type has its own doc:
- `synthesis-subtractive.md`
- `synthesis-fm.md`
- `synthesis-additive.md`
- `synthesis-pluck.md`
- `synthesis-granular.md`

Voice, envelope and interface rules are in `audio-engine-core.md`.

## Pitch and velocity
- Pitch to frequency: `f = 440 * 2 ** ((pitch - 69) / 12)`.
- Velocity to gain: `0.3 * (vel / 127) ** 2`. The square law approximates perceived loudness.

## Parameter definitions
- All param definitions live in one table object, `PARAM_DEFS[type]`. It drives the UI, `setParam` clamping and patch validation (`patch-format.md`). Never duplicate ranges elsewhere.
```ts
type ParamDef = {
  name: string; label: string; unit: string;
  min: number; max: number; default: number;
  scale: 'lin' | 'log' | 'pow3';
  step?: number; options?: string[];
  mod?: ModDef | null;   // modulation path (modulation.md); absent means null
};
```
- **Modulation paths** (`modulation.md`, Synth targets). Every numeric parameter has a `ModDef`; enum and array parameters have `mod: null`.

  | Type | Audio rate (`target`) | Control rate |
  |---|---|---|
  | `subtractive` | `cutoff` (`filter.detune`), `resonance` (`filter.Q`) | `envAmount`, `attack`, `decay`, `sustain`, `release` |
  | `fm` | | every numeric parameter |
  | `additive` | `vibratoRate` (`lfo.detune`), `vibratoDepth` (`depth.gain`) | `attack`, `decay`, `sustain`, `release` |
  | `pluck` | | every parameter |
  | `granular` | | every numeric parameter |

  Control-rate envelope times, FM `ratio`, `fine` and `indexDecay`, subtractive `envAmount`, and pluck `pickPosition`, `decay` and `release` take effect at the next note; the others also move sounding voices.
- **Scaled params:** store values in natural units, and map the UI's normalised slider position `u ∈ [0,1]`:
  - Frequency-like (log): `v = min * (max/min) ** u`.
  - Times (cubic): `v = min + (max-min) * u ** 3`.
  - Linear: `v = min + (max-min) * u`.
- Keep each widget to at most 8 controls so it fits a 340 px card, its width at the 390 px minimum (`layout-and-responsive.md`); `tests/param-defs.test.js` checks the limit.
- Modulation and shaping params default to their neutral value (filter env 0, sustain 1, fine 0, vibrato 0, pick position 0, pitch spread 0, position 0.5), so a patch that omits them plays the plain sound of its synth type (`patch-format.md`).
- Subtractive, FM and additive share the ADSR envelope params (attack, decay, sustain, release; `audio-engine-core.md` "Click-free envelopes").
- Every widget also has a tuning shift (Octave, Cents) outside `PARAM_DEFS`, defined in `TUNING_DEFS`. `Instrument.noteOn` plays `clamp(pitch + 12·octave + cents/100, 0, 127)`; voices keep the played pitch for note-off matching.

## CPU summary (relative per voice)
From cheapest to most expensive:
1. Subtractive (1×)
2. Additive (1×)
3. FM (1.3×)
4. Pluck (all voices share one worklet node)
5. Granular (depends on density; highest)
