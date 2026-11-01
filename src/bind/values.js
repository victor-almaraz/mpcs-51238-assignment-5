// Clamps applied to expression results before they reach an instrument. The ranges and defaults
// are the DSL's (src/dsl/limits.js).

import { DEFAULTS, RANGES } from '../dsl/limits.js';

/** @param {unknown} v @returns {v is number} */
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
/** @param {number} v @param {readonly number[]} range */
const clampTo = (v, range) => Math.min(Math.max(v, range[0]), range[1]);

/** @param {unknown} v @returns {number | null} MIDI pitch clamped to 0–127 */
export function pitchOf(v) {
  return finite(v) ? clampTo(v, RANGES.pitch) : null;
}

/** @param {unknown} v @returns {number} integer velocity 1–127, default 100 */
export function velocityOf(v) {
  return finite(v) ? clampTo(Math.round(v), RANGES.velocity) : DEFAULTS.velocity;
}

/** @param {unknown} v @returns {number | null} pan −1 to 1 */
export function panOf(v) {
  return finite(v) ? clampTo(v, RANGES.pan) : null;
}

/** @param {unknown} v @returns {number | null} per-voice modulation value −1 to 1 */
export function voiceModOf(v) {
  return finite(v) ? clampTo(v, RANGES.voiceMod) : null;
}

/** @param {unknown} v @param {number} fallback @returns {number} */
export function numberOr(v, fallback) {
  return finite(v) ? v : fallback;
}
