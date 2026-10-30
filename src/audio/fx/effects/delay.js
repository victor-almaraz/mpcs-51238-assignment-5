/*
 * Delay (assignment-3-scope.md, Effects; a3-audio-implementation.md, Delay):
 * stereo feedback delay, in place.
 *   Ring of ceil(2·fs) + 4 frames per channel, allocated at construction.
 *   Delay time 1–2000 ms, or synced: beats·60/bpm, capped at 2000 ms;
 *   smoothed in frames with τ 50 ms (project limit).
 *   read = ring[w − d] by linear interpolation at the fractional delay d
 *   wet = lp += a·(read − lp), a one-pole high-cut (gain ≤ 1), coefficient per block
 *   ring[w] = x + fb·wet, fb ≤ 0.9, so the loop gain stays below 1
 *   out = x·(1 − mix) + wet·mix
 * Values written to the ring below the denormal threshold are stored as 0.
 */
import { BLOCK, DENORMAL_THRESHOLD } from '../core/constants.js';
import { flushDenormal } from '../core/math.js';
import { clampParam, defineParam } from '../core/params.js';
import { Smoother } from '../core/smoother.js';

/** Longest delay, ms (project limit). */
export const DELAY_MAX_MS = 2000;
const DELAY_MIN_MS = 1;

/** Delay-time smoothing time constant, s (project limit). */
export const DELAY_TIME_TAU_S = 0.05;

/** Note values for tempo sync, as fractions of a whole note. */
const SYNC_NOTES = [
  ['1/32', 1 / 32],
  ['1/16', 1 / 16],
  ['1/8', 1 / 8],
  ['1/4', 1 / 4],
  ['1/2', 1 / 2],
  ['1/1', 1],
];

/** Sync option names: 'off', then per note value the straight, dotted ('d') and triplet ('t') variants. */
export const DELAY_SYNC = ['off'];

/** Length of each sync option in beats (quarter notes); 0 for 'off'. */
export const DELAY_SYNC_BEATS = new Float64Array(1 + 3 * SYNC_NOTES.length);

for (let i = 0; i < SYNC_NOTES.length; i++) {
  const [name, whole] = SYNC_NOTES[i];
  const beats = 4 * whole;
  DELAY_SYNC.push(name, `${name}d`, `${name}t`);
  DELAY_SYNC_BEATS[1 + 3 * i] = beats;
  DELAY_SYNC_BEATS[2 + 3 * i] = beats * 1.5;
  DELAY_SYNC_BEATS[3 + 3 * i] = (beats * 2) / 3;
}
Object.freeze(DELAY_SYNC);

export const DELAY_PARAMS = [
  defineParam({ id: 'time', min: DELAY_MIN_MS, max: DELAY_MAX_MS, default: 375, unit: 'ms', scale: 'log' }),
  defineParam({ id: 'sync', scale: 'enum', options: DELAY_SYNC, default: 0 }),
  defineParam({ id: 'feedback', min: 0, max: 0.9, default: 0.35, unit: 'fraction', scale: 'lin', step: 0.01 }),
  defineParam({ id: 'highCut', min: 1000, max: 20000, default: 8000, unit: 'Hz', scale: 'log' }),
  defineParam({ id: 'mix', min: 0, max: 1, default: 0.3, unit: 'fraction', scale: 'lin', step: 0.01 }),
];

const DEF = Object.fromEntries(DELAY_PARAMS.map((d) => [d.id, d]));

const DEFAULT_BPM = 120;

/** One-pole lowpass coefficient for corner `fc` at `fs`. */
function onePoleCoeff(fc, fs) {
  const f = fc > 0.45 * fs ? 0.45 * fs : fc;
  return 1 - Math.exp((-2 * Math.PI * f) / fs);
}

export class DelayKernel {
  /** @param {number} fs sample rate, Hz */
  constructor(fs) {
    this.fs = fs;
    this.size = Math.ceil(2 * fs) + 4;
    this.ringL = new Float32Array(this.size);
    this.ringR = new Float32Array(this.size);
    this.w = 0;
    this.lpL = 0;
    this.lpR = 0;
    this.timeMs = DEF.time.default;
    this.sync = DEF.sync.default;
    this.bpm = DEFAULT_BPM;
    this.delay = new Smoother(fs, this.delayFrames(), DELAY_TIME_TAU_S); // frames
    this.feedback = new Smoother(fs, DEF.feedback.default);
    this.highCut = new Smoother(fs, DEF.highCut.default);
    this.mix = new Smoother(fs, DEF.mix.default);
  }

