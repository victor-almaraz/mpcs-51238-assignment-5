import test from 'node:test';
import assert from 'node:assert/strict';

import { fromNorm, toNorm, usesNativeSteps } from '../../src/audio/synths/scaling.js';
import { PARAM_DEFS, getDef } from '../../src/audio/synths/param-defs.js';
import { close } from './fakes.js';

const LOG = { min: 40, max: 16000, scale: 'log' };
const POW3 = { min: 0.002, max: 2, scale: 'pow3' };
const LIN = { min: 0, max: 20, scale: 'lin' };
const DEFS = [LOG, POW3, LIN];
const US = [0, 0.001, 0.1, 0.25, 0.37, 0.5, 0.75, 0.9, 0.999, 1];

test('fromNorm maps 0 and 1 to min and max for every scale', () => {
  for (const def of DEFS) {
    close(fromNorm(def, 0), def.min);
    close(fromNorm(def, 1), def.max);
  }
});

test('log scale: v = min * (max/min) ** u, midpoint is the geometric mean', () => {
  close(fromNorm(LOG, 0.5), 800);
  close(toNorm(LOG, 800), 0.5);
  close(fromNorm(LOG, 0.25), 40 * Math.pow(400, 0.25));
});

test('pow3 scale: v = min + (max-min) * u ** 3', () => {
  close(fromNorm(POW3, 0.5), 0.002 + 1.998 * 0.125);
  close(toNorm(POW3, 0.002 + 1.998 * 0.125), 0.5);
  close(fromNorm(POW3, 0.1), 0.002 + 1.998 * 0.001);
});

test('lin scale: v = min + (max-min) * u', () => {
  close(fromNorm(LIN, 0.25), 5);
  close(toNorm(LIN, 15), 0.75);
});

test('round trip u -> v -> u for lin, log and pow3', () => {
  for (const def of DEFS) {
    for (const u of US) close(toNorm(def, fromNorm(def, u)), u);
  }
});

test('round trip v -> u -> v for lin, log and pow3', () => {
  for (const [def, vs] of [[LOG, [40, 100, 2000, 16000]], [POW3, [0.002, 0.01, 0.3, 2]], [LIN, [0, 1, 7.5, 20]]]) {
    for (const v of vs) close(fromNorm(def, toNorm(def, v)), v, 1e-9 * Math.max(1, v));
  }
});

test('round trip holds for every numeric def in PARAM_DEFS', () => {
  for (const defs of Object.values(PARAM_DEFS)) {
    for (const def of defs) {
      if (def.kind !== 'number') continue;
      for (const u of US) close(toNorm(def, fromNorm(def, u)), u);
    }
  }
});

test('fromNorm clamps u outside [0, 1]', () => {
  for (const def of DEFS) {
    close(fromNorm(def, -0.5), def.min);
    close(fromNorm(def, -Infinity), def.min);
    close(fromNorm(def, 1.5), def.max);
    close(fromNorm(def, Infinity), def.max);
  }
});

test('toNorm clamps to [0, 1] and maps non-finite results to 0', () => {
  assert.equal(toNorm(LIN, 25), 1);
  assert.equal(toNorm(LIN, -5), 0);
  assert.equal(toNorm(LIN, NaN), 0);
  assert.equal(toNorm(LOG, 20), 0);
  assert.equal(toNorm(LOG, 1e6), 1);
  assert.equal(toNorm(LOG, 0), 0);       // log(0) = -Infinity
  assert.equal(toNorm(LOG, -1), 0);      // log of a negative = NaN
  assert.equal(toNorm(POW3, 0), 0);      // cbrt of a negative
  assert.equal(toNorm(POW3, 5), 1);
});

test('toNorm returns 0 for an empty range', () => {
  assert.equal(toNorm({ min: 5, max: 5, scale: 'lin' }, 5), 0);
  assert.equal(toNorm({ min: 5, max: 1, scale: 'lin' }, 3), 0);
});

test('usesNativeSteps is true only for linear defs with a numeric step', () => {
  assert.equal(usesNativeSteps(getDef('fm', 'ratio')), true);
  assert.equal(usesNativeSteps(getDef('fm', 'index')), true);
  assert.equal(usesNativeSteps(getDef('pluck', 'damping')), true);
  assert.equal(usesNativeSteps(getDef('subtractive', 'resonance')), false);   // lin, no step
  assert.equal(usesNativeSteps(getDef('subtractive', 'cutoff')), false);      // log
  assert.equal(usesNativeSteps(getDef('fm', 'indexDecay')), false);           // pow3
  assert.equal(usesNativeSteps(getDef('subtractive', 'waveform')), false);    // radio
  assert.equal(usesNativeSteps({ scale: 'log', step: 1 }), false);
  assert.equal(usesNativeSteps({ scale: 'lin', step: '1' }), false);
});
