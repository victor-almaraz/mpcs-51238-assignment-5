# Synthesis: subtractive

## Scope
The subtractive instrument. Shared rules (pitch, velocity, `ParamDef`, scaling) are in `synthesis-conventions.md`; envelopes and voices in `audio-engine-core.md`.

## Flow
`OscillatorNode(type) → BiquadFilterNode('lowpass') → GainNode(env) → widget.output`

## Parameters
| Param | Range | Default | Unit | Scale |
|---|---|---|---|---|
| waveform | sine, square, sawtooth, triangle | sawtooth | — | radio |
| cutoff | 40 – 16000 (clamp ≤ 0.45·fs) | 2000 | Hz | log |
| resonance | 0 – 20 | 1 | dB (the lowpass `Q` is interpreted in dB) | lin |
| envAmount ("Filter env") | 0 – 6 | 0 | octaves above cutoff at the envelope peak | lin, step 0.1 |
| attack | 0.002 – 2 | 0.01 | s | pow3 |
| decay | 0.01 – 4 | 0.3 | s | pow3 |
| sustain | 0 – 1 | 1 | fraction of the peak | lin, step 0.01 |
| release | 0.01 – 4 | 0.3 | s | pow3 |

## Filter envelope
- The filter envelope follows the amp envelope's shape: it rises to `envAmount` octaves over the attack, decays to `sustain × envAmount` and returns to 0 over the release.
- It runs on the filter's `detune` param in cents (`envAmount × 1200`), so the sweep is exponential in Hz. Live cutoff changes still go to `frequency` and do not disturb it.
- **Nyquist cap:** per voice, the depth is capped at `1200·log2(0.45·fs / cutoff)` cents, so the envelope peak stays at or under 0.45·fs. A live cutoff increase on a sounding voice lowers that voice's base cutoff when needed (`min(cutoff, 0.45·fs / 2^(cents/1200))`), so the peak never passes the cap.
- A biquad lowpass at Nyquist has a double pole at z = −1 (marginally stable), which is why the cap is enforced rather than left to the browser's own clamp.

## Notes
- The spec defines the built-in waveforms from Fourier series, so they are band-limited. Aliasing is not a concern with the native types.
- Live cutoff changes go to every active voice's `filter.frequency`, with smoothing.
- Cost: 3 nodes per voice (the filter envelope uses the existing `detune` param).

## Sources
- W3C Web Audio API 1.1, OscillatorNode and BiquadFilterNode (https://www.w3.org/TR/webaudio-1.1/)
- MDN, BiquadFilterNode (https://developer.mozilla.org/en-US/docs/Web/API/BiquadFilterNode)
