/*
 * Feed-forward log-domain compressor (assignment-3-scope.md, Effects;
 * a3-audio-implementation.md, Compressor), stereo-linked, in place:
 *   x = max(|L|, |R|), xdB = 20·log10(max(x, 1e-9))
 *   gc = staticCurveDb(xdB, T, R, W) − xdB, soft knee W = 6 dB
 *   xL = −gc; yL = xL > yL ? αA·yL + (1 − αA)·xL : αR·yL + (1 − αR)·xL
 *   gain = 10^((M − yL)/20), α = exp(−1/(τ·fs)) computed on parameter change.
 * One log10 and one pow per sample (accepted exception to Real-time rule 4).
 */
import { BLOCK } from '../core/constants.js';
import { flushDenormal } from '../core/math.js';
import { clampParam, defineParam } from '../core/params.js';
import { Smoother } from '../core/smoother.js';

/** Soft-knee width, dB (project limit). */
export const KNEE_DB = 6;

/** 20·log10(x) = DB_PER_NEPER·ln(x); 10^(d/20) = exp(d·NEPER_PER_DB). */
const DB_PER_NEPER = 20 / Math.LN10;
const NEPER_PER_DB = Math.LN10 / 20;

/** Detector floor: levels below this read as −180 dB. */
const LEVEL_FLOOR = 1e-9;

export const COMPRESSOR_PARAMS = [
  defineParam({ id: 'threshold', min: -60, max: 0, default: -18, unit: 'dB', scale: 'lin', step: 0.1 }),
  defineParam({ id: 'ratio', min: 1, max: 20, default: 4, unit: ':1', scale: 'log' }),
  defineParam({ id: 'attack', min: 0.1, max: 100, default: 10, unit: 'ms', scale: 'log' }),
  defineParam({ id: 'release', min: 10, max: 1000, default: 120, unit: 'ms', scale: 'log' }),
  defineParam({ id: 'makeup', min: 0, max: 24, default: 0, unit: 'dB', scale: 'lin', step: 0.1 }),
];

const DEF = Object.fromEntries(COMPRESSOR_PARAMS.map((d) => [d.id, d]));

/**
 * Static gain-computer curve: output level, in dB, for input level `xdB` with
 * threshold `threshold` dB, ratio `ratio` and knee width `knee` dB.
 */
export function staticCurveDb(xdB, threshold, ratio, knee = KNEE_DB) {
  const over = 2 * (xdB - threshold);
  if (over < -knee) return xdB;
  if (knee > 0 && over <= knee) {
    const t = xdB - threshold + knee / 2;
    return xdB + ((1 / ratio - 1) * t * t) / (2 * knee);
  }
  return threshold + (xdB - threshold) / ratio;
}

/** Detector coefficient for time constant `ms` at `fs`. */
function detectorCoeff(ms, fs) {
  return Math.exp(-1 / (ms * 0.001 * fs));
}

export class CompressorKernel {
  /** @param {number} fs sample rate, Hz */
  constructor(fs) {
    this.fs = fs;
    this.threshold = new Smoother(fs, DEF.threshold.default);
    this.ratio = new Smoother(fs, DEF.ratio.default);
    this.makeup = new Smoother(fs, DEF.makeup.default);
    this.alphaA = detectorCoeff(DEF.attack.default, fs);
    this.alphaR = detectorCoeff(DEF.release.default, fs);
    this.yL = 0;
    /** Gain reduction at the end of the last block, dB (≥ 0); read by the meter. */
    this.gainReductionDb = 0;
  }

  /** Zeroes the detector; parameters jump to their targets. */
  reset() {
    this.yL = 0;
    this.gainReductionDb = 0;
    this.threshold.snap(this.threshold.target);
    this.ratio.snap(this.ratio.target);
    this.makeup.snap(this.makeup.target);
  }

  /** Sets a parameter by id; the value is clamped through its ParamDef. Unknown ids are ignored. */
  setParam(id, value) {
    const def = DEF[id];
    if (!def) return;
    const v = clampParam(def, value);
    if (id === 'threshold') this.threshold.setTarget(v);
    else if (id === 'ratio') this.ratio.setTarget(v);
    else if (id === 'makeup') this.makeup.setTarget(v);
    else if (id === 'attack') this.alphaA = detectorCoeff(v, this.fs);
    else this.alphaR = detectorCoeff(v, this.fs);
  }

  /** Processes frames [start, end) of both channels in place. */
  process(bufL, bufR, start, end) {
    for (let s = start; s < end; s += BLOCK) this.block(bufL, bufR, s, s + BLOCK < end ? s + BLOCK : end);
  }

  block(bufL, bufR, start, end) {
    const thr = this.threshold;
    const rat = this.ratio;
    const mk = this.makeup;
    const aA = this.alphaA;
    const aR = this.alphaR;
    const bA = 1 - aA;
    const bR = 1 - aR;
    const halfKnee = KNEE_DB / 2;
    const knee2 = 2 * KNEE_DB;
    let yL = this.yL;
    // Settled controls (the usual case) are read once per block.
    const steady = thr.settled() && rat.settled() && mk.settled();
    let T = thr.y;
    let R = rat.y;
    let M = mk.y;
    for (let i = start; i < end; i++) {
      if (!steady) {
        T = thr.next();
        R = rat.next();
        M = mk.next();
      }
      const l = bufL[i];
      const r = bufR[i];
      const al = l < 0 ? -l : l;
      const ar = r < 0 ? -r : r;
      const x = al > ar ? al : ar;
      const xdB = DB_PER_NEPER * Math.log(x > LEVEL_FLOOR ? x : LEVEL_FLOOR);
      const over = xdB - T;
      let xL = 0; // −gc, the gain reduction the static curve asks for
      if (2 * over > KNEE_DB) xL = over - over / R;
      else if (2 * over >= -KNEE_DB) {
        const t = over + halfKnee;
        xL = ((1 - 1 / R) * t * t) / knee2;
      }
      yL = xL > yL ? aA * yL + bA * xL : aR * yL + bR * xL;
      const g = Math.exp((M - yL) * NEPER_PER_DB);
      bufL[i] = l * g;
      bufR[i] = r * g;
    }
    this.yL = flushDenormal(yL);
    this.gainReductionDb = this.yL;
    thr.flush();
    rat.flush();
    mk.flush();
  }
}
