/*
 * Reverb, Freeverb structure (assignment-3-scope.md, Effects;
 * a3-audio-implementation.md, Reverb), stereo, in place.
 *   Input: (L + R)·0.015 after a 0–200 ms pre-delay (smoothed, interpolated).
 *   Per channel: 8 parallel lowpass-feedback combs into 4 series allpasses (g = 0.5).
 *   Lengths at 44.1 kHz (right channel + 23), scaled by fs/44100; size 0–1
 *   scales comb lengths by 0.5–1.0. Buffers are allocated at maximum length.
 *   Comb: y = buf[w − L]; f = y·(1 − d) + f·d; buf[w] = in + g·f
 *   g_i = min(0.98, 10^(−3·L_i/(T60·fs))), T60 = decay; d = 0.4·damping.
 *   Allpass: b = buf[j]; buf[j] = x + 0.5·b; y = b − x.
 *   out = dry·(1 − mix) + 3·wet·mix
 * Comb lengths and gains are recomputed at most once per block, only when the
 * smoothed size or decay moved more than 1e-6 of its range. Values written to
 * the delay buffers below the denormal threshold are stored as 0.
 */
import { BLOCK, DENORMAL_THRESHOLD } from '../core/constants.js';
import { flushDenormal } from '../core/math.js';
import { clampParam, defineParam } from '../core/params.js';
import { Smoother } from '../core/smoother.js';

/** Reverb instances allowed per project (project limit; enforced by the engine). */
export const MAX_REVERBS = 4;

/** Freeverb tunings at 44.1 kHz. */
const COMB_TUNING = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
const ALLPASS_TUNING = [556, 441, 341, 225];
const STEREO_SPREAD = 23;
const TUNING_FS = 44100;

const COMBS = COMB_TUNING.length;       // per channel
const ALLPASSES = ALLPASS_TUNING.length; // per channel
const INPUT_GAIN = 0.015;
const WET_SCALE = 3;
const ALLPASS_G = 0.5;
const COMB_GAIN_MAX = 0.98;
const DAMP_SCALE = 0.4;
const MAX_PRE_DELAY_MS = 200;

export const REVERB_PARAMS = [
  defineParam({ id: 'size', min: 0, max: 1, default: 0.75, unit: 'fraction', scale: 'lin', step: 0.01 }),
  defineParam({ id: 'decay', min: 0.2, max: 10, default: 2, unit: 's', scale: 'log' }),
  defineParam({ id: 'damping', min: 0, max: 1, default: 0.5, unit: 'fraction', scale: 'lin', step: 0.01 }),
  defineParam({ id: 'preDelay', min: 0, max: MAX_PRE_DELAY_MS, default: 10, unit: 'ms', scale: 'lin', step: 1 }),
  defineParam({ id: 'mix', min: 0, max: 1, default: 0.25, unit: 'fraction', scale: 'lin', step: 0.01 }),
];

const DEF = Object.fromEntries(REVERB_PARAMS.map((d) => [d.id, d]));

/** Fraction of a parameter's range a smoothed value must move to trigger a recompute. */
const RECOMPUTE_FRACTION = 1e-6;
const SIZE_EPS = RECOMPUTE_FRACTION * (DEF.size.max - DEF.size.min);
const DECAY_EPS = RECOMPUTE_FRACTION * (DEF.decay.max - DEF.decay.min);

