// Problem codes: src/dsl/problem-codes.js is the single list; the guide's troubleshooting page
// documents every user-facing code (doc/piece-dsl.md, Problem codes; doc/guide.md, Consistency).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LIMIT_ITEMS, PROBLEM_CODES, problem, userFacingCodes } from '../src/dsl/problem-codes.js';

const guide = readFileSync(new URL('../content/learn/troubleshooting.md', import.meta.url), 'utf8');
const doc = readFileSync(new URL('../doc/piece-dsl.md', import.meta.url), 'utf8');

/** Codes in the first column of the table under `heading`. @param {string} md @param {string} heading */
function tableCodes(md, heading) {
  const from = md.indexOf(heading);
  const to = md.indexOf('\n## ', from + heading.length);
  const section = md.slice(from, to < 0 ? undefined : to);
  return [...section.matchAll(/^\| `([^`]+)`/gm)].map((m) => m[1]);
}

test('troubleshooting.md lists exactly the user-facing codes', () => {
  const listed = tableCodes(guide, '## Problem codes');
  assert.deepEqual([...listed].sort(), userFacingCodes().sort());
});

test('piece-dsl.md lists every code', () => {
  const section = doc.slice(doc.indexOf('### Problem codes'), doc.indexOf('## Versioning'));
  const listed = [...section.matchAll(/^\| `([^`]+)` \| (error|warning) \|/gm)].map((m) => [m[1], m[2]]);
  const expected = Object.entries(PROBLEM_CODES)
    .filter(([c]) => !c.startsWith('limit_'))
    .map(([c, d]) => [c, d.severity]);
  assert.deepEqual([...listed].filter(([c]) => c !== 'limit_<item>').sort(), expected.sort());
  for (const item of LIMIT_ITEMS) assert.match(section, new RegExp(`\`${item}\``), item);
});

test('problem() takes the severity of its code and rejects unknown codes', () => {
  assert.deepEqual(problem('unknown_field', '/x', 'm', 3), { severity: 'warning', code: 'unknown_field', path: '/x', line: 3, message: 'm' });
  assert.throws(() => problem('nope', '', ''), /unknown problem code/);
});
