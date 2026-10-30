import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BLOCK } from '../../src/audio/fx/core/constants.js';
import { fromNorm } from '../../src/audio/fx/core/params.js';
import { Mulberry32 } from '../../src/audio/fx/core/prng.js';
import { settleSmoothers } from '../../src/audio/fx/core/smoother.js';
import { biquadMagnitudeDb, peakCoefficients } from '../../src/audio/fx/effects/biquad.js';
import { EffectSlot, processChain } from '../../src/audio/fx/effects/chain.js';
import { KNEE_DB, staticCurveDb } from '../../src/audio/fx/effects/compressor.js';
import { DELAY_SYNC, DelayKernel } from '../../src/audio/fx/effects/delay.js';
import { Eq3Kernel } from '../../src/audio/fx/effects/eq3.js';
import { FILTER_MODES, FilterKernel } from '../../src/audio/fx/effects/filter.js';
import { EFFECTS, effectFor } from '../../src/audio/fx/effects/registry.js';
import { MAX_REVERBS } from '../../src/audio/fx/effects/reverb.js';
import { peak, toneMagnitude } from './support/signal.js';

const FS = 48000;
const db = (x) => 20 * Math.log10(x);

/** Measured margins, reported by the last test. */
const results = { peaks: {} };

/** Builds a kernel of `type` with `params` applied and its smoothers settled. */
function kernel(type, params = {}, fs = FS) {
  const k = new EFFECTS[type].Kernel(fs);
  for (const [id, v] of Object.entries(params)) k.setParam(id, v);
  settleSmoothers(k);
  if (k.reset) k.reset();
  return k;
}

/** Seeded white noise in [−amp, amp). */
function noise(frames, seed, amp = 1) {
  const rng = new Mulberry32(seed);
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) out[i] = amp * rng.nextBipolar();
  return out;
}

function sine(frames, freq, amp = 1, fs = FS) {
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / fs);
  return out;
}

/** Processes copies of (l, r) through `fx` in BLOCK chunks; `onBlock(offset)` runs before each chunk. */
function run(fx, l, r = l, onBlock) {
  const L = Float32Array.from(l);
  const R = Float32Array.from(r);
  for (let off = 0; off < L.length; off += BLOCK) {
    if (onBlock) onBlock(off);
    fx.process(L, R, off, Math.min(off + BLOCK, L.length));
  }
  return [L, R];
}

function allFinite(buf) {
  for (let i = 0; i < buf.length; i++) if (!Number.isFinite(buf[i])) return false;
  return true;
}

/** Output peak bound for full-scale noise input, per effect (largest legal gain plus margin). */
const BOUND = { eq3: 64, filter: 64, compressor: 16, saturation: 2.01, distortion: 2.01, delay: 11, reverb: 16 };

test('registry: seven effects with labels; effectFor', () => {
  assert.deepEqual(Object.keys(EFFECTS), ['eq3', 'filter', 'compressor', 'saturation', 'distortion', 'delay', 'reverb']);
  assert.deepEqual(Object.values(EFFECTS).map((e) => e.label), ['EQ', 'Filter', 'Compressor', 'Saturation', 'Distortion', 'Delay', 'Reverb']);
  assert.equal(effectFor('delay'), EFFECTS.delay);
  assert.equal(effectFor('toString'), undefined);
  assert.equal(effectFor('nope'), undefined);
  assert.equal(MAX_REVERBS, 4);
  assert.equal(DELAY_SYNC.length, 19);
  assert.deepEqual(FILTER_MODES, ['lowpass', 'highpass', 'bandpass']);
});

test('setParam clamps through ParamDef and ignores unknown ids', () => {
  const f = new FilterKernel(FS);
  f.setParam('resonance', 100);
  assert.equal(f.resonance.target, 12);
  f.setParam('cutoff', Number.NaN);
  assert.equal(f.cutoff.target, 2000);
  f.setParam('bogus', 1);
  const d = new DelayKernel(FS);
  d.setParam('feedback', 5);
  assert.equal(d.feedback.target, 0.9);
});

