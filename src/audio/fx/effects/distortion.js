/*
 * Distortion (assignment-3-scope.md, Effects; a3-audio-implementation.md,
 * Distortion): a waveshaper with three curves, stereo, in place.
 *   u = x·10^(drive/20) + bias
 *   softclip  f(u) = 1.5·(u − u³/3), |u| ≤ 1; ±1 beyond
 *   hardclip  f(u) = clamp(u, −1, 1)
 *   foldback  f(u) = sin(π·u/2)  (folds back beyond |u| = 1)
 *   wet = (F(u) − F(u1))/(u − u1) with F the antiderivative of f (first-order
 *   ADAA), or f((u + u1)/2) when |u − u1| < 1e-5
 *   wet → one-pole lowpass at `tone` → DC blocker (10 Hz), which removes the
 *   offset the bias adds
 *   dry = 0.5·(x + x1), matching the half-sample delay of the ADAA output
 *   out = (dry·(1 − mix) + wet·mix)·10^(output/20), output ≤ 0 dB
 *
 * Safety: |f| ≤ 1, so the ADAA quotient and the lowpass stay within ±1 and the
 * DC blocker within ±2; with output ≤ 0 dB the wet path never exceeds +6 dBFS
 * before the master limiter. A mode change crossfades the curves over 10 ms.
 * Drive, bias, mix and output are smoothed; the tone coefficient is set per
 * block. The foldback curve calls Math.cos once per sample per channel, which
 * Real-time rule 4 does not restrict.
 */
import { BLOCK } from '../core/constants.js';
import { dbToGain, flushDenormal } from '../core/math.js';
import { clampParam, defineParam } from '../core/params.js';
import { Smoother } from '../core/smoother.js';
import { DcBlocker } from '../safety/dc-blocker.js';

export const DISTORTION_MODES = ['softclip', 'hardclip', 'foldback'];

export const DISTORTION_PARAMS = [
  defineParam({ id: 'mode', scale: 'enum', options: DISTORTION_MODES, default: 0 }),
  defineParam({ id: 'drive', min: 0, max: 48, default: 12, unit: 'dB', scale: 'lin', step: 0.1 }),
  defineParam({ id: 'bias', min: -0.5, max: 0.5, default: 0, unit: '', scale: 'lin', step: 0.01 }),
  defineParam({ id: 'tone', min: 500, max: 16000, default: 6000, unit: 'Hz', scale: 'log' }),
  defineParam({ id: 'mix', min: 0, max: 1, default: 1, unit: 'fraction', scale: 'lin', step: 0.01 }),
  defineParam({ id: 'output', min: -36, max: 0, default: -6, unit: 'dB', scale: 'lin', step: 0.1 }),
];

const DEF = Object.fromEntries(DISTORTION_PARAMS.map((d) => [d.id, d]));

/** Below this input step the ADAA quotient is ill-conditioned and the midpoint curve is used. */
const ADAA_EPS = 1e-5;
/** Curve crossfade on a mode change, s. */
const MODE_FADE_S = 0.01;
const HALF_PI = Math.PI / 2;
const TWO_OVER_PI = 2 / Math.PI;

/** The curve `mode` at u. */
export function shape(mode, u) {
  if (mode === 0) return u >= 1 ? 1 : u <= -1 ? -1 : 1.5 * (u - (u * u * u) / 3);
  if (mode === 1) return u >= 1 ? 1 : u <= -1 ? -1 : u;
  return Math.sin(HALF_PI * u);
}

/** The antiderivative of curve `mode` at u (continuous; constants cancel in differences). */
export function antiderivative(mode, u) {
  const a = u < 0 ? -u : u;
  if (mode === 0) {
    if (a <= 1) {
      const u2 = u * u;
      return 1.5 * (u2 / 2 - (u2 * u2) / 12);
    }
    return a - 0.375; // 1.5·(1/2 − 1/12) − 1 at a = 1
  }
  if (mode === 1) return a <= 1 ? (u * u) / 2 : a - 0.5;
  return -TWO_OVER_PI * Math.cos(HALF_PI * u);
}

/** One-pole lowpass coefficient for corner `fc` at `fs`. */
function onePoleCoeff(fc, fs) {
  const f = fc > 0.45 * fs ? 0.45 * fs : fc;
  return 1 - Math.exp((-2 * Math.PI * f) / fs);
}

const MODES = DISTORTION_MODES.length;

