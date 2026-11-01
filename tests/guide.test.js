// Guide consistency (doc/guide.md, Consistency; doc/testing.md, Guide tests).
// Covered elsewhere: type-checking runnable examples (types.test.js), the layer table
// (visual-layer-defs.test.js) and troubleshooting codes (dsl-codes.test.js).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transform } from 'sucrase';
import { PARAM_DEFS } from '../src/audio/synths/param-defs.js';
import { MAX_VOICES_GLOBAL } from '../src/audio/voices.js';
import { EFFECTS } from '../src/audio/fx/effects/registry.js';
import { DEFS } from '../src/dsl/load-defs.js';
import { LIMITS, PROGRAM } from '../src/dsl/limits.js';
import { unitLabel } from '../src/dsl/units.js';
import { buildPiece } from '../src/dsl/run-script.js';
import { loadGuide, readPageSource, renderPage } from '../src/learn/guide.js';

const pages = loadGuide();
const source = (slug) => readPageSource(slug);
const groups = JSON.parse(readFileSync(new URL('../src/sky/groups.json', import.meta.url), 'utf8'));

/** Rows of every Markdown table under `heading` (up to the next heading of the same or higher level). */
function tables(markdown, heading) {
  const lines = markdown.split('\n');
  const start = lines.findIndex((l) => l.trim() === heading);
  assert.ok(start >= 0, `heading ${heading} not found`);
  const depth = heading.match(/^#+/)[0].length;
  const rows = [];
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#+) /);
    if (m && m[1].length <= depth) break;
    if (!lines[i].startsWith('|') || /^\|[\s|:-]+\|$/.test(lines[i])) continue;
    rows.push(lines[i].slice(1, -1).split('|').map((c) => c.trim()));
  }
  return rows;
}
const ticks = (cell) => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
const num = (s) => Number(s.replace(/−/g, '-').replace(/,/g, ''));

/** Option lists, expanding the note-value shorthand "`1/32`–`1/1`, with `d` … or `t` …". */
function options(cell) {
  const m = cell.match(/`(1\/\d+)`–`(1\/\d+)`, with `d`.*`t`/);
  if (!m) return ticks(cell);
  const head = ticks(cell.slice(0, m.index));
  const out = [...head];
  for (let d = Number(m[1].slice(2)); d >= Number(m[2].slice(2)); d /= 2) out.push(`1/${d}`, `1/${d}d`, `1/${d}t`);
  return out;
}

function range(cell) {
  const m = cell.replace(/−/g, '-').replace(/,/g, '').match(/(-?[\d.]+)\s*–\s*(-?[\d.]+)/);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

test('every page has a title and a unique order', () => {
  const orders = pages.map((p) => p.order);
  assert.equal(new Set(orders).size, orders.length, `duplicate order in ${orders}`);
  assert.equal(pages[0].slug, 'index');
  assert.equal(pages[0].order, 0);
});

test('every internal link resolves to a page or a heading anchor', async () => {
  const ids = new Map();
  for (const p of pages) {
    const html = await renderPage(p, source(p.slug));
    ids.set(p.slug, new Set([...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1])));
  }
  const broken = [];
  for (const p of pages) {
    for (const m of source(p.slug).matchAll(/\]\(([^)\s]+)\)/g)) {
      const url = m[1];
      if (/^[a-z]+:/.test(url) || url.startsWith('/')) continue;
      const [slug, anchor] = url.startsWith('#') ? [p.slug, url.slice(1)] : url.split('#');
      if (!ids.has(slug)) broken.push(`${p.slug}: ${url} (no page)`);
      else if (anchor && !ids.get(slug).has(decodeURIComponent(anchor))) broken.push(`${p.slug}: ${url} (no anchor)`);
    }
  }
  assert.deepEqual(broken, []);
});

test('every runnable example builds with zero problems against the real tables', () => {
  const failures = [];
  for (const p of pages) {
    p.examples.forEach((ex, i) => {
      const r = buildPiece(ex.source, DEFS, { transform: (s) => transform(s, { transforms: ['typescript'] }).code });
      if (r.problems.length) failures.push(`${p.slug}/${i}: ${r.problems.map((x) => x.code).join(', ')}`);
    });
  }
  assert.deepEqual(failures, []);
});

