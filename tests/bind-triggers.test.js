import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBindingRuntime, createTokenBucket } from '../src/bind/index.js';
import { FakeEngine, createFakeClock, createFakeSky, createTraceSink, skyObj } from './fakes.js';

const f = (name) => ({ op: 'field', args: [name] });

function setup(binding, group = 'll2.upcoming') {
  const ir = {
    seed: 3, scale: { root: 'C', mode: 'major' },
    instruments: [{ id: 'i0', type: 'pluck', volumeDb: -10, octave: 0, cents: 0, params: {}, fx: [] }],
    master: { fx: [] }, lfos: [], mods: [], reactions: [], layers: [], groups: [group],
    bindings: [{ id: 'b1', kind: 'trigger', inst: 'i0', group, event: 'update', when: null,
      pitch: 38, velocity: 64, durationMs: 4000, maxPerSecond: 2, ...binding }],
  };
  const engine = new FakeEngine();
  engine.sync([{ id: 'i0', type: 'pluck', params: {} }]);
  const sky = createFakeSky();
  const clock = createFakeClock();
  const trace = createTraceSink();
  const rt = createBindingRuntime({ ir, engine, sky, clock, trace });
  return { engine, inst: engine.get('i0'), sky, clock, trace, rt };
}

test('token bucket: capacity ceil(rate), starts full, refills at rate', () => {
  let t = 0;
  const b = createTokenBucket(2.5, () => t);
  assert.deepEqual([b.take(), b.take(), b.take(), b.take()], [true, true, true, false]);
  t = 399; assert.equal(b.take(), false);
  t = 400; assert.equal(b.take(), true);
  t = 10_000; assert.deepEqual([b.take(), b.take(), b.take(), b.take()], [true, true, true, false]);
  const slow = createTokenBucket(0.1, () => t);
  assert.deepEqual([slow.take(), slow.take()], [true, false]);
  t += 9_999; assert.equal(slow.take(), false);
  t += 1; assert.equal(slow.take(), true);
});

test('trigger: noteOn now and noteOff after durationMs, tagged trig:<binding>', () => {
  const { inst, sky, clock, trace, rt } = setup({});
  sky.put(skyObj('ll2.upcoming', 'x', { status: 'Go' }));
  rt.start();
  clock.advance(1000);
  sky.update('ll2.upcoming:x', { status: 'In Flight' }, 'trace-1');
  assert.deepEqual(inst.calls, [['noteOn', 38, 64, 1, 'trig:b1'], ['noteOff', 38, 5, 'trig:b1']]);
  const fired = trace.of({ stage: 'BIND', event: 'fired' });
  assert.equal(fired.length, 1);
  assert.deepEqual(fired[0].data, { binding: 'b1', result: 'fired', objectId: 'll2.upcoming:x' });
  assert.equal(fired[0].traceId, 'trace-1');
  assert.equal(trace.of({ stage: 'AUDIO', event: 'noteOn' })[0].traceId, 'trace-1');
});

test('only the binding event kind fires; when must be true', () => {
  const when = { op: 'eq', args: [f('status'), 'In Flight'] };
  const { inst, sky, rt } = setup({ when });
  rt.start();
  sky.enter(skyObj('ll2.upcoming', 'x', { status: 'Go' }));
  sky.update('ll2.upcoming:x', { status: 'Hold' });
  assert.equal(inst.calls.length, 0, 'enter is not update; Hold is not In Flight');
  sky.update('ll2.upcoming:x', { status: 'In Flight' });
  assert.equal(inst.callsOf('noteOn').length, 1);
  sky.update('ll2.upcoming:x', { status: null });
  assert.equal(inst.callsOf('noteOn').length, 1, 'null condition does not fire');
  sky.exit('ll2.upcoming:x');
  assert.equal(inst.callsOf('noteOn').length, 1);
});

