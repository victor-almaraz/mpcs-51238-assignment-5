// Clamps applied to expression results before they reach an instrument.

import { LIMITS } from './limits.js';

/** @param {unknown} v @returns {number | null} MIDI pitch clamped to 0–127 */
export function pitchOf(v) {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(Math.max(v, 0), 127) : null;
}

/** @param {unknown} v @returns {number} integer velocity 1–127, default 64 */
export function velocityOf(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return LIMITS.defaultVelocity;
  return Math.min(Math.max(Math.round(v), 1), 127);
}

/** @param {unknown} v @returns {number | null} pan −1 to 1 */
export function panOf(v) {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(Math.max(v, -1), 1) : null;
}

/** @param {unknown} v @param {number} fallback @returns {number} */
export function numberOr(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
