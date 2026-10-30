// Types (doc/piece-dsl.md, Types; doc/testing.md, Types): builder.d.ts generation is deterministic,
// invalid scripts yield the expected diagnostics, and the examples yield none.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import ts from 'typescript';
import * as vfs from '@typescript/vfs';
import { codeBlocks, defs } from './fixtures/dsl/load.js';
import { generateBuilderDts } from '../src/dsl/gen-dts.js';
import { createChecker } from '../src/dsl/typecheck.js';
import { normalizeDefs } from '../src/dsl/defs.js';
import { nodeLibFiles } from '../scripts/lib/starters.mjs';
import libFiles from '../src/dsl/ts-lib-files.js';
import builderDtsModule from '../src/dsl/builder-dts.js';
import { EFFECT_REGISTRY, PARAM_DEFS, TUNING_DEFS } from './fixtures/dsl/engine-defs.js';
import { LAYER_DEFS } from '../src/visual/layer-defs.js';

const read = (/** @type {string} */ rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const dts = generateBuilderDts(defs);
const checker = createChecker({ ts, vfs, libFiles, builderDts: dts });

test('generation is deterministic and independent of key order', () => {
  assert.equal(generateBuilderDts(defs), dts);
  const groups = JSON.parse(read('../src/sky/groups.json'));
  const again = normalizeDefs({ paramDefs: PARAM_DEFS, tuningDefs: TUNING_DEFS, effectRegistry: EFFECT_REGISTRY, layerDefs: LAYER_DEFS, groups });
  assert.equal(generateBuilderDts(again), dts);
});

test('builder.d.ts declares no errors of its own', () => {
  assert.deepEqual(checker.diagnostics(''), []);
});

test('the committed builder files are the same text', () => {
  assert.equal(read('../src/dsl/builder.d.ts'), builderDtsModule);
});

test('the bundled library files match the installed TypeScript', () => {
  assert.deepEqual(Object.keys(libFiles), Object.keys(nodeLibFiles()));
  assert.ok('/lib.es2022.d.ts' in libFiles && '/lib.es5.d.ts' in libFiles);
  assert.ok(!Object.keys(libFiles).some((k) => k.includes('dom')), 'no DOM declarations');
});

test('the example in piece-dsl.md yields no diagnostics', () => {
  const blocks = codeBlocks(read('../doc/piece-dsl.md'), 'ts');
  assert.deepEqual(checker.diagnostics(blocks[0]), []);
  const orbit = blocks.find((b) => b.includes("sky.orbit('celestrak.stations:25544', 'sunlit')"));
  assert.deepEqual(checker.diagnostics(/** @type {string} */ (orbit)), []);
});

test('the runnable guide examples yield no diagnostics', () => {
  const dir = new URL('../content/learn/', import.meta.url);
  for (const f of readdirSync(dir)) {
    codeBlocks(readFileSync(new URL(f, dir), 'utf8'), 'ts piece').forEach((b, i) => {
      assert.deepEqual(checker.diagnostics(b), [], `${f} example ${i}`);
    });
  }
});

test('each invalid script yields its expected diagnostic', () => {
  const expected = JSON.parse(read('./fixtures/dsl/types-invalid.json'));
  for (const [file, want] of Object.entries(expected)) {
    const d = checker.diagnostics(read(`./fixtures/dsl/types-invalid/${file}`));
    assert.equal(d.length, 1, `${file}: ${JSON.stringify(d)}`);
    assert.ok(want.codes.includes(d[0].code), `${file}: TS${d[0].code} ${d[0].message}`);
    assert.equal(d[0].line, want.line, file);
  }
});

test('context rules: field and audio outside their positions, fn in a layer', () => {
  const bad = [
    `const a = additive({}); a.attack.follow(field('x'));`,
    `const a = additive({}); a.attack.follow(audio.level(a));`,
    `layer.aurora({ intensity: fn('o => 1') });`,
    `const a = additive({}); sky.group('swpc.kp').voices(a, { pitch: 60, pan: audio.level(a) });`,
  ];
  for (const src of bad) assert.equal(checker.diagnostics(src).length, 1, src);
  const good = [
    `const a = additive({}); a.attack.follow(fn('o => 1'));`,
    `const a = additive({}); layer.points(sky.group('celestrak.stations'), (o) => ({ size: o.meanMotion.add(audio.level(a)), opacity: o.orbit('sunlit') }));`,
    `const a = additive({}); a.attack.follow(sky.value('celestrak.stations:25544', 'meanMotion').map(1, 16, 0.1, 1));`,
  ];
  for (const src of good) assert.deepEqual(checker.diagnostics(src), [], src);
});

test('check() reports type_error warnings with lines', () => {
  const problems = checker.check(`\nadditive({ volum: 1 });`);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].code, 'type_error');
  assert.equal(problems[0].severity, 'warning');
  assert.equal(problems[0].line, 2);
});
