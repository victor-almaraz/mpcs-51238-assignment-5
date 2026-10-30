import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, collectDeps, sourceClass, quantize, rand01 } from '../src/expr/index.js';

const f = (name) => ({ op: 'field', args: [name] });
const node = (op, ...args) => ({ op, args });
const obj = (fields, id = 'jpl.cad:1') => ({ id, source: 'jpl.cad', group: 'jpl.cad', fields });
const o = obj({ a: 2, b: 0, s: 'In Flight', t: true, u: false, nan: NaN, inf: Infinity, nul: null });

test('literals: numbers, strings, booleans pass; non-finite becomes null', () => {
  assert.equal(evaluate(64, null), 64);
  assert.equal(evaluate('x', null), 'x');
  assert.equal(evaluate(true, null), true);
  assert.equal(evaluate(null, null), null);
  assert.equal(evaluate(NaN, null), null);
  assert.equal(evaluate(Infinity, null), null);
  assert.equal(evaluate(node('num', 3), null), 3);
  assert.equal(evaluate(node('num', -Infinity), null), null);
});

test('field: present, absent, null, non-finite, no current object', () => {
  assert.equal(evaluate(f('a'), o), 2);
  assert.equal(evaluate(f('s'), o), 'In Flight');
  assert.equal(evaluate(f('missing'), o), null);
  assert.equal(evaluate(f('nul'), o), null);
  assert.equal(evaluate(f('nan'), o), null);
  assert.equal(evaluate(f('inf'), o), null);
  assert.equal(evaluate(f('a'), null), null);
});

test('arithmetic on numbers, null and non-finite input', () => {
  const cases = [
    ['add', 2, 3, 5], ['sub', 2, 3, -1], ['mul', 2, 3, 6], ['div', 3, 2, 1.5],
  ];
  for (const [op, x, y, want] of cases) {
    assert.equal(evaluate(node(op, x, y), o), want, op);
    assert.equal(evaluate(node(op, f('nul'), y), o), null, `${op} null left`);
    assert.equal(evaluate(node(op, x, f('missing')), o), null, `${op} null right`);
    assert.equal(evaluate(node(op, f('nan'), y), o), null, `${op} NaN`);
    assert.equal(evaluate(node(op, f('s'), y), o), null, `${op} string`);
  }
  assert.equal(evaluate(node('div', f('a'), f('b')), o), null, 'division by zero');
  assert.equal(evaluate(node('mul', 1e308, 10), o), null, 'overflow');
  assert.equal(evaluate(node('add', f('a'), node('mul', f('a'), 10)), o), 22, 'nested');
  for (const [op, x, want] of [['abs', -2.5, 2.5], ['neg', 2, -2], ['round', 2.5, 3], ['round', -2.4, -2]]) {
    assert.equal(evaluate(node(op, x), o), want, op);
    assert.equal(evaluate(node(op, f('nul')), o), null, `${op} null`);
    assert.equal(evaluate(node(op, f('inf')), o), null, `${op} Infinity`);
  }
});

test('comparison and logic', () => {
  assert.equal(evaluate(node('eq', f('s'), 'In Flight'), o), true);
  assert.equal(evaluate(node('eq', f('a'), 3), o), false);
  assert.equal(evaluate(node('eq', f('nul'), 3), o), null);
  assert.equal(evaluate(node('gt', f('a'), 1), o), true);
  assert.equal(evaluate(node('lt', f('a'), 1), o), false);
  assert.equal(evaluate(node('gt', f('s'), 1), o), null);
  assert.equal(evaluate(node('lt', f('nan'), 1), o), null);
  assert.equal(evaluate(node('and', f('t'), f('u')), o), false);
  assert.equal(evaluate(node('or', f('t'), f('u')), o), true);
  assert.equal(evaluate(node('not', f('u')), o), true);
  assert.equal(evaluate(node('and', f('t'), f('nul')), o), null);
  assert.equal(evaluate(node('or', f('a'), f('t')), o), null, 'number is not boolean');
  assert.equal(evaluate(node('not', f('missing')), o), null);
});

test('map: lin, log, exp, clamped to output range, reversed ranges', () => {
  const m = (x, ...r) => evaluate(node('map', x, ...r), o);
  assert.equal(m(17.5, 5, 30, 36, 60, 'lin'), 48);
  assert.equal(m(17.5, 5, 30, 36, 60), 48, 'lin is the default');
  assert.equal(m(0, 5, 30, 36, 60, 'lin'), 36, 'clamped low');
  assert.equal(m(99, 5, 30, 36, 60, 'lin'), 60, 'clamped high');
  assert.equal(m(0.5, 0.5, 10, 100, 20, 'lin'), 100, 'reversed output');
  assert.equal(m(10, 0.5, 10, 100, 20, 'lin'), 20);
  assert.ok(Math.abs(m(550, 300, 800, 300, 4000, 'log') - 300 * Math.sqrt(4000 / 300)) < 1e-9);
  assert.equal(m(300, 300, 800, 300, 4000, 'log'), 300);
  assert.equal(m(1, 0, 1, -1, 1, 'log'), null, 'log needs one-signed output');
  assert.ok(Math.abs(m(10, 1, 100, 0, 1, 'exp') - 0.5) < 1e-12);
  assert.equal(m(10, 0, 100, 0, 1, 'exp'), null, 'exp needs one-signed input');
  assert.equal(m(1, 2, 2, 0, 1, 'lin'), null, 'empty input range');
  assert.equal(m(f('nul'), 0, 1, 0, 1, 'lin'), null);
  assert.equal(m(f('inf'), 0, 1, 0, 1, 'lin'), null);
  assert.throws(() => m(1, 0, 1, 0, 1, 'cubic'), /Unknown map curve/);
});