test('bounded output: parameter sweeps and extreme settings with white noise, every effect', () => {
  const frames = Math.round(0.25 * FS);
  for (const [type, { params, Kernel }] of Object.entries(EFFECTS)) {
    const input = noise(frames, 7);
    let worst = 0;
    const check = (out, label) => {
      for (const ch of out) {
        assert.ok(allFinite(ch), `${type} ${label}: non-finite output`);
        worst = Math.max(worst, peak(ch));
      }
      assert.ok(worst < BOUND[type], `${type} ${label}: peak ${worst}`);
    };
    // Each parameter swept min → max across the render, others at defaults.
    for (const def of params) {
      const k = new Kernel(FS);
      const blocks = Math.ceil(frames / BLOCK);
      check(run(k, input, input, (off) => k.setParam(def.id, fromNorm(def, off / BLOCK / (blocks - 1)))), `sweep ${def.id}`);
      const back = new Kernel(FS);
      check(run(back, input, input, (off) => back.setParam(def.id, fromNorm(def, 1 - off / BLOCK / (blocks - 1)))), `sweep ${def.id} down`);
    }
    // All-minimum, all-maximum and seeded random settings, switched abruptly on one kernel.
    const k = new Kernel(FS);
    const rng = new Mulberry32(99);
    for (let trial = 0; trial < 18; trial++) {
      for (const def of params) k.setParam(def.id, fromNorm(def, trial === 0 ? 0 : trial === 1 ? 1 : rng.next()));
      check(run(k, noise(frames, 100 + trial), noise(frames, 200 + trial)), `trial ${trial}`);
    }
    results.peaks[type] = worst;
  }
});

test('delay: loop gain stays below 1 at maximum feedback and high-cut (impulse decays)', () => {
  const period = 480; // 10 ms
  const k = kernel('delay', { time: 10, feedback: 0.9, highCut: 20000, mix: 1 });
  const frames = 3 * FS;
  const imp = new Float32Array(frames);
  imp[0] = 1;
  const [L] = run(k, imp);
  const energies = [];
  for (let e = 1; e * period + period <= frames; e++) {
    let s = 0;
    for (let i = e * period - period / 2; i < e * period + period / 2; i++) s += L[i] * L[i];
    energies.push(s);
  }
  let worstRatio = 0;
  for (let e = 1; e < 200; e++) worstRatio = Math.max(worstRatio, Math.sqrt(energies[e] / energies[e - 1]));
  assert.ok(worstRatio < 0.9 + 1e-6, `echo amplitude ratio ${worstRatio}`);
  assert.ok(peak(L, frames - FS) < 1e-6, `tail after 2 s: ${peak(L, frames - FS)}`);
  results.loopGain = worstRatio;
});

test('delay: tempo sync places the first echo at beats·60/bpm', () => {
  const k = kernel('delay', { sync: DELAY_SYNC.indexOf('1/4'), feedback: 0, highCut: 20000, mix: 1 });
  k.setTempo(120);
  settleSmoothers(k);
  const imp = new Float32Array(FS);
  imp[0] = 1;
  const [L] = run(k, imp);
  let at = 0;
  for (let i = 1; i < L.length; i++) if (Math.abs(L[i]) > Math.abs(L[at])) at = i;
  assert.ok(Math.abs(at - 24000) <= 2, `echo at frame ${at}`);
  // Synced times cap at 2000 ms: 1/1 dotted at 60 bpm is 6 s.
  k.setParam('sync', DELAY_SYNC.indexOf('1/1d'));
  k.setTempo(60);
  assert.equal(k.delay.target, 2 * FS);
});

/** T60 from the Schroeder energy decay curve, by a linear fit between −5 and −35 dB. */
function measureT60(L, R, fs) {
  const n = L.length;
  const edc = new Float64Array(n);
  let acc = 0;
  for (let i = n - 1; i >= 0; i--) {
    acc += L[i] * L[i] + R[i] * R[i];
    edc[i] = acc;
  }
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  let m = 0;
  for (let i = 0; i < n; i++) {
    const level = 10 * Math.log10(edc[i] / edc[0]);
    if (level > -5) continue;
    if (level < -35) break;
    const t = i / fs;
    sx += t;
    sy += level;
    sxx += t * t;
    sxy += t * level;
    m++;
  }
  const slope = (m * sxy - sx * sy) / (m * sxx - sx * sx); // dB/s
  return -60 / slope;
}

