import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBindingRuntime, createSmoother, LIMITS } from '../src/bind/index.js';
import { FakeEngine, FakeInstrument, createFakeClock, createFakeSky, createTraceSink, skyObj } from './fakes.js';

const kp = { op: 'swpc', args: ['kp.kp'] };
const kpMap = { op: 'map', args: [kp, 0, 9, 2, 40, 'lin'] };

function setup({ bindings, fx = [], instParams = { vibratoDepth: 6 }, ranges = {}, fxParamDef } = {}) {
  const ir = {
    seed: 1, scale: { root: 'C', mode: 'chromatic' },
    instruments: [{ id: 'i0', type: 'additive', volumeDb: -12, octave: 0, cents: 0, params: instParams, fx }],
    master: { fx: [] }, lfos: [], mods: [], reactions: [], layers: [], groups: ['swpc.kp'],
    bindings,
  };
  const engine = new FakeEngine({ instrument: (w) => new FakeInstrument(w.type, { params: w.params, ranges }) });
  engine.sync([{ id: 'i0', type: 'additive', params: instParams }]);
  engine.setFx('i0', fx);
  const sky = createFakeSky();
  sky.put(skyObj('swpc.kp', 'planetary', { kp: 0 }));
  const clock = createFakeClock();
  const trace = createTraceSink();
  const rt = createBindingRuntime({ ir, engine, sky, clock, trace, fxParamDef });
  return { engine, inst: engine.get('i0'), sky, clock, trace, rt };
}

test('one-pole smoother settles within about smoothMs', () => {
  const s = createSmoother(300);
  s.set(10, 0, 0);
  let t = 0;
  while (s.moving && t < 10_000) { t += 10; s.step(t); }
  assert.equal(s.value, 10);
  // τ = 100 ms; 0.1% of the step is reached after ln(1000) τ ≈ 690 ms.
  assert.ok(t >= 690 && t <= 700, String(t));
  const s2 = createSmoother(300);
  s2.set(10, 0, 0);
  s2.step(300);
  assert.ok(Math.abs(s2.value - 10 * (1 - Math.exp(-3))) < 1e-9, 'after smoothMs: 95%');
});

test('param: smoothed setParam at most 30 Hz while moving, then stops', () => {
  const { inst, sky, clock, rt } = setup({ bindings: [{ id: 'b2', kind: 'param', inst: 'i0', param: 'vibratoDepth', expr: kpMap, smoothMs: 300 }] });
  rt.start();
  clock.advance(1500);
  const initial = inst.callsOf('setParam').length;
  // kp 0 → value 2: glides from the IR's 6 to 2.
  assert.ok(initial > 0);
  assert.equal(inst.getParams().vibratoDepth, 2);
  inst.calls.length = 0;
  sky.update('swpc.kp:planetary', { kp: 9 });
  clock.advance(1000);
  const sets = inst.callsOf('setParam');
  assert.ok(sets.length > 5 && sets.length <= 30, `${sets.length} calls in 1 s`);
  clock.advance(500);
  const values = sets.map((c) => c[2]);
  for (let i = 1; i < values.length; i++) assert.ok(values[i] >= values[i - 1], 'monotonic glide');
  assert.ok(Math.abs(values[Math.round(300 / LIMITS.tickMs) - 1] - (2 + 38 * (1 - Math.exp(-3)))) < 1.5, '~95% after smoothMs');
  assert.equal(inst.callsOf('setParam').at(-1)[2], 40);
  inst.calls.length = 0;
  clock.advance(2000);
  assert.equal(inst.callsOf('setParam').length, 0, 'no calls once settled');
});

test('param: 30 Hz limit holds for a long glide', () => {
  const { inst, sky, clock, rt } = setup({ bindings: [{ id: 'b2', kind: 'param', inst: 'i0', param: 'vibratoDepth', expr: kpMap, smoothMs: 4000 }] });
  rt.start();
  clock.advance(10_000);
  inst.calls.length = 0;
  sky.update('swpc.kp:planetary', { kp: 9 });
  for (let s = 0; s < 3; s++) {
    const before = inst.callsOf('setParam').length;
    clock.advance(1000);
    const n = inst.callsOf('setParam').length - before;
    assert.ok(n <= 30 && n >= 28, `second ${s}: ${n} calls`);
  }
  assert.ok(1000 / LIMITS.tickMs <= 30);
});

test('param traces requested, sent and applied (clamped by the instrument) at start and settle', () => {
  const { sky, clock, trace, rt } = setup({
    bindings: [{ id: 'b2', kind: 'param', inst: 'i0', param: 'vibratoDepth', expr: { op: 'mul', args: [kp, 10] }, smoothMs: 100 }],
    ranges: { vibratoDepth: [0, 50] },
  });
  rt.start();
  clock.advance(1000);
  trace.records.length = 0;
  sky.update('swpc.kp:planetary', { kp: 9 }, 'tr-kp');
  clock.advance(2000);
  const recs = trace.of({ event: 'setParam' });
  assert.equal(recs.length, 2);
  assert.deepEqual(recs.map((r) => r.data.phase), ['start', 'settled']);
  assert.equal(recs[1].data.requested, 90);
  assert.equal(recs[1].data.sent, 90);
  assert.equal(recs[1].data.applied, 50, 'applied shows the clamp');
  assert.equal(recs[1].traceId, 'tr-kp');
  assert.equal(recs[1].stage, 'AUDIO');
});

