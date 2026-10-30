# Synthesis: FM (two-operator)

## Scope
The FM instrument. Shared rules are in `synthesis-conventions.md`; envelopes and voices in `audio-engine-core.md`.

## Flow
- `mod Osc(sine, f·(ratio + fine)) → modGain (depth in Hz) → carrier.frequency`
- `carrier Osc(sine, f) → env Gain → output`

## Parameters
| Param | Range | Default | Unit | Scale |
|---|---|---|---|---|
| ratio | 0.5 – 12 | 2 | × carrier | lin, step 0.5 (integers give harmonic spectra) |
| fine | −0.5 – +0.5 | 0 | added to the ratio | lin, step 0.01 (off-grid values give inharmonic, bell-like spectra) |
| index | 0 – 20 | 3 | modulation index I | lin |
| index decay | 0.01 – 4 | 0.5 | s | pow3 |
| attack | 0.002 – 2 | 0.005 | s | pow3 |
| decay | 0.01 – 4 | 0.5 | s | pow3 |
| sustain | 0 – 1 | 1 | fraction of the peak | lin, step 0.01 |
| release | 0.01 – 4 | 0.4 | s | pow3 |

- The effective modulator ratio is `max(0.01, ratio + fine)`; the index scaling and the Carson clamp below use it.
- Decay and sustain shape the carrier's amp envelope (ADSR, `audio-engine-core.md`). With sustain 0 a held note dies away like a struck bell.

## Notes
- **Index scaling:**
  - The index is I = Δf / f_mod, but `modGain.gain` is in Hz. So set it to `I * f_mod = I * ratio * f_carrier`, computed per voice.
  - Setting modGain to `I` directly makes timbre depend on pitch and makes FM inaudible on low notes.
- Index decay:
  - `modGain.gain.setValueAtTime(I*fm, t); setTargetAtTime(I*fm*0.1, t, decay/3)`.
  - The floor is 10% of the index, or 0 for bell-like sounds.
- Aliasing:
  - Sidebands extend to roughly `f_c + (I+1)·f_m` (Carson's rule).
  - With I=20 and ratio=12 on high notes, this passes Nyquist and folds back.
  - Mitigation: clamp the effective index per voice to `I_max = max(0, (0.45·fs - f_c) / f_m - 1)`.
- Cost: 4 nodes per voice.

## Sources
- W3C Web Audio API 1.1, AudioParam inputs (https://www.w3.org/TR/webaudio-1.1/)
- J. Chowning (1973). "The Synthesis of Complex Audio Spectra by Means of Frequency Modulation." JAES 21(7)
