// Program VM (doc/piece-dsl.md, Program and VM): a built program driven by start and batch
// messages, as the sandbox worker drives it. Scripts here are plain JavaScript.

import test from 'node:test';
import assert from 'node:assert/strict';
import { build, codes } from './fixtures/dsl/load.js';
import { createRunner, syncMs } from '../src/dsl/program.js';

/** Builds `source` and returns its runner. */
function vm(source) {
  const r = build(source);
  assert.deepEqual(r.problems.filter((p) => p.severity === 'error'), [], JSON.stringify(r.problems));
  return { ir: r.ir, runner: createRunner(r.program) };
}

const scout = (n, fields = {}) => ({ id: `jpl.scout:${n}`, group: 'jpl.scout', fields: { objectName: n, neoScore: 50, ...fields } });
const enter = (obj, traceId = `t-${obj.id}`) => ({ kind: 'enter', obj, traceId });
const ops = (r) => r.commands.map((c) => c.op);

test('the IR records handlers and their groups; functions stay in the VM', () => {
  const { ir } = vm(`
    const bell = fm({});
    on('jpl.scout', 'enter', () => {});
    every('1/8', () => {});
    every(500, () => {});
    after(1000, () => {});
    onFreshness('*', () => {});
    follow('swpc.kp');
  `);
  assert.deepEqual(ir.program, {
    handlers: [
      { id: 'h0', kind: 'on', group: 'jpl.scout', event: 'enter' },
      { id: 'h1', kind: 'every', sync: '1/8' },
      { id: 'h2', kind: 'every', intervalMs: 500 },
      { id: 'h3', kind: 'after', ms: 1000 },
      { id: 'h4', kind: 'freshness', source: '*' },
    ],
    follow: ['swpc.kp'],
  });
  assert.deepEqual(ir.groups, ['jpl.scout', 'swpc.kp']);
});

test('a piece without handlers has no program entry', () => {
  const { ir } = vm(`const p = additive({}); sky.group('swpc.wind').voices(p, { pitch: 36 });`);
  assert.equal('program' in ir, false);
});

test('variables keep their values between handler calls', () => {
  const { runner } = vm(`
    const bell = fm({});
    let n = 0;
    on('jpl.scout', 'enter', () => { n += 1; bell.play(60 + n); });
  `);
  runner.start({ groups: ['jpl.scout'], objects: [] });
  const a = runner.batch({ now: 25, events: [enter(scout('A'))] });
  const b = runner.batch({ now: 50, events: [enter(scout('B')), enter(scout('C'))] });
  assert.deepEqual(a.commands.map((c) => c.pitch), [61]);
  assert.deepEqual(b.commands.map((c) => c.pitch), [62, 63]);
});

test('commands carry the event trace id, the handler id and program time', () => {
  const { runner } = vm(`const bell = fm({}); on('jpl.scout', '*', (o, e) => bell.play(70, { velocity: 200, durationMs: 1 }));`);
  runner.start({ groups: ['jpl.scout'], objects: [] });
  const r = runner.batch({ now: 125, events: [enter(scout('A'), 'trace-1')] });
  assert.deepEqual(r.commands, [{ op: 'play', inst: 'i0', pitch: 70, velocity: 127, pan: 0, durationMs: 20, at: 125, trace: 'trace-1', src: 'h0' }]);
});

test('start calls enter handlers once per current object, in id order, with initial true', () => {
  const { runner } = vm(`
    const pad = additive({});
    on('jpl.scout', 'enter', (o, e) => { if (e.initial) pad.hold(o.objectName, 60); });
  `);
  const r = runner.start({ groups: ['jpl.scout'], objects: [scout('B'), scout('A'), { id: 'x:1', group: 'swpc.kp', fields: {} }] });
  assert.deepEqual(r.commands.map((c) => c.key), ['A', 'B']);
});

