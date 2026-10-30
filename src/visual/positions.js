/**
 * Main-thread store of propagator samples with per-frame linear
 * interpolation between the last two samples (doc/visuals.md, Orbit
 * propagation).
 */
import { STRIDE } from './propagation-core.js';

const WRAP = new Set([4, 6]); // longitude, azimuth
const TWO_PI = 2 * Math.PI;
/** Largest extrapolation past the newest sample, as a fraction of the sample spacing. */
const MAX_ALPHA = 1.5;

/**
 * @typedef {{ wallMs: number, simMs: number, idsVersion: number, ids: string[], positions: Float32Array }} Sample
 */

export class SampleBuffer {
  constructor() {
    /** @type {Sample | null} */ this.a = null;
    /** @type {Sample | null} */ this.b = null;
    /** @type {string[]} */ this.ids = [];
    this.idsVersion = -1;
    /** @type {string[]} */ this.orbitKeys = [];
    /** @type {Map<string, number>} */ this.orbitIndex = new Map();
    /** @type {Float32Array} */ this.orbitValues = new Float32Array(0);
    /** @type {Map<string, number>} */ this.index = new Map();
    this.out = new Float32Array(0);
  }

  /**
   * Adds a worker `sample` message.
   * @param {any} msg
   */
  push(msg) {
    if (Array.isArray(msg.ids)) {
      this.ids = msg.ids;
      this.idsVersion = msg.idsVersion;
      this.index = new Map(this.ids.map((id, i) => [id, i]));
    }
    if (Array.isArray(msg.orbitKeys)) {
      this.orbitKeys = msg.orbitKeys;
      this.orbitIndex = new Map(this.orbitKeys.map((k, i) => [k, i]));
    }
    if (msg.orbitValues instanceof Float32Array && msg.orbitValues.length === this.orbitKeys.length) this.orbitValues = msg.orbitValues;
    if (!(msg.positions instanceof Float32Array) || msg.positions.length !== this.ids.length * STRIDE || msg.idsVersion !== this.idsVersion) return;
    const s = { wallMs: msg.wallMs, simMs: msg.simMs, idsVersion: msg.idsVersion, ids: this.ids, positions: msg.positions };
    this.a = this.b && this.b.idsVersion === s.idsVersion && this.b.wallMs < s.wallMs ? this.b : null;
    this.b = s;
  }

  /**
   * Interpolated positions at wall time `nowMs`. The returned array is
   * reused by the next call.
   * @param {number} nowMs
   * @returns {{ ids: string[], data: Float32Array, stride: number, index: Map<string, number> }}
   */
  positions(nowMs) {
    const b = this.b;
    if (!b) return { ids: [], data: new Float32Array(0), stride: STRIDE, index: new Map() };
    if (this.out.length !== b.positions.length) this.out = new Float32Array(b.positions.length);
    const out = this.out;
    const a = this.a;
    if (!a) { out.set(b.positions); return { ids: b.ids, data: out, stride: STRIDE, index: this.index }; }
    const alpha = clamp((nowMs - a.wallMs) / (b.wallMs - a.wallMs), 0, MAX_ALPHA);
    interpolate(a.positions, b.positions, alpha, out);
    return { ids: b.ids, data: out, stride: STRIDE, index: this.index };
  }

  /**
   * Simulated time at wall time `nowMs`, from the last two samples; `null`
   * before the first sample.
   * @param {number} nowMs
   */
  simAt(nowMs) {
    const a = this.a, b = this.b;
    if (!b) return null;
    if (!a) return b.simMs;
    const speed = (b.simMs - a.simMs) / (b.wallMs - a.wallMs);
    return b.simMs + (nowMs - b.wallMs) * speed;
  }

  /** @param {string} key @returns {number | null} */
  orbitValue(key) {
    const i = this.orbitIndex.get(key);
    if (i === undefined) return null;
    const v = this.orbitValues[i];
    return Number.isFinite(v) ? v : null;
  }
}

/**
 * Linear interpolation of position records; longitude and azimuth take the
 * shorter way around. A record missing in either sample takes `b`'s value.
 * @param {Float32Array} a @param {Float32Array} b @param {number} alpha
 * @param {Float32Array} out
 */
export function interpolate(a, b, alpha, out) {
  for (let r = 0; r < b.length; r += STRIDE) {
    if (Number.isNaN(a[r]) || Number.isNaN(b[r])) {
      for (let k = 0; k < STRIDE; k++) out[r + k] = b[r + k];
      continue;
    }
    for (let k = 0; k < STRIDE; k++) {
      const x = a[r + k], y = b[r + k];
      if (WRAP.has(k)) {
        let d = y - x;
        if (d > Math.PI) d -= TWO_PI; else if (d < -Math.PI) d += TWO_PI;
        let v = x + d * alpha;
        if (k === 4) { if (v > Math.PI) v -= TWO_PI; else if (v < -Math.PI) v += TWO_PI; }
        else { if (v >= TWO_PI) v -= TWO_PI; else if (v < 0) v += TWO_PI; }
        out[r + k] = v;
      } else {
        out[r + k] = x + (y - x) * alpha;
      }
    }
  }
}

/** @param {number} x @param {number} lo @param {number} hi */
function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}