test('clamp', () => {
  assert.equal(evaluate(node('clamp', 5, 0, 1), o), 1);
  assert.equal(evaluate(node('clamp', -5, 0, 1), o), 0);
  assert.equal(evaluate(node('clamp', 0.5, 0, 1), o), 0.5);
  assert.equal(evaluate(node('clamp', f('nul'), 0, 1), o), null);
  assert.equal(evaluate(node('clamp', f('nan'), 0, 1), o), null);
});

test('octaveInto: result lies in [lo, hi) and is a MIDI pitch', () => {
  const oi = (x, lo, hi) => evaluate(node('octaveInto', x, lo, hi), o);
  assert.equal(oi(440, 110, 440), 57, '440 Hz lands on 220 Hz (A3)');
  assert.equal(oi(110, 110, 440), 45, 'low bound is inclusive');
  assert.ok(Math.abs(oi(15.5, 110, 440) - (69 + 12 * Math.log2(124 / 440))) < 1e-9, '15.5 → 124 Hz');
  for (const x of [0.001, 0.7, 3, 15.49, 100, 1000, 1e6]) {
    const p = oi(x, 110, 440);
    const hz = 440 * 2 ** ((p - 69) / 12);
    assert.ok(hz >= 110 - 1e-6 && hz < 440, `${x} → ${hz}`);
  }
  assert.equal(oi(0, 110, 440), null, 'zero');
  assert.equal(oi(-5, 110, 440), null, 'negative');
  assert.equal(oi(f('nul'), 110, 440), null, 'null');
  assert.equal(oi(f('inf'), 110, 440), null, 'Infinity');
  assert.equal(oi(200, 110, 150), null, 'no octave of 200 Hz lies in [110, 150)');
  assert.ok(oi(130, 110, 150) !== null);
});

test('quantize per mode', () => {
  assert.equal(quantize(60.4), 60, 'default C chromatic rounds');
  assert.equal(quantize(60.5), 61, 'tie goes up');
  assert.equal(quantize(61, { root: 'C', mode: 'major' }), 62, 'C# → D on a tie');
  assert.equal(quantize(61.2, { root: 'C', mode: 'major' }), 62);
  assert.equal(quantize(60.9, { root: 'C', mode: 'major' }), 60);
  assert.equal(quantize(66, { root: 'D', mode: 'lydian' }), 66, 'F# in D lydian');
  assert.equal(quantize(68, { root: 'D', mode: 'lydian' }), 68, 'G# in D lydian');
  assert.equal(quantize(67.4, { root: 'D', mode: 'lydian' }), 68, 'G is not in D lydian');
  assert.equal(quantize(63, { root: 'C', mode: 'minor' }), 63, 'Eb in C minor');
  assert.equal(quantize(64.4, { root: 'C', mode: 'minor' }), 65);
  assert.equal(quantize(66, { root: 'C', mode: 'pentatonic' }), 67, 'F# → G in C pentatonic');
  assert.equal(quantize(65.4, { root: 'C', mode: 'pentatonic' }), 64);
  assert.equal(quantize(59.6, { root: 'F#', mode: 'major' }), 59, 'B in F# major');
  assert.equal(quantize(58, { root: 'Bb', mode: 'major' }), 58, 'Bb root');
  for (const mode of ['major', 'minor', 'dorian', 'phrygian', 'lydian', 'mixolydian', 'locrian', 'pentatonic', 'chromatic']) {
    for (let p = 20; p < 100; p += 0.37) {
      const q = quantize(p, { root: 'E', mode });
      assert.ok(Number.isInteger(q) && Math.abs(q - p) <= 2, `${mode} ${p} → ${q}`);
    }
  }
  const ctx = { scale: { root: 'D', mode: 'lydian' } };
  assert.equal(evaluate(node('quantize', 67.4), o, ctx), 68);
  assert.equal(evaluate(node('quantize', f('nul')), o, ctx), null);
  assert.throws(() => quantize(60, { root: 'H', mode: 'major' }), /Unknown scale root/);
});

