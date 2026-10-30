import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PARAM_DEFS, SYNTH_TYPES, VOLUME, VOLUME_OFF,
  coerceParam, coerceVolume, dbToGain, defaultParams, getDef, mtof, velocityGain,
} from '../../src/audio/synths/param-defs.js';
import { close } from './fakes.js';

const cutoff = getDef('subtractive', 'cutoff');
const waveform = getDef('subtractive', 'waveform');
const ratio = getDef('fm', 'ratio');
const index = getDef('fm', 'index');
const harmonics = getDef('additive', 'harmonics');
const HDEF = [1, 0.5, 0.33, 0.25, 0.2, 0.17, 0.14, 0.12];

test('every synth type has defs and getDef finds them', () => {
  for (const type of SYNTH_TYPES) assert.ok(PARAM_DEFS[type].length > 0, type);
  assert.equal(getDef('fm', 'ratio').max, 12);
  assert.equal(getDef('fm', 'nope'), null);
  assert.equal(getDef('nope', 'ratio'), null);
});

test('coerceParam: every default is accepted unchanged', () => {
  for (const defs of Object.values(PARAM_DEFS)) {
    for (const def of defs) assert.deepEqual(coerceParam(def, def.default), def.default, def.name);
  }
});

test('coerceParam: NaN, ±Infinity and non-numbers become the default', () => {
  for (const v of [NaN, Infinity, -Infinity, '2000', null, undefined, true, {}, [5]]) {
    assert.equal(coerceParam(cutoff, v), 2000, String(v));
  }
  assert.equal(coerceParam(index, NaN), 3);
  assert.equal(coerceParam(ratio, Infinity), 2);
});

test('coerceParam: numbers are clamped to [min, max]', () => {
  assert.equal(coerceParam(cutoff, 10), 40);
  assert.equal(coerceParam(cutoff, 1e9), 16000);
  assert.equal(coerceParam(cutoff, -5), 40);
  assert.equal(coerceParam(index, 25), 20);
  assert.equal(coerceParam(index, -1), 0);
  assert.equal(coerceParam(ratio, 0.1), 0.5);
  assert.equal(coerceParam(ratio, 99), 12);
});

test('coerceParam: values without a step are not rounded', () => {
  assert.equal(coerceParam(cutoff, 1234.567), 1234.567);
  assert.equal(coerceParam(getDef('subtractive', 'resonance'), 3.33), 3.33);
});

test('coerceParam: step snapping without float noise', () => {
  assert.equal(coerceParam(ratio, 2.3), 2.5);
  assert.equal(coerceParam(ratio, 2.2), 2);
  assert.equal(coerceParam(ratio, 11.9), 12);
  assert.equal(coerceParam(index, 3.04), 3);          // 30 * 0.1 = 3.0000000000000004 without the fix
  assert.equal(coerceParam(index, 0.7), 0.7);         // 7 * 0.1 = 0.7000000000000001 without the fix
  assert.equal(coerceParam(index, 0.68), 0.7);
  assert.equal(coerceParam(getDef('pluck', 'brightness'), 0.333), 0.33);
  assert.equal(coerceParam(getDef('granular', 'spray'), 0.2), 0.2);
});

test('coerceParam: enums fall back to the default', () => {
  assert.equal(coerceParam(waveform, 'square'), 'square');
  assert.equal(coerceParam(waveform, 'SQUARE'), 'sawtooth');
  assert.equal(coerceParam(waveform, 3), 'sawtooth');
  assert.equal(coerceParam(waveform, undefined), 'sawtooth');
  assert.equal(coerceParam(getDef('granular', 'source'), 'chord'), 'chord');
  assert.equal(coerceParam(getDef('granular', 'source'), 'pink'), 'saw');
});

test('coerceParam: harmonics from a non-array or empty array are the defaults (fresh array)', () => {
  const a = coerceParam(harmonics, 'x');
  assert.deepEqual(a, HDEF);
  assert.notEqual(a, harmonics.default);
  assert.deepEqual(coerceParam(harmonics, []), HDEF);
  assert.deepEqual(coerceParam(harmonics, undefined), HDEF);
});

