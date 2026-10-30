/*
 * Scalar helpers used by DSP code on both threads. None allocates.
 */
import { DENORMAL_THRESHOLD } from './constants.js';

/** Returns `x` limited to [lo, hi]. */
export function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

/** Linear gain for `db` decibels; −Infinity dB gives 0. */
export function dbToGain(db) {
  return db === -Infinity ? 0 : 10 ** (db / 20);
}

/** Decibels for linear gain `g` ≥ 0; 0 gives −Infinity. */
export function gainToDb(g) {
  return g <= 0 ? -Infinity : 20 * Math.log10(g);
}

/** Returns 0 for |x| below the denormal threshold, otherwise `x`. Call at block end on recursive state. */
export function flushDenormal(x) {
  return x < DENORMAL_THRESHOLD && x > -DENORMAL_THRESHOLD ? 0 : x;
}