test('rand is deterministic per seed, binding and object, and lies in [lo, hi)', () => {
  const r = node('rand', 72, 84);
  const a1 = evaluate(r, obj({}, 'jpl.scout:A'), { seed: 7, bindingId: 'b1' });
  const a2 = evaluate(r, obj({}, 'jpl.scout:A'), { seed: 7, bindingId: 'b1' });
  assert.equal(a1, a2);
  const others = [
    evaluate(r, obj({}, 'jpl.scout:B'), { seed: 7, bindingId: 'b1' }),
    evaluate(r, obj({}, 'jpl.scout:A'), { seed: 8, bindingId: 'b1' }),
    evaluate(r, obj({}, 'jpl.scout:A'), { seed: 7, bindingId: 'b2' }),
  ];
  for (const x of others) assert.notEqual(x, a1);
  for (let i = 0; i < 500; i++) {
    const u = rand01(1, 'b0', `g:${i}`);
    assert.ok(u >= 0 && u < 1);
    const v = evaluate(r, obj({}, `g:${i}`), { seed: 1, bindingId: 'b0' });
    assert.ok(v >= 72 && v < 84);
  }
  assert.equal(evaluate(node('rand', f('nul'), 1), o, { seed: 1 }), null);
});

test('sky sources call the context and sanitize results', () => {
  const ctx = {
    swpc: (p) => ({ 'kp.kp': 5, 'wind.speed': NaN })[p] ?? null,
    value: (id, fld) => (id === 'celestrak.stations:25544' && fld === 'inclination' ? 51.6 : null),
    count: (g) => (g === 'jpl.scout' ? 3 : 0),
    mean: () => 2.5,
    spread: () => Infinity,
    orbit: (id, q, ts) => (q === 'phaseCos' ? (id === o.id ? 0.5 : -0.5) * ts : null),
    level: () => 0.25,
    spectrum: (inst, bands) => new Array(bands).fill(0.1),
    env: (inst, id) => (id ? 0.75 : null),
    local: () => 9,
  };
  assert.equal(evaluate(node('swpc', 'kp.kp'), null, ctx), 5);
  assert.equal(evaluate(node('swpc', 'wind.speed'), null, ctx), null);
  assert.equal(evaluate(node('value', 'celestrak.stations:25544', 'inclination'), null, ctx), 51.6);
  assert.equal(evaluate(node('count', 'jpl.scout'), null, ctx), 3);
  assert.equal(evaluate(node('mean', 'jpl.cad', 'distLD'), null, ctx), 2.5);
  assert.equal(evaluate(node('spread', 'jpl.cad', 'distLD'), null, ctx), null);
  assert.equal(evaluate(node('orbit', 'phaseCos', null, 1), o, ctx), 0.5);
  assert.equal(evaluate(node('orbit', 'phaseCos', null, 1), null, ctx), null, 'no current object');
  assert.equal(evaluate(node('orbit', 'phaseCos', 'celestrak.stations:1', 2), null, ctx), -1);
  assert.equal(evaluate(node('level', 'i0'), null, ctx), 0.25);
  assert.deepEqual(evaluate(node('spectrum', 'i0', 4), null, ctx), [0.1, 0.1, 0.1, 0.1]);
  assert.equal(evaluate(node('env', 'i0'), o, ctx), 0.75);
  assert.equal(evaluate(node('local', 'o => 9'), o, ctx), 9);
  assert.equal(evaluate(node('swpc', 'kp.kp'), null, {}), null, 'missing resolver');
});

test('unknown op throws', () => {
  assert.throws(() => evaluate(node('sqrt', 4), null), /Unknown expression op "sqrt"/);
});

test('collectDeps and sourceClass', () => {
  const e = node('add', node('swpc', 'wind.speed'), node('count', 'jpl.scout'));
  const d = collectDeps(e);
  assert.deepEqual([...d.groups].sort(), ['jpl.scout', 'swpc.wind']);
  assert.equal(d.current, false);
  assert.equal(sourceClass(d), 'random-walk');
  const d2 = collectDeps(node('map', node('orbit', 'latitude', null, 10), -1, 1, 0, 1, 'lin'));
  assert.equal(d2.orbit, true);
  assert.equal(d2.current, true);
  assert.equal(d2.timeScale, 10);
  assert.equal(sourceClass(d2), 'vlfo');
  assert.equal(sourceClass(collectDeps(node('value', 'jpl.cad:x', 'distLD'))), 'step');
  assert.deepEqual([...collectDeps(node('value', 'jpl.cad:2026 AB:2026-Oct-31', 'h')).groups], ['jpl.cad']);
});

test('color and mix for layer properties', () => {
  assert.equal(evaluate(node('color', '#F6E05E'), null), '#f6e05e');
  assert.equal(evaluate(node('color', '#abc'), null), '#aabbcc');
  assert.equal(evaluate(node('color', 'red'), null), null);
  const m = (t) => evaluate(node('mix', node('color', '#000000'), '#ffffff', t), o);
  assert.equal(m(0), '#000000');
  assert.equal(m(1), '#ffffff');
  assert.equal(m(0.5), '#808080');
  assert.equal(m(7), '#ffffff', 't clamps to 0–1');
  assert.equal(m(f('nul')), null);
  assert.equal(evaluate(node('mix', '#000000', f('nul'), 0.5), o), null);
});