test('coerceParam: harmonics are padded with 0, truncated to 8 and clamped to [0, 1]', () => {
  assert.deepEqual(coerceParam(harmonics, [0.5]), [0.5, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(
    coerceParam(harmonics, [0.5, 2, -1, NaN, 'a', Infinity, 0.25, 1, 0.9, 0.8]),
    [0.5, 1, 0, 0, 0, 0, 0.25, 1],
  );
  const src = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
  const out = coerceParam(harmonics, src);
  assert.deepEqual(out, src);
  assert.notEqual(out, src);
});

test('coerceVolume: "off" and -Infinity mean Off', () => {
  assert.equal(coerceVolume('off', -6), VOLUME_OFF);
  assert.equal(coerceVolume(-Infinity, -6), -Infinity);
  assert.equal(VOLUME_OFF, -Infinity);
});

test('coerceVolume: non-numbers, NaN and +Infinity become the fallback', () => {
  for (const v of [NaN, Infinity, '-6', null, undefined, true, 'OFF']) {
    assert.equal(coerceVolume(v, -12), -12, String(v));
  }
});

test('coerceVolume: clamps to [-60, maxDb]', () => {
  assert.equal(coerceVolume(-100, -6), -60);
  assert.equal(coerceVolume(3, -6), 0);
  assert.equal(coerceVolume(0, -6), 0);
  assert.equal(coerceVolume(-3, -6, -12), -12);
  assert.equal(coerceVolume(-30, -6, -12), -30);
  assert.equal(VOLUME.min, -60);
  assert.equal(VOLUME.max, 0);
});

test('coerceVolume: snaps to 0.5 dB and never returns -0', () => {
  assert.equal(coerceVolume(-6.3, 0), -6.5);
  assert.equal(coerceVolume(-6.2, 0), -6);
  assert.equal(coerceVolume(-6.5, 0), -6.5);
  assert.equal(coerceVolume(-59.9, 0), -60);
  const z = coerceVolume(-0.1, -6);
  assert.ok(Object.is(z, 0), 'expected +0');
  assert.ok(Object.is(coerceVolume(-0, -6), 0), 'expected +0 for -0 input');
});

test('dbToGain: 10^(dB/20), Off and non-finite are 0', () => {
  assert.equal(dbToGain(0), 1);
  close(dbToGain(-20), 0.1);
  close(dbToGain(-6), Math.pow(10, -6 / 20));
  close(dbToGain(-60), 0.001);
  assert.equal(dbToGain(-Infinity), 0);
  assert.equal(dbToGain(NaN), 0);
  assert.equal(dbToGain(Infinity), 0);
});

test('mtof: A4 = 440 Hz and octaves double', () => {
  assert.equal(mtof(69), 440);
  close(mtof(81), 880);
  close(mtof(57), 220);
  close(mtof(60), 261.6255653005986, 1e-9);
});

test('velocityGain: 0.3 at 127, square law, clamped to 1..127', () => {
  assert.equal(velocityGain(127), 0.3);
  close(velocityGain(63.5), 0.075);
  for (const v of [1, 32, 64, 100]) close(velocityGain(v), 0.3 * (v / 127) ** 2);
  close(velocityGain(64) / velocityGain(32), 4);
  close(velocityGain(0), velocityGain(1));
  close(velocityGain(-5), 0.3 / (127 * 127));
  assert.equal(velocityGain(1000), 0.3);
});

test('defaultParams returns the defaults with fresh arrays each call', () => {
  assert.deepEqual(defaultParams('subtractive'), {
    waveform: 'sawtooth', cutoff: 2000, resonance: 1, envAmount: 0, attack: 0.01, decay: 0.3, sustain: 1, release: 0.3,
  });
  assert.deepEqual(defaultParams('fm'), {
    ratio: 2, fine: 0, index: 3, indexDecay: 0.5, attack: 0.005, decay: 0.5, sustain: 1, release: 0.4,
  });
  const a = defaultParams('additive');
  const b = defaultParams('additive');
  assert.deepEqual(a.harmonics, HDEF);
  assert.notEqual(a.harmonics, b.harmonics);
  assert.notEqual(a.harmonics, harmonics.default);
  a.harmonics[0] = 0;
  assert.equal(harmonics.default[0], 1);
  assert.equal(defaultParams('additive').harmonics[0], 1);
});

test('new params default to the sound from before they existed', () => {
  // Patches saved earlier omit these params; their defaults must leave the sound unchanged.
  assert.equal(getDef('subtractive', 'envAmount').default, 0);
  for (const type of ['subtractive', 'fm', 'additive']) assert.equal(getDef(type, 'sustain').default, 1, type);
  assert.equal(getDef('fm', 'fine').default, 0);
  assert.equal(getDef('additive', 'vibratoDepth').default, 0);
  assert.equal(getDef('pluck', 'pickPosition').default, 0);
  assert.equal(getDef('granular', 'position').default, 0.5);
  assert.equal(getDef('granular', 'pitchSpread').default, 0);
  assert.equal(getDef('granular', 'attack').default, 0.05);
  assert.equal(getDef('granular', 'release').default, 0.4);
});

test('no card has more than 8 controls', () => {
  for (const type of SYNTH_TYPES) assert.ok(PARAM_DEFS[type].length <= 8, type);
});
