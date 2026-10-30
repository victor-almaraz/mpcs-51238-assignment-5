import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { normalizers, NormalizeError } from '../../supabase/functions/harvest/normalizers/index.js';
import { fixture } from './fakes.js';

const sources = JSON.parse(readFileSync(new URL('../../supabase/functions/harvest/sources.json', import.meta.url), 'utf8'));
const entryFor = (file) => {
  const prefix = file.replace(/-(\d|nul|9999|inactive-first|empty|version)\.json$/, '');
  const e = sources.find((s) => s.id.replace('.', '-') === prefix);
  assert.ok(e, `no registry entry for ${file}`);
  return e;
};
const run = (file, e = entryFor(file), warnings = []) =>
  normalizers[e.normalizer](fixture(file), e.normalizerArgs, { source: e.id, group: e.group, warn: (w) => warnings.push(w) });

for (const file of readdirSync(new URL('./expected/', import.meta.url))) {
  test(`normalizer output for ${file} matches expected`, () => {
    const expected = JSON.parse(readFileSync(new URL(`./expected/${file}`, import.meta.url), 'utf8'));
    assert.deepEqual(run(file), expected);
  });
}

test('every field is a finite number, string, boolean or null', () => {
  for (const file of readdirSync(new URL('./expected/', import.meta.url))) {
    for (const o of run(file)) {
      for (const [k, v] of Object.entries(o.fields)) {
        assert.ok(v === null || typeof v === 'string' || typeof v === 'boolean' || Number.isFinite(v), `${file} ${o.id}.${k}`);
      }
    }
  }
});

test('CelesTrak ids are group:noradId with six-digit catalog numbers as text', () => {
  const out = run('celestrak-stations-1.json');
  assert.ok(out.some((o) => o.id === 'celestrak.stations:25544'));
  assert.ok(out.some((o) => o.fields.noradId.length === 6));
});

test('CelesTrak text bodies are rejected', () => {
  const e = sources.find((s) => s.id === 'celestrak.stations');
  for (const file of ['celestrak-no-data.txt', 'celestrak-403.txt']) {
    assert.throws(() => normalizers.celestrakOmm(fixture(file), {}, { source: e.id, group: e.group, warn() {} }), NormalizeError);
  }
});

test('RTSW skips the inactive newest row and records the spacecraft', () => {
  const [o] = run('swpc-wind-inactive-first.json');
  assert.equal(o.id, 'swpc.wind:l1');
  assert.equal(o.fields.spacecraft, 'SOLAR1');
});

test('RTSW maps -9999 and null to null; mag file contains real sentinels', () => {
  assert.equal(run('swpc-wind-9999.json')[0].fields.speed, null);
  assert.match(fixture('swpc-mag-1.json'), /-9999/);
});

test('trailing NUL bytes are stripped', () => {
  assert.deepEqual(run('swpc-wind-nul.json'), run('swpc-wind-inactive-first.json'));
});

test('CAD version mismatch warns and still normalizes', () => {
  const warnings = [];
  const out = run('jpl-cad-version.json', entryFor('jpl-cad-1.json'), warnings);
  assert.equal(out.length, 8);
  assert.deepEqual(warnings, [{ event: 'version_mismatch', expected: '1.5', got: '1.6' }]);
});

test('CAD with count 0 is an empty result', () => {
  assert.deepEqual(run('jpl-cad-empty.json', entryFor('jpl-cad-1.json')), []);
});

test('CAD missing a field fails', () => {
  const e = entryFor('jpl-cad-1.json');
  const doc = JSON.parse(fixture('jpl-cad-1.json'));
  doc.fields = doc.fields.filter((f) => f !== 'v_inf');
  assert.throws(() => normalizers.jplCad(JSON.stringify(doc), e.normalizerArgs, { source: e.id, group: e.group, warn() {} }), /v_inf/);
});

test('Scout runs that differ only in tEphem normalize identically', () => {
  assert.deepEqual(run('jpl-scout-1.json'), run('jpl-scout-2.json'));
});
