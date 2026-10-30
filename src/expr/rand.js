// Deterministic `rand(lo, hi)` (doc/piece-dsl.md, Expressions): seeded by the piece seed,
// the binding id and the object id. No Math.random().

/**
 * 32-bit FNV-1a hash of a string.
 * @param {string} s
 * @returns {number} unsigned 32-bit integer
 */
export function hash32(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * One mulberry32 step from a 32-bit state, as a number in [0, 1).
 * @param {number} a
 * @returns {number}
 */
export function mulberry32Once(a) {
  let t = (a + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/**
 * Deterministic number in [0, 1) for (seed, bindingId, objectId).
 * @param {number} seed
 * @param {string} bindingId
 * @param {string} objectId
 * @returns {number}
 */
export function rand01(seed, bindingId, objectId) {
  return mulberry32Once(hash32(`${seed}\u0000${bindingId}\u0000${objectId}`));
}
