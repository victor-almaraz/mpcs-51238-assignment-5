import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LAYER_DEFS, LAYER_TYPES } from '../src/visual/layer-defs.js';

/** Rows of the first Markdown table after `heading` whose header starts with `firstCol`. */
function table(md, firstCol) {
  const lines = md.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`| ${firstCol} |`));
  assert.ok(start >= 0, `table starting with ${firstCol} not found`);
  const rows = [];
  for (let i = start + 2; i < lines.length && lines[i].startsWith('|'); i++) {
    rows.push(lines[i].slice(1, -1).split('|').map((c) => c.trim()));
  }
  return rows;
}

const strip = (s) => s.replace(/`/g, '').trim();
const num = (s) => Number(s.replace('−', '-'));

/** Expected property list from the doc tables: { type: { prop: { range, default } } }. */
function fromDocTable(rows, { layerCol, propCol, rangeCol, defaultCol }) {
  const out = {};
  let layer = '';
  for (const r of rows) {
    if (strip(r[layerCol])) layer = strip(r[layerCol]);
    const t = layer === 'all' || layer === 'every layer' ? '*' : layer;
    (out[t] ??= {})[strip(r[propCol])] = { range: strip(r[rangeCol]), def: strip(r[defaultCol]) };
  }
  return out;
}

function checkAgainst(expected) {
  const common = expected['*'];
  assert.deepEqual(Object.keys(common), ['opacity']);
  for (const type of LAYER_TYPES) {
    const want = { ...common, ...(expected[type] ?? {}) };
    assert.deepEqual(Object.keys(LAYER_DEFS[type].props).sort(), Object.keys(want).sort(), `props of ${type}`);
    for (const [name, w] of Object.entries(want)) {
      const d = LAYER_DEFS[type].props[name];
      assert.equal(Array.isArray(d.default) ? JSON.stringify(d.default) : String(d.default), w.def, `${type}.${name} default`);
      if (d.type === 'number') {
        const m = /^([\d.−-]+)–([\d.−-]+)/.exec(w.range);
        assert.ok(m, `${type}.${name} range ${w.range}`);
        assert.equal(d.min, num(m[1]), `${type}.${name} min`);
        assert.equal(d.max, num(m[2]), `${type}.${name} max`);
      } else if (d.type === 'enum') {
        assert.deepEqual(d.options, w.range.split(',').map((s) => s.trim()), `${type}.${name} options`);
      }
    }
  }
  for (const t of Object.keys(expected)) if (t !== '*') assert.ok(LAYER_DEFS[t], `doc layer ${t} exists`);
}

test('LAYER_DEFS matches the property table in doc/visuals.md', () => {
  const md = readFileSync(new URL('../doc/visuals.md', import.meta.url), 'utf8');
  const rows = table(md, 'Layer').filter((r) => r.length === 5);
  checkAgainst(fromDocTable(rows, { layerCol: 0, propCol: 1, rangeCol: 3, defaultCol: 4 }));
});

test('LAYER_DEFS matches the property table in content/learn/reference.md', () => {
  const md = readFileSync(new URL('../content/learn/reference.md', import.meta.url), 'utf8');
  const rows = table(md, 'Layer').filter((r) => r.length === 4);
  checkAgainst(fromDocTable(rows, { layerCol: 0, propCol: 1, rangeCol: 2, defaultCol: 3 }));
});

test('every layer type has a valid shape and frozen definitions', () => {
  for (const [type, def] of Object.entries(LAYER_DEFS)) {
    assert.equal(typeof def.group, 'boolean', type);
    assert.equal(typeof def.localOnly, 'boolean', type);
    assert.ok(Object.isFrozen(def.props), type);
    for (const [name, p] of Object.entries(def.props)) {
      assert.ok(['number', 'color', 'char', 'enum', 'colors'].includes(p.type), `${type}.${name}`);
      if (p.type === 'number') assert.ok(p.min <= p.default && p.default <= p.max, `${type}.${name} default in range`);
      if (p.type === 'color') assert.match(p.default, /^#[0-9a-f]{6}$/);
      if (p.type === 'enum') assert.ok(p.options.includes(p.default));
      if (p.type === 'char') assert.equal([...p.default].length, 1);
      if (p.type === 'colors') assert.ok(Array.isArray(p.default) && p.max > 0, `${type}.${name} list`);
    }
  }
  assert.deepEqual(LAYER_TYPES.filter((t) => LAYER_DEFS[t].group), ['points', 'rings', 'lines', 'glyph']);
  assert.deepEqual(LAYER_TYPES.filter((t) => LAYER_DEFS[t].localOnly), ['shader']);
});

test('reduced motion forces trail, fade and drift to 0', () => {
  const forced = [];
  for (const [type, def] of Object.entries(LAYER_DEFS)) {
    for (const [name, p] of Object.entries(def.props)) if (p.reducedMotion !== undefined) forced.push(`${type}.${name}=${p.reducedMotion}`);
  }
  assert.deepEqual(forced.sort(), ['aurora.drift=0', 'glyph.fade=0', 'points.trail=0']);
});
