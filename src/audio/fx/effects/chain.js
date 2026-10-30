/*
 * Effect chain slots (assignment-3-scope.md, Effects; a3-audio-implementation.md,
 * Shared slot rules). An EffectSlot wraps one kernel and processes stereo in
 * place, in chunks of at most BLOCK frames:
 *   - Bypass crossfades linearly between dry and wet over 10 ms (project limit).
 *     A fully bypassed slot does not run its kernel.
 *   - After each chunk, e = Σ wet² over both channels. If e !== e or e > 1e12,
 *     the kernel is reset, the slot bypasses at once, the chunk outputs the dry
 *     signal, and the fault is reported once through takeFault().
 *   - A chunk whose input is already non-finite is silenced without
 *     running the kernel or reporting a fault, so one bad source never faults
 *     every slot after it.
 * Dry copies live in BLOCK-sized scratch buffers allocated at construction.
 */
import { BLOCK } from '../core/constants.js';

/** Bypass crossfade time, s (project limit). */
export const BYPASS_FADE_S = 0.01;

/** Block energy above which a slot faults. */
export const FAULT_ENERGY = 1e12;

export class EffectSlot {
  /**
   * @param {number} fs sample rate, Hz
   * @param {{ reset(): void, setParam(id: string, v: number): void, process(l: Float32Array, r: Float32Array, s: number, e: number): void }} kernel
   */
  constructor(fs, kernel) {
    this.kernel = kernel;
    this.dryL = new Float32Array(BLOCK);
    this.dryR = new Float32Array(BLOCK);
    this.step = 1 / Math.max(1, Math.round(BYPASS_FADE_S * fs)); // wet-weight change per frame
    this.wet = 1;      // current wet weight
    this.target = 1;   // 1 active, 0 bypassed
    this.bypassed = false;
    this.faulted = false;  // bypassed by a fault; cleared by setBypass(false)
    this.pending = false;  // fault not yet taken
  }

  /** Bypasses (true) or activates (false) the slot with a 10 ms crossfade. Leaving full bypass resets the kernel. */
  setBypass(on) {
    const b = Boolean(on);
    if (!b) this.faulted = false;
    if (b === this.bypassed) return;
    if (!b && this.wet === 0) this.kernel.reset();
    this.bypassed = b;
    this.target = b ? 0 : 1;
  }

  /** Forwards a parameter to the kernel (clamped there). */
  setParam(id, value) {
    this.kernel.setParam(id, value);
  }

  /** Resets the kernel's state. */
  reset() {
    this.kernel.reset();
  }

  /** True while a fault waits to be taken (takeFault). */
  hasFault() {
    return this.pending;
  }

  /** True once after a fault, false otherwise. */
  takeFault() {
    if (!this.pending) return false;
    this.pending = false;
    return true;
  }

  /** Processes frames [start, end) of both channels in place. */
  process(bufL, bufR, start, end) {
    for (let s = start; s < end; s += BLOCK) this.block(bufL, bufR, s, s + BLOCK < end ? s + BLOCK : end);
  }

  block(bufL, bufR, start, end) {
    if (this.wet === 0 && this.target === 0) return;
    const n = end - start;
    const dryL = this.dryL;
    const dryR = this.dryR;
    let inE = 0;
    for (let i = 0; i < n; i++) {
      const l = bufL[start + i];
      const r = bufR[start + i];
      dryL[i] = l;
      dryR[i] = r;
      inE += l * l + r * r;
    }
    if (inE !== inE || inE === Infinity) {
      // A non-finite input is not this slot's fault: silence the block so the
      // later slots and the bus never see it, and keep the kernel's state clean.
      bufL.fill(0, start, end);
      bufR.fill(0, start, end);
      return;
    }
    this.kernel.process(bufL, bufR, start, end);

    let e = 0;
    for (let i = start; i < end; i++) e += bufL[i] * bufL[i] + bufR[i] * bufR[i];
    if (e !== e || e > FAULT_ENERGY) {
      this.kernel.reset();
      for (let i = 0; i < n; i++) {
        bufL[start + i] = dryL[i];
        bufR[start + i] = dryR[i];
      }
      this.wet = 0;
      this.target = 0;
      this.bypassed = true;
      this.faulted = true;
      this.pending = true;
      return;
    }

    if (this.wet === this.target) return;
    const target = this.target;
    const step = target > this.wet ? this.step : -this.step;
    let w = this.wet;
    for (let i = 0; i < n; i++) {
      w += step;
      if ((step > 0 && w > target) || (step < 0 && w < target)) w = target;
      const k = start + i;
      bufL[k] = dryL[i] + (bufL[k] - dryL[i]) * w;
      bufR[k] = dryR[i] + (bufR[k] - dryR[i]) * w;
    }
    this.wet = w;
  }
}

/** Runs slots[0 … count − 1] in order over frames [start, end) of both channels, in place. */
export function processChain(slots, count, bufL, bufR, start, end) {
  for (let i = 0; i < count; i++) slots[i].process(bufL, bufR, start, end);
}