test('reverb: decay within ±20% of T60 for several settings', () => {
  results.t60 = [];
  for (const decay of [1, 3]) {
    const k = kernel('reverb', { size: 1, decay, damping: 0, preDelay: 0, mix: 1 });
    const frames = Math.round((1.6 * decay + 0.5) * FS);
    const imp = new Float32Array(frames);
    imp[0] = 1;
    const [L, R] = run(k, imp, imp);
    const t60 = measureT60(L, R, FS);
    const err = (t60 - decay) / decay;
    results.t60.push([decay, t60, err]);
    assert.ok(Math.abs(err) < 0.2, `decay ${decay} s measured ${t60.toFixed(3)} s`);
  }
});

test('compressor: static curve within 0.1 dB of the formula, including the knee', () => {
  const T = -18;
  const R = 4;
  let worst = 0;
  for (const makeup of [0, 6]) {
    for (const level of [-40, -24, -21.5, -20, -18, -16.5, -15, -10, -3, 0]) {
      const k = kernel('compressor', { threshold: T, ratio: R, attack: 0.1, release: 10, makeup });
      const x = 10 ** (level / 20);
      const input = new Float32Array(FS / 2).fill(x);
      const [L] = run(k, input, input);
      const outDb = db(L[L.length - 1]);
      const expected = staticCurveDb(level, T, R, KNEE_DB) + makeup;
      const err = Math.abs(outDb - expected);
      worst = Math.max(worst, err);
      assert.ok(err < 0.1, `level ${level} dB makeup ${makeup}: ${outDb.toFixed(3)} vs ${expected.toFixed(3)}`);
      assert.ok(Math.abs(k.gainReductionDb - (level - staticCurveDb(level, T, R))) < 0.1, 'gain reduction meter');
    }
  }
  // Knee boundaries are continuous.
  for (const edge of [T - KNEE_DB / 2, T + KNEE_DB / 2]) {
    assert.ok(Math.abs(staticCurveDb(edge - 1e-9, T, R) - staticCurveDb(edge + 1e-9, T, R)) < 1e-6);
  }
  results.compressorError = worst;
});

test('EQ: a +12 dB peak measures within 0.5 dB at f0 and near 0 dB far away', () => {
  const k = kernel('eq3', { midFreq: 1000, midGain: 12, midQ: 1 });
  const n = FS;
  const gainAt = (f) => {
    const input = sine(n, f, 0.25);
    const fx = kernel('eq3', { midFreq: 1000, midGain: 12, midQ: 1 });
    const [L] = run(fx, input);
    return db(toneMagnitude(L, f, FS, FS / 4, 32768) / toneMagnitude(input, f, FS, FS / 4, 32768));
  };
  const atF0 = gainAt(1000);
  const low = gainAt(30);
  const high = gainAt(20000);
  assert.ok(Math.abs(atF0 - 12) < 0.5, `at f0: ${atF0} dB`);
  assert.ok(Math.abs(low) < 0.5, `30 Hz: ${low} dB`);
  assert.ok(Math.abs(high) < 0.5, `20 kHz: ${high} dB`);
  // The measured response matches the analytic biquad response.
  const coef = new Float64Array(5);
  peakCoefficients(coef, 0, 1000, 12, 1, FS);
  assert.ok(Math.abs(gainAt(2000) - biquadMagnitudeDb(coef, 0, 2000, FS)) < 0.05);
  assert.ok(k instanceof Eq3Kernel);
  results.eq = { atF0, low, high };
});

test('filter: lowpass attenuates an octave above cutoff; highpass and bandpass shape too', () => {
  const gain = (mode, f, cutoff = 1000, resonance = 0.707) => {
    const fx = kernel('filter', { mode: FILTER_MODES.indexOf(mode), cutoff, resonance });
    const input = sine(FS, f, 0.25);
    const [L] = run(fx, input);
    return db(toneMagnitude(L, f, FS, FS / 4, 32768) / toneMagnitude(input, f, FS, FS / 4, 32768));
  };
  const lpOctave = gain('lowpass', 2000);
  assert.ok(lpOctave < -10, `LP one octave above: ${lpOctave} dB`);
  assert.ok(Math.abs(gain('lowpass', 100)) < 0.5);
  assert.ok(gain('highpass', 500) < -10);
  assert.ok(Math.abs(gain('highpass', 10000)) < 0.5);
  assert.ok(gain('bandpass', 4000, 1000, 2) < -10);
  // Cutoff above 0.45·fs is clamped: a 32 kHz kernel stays finite at 20 kHz.
  const hi = kernel('filter', { cutoff: 20000, resonance: 12 }, 32000);
  const [L] = run(hi, noise(32000, 3));
  assert.ok(allFinite(L));
  results.filterOctave = lpOctave;
});

