import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LAYER_DEFS } from '../src/visual/layer-defs.js';
import { coerceProp, normalizeLayer, diffLayers, PropResolver, ValueGate, usesAudio, canonicalJson } from '../src/visual/layer-state.js';

const P = LAYER_DEFS.points.props;
const env = { op: 'map', args: [{ op: 'env', args: ['i0'] }, 0, 1, 3, 9, 'lin'] };
const kp = { op: 'map', args: [{ op: 'swpc', args: ['kp.kp'] }, 0, 9, 0, 1, 'lin'] };

test('coerceProp clamps numbers and rejects unusable values', () => {
  assert.equal(coerceProp(P.size, 100), 24);
  assert.equal(coerceProp(P.size, 0), 0.5);
  assert.equal(coerceProp(P.size, NaN), undefined);
  assert.equal(coerceProp(P.size, null), undefined);
  assert.equal(coerceProp(P.size, '3'), undefined);
  assert.equal(coerceProp(P.opacity, true), 1);
  assert.equal(coerceProp(P.color, '#ABCDEF'), '#abcdef');
  assert.equal(coerceProp(P.color, 'red'), undefined);
  assert.equal(coerceProp(LAYER_DEFS.glyph.props.char, 'xyz'), 'x');
  assert.equal(coerceProp(LAYER_DEFS.glyph.props.char, '🛰️'), '🛰');
  assert.equal(coerceProp(LAYER_DEFS.glyph.props.char, ' '), undefined);
  assert.equal(coerceProp(LAYER_DEFS.field.props.colormap, 'ice'), 'ice');
  assert.equal(coerceProp(LAYER_DEFS.field.props.colormap, 1.2), 'ember');
  assert.equal(coerceProp(LAYER_DEFS.field.props.colormap, 'fire'), undefined);
});

test('normalizeLayer separates constants and expressions and finds audio ops', () => {
  const l = /** @type {any} */ (normalizeLayer({ id: 'l0', type: 'points', group: 'celestrak.stations', props: { size: env, color: '#F6E05E', opacity: kp, trail: 99999, bogus: 1 } }));
  assert.equal(l.group, 'celestrak.stations');
  assert.deepEqual(l.constants, { color: '#f6e05e', trail: 3600 });
  assert.deepEqual([...l.exprProps].sort(), ['opacity', 'size']);
  assert.deepEqual([...l.audioProps], ['size']);
  assert.equal(usesAudio(kp), false);
  assert.match(String(normalizeLayer({ id: 'l1', type: 'sparkles', props: {} })), /unknown layer type/);
  assert.match(String(normalizeLayer({ id: 'l1', type: 'rings', props: {} })), /no group/);
  assert.match(String(normalizeLayer({ id: 'l1', type: 'shader', group: null, props: {} })), /no glsl/);
  assert.equal(/** @type {any} */ (normalizeLayer({ id: 'l2', type: 'field', group: 'ignored', props: {} })).group, null);
});

test('diffLayers keeps unchanged layers by canonical JSON', () => {
  const a = { id: 'l0', type: 'points', group: 'celestrak.stations', props: { size: 3, color: '#ffffff' } };
  const b = { id: 'l1', type: 'aurora', group: null, props: { intensity: kp } };
  const first = diffLayers(new Map(), [a, b]);
  assert.deepEqual(first.added, ['l0', 'l1']);
  const running = new Map(first.layers.map((l) => [l.id, l]));
  const reordered = { props: { color: '#ffffff', size: 3 }, group: 'celestrak.stations', type: 'points', id: 'l0' };
  const second = diffLayers(running, [reordered, { ...b, props: { intensity: 0.5 } }, { id: 'l2', type: 'field', props: {} }]);
  assert.deepEqual(second.unchanged, ['l0']);
  assert.deepEqual(second.changed, ['l1']);
  assert.deepEqual(second.added, ['l2']);
  assert.equal(second.layers[0], running.get('l0'), 'unchanged layer keeps its state object');
  const third = diffLayers(new Map(second.layers.map((l) => [l.id, l])), [a, a]);
  assert.deepEqual(third.removed, ['l1', 'l2']);
  assert.equal(third.errors[0].message, 'duplicate layer id l0');
  assert.equal(canonicalJson({ b: 1, a: [1, { d: 2, c: 3 }] }), '{"a":[1,{"c":3,"d":2}],"b":1}');
});

test('PropResolver applies per-object values, layer values, constants and defaults', () => {
  const l = /** @type {any} */ (normalizeLayer({ id: 'l0', type: 'points', group: 'g', props: { size: env, color: kp, trail: 600 } }));
  const r = new PropResolver();
  const pushed = { l0: { color: { 'g:1': '#ff0000', 'g:2': 'nope' } } };
  const frame = { l0: { size: { 'g:1': 50 }, opacity: 0.2 } };
  const p1 = r.resolve(l, 'g:1', { frame, pushed });
  assert.deepEqual(p1, { opacity: 1, size: 24, color: '#ff0000', trail: 600 }, 'opacity is not an expression, so the constant default applies');
  const p2 = r.resolve(l, 'g:2', { frame, pushed });
  assert.equal(p2.size, 2, 'missing per-object value uses the default');
  assert.equal(p2.color, '#ffffff', 'invalid value without a previous value uses the default');
  const p1b = r.resolve(l, 'g:1', { frame: {}, pushed: {} });
  assert.equal(p1b.size, 24, 'absent value keeps the previous value');
  assert.equal(p1b.color, '#ff0000');
  const all = r.resolve(l, 'g:3', { pushed: { l0: { color: '#00ff00' } } });
  assert.equal(all.color, '#00ff00', 'a plain value applies to every object');
});

