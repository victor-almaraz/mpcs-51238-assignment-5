// Web Audio modulation sources for the synth audio-rate path (modulation.md, Synth targets):
//   periodic LFO  → OscillatorNode with a phase-shifted, peak-normalized PeriodicWave
//   random/smooth → ConstantSourceNode whose offset pump() schedules per cycle
//   data value    → ConstantSourceNode whose offset follows each post
// Each source exposes `node` (connect it to route gains), `setHz(hz, t)` for rate changes,
// `schedule(until)` for pump() and `stop(t)`.

import { holdAt } from '../envelope.js';
import { periodicCoefficients, stepValue, lfoValue } from './lfo.js';

/** Most cycle boundaries one schedule() call writes (20 Hz × a generous lookahead). */
const MAX_STEPS_PER_PUMP = 64;

export class PeriodicSource {
  /**
   * @param {BaseAudioContext} ctx
   * @param {{ shape: string }} lfo
   * @param {import('./lfo.js').LfoClock} clock
   * @param {number} t start time
   */
  constructor(ctx, lfo, clock, t) {
    const { real, imag } = periodicCoefficients(lfo.shape, clock.phaseAt(t));
    const wave = ctx.createPeriodicWave(real, imag, { disableNormalization: true });
    this.node = new OscillatorNode(ctx, { frequency: clock.hz, periodicWave: wave });
    this.node.start(t);
  }

  setHz(hz, t, tau = 0) {
    if (tau > 0) this.node.frequency.setTargetAtTime(hz, t, tau);
    else this.node.frequency.setValueAtTime(hz, t);
  }

  schedule() {}

  stop(t) {
    try { this.node.stop(t); } catch { /* already stopped */ }
  }
}

export class SteppedSource {
  /**
   * @param {BaseAudioContext} ctx
   * @param {{ code: number, index: number, smooth: number, decay: number }} lfo compiled LFO
   * @param {number} seed
   * @param {import('./lfo.js').LfoClock} clock
   * @param {number} t start time
   */
  constructor(ctx, lfo, seed, clock, t) {
    this.lfo = lfo;
    this.seed = seed;
    this.clock = clock;
    this.node = new ConstantSourceNode(ctx, { offset: this.valueAt(t) });
    this.node.start(t);
    this.until = t;
  }

  valueAt(t) {
    const L = this.lfo;
    return lfoValue(L.code, this.clock.phaseAt(t), this.seed, L.index, L.smooth, L.decay);
  }

  /** Writes the cycle starts in (until, end]: a held value, or the one-pole curve toward it. */
  schedule(end) {
    const c = this.clock;
    if (!(c.hz > 0) || end <= this.until) return;
    const L = this.lfo;
    const off = this.node.offset;
    let k = Math.floor(c.phaseAt(this.until)) + 1;
    for (let n = 0; n < MAX_STEPS_PER_PUMP; n++, k++) {
      const tk = c.anchorT + (k - c.anchorPhase) / c.hz;
      if (tk > end) break;
      const v = stepValue(this.seed, L.index, k);
      if (L.smooth > 0) off.setTargetAtTime(v, tk, L.smooth / c.hz);
      else off.setValueAtTime(v, tk);
    }
    this.until = end;
  }

  /** Rate change: drops scheduled steps after `t` and continues from the value at `t`. */
  setHz(hz, t) {
    this.clock.setHz(hz, t);
    holdAt(this.node.offset, t, this.valueAt(t));
    this.until = t;
  }

  stop(t) {
    try { this.node.stop(t); } catch { /* already stopped */ }
  }
}

export class DataSource {
  /**
   * @param {BaseAudioContext} ctx
   * @param {{ valueAt(t: number): number, target: number, tau: number }} data
   * @param {number} t
   */
  constructor(ctx, data, t) {
    this.node = new ConstantSourceNode(ctx, { offset: data.valueAt(t) });
    if (data.tau > 0) this.node.offset.setTargetAtTime(data.target, t, data.tau);
    else this.node.offset.setValueAtTime(data.target, t);
    this.node.start(t);
  }

  /** Follows a new post: one-pole toward `value` with time constant `tau` s. */
  post(value, t, tau) {
    if (tau > 0) this.node.offset.setTargetAtTime(value, t, tau);
    else this.node.offset.setValueAtTime(value, t);
  }

  setHz() {}

  schedule() {}

  stop(t) {
    try { this.node.stop(t); } catch { /* already stopped */ }
  }
}