test('saturation: ADAA output is finite and odd-symmetric; mix 0 passes the half-sample-delayed dry', () => {
  const x = noise(FS / 2, 11, 0.9);
  const neg = x.map((v) => -v);
  const a = kernel('saturation', { drive: 36, tone: 16000, mix: 1, output: 0 });
  const b = kernel('saturation', { drive: 36, tone: 16000, mix: 1, output: 0 });
  const [ya] = run(a, x);
  const [yb] = run(b, neg);
  assert.ok(allFinite(ya));
  let asym = 0;
  for (let i = 0; i < ya.length; i++) asym = Math.max(asym, Math.abs(ya[i] + yb[i]));
  assert.ok(asym < 1e-6, `asymmetry ${asym}`);
  assert.ok(peak(ya) <= 1, 'tanh output stays within ±1');
  // A ramp with tiny steps takes the midpoint-tanh branch and stays continuous.
  const ramp = new Float32Array(4096).map((_, i) => (i - 2048) * 1e-7);
  assert.ok(allFinite(run(kernel('saturation', { drive: 36 }), ramp)[0]));

  const dry = kernel('saturation', { mix: 0, output: 0 });
  const [yd] = run(dry, x);
  let err = Math.abs(yd[0] - 0.5 * x[0]);
  for (let i = 1; i < x.length; i++) err = Math.max(err, Math.abs(yd[i] - Math.fround(0.5 * (x[i] + x[i - 1]))));
  assert.ok(err < 1e-6, `dry error ${err}`);
});

test('chain slot: bypass crossfade is click-free and takes 10 ms', () => {
  // DC 0.5 through saturation at −24 dB output: wet ≈ 0.029, dry 0.5, so a hard switch steps by ≈ 0.47.
  const slot = new EffectSlot(FS, kernel('saturation', { drive: 0, mix: 1, output: -24 }));
  const frames = FS / 4;
  const input = new Float32Array(frames).fill(0.5);
  const [L] = run(slot, input, input, (off) => {
    if (off === 40 * BLOCK) slot.setBypass(true);
    if (off === 80 * BLOCK) slot.setBypass(false);
  });
  let maxStep = 0;
  for (let i = BLOCK; i < frames; i++) maxStep = Math.max(maxStep, Math.abs(L[i] - L[i - 1]));
  assert.ok(maxStep < 0.002, `largest step ${maxStep}`);
  const fade = Math.round(0.01 * FS);
  assert.equal(L[40 * BLOCK + fade + 1], 0.5, 'fully bypassed after 10 ms');
  assert.ok(L[80 * BLOCK + fade + 1] < 0.05, 'fully active 10 ms after re-enabling');
});

test('chain slot: NaN injection resets, bypasses, outputs dry and reports the fault once', () => {
  const filter = kernel('filter', { cutoff: 500 });
  const slot = new EffectSlot(FS, filter);
  const input = noise(8 * BLOCK, 5, 0.5);
  const [L] = run(slot, input, input, (off) => {
    if (off === 4 * BLOCK) filter.state[0] = Number.NaN;
  });
  assert.ok(allFinite(L));
  for (let i = 4 * BLOCK; i < 8 * BLOCK; i++) assert.equal(L[i], input[i], 'dry output from the fault block on');
  assert.equal(filter.state[0], 0, 'kernel reset');
  assert.equal(slot.bypassed, true);
  assert.equal(slot.faulted, true);
  assert.equal(slot.takeFault(), true);
  assert.equal(slot.takeFault(), false);
  // Energy above 1e12 also faults.
  const loud = new EffectSlot(FS, kernel('compressor', { threshold: 0, ratio: 1, makeup: 24 }));
  run(loud, new Float32Array(BLOCK).fill(1e6));
  assert.equal(loud.takeFault(), true);
  // Re-enabling clears the fault flag.
  slot.setBypass(false);
  assert.equal(slot.faulted, false);
});

