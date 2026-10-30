import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createFakeSky, skyObj } from './fakes.js';
import { audioDrivenProps, backgroundValue, blocking, computeLayerValues, orbitGroupsOf, orbitSourcesOf, skyDrivenProps, usesAudio } from '../src/ui/ir-helpers.js';

const starter = (slug) => JSON.parse(readFileSync(new URL(`../content/starters/${slug}.ir.json`, import.meta.url), 'utf8'));
const node = (op, ...args) => ({ op, args });

test('orbit sources of the station-chord starter', () => {
  assert.deepEqual(orbitSourcesOf(starter('station-chord')), [{ objectId: null, group: 'celestrak.stations', quantity: 'phaseCos', timeScale: 1 }]);
  assert.deepEqual(orbitGroupsOf(starter('station-chord')), ['celestrak.stations']);
});

test('orbit sources are unique by object, quantity and time scale', () => {
  const ir = starter('station-chord');
  ir.mods = [
    { target: 'f0.mix', source: { expr: node('orbit', 'sunlit', 'celestrak.stations:25544', 1) }, depth: 0.1, smoothMs: 500 },
    { target: 'f0.size', source: { expr: node('orbit', 'sunlit', 'celestrak.stations:25544', 1) }, depth: 0.1, smoothMs: 500 },
    { target: 'f0.decay', source: { expr: node('orbit', 'sunlit', 'celestrak.stations:25544', 10) }, depth: 0.1, smoothMs: 500 },
  ];
  const s = orbitSourcesOf(ir).filter((x) => x.objectId);
  assert.deepEqual(s.map((x) => x.timeScale), [1, 10]);
});

test('sky-driven props are expressions without audio ops', () => {
  const layer = { id: 'l0', type: 'points', group: 'g', props: { size: node('env', 'i0'), color: '#fff', opacity: node('field', 'x'), r: node('map', node('level', 'i0'), 0, 1, 0, 1, 'lin') } };
  assert.deepEqual(skyDrivenProps(layer), ['opacity']);
  assert.equal(usesAudio(layer.props.r), true);
  assert.equal(usesAudio(7), false);
});

test('computeLayerValues maps objects to values and skips nulls', () => {
  const sky = createFakeSky();
  sky.put(skyObj('swpc.kp', 'a', { kp: 3 }));
  sky.put(skyObj('swpc.kp', 'b', { kp: null }));
  const ir = { layers: [
    { id: 'l0', type: 'points', group: 'swpc.kp', props: { size: node('field', 'kp'), color: '#ffffff' } },
    { id: 'l1', type: 'aurora', group: null, props: { intensity: node('num', 0.5) } },
    { id: 'l2', type: 'points', group: 'swpc.kp', props: { color: '#000000' } },
  ] };
  const props = (layer, obj) => Object.fromEntries(Object.keys(layer.props).map((k) => [k, obj ? obj.fields.kp : 0.5]));
  assert.deepEqual(computeLayerValues(ir, sky, props), { l0: { size: { 'swpc.kp:a': 3 } }, l1: { intensity: 0.5 } });
});

test('backgroundValue evaluates an expression background only', () => {
  const props = () => ({ background: '#102030' });
  assert.equal(backgroundValue({ view: { background: '#000000' } }, props), null);
  assert.equal(backgroundValue({ view: { background: node('mix', '#000000', '#ffffff', node('num', 0.5)) } }, props), '#102030');
});

test('blocking is true for errors only', () => {
  assert.equal(blocking([{ severity: 'warning' }]), false);
  assert.equal(blocking([{ severity: 'warning' }, { severity: 'error' }]), true);
});

test('audio-driven props are evaluated separately for frameValues', () => {
  const sky = createFakeSky();
  sky.put(skyObj('celestrak.stations', 'a', {}));
  const layer = { id: 'l0', type: 'points', group: 'celestrak.stations', props: { size: node('map', node('env', 'i0'), 0, 1, 3, 9, 'lin'), color: '#ffffff' } };
  assert.deepEqual(audioDrivenProps(layer), ['size']);
  const ir = { layers: [layer] };
  const props = () => ({ size: 6 });
  assert.deepEqual(computeLayerValues(ir, sky, props), {});
  assert.deepEqual(computeLayerValues(ir, sky, props, audioDrivenProps), { l0: { size: { 'celestrak.stations:a': 6 } } });
});