test('every fires at start and at each interval; a late timer fires once', () => {
  const { runner } = vm(`const b = fm({}); every(100, (t) => b.play(60));`);
  assert.equal(runner.start({ groups: [], objects: [] }).commands.length, 1);
  const r = runner.batch({ now: 250 });
  assert.deepEqual(r.commands.map((c) => c.at), [100, 200]);
  const late = runner.batch({ now: 5000 });
  assert.deepEqual(late.commands.map((c) => c.at), [5000]);
  assert.deepEqual(runner.batch({ now: 5100 }).commands.map((c) => c.at), [5100]);
});

test('sync intervals follow the tempo', () => {
  assert.equal(syncMs('1/4', 120), 500);
  assert.equal(syncMs('1/8d', 120), 375);
  assert.equal(Math.round(syncMs('1/8t', 120)), 167);
  const { runner } = vm(`tempo(60); const b = fm({}); every('1/4', () => b.play(60));`);
  runner.start({ groups: [], objects: [] });
  assert.deepEqual(runner.batch({ now: 2000 }).commands.map((c) => c.at), [1000, 2000]);
});

test('after schedules one call from a handler, and its cancel works', () => {
  const { runner } = vm(`
    const b = fm({});
    let cancel = null;
    on('jpl.scout', 'enter', (o) => {
      after(300, () => b.play(72));
      const c = after(400, () => b.play(73));
      if (o.objectName === 'B') c();
    });
  `);
  runner.start({ groups: ['jpl.scout'], objects: [] });
  runner.batch({ now: 0, events: [enter(scout('A'))] });
  runner.batch({ now: 100, events: [enter(scout('B'))] });
  const r = runner.batch({ now: 1000 });
  assert.deepEqual(r.commands.map((c) => [c.pitch, c.at]), [[72, 300], [73, 400], [72, 400]]);
});

test('random, randInt, choose and Math.random repeat with the same seed', () => {
  const src = (seed) => `
    seed(${seed});
    const b = fm({});
    every(100, () => b.play(randInt(100) + choose([0, 0.25]) + random() * 0 + Math.random() * 0));
  `;
  const run = (seed) => {
    const { runner } = vm(src(seed));
    runner.start({ groups: [], objects: [] });
    return runner.batch({ now: 1000 }).commands.map((c) => c.pitch);
  };
  assert.deepEqual(run(7), run(7));
  assert.notEqual(JSON.stringify(run(7)), JSON.stringify(run(8)));
});

test('output and read in setup give io_outside_handler with a line', () => {
  const r = build(`const b = fm({});\nb.play(60);`);
  assert.equal(r.ir, null);
  assert.deepEqual(codes(r), ['io_outside_handler ']);
  assert.equal(r.problems[0].line, 2);
  assert.deepEqual(codes(build(`read.swpc('kp.kp');`)), ['io_outside_handler ']);
});

test('setTimeout and Date are not available to scripts', () => {
  assert.deepEqual(codes(build(`setTimeout(() => {}, 10);`)), ['runtime_error ']);
  assert.deepEqual(codes(build(`Date.now();`)), ['runtime_error ']);
});

test('a handler that throws is reported once with its line and disabled', () => {
  const { runner } = vm(`const b = fm({});\non('jpl.scout', 'enter', () => {\n  throw new Error('boom');\n});`);
  runner.start({ groups: ['jpl.scout'], objects: [] });
  const r = runner.batch({ now: 10, events: [enter(scout('A'))] });
  assert.deepEqual(r.errors, [{ handler: 'h0', line: 3, message: 'boom' }]);
  assert.deepEqual(runner.batch({ now: 20, events: [enter(scout('B'))] }).errors, []);
});

test('read reads followed groups and throws on others', () => {
  const { runner } = vm(`
    const b = fm({});
    follow('swpc.kp');
    on('jpl.scout', 'enter', () => b.play(Number(read.swpc('kp.kp')) + read.group('jpl.scout').length));
    on('jpl.scout', 'exit', () => read.group('jpl.cad'));
  `);
  runner.start({ groups: ['jpl.scout', 'swpc.kp'], objects: [{ id: 'swpc.kp:now', group: 'swpc.kp', fields: { kp: 40 } }] });
  const r = runner.batch({ now: 10, events: [enter(scout('A')), enter(scout('B'))] });
  assert.deepEqual(r.commands.map((c) => c.pitch), [41, 42]);
  const e = runner.batch({ now: 20, events: [{ kind: 'exit', obj: scout('A'), traceId: 'x' }] });
  assert.match(e.errors[0].message, /does not follow jpl\.cad/);
});

