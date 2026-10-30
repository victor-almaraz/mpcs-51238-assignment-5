import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MIN_ATTACK, MIN_RELEASE, FAST_TAU, STEAL_TAU,
  holdAt, envValueAt, scheduleAttack, scheduleRelease,
} from '../../src/audio/envelope.js';
import { close, fakeParam, assertCalls } from './fakes.js';

// start 1 s, 100 ms linear attack to 0.3, no release yet.
const voice = (extra = {}) => ({ start: 1, attack: 0.1, peak: 0.3, offTime: Infinity, relFrom: 0, tau: 1, ...extra });

test('limits match audio-engine-core.md', () => {
  assert.equal(MIN_ATTACK, 0.002);
  assert.equal(MIN_RELEASE, 0.01);
  assert.equal(STEAL_TAU, 0.0015);
  close(FAST_TAU * 3, 0.01, 1e-3);
});

test('envValueAt is 0 before and at the start', () => {
  const v = voice();
  assert.equal(envValueAt(v, 0), 0);
  assert.equal(envValueAt(v, 0.999), 0);
  assert.equal(envValueAt(v, 1), 0);
});

test('envValueAt rises linearly during the attack', () => {
  const v = voice();
  close(envValueAt(v, 1.025), 0.075);
  close(envValueAt(v, 1.05), 0.15);
  close(envValueAt(v, 1.075), 0.225);
});

test('envValueAt holds the peak after the attack', () => {
  const v = voice();
  assert.equal(envValueAt(v, 1.5), 0.3);
  assert.equal(envValueAt(v, 100), 0.3);
});

test('envValueAt decays exponentially from relFrom after offTime', () => {
  const v = voice({ offTime: 2, relFrom: 0.3, tau: 0.1 });
  assert.equal(envValueAt(v, 1.5), 0.3);          // before the release: attack model
  close(envValueAt(v, 2), 0.3);                   // at offTime
  close(envValueAt(v, 2.1), 0.3 * Math.exp(-1));
  close(envValueAt(v, 2.3), 0.3 * Math.exp(-3));
  assert.ok(envValueAt(v, 10) < 1e-12);
});

test('envValueAt during a release started mid-attack decays from that level', () => {
  const v = voice({ offTime: 1.05, relFrom: 0.15, tau: 0.01 });
  close(envValueAt(v, 1.06), 0.15 * Math.exp(-1));
});

test('holdAt uses cancelAndHoldAtTime when present', () => {
  const p = fakeParam({ hold: true, trapValue: true });
  holdAt(p, 2, 0.7);
  assertCalls(p.calls, [['cancelAndHoldAtTime', 2]]);
});

test('holdAt falls back to cancelScheduledValues + setValueAtTime(model value)', () => {
  const p = fakeParam({ hold: false, trapValue: true });
  holdAt(p, 2, 0.7);
  assertCalls(p.calls, [['cancelScheduledValues', 2], ['setValueAtTime', 0.7, 2]]);
});

test('scheduleAttack: set 0 at start, linear ramp to peak at start + attack', () => {
  const p = fakeParam({ trapValue: true });
  scheduleAttack(p, voice());
  assertCalls(p.calls, [['setValueAtTime', 0, 1], ['linearRampToValueAtTime', 0.3, 1.1]]);
});

test('scheduleRelease mid-attack with cancelAndHoldAtTime', () => {
  const p = fakeParam({ hold: true, trapValue: true });
  const v = voice();
  scheduleRelease(p, v, 1.05, 0.01);
  assertCalls(p.calls, [['cancelAndHoldAtTime', 1.05], ['setTargetAtTime', 0, 1.05, 0.01]]);
  assert.equal(v.offTime, 1.05);
  close(v.relFrom, 0.15);
  assert.equal(v.tau, 0.01);
});

test('scheduleRelease mid-attack without cancelAndHoldAtTime ramps to the model value', () => {
  const p = fakeParam({ hold: false, trapValue: true });
  const v = voice();
  scheduleRelease(p, v, 1.05, 0.01);
  assertCalls(p.calls, [
    ['cancelScheduledValues', 1.05],
    ['linearRampToValueAtTime', 0.15, 1.05],
    ['setTargetAtTime', 0, 1.05, 0.01],
  ]);
  assert.equal(v.offTime, 1.05);
  close(v.relFrom, 0.15);
  assert.equal(v.tau, 0.01);
});