test('processChain runs slots in order', () => {
  const sat = new EffectSlot(FS, kernel('saturation', { drive: 0, mix: 1, output: 0 }));
  const comp = new EffectSlot(FS, kernel('compressor', { threshold: 0, ratio: 1, makeup: 6 }));
  const input = new Float32Array(4 * BLOCK).fill(0.9);
  const L = Float32Array.from(input);
  const R = Float32Array.from(input);
  processChain([sat, comp], 2, L, R, 0, L.length);
  // tanh first, then +6 dB: 2·tanh(0.9); the reverse order would give tanh(1.8).
  assert.ok(Math.abs(L[L.length - 1] - 10 ** (6 / 20) * Math.tanh(0.9)) < 1e-3, `${L[L.length - 1]}`);
});

/** True when `v` is a nonzero subnormal (double, or float32 for Float32Array storage). */
function subnormal(v, f32) {
  const a = Math.abs(v);
  return a !== 0 && a < (f32 ? 1.1754943508222875e-38 : 2.2250738585072014e-308);
}

function scanState(obj, seen = new Set()) {
  let bad = 0;
  if (seen.has(obj)) return 0;
  seen.add(obj);
  for (const value of Object.values(obj)) {
    if (typeof value === 'number') bad += subnormal(value, false) ? 1 : 0;
    else if (value instanceof Float32Array) for (const v of value) bad += subnormal(v, true) ? 1 : 0;
    else if (value instanceof Float64Array) for (const v of value) bad += subnormal(v, false) ? 1 : 0;
    else if (value && typeof value === 'object') bad += scanState(value, seen);
  }
  return bad;
}

test('denormal flush: no subnormal state after silence; tails reach exact zero', () => {
  const settings = {
    eq3: { lowGain: 18, midGain: -18, midQ: 8, highGain: 18 },
    filter: { cutoff: 50, resonance: 12 },
    compressor: { threshold: -60, ratio: 20 },
    saturation: { tone: 1000 },
    distortion: { drive: 48, bias: 0.5, tone: 500 },
    delay: { time: 1, feedback: 0.9, highCut: 1000 },
    reverb: { decay: 0.2, size: 0 },
  };
  for (const [type, params] of Object.entries(settings)) {
    const k = kernel(type, params);
    const frames = 6 * FS;
    const input = new Float32Array(frames);
    input.set(noise(FS / 4, 21));
    const [L, R] = run(k, input, input);
    assert.equal(scanState(k), 0, `${type}: subnormal state`);
    assert.equal(peak(L, frames - BLOCK), 0, `${type}: left tail not zero`);
    assert.equal(peak(R, frames - BLOCK), 0, `${type}: right tail not zero`);
  }
});

test('CPU: each effect renders 10 s of stereo noise well inside real time', (t) => {
  const seconds = 10;
  const frames = seconds * FS;
  const L0 = noise(frames, 1, 0.5);
  const R0 = noise(frames, 2, 0.5);
  const L = new Float32Array(frames);
  const R = new Float32Array(frames);
  results.cpu = {};
  for (const type of Object.keys(EFFECTS)) {
    const k = kernel(type);
    L.set(L0);
    R.set(R0);
    for (let off = 0; off < FS; off += BLOCK) k.process(L, R, off, off + BLOCK); // warm-up
    L.set(L0);
    R.set(R0);
    const t0 = performance.now();
    for (let off = 0; off < frames; off += BLOCK) k.process(L, R, off, Math.min(off + BLOCK, frames));
    const fraction = (performance.now() - t0) / 1000 / seconds;
    results.cpu[type] = fraction;
    t.diagnostic(`${type}: ${(100 * fraction).toFixed(2)}% of real time`);
    assert.ok(fraction < 0.25, `${type}: ${(100 * fraction).toFixed(1)}% of real time`);
  }
});