test('registering a handler inside a handler throws', () => {
  const { runner } = vm(`on('jpl.scout', 'enter', () => every(100, () => {}));`);
  runner.start({ groups: ['jpl.scout'], objects: [] });
  assert.match(runner.batch({ now: 1, events: [enter(scout('A'))] }).errors[0].message, /setup code/);
});

test('at most 256 commands per batch; the rest are counted', () => {
  const { runner } = vm(`const b = fm({}); on('jpl.scout', 'enter', () => { for (let i = 0; i < 300; i++) b.play(60); });`);
  runner.start({ groups: ['jpl.scout'], objects: [] });
  const r = runner.batch({ now: 1, events: [enter(scout('A'))] });
  assert.equal(r.commands.length, 256);
  assert.equal(r.dropped, 44);
});

test('hold, glide, stop, set and layer commands', () => {
  const { runner } = vm(`
    const pad = subtractive({});
    const d = delay({});
    pad.fx(d);
    const glyphs = layer.glyph(sky.group('jpl.scout'), {});
    on('jpl.scout', 'enter', () => {
      pad.hold('a', 60, { pan: -2 });
      pad.glide('a', 62);
      pad.pan('a', 3);
      pad.cutoff.set(99999, { smoothMs: 100 });
      d.mix.set(0.5);
      d.bypass.set(true);
      glyphs.set({ size: 30, color: '#ff0000' });
      pad.stop('a');
      pad.stopAll();
      pad.play(null);
    });
  `);
  runner.start({ groups: ['jpl.scout'], objects: [] });
  const r = runner.batch({ now: 1, events: [enter(scout('A'))] });
  const strip = ({ at, trace, src, ...c }) => c;
  assert.deepEqual(r.commands.map(strip), [
    { op: 'hold', inst: 'i0', key: 'a', pitch: 60, velocity: 100, pan: -1 },
    { op: 'glide', inst: 'i0', key: 'a', pitch: 62, ms: 150 },
    { op: 'pan', inst: 'i0', key: 'a', pan: 1 },
    { op: 'set', target: 'i0.cutoff', value: 16000, smoothMs: 100 },
    { op: 'set', target: 'f0.mix', value: 0.5, smoothMs: 250 },
    { op: 'set', target: 'f0.bypass', value: true },
    { op: 'layer', layer: 'l0', props: { size: 30, color: '#ff0000' } },
    { op: 'stop', inst: 'i0', key: 'a' },
    { op: 'stopAll', inst: 'i0' },
  ]);
});

test('grid.set sends a colour list; the constructor takes a constant list', () => {
  const { ir, runner } = vm(`
    const grid = layer.grid({ cols: 2, rows: 2, cells: ['#000000', '#ffffff'] });
    on('jpl.scout', 'enter', () => grid.set({ cells: ['#ff0000', '#00ff00', '#0000ff', '#ffffff'], sizes: [0.5, 2, -1] }));
    on('jpl.scout', 'enter', () => grid.set({ cells: ['red'] }));
  `);
  assert.deepEqual(ir.layers[0].props.cells, ['#000000', '#ffffff']);
  runner.start({ groups: ['jpl.scout'], objects: [] });
  const r = runner.batch({ now: 1, events: [enter(scout('A'))] });
  assert.deepEqual(r.commands.map((c) => c.props), [{ cells: ['#ff0000', '#00ff00', '#0000ff', '#ffffff'], sizes: [0.5, 1, 0] }]);
  assert.match(r.errors[0].message, /entry 0 must look like '#rrggbb'/);
  assert.deepEqual(codes(build(`layer.grid({ cells: sky.swpc('kp.kp') });`)), ['runtime_error ']);
});