test('scheduleRelease after the attack holds at the peak', () => {
  const p = fakeParam({ hold: false });
  const v = voice();
  scheduleRelease(p, v, 2, 0.1);
  assertCalls(p.calls, [['cancelScheduledValues', 2], ['setValueAtTime', 0.3, 2], ['setTargetAtTime', 0, 2, 0.1]]);
  assert.equal(v.relFrom, 0.3);
});

test('scheduleRelease during a release (steal) continues from the decayed value', () => {
  const p = fakeParam({ hold: false, trapValue: true });
  const v = voice({ offTime: 2, relFrom: 0.3, tau: 0.1 });
  scheduleRelease(p, v, 2.1, STEAL_TAU);
  const from = 0.3 * Math.exp(-1);
  assertCalls(p.calls, [
    ['cancelScheduledValues', 2.1],
    ['setValueAtTime', from, 2.1],
    ['setTargetAtTime', 0, 2.1, STEAL_TAU],
  ]);
  assert.equal(v.offTime, 2.1);
  close(v.relFrom, from);
  assert.equal(v.tau, STEAL_TAU);
  close(envValueAt(v, 2.1 + STEAL_TAU), from * Math.exp(-1));
});

test('scheduleRelease for a voice that has not started holds at 0', () => {
  const p = fakeParam({ hold: false });
  const v = voice({ start: 5 });
  scheduleRelease(p, v, 3, FAST_TAU);
  assertCalls(p.calls, [['cancelScheduledValues', 3], ['setValueAtTime', 0, 3], ['setTargetAtTime', 0, 3, FAST_TAU]]);
  assert.equal(v.relFrom, 0);
});

// ADSR: 100 ms attack to 0.3, then decay (τ 0.1 s) towards sustain 0.5 × 0.3 = 0.15.
const adsr = (extra = {}) => voice({ sustain: 0.5, decayTau: 0.1, ...extra });

test('envValueAt decays from the peak towards sustain × peak after the attack', () => {
  const v = adsr();
  close(envValueAt(v, 1.05), 0.15);                         // still in the attack
  close(envValueAt(v, 1.1), 0.3);                           // peak at the end of the attack
  close(envValueAt(v, 1.2), 0.15 + 0.15 * Math.exp(-1));
  close(envValueAt(v, 3), 0.15, 1e-6);                      // settled at the sustain level
});

test('envValueAt: sustain 1 or absent holds the peak (plain AR)', () => {
  close(envValueAt(adsr({ sustain: 1 }), 2), 0.3);
  close(envValueAt(voice(), 2), 0.3);
});

test('scheduleAttack adds the decay to sustain only when sustain < 1', () => {
  const p = fakeParam({ trapValue: true });
  scheduleAttack(p, adsr());
  assertCalls(p.calls, [['setValueAtTime', 0, 1], ['linearRampToValueAtTime', 0.3, 1.1], ['setTargetAtTime', 0.15, 1.1, 0.1]]);
  const q = fakeParam({ trapValue: true });
  scheduleAttack(q, adsr({ sustain: 1 }));
  assert.equal(q.calls.length, 2);
});

test('scheduleRelease during the decay starts from the decaying level', () => {
  const p = fakeParam({ hold: false, trapValue: true });
  const v = adsr();
  scheduleRelease(p, v, 1.2, 0.05);
  close(v.relFrom, 0.15 + 0.15 * Math.exp(-1));
  assertCalls(p.calls, [['cancelScheduledValues', 1.2], ['setValueAtTime', v.relFrom, 1.2], ['setTargetAtTime', 0, 1.2, 0.05]]);
});

test('holdAt with inRamp uses cancelAndHoldAtTime when available', () => {
  const p = fakeParam({ hold: true, trapValue: true });
  holdAt(p, 2, 0.5, true);
  assertCalls(p.calls, [['cancelAndHoldAtTime', 2]]);
});
