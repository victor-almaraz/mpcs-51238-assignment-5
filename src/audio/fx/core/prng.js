/*
 * Seeded randomness (a3-audio-implementation.md, Real-time rules 9). DSP code
 * never calls Math.random. Seeds come from hash32(projectSeed, trackIndex, eventIndex).
 */

/**
 * mulberry32: returns a function giving uniform floats in [0, 1). The closure is
 * created once per kernel at construction, never in process(). Code that
 * reseeds inside process() uses the Mulberry32 class instead.
 */
export function mulberry32(seed) {
  let a = seed | 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** mulberry32 as a reusable object: reseed() and next() allocate nothing. */
export class Mulberry32 {
  constructor(seed = 0) {
    this.a = seed | 0;
  }

  /** Restarts the sequence from `seed`. */
  reseed(seed) {
    this.a = seed | 0;
  }

  /** Next uniform float in [0, 1); the same sequence as mulberry32(seed). */
  next() {
    this.a = (this.a + 0x6d2b79f5) | 0;
    let t = Math.imul(this.a ^ (this.a >>> 15), 1 | this.a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Next uniform float in [−1, 1) (white noise). */
  nextBipolar() {
    return this.next() * 2 - 1;
  }
}

/** 32-bit finalizer (MurmurHash3 fmix32). */
function fmix32(h) {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * Combines three integers into one unsigned 32-bit seed. Fixed arity, so a call
 * inside process() allocates nothing.
 */
export function hash32(a, b, c) {
  let h = 0x811c9dc5;
  h = Math.imul(h ^ (a | 0), 0x01000193);
  h = Math.imul(h ^ (b | 0), 0x01000193);
  h = Math.imul(h ^ (c | 0), 0x01000193);
  return fmix32(h);
}
