import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import {
  BLANK_SOURCE, LAST_RUN_PREFIX, checkManifest, createLastRunStore, duplicateName, nameError, needsSeeding, projectRows, seedPayload, uniqueName,
} from '../src/ui/projects.js';

test('the starter manifest is valid', () => {
  const m = checkManifest(JSON.parse(readFileSync(new URL('../content/starters/manifest.json', import.meta.url), 'utf8')));
  assert.ok(m.starters.some((s) => s.slug === 'station-chord'));
  assert.throws(() => checkManifest({ version: 0, starters: [] }), /integer version/);
  assert.throws(() => checkManifest({ version: 1, starters: [{ slug: 'Bad Slug', name: 'x' }] }), /invalid starter/);
});

test('seeding runs while starters_version is below the manifest version', () => {
  assert.equal(needsSeeding(0, 1), true);
  assert.equal(needsSeeding(null, 1), true);
  assert.equal(needsSeeding(1, 1), false);
  assert.equal(needsSeeding(2, 1), false);
});

test('seedPayload keeps slug, name, source and ir', () => {
  assert.deepEqual(seedPayload([{ slug: 'a', name: 'A', source: 's', ir: { groups: [] }, extra: 1 }]), [{ slug: 'a', name: 'A', source: 's', ir: { groups: [] } }]);
});

test('duplicate and new names are unique and bounded', () => {
  assert.equal(duplicateName('Bells', ['Bells']), 'Bells (copy)');
  assert.equal(duplicateName('Bells', ['Bells', 'Bells (copy)']), 'Bells (copy 2)');
  assert.equal(duplicateName('Bells (copy)', ['Bells (copy)']), 'Bells (copy 2)');
  assert.ok(duplicateName('x'.repeat(120), []).length <= 120);
  assert.equal(uniqueName('Untitled', ['Untitled']), 'Untitled 2');
  assert.equal(uniqueName('Untitled', []), 'Untitled');
});

test('nameError', () => {
  assert.equal(nameError('ok'), null);
  assert.match(String(nameError('  ')), /empty/);
  assert.match(String(nameError('x'.repeat(121))), /120/);
});

test('last run is stored per browser', () => {
  const m = new Map();
  const storage = { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) };
  const s = createLastRunStore(storage);
  assert.equal(s.get('p1'), null);
  s.set('p1', 1700000000000);
  assert.equal(s.get('p1'), 1700000000000);
  assert.ok(m.has(`${LAST_RUN_PREFIX}p1`));
  assert.equal(createLastRunStore(null).get('p1'), null);
  const throwing = createLastRunStore({ getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } });
  assert.equal(throwing.get('p1'), null);
  throwing.set('p1', 1);
});

test('projectRows flattens subscriptions', () => {
  assert.deepEqual(projectRows([{ id: 'p', name: 'N', updated_at: 't', project_subscriptions: [{ group_key: 'b' }, { group_key: 'a' }] }]),
    [{ id: 'p', name: 'N', updatedAt: 't', starterSlug: null, groups: ['a', 'b'] }]);
});

test('the blank source is a comment-only script', () => {
  assert.ok(BLANK_SOURCE.split('\n').every((l) => l === '' || l.startsWith('//')));
});
