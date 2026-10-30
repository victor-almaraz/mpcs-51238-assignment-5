// Safety limiter (audio-safety.md): non-finite guard → DC blocker → sustained-level duck
// → look-ahead limiter → hard clip. Plain JS AudioWorklet. All buffers are allocated in
// the constructor; process() does not allocate.
const MAX_ABS = 1e4;

class SafetyLimiter extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    const fs = sampleRate;
    this.ceil = Math.pow(10, (o.ceilingDb ?? -1) / 20);
    this.L = Math.max(1, Math.round((o.lookaheadMs ?? 1.5) * 1e-3 * fs));
    this.aRel = 1 - Math.exp(-1 / ((o.releaseMs ?? 100) * 1e-3 * fs));
    this.R = 1 - (2 * Math.PI * (o.dcHz ?? 10)) / fs;
    this.fadeLen = Math.round(0.05 * fs);
    this.holdLen = Math.round(0.25 * fs);
    this.msCoef = 1 - Math.exp(-1 / (3 * fs));
    this.duckThresh = Math.pow(10, -12 / 10);   // mean-square at −12 dBFS
    this.duckTarget = Math.pow(10, -6 / 20);
    this.duckStep = (1 - this.duckTarget) / fs; // ≈ 1 s ramp

    const n = this.L + 1;
    this.dL = new Float32Array(n);
    this.dR = new Float32Array(n);
    this.req = new Float32Array(n);
    this.box = new Float32Array(this.L);
    this.faultSent = false;
    this.reset();
    this.ducking = false; this.duck = 1; this.ms = 0;
    this.port.onmessage = (e) => { if (e.data && e.data.type === 'ack') this.ducking = false; };
  }

  reset() {
    this.dL.fill(0); this.dR.fill(0); this.req.fill(1); this.box.fill(1);
    this.w = 0; this.bw = 0; this.boxSum = this.L; this.h = 1;
    this.xl1 = 0; this.yl1 = 0; this.xr1 = 0; this.yr1 = 0;
    this.fade = 0; this.hold = 0;
    // faultSent is not cleared here: one fault posts once, until the hold and fade-in finish.
  }

  fault() {
    this.reset();
    this.hold = this.holdLen;
    if (!this.faultSent) { this.port.postMessage({ type: 'fault' }); this.faultSent = true; }
  }

  process(inputs, outputs) {
    const out = outputs[0];
    const oL = out[0], oR = out.length > 1 ? out[1] : out[0];
    const inp = inputs[0];
    const n = oL.length;
    // With no active input, silence still runs through the loop so the delay line, DC
    // blocker and RMS estimate keep advancing (no stale samples replayed later).
    const iL = inp && inp.length > 0 ? inp[0] : null;
    const iR = inp && inp.length > 1 ? inp[1] : iL;
    const c = this.ceil, L = this.L, N = L + 1;

    for (let i = 0; i < n; i++) {
      const xl = iL !== null ? iL[i] : 0, xr = iR !== null ? iR[i] : 0;
      if (!(Math.abs(xl) <= MAX_ABS) || !(Math.abs(xr) <= MAX_ABS)) {
        this.fault();
        for (let k = i; k < n; k++) { oL[k] = 0; oR[k] = 0; }
        return true;
      }
      if (this.hold > 0) { this.hold--; oL[i] = 0; oR[i] = 0; continue; }

      // DC blocker
      let yl = xl - this.xl1 + this.R * this.yl1; this.xl1 = xl;
      let yr = xr - this.xr1 + this.R * this.yr1; this.xr1 = xr;
      if (Math.abs(yl) < 1e-20) yl = 0;
      if (Math.abs(yr) < 1e-20) yr = 0;
      this.yl1 = yl; this.yr1 = yr;

      // Sustained-level duck
      this.ms += this.msCoef * (0.5 * (yl * yl + yr * yr) - this.ms);
      if (this.ms < 1e-20) this.ms = 0;
      if (this.ms > this.duckThresh && !this.ducking) {
        this.ducking = true;
        this.port.postMessage({ type: 'duck' });
      }
      const dt = this.ducking ? this.duckTarget : 1;
      this.duck += Math.max(-this.duckStep, Math.min(this.duckStep, dt - this.duck));
      yl *= this.duck; yr *= this.duck;

      // Look-ahead limiter
      const pk = Math.max(Math.abs(yl), Math.abs(yr));
      const w = this.w;
      this.req[w] = pk > c ? c / pk : 1;
      const outL = this.dL[(w + 1) % N], outR = this.dR[(w + 1) % N]; // x[n−L]
      this.dL[w] = yl; this.dR[w] = yr;
      let m = 1;
      for (let k = 0; k < N; k++) if (this.req[k] < m) m = this.req[k];
      this.h = Math.min(m, this.h + (1 - this.h) * this.aRel);
      this.boxSum += this.h - this.box[this.bw];
      this.box[this.bw] = this.h;
      this.bw = (this.bw + 1) % L;
      this.w = (w + 1) % N;
      const g = this.boxSum / L;

      // Fade-in and hard clip
      let f = 1;
      if (this.fade < this.fadeLen) {
        f = this.fade / this.fadeLen;
        if (++this.fade === this.fadeLen) this.faultSent = false;   // recovered
      }
      const sl = outL * g * f, sr = outR * g * f;
      oL[i] = sl > c ? c : sl < -c ? -c : sl;
      if (oR !== oL) oR[i] = sr > c ? c : sr < -c ? -c : sr;
    }
    return true;
  }
}

registerProcessor('safety-limiter', SafetyLimiter);
