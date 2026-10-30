// Starter projects (doc/ui.md, Starter projects; doc/testing.md, Starter tests): every manifest
// slug has a script that builds with no problems, type-checks with no diagnostics, and matches
// its committed .ir.json.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defs } from './fixtures/dsl/load.js';
import { buildStarters } from '../scripts/lib/starters.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const result = buildStarters(root, defs);

test('the manifest lists starters with unique slugs and names', () => {
  assert.ok(result.version >= 1);
  assert.ok(result.starters.length > 0);
  assert.equal(new Set(result.starters.map((s) => s.slug)).size, result.starters.length);
});

for (const s of result.starters) {
  test(`starter ${s.slug} builds with no errors, warnings or type diagnostics`, () => {
    assert.deepEqual(s.problems, []);
    assert.ok(s.ir);
  });

  test(`starter ${s.slug} opens with comments naming its guide pages`, () => {
    const head = s.source.split('\n').filter((l) => l.startsWith('//'));
    assert.ok(head.length >= 2);
    assert.ok(head.some((l) => /\/learn\//.test(l)));
  });

  test(`starter ${s.slug}.ir.json matches the compiled IR`, () => {
    const file = new URL(`../content/starters/${s.slug}.ir.json`, import.meta.url);
    assert.ok(existsSync(file), `${s.slug}.ir.json missing; run node scripts/build-starters.mjs`);
    assert.equal(readFileSync(file, 'utf8'), s.text);
  });
}