export class ReverbKernel {
  /** @param {number} fs sample rate, Hz */
  constructor(fs) {
    this.fs = fs;
    const scale = fs / TUNING_FS;
    // Combs 0–7 feed the left output, 8–15 the right; allpasses likewise 0–3 and 4–7.
    this.combBase = new Float64Array(2 * COMBS); // length at size 1, frames
    this.combOff = new Int32Array(2 * COMBS);    // offset into combBuf
    this.combCap = new Int32Array(2 * COMBS);    // allocated length
    this.combLen = new Int32Array(2 * COMBS);    // current delay length
    this.combPos = new Int32Array(2 * COMBS);    // write index
    this.combGain = new Float64Array(2 * COMBS);
    this.combStore = new Float64Array(2 * COMBS); // in-loop lowpass state f
    let total = 0;
    for (let j = 0; j < 2 * COMBS; j++) {
      const tuning = COMB_TUNING[j % COMBS] + (j < COMBS ? 0 : STEREO_SPREAD);
      this.combBase[j] = tuning * scale;
      this.combCap[j] = Math.ceil(tuning * scale) + 1;
      this.combOff[j] = total;
      total += this.combCap[j];
    }
    this.combBuf = new Float32Array(total);

    this.apOff = new Int32Array(2 * ALLPASSES);
    this.apLen = new Int32Array(2 * ALLPASSES);
    this.apPos = new Int32Array(2 * ALLPASSES);
    total = 0;
    for (let j = 0; j < 2 * ALLPASSES; j++) {
      const tuning = ALLPASS_TUNING[j % ALLPASSES] + (j < ALLPASSES ? 0 : STEREO_SPREAD);
      this.apLen[j] = Math.max(1, Math.round(tuning * scale));
      this.apOff[j] = total;
      total += this.apLen[j];
    }
    this.apBuf = new Float32Array(total);

    this.preSize = Math.ceil((MAX_PRE_DELAY_MS / 1000) * fs) + 2;
    this.preBuf = new Float32Array(this.preSize);
    this.prePos = 0;

    // Per-block scratch: comb input, then each channel's wet sum.
    this.input = new Float32Array(BLOCK);
    this.wetL = new Float32Array(BLOCK);
    this.wetR = new Float32Array(BLOCK);

    this.size = new Smoother(fs, DEF.size.default);
    this.decay = new Smoother(fs, DEF.decay.default);
    this.damping = new Smoother(fs, DEF.damping.default);
    this.preDelay = new Smoother(fs, (DEF.preDelay.default / 1000) * fs); // frames
    this.mix = new Smoother(fs, DEF.mix.default);
    this.updateCombs();
  }

  /** Zeroes every buffer and filter; parameters jump to their targets. */
  reset() {
    this.combBuf.fill(0);
    this.combPos.fill(0);
    this.combStore.fill(0);
    this.apBuf.fill(0);
    this.apPos.fill(0);
    this.preBuf.fill(0);
    this.prePos = 0;
    this.size.snap(this.size.target);
    this.decay.snap(this.decay.target);
    this.damping.snap(this.damping.target);
    this.preDelay.snap(this.preDelay.target);
    this.mix.snap(this.mix.target);
    this.updateCombs();
  }

  /** Sets a parameter by id; the value is clamped through its ParamDef. Unknown ids are ignored. */
  setParam(id, value) {
    const def = DEF[id];
    if (!def) return;
    const v = clampParam(def, value);
    if (id === 'size') this.size.setTarget(v);
    else if (id === 'decay') this.decay.setTarget(v);
    else if (id === 'damping') this.damping.setTarget(v);
    else if (id === 'preDelay') this.preDelay.setTarget((v / 1000) * this.fs);
    else this.mix.setTarget(v);
  }

  /** Comb lengths from the smoothed size and gains g_i = min(0.98, 10^(−3·L_i/(T60·fs))). */
  updateCombs() {
    this.usedSize = this.size.y;
    this.usedDecay = this.decay.y;
    const lengthScale = 0.5 + 0.5 * this.usedSize;
    const k = -3 / (this.usedDecay * this.fs);
    for (let j = 0; j < 2 * COMBS; j++) {
      let len = Math.round(this.combBase[j] * lengthScale);
      if (len < 1) len = 1;
      if (len >= this.combCap[j]) len = this.combCap[j] - 1;
      this.combLen[j] = len;
      const g = 10 ** (k * len);
      this.combGain[j] = g < COMB_GAIN_MAX ? g : COMB_GAIN_MAX;
    }
  }

  /** Processes frames [start, end) of both channels in place. */
  process(bufL, bufR, start, end) {
    for (let s = start; s < end; s += BLOCK) this.block(bufL, bufR, s, s + BLOCK < end ? s + BLOCK : end);
  }

