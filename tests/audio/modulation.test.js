// Modulation model and LFOs (doc/audio/modulation.md; doc/testing.md, Engine tests): normalized
// sums and clamps, down-only parameters, rejected targets, audio-rate conversion and limits,
// LFO determinism and phase continuity.
import test from 'node:test';
import assert from 'node:assert/strict';

import { modulate, modulateDown, modulatedValue, nativeGain, depthScale, limitedGains, voiceOffsetRange, synthModPath, effectModulatable, effectModDown } from '../../src/audio/mod/model.js';
import { toNorm, fromNorm } from '../../src/audio/fx/core/params.js';
import { LfoClock, periodicValue, steppedValue, stepValue, smoothDecay, periodicCoefficients, syncHz, dataHz, SHAPE_CODE } from '../../src/audio/mod/lfo.js';
import { PARAM_DEFS, getDef } from '../../src/audio/synths/param-defs.js';
import { EFFECTS } from '../../src/audio/fx/effects/registry.js';
import { ChainCore, SUB_BLOCK } from '../../src/audio/fx/chain-core.js';

const lin = { min: -18, max: 18, default: 0, scale: 'lin' };
const log = { min: 20, max: 20000, default: 1000, scale: 'log' };
const pow3 = { min: 0.002, max: 2, default: 0.01, scale: 'pow3' };
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${a} ≉ ${b}`);

test('model: the sum is taken in normalized space and clamped to [min, max] on lin, log and pow3', () => {
  near(modulate(lin, 0, 0.25), 9);
  near(modulate(lin, 0, -0.25), -9);
  near(modulate(lin, 12, 0.5), 18, 0);                    // clamped at max
  near(modulate(log, 1000, 0.1), 1000 * 2 ** (0.1 * Math.log2(1000)));   // log: depth 0.1 ≈ one octave
  near(modulate(log, 1000, -2), 20);                      // clamped at min
  const u = toNorm(pow3, 0.5);
  near(modulate(pow3, 0.5, 0.1), fromNorm(pow3, u + 0.1));
  near(modulate(pow3, 0.5, 1), 2);
  // Two routes sum before the clamp; a negative depth inverts its source.
  near(modulatedValue(lin, 0, [{ depth: 0.25, value: 1 }, { depth: -0.25, value: 1 }]), 0);
  near(modulatedValue(lin, 0, [{ depth: -0.5, value: -1 }]), 18);
});

test('model: down parameters never exceed their base value', () => {
  const out = EFFECTS.saturation.params.find((d) => d.id === 'output');
  assert.ok(effectModDown(out));
  for (let s = -1; s <= 1; s += 0.125) {
    for (const d of [-1, -0.3, 0.3, 1]) {
      const v = modulatedValue(out, -3, [{ depth: d, value: s }], true);
      assert.ok(v <= -3 + 1e-9 && v >= out.min, `${v} at s=${s}, d=${d}`);
    }
  }
  near(modulateDown(out, -3, 0), -3);
  near(modulateDown(out, -3, 2), -24);
  for (const [type, id] of [['compressor', 'makeup'], ['distortion', 'output'], ['saturation', 'output']]) {
    assert.ok(effectModDown(EFFECTS[type].params.find((d) => d.id === id)), `${type}.${id} is down`);
  }
});

test('targets: enum and array parameters are rejected; every numeric synth parameter has a ModDef', () => {
  for (const [type, defs] of Object.entries(PARAM_DEFS)) {
    for (const d of defs) {
      const path = synthModPath(d);
      if (d.kind === 'enum' || d.kind === 'array') assert.equal(path, null, `${type}.${d.name}`);
      else assert.ok(path === 'audio' || path === 'control', `${type}.${d.name} has ${path}`);
    }
  }
  assert.equal(synthModPath(getDef('additive', 'harmonics')), null);
  assert.equal(synthModPath(getDef('subtractive', 'waveform')), null);
  assert.equal(synthModPath(getDef('subtractive', 'cutoff')), 'audio');
  assert.equal(synthModPath({ ...getDef('subtractive', 'attack'), mod: { rate: 'audio', target: 'env.gain' } }), 'control', 'pow3 uses the control path');
  assert.equal(synthModPath({ ...getDef('subtractive', 'cutoff'), mod: { rate: 'audio', target: 'filter.detune', dir: 'down' } }), 'control', 'down uses the control path');
  assert.equal(effectModulatable(EFFECTS.filter.params.find((d) => d.id === 'mode')), false);
  assert.equal(effectModulatable(EFFECTS.delay.params.find((d) => d.id === 'sync')), false);
  assert.equal(effectModulatable(EFFECTS.delay.params.find((d) => d.id === 'time')), true);
});

test('audio-rate routes: depth converts to cents on log parameters and units on lin parameters', () => {
  const cutoff = getDef('subtractive', 'cutoff');
  near(nativeGain(cutoff, 0.1), 0.1 * Math.log2(16000 / 40) * 1200);
  const res = getDef('subtractive', 'resonance');
  near(nativeGain(res, 0.25), 0.25 * 20);
  near(nativeGain(getDef('additive', 'vibratoDepth'), -0.5), -50);
});

test('audio-rate routes: the gain limit keeps toNorm(base) ± Σ|depth| within 0–1', () => {
  const cutoff = getDef('subtractive', 'cutoff');
  for (const base of [40, 60, 300, 2000, 9000, 16000]) {
    for (const depths of [[0.1], [0.5, -0.4], [1, 1, 1, 1], [0.02, 0.03]]) {
      const k = depthScale(cutoff, base, depths);
      const S = depths.reduce((s, d) => s + Math.abs(d), 0) * k;
      const u0 = toNorm(cutoff, base);
      assert.ok(u0 - S >= -1e-12 && u0 + S <= 1 + 1e-12, `base ${base}, depths ${depths}: ${u0} ± ${S}`);
      if (S / k <= Math.min(u0, 1 - u0)) assert.equal(k, 1, 'no limit when the routes fit');
      const g = limitedGains(cutoff, base, depths);
      g.forEach((x, i) => near(x, nativeGain(cutoff, depths[i] * k)));
    }
  }
  const [lo, hi] = voiceOffsetRange(cutoff, 2000, 0.1);
  const u0 = toNorm(cutoff, 2000);
  near(u0 + lo - 0.1, 0);
  near(u0 + hi + 0.1, 1);
});

test('LFO shapes: bipolar, sine-phase, and the documented values', () => {
  for (const code of [0, 1, 2, 3]) {
    for (let p = -2; p < 3; p += 0.01) {
      const v = periodicValue(code, p);
      assert.ok(v >= -1 && v <= 1, `shape ${code} at ${p}: ${v}`);
    }
  }
  near(periodicValue(SHAPE_CODE.sine, 0.25), 1);
  near(periodicValue(SHAPE_CODE.triangle, 0), 0);
  near(periodicValue(SHAPE_CODE.triangle, 0.25), 1);
  near(periodicValue(SHAPE_CODE.triangle, 0.75), -1);
  assert.equal(periodicValue(SHAPE_CODE.square, 0.1), 1);
  assert.equal(periodicValue(SHAPE_CODE.square, 0.6), -1);
  near(periodicValue(SHAPE_CODE.saw, 0), 0);
  near(periodicValue(SHAPE_CODE.saw, 0.25), 0.5);
  near(syncHz('1/4', 120), 2);
  near(syncHz('1/8t', 90), 90 / 60 / (0.5 * 2 / 3));
  near(dataHz(-1, 0.1, 3), 0.1);
  near(dataHz(1, 0.1, 3), 3);
  near(dataHz(0, 1, 3), 2);
});

test('LFO shapes: the PeriodicWave coefficients reproduce the shifted shape with a peak of at most 1', () => {
  for (const shape of ['sine', 'triangle', 'square', 'saw']) {
    for (const phase of [0, 0.3, 0.75]) {
      const { real, imag } = periodicCoefficients(shape, phase);
      let peak = 0;
      let err = 0;
      for (let i = 0; i < 1000; i++) {
        const th = i / 1000;
        let y = 0;
        for (let k = 1; k < real.length; k++) y += real[k] * Math.cos(2 * Math.PI * k * th) + imag[k] * Math.sin(2 * Math.PI * k * th);
        peak = Math.max(peak, Math.abs(y));
        // Away from the square and saw edges the band-limited wave tracks the exact shape.
        const p = (th + phase) % 1;
        const edge = Math.min(Math.abs(p - 0.5), p, 1 - p);
        if (shape === 'sine' || shape === 'triangle' || edge > 0.08) err = Math.max(err, Math.abs(y - periodicValue(SHAPE_CODE[shape], th + phase)));
      }
      assert.ok(peak <= 1 + 1e-5, `${shape} peak ${peak}`);
      assert.ok(err < ({ sine: 1e-6, triangle: 0.05 }[shape] ?? 0.2), `${shape} at phase ${phase}: error ${err}`);
    }
  }
});

test('random and smooth: sequences repeat for a seed and differ for another; smooth is continuous', () => {
  const seq = (seed, idx) => Array.from({ length: 50 }, (_, k) => stepValue(seed, idx, k));
  assert.deepEqual(seq(1, 0), seq(1, 0));
  assert.notDeepEqual(seq(1, 0), seq(2, 0));
  assert.notDeepEqual(seq(1, 0), seq(1, 1));
  assert.ok(seq(5, 2).every((v) => v >= -1 && v < 1));
  // smooth = 0 holds each value for the cycle.
  assert.equal(steppedValue(3, 0, 4.2, 0, 0), stepValue(3, 0, 4));
  assert.equal(steppedValue(3, 0, 4.9, 0, 0), stepValue(3, 0, 4));
  // smooth > 0: no jump at cycle starts.
  const s = 0.5;
  const d = smoothDecay(s);
  for (let k = 1; k < 30; k++) {
    const a = steppedValue(3, 0, k - 1e-9, s, d);
    const b = steppedValue(3, 0, k + 1e-9, s, d);
    assert.ok(Math.abs(a - b) < 1e-3, `jump ${a} → ${b} at cycle ${k}`);
  }
});

test('LFO phase from frames in a chain equals phase from t − t₀; rate changes keep phase continuous', () => {
  const fs = 44100;
  const clock = new LfoClock(0.2, 1.7, 0.5);   // phase 0.2, 1.7 Hz, t₀ = 0.5 s
  const c = new ChainCore(fs, { seed: 1 });
  c.handle({ t: 'lfos', seed: 1, lfos: [{ id: 'lfo0', index: 0, shape: 'triangle', rate: 1.7, phase: 0.2, smooth: 0, anchorT: 0.5, anchorPhase: 0.2, hz: 1.7 }] });
  for (const frame of [22050, 44100 * 7 + 13, 44100 * 3600]) {
    c.evaluate(frame / fs);
    near(c.lfoVal[0], periodicValue(SHAPE_CODE.triangle, clock.phaseAt(frame / fs)), 1e-9);
  }
  const before = clock.phaseAt(10);
  clock.setHz(3.1, 10);
  near(clock.phaseAt(10), before);
  near(clock.phaseAt(11) - clock.phaseAt(10), 3.1);
  assert.equal(SUB_BLOCK, 32);
});
