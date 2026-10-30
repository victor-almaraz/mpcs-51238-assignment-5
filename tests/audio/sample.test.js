import test from 'node:test';
import assert from 'node:assert/strict';
import { conditionSample, SampleError, MAX_SAMPLE_SECONDS } from '../../src/audio/sample.js';

const SR = 8000;
const peakOf = (d) => d.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
const rmsOf = (d) => Math.sqrt(d.reduce((s, x) => s + x * x, 0) / d.length);
const sine = (n, hz, amp, dc = 0) => Float32Array.from({ length: n }, (_, i) => dc + amp * Math.sin((2 * Math.PI * hz * i) / SR));

test('quiet audio is raised to peak 1 unless its RMS would pass the cap', () => {
  const clicks = new Float32Array(SR);
  for (let i = 100; i < SR; i += 400) clicks[i] = 0.01;      // sparse: low RMS, peak-limited
  assert.ok(Math.abs(peakOf(conditionSample([clicks], SR).data) - 1) < 1e-2);
  const { data } = conditionSample([sine(SR, 220, 0.01)], SR); // a sine reaches the RMS cap first
  assert.ok(Math.abs(rmsOf(data) - 1 / Math.sqrt(3)) < 1e-3);
  assert.ok(peakOf(data) < 1);
});

test('a full-scale square is held to the generated sources\' RMS', () => {
  const sq = Float32Array.from({ length: SR }, (_, i) => (Math.floor(i / 20) % 2 ? 1 : -1));
  const { data } = conditionSample([sq], SR);
  assert.ok(rmsOf(data) <= 1 / Math.sqrt(3) + 1e-6);
  assert.ok(peakOf(data) <= 1 + 1e-6);
});

test('DC is removed and the edges fade from and to zero', () => {
  const { data } = conditionSample([sine(SR, 220, 0.2, 0.7)], SR);
  const mean = data.reduce((s, x) => s + x, 0) / data.length;
  assert.ok(Math.abs(mean) < 0.01, `mean ${mean}`);
  assert.ok(Math.abs(data[0]) < 1e-9);
  assert.ok(Math.abs(data[data.length - 1]) < 1e-6);
});

test('stereo is mixed to mono and long files are truncated', () => {
  const n = SR * (MAX_SAMPLE_SECONDS + 1);
  const { data, truncated } = conditionSample([sine(n, 220, 0.5), sine(n, 220, 0.5)], SR);
  assert.equal(data.length, SR * MAX_SAMPLE_SECONDS);
  assert.equal(truncated, true);
});

test('NaN and Infinity count as silence; silent and empty files are rejected', () => {
  const bad = sine(SR, 220, 0.5);
  bad[100] = NaN;
  bad[200] = Infinity;
  const { data } = conditionSample([bad], SR);
  assert.ok(data.every(Number.isFinite));
  assert.throws(() => conditionSample([new Float32Array(SR)], SR), SampleError);
  assert.throws(() => conditionSample([new Float32Array(0)], SR), SampleError);
  assert.throws(() => conditionSample([], SR), SampleError);
});
