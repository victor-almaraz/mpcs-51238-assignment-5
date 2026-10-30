// Analysis taps for audio-reactive visuals (audio-engine-core.md, Analysis taps). One AnalyserNode
// per instrument at most, created on the first read and connected from the instrument's output.
// The analyser is a sink (no outputs), so the signal path and the safety stage are unchanged.
// Reads are cached for READ_INTERVAL_S of context time.

export const READ_INTERVAL_S = 0.016;
export const TAP_FFT_SIZE = 1024;
export const LEVEL_FLOOR_DB = -60;
export const SPECTRUM_LO_HZ = 40;
export const SPECTRUM_HI_HZ = 16000;
export const BANDS_MIN = 4;
export const BANDS_MAX = 32;

/** RMS of `buf` mapped to 0–1 over LEVEL_FLOOR_DB…0 dBFS. */
export function levelOf(buf) {
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
  const rms = Math.sqrt(s / Math.max(1, buf.length));
  if (!(rms > 0)) return 0;
  const x = (20 * Math.log10(rms) - LEVEL_FLOOR_DB) / -LEVEL_FLOOR_DB;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * Mean byte magnitude / 255 over `bands` log-spaced bands between SPECTRUM_LO_HZ and
 * min(SPECTRUM_HI_HZ, fs/2). `bins` is getByteFrequencyData output for an FFT of 2·bins.length.
 */
export function bandsOf(bins, bands, fs) {
  const n = Math.min(BANDS_MAX, Math.max(BANDS_MIN, Math.round(Number.isFinite(bands) ? bands : BANDS_MIN)));
  const hzPerBin = fs / (2 * bins.length);
  const lo = SPECTRUM_LO_HZ;
  const hi = Math.min(SPECTRUM_HI_HZ, fs / 2);
  const out = new Array(n);
  for (let b = 0; b < n; b++) {
    const f0 = lo * Math.pow(hi / lo, b / n);
    const f1 = lo * Math.pow(hi / lo, (b + 1) / n);
    let i0 = Math.floor(f0 / hzPerBin);
    let i1 = Math.ceil(f1 / hzPerBin);
    if (i1 <= i0) i1 = i0 + 1;
    i0 = Math.min(i0, bins.length - 1);
    i1 = Math.min(Math.max(i1, i0 + 1), bins.length);
    let s = 0;
    for (let i = i0; i < i1; i++) s += bins[i];
    out[b] = s / (i1 - i0) / 255;
  }
  return out;
}

export class AnalysisTaps {
  constructor(engine) {
    this.engine = engine;
    this.ctx = engine.ctx;
    /** @type {Map<string, any>} id → tap */
    this.taps = new Map();
  }

  tap(id) {
    const e = this.engine.entries.get(id);
    if (!e || !e.inst) return null;
    let t = this.taps.get(id);
    if (!t) {
      const analyser = new AnalyserNode(this.ctx, { fftSize: TAP_FFT_SIZE, smoothingTimeConstant: 0.5 });
      t = {
        analyser, inst: null,
        time: new Float32Array(TAP_FFT_SIZE), freq: new Uint8Array(TAP_FFT_SIZE / 2),
        levelAt: -Infinity, level: 0, specAt: -Infinity, specBands: 0, spectrum: [],
      };
      this.taps.set(id, t);
    }
    if (t.inst !== e.inst) this.attach(id, e.inst);
    return t;
  }

  /** Connects instrument `inst` to the tap of `id`, if one exists (called by Engine.attach). */
  attach(id, inst) {
    const t = this.taps.get(id);
    if (!t || !inst) return;
    inst.output.connect(t.analyser);
    t.inst = inst;
  }

  level(id) {
    const t = this.tap(id);
    if (!t) return null;
    const now = this.ctx.currentTime;
    if (Math.abs(now - t.levelAt) >= READ_INTERVAL_S) {
      t.analyser.getFloatTimeDomainData(t.time);
      t.level = levelOf(t.time);
      t.levelAt = now;
    }
    return t.level;
  }

  spectrum(id, bands) {
    const t = this.tap(id);
    if (!t) return null;
    const now = this.ctx.currentTime;
    const n = Math.min(BANDS_MAX, Math.max(BANDS_MIN, Math.round(Number.isFinite(bands) ? bands : BANDS_MIN)));
    if (Math.abs(now - t.specAt) >= READ_INTERVAL_S || t.specBands !== n) {
      t.analyser.getByteFrequencyData(t.freq);
      t.spectrum = bandsOf(t.freq, n, this.ctx.sampleRate);
      t.specAt = now;
      t.specBands = n;
    }
    return t.spectrum.slice();
  }

  remove(id) {
    const t = this.taps.get(id);
    if (!t) return;
    if (t.inst) {
      try { t.inst.output.disconnect(t.analyser); } catch { /* already disconnected */ }
    }
    this.taps.delete(id);
  }

  dispose() {
    for (const id of [...this.taps.keys()]) this.remove(id);
  }
}
