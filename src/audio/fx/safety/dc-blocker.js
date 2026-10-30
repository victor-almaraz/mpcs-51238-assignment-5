/*
 * DC blocker: y = x − x₁ + R·y₁, R = exp(−2π·10/fs), a 10 Hz one-pole high-pass
 * (0.99869 at 48 kHz). Stereo; state flushes at block end.
 */
import { flushDenormal } from '../core/math.js';

/** Corner frequency, Hz (project limit). */
export const DC_CORNER_HZ = 10;

export class DcBlocker {
  /** @param {number} fs sample rate, Hz */
  constructor(fs) {
    this.R = Math.exp((-2 * Math.PI * DC_CORNER_HZ) / fs);
    this.reset();
  }

  reset() {
    this.xl = 0;
    this.yl = 0;
    this.xr = 0;
    this.yr = 0;
  }

  /** Processes frames [start, end) of both channels in place. */
  process(bufL, bufR, start, end) {
    const R = this.R;
    let xl = this.xl;
    let yl = this.yl;
    let xr = this.xr;
    let yr = this.yr;
    for (let i = start; i < end; i++) {
      const l = bufL[i];
      const r = bufR[i];
      yl = l - xl + R * yl;
      yr = r - xr + R * yr;
      xl = l;
      xr = r;
      bufL[i] = yl;
      bufR[i] = yr;
    }
    this.xl = xl;
    this.xr = xr;
    this.yl = flushDenormal(yl);
    this.yr = flushDenormal(yr);
  }
}