test('the validator rejects too many handlers', () => {
  const r = build(Array.from({ length: 65 }, () => `every(100, () => {});`).join('\n'));
  assert.ok(codes(r).includes('limit_handlers /program/handlers/64'));
});

test('start seeds the state read.freshness returns', () => {
  const { runner } = vm(`const b = fm({}); every(100, () => { if (read.freshness('swpc.kp') === 'stale') b.play(40); });`);
  assert.deepEqual(ops(runner.start({ groups: [], objects: [], freshness: [{ source: 'swpc.kp', state: 'stale' }] })), ['play']);
});

test('follow(sky.orbit(...)) declares an orbit that read.orbit reads from start and batch values', () => {
  const { ir, runner } = vm(`
    const pad = additive({});
    const iss = 'celestrak.stations:25544';
    follow(sky.orbit(iss, 'latitude', { timeScale: 60 }), sky.orbit(iss, 'sunlit'));
    every(100, () => pad.play(60 + 10 * (read.orbit(iss, 'latitude', { timeScale: 60 }) ?? 0) + (read.orbit(iss, 'sunlit') === null ? 0.5 : 0)));
    on('celestrak.stations', 'exit', () => read.orbit(iss, 'phaseSin'));
  `);
  assert.deepEqual(ir.program.orbits, [
    { op: 'orbit', args: ['latitude', 'celestrak.stations:25544', 60] },
    { op: 'orbit', args: ['sunlit', 'celestrak.stations:25544', 1] },
  ]);
  assert.ok(ir.groups.includes('celestrak.stations'));
  assert.deepEqual(runner.start({ groups: ir.groups, objects: [], orbits: [0.5, null] }).commands.map((c) => c.pitch), [65.5]);
  assert.deepEqual(runner.batch({ now: 100, orbits: [7, -1] }).commands.map((c) => c.pitch), [70]);
  const e = runner.batch({ now: 150, events: [{ kind: 'exit', obj: { id: 'celestrak.stations:1', group: 'celestrak.stations', fields: {} }, traceId: 'x' }] });
  assert.match(e.errors[0].message, /follow\(sky\.orbit\('celestrak\.stations:25544', 'phaseSin'\)\)/);
});

test('follow rejects expressions other than sky.orbit with an object', () => {
  assert.deepEqual(codes(build(`follow(sky.swpc('kp.kp'));`)), ['runtime_error ']);
  assert.deepEqual(codes(build(`follow(sky.orbit('swpc.kp:now', 'latitude'));`)).map((c) => c.split(' ')[0]), ['orbit_no_elements']);
});

test('harmonics.set sends the whole list, clamped and padded', () => {
  const { runner } = vm(`
    const pad = additive({});
    on('jpl.scout', 'enter', () => pad.harmonics.set([2, 0.5, -1]));
    on('jpl.scout', 'enter', () => pad.harmonics.set([1, 1, 1, 1, 1, 1, 1, 1, 1]));
    on('jpl.scout', 'enter', () => pad.harmonics.set([1], { smoothMs: 10 }));
  `);
  runner.start({ groups: ['jpl.scout'], objects: [] });
  const r = runner.batch({ now: 1, events: [enter(scout('A'))] });
  assert.deepEqual(r.commands.map(({ op, target, value }) => ({ op, target, value })), [{ op: 'set', target: 'i0.harmonics', value: [1, 0.5, 0, 0, 0, 0, 0, 0] }]);
  assert.match(r.errors[0].message, /up to 8 numbers/);
  assert.match(r.errors[1].message, /unknown option 'smoothMs'/);
});

test('freshness handlers receive changes of their source', () => {
  const { runner } = vm(`const b = fm({}); onFreshness('swpc.kp', (f) => { if (f.state === 'stale') b.play(40); });`);
  runner.start({ groups: [], objects: [] });
  const r = runner.batch({ now: 1, freshness: [{ source: 'swpc.kp', state: 'stale' }, { source: 'jpl.cad', state: 'stale' }] });
  assert.deepEqual(ops(r), ['play']);
});
