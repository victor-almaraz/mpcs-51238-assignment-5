import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSprites, buildSegments, objectScreenPosition, maxProp, SPRITE_STRIDE, SEGMENT_STRIDE, OCCLUDED_ALPHA } from '../src/visual/scene.js';
import { normalizeLayer, PropResolver } from '../src/visual/layer-state.js';
import { orbitalCamera } from '../src/visual/projection.js';
import { STRIDE } from '../src/visual/propagation-core.js';
import { EARTH_RADIUS_KM } from '../src/sky/orbit.js';

const DEG = Math.PI / 180;
const view = { width: 800, height: 400 };
const ctx = { simMs: Date.parse('2026-10-29T14:00:00Z'), observer: { lat: 41.79, lon: -87.6 } };

function positionsOf(records) {
  const ids = Object.keys(records);
  const data = new Float32Array(ids.length * STRIDE);
  ids.forEach((id, i) => data.set(records[id], i * STRIDE));
  return { ids, data, index: new Map(ids.map((id, i) => [id, i])) };
}

const iss = { id: 'celestrak.stations:25544', group: 'celestrak.stations', fields: {} };
const pad = { id: 'll2.upcoming:abc', group: 'll2.upcoming', fields: { padLat: 0, padLon: 90 } };
const neo = { id: 'jpl.cad:2026 AB', group: 'jpl.cad', fields: { distLD: 3 } };
const positions = positionsOf({ [iss.id]: [7000, 0, 0, 10 * DEG, -90 * DEG, 420, 0, -0.1] });

test('positions: propagated, launch pad, centre for groups without positions', () => {
  const a = /** @type {any} */ (objectScreenPosition(iss, positions, 'map', view, ctx));
  assert.ok(Math.abs(a.x - 200) < 1e-3 && Math.abs(a.y - (0.5 - 10 / 180) * 400) < 1e-3);
  const b = /** @type {any} */ (objectScreenPosition(pad, positions, 'map', view, ctx));
  assert.ok(Math.abs(b.x - 600) < 1e-3 && Math.abs(b.y - 200) < 1e-3);
  assert.deepEqual(objectScreenPosition(neo, positions, 'map', view, ctx), { x: 400, y: 200, occluded: false });
  assert.deepEqual(objectScreenPosition(neo, positions, 'sky', view, ctx), { x: 400, y: 200, occluded: false });
  assert.equal(objectScreenPosition(iss, positions, 'sky', view, ctx), null, 'below the horizon');
  assert.equal(objectScreenPosition({ ...pad, fields: { padLat: null } }, positions, 'map', view, ctx), null);
  assert.equal(objectScreenPosition({ ...iss, id: 'celestrak.stations:1' }, positions, 'map', view, ctx), null, 'not yet propagated');
});

test('sprites carry resolved properties scaled by the pixel ratio', () => {
  const layer = /** @type {any} */ (normalizeLayer({ id: 'l0', type: 'rings', group: 'jpl.cad', props: { radius: { op: 'field', args: ['distLD'] }, width: 2, color: '#ff8000' } }));
  const r = new PropResolver();
  const pushed = { l0: { radius: { [neo.id]: 30 } } };
  const s = buildSprites({ layer, objects: [neo], positions, projection: 'map', view, ctx, resolve: (id) => r.resolve(layer, id, { pushed }), pixelRatio: 2, nowMs: 0 });
  assert.equal(s.count, 1);
  assert.deepEqual([...s.data.slice(0, SPRITE_STRIDE)].map((v) => Math.round(v * 1000) / 1000), [400, 200, 60, 4, 1, 0.502, 0, 1, 0]);
  assert.deepEqual(s.ids, [neo.id]);
});