  block(bufL, bufR, start, end) {
    const n = end - start;
    for (let i = 0; i < n; i++) {
      this.size.next();
      this.decay.next();
      this.damping.next();
    }
    this.size.flush();
    this.decay.flush();
    this.damping.flush();
    const ds = this.size.y - this.usedSize;
    const dd = this.decay.y - this.usedDecay;
    if (ds > SIZE_EPS || ds < -SIZE_EPS || dd > DECAY_EPS || dd < -DECAY_EPS) this.updateCombs();

    this.preDelayInput(bufL, bufR, start, n);
    const wetL = this.wetL;
    const wetR = this.wetR;
    wetL.fill(0, 0, n);
    wetR.fill(0, 0, n);
    const d = DAMP_SCALE * this.damping.y;
    for (let j = 0; j < COMBS; j++) this.comb(j, wetL, n, d);
    for (let j = COMBS; j < 2 * COMBS; j++) this.comb(j, wetR, n, d);
    for (let j = 0; j < ALLPASSES; j++) this.allpass(j, wetL, n);
    for (let j = ALLPASSES; j < 2 * ALLPASSES; j++) this.allpass(j, wetR, n);

    const mix = this.mix;
    for (let i = 0; i < n; i++) {
      const m = mix.next();
      const dryGain = 1 - m;
      const wetGain = WET_SCALE * m;
      bufL[start + i] = bufL[start + i] * dryGain + wetL[i] * wetGain;
      bufR[start + i] = bufR[start + i] * dryGain + wetR[i] * wetGain;
    }
    mix.flush();
  }

  /** Writes the mono input into the pre-delay ring and reads it back, delayed, into `input`. */
  preDelayInput(bufL, bufR, start, n) {
    const buf = this.preBuf;
    const size = this.preSize;
    const pd = this.preDelay;
    const input = this.input;
    let w = this.prePos;
    for (let i = 0; i < n; i++) {
      const x = (bufL[start + i] + bufR[start + i]) * INPUT_GAIN;
      buf[w] = x < DENORMAL_THRESHOLD && x > -DENORMAL_THRESHOLD ? 0 : x;
      let rp = w - pd.next();
      if (rp < 0) rp += size;
      const i0 = rp | 0;
      const frac = rp - i0;
      const i1 = i0 + 1 === size ? 0 : i0 + 1;
      input[i] = buf[i0] + (buf[i1] - buf[i0]) * frac;
      w = w + 1 === size ? 0 : w + 1;
    }
    this.prePos = w;
    pd.flush();
  }

  /** Runs comb `j` over the block input and adds its output to `sum`. */
  comb(j, sum, n, d) {
    const buf = this.combBuf;
    const input = this.input;
    const off = this.combOff[j];
    const cap = this.combCap[j];
    const g = this.combGain[j];
    const d1 = 1 - d;
    let w = this.combPos[j];
    let r = w - this.combLen[j];
    if (r < 0) r += cap;
    let f = this.combStore[j];
    for (let i = 0; i < n; i++) {
      const y = buf[off + r];
      f = y * d1 + f * d;
      const v = input[i] + g * f;
      buf[off + w] = v < DENORMAL_THRESHOLD && v > -DENORMAL_THRESHOLD ? 0 : v;
      sum[i] += y;
      w = w + 1 === cap ? 0 : w + 1;
      r = r + 1 === cap ? 0 : r + 1;
    }
    this.combPos[j] = w;
    this.combStore[j] = flushDenormal(f);
  }

  /** Runs allpass `j` over `buf` in place. */
  allpass(j, io, n) {
    const buf = this.apBuf;
    const off = this.apOff[j];
    const len = this.apLen[j];
    let p = this.apPos[j];
    for (let i = 0; i < n; i++) {
      const x = io[i];
      const b = buf[off + p];
      const v = x + ALLPASS_G * b;
      buf[off + p] = v < DENORMAL_THRESHOLD && v > -DENORMAL_THRESHOLD ? 0 : v;
      io[i] = b - x;
      p = p + 1 === len ? 0 : p + 1;
    }
    this.apPos[j] = p;
  }
}