test('param null keeps the last value', () => {
  const { inst, sky, clock, rt } = setup({ bindings: [{ id: 'b2', kind: 'param', inst: 'i0', param: 'vibratoDepth', expr: kpMap, smoothMs: 100 }] });
  rt.start();
  clock.advance(1000);
  inst.calls.length = 0;
  sky.update('swpc.kp:planetary', { kp: null });
  clock.advance(1000);
  assert.equal(inst.callsOf('setParam').length, 0);
  assert.equal(inst.getParams().vibratoDepth, 2);
});

test('param is re-evaluated only on events in groups the expression references', () => {
  const count = { op: 'count', args: ['jpl.scout'] };
  const { inst, sky, clock, rt } = setup({ bindings: [{ id: 'b2', kind: 'param', inst: 'i0', param: 'vibratoDepth', expr: count, smoothMs: 0 }] });
  rt.start();
  clock.advance(100);
  assert.equal(inst.getParams().vibratoDepth, 0);
  sky.enter(skyObj('jpl.scout', 'a', {}));
  sky.enter(skyObj('jpl.scout', 'b', {}));
  clock.advance(100);
  assert.equal(inst.getParams().vibratoDepth, 2, 'count cache invalidated on group events');
  inst.calls.length = 0;
  sky.update('swpc.kp:planetary', { kp: 4 });
  clock.advance(100);
  assert.equal(inst.callsOf('setParam').length, 0);
});

test('effect follow calls setFxParam; enum results round to an option index; bypass follows a boolean', () => {
  const fx = [
    { id: 'f0', type: 'delay', params: { time: 375, feedback: 0.35 }, bypass: false },
    { id: 'f1', type: 'filter', params: { cutoff: 2000 }, bypass: false },
  ];
  const fxParamDef = (type, name) => (type === 'filter' && name === 'mode'
    ? { id: 'mode', scale: 'enum', options: ['lowpass', 'highpass', 'bandpass'] } : { id: name, scale: 'lin' });
  const { engine, sky, clock, trace, rt } = setup({
    fx,
    fxParamDef,
    bindings: [
      { id: 'b0', kind: 'fxParam', slot: 'f0', param: 'feedback', expr: { op: 'map', args: [kp, 0, 9, 0, 0.9, 'lin'] }, smoothMs: 100 },
      { id: 'b1', kind: 'fxParam', slot: 'f1', param: 'mode', expr: { op: 'map', args: [kp, 0, 9, 0, 2, 'lin'] }, smoothMs: 100 },
      { id: 'b2', kind: 'fxBypass', slot: 'f1', expr: { op: 'gt', args: [kp, 5] } },
    ],
  });
  rt.start();
  clock.advance(1000);
  engine.calls.length = 0;
  sky.update('swpc.kp:planetary', { kp: 6.3 });
  clock.advance(1000);
  const fb = engine.callsOf('setFxParam').filter((c) => c[1] === 'f0');
  assert.ok(fb.length > 1);
  assert.ok(Math.abs(fb.at(-1)[3] - 0.63) < 1e-9);
  assert.deepEqual(engine.callsOf('setFxParam').filter((c) => c[1] === 'f1'), [['setFxParam', 'f1', 'mode', 1]], 'one unsmoothed index');
  assert.deepEqual(engine.callsOf('setFxBypass'), [['setFxBypass', 'f1', true]]);
  sky.update('swpc.kp:planetary', { kp: 6.4 });
  assert.equal(engine.callsOf('setFxBypass').length, 1, 'bypass calls only on change');
  sky.update('swpc.kp:planetary', { kp: 1 });
  assert.deepEqual(engine.callsOf('setFxBypass').at(-1), ['setFxBypass', 'f1', false]);
  assert.ok(trace.of({ event: 'setFxBypass' }).length >= 2);
});

test('a param binding whose inst is a slot id is an effect follow', () => {
  const fx = [{ id: 'f0', type: 'reverb', params: { mix: 0.25 }, bypass: false }];
  const { engine, sky, clock, rt } = setup({
    fx,
    bindings: [
      { id: 'b0', kind: 'param', inst: 'f0', param: 'mix', expr: { op: 'map', args: [kp, 0, 9, 0, 1, 'lin'] }, smoothMs: 0 },
      { id: 'b1', kind: 'param', inst: 'f0', param: 'bypass', expr: { op: 'gt', args: [kp, 5] } },
    ],
  });
  rt.start();
  sky.update('swpc.kp:planetary', { kp: 9 });
  clock.advance(100);
  assert.deepEqual(engine.callsOf('setFxParam').at(-1), ['setFxParam', 'f0', 'mix', 1]);
  assert.deepEqual(engine.callsOf('setFxBypass'), [['setFxBypass', 'f0', true]]);
  assert.deepEqual(rt.disabled(), []);
});
