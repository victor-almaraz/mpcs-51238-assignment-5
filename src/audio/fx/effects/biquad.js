/*
 * RBJ Audio EQ Cookbook biquads in transposed direct form II
 * (a3-audio-implementation.md, Biquad):
 *   w0 = 2π·f0/fs, α = sin(w0)/(2Q), A = 10^(G/40); shelves use S = 1, α = sin(w0)/√2.
 *   y = b0·x + s1; s1 = b1·x − a1·y + s2; s2 = b2·x − a2·y.
 * Coefficient functions write [b0, b1, b2, a1, a2], normalised by a0, into a
 * preallocated array; they run per block or on parameter change, never per
 * sample. f0 is clamped to 0.45·fs so every section stays below Nyquist.
 */
import { flushDenormal } from '../core/math.js';

/** Coefficients per section: [b0, b1, b2, a1, a2]. */
export const BIQUAD_COEFS = 5;

/** State values per stereo section: [s1L, s2L, s1R, s2R]. */
export const BIQUAD_STATE = 4;

/** Highest centre or corner frequency, as a fraction of fs. */
const MAX_F0 = 0.45;

function omega(f0, fs) {
  const f = f0 > MAX_F0 * fs ? MAX_F0 * fs : f0;
  return (2 * Math.PI * f) / fs;
}

function store(out, at, b0, b1, b2, a0, a1, a2) {
  const inv = 1 / a0;
  out[at] = b0 * inv;
  out[at + 1] = b1 * inv;
  out[at + 2] = b2 * inv;
  out[at + 3] = a1 * inv;
  out[at + 4] = a2 * inv;
}

/** Peaking EQ at `f0` Hz with gain `gainDb` and quality `q`; writes 5 coefficients at `at`. */
export function peakCoefficients(out, at, f0, gainDb, q, fs) {
  const w0 = omega(f0, fs);
  const A = 10 ** (gainDb / 40);
  const alpha = Math.sin(w0) / (2 * q);
  const c = -2 * Math.cos(w0);
  store(out, at, 1 + alpha * A, c, 1 - alpha * A, 1 + alpha / A, c, 1 - alpha / A);
}

/** Low shelf (S = 1) with corner `f0` Hz and gain `gainDb`; writes 5 coefficients at `at`. */
export function lowShelfCoefficients(out, at, f0, gainDb, fs) {
  const w0 = omega(f0, fs);
  const A = 10 ** (gainDb / 40);
  const cw = Math.cos(w0);
  const t = 2 * Math.sqrt(A) * (Math.sin(w0) / Math.SQRT2);
  store(
    out,
    at,
    A * (A + 1 - (A - 1) * cw + t),
    2 * A * (A - 1 - (A + 1) * cw),
    A * (A + 1 - (A - 1) * cw - t),
    A + 1 + (A - 1) * cw + t,
    -2 * (A - 1 + (A + 1) * cw),
    A + 1 + (A - 1) * cw - t,
  );
}

/** High shelf (S = 1) with corner `f0` Hz and gain `gainDb`; writes 5 coefficients at `at`. */
export function highShelfCoefficients(out, at, f0, gainDb, fs) {
  const w0 = omega(f0, fs);
  const A = 10 ** (gainDb / 40);
  const cw = Math.cos(w0);
  const t = 2 * Math.sqrt(A) * (Math.sin(w0) / Math.SQRT2);
  store(
    out,
    at,
    A * (A + 1 + (A - 1) * cw + t),
    -2 * A * (A - 1 + (A + 1) * cw),
    A * (A + 1 + (A - 1) * cw - t),
    A + 1 - (A - 1) * cw + t,
    2 * (A - 1 - (A + 1) * cw),
    A + 1 - (A - 1) * cw - t,
  );
}

/**
 * Runs frames [start, end) of both channels through the section whose
 * coefficients are at `coef[c]` and whose state is at `state[s]`, in place.
 * State is flushed at the end of the range.
 */
export function biquadStereo(coef, c, state, s, bufL, bufR, start, end) {
  const b0 = coef[c];
  const b1 = coef[c + 1];
  const b2 = coef[c + 2];
  const a1 = coef[c + 3];
  const a2 = coef[c + 4];
  let s1l = state[s];
  let s2l = state[s + 1];
  let s1r = state[s + 2];
  let s2r = state[s + 3];
  for (let i = start; i < end; i++) {
    const xl = bufL[i];
    const yl = b0 * xl + s1l;
    s1l = b1 * xl - a1 * yl + s2l;
    s2l = b2 * xl - a2 * yl;
    bufL[i] = yl;
    const xr = bufR[i];
    const yr = b0 * xr + s1r;
    s1r = b1 * xr - a1 * yr + s2r;
    s2r = b2 * xr - a2 * yr;
    bufR[i] = yr;
  }
  state[s] = flushDenormal(s1l);
  state[s + 1] = flushDenormal(s2l);
  state[s + 2] = flushDenormal(s1r);
  state[s + 3] = flushDenormal(s2r);
}

/** Magnitude response, in dB, of the section at `coef[c]` at frequency `f` Hz (UI curves and tests). */
export function biquadMagnitudeDb(coef, c, f, fs) {
  const w = (2 * Math.PI * f) / fs;
  const c1 = Math.cos(w);
  const s1 = Math.sin(w);
  const c2 = Math.cos(2 * w);
  const s2 = Math.sin(2 * w);
  const nr = coef[c] + coef[c + 1] * c1 + coef[c + 2] * c2;
  const ni = -(coef[c + 1] * s1 + coef[c + 2] * s2);
  const dr = 1 + coef[c + 3] * c1 + coef[c + 4] * c2;
  const di = -(coef[c + 3] * s1 + coef[c + 4] * s2);
  return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
}