test('reduced motion forces trail to 0 and the flash hold keeps colours', () => {
  const l = /** @type {any} */ (normalizeLayer({ id: 'l0', type: 'points', group: 'g', props: { color: kp, opacity: kp, size: kp, trail: 600 } }));
  const r = new PropResolver();
  r.resolve(l, 'g:1', { pushed: { l0: { color: '#112233', opacity: 0.5, size: 4 } } });
  const held = r.resolve(l, 'g:1', { pushed: { l0: { color: '#ffffff', opacity: 1, size: 8 } }, holdColors: true, reducedMotion: true });
  assert.equal(held.color, '#112233');
  assert.equal(held.opacity, 0.5);
  assert.equal(held.size, 8, 'size is not held');
  assert.equal(held.trail, 0);
  const released = r.resolve(l, 'g:1', { pushed: { l0: { color: '#ffffff' } } });
  assert.equal(released.color, '#ffffff');
  r.forget('l0');
  assert.equal(r.last.size, 0);
});

test('grid cells: a colour list is coerced, pushed from a handler and held by the flash guard', () => {
  const G = LAYER_DEFS.grid.props;
  assert.deepEqual(coerceProp(G.cells, ['#AABBCC', 'red', 7]), ['#aabbcc', null, null]);
  assert.equal(coerceProp(G.cells, '#aabbcc'), undefined);
  assert.equal(coerceProp(G.cells, Array(2000).fill('#000000')).length, 1024);
  assert.deepEqual(coerceProp(G.sizes, [0.5, 2, -1, 'x', NaN]), [0.5, 1, 0, null, null]);
  assert.equal(coerceProp(G.shape, 'circle'), 'circle');
  const l = /** @type {any} */ (normalizeLayer({ id: 'l0', type: 'grid', group: null, props: { cells: ['#111111'] } }));
  assert.deepEqual(l.constants.cells, ['#111111']);
  const r = new PropResolver();
  assert.deepEqual(r.resolve(l, null, {}).cells, ['#111111'], 'the constant until a handler sets it');
  assert.deepEqual(r.resolve(l, null, { pushed: { l0: { cells: ['#222222', '#333333'] } } }).cells, ['#222222', '#333333']);
  r.resolve(l, null, { pushed: { l0: { cells: ['#222222', '#333333'], sizes: [0.5] } } });
  const held = r.resolve(l, null, { pushed: { l0: { cells: ['#ffffff'], background: '#ffffff', sizes: [1] } }, holdColors: true });
  assert.deepEqual(held.cells, ['#222222', '#333333'], 'cells are held while the guard intervenes');
  assert.deepEqual(held.sizes, [0.5], 'and so are sizes');
});

test('forgetObject drops one object in every layer, so the memo does not grow as objects come and go', () => {
  const a = /** @type {any} */ (normalizeLayer({ id: 'l0', type: 'points', group: 'g', props: { size: kp } }));
  const b = /** @type {any} */ (normalizeLayer({ id: 'l1', type: 'points', group: 'g', props: { size: kp } }));
  const r = new PropResolver();
  for (let i = 0; i < 100; i++) {
    const id = `g:${i}`;
    for (const l of [a, b]) r.resolve(l, id, { pushed: { [l.id]: { size: { [id]: 4 } } } });
    if (i > 0) r.forgetObject(`g:${i - 1}`);
  }
  assert.equal(r.last.size, 2, 'only the last object is remembered, once per layer');
  assert.equal(r.byObject.size, 1);
  r.forgetObject('g:unknown');
  r.forget('l0');
  assert.equal(r.last.size, 1);
  assert.equal(r.byObject.get('g:99')?.size, 1, 'forget(layer) also cleans the object index');
  r.resolve(a, null, { pushed: { l0: { size: 3 } } });
  r.forget();
  assert.equal(r.last.size, 0);
  assert.equal(r.byObject.size, 0);
});

test('ValueGate passes changes at most once per second while active', () => {
  const g = new ValueGate(1000);
  assert.equal(g.offer('a', 0, true), 'a');
  assert.equal(g.offer('b', 500, true), 'a');
  assert.equal(g.offer('c', 999, true), 'a');
  assert.equal(g.offer('d', 1000, true), 'd');
  assert.equal(g.offer('e', 1200, false), 'e');
  assert.equal(g.offer('f', 1300, true), 'e');
  assert.equal(g.offer('g', 2200, true), 'g');
});
