/**
 * Flash guard (doc/visuals.md, Visual safety). Consumes a 64×48 RGBA
 * readback each frame (the renderer runs one guard on its output and one on
 * the scene before the limit), counts general and red flash transitions per
 * cell over the last second, and decides when the renderer must limit
 * change. Pure: no WebGL or DOM.
 */
import { srgbToLinear, WHITE_UV } from './color.js';

export const GRID_W = 64;
export const GRID_H = 48;
export const LUMA_STEP = 0.1;
export const DARK_LIMIT = 0.8;
export const RED_RATIO = 0.8;
export const UV_STEP = 0.2;
/** Share of the 10° field that may flash concurrently. */
export const AREA_SHARE = 0.25;
/** Largest flash limit; settings can only lower it. */
export const MAX_FLASHES_PER_SECOND = 3;
/** Change of linear RGB per second allowed while the guard intervenes. */
export const LIMIT_RATE_PER_SEC = 0.5;
/** Longest frame interval the limit allows for. */
export const MAX_LIMIT_DT_SEC = 1 / 30;
/** Limited time after an intervention ends: enough for any pixel to reach the scene. */
export const LIMIT_TAIL_SEC = 1 / LIMIT_RATE_PER_SEC;
const WINDOW_MS = 1000;
const CAP = 128; // transitions remembered per cell; far above any 1 s count that matters

const SRGB_LUT = new Float32Array(256).map((_, i) => srgbToLinear(i / 255));

/**
 * Largest per-pixel change of linear RGB in one frame while limiting.
 * @param {number} dtSec
 */
export function limitStep(dtSec) {
  const dt = Number.isFinite(dtSec) && dtSec > 0 ? Math.min(dtSec, MAX_LIMIT_DT_SEC) : MAX_LIMIT_DT_SEC;
  return LIMIT_RATE_PER_SEC * dt;
}

/**
 * Transition count per cell at which the cell flashes too often. Limits
 * outside 0–3 are clamped into it, so the result is never looser than 3.
 * @param {number} maxFlashesPerSecond
 * @throws {RangeError} when the limit is not a finite number
 */
export function transitionThreshold(maxFlashesPerSecond) {
  if (typeof maxFlashesPerSecond !== 'number' || !Number.isFinite(maxFlashesPerSecond)) {
    throw new RangeError(`maxFlashesPerSecond must be a finite number, got ${String(maxFlashesPerSecond)}`);
  }
  const n = Math.min(MAX_FLASHES_PER_SECOND, Math.max(0, maxFlashesPerSecond));
  return Math.max(1, Math.floor(2 * n));
}

/**
 * Keeps the change limit on for LIMIT_TAIL_SEC of limited frame time after
 * every guard has released, so held values return gradually.
 */
export function createLimitTail() {
  let tail = 0;
  return {
    /** Whether the limit applies to the coming frame. @param {boolean} limiting */
    active(limiting) { return limiting || tail > 0; },
    /**
     * After a frame drawn with `wasLimiting`, given the guards' new state.
     * @param {boolean} wasLimiting @param {boolean} limiting @param {number} dtSec
     */
    after(wasLimiting, limiting, dtSec) {
      if (limiting) tail = 0;
      else if (wasLimiting) tail = LIMIT_TAIL_SEC;
      else if (tail > 0) tail = Math.max(0, tail - (Number.isFinite(dtSec) && dtSec > 0 ? Math.min(dtSec, MAX_LIMIT_DT_SEC) : MAX_LIMIT_DT_SEC));
    },
  };
}

/** Per-cell ring of transition times. */
class TransitionLog {
  /** @param {number} cells */
  constructor(cells) {
    this.times = new Float64Array(cells * CAP);
    this.head = new Uint16Array(cells);
    this.count = new Uint16Array(cells);
  }
  /** @param {number} c @param {number} t */
  add(c, t) {
    this.times[c * CAP + this.head[c]] = t;
    this.head[c] = (this.head[c] + 1) % CAP;
    if (this.count[c] < CAP) this.count[c]++;
  }
  /** Drops entries older than the window and returns the remaining count. @param {number} c @param {number} t */
  recent(c, t) {
    let n = this.count[c];
    while (n > 0) {
      const tail = (this.head[c] - n + CAP) % CAP;
      if (t - this.times[c * CAP + tail] <= WINDOW_MS) break;
      n--;
    }
    this.count[c] = n;
    return n;
  }
}

/**
 * @param {{
 *   width?: number, height?: number,
 *   maxFlashesPerSecond?: number,
 *   encoding?: 'srgb' | 'linear',
 *   measured?: 'output' | 'scene',
 *   trace?: (record: any) => void,
 *   clock?: () => number,
 * }} [options]
 */
