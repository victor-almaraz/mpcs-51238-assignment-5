# Synthesis: additive (8 harmonics)

## Scope
The additive instrument. Shared rules are in `synthesis-conventions.md`; envelopes and voices in `audio-engine-core.md`; the harmonic bar control in `controls-and-accessibility.md`.

## Flow
`OscillatorNode with PeriodicWave(harmonic amplitudes) → env Gain → output`, with a vibrato LFO on the oscillator's `detune`

## Parameters
| Param | Range | Default | Unit | Scale |
|---|---|---|---|---|
| h1 … h8 (`harmonics` array) | 0 – 1 | [1, .5, .33, .25, .2, .17, .14, .12] | amplitude | lin, step 0.01 |
| attack | 0.002 – 2 | 0.02 | s | pow3 |
| decay | 0.01 – 4 | 0.5 | s | pow3 |
| sustain | 0 – 1 | 1 | fraction of the peak | lin, step 0.01 |
| release | 0.01 – 4 | 0.5 | s | pow3 |
| vibratoRate | 0.5 – 12 | 5 | Hz | log |
| vibratoDepth ("Vibrato") | 0 – 100 | 0 | cents | lin, step 1 |

## Vibrato
- Per voice: `OscillatorNode(sine, rate) → Gain(depth in cents) → osc.detune`. It moves pitch only; level is unchanged.
- Live rate and depth changes reach sounding voices with smoothing (τ 15 ms).

## Building the wave
```ts
function makeWave(ctx: BaseAudioContext, h: number[]) {
  const real = new Float32Array(h.length + 1);       // index 0 = DC term, ignored by the spec
  const imag = new Float32Array(h.length + 1);
  h.forEach((a, i) => (imag[i + 1] = a));             // sine terms
  const sum = h.reduce((s, a) => s + a, 0) || 1;
  for (let i = 1; i < imag.length; i++) imag[i] /= Math.max(1, sum);  // manual headroom
  return ctx.createPeriodicWave(real, imag, { disableNormalization: true });
}
```

## Notes
- **Normalization pitfall:**
  - By default `createPeriodicWave` normalizes the waveform to a peak absolute value of 1.
  - With the default, lowering all bars doesn't change loudness: one bar at 0.1 sounds as loud as at 1.0.
  - Use `disableNormalization: true`, and divide by `max(1, sum)` so the sum of sines can't exceed ±1.
- `real` and `imag` must have equal length (otherwise `IndexSizeError`). Index 0 is the DC slot; the spec ignores it, so the wave has no DC component. It is left at 0.
- Bar edits:
  - Rebuild the PeriodicWave (9 coefficients) at most once per animation frame.
  - Call `osc.setPeriodicWave(w)` on active voices. Changing the wave mid-note may produce a small click.
- All-zero bars: the voice is silent. This is valid; the UI shows "All harmonics at 0".
- Harmonic 8 at a high pitch can exceed Nyquist. Browsers band-limit PeriodicWave tables, so no extra handling is needed.
- Cost: 4 nodes per voice (oscillator, envelope, vibrato LFO and its depth gain).

## Sources
- MDN, BaseAudioContext.createPeriodicWave (https://developer.mozilla.org/en-US/docs/Web/API/BaseAudioContext/createPeriodicWave)
- W3C Web Audio API 1.1, PeriodicWave (https://www.w3.org/TR/webaudio-1.1/)