test('report', (t) => {
  for (const [type, p] of Object.entries(results.peaks)) t.diagnostic(`${type}: sweep peak ${p.toFixed(3)} (bound ${BOUND[type]})`);
  if (results.eq) t.diagnostic(`EQ +12 dB peak: f0 ${results.eq.atF0.toFixed(3)} dB, 30 Hz ${results.eq.low.toFixed(3)} dB, 20 kHz ${results.eq.high.toFixed(3)} dB`);
  if (results.compressorError !== undefined) t.diagnostic(`compressor max static error ${results.compressorError.toExponential(2)} dB`);
  if (results.t60) for (const [d, m, e] of results.t60) t.diagnostic(`reverb T60 ${d} s → ${m.toFixed(3)} s (${(100 * e).toFixed(1)}%)`);
  if (results.loopGain !== undefined) t.diagnostic(`delay worst echo ratio ${results.loopGain.toFixed(4)}`);
  if (results.filterOctave !== undefined) t.diagnostic(`filter LP one octave above cutoff ${results.filterOctave.toFixed(2)} dB`);
});

// Distortion: curves, ADAA, DC removal, mode changes and safety bounds.
import { DISTORTION_MODES, antiderivative, shape } from '../../src/audio/fx/effects/distortion.js';

test('distortion: each antiderivative differentiates to its curve, and every curve stays within ±1', () => {
  for (let m = 0; m < DISTORTION_MODES.length; m++) {
    for (let u = -4; u <= 4; u += 0.137) {
      const h = 1e-5;
      const slope = (antiderivative(m, u + h) - antiderivative(m, u - h)) / (2 * h);
      assert.ok(Math.abs(slope - shape(m, u)) < 1e-6, `${DISTORTION_MODES[m]} at ${u}`);
      assert.ok(Math.abs(shape(m, u)) <= 1);
    }
  }
  assert.ok(Math.abs(shape(2, 2)) < 1e-12, 'foldback folds back to zero at u = 2');
});

test('distortion: the bias adds no DC to the output; the output stays bounded at any setting', () => {
  const frames = 2 * FS;
  const sine = Float32Array.from({ length: frames }, (_, i) => 0.8 * Math.sin((2 * Math.PI * 110 * i) / FS));
  for (let mode = 0; mode < DISTORTION_MODES.length; mode++) {
    const k = kernel('distortion', { mode, drive: 48, bias: 0.5, tone: 16000, mix: 1, output: 0 });
    const [L, R] = run(k, sine, sine);
    let sum = 0;
    for (let i = FS; i < frames; i++) sum += L[i];
    assert.ok(Math.abs(sum / FS) < 0.01, `${DISTORTION_MODES[mode]}: DC ${sum / FS}`);
    assert.ok(peak(L) <= 2 && peak(R) <= 2 && allFinite(L), `${DISTORTION_MODES[mode]}: peak ${peak(L)}`);
  }
});

test('distortion: a mode change crossfades instead of stepping', () => {
  const frames = FS / 2;
  const sine = Float32Array.from({ length: frames }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 220 * i) / FS));
  const k = kernel('distortion', { mode: 0, drive: 24, output: 0 });
  const L = Float32Array.from(sine);
  const R = Float32Array.from(sine);
  k.process(L, R, 0, frames / 2);
  const before = L[frames / 2 - 1];
  k.setParam('mode', 2);
  k.process(L, R, frames / 2, frames);
  const maxStep = (a, b) => {
    let w = 0;
    for (let i = a; i < b; i++) w = Math.max(w, Math.abs(L[i + 1] - L[i]));
    return w;
  };
  const steady = Math.max(maxStep(FS / 8, frames / 2 - 1), maxStep(frames / 2 + FS / 50, frames - 1));
  const across = maxStep(frames / 2 - 64, frames / 2 + 1024);
  assert.ok(across <= 1.05 * steady, `step across the change ${across}, steady ${steady}`);
  assert.ok(Number.isFinite(before));
});

test('distortion: a fault in the kernel resets and bypasses its slot like every effect', () => {
  const k = kernel('distortion');
  const slot = new EffectSlot(FS, k);
  const input = noise(4 * BLOCK, 9, 0.5);
  run(slot, input, input, (off) => {
    if (off === 2 * BLOCK) k.lp[0] = Number.NaN;
  });
  assert.equal(slot.takeFault(), true);
  assert.equal(slot.bypassed, true);
  assert.equal(k.lp[0], 0);
});
