import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { json2satrec, propagate } from 'satellite.js';
import { OmmError, toOmm } from '../src/sky/omm.js';

const ISS = JSON.parse(readFileSync(new URL('./fixtures/sky/iss-object.json', import.meta.url), 'utf8'));
const OMM = JSON.parse(readFileSync(new URL('./fixtures/sky/iss-omm.json', import.meta.url), 'utf8'));

test('toOmm restores the CelesTrak record from normalized fields', () => {
  assert.deepEqual(toOmm(ISS.fields), { ...OMM, NORAD_CAT_ID: String(OMM.NORAD_CAT_ID) });
});

test('json2satrec(toOmm(fields)) propagates like the raw record', () => {
  const t = new Date('2026-10-29T20:00:00Z');
  const a = propagate(json2satrec(toOmm(ISS.fields)), t).position;
  const b = propagate(json2satrec(OMM), t).position;
  assert.deepEqual(a, b);
});

test('six-digit catalog numbers pass through', () => {
  const omm = toOmm({ ...ISS.fields, noradId: '101031' });
  assert.equal(omm.NORAD_CAT_ID, '101031');
  assert.equal(json2satrec(omm).satnum, '101031');
});

test('null drag terms become 0 and null optional fields are omitted', () => {
  const omm = toOmm({ ...ISS.fields, bstar: null, meanMotionDot: null, revAtEpoch: null, classification: null });
  assert.equal(omm.BSTAR, 0);
  assert.equal(omm.MEAN_MOTION_DOT, 0);
  assert.equal('REV_AT_EPOCH' in omm, false);
  assert.equal('CLASSIFICATION_TYPE' in omm, false);
});

test('missing or invalid elements fail with the field name', () => {
  assert.throws(() => toOmm({ ...ISS.fields, meanMotion: null }), (e) => e instanceof OmmError && /meanMotion/.test(e.message));
  assert.throws(() => toOmm({ ...ISS.fields, epoch: 'soon' }), /epoch/);
  assert.throws(() => toOmm({ ...ISS.fields, noradId: 25544 }), /noradId/);
  assert.throws(() => toOmm(null), OmmError);
});