test('instrument tables in reference.md match PARAM_DEFS', () => {
  const ref = source('reference');
  for (const [type, defs] of Object.entries(PARAM_DEFS)) {
    const rows = tables(ref, `### \`${type}\``).slice(1);
    const listed = new Map(rows.map((r) => [ticks(r[0])[0], r]));
    assert.deepEqual([...listed.keys()].sort(), defs.map((d) => d.name).sort(), `${type}: parameter names`);
    for (const d of defs) {
      const [, rangeCell, defCell, unitCell] = listed.get(d.name);
      if (d.options) {
        const allowed = type === 'granular' && d.name === 'source' ? d.options.filter((o) => o !== 'sample') : d.options;
        assert.deepEqual(ticks(rangeCell), allowed, `${type}.${d.name} options`);
        assert.deepEqual(ticks(defCell), [d.default], `${type}.${d.name} default`);
      } else if (Array.isArray(d.default)) {
        assert.deepEqual(range(rangeCell), [d.min, d.max], `${type}.${d.name} range`);
        assert.deepEqual(JSON.parse(ticks(defCell)[0]), d.default, `${type}.${d.name} default`);
      } else {
        assert.deepEqual(range(rangeCell), [d.min, d.max], `${type}.${d.name} range`);
        assert.equal(num(defCell), d.default, `${type}.${d.name} default`);
        assert.equal(unitCell, unitLabel(d.unit), `${type}.${d.name} unit`);
      }
    }
  }
});

test('effect table in reference.md matches the effect registry', () => {
  const rows = tables(source('reference'), '## Effects').slice(1);
  const listed = new Map();
  let effect = null;
  for (const r of rows) {
    if (ticks(r[0])[0]) effect = ticks(r[0])[0];
    const param = ticks(r[1])[0];
    if (effect && param) listed.set(`${effect}.${param}`, r);
  }
  const expected = Object.entries(EFFECTS).flatMap(([type, e]) => e.params.map((p) => [`${type}.${p.id}`, p]));
  assert.deepEqual([...listed.keys()].sort(), expected.map(([k]) => k).sort(), 'effect parameter names');
  for (const [key, p] of expected) {
    const [, , rangeCell, defCell] = listed.get(key);
    if (p.options) {
      assert.deepEqual(options(rangeCell), p.options.map(String), `${key} options`);
    } else {
      assert.deepEqual(range(rangeCell), [p.min, p.max], `${key} range`);
      assert.equal(num(defCell), p.default, `${key} default`);
    }
  }
});

test('sky-data.md lists exactly the fields of groups.json', () => {
  const md = source('sky-data');
  const sections = {
    '### Orbits (`celestrak.*`)': 'celestrak.stations',
    '### Close approaches (`jpl.cad`)': 'jpl.cad',
    '### Scout candidates (`jpl.scout`)': 'jpl.scout',
    '### Launches (`ll2.upcoming`)': 'll2.upcoming',
  };
  for (const [heading, group] of Object.entries(sections)) {
    const listed = tables(md, heading).slice(1).flatMap((r) => ticks(r[0]));
    assert.deepEqual(listed.sort(), Object.keys(groups[group].fields).sort(), heading);
  }
  const swpc = tables(md, '### Space weather (`swpc.*`)').slice(1).flatMap((r) => ticks(r[0]));
  const expected = ['kp', 'wind', 'mag'].flatMap((k) => Object.keys(groups[`swpc.${k}`].fields).map((f) => `${k}.${f}`));
  assert.deepEqual(swpc.sort(), expected.sort(), 'space weather paths');
  const groupRows = tables(md, '## Groups').slice(1).map((r) => ticks(r[0])[0]);
  assert.deepEqual(groupRows.sort(), Object.keys(groups).sort(), 'group list');
});

test('limits in reference.md match the validator and engine constants', () => {
  const rows = new Map(tables(source('reference'), '## Limits').slice(1).map((r) => [r[0], r[1]]));
  const expect = {
    Instruments: `${LIMITS.instruments}`,
    'Notes per instrument': `${LIMITS.voicesPerBinding} (granular: ${LIMITS.voicesPerBindingGranular})`,
    'Notes per piece': `${MAX_VOICES_GLOBAL}`,
    'Bindings (voices, triggers, follows)': `${LIMITS.bindings}`,
    'Effects per chain': `${LIMITS.slotsPerChain}`,
    Reverbs: `${LIMITS.reverbs}`,
    LFOs: `${LIMITS.lfos}`,
    'Modulation routes': `${LIMITS.routes}, at most ${LIMITS.routesPerTarget} per parameter`,
    Layers: `${LIMITS.layers}`,
    'Orbit sources (object, quantity, time scale)': `${LIMITS.orbitSources}`,
    'Expression nesting': `${LIMITS.exprDepth} levels`,
    'Script length': `${LIMITS.sourceChars.toLocaleString('en-US')} characters`,
    'Script run time': `${LIMITS.timeoutMs / 1000} s`,
    Handlers: `${LIMITS.handlers}`,
    'Handler run time per round': `${PROGRAM.batchTimeoutMs} ms`,
    'New notes per second from handlers': `${PROGRAM.noteStartsPerSecond}`,
    'Commands per round': `${PROGRAM.commandsPerBatch}`,
    'Waiting after() calls': `${PROGRAM.pendingTimers}`,
    'Harmonics updates per second, per instrument': `${PROGRAM.harmonicsPerSecond}`,
  };
  assert.deepEqual(Object.fromEntries(rows), expect);
});
