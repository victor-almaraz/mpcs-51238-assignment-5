import test from 'node:test';
import assert from 'node:assert/strict';

import { TrackedParam, GAIN_TAU, RISE_TAU, FILTER_TAU, POLY_TAU } from '../../src/audio/smoothing.js';
import { close, fakeParam, assertCalls } from './fakes.js';

test('time constants match audio-safety.md', () => {
  assert.equal(GAIN_TAU, 0.01);
  assert.equal(FILTER_TAU, 0.015);
  assert.equal(POLY_TAU, 0.05);
  assert.ok(RISE_TAU >= GAIN_TAU);
});

test('a new TrackedParam holds its value and schedules nothing', () => {
  const p = fakeParam();
  const tp = new TrackedParam(p, 0.5);
  assert.equal(tp.valueAt(0), 0.5);
  assert.equal(tp.valueAt(100), 0.5);
  assert.equal(tp.target, 0.5);
  assert.equal(p.calls.length, 0);
});

test('setTarget (fallback) holds at the tracked value, not param.value', () => {
  const p = fakeParam({ hold: false, value: 999 });
  const tp = new TrackedParam(p, 0.5);
  tp.setTarget(1, 2, 0.1);
  assertCalls(p.calls, [['cancelScheduledValues', 2], ['setValueAtTime', 0.5, 2], ['setTargetAtTime', 1, 2, 0.1]]);
  assert.equal(tp.target, 1);
});

test('setTarget (cancelAndHoldAtTime) never touches param.value', () => {
  const p = fakeParam({ hold: true, trapValue: true });
  const tp = new TrackedParam(p, 0.5);
  tp.setTarget(1, 2, 0.1);
  assertCalls(p.calls, [['cancelAndHoldAtTime', 2], ['setTargetAtTime', 1, 2, 0.1]]);
});

test('valueAt follows a target segment exponentially', () => {
  const tp = new TrackedParam(fakeParam(), 0.5);
  tp.setTarget(1, 2, 0.1);
  assert.equal(tp.valueAt(1.9), 0.5);
  assert.equal(tp.valueAt(2), 0.5);
  close(tp.valueAt(2.1), 1 - 0.5 * Math.exp(-1));
  close(tp.valueAt(2.3), 1 - 0.5 * Math.exp(-3));
  close(tp.valueAt(10), 1);
});

test('chained setTarget starts from the value reached on the previous segment', () => {
  const p = fakeParam({ hold: false, trapValue: true });
  const tp = new TrackedParam(p, 0.5);
  tp.setTarget(1, 2, 0.1);
  tp.setTarget(0, 2.1, 0.01);
  const v0 = 1 - 0.5 * Math.exp(-1);
  assertCalls(p.calls.slice(3), [['cancelScheduledValues', 2.1], ['setValueAtTime', v0, 2.1], ['setTargetAtTime', 0, 2.1, 0.01]]);
  assert.equal(tp.target, 0);
  close(tp.valueAt(2.11), v0 * Math.exp(-1));
});

test('linearTo ramps from the tracked value over `duration`', () => {
  const p = fakeParam({ hold: true, trapValue: true });
  const tp = new TrackedParam(p, 0.5);
  tp.linearTo(0, 1, 0.5);
  assertCalls(p.calls, [['cancelAndHoldAtTime', 1], ['linearRampToValueAtTime', 0, 1.5]]);
  assert.equal(tp.target, 0);
  assert.equal(tp.valueAt(0.9), 0.5);
  close(tp.valueAt(1.25), 0.25);
  assert.equal(tp.valueAt(1.5), 0);
  assert.equal(tp.valueAt(3), 0);
});

test('linearTo during a target segment (fallback) holds at the computed value', () => {
  const p = fakeParam({ hold: false, value: 999 });
  const tp = new TrackedParam(p, 0.5);
  tp.setTarget(1, 0, 0.1);
  tp.linearTo(0, 0.1, 1);
  const v0 = 1 - 0.5 * Math.exp(-1);
  assertCalls(p.calls.slice(3), [['cancelScheduledValues', 0.1], ['setValueAtTime', v0, 0.1], ['linearRampToValueAtTime', 0, 1.1]]);
  close(tp.valueAt(0.6), v0 / 2);
  assert.equal(tp.target, 0);
});

test('setAt jumps to a value at t', () => {
  const p = fakeParam({ hold: true });
  const tp = new TrackedParam(p, 0.5);
  tp.setAt(0.2, 3);
  assertCalls(p.calls, [['cancelAndHoldAtTime', 3], ['setValueAtTime', 0.2, 3]]);
  assert.equal(tp.target, 0.2);
  assert.equal(tp.valueAt(4), 0.2);
});
