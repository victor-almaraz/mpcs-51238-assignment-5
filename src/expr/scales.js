// Scales for `.quantize()` (doc/piece-dsl.md, Piece: scale(root, mode)).

/** Semitone offsets from the root for each mode. */
export const SCALE_MODES = Object.freeze({
  major:      [0, 2, 4, 5, 7, 9, 11],
  minor:      [0, 2, 3, 5, 7, 8, 10],
  dorian:     [0, 2, 3, 5, 7, 9, 10],
  phrygian:   [0, 1, 3, 5, 7, 8, 10],
  lydian:     [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  locrian:    [0, 1, 3, 5, 6, 8, 10],
  pentatonic: [0, 2, 4, 7, 9],
  chromatic:  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
});

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
  const steps = SCALE_MODES[scale.mode];
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
