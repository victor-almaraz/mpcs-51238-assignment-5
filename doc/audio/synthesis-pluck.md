# Synthesis: pluck (Karplus-Strong)

## Scope
The pluck algorithm and its parameters. The AudioWorklet that runs it (file layout, loading, messages, real-time rules) is in `audioworklet.md`. Shared rules are in `synthesis-conventions.md`.

## Why not native nodes
- The spec clamps a `DelayNode` inside a cycle to at least one render quantum (128 frames), so the loop period can't be shorter than 128 samples.
- With the default 128-frame quantum, that caps pitch at **fs/128 = 375 Hz at 48 kHz (≈F#4) and 344.5 Hz at 44.1 kHz (≈F4)**. The loop filter's delay lowers it further. The ceiling scales with the render quantum size if `renderSizeHint` changes it.

## Parameters
| Param | Range | Default | Unit | Scale | Maps to |
|---|---|---|---|---|---|
| damping | 0 – 1 | 0.5 | — | lin | loop lowpass weight S (0 = bright loop, 1 = dark) |
| brightness | 0 – 1 | 0.7 | — | lin | one-pole lowpass on the noise burst (excitation colour) |
| pickPosition ("Pick position") | 0 – 0.5 | 0 | fraction of the string from the bridge | lin, step 0.01 | comb `1 − z^−k` on the burst, `k = round(position · N)`; 0 = no comb |
| decay | 0.2 – 10 | 2 | s (T60) | pow3 | loop gain ρ per note |
| release | 0.02 – 2 | 0.1 | s (T60 after note-off) | pow3 | loop gain after note-off, `min(ρ, 10^(−3/(release·f)))` |

## Algorithm (Jaffe & Smith 1983 extensions)
- Excitation: N samples of white noise (seeded `mulberry32`), lowpassed by brightness, scaled by velocity.
- Loop:
  - Weighted two-point average: `y[n] = ρ · ((1−S)·x[n−M] + S·x[n−M−1])`. Its delay is 0.5 sample when S=0.5.
  - Then a first-order allpass for the fractional delay: `y = C·x + x1 − C·y1`.
- **Tuning:**
  - Total loop delay `P = fs / f`. Subtract the averager's phase delay (≈ S samples): `D = P − S`.
  - Integer delay `M = floor(D − 0.1)`, fraction `d = D − M`. d stays in [0.1, 1.1), the allpass's well-conditioned range.
  - Allpass coefficient `C = (1 − d) / (1 + d)`.
  - Without the allpass, integer-only delay lengths are audibly out of tune above ~C5.
- **Decay → ρ:**
  - Each pass round the loop multiplies amplitude by ρ times the averager's gain at f.
  - For T60 in seconds: `ρ = 10 ** (-3 / (T60 · f))`, clamped to ≤ 0.9999. This makes decay time roughly independent of pitch.
- **DC offset:**
  - The noise burst has a nonzero mean, and the loop preserves DC.
  - Subtract the burst's mean at excitation.
  - Run a DC blocker on the output: `y = x − x1 + 0.995·y1`.
- **Pick position:** the comb removes harmonics with a node at the pick point (k = N/2 removes the even harmonics). It is applied to the burst before the mean is removed and the burst is scaled to the velocity peak, so level does not depend on position.
- **Release (muting):** at the note-off frame the loop gain glides to the release's ρ (per-sample, τ ≈ 5 ms, so a note-off never steps the level), which is never above the decay's, so a release can only shorten the ring. The main thread ends the logical voice `2 × release + 50 ms` later (below −120 dB).
- **No retuning:** M is fixed for the life of a voice; changing it on a sounding voice clicks.
- **Stability:** loop gain stays below 1 at all frequencies. The two-point average has peak gain 1, so ρ ≤ 0.9999 is sufficient; any added loop filter has peak gain ≤ 1 (`audio-safety.md`).
- Cost: about 6 multiply-adds per sample per voice, all inside one node.

## Sources
- W3C Web Audio API, DelayNode cycle clamping and render quantum (https://www.w3.org/TR/webaudio-1.1/; PR #1170 https://github.com/WebAudio/web-audio-api/pull/1170/files)
- Jaffe, D. A. & Smith, J. O. (1983). "Extensions of the Karplus-Strong Plucked-String Algorithm." Computer Music Journal 7(2), 56–69
- Karplus, K. & Strong, A. (1983). "Digital Synthesis of Plucked-String and Drum Timbres." Computer Music Journal 7(2), 43–55
- J. O. Smith, Physical Audio Signal Processing, CCRMA (https://ccrma.stanford.edu/~jos/pasp/)
- B. Lynn, "The Karplus-Strong Algorithm" (http://crypto.stanford.edu/~blynn/sound/karplusstrong.html)
