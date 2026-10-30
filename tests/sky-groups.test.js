import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GROUPS, groupKeys, groupOf, hasOrbit, isGroup, sourceOf } from '../src/sky/groups.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

/** Markdown tables under each heading: [{ heading, header, rows }]. */
function tables(md) {
  const out = [];
  let heading = '';
  const lines = md.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const h = /^#+\s+(.*)$/.exec(lines[i]);
    if (h) heading = h[1];
    if (lines[i].startsWith('|') && lines[i + 1]?.startsWith('|---')) {
      const cells = (l) => l.slice(1, -1).split('|').map((c) => c.trim());
      const header = cells(lines[i]);
      const rows = [];
      for (i += 2; i < lines.length && lines[i].startsWith('|'); i++) rows.push(cells(lines[i]));
      out.push({ heading, header, rows });
    }
  }
  return out;
}
const unquote = (s) => s.replace(/`/g, '');

test('groups.json has the documented shape', () => {
  for (const [key, g] of Object.entries(GROUPS)) {
    assert.deepEqual(Object.keys(g).sort(), ['class', 'fields', 'orbit', 'source'], key);
    assert.ok(['step', 'random-walk'].includes(g.class), key);
    assert.equal(typeof g.orbit, 'boolean');
    assert.equal(g.orbit, key.startsWith('celestrak.'));
    for (const [f, d] of Object.entries(g.fields)) {
      assert.deepEqual(Object.keys(d).sort(), ['type', 'unit'], `${key}.${f}`);
      assert.ok(['number', 'string', 'boolean'].includes(d.type), `${key}.${f}`);
      assert.equal(typeof d.unit, 'string');
    }
  }
});

test('groups and registry ids match the source table in doc/sources.md', () => {
  const src = tables(read('doc/sources.md')).find((t) => t.heading === 'Source table');
  const doc = src.rows.map((r) => [unquote(r[1]), unquote(r[0])]);
  assert.deepEqual(Object.entries(GROUPS).map(([k, g]) => [k, g.source]), doc);
});

test('groups match the harvest registry', () => {
  const reg = JSON.parse(read('supabase/functions/harvest/sources.json'));
  const entries = reg.sources ?? reg;
  assert.deepEqual(entries.map((e) => [e.group, e.id]).sort(), Object.entries(GROUPS).map(([k, g]) => [k, g.source]).sort());
});

test('fields and units match the field tables in doc/sources.md', () => {
  const t = tables(read('doc/sources.md'));
  const orbit = t.find((x) => x.heading === 'CelesTrak' && x.header[0] === 'Field');
  for (const key of groupKeys().filter((k) => k.startsWith('celestrak.'))) {
    assert.deepEqual(Object.entries(GROUPS[key].fields).map(([f, d]) => [f, d.unit]), orbit.rows.map((r) => [unquote(r[0]), r[2]]), key);
  }
  for (const heading of ['NOAA SWPC', 'JPL SSD/CNEOS']) {
    const tab = t.find((x) => x.heading === heading && x.header[0] === 'Group');
    /** @type {Record<string, [string, string][]>} */
    const byGroup = {};
    for (const r of tab.rows) (byGroup[unquote(r[0])] ??= []).push([unquote(r[1]), r[3]]);
    for (const [g, fields] of Object.entries(byGroup)) {
      assert.deepEqual(Object.entries(GROUPS[g].fields).map(([f, d]) => [f, d.unit]), fields, g);
    }
  }
  const ll2 = t.find((x) => x.heading === 'Launch Library 2' && x.header[0] === 'Field');
  assert.deepEqual(Object.keys(GROUPS['ll2.upcoming'].fields), ll2.rows.map((r) => unquote(r[0])));
});

test('every field in content/learn/sky-data.md exists in groups.json', () => {
  const t = tables(read('content/learn/sky-data.md'));
  const groupTable = t.find((x) => x.heading === 'Groups');
  assert.deepEqual(groupTable.rows.map((r) => unquote(r[0])), groupKeys());
  const sections = {
    'Orbits (`celestrak.*`)': groupKeys().filter((k) => k.startsWith('celestrak.')),
    'Close approaches (`jpl.cad`)': ['jpl.cad'],
    'Scout candidates (`jpl.scout`)': ['jpl.scout'],
    'Launches (`ll2.upcoming`)': ['ll2.upcoming'],
  };
  for (const [heading, keys] of Object.entries(sections)) {
    const tab = t.find((x) => x.heading === heading);
    const names = tab.rows.flatMap((r) => r[0].split(',').map((s) => unquote(s.trim())));
    for (const k of keys) for (const n of names) assert.ok(n in GROUPS[k].fields, `${k}.${n}`);
  }
  const swpc = t.find((x) => x.heading === 'Space weather (`swpc.*`)');
  for (const r of swpc.rows) {
    const [g, f] = unquote(r[0]).split('.');
    assert.ok(f in GROUPS[`swpc.${g}`].fields, unquote(r[0]));
  }
});

test('helpers', () => {
  assert.equal(isGroup('swpc.kp'), true);
  assert.equal(isGroup('toString'), false);
  assert.equal(sourceOf('jpl.cad'), 'jpl.cad');
  assert.equal(sourceOf('nope'), null);
  assert.equal(hasOrbit('celestrak.stations'), true);
  assert.equal(hasOrbit('jpl.cad'), false);
  assert.equal(groupOf('celestrak.stations:25544'), 'celestrak.stations');
  assert.equal(groupOf('nocolon'), null);
});
