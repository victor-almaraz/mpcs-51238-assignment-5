// LFO shapes, stepped random values and the phase model (modulation.md, Sources). Pure and
// environment-independent: the main thread and the fx-chain worklet both use it. The value
// functions allocate nothing, so the worklet calls them inside process().

import { hash32 } from '../fx/core/prng.js';
import { DELAY_SYNC, DELAY_SYNC_BEATS } from '../fx/effects/delay.js';

export const LFO_SHAPES = Object.freeze(['sine', 'triangle', 'square', 'saw', 'random', 'smooth']);
export const SHAPE_CODE = Object.freeze({ sine: 0, triangle: 1, square: 2, saw: 3, random: 4, smooth: 5 });

export const LFO_RATE_MIN = 0.01;
export const LFO_RATE_MAX = 20;
export const DEFAULT_RATE = 0.1;
export const DEFAULT_SMOOTH = 0.5;      // for 'smooth'; 0 for every other shape

/** Cycles before the current one that the stepped smoother starts from. */
export const SMOOTH_HISTORY = 8;

const TWO_PI = 2 * Math.PI;
const INV_2_32 = 1 / 4294967296;

/** Sync option names valid for LFO rates: the delay's sync options except 'off'. */
export const LFO_SYNC = Object.freeze(DELAY_SYNC.filter((s) => s !== 'off'));

/** Length of a sync value in quarter notes, or 0 when unknown. */
export function syncBeats(name) {
  const i = DELAY_SYNC.indexOf(name);
  return i > 0 ? DELAY_SYNC_BEATS[i] : 0;
}

/** Rate in Hz of a synced LFO at `bpm`. */
export function syncHz(name, bpm) {
  const beats = syncBeats(name);
  return beats > 0 ? bpm / 60 / beats : DEFAULT_RATE;
}

/** Rate in Hz of a data-rate LFO for data value `v` in −1..1. */
export function dataHz(v, min, max) {
  const x = v < -1 ? -1 : v > 1 ? 1 : v;
  return min + ((x + 1) / 2) * (max - min);
}

/** Held value of cycle `k` of LFO `index`, in [−1, 1). */
export function stepValue(seed, index, k) {
  return hash32(seed, index, k) * INV_2_32 * 2 - 1;
}

/**
 * Stepped (random/smooth) value at `phase`. With smooth = s > 0 the held values pass through a
 * one-pole filter with a time constant of s cycles, started SMOOTH_HISTORY cycles back.
 * `decay` is exp(−1/s), precomputed by the caller (0 when s = 0).
 */
export function steppedValue(seed, index, phase, smooth, decay) {
  const k = Math.floor(phase);
  const vk = stepValue(seed, index, k);
  if (!(smooth > 0)) return vk;
  let y = stepValue(seed, index, k - SMOOTH_HISTORY);
  for (let j = k - SMOOTH_HISTORY + 1; j < k; j++) {
    const v = stepValue(seed, index, j);
    y = v + (y - v) * decay;
  }
  return vk + (y - vk) * Math.exp(-(phase - k) / smooth);
}

/** Periodic shape value at `phase` (cycles). Shape codes 0–3. */
export function periodicValue(code, phase) {
  const p = phase - Math.floor(phase);
  switch (code) {
    case 0: return Math.sin(TWO_PI * p);
    case 1: {
      let q = p - 0.25;
      if (q < 0) q += 1;
      const d = q - 0.5;
      return 4 * (d < 0 ? -d : d) - 1;
    }
    case 2: return p < 0.5 ? 1 : -1;
    default: {
      let q = p + 0.5;
      if (q >= 1) q -= 1;
      return 2 * q - 1;
    }
  }
}

/** Value of an LFO at `phase`; `decay` = exp(−1/smooth) for stepped shapes. */
export function lfoValue(code, phase, seed, index, smooth, decay) {
  return code >= 4 ? steppedValue(seed, index, phase, smooth, decay) : periodicValue(code, phase);
}

/** exp(−1/smooth), the per-cycle decay of the stepped smoother. */
export function smoothDecay(smooth) {
  return smooth > 0 ? Math.exp(-1 / smooth) : 0;
}

/**
 * Fourier coefficients of a periodic shape shifted by `phase` cycles, for a PeriodicWave with
 * disableNormalization: Σ real[k]·cos(2πkθ) + imag[k]·sin(2πkθ) ≈ scale⁻¹·shape(θ + phase).
 * The coefficients are pre-multiplied by `scale`, the reciprocal of the band-limited wave's peak,
 * so the wave never leaves −1..1 (modulation.md, Synth targets).
 * @returns {{ real: Float32Array, imag: Float32Array }}
 */
export function periodicCoefficients(shape, phase, harmonics = 64) {
  const code = SHAPE_CODE[shape];
  const b = new Float64Array(harmonics + 1);   // sine-series amplitudes of the unshifted shape
  for (let k = 1; k <= harmonics; k++) {
    if (code === 0) b[k] = k === 1 ? 1 : 0;
    else if (code === 1) b[k] = k % 2 ? ((((k - 1) / 2) % 2 ? -1 : 1) * 8) / (Math.PI * Math.PI * k * k) : 0;
    else if (code === 2) b[k] = k % 2 ? 4 / (Math.PI * k) : 0;
    else b[k] = ((k % 2 ? 1 : -1) * 2) / (Math.PI * k);
  }
  // Peak of the band-limited wave, sampled finely enough for 64 harmonics.
  const N = 4096;
  let peak = 0;
  for (let i = 0; i < N; i++) {
    const th = i / N;
    let y = 0;
    for (let k = 1; k <= harmonics; k++) if (b[k] !== 0) y += b[k] * Math.sin(TWO_PI * k * th);
    const a = y < 0 ? -y : y;
    if (a > peak) peak = a;
  }
  const scale = peak > 0 ? 1 / peak : 1;
  const real = new Float32Array(harmonics + 1);
  const imag = new Float32Array(harmonics + 1);
  for (let k = 1; k <= harmonics; k++) {
    // b·sin(2πk(θ + φ)) = b·cos(2πkφ)·sin(2πkθ) + b·sin(2πkφ)·cos(2πkθ)
    imag[k] = b[k] * Math.cos(TWO_PI * k * phase) * scale;
    real[k] = b[k] * Math.sin(TWO_PI * k * phase) * scale;
  }
  return { real, imag };
}

/**
 * Phase clock of one LFO: phase(t) = anchorPhase + hz · (t − anchorT). A rate change re-anchors
 * at the time of the change, so phase accumulates continuously (modulation.md, Sources).
 */
export class LfoClock {
  constructor(phase, hz, t0) {
    this.anchorT = t0;
    this.anchorPhase = phase;
    this.hz = hz;
  }

  phaseAt(t) {
    return this.anchorPhase + this.hz * (t - this.anchorT);
  }

  /** Changes the rate from time `t` on. */
  setHz(hz, t) {
    if (hz === this.hz) return;
    this.anchorPhase = this.phaseAt(t);
    this.anchorT = t;
    this.hz = hz;
  }
}
