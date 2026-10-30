// Definition tables (doc/piece-dsl.md, Definition tables): normalization of the engine, layer and
// group tables, and the shapes the adapters accept.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defs } from './fixtures/dsl/load.js';
import { normalizeDefs } from '../src/dsl/defs.js';

const base = { paramDefs: { fm: [] }, effectRegistry: {}, layerDefs: {}, groups: {} };

test('fixture tables normalize', () => {
  assert.deepEqual(Object.keys(defs.instruments), ['subtractive', 'fm', 'additive', 'pluck', 'granular']);
  assert.deepEqual(Object.keys(defs.effects), ['eq3', 'filter', 'compressor', 'saturation', 'distortion', 'delay', 'reverb']);
  assert.equal(defs.instruments.additive.params.harmonics.kind, 'array');
  assert.equal(defs.instruments.subtractive.params.waveform.kind, 'enum');
  assert.equal(defs.effects.compressor.params.makeup.dir, 'down');
  assert.equal(defs.effects.filter.params.mode.modulatable, false);
  assert.equal(defs.effects.filter.params.mode.default, 'lowpass');
  assert.ok(defs.syncNames.includes('1/4d') && !defs.syncNames.includes('off'));
  assert.equal(defs.layers.glyph.props.char.maxLength, 1);
  assert.ok(!('shader' in defs.layers));
  assert.ok('opacity' in defs.shaderProps);
  assert.equal(defs.groups['celestrak.stations'].orbit, true);
  assert.equal(defs.groups['jpl.cad'].orbit, false);
  assert.ok(defs.sources.includes('swpc.wind'));
  assert.deepEqual(defs.tuning.octave, { min: -3, max: 3, default: 0 });
});

test('normalized tables survive structured cloning', () => {
  assert.deepEqual(structuredClone(defs), defs);
});

test('synth ParamDefs without mod are not modulatable; effect ParamDefs are unless mod is null', () => {
  const d = normalizeDefs({
    ...base,
    paramDefs: { fm: [{ name: 'a', min: 0, max: 1, default: 0 }, { name: 'b', min: 0, max: 1, default: 0, mod: { rate: 'control' } }] },
    effectRegistry: { x: [{ id: 'c', min: 0, max: 1, default: 0 }, { id: 'd', min: 0, max: 1, default: 0, mod: null }] },
  });
  assert.equal(d.instruments.fm.params.a.modulatable, false);
  assert.equal(d.instruments.fm.params.b.modulatable, true);
  assert.equal(d.effects.x.params.c.modulatable, true);
  assert.equal(d.effects.x.params.d.modulatable, false);
});

test('layer shapes: an `all` entry, inferred types and group flags', () => {
  const d = normalizeDefs({
    ...base,
    layerDefs: {
      all: { props: { opacity: { min: 0, max: 1, default: 1 } } },
      points: { props: { color: { default: '#ffffff' } } },
      aurora: { props: { mode: { options: ['a', 'b'], default: 'a' } } },
    },
  });
  assert.deepEqual(Object.keys(d.layers.points.props), ['opacity', 'color']);
  assert.equal(d.layers.points.props.color.type, 'color');
  assert.equal(d.layers.points.group, true);
  assert.equal(d.layers.aurora.group, false);
  assert.equal(d.layers.aurora.props.mode.type, 'enum');
});

test('invalid tables fail with a message naming the entry', () => {
  assert.throws(() => normalizeDefs({ ...base, paramDefs: { fm: [{ name: 'a', min: 1, max: 0, default: 0 }] } }), /PARAM_DEFS\.fm\.a/);
  assert.throws(() => normalizeDefs({ ...base, groups: { g: { fields: { f: { type: 'date' } } } } }), /groups\.json g\.f/);
  assert.throws(() => normalizeDefs({ ...base, effectRegistry: { x: {} } }), /effect registry x/);
});