test('a full-group refresh of 300 updates is bounded by the bucket; excess is dropped, not queued', () => {
  const { inst, sky, clock, trace, rt } = setup({ maxPerSecond: 2, pitch: 50 }, 'celestrak.visual');
  for (let i = 0; i < 300; i++) sky.put(skyObj('celestrak.visual', String(i), { meanMotion: 15 }));
  rt.start();
  for (let i = 0; i < 300; i++) sky.update(`celestrak.visual:${i}`, { meanMotion: 15.01 });
  assert.equal(inst.callsOf('noteOn').length, 2);
  assert.equal(trace.of({ event: 'dropped' }).length, 298);
  assert.equal(trace.of({ event: 'dropped' })[0].data.result, 'dropped');
  clock.advance(5000);
  assert.equal(inst.callsOf('noteOn').length, 2, 'dropped events are not replayed later');
  sky.update('celestrak.visual:0', { meanMotion: 15.02 });
  assert.equal(inst.callsOf('noteOn').length, 3);
});

test('null pitch does not fire and takes no token', () => {
  const { inst, sky, trace, rt } = setup({ pitch: f('p'), maxPerSecond: 1 });
  sky.put(skyObj('ll2.upcoming', 'x', {}));
  rt.start();
  sky.update('ll2.upcoming:x', { p: null });
  sky.update('ll2.upcoming:x', { p: 'text' });
  assert.equal(inst.calls.length, 0);
  assert.equal(trace.of({ event: 'dropped' }).length, 0);
  sky.update('ll2.upcoming:x', { p: 70 });
  assert.equal(inst.callsOf('noteOn').length, 1);
});

test('rand pitch is deterministic per object, quantized to the scale', () => {
  const pitch = { op: 'quantize', args: [{ op: 'rand', args: [72, 84] }] };
  const run = () => {
    const { inst, sky, rt } = setup({ event: 'enter', pitch, maxPerSecond: 20 }, 'jpl.scout');
    rt.start();
    for (const k of ['A', 'B', 'C']) sky.enter(skyObj('jpl.scout', k, {}));
    return inst.callsOf('noteOn').map((c) => c[1]);
  };
  const a = run();
  assert.deepEqual(a, run());
  const major = new Set([0, 2, 4, 5, 7, 9, 11]);
  for (const p of a) assert.ok(p >= 72 && p <= 84 && major.has(p % 12), String(p));
});

test('initial enters from the store snapshot do not fire triggers; voices still start', () => {
  const { inst, sky, trace, rt } = setup({ event: 'enter', maxPerSecond: 20 }, 'jpl.scout');
  rt.start();
  sky.enter(skyObj('jpl.scout', 'A', {}), 'tr-A', { initial: true });
  sky.enter(skyObj('jpl.scout', 'B', {}), 'tr-B', { initial: true });
  assert.equal(inst.calls.length, 0);
  assert.equal(trace.of({ stage: 'BIND' }).length, 0);
  sky.enter(skyObj('jpl.scout', 'C', {}), 'tr-C');
  assert.equal(inst.callsOf('noteOn').length, 1);

  const ir = {
    seed: 1, instruments: [{ id: 'i0', type: 'additive', volumeDb: -12, octave: 0, cents: 0, params: {}, fx: [] }],
    master: { fx: [] }, lfos: [], mods: [], reactions: [], layers: [], groups: ['jpl.cad'],
    bindings: [{ id: 'b0', kind: 'voices', inst: 'i0', group: 'jpl.cad', select: null, pitch: 60, velocity: 64, pan: null, voiceMods: {} }],
  };
  const engine = new FakeEngine();
  engine.sync([{ id: 'i0', type: 'additive', params: {} }]);
  const sky2 = createFakeSky();
  const rt2 = createBindingRuntime({ ir, engine, sky: sky2, clock: createFakeClock() });
  rt2.start();
  sky2.enter(skyObj('jpl.cad', 'a', {}), 'tr-a', { initial: true });
  assert.equal(engine.get('i0').callsOf('noteOn').length, 1, 'an initial enter starts a voice');
});