export function createFlashGuard({ width = GRID_W, height = GRID_H, maxFlashesPerSecond = MAX_FLASHES_PER_SECOND, encoding = 'srgb', measured = 'output', trace = () => {}, clock = Date.now } = {}) {
  const cells = width * height;
  const winW = Math.max(1, Math.min(width, Math.round((width * 341) / 1024)));
  const winH = Math.max(1, Math.min(height, Math.round((height * 256) / 768)));
  const areaCells = Math.max(1, Math.ceil(AREA_SHARE * winW * winH));
  const releaseCells = Math.floor(areaCells / 2);
  let threshold = transitionThreshold(maxFlashesPerSecond);

  const ext = new Float32Array(cells);
  const dir = new Int8Array(cells);
  const refU = new Float32Array(cells);
  const refV = new Float32Array(cells);
  const refRed = new Uint8Array(cells);
  let primed = false;
  const general = new TransitionLog(cells);
  const red = new TransitionLog(cells);
  const overG = new Uint8Array(cells);
  const overR = new Uint8Array(cells);
  const warmG = new Uint8Array(cells);
  const warmR = new Uint8Array(cells);
  const sat = new Int32Array((width + 1) * (height + 1));
  let limiting = false;
  let interventions = 0;

  /** @param {ArrayLike<number>} px @param {number} i */
  function linear(px, i) {
    if (px instanceof Float32Array || px instanceof Float64Array) {
      const v = px[i];
      return encoding === 'srgb' ? srgbToLinear(v) : v;
    }
    return encoding === 'srgb' ? SRGB_LUT[px[i]] : px[i] / 255;
  }

  /** Largest window sum of a 0/1 grid. @param {Uint8Array} grid */
  function maxWindow(grid) {
    const W = width + 1;
    for (let y = 0; y < height; y++) {
      let row = 0;
      for (let x = 0; x < width; x++) {
        row += grid[y * width + x];
        sat[(y + 1) * W + x + 1] = sat[y * W + x + 1] + row;
      }
    }
    let best = 0, bx = 0, by = 0;
    for (let y = 0; y + winH <= height; y++) {
      for (let x = 0; x + winW <= width; x++) {
        const s = sat[(y + winH) * W + x + winW] - sat[y * W + x + winW] - sat[(y + winH) * W + x] + sat[y * W + x];
        if (s > best) { best = s; bx = x; by = y; }
      }
    }
    return { cells: best, window: [bx, by] };
  }

  function emit(event, level, data) {
    trace({
      t: new Date(clock()).toISOString(),
      traceId: `safety-flash-${measured}-${interventions}`,
      stage: 'SAFETY', component: 'flash-guard', event, level, data,
    });
  }

  return {
    get limiting() { return limiting; },
    get threshold() { return threshold; },
    window: { width: winW, height: winH, areaCells },

    /** @param {number} n flashes per second, clamped to 0–3 @throws {RangeError} when not finite */
    setMaxFlashes(n) { threshold = transitionThreshold(n); },

    /**
     * Processes one frame.
     * @param {ArrayLike<number>} pixels RGBA, `width × height` cells
     * @param {number} tMs frame time
     * @returns {{ limiting: boolean, event: 'engaged' | 'released' | null, general: number, red: number }}
     */
    frame(pixels, tMs) {
      if (pixels.length < cells * 4) throw new Error(`flash guard expects ${cells * 4} values, got ${pixels.length}`);
      for (let c = 0; c < cells; c++) {
        const i = c * 4;
        const r = linear(pixels, i), g = linear(pixels, i + 1), b = linear(pixels, i + 2);
        // Relative luminance and CIE 1976 u′v′ (color.js luminance, chromaticityUV), inlined.
        const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        const X = 0.4124 * r + 0.3576 * g + 0.1805 * b;
        const Z = 0.0193 * r + 0.1192 * g + 0.9505 * b;
        const den = X + 15 * L + 3 * Z;
        const u = den < 1e-6 ? WHITE_UV[0] : (4 * X) / den;
        const v = den < 1e-6 ? WHITE_UV[1] : (9 * L) / den;
        const sum = r + g + b;
        const isRed = sum > 1e-6 && r / sum >= RED_RATIO;
        if (!primed) {
          ext[c] = L; dir[c] = 0; refU[c] = u; refV[c] = v; refRed[c] = isRed ? 1 : 0;
          continue;
        }
        // General flash transitions: a reversal of at least LUMA_STEP from the last extreme.
        const e = ext[c], d = dir[c], delta = L - e;
        if ((d === 1 && delta > 0) || (d === -1 && delta < 0)) {
          ext[c] = L; // the current swing continues
        } else if (Math.abs(delta) >= LUMA_STEP && Math.min(L, e) < DARK_LIMIT) {
          general.add(c, tMs);
          dir[c] = delta > 0 ? 1 : -1;
          ext[c] = L;
        }
        // Red flash transitions.
        const du = u - refU[c], dv = v - refV[c];
        const far = Math.hypot(du, dv) > UV_STEP;
        if ((isRed || refRed[c]) && far) {
          red.add(c, tMs);
          refU[c] = u; refV[c] = v; refRed[c] = isRed ? 1 : 0;
        } else if (!isRed && !refRed[c]) {
          refU[c] = u; refV[c] = v;
        }
      }
      primed = true;
      const half = Math.max(1, Math.floor(threshold / 2));
      for (let c = 0; c < cells; c++) {
        const ng = general.recent(c, tMs), nr = red.recent(c, tMs);
        overG[c] = ng >= threshold ? 1 : 0;
        overR[c] = nr >= threshold ? 1 : 0;
        warmG[c] = ng >= half ? 1 : 0;
        warmR[c] = nr >= half ? 1 : 0;
      }
      const g = maxWindow(overG);
      const rw = maxWindow(overR);
      /** @type {'engaged' | 'released' | null} */
      let event = null;
      if (!limiting && (g.cells >= areaCells || rw.cells >= areaCells)) {
        limiting = true;
        event = 'engaged';
        interventions++;
        const kind = g.cells >= areaCells ? 'general' : 'red';
        const w = kind === 'general' ? g : rw;
        emit('flashLimit', 'warn', { measured, kind, cells: w.cells, window: w.window });
      } else if (limiting && maxWindow(warmG).cells <= releaseCells && maxWindow(warmR).cells <= releaseCells) {
        limiting = false;
        event = 'released';
        emit('flashLimitEnd', 'info', { measured });
      }
      return { limiting, event, general: g.cells, red: rw.cells };
    },
  };
}
