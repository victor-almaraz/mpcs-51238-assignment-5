/*
 * Saturation (assignment-3-scope.md, Effects; a3-audio-implementation.md,
 * Saturation): tanh with first-order antiderivative anti-aliasing, stereo,
 * in place.
 *   u = x·10^(drive/20); F(u) = ln cosh u = |u| + log1p(exp(−2|u|)) − ln 2
 *   wet = (F(u) − F(u1))/(u − u1), or tanh((u + u1)/2) when |u − u1| < 1e-5
 *   dry = 0.5·(x + x1), matching the half-sample delay of the ADAA output
 *   wet → one-pole lowpass at `tone` (coefficient per block)
 *   out = (dry·(1 − mix) + wet·mix)·10^(output/20)
 * F(u) of each sample is kept for the next, so the cost is one exp and one
 * log1p per sample per channel (accepted exception to Real-time rule 4).
 * Drive and output gains are smoothed as linear gains.
 */
import { BLOCK } from '../core/constants.js';
import { dbToGain, flushDenormal } from '../core/math.js';
import { clampParam, defineParam } from '../core/params.js';
import { Smoother } from '../core/smoother.js';

export const SATURATION_PARAMS = [
  defineParam({ id: 'drive', min: 0, max: 36, default: 6, unit: 'dB', scale: 'lin', step: 0.1 }),
  defineParam({ id: 'tone', min: 1000, max: 16000, default: 8000, unit: 'Hz', scale: 'log' }),
  defineParam({ id: 'mix', min: 0, max: 1, default: 1, unit: 'fraction', scale: 'lin', step: 0.01 }),
  defineParam({ id: 'output', min: -24, max: 6, default: -3, unit: 'dB', scale: 'lin', step: 0.1 }),
];

const DEF = Object.fromEntries(SATURATION_PARAMS.map((d) => [d.id, d]));

/** Below this input step the ADAA quotient is ill-conditioned and the midpoint tanh is used. */
const ADAA_EPS = 1e-5;

/** One-pole lowpass coefficient for corner `fc` at `fs`. */
function onePoleCoeff(fc, fs) {
  const f = fc > 0.45 * fs ? 0.45 * fs : fc;
  return 1 - Math.exp((-2 * Math.PI * f) / fs);
}

export class SaturationKernel {
  /** @param {number} fs sample rate, Hz */
  constructor(fs) {
    this.fs = fs;
    this.drive = new Smoother(fs, dbToGain(DEF.drive.default));
    this.tone = new Smoother(fs, DEF.tone.default);
    this.mix = new Smoother(fs, DEF.mix.default);
    this.output = new Smoother(fs, dbToGain(DEF.output.default));
    // Per channel [L, R]: previous input x1, previous driven input u1, F(u1), tone lowpass state.
    this.x1 = new Float64Array(2);
    this.u1 = new Float64Array(2);
    this.f1 = new Float64Array(2);
    this.lp = new Float64Array(2);
  }

  /** Zeroes the state; parameters jump to their targets. */
  reset() {
    this.x1.fill(0);
    this.u1.fill(0);
    this.f1.fill(0);
    this.lp.fill(0);
    this.drive.snap(this.drive.target);
    this.tone.snap(this.tone.target);
    this.mix.snap(this.mix.target);
    this.output.snap(this.output.target);
  }

  /** Sets a parameter by id; the value is clamped through its ParamDef. Unknown ids are ignored. */
  setParam(id, value) {
    const def = DEF[id];
    if (!def) return;
    const v = clampParam(def, value);
    if (id === 'drive') this.drive.setTarget(dbToGain(v));
    else if (id === 'tone') this.tone.setTarget(v);
    else if (id === 'mix') this.mix.setTarget(v);
    else this.output.setTarget(dbToGain(v));
  }

  /** Processes frames [start, end) of both channels in place. */
  process(bufL, bufR, start, end) {
    for (let s = start; s < end; s += BLOCK) this.block(bufL, bufR, s, s + BLOCK < end ? s + BLOCK : end);
  }

  block(bufL, bufR, start, end) {
    const n = end - start;
    const tone = this.tone;
    for (let i = 0; i < n; i++) tone.next();
    tone.flush();
    const a = onePoleCoeff(tone.y, this.fs);
    const drive = this.drive;
    const mix = this.mix;
    const output = this.output;
    const LN2 = Math.LN2;
    let x1l = this.x1[0];
    let x1r = this.x1[1];
    let u1l = this.u1[0];
    let u1r = this.u1[1];
    let f1l = this.f1[0];
    let f1r = this.f1[1];
    let lpl = this.lp[0];
    let lpr = this.lp[1];
    // Settled controls (the usual case) are read once per block.
    const steady = drive.settled() && mix.settled() && output.settled();
    let g = drive.y;
    let m = mix.y;
    let o = output.y;
    for (let i = start; i < end; i++) {
      if (!steady) {
        g = drive.next();
        m = mix.next();
        o = output.next();
      }

      const xl = bufL[i];
      const xl1 = x1l;
      const u1lPrev = u1l;
      const f1lPrev = f1l;
      const lplPrev = lpl;
      const lprPrev = lpr;
      const ul = xl * g;
      const aul = ul < 0 ? -ul : ul;
      const fl = aul + Math.log1p(Math.exp(-2 * aul)) - LN2;
      const dul = ul - u1l;
      const wl = dul > ADAA_EPS || dul < -ADAA_EPS ? (fl - f1l) / dul : Math.tanh(0.5 * (ul + u1l));
      lpl += a * (wl - lpl);
      const dryl = 0.5 * (xl + x1l);
      bufL[i] = (dryl + (lpl - dryl) * m) * o;
      x1l = xl;
      u1l = ul;
      f1l = fl;

      const xr = bufR[i];
      if (xr === xl && x1r === xl1 && u1r === u1lPrev && f1r === f1lPrev && lprPrev === lplPrev) {
        // Dual-mono input with equal state (mono sources in a stereo chain): the right channel is the left.
        bufR[i] = bufL[i];
        lpr = lpl;
        x1r = xr;
        u1r = ul;
        f1r = fl;
        continue;
      }
      const ur = xr * g;
      const aur = ur < 0 ? -ur : ur;
      const fr = aur + Math.log1p(Math.exp(-2 * aur)) - LN2;
      const dur = ur - u1r;
      const wr = dur > ADAA_EPS || dur < -ADAA_EPS ? (fr - f1r) / dur : Math.tanh(0.5 * (ur + u1r));
      lpr += a * (wr - lpr);
      const dryr = 0.5 * (xr + x1r);
      bufR[i] = (dryr + (lpr - dryr) * m) * o;
      x1r = xr;
      u1r = ur;
      f1r = fr;
    }
    this.x1[0] = x1l;
    this.x1[1] = x1r;
    this.u1[0] = u1l;
    this.u1[1] = u1r;
    this.f1[0] = f1l;
    this.f1[1] = f1r;
    this.lp[0] = flushDenormal(lpl);
    this.lp[1] = flushDenormal(lpr);
    drive.flush();
    mix.flush();
    output.flush();
  }
}
