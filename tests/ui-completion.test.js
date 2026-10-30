import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFS } from '../src/dsl/load-defs.js';
import { BUILDER_NAMES, completeAt, enclosingOptionsCall } from '../src/ui/completion.js';
import { createBuilder } from '../src/dsl/builder.js';

const labels = (r) => r?.options.map((o) => o.label) ?? null;

test('BUILDER_NAMES are the builder API apart from instruments and effects', () => {
  const api = Object.keys(createBuilder(DEFS, { line: () => null }).api);
  const typed = new Set([...Object.keys(DEFS.instruments), ...Object.keys(DEFS.effects)]);
  assert.deepEqual([...BUILDER_NAMES].sort(), api.filter((n) => !typed.has(n)).sort());
});

test('group keys complete inside sky.group(', () => {
  const text = "sky.group('cel";
  const r = completeAt(text, DEFS);
  assert.equal(r?.from, text.length - 3);
  assert.deepEqual(labels(r), Object.keys(DEFS.groups));
});

test('field names come from the group on the same line', () => {
  const r = completeAt("sky.group('swpc.wind').voices(pad, { pitch: field('sp", DEFS);
  assert.deepEqual(labels(r), Object.keys(DEFS.groups['swpc.wind'].fields));
  const any = completeAt("const x = field('", DEFS);
  assert.ok(labels(any)?.includes('meanMotion'));
});

test('orbit quantities and projections', () => {
  assert.ok(labels(completeAt("orbit('ph", DEFS))?.includes('phaseCos'));
  assert.ok(labels(completeAt("sky.orbit('celestrak.stations:25544', 'su", DEFS))?.includes('sunlit'));
  assert.ok(labels(completeAt("sky.orbit('", DEFS))?.includes('celestrak.stations:'));
  assert.deepEqual(labels(completeAt("view.projection('", DEFS)), ['orbital', 'map', 'sky']);
});

test('members of sky, layer, view and audio', () => {
  assert.deepEqual(labels(completeAt('sky.', DEFS)), ['group', 'swpc', 'value', 'orbit']);
  assert.ok(labels(completeAt('layer.po', DEFS))?.includes('points'));
  assert.deepEqual(labels(completeAt('audio.', DEFS)), ['level', 'spectrum', 'voice']);
  assert.equal(completeAt('foo.', DEFS), null);
});

test('instrument, effect and layer option names inside the options object', () => {
  const inst = completeAt('const pad = additive({ volume: -12, att', DEFS);
  assert.ok(labels(inst)?.includes('attack'));
  assert.ok(labels(inst)?.includes('volume'));
  const fx = completeAt('pad.fx(reverb({ ', DEFS, { explicit: true });
  assert.ok(labels(fx)?.includes('decay'));
  const layer = completeAt("layer.points(sky.group('celestrak.stations'), {\n  si", DEFS);
  assert.deepEqual(labels(layer), DEFS.layers.points.order);
});

test('no option completion at a value position', () => {
  const r = completeAt('additive({ volume: -1', DEFS);
  assert.equal(r, null);
});

test('builder names at an identifier start', () => {
  const r = completeAt('\nsca', DEFS);
  assert.equal(r?.from, 1);
  assert.ok(labels(r)?.includes('scale'));
  assert.ok(labels(r)?.includes('additive'));
  assert.equal(completeAt('\n', DEFS), null, 'not without input unless explicit');
  assert.ok(completeAt('\n', DEFS, { explicit: true }));
});

test('enclosingOptionsCall finds the callee of the open object', () => {
  assert.equal(enclosingOptionsCall('additive({ '), 'additive');
  assert.equal(enclosingOptionsCall("layer.points(g, { size: 3, "), 'layer.points');
  assert.equal(enclosingOptionsCall('const a = { '), null);
  assert.equal(enclosingOptionsCall('additive({ a: 1 }); '), null);
  assert.equal(enclosingOptionsCall('x.voices(pad, { pitch: field("a").map(1, 2), '), 'x.voices');
});
