/*
 * Filter effect (assignment-3-scope.md, Effects; a3-audio-implementation.md,
 * Filter): one TPT state-variable filter per channel, stereo, in place.
 * Coefficients are computed per block from the smoothed cutoff (clamped to
 * 0.45·fs by svfCoefficients) and resonance Q. The SVF yields LP, BP and HP
 * at once, so a mode change crossfades between outputs over the smoothing time
 * constant instead of switching abruptly.
 */
import { BLOCK } from '../core/constants.js';
import { flushDenormal } from '../core/math.js';
import { clampParam, defineParam } from '../core/params.js';
import { Smoother } from '../core/smoother.js';
import { BANDPASS, HIGHPASS, LOWPASS, svfCoefficients } from './svf.js';

/** Mode option names; indices match LOWPASS, HIGHPASS and BANDPASS in svf.js. */
export const FILTER_MODES = ['lowpass', 'highpass', 'bandpass'];

export const FILTER_PARAMS = [
  defineParam({ id: 'mode', scale: 'enum', options: FILTER_MODES, default: LOWPASS }),
  defineParam({ id: 'cutoff', min: 20, max: 20000, default: 2000, unit: 'Hz', scale: 'log' }),
  defineParam({ id: 'resonance', min: 0.5, max: 12, default: 0.707, unit: 'Q', scale: 'log' }),
];

const DEF = Object.fromEntries(FILTER_PARAMS.map((d) => [d.id, d]));

/** Fraction of a parameter's range a smoothed value must move to trigger a recompute. */
const RECOMPUTE_FRACTION = 1e-6;
const CUTOFF_EPS = RECOMPUTE_FRACTION * (DEF.cutoff.max - DEF.cutoff.min);
const Q_EPS = RECOMPUTE_FRACTION * (DEF.resonance.max - DEF.resonance.min);

export class FilterKernel {
  /** @param {number} fs sample rate, Hz */
  constructor(fs) {
    this.fs = fs;
    this.coef = new Float64Array(4);  // [a1, a2, a3, k]
    this.state = new Float64Array(4); // [ic1L, ic2L, ic1R, ic2R]
    this.mode = DEF.mode.default;
    this.cutoff = new Smoother(fs, DEF.cutoff.default);
    this.resonance = new Smoother(fs, DEF.resonance.default);
    // Output weights per mode; exactly one targets 1.
    this.lp = new Smoother(fs, 1);
    this.hp = new Smoother(fs, 0);
    this.bp = new Smoother(fs, 0);
    this.updateCoefficients();
  }

  /** Zeroes the filter state; parameters jump to their targets. */
  reset() {
    this.state.fill(0);
    this.cutoff.snap(this.cutoff.target);
    this.resonance.snap(this.resonance.target);
    this.lp.snap(this.lp.target);
    this.hp.snap(this.hp.target);
    this.bp.snap(this.bp.target);
    this.updateCoefficients();
  }

  /** Sets a parameter by id; the value is clamped through its ParamDef. Unknown ids are ignored. */
  setParam(id, value) {
    const def = DEF[id];
    if (!def) return;
    const v = clampParam(def, value);
    if (id === 'cutoff') this.cutoff.setTarget(v);
    else if (id === 'resonance') this.resonance.setTarget(v);
    else {
      this.mode = v;
      this.lp.setTarget(v === LOWPASS ? 1 : 0);
      this.hp.setTarget(v === HIGHPASS ? 1 : 0);
      this.bp.setTarget(v === BANDPASS ? 1 : 0);
    }
  }

  /** Processes frames [start, end) of both channels in place. */
  process(bufL, bufR, start, end) {
    for (let s = start; s < end; s += BLOCK) this.block(bufL, bufR, s, s + BLOCK < end ? s + BLOCK : end);
  }

  block(bufL, bufR, start, end) {
    const n = end - start;
    for (let i = 0; i < n; i++) {
      this.cutoff.next();
      this.resonance.next();
    }
    this.cutoff.flush();
    this.resonance.flush();
    const dc = this.cutoff.y - this.usedCutoff;
    const dq = this.resonance.y - this.usedQ;
    if (dc > CUTOFF_EPS || dc < -CUTOFF_EPS || dq > Q_EPS || dq < -Q_EPS) this.updateCoefficients();

    const coef = this.coef;
    const a1 = coef[0];
    const a2 = coef[1];
    const a3 = coef[2];
    const k = coef[3];
    const st = this.state;
    let ic1l = st[0];
    let ic2l = st[1];
    let ic1r = st[2];
    let ic2r = st[3];
    const wl = this.lp;
    const wh = this.hp;
    const wb = this.bp;
    for (let i = start; i < end; i++) {
      const gl = wl.next();
      const gh = wh.next();
      const gb = wb.next();

      const xl = bufL[i];
      const v3l = xl - ic2l;
      const v1l = a1 * ic1l + a2 * v3l;
      const v2l = ic2l + a2 * ic1l + a3 * v3l;
      ic1l = 2 * v1l - ic1l;
      ic2l = 2 * v2l - ic2l;
      bufL[i] = gl * v2l + gb * v1l + gh * (xl - k * v1l - v2l);

      const xr = bufR[i];
      const v3r = xr - ic2r;
      const v1r = a1 * ic1r + a2 * v3r;
      const v2r = ic2r + a2 * ic1r + a3 * v3r;
      ic1r = 2 * v1r - ic1r;
      ic2r = 2 * v2r - ic2r;
      bufR[i] = gl * v2r + gb * v1r + gh * (xr - k * v1r - v2r);
    }
    st[0] = flushDenormal(ic1l);
    st[1] = flushDenormal(ic2l);
    st[2] = flushDenormal(ic1r);
    st[3] = flushDenormal(ic2r);
    wl.flush();
    wh.flush();
    wb.flush();
  }

  updateCoefficients() {
    this.usedCutoff = this.cutoff.y;
    this.usedQ = this.resonance.y;
    svfCoefficients(this.coef, 0, this.usedCutoff, this.usedQ, this.fs);
  }
}