test('objects behind Earth draw at a quarter opacity in orbital', () => {
  const cam = orbitalCamera({ width: 800, height: 400, fitRadiusKm: 2 * EARTH_RADIUS_KM, azimuthRad: 0 });
  const behind = positionsOf({ [iss.id]: [-7000, 0, 0, 0, 0, 420, 0, 0] });
  const layer = /** @type {any} */ (normalizeLayer({ id: 'l0', type: 'points', group: 'celestrak.stations', props: { opacity: 0.8 } }));
  const r = new PropResolver();
  const s = buildSprites({ layer, objects: [iss], positions: behind, projection: 'orbital', view: { ...view, cam }, ctx, resolve: (id) => r.resolve(layer, id), pixelRatio: 1, nowMs: 0 });
  assert.ok(Math.abs(s.data[7] - 0.8 * OCCLUDED_ALPHA) < 1e-6);
});

test('glyphs fade after their last event; fade 0 does not fade', () => {
  const mk = (fade) => /** @type {any} */ (normalizeLayer({ id: 'l1', type: 'glyph', group: 'jpl.cad', props: { fade, char: '*' } }));
  const r = new PropResolver();
  const last = new Map([[neo.id, 1000]]);
  const chars = [];
  const build = (fade, nowMs) => buildSprites({ layer: mk(fade), objects: [neo], positions, projection: 'map', view, ctx, resolve: (id) => r.resolve(mk(fade), id), pixelRatio: 1, nowMs, lastEventMs: last, glyphIndex: (c) => { chars.push(c); return 7; } });
  const half = build(10, 6000);
  assert.ok(Math.abs(half.data[7] - 0.5) < 1e-6);
  assert.equal(half.data[8], 7);
  assert.equal(chars[0], '*');
  assert.equal(build(10, 11000).count, 0, 'fully faded glyphs are not drawn');
  assert.equal(build(0, 99000).data[7], 1);
  const reduced = buildSprites({ layer: mk(10), objects: [neo], positions, projection: 'map', view, ctx, resolve: (id) => r.resolve(mk(10), id, { reducedMotion: true }), pixelRatio: 1, nowMs: 99000, lastEventMs: last });
  assert.equal(reduced.data[7], 1, 'reduced motion turns glyph fades off');
});

test('segments break at the antimeridian, respect the window and fade trails', () => {
  // One object, 4 samples 60 s apart from −180 s: longitudes 170°, 178°, −176°, −168°.
  const steps = 4;
  const data = new Float32Array(steps * STRIDE);
  [170, 178, -176, -168].forEach((lon, k) => data.set([7000, 0, 0, 0, lon * DEG, 420, 0, 0.5], k * STRIDE));
  const paths = { ids: [iss.id], steps, stepSec: 60, fromSec: -180, data };
  const base = { paths, objects: [iss], projection: 'map', view, simNowMs: 0, pathSimMs: 0, pixelRatio: 1 };
  const lines = buildSegments({ ...base, window: () => ({ fromSec: -1000, toSec: 1000, color: '#00ff00', opacity: 1 }) });
  assert.equal(lines.count, 2, 'the segment across ±180° is dropped');
  assert.equal(lines.data.length, 2 * SEGMENT_STRIDE);
  const trail = buildSegments({ ...base, window: () => ({ fromSec: -120, toSec: 0, color: '#ffffff', opacity: 1, fadeSec: 120 }), head: () => ({ x: 30, y: 200, occluded: false }) });
  // In the window: samples at −120 s (178°), −60 s (−176°) and 0 s (−168°). The first pair crosses ±180° and is
  // dropped; the pair −60 s → 0 s has mean age 30 s (alpha 0.75); the head segment from 0 s has age 0 (alpha 1).
  assert.equal(trail.count, 2);
  assert.ok(Math.abs(trail.data[8] - 0.75) < 1e-6, `alpha ${trail.data[8]}`);
  assert.ok(Math.abs(trail.data[SEGMENT_STRIDE + 8] - 1) < 1e-6);
  assert.equal(buildSegments({ ...base, paths: null, window: () => null }).count, 0);
});

test('maxProp rounds the largest value up, so path requests change rarely', () => {
  const vals = { a: 125, b: 30 };
  assert.equal(maxProp([{ id: 'a' }, { id: 'b' }], (id) => ({ trail: vals[id] }), 'trail', 60), 180);
  assert.equal(maxProp([], () => ({}), 'trail', 60), 0);
});
