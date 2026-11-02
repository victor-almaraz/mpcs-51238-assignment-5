// Scales for `.quantize()` (doc/piece-dsl.md, Piece: scale(root, mode)).

import { SCALE_STEPS } from '../dsl/limits.js';

const NATURAL = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/**
 * Pitch class (0–11) of a root note name such as `C`, `F#` or `Bb`.
 * @param {string} root
 * @returns {number}
 */
export function rootPitchClass(root) {
  const m = /^([A-G])([#b]?)$/.exec(String(root));
  if (!m) throw new Error(`Unknown scale root "${root}"; expected C–B with optional # or b`);
  const pc = NATURAL[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
  return (pc + 12) % 12;
}

/**
 * Nearest pitch of the scale to `pitch` (MIDI, fractional). A tie goes to the higher pitch,
 * so the chromatic scale matches `Math.round`.
 * @param {number} pitch
 * @param {{ root: string, mode: string }} [scale] default C chromatic
 * @returns {number}
 */
export function quantize(pitch, scale = { root: 'C', mode: 'chromatic' }) {
  const steps = Object.hasOwn(SCALE_STEPS, scale.mode) ? SCALE_STEPS[/** @type {keyof typeof SCALE_STEPS} */ (scale.mode)] : null;
  if (!steps) throw new Error(`Unknown scale mode "${scale.mode}"`);
  const root = rootPitchClass(scale.root);
  const octave = Math.floor((pitch - root) / 12);
  let best = NaN;
  let bestDist = Infinity;
  for (let k = octave - 1; k <= octave + 1; k++) {
    for (const s of steps) {
      const c = root + 12 * k + s;
      const d = Math.abs(c - pitch);
      if (d < bestDist || (d === bestDist && c > best)) { best = c; bestDist = d; }
    }
  }
  return best;
}
