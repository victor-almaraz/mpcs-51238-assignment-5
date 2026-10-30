/*
 * TPT state-variable filter (a3-audio-implementation.md, Filter): stable
 * under fast modulation. Coefficients from g = tan(π·fc/fs) and k = 1/Q, computed
 * per block by svfCoefficients; svfTick processes one sample against state in
 * typed arrays, so voices and channels share the code without objects.
 */

/** Writes [a1, a2, a3, k] for cutoff `fc` (Hz, clamped to 0.45·fs) and `q` into `out` at `at`. */
export function svfCoefficients(out, at, fc, q, fs) {
  const f = fc > 0.45 * fs ? 0.45 * fs : fc;
  const g = Math.tan((Math.PI * f) / fs);
  const k = 1 / q;
  const a1 = 1 / (1 + g * (g + k));
  out[at] = a1;
  out[at + 1] = g * a1;
  out[at + 2] = g * g * a1;
  out[at + 3] = k;
}

/** SVF modes. */
export const LOWPASS = 0;
export const HIGHPASS = 1;
export const BANDPASS = 2;

/**
 * One sample of the SVF. `coef` holds [a1, a2, a3, k] at `c`; `state` holds
 * [ic1, ic2] at `s`. Returns the output for `mode`.
 */
export function svfTick(x, coef, c, state, s, mode) {
  const a1 = coef[c];
  const a2 = coef[c + 1];
  const a3 = coef[c + 2];
  const ic1 = state[s];
  const ic2 = state[s + 1];
  const v3 = x - ic2;
  const v1 = a1 * ic1 + a2 * v3;
  const v2 = ic2 + a2 * ic1 + a3 * v3;
  state[s] = 2 * v1 - ic1;
  state[s + 1] = 2 * v2 - ic2;
  if (mode === LOWPASS) return v2;
  if (mode === BANDPASS) return v1;
  return x - coef[c + 3] * v1 - v2;
}