  /** Zeroes the ring and filters; parameters jump to their targets. */
  reset() {
    this.ringL.fill(0);
    this.ringR.fill(0);
    this.w = 0;
    this.lpL = 0;
    this.lpR = 0;
    this.delay.snap(this.delay.target);
    this.feedback.snap(this.feedback.target);
    this.highCut.snap(this.highCut.target);
    this.mix.snap(this.mix.target);
  }

  /** Sets a parameter by id; the value is clamped through its ParamDef. Unknown ids are ignored. */
  setParam(id, value) {
    const def = DEF[id];
    if (!def) return;
    const v = clampParam(def, value);
    if (id === 'time' || id === 'sync') {
      if (id === 'time') this.timeMs = v;
      else this.sync = v;
      this.delay.setTarget(this.delayFrames());
    } else if (id === 'feedback') this.feedback.setTarget(v);
    else if (id === 'highCut') this.highCut.setTarget(v);
    else this.mix.setTarget(v);
  }

  /** Sets the tempo used by synced delay times; non-positive or non-finite values are ignored. */
  setTempo(bpm) {
    if (!(bpm > 0) || bpm === Infinity) return;
    this.bpm = bpm;
    this.delay.setTarget(this.delayFrames());
  }

  /** Current delay target in frames, from the free time or the synced note value. */
  delayFrames() {
    let ms = this.timeMs;
    if (this.sync > 0) ms = (DELAY_SYNC_BEATS[this.sync] * 60000) / this.bpm;
    if (ms > DELAY_MAX_MS) ms = DELAY_MAX_MS;
    if (ms < DELAY_MIN_MS) ms = DELAY_MIN_MS;
    return (ms * this.fs) / 1000;
  }

  /** Processes frames [start, end) of both channels in place. */
  process(bufL, bufR, start, end) {
    for (let s = start; s < end; s += BLOCK) this.block(bufL, bufR, s, s + BLOCK < end ? s + BLOCK : end);
  }

  block(bufL, bufR, start, end) {
    const n = end - start;
    const hc = this.highCut;
    for (let i = 0; i < n; i++) hc.next();
    hc.flush();
    const a = onePoleCoeff(hc.y, this.fs);
    const ringL = this.ringL;
    const ringR = this.ringR;
    const size = this.size;
    const delay = this.delay;
    const feedback = this.feedback;
    const mix = this.mix;
    let w = this.w;
    let lpL = this.lpL;
    let lpR = this.lpR;
    for (let i = start; i < end; i++) {
      const d = delay.next();
      const fb = feedback.next();
      const m = mix.next();
      let rp = w - d;
      if (rp < 0) rp += size;
      const i0 = rp | 0;
      const frac = rp - i0;
      const i1 = i0 + 1 === size ? 0 : i0 + 1;

      const l0 = ringL[i0];
      lpL += a * (l0 + (ringL[i1] - l0) * frac - lpL);
      const xl = bufL[i];
      const wl = xl + fb * lpL;
      ringL[w] = wl < DENORMAL_THRESHOLD && wl > -DENORMAL_THRESHOLD ? 0 : wl;
      bufL[i] = xl + (lpL - xl) * m;

      const r0 = ringR[i0];
      lpR += a * (r0 + (ringR[i1] - r0) * frac - lpR);
      const xr = bufR[i];
      const wr = xr + fb * lpR;
      ringR[w] = wr < DENORMAL_THRESHOLD && wr > -DENORMAL_THRESHOLD ? 0 : wr;
      bufR[i] = xr + (lpR - xr) * m;

      w = w + 1 === size ? 0 : w + 1;
    }
    this.w = w;
    this.lpL = flushDenormal(lpL);
    this.lpR = flushDenormal(lpR);
    delay.flush();
    feedback.flush();
    mix.flush();
  }
}
