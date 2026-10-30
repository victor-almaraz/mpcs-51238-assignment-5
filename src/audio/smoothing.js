// Gain smoothing whose ramps start from a value tracked in JS, not from AudioParam.value
// (audio-safety.md). Every change cancels and holds at its start time first.

import { holdAt } from './envelope.js';

export const GAIN_TAU = 0.01;      // volume, mute/solo, master (decreases)
export const RISE_TAU = 0.05;      // level increases settle over ~150 ms (conservative; no fast jumps up)
export const FILTER_TAU = 0.015;   // filter frequency and resonance
export const POLY_TAU = 0.05;      // polyGain

export class TrackedParam {
  /** `param` must already hold `value` (set it through the node constructor options). */
  constructor(param, value) {
    this.param = param;
    this.seg = { kind: 'set', t0: 0, v0: value };
  }

  valueAt(t) {
    const s = this.seg;
    if (s.kind === 'set' || t <= s.t0) return s.v0;
    if (s.kind === 'target') return s.target + (s.v0 - s.target) * Math.exp(-(t - s.t0) / s.tau);
    if (t >= s.t1) return s.v1;
    return s.v0 + ((s.v1 - s.v0) * (t - s.t0)) / (s.t1 - s.t0);
  }

  /** Final value the param is heading to. */
  get target() {
    const s = this.seg;
    return s.kind === 'set' ? s.v0 : s.kind === 'target' ? s.target : s.v1;
  }

  setTarget(target, t, tau) {
    const v0 = this.valueAt(t);
    holdAt(this.param, t, v0);
    this.param.setTargetAtTime(target, t, tau);
    this.seg = { kind: 'target', t0: t, v0, target, tau };
  }

  linearTo(target, t, duration) {
    const v0 = this.valueAt(t);
    holdAt(this.param, t, v0);
    this.param.linearRampToValueAtTime(target, t + duration);
    this.seg = { kind: 'linear', t0: t, v0, t1: t + duration, v1: target };
  }

  /** Jump to `value` at `t`. Only for params whose signal is silent at `t`. */
  setAt(value, t) {
    holdAt(this.param, t, value);
    this.param.setValueAtTime(value, t);
    this.seg = { kind: 'set', t0: t, v0: value };
  }
}