export class DistortionKernel {
  /** @param {number} fs sample rate, Hz */
  constructor(fs) {
    this.fs = fs;
    this.drive = new Smoother(fs, dbToGain(DEF.drive.default));
    this.bias = new Smoother(fs, DEF.bias.default);
    this.tone = new Smoother(fs, DEF.tone.default);
    this.mix = new Smoother(fs, DEF.mix.default);
    this.output = new Smoother(fs, dbToGain(DEF.output.default));
    this.mode = DEF.mode.default;
    this.weights = new Float64Array(MODES); // curve weights, ramped on a mode change
    this.weights[this.mode] = 1;
    this.fadeStep = 1 / Math.max(1, Math.round(MODE_FADE_S * fs));
    // Per channel [L, R]: previous input x1, previous shaped input u1, tone lowpass state.
    this.x1 = new Float64Array(2);
    this.u1 = new Float64Array(2);
    this.lp = new Float64Array(2);
    this.f1 = new Float64Array(2 * MODES); // F(u1) per curve and channel
    this.dc = new DcBlocker(fs);
    this.wetL = new Float32Array(BLOCK);
    this.wetR = new Float32Array(BLOCK);
  }

  /** Zeroes the state; parameters jump to their targets. */
  reset() {
    this.x1.fill(0);
    this.u1.fill(0);
    this.lp.fill(0);
    for (let m = 0; m < MODES; m++) {
      const f0 = antiderivative(m, 0);
      this.f1[2 * m] = f0;
      this.f1[2 * m + 1] = f0;
    }
    this.weights.fill(0);
    this.weights[this.mode] = 1;
    this.dc.reset();
    for (const s of [this.drive, this.bias, this.tone, this.mix, this.output]) s.snap(s.target);
  }

  /** Sets a parameter by id; the value is clamped through its ParamDef. Unknown ids are ignored. */
  setParam(id, value) {
    const def = DEF[id];
    if (!def) return;
    const v = clampParam(def, value);
    if (id === 'mode') {
      if (v === this.mode) return;
      // The incoming curve's history starts from the current input, so its first quotient is valid.
      for (let c = 0; c < 2; c++) this.f1[2 * v + c] = antiderivative(v, this.u1[c]);
      this.mode = v;
    } else if (id === 'drive') this.drive.setTarget(dbToGain(v));
    else if (id === 'bias') this.bias.setTarget(v);
    else if (id === 'tone') this.tone.setTarget(v);
    else if (id === 'mix') this.mix.setTarget(v);
    else this.output.setTarget(dbToGain(v));
  }

  /** Processes frames [start, end) of both channels in place. */
  process(bufL, bufR, start, end) {
    for (let s = start; s < end; s += BLOCK) this.block(bufL, bufR, s, s + BLOCK < end ? s + BLOCK : end);
  }

  /** The ADAA output of channel `c` for shaped input `u`, advancing that channel's curve state. */
  wet(c, u) {
    const u1 = this.u1[c];
    const du = u - u1;
    const w = this.weights;
    let y = 0;
    for (let m = 0; m < MODES; m++) {
      if (w[m] === 0) continue;
      const F = antiderivative(m, u);
      const k = 2 * m + c;
      const q = du > ADAA_EPS || du < -ADAA_EPS ? (F - this.f1[k]) / du : shape(m, 0.5 * (u + u1));
      this.f1[k] = F;
      y += w[m] * q;
    }
    this.u1[c] = u;
    return y;
  }

  block(bufL, bufR, start, end) {
    const n = end - start;
    const tone = this.tone;
    for (let i = 0; i < n; i++) tone.next();
    tone.flush();
    const a = onePoleCoeff(tone.y, this.fs);
    const drive = this.drive;
    const bias = this.bias;
    const w = this.weights;
    const wetL = this.wetL;
    const wetR = this.wetR;
    let lpl = this.lp[0];
    let lpr = this.lp[1];
    for (let i = 0; i < n; i++) {
      // Ramp the curve weights toward the selected mode.
      for (let m = 0; m < MODES; m++) {
        const target = m === this.mode ? 1 : 0;
        if (w[m] < target) w[m] = Math.min(target, w[m] + this.fadeStep);
        else if (w[m] > target) w[m] = Math.max(target, w[m] - this.fadeStep);
      }
      const g = drive.next();
      const b = bias.next();
      lpl += a * (this.wet(0, bufL[start + i] * g + b) - lpl);
      lpr += a * (this.wet(1, bufR[start + i] * g + b) - lpr);
      wetL[i] = lpl;
      wetR[i] = lpr;
    }
    this.lp[0] = flushDenormal(lpl);
    this.lp[1] = flushDenormal(lpr);
    this.dc.process(wetL, wetR, 0, n);
    const mix = this.mix;
    const output = this.output;
    let x1l = this.x1[0];
    let x1r = this.x1[1];
    for (let i = 0; i < n; i++) {
      const m = mix.next();
      const o = output.next();
      const xl = bufL[start + i];
      const xr = bufR[start + i];
      const dryl = 0.5 * (xl + x1l);
      const dryr = 0.5 * (xr + x1r);
      bufL[start + i] = (dryl + (wetL[i] - dryl) * m) * o;
      bufR[start + i] = (dryr + (wetR[i] - dryr) * m) * o;
      x1l = xl;
      x1r = xr;
    }
    this.x1[0] = x1l;
    this.x1[1] = x1r;
    drive.flush();
    bias.flush();
    mix.flush();
    output.flush();
  }
}
