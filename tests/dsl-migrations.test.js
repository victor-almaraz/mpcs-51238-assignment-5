// IR versioning (doc/piece-dsl.md, Versioning): each migration step on a fixture, and the round
// trip of a stored IR to the current version.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { defs } from './fixtures/dsl/load.js';
import { loadIr, migrate, migrations } from '../src/dsl/migrations.js';
import { CURRENT_IR_VERSION } from '../src/dsl/limits.js';

const v1 = JSON.parse(readFileSync(new URL('./fixtures/dsl/ir-v1.json', import.meta.url), 'utf8'));

test('a step exists for every version below the current one', () => {
  for (let n = 1; n < CURRENT_IR_VERSION; n++) assert.equal(typeof migrations[n], 'function', `step ${n}`);
  assert.equal(Object.keys(migrations).length, CURRENT_IR_VERSION - 1);
});

test('each step returns the next version and leaves its input unchanged', () => {
  for (let n = 1; n < CURRENT_IR_VERSION; n++) {
    const input = JSON.parse(JSON.stringify({ ...v1, irVersion: n }));
    const before = JSON.stringify(input);
    assert.equal(migrations[n](input).irVersion, n + 1);
    assert.equal(JSON.stringify(input), before);
  }
});

test('a stored version-1 IR loads at the current version with no problems', () => {
  const r = loadIr(v1, defs);
  assert.deepEqual(r.problems, []);
  assert.equal(r.ir.irVersion, CURRENT_IR_VERSION);
  if (CURRENT_IR_VERSION === 1) assert.deepEqual(r.ir, v1);
  assert.notEqual(r.ir, v1, 'migration works on a copy');
});

test('migrate applies steps in order', () => {
  const steps = {
    1: (/** @type {any} */ ir) => ({ ...ir, irVersion: 2, trail: [...(ir.trail ?? []), 1] }),
    2: (/** @type {any} */ ir) => ({ ...ir, irVersion: 3, trail: [...ir.trail, 2] }),
  };
  assert.deepEqual(migrate({ irVersion: 1 }, { steps, current: 3 }).ir, { irVersion: 3, trail: [1, 2] });
  assert.deepEqual(migrate({ irVersion: 2, trail: [] }, { steps, current: 3 }).ir, { irVersion: 3, trail: [2] });
  assert.throws(() => migrate({ irVersion: 1 }, { steps: { 1: (/** @type {any} */ ir) => ir }, current: 2 }), /must return irVersion 2/);
});

test('a newer version is rejected with ir_version_unsupported', () => {
  const r = migrate({ ...v1, irVersion: CURRENT_IR_VERSION + 1 });
  assert.equal(r.ir, null);
  assert.deepEqual(r.problems.map((p) => [p.code, p.path]), [['ir_version_unsupported', '/irVersion']]);
});

test('a missing or invalid version is ir_schema', () => {
  for (const bad of [{}, { irVersion: 0 }, { irVersion: '1' }, null, []]) {
    assert.equal(migrate(bad).problems[0].code, 'ir_schema');
  }
});
