/*
 * 3-band EQ (assignment-3-scope.md, Effects; a3-audio-implementation.md,
 * 3-band EQ): low shelf, peak and high shelf biquads in series, stereo, in
 * place. A band's coefficients are recomputed at most once per block, and only
 * when one of its smoothed parameters moved more than 1e-6 of its range.
 */
import { BLOCK } from '../core/constants.js';
import { clampParam, defineParam } from '../core/params.js';
import { Smoother } from '../core/smoother.js';
import {
  BIQUAD_COEFS,
  BIQUAD_STATE,
  biquadStereo,
  highShelfCoefficients,
  lowShelfCoefficients,
  peakCoefficients,
} from './biquad.js';

export const EQ3_PARAMS = [
  defineParam({ id: 'lowFreq', min: 30, max: 500, default: 120, unit: 'Hz', scale: 'log' }),
  defineParam({ id: 'lowGain', min: -18, max: 18, default: 0, unit: 'dB', scale: 'lin', step: 0.1 }),
  defineParam({ id: 'midFreq', min: 200, max: 8000, default: 1000, unit: 'Hz', scale: 'log' }),
  defineParam({ id: 'midGain', min: -18, max: 18, default: 0, unit: 'dB', scale: 'lin', step: 0.1 }),
  defineParam({ id: 'midQ', min: 0.3, max: 8, default: 0.7, unit: '', scale: 'log' }),
  defineParam({ id: 'highFreq', min: 2000, max: 16000, default: 8000, unit: 'Hz', scale: 'log' }),
  defineParam({ id: 'highGain', min: -18, max: 18, default: 0, unit: 'dB', scale: 'lin', step: 0.1 }),
];

const COUNT = EQ3_PARAMS.length;
const INDEX = Object.fromEntries(EQ3_PARAMS.map((d, i) => [d.id, i]));
const LOW_FREQ = INDEX.lowFreq;
const LOW_GAIN = INDEX.lowGain;
const MID_FREQ = INDEX.midFreq;
const MID_GAIN = INDEX.midGain;
const MID_Q = INDEX.midQ;
const HIGH_FREQ = INDEX.highFreq;
const HIGH_GAIN = INDEX.highGain;

/** Fraction of a parameter's range a smoothed value must move to trigger a recompute. */
const RECOMPUTE_FRACTION = 1e-6;

export class Eq3Kernel {
  /** @param {number} fs sample rate, Hz */
  constructor(fs) {
    this.fs = fs;
    this.coef = new Float64Array(3 * BIQUAD_COEFS);   // low, mid, high sections
    this.state = new Float64Array(3 * BIQUAD_STATE);  // [s1L, s2L, s1R, s2R] per section
    this.used = new Float64Array(COUNT);              // smoothed values behind the current coefficients
    this.eps = new Float64Array(COUNT);               // recompute threshold per parameter
    this.params = [];                                  // one Smoother per EQ3_PARAMS entry
    for (let p = 0; p < COUNT; p++) {
      const def = EQ3_PARAMS[p];
      this.params.push(new Smoother(fs, def.default));
      this.eps[p] = RECOMPUTE_FRACTION * (def.max - def.min);
    }
    this.updateLow();
    this.updateMid();
    this.updateHigh();
  }

  /** Zeroes the filter state; parameters jump to their targets. */
  reset() {
    this.state.fill(0);
    for (let p = 0; p < COUNT; p++) this.params[p].snap(this.params[p].target);
    this.updateLow();
    this.updateMid();
    this.updateHigh();
  }

  /** Sets a parameter by id; the value is clamped through its ParamDef. Unknown ids are ignored. */
  setParam(id, value) {
    const p = INDEX[id];
    if (p === undefined) return;
    this.params[p].setTarget(clampParam(EQ3_PARAMS[p], value));
  }

  /** Processes frames [start, end) of both channels in place. */
  process(bufL, bufR, start, end) {
    for (let s = start; s < end; s += BLOCK) this.block(bufL, bufR, s, s + BLOCK < end ? s + BLOCK : end);
  }

  block(bufL, bufR, start, end) {
    const n = end - start;
    const params = this.params;
    for (let p = 0; p < COUNT; p++) {
      const sm = params[p];
      for (let i = 0; i < n; i++) sm.next();
      sm.flush();
    }
    if (this.moved(LOW_FREQ) || this.moved(LOW_GAIN)) this.updateLow();
    if (this.moved(MID_FREQ) || this.moved(MID_GAIN) || this.moved(MID_Q)) this.updateMid();
    if (this.moved(HIGH_FREQ) || this.moved(HIGH_GAIN)) this.updateHigh();
    biquadStereo(this.coef, 0, this.state, 0, bufL, bufR, start, end);
    biquadStereo(this.coef, BIQUAD_COEFS, this.state, BIQUAD_STATE, bufL, bufR, start, end);
    biquadStereo(this.coef, 2 * BIQUAD_COEFS, this.state, 2 * BIQUAD_STATE, bufL, bufR, start, end);
  }

  moved(p) {
    const d = this.params[p].y - this.used[p];
    return d > this.eps[p] || d < -this.eps[p];
  }

  take(p) {
    const v = this.params[p].y;
    this.used[p] = v;
    return v;
  }

  updateLow() {
    lowShelfCoefficients(this.coef, 0, this.take(LOW_FREQ), this.take(LOW_GAIN), this.fs);
  }

  updateMid() {
    peakCoefficients(this.coef, BIQUAD_COEFS, this.take(MID_FREQ), this.take(MID_GAIN), this.take(MID_Q), this.fs);
  }

  updateHigh() {
    highShelfCoefficients(this.coef, 2 * BIQUAD_COEFS, this.take(HIGH_FREQ), this.take(HIGH_GAIN), this.fs);
  }
}
