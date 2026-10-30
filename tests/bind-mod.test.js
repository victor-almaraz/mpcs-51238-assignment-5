import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBindingRuntime, buildModConfig, postedValue } from '../src/bind/index.js';
import { FakeEngine, createFakeClock, createFakeSky, createTraceSink, skyObj } from './fakes.js';

const swpc = (p) => ({ op: 'swpc', args: [p] });
const map = (x, ...r) => ({ op: 'map', args: [x, ...r, 'lin'] });

const modIr = () => ({
  seed: 1,
  instruments: [{ id: 'i0', type: 'subtractive', volumeDb: -12, octave: 0, cents: 0, params: {},
    fx: [{ id: 'f0', type: 'delay', params: { time: 500 }, bypass: false }, { id: 'f1', type: 'reverb', params: {}, bypass: false }] }],
  master: { fx: [] },
  lfos: [
    { id: 'lfo0', shape: 'sine', rate: 0.03, phase: 0, retrigger: false, smooth: 0 },
    { id: 'lfo1', shape: 'smooth', rate: { expr: map(swpc('wind.speed'), 300, 800, 0.1, 3), min: 0.1, max: 3 }, phase: 0, retrigger: false, smooth: 0.5 },
    { id: 'lfo2', shape: 'square', rate: { sync: '1/4d' }, phase: 0.25, retrigger: false, smooth: 0 },
  ],
  mods: [
    { target: 'f1.decay', source: { lfo: 'lfo0' }, depth: 0.2, smoothMs: 250 },
    { target: 'f0.feedback', source: { expr: map(swpc('kp.kp'), 0, 9, -1, 1) }, depth: 0.4, smoothMs: 250 },
    { target: 'f0.time', source: { lfo: 'lfo1' }, depth: 0.05, smoothMs: 250 },
    { target: 'i0.cutoff', source: { expr: { op: 'mul', args: [swpc('mag.bz'), 0.1] } }, depth: 0.3, smoothMs: 1000 },
    { target: 'i0.resonance', source: { expr: { op: 'orbit', args: ['sunlit', 'celestrak.stations:25544', 10] } }, depth: 0.15, smoothMs: 4000 },
  ],
  bindings: [], reactions: [], layers: [], groups: ['swpc.kp', 'swpc.wind', 'swpc.mag', 'celestrak.stations'],
});

test('data source ids: LFO rate expressions first, then route expressions, in IR order', () => {
  const { lfos, routes, dataSources } = buildModConfig(modIr());
  assert.deepEqual(lfos.map((l) => l.rate), [0.03, { data: 'dat0', min: 0.1, max: 3 }, { sync: '1/4d' }]);
  assert.deepEqual(routes, [
    { target: 'f1.decay', source: 'lfo0', depth: 0.2 },
    { target: 'f0.feedback', source: 'dat1', depth: 0.4 },
    { target: 'f0.time', source: 'lfo1', depth: 0.05 },
    { target: 'i0.cutoff', source: 'dat2', depth: 0.3 },
    { target: 'i0.resonance', source: 'dat3', depth: 0.15 },
  ]);
  assert.deepEqual(dataSources.map((d) => [d.id, d.kind, d.class, d.smoothMs, d.timeScale]), [
    ['dat0', 'rate', 'random-walk', 250, 1],
    ['dat1', 'route', 'random-walk', 250, 1],
    ['dat2', 'route', 'random-walk', 1000, 1],
    ['dat3', 'route', 'vlfo', 4000, 10],
  ]);
  assert.equal(lfos[2].phase, 0.25);
});

test('orbit sources default to smoothMs 500 when the IR leaves it out', () => {
  const ir = modIr();
  delete ir.mods[4].smoothMs;
  delete ir.mods[3].smoothMs;
  const ds = buildModConfig(ir).dataSources;
  assert.equal(ds[3].smoothMs, 500);
  assert.equal(ds[2].smoothMs, 250);
});

test('posted values: routes clamp to −1..1; rates clamp to [min, max] and map to −1..1', () => {
  const route = { kind: 'route', min: -1, max: 1 };
  assert.equal(postedValue(route, 1.3), 1);
  assert.equal(postedValue(route, -7), -1);
  assert.equal(postedValue(route, 0.25), 0.25);
  const rate = { kind: 'rate', min: 0.1, max: 3 };
  assert.equal(postedValue(rate, 0.1), -1);
  assert.equal(postedValue(rate, 3), 1);
  assert.ok(Math.abs(postedValue(rate, 1.55)) < 1e-12);
  assert.equal(postedValue(rate, 50), 1);
  assert.equal(postedValue(rate, 0), -1);
});

function run() {
  const ir = modIr();
  const engine = new FakeEngine();
  const sky = createFakeSky();
  sky.put(skyObj('swpc.kp', 'planetary', { kp: 4.5 }));
  sky.put(skyObj('swpc.wind', 'l1', { speed: 1000 }));
  sky.put(skyObj('swpc.mag', 'l1', { bz: 13 }));
  const clock = createFakeClock();
  const trace = createTraceSink();
  let sunlit = 1;
  const rt = createBindingRuntime({ ir, engine, sky, clock, trace, orbit: () => sunlit });
  return { engine, sky, clock, trace, rt, setSunlit: (v) => { sunlit = v; } };
}

test('runtime posts each data source at start with clamping, and traces raw and posted', () => {
  const { engine, trace, rt } = run();
  rt.start();
  assert.deepEqual(engine.callsOf('postModValue'), [
    ['postModValue', 'dat0', 1, 250],      // 1000 km/s → 3 Hz (clamped at max) → 1
    ['postModValue', 'dat1', 0, 250],      // kp 4.5 → 0
    ['postModValue', 'dat2', 1, 1000],     // 1.3 → clamped to 1
    ['postModValue', 'dat3', 1, 4000],
  ]);
  const recs = trace.of({ event: 'modValue' });
  assert.deepEqual(recs[2].data, { event: 'modValue', source: 'dat2', class: 'random-walk', raw: 1.3, posted: 1 });
  assert.deepEqual(recs[3].data, { event: 'modValue', source: 'dat3', class: 'vlfo', raw: 1, posted: 1, timeScale: 10 });
  assert.equal(recs[0].data.raw, 3, 'rate raw is the expression result before clamping');
  assert.equal(recs[0].stage, 'AUDIO');
});

test('30 Hz post limit: a burst of changes posts at most once per 1/30 s, latest value wins', () => {
  const { engine, sky, clock, rt } = run();
  rt.start();
  engine.calls.length = 0;
  for (let i = 0; i < 100; i++) {
    sky.update('swpc.kp:planetary', { kp: (i % 10) * 0.9 });
    clock.advance(5);
  }
  clock.advance(100);
  const posts = engine.callsOf('postModValue').filter((c) => c[1] === 'dat1');
  assert.ok(posts.length <= 16 && posts.length >= 14, `${posts.length} posts in 0.6 s`);
  const kpLast = 9 * 0.9;
  assert.ok(Math.abs(posts.at(-1)[2] - (kpLast / 9 * 2 - 1)) < 1e-12, 'the last value is posted');
  // Sliding 1 s windows never hold more than 30 posts.
  const { engine: e2, sky: s2, clock: c2, rt: r2 } = run();
  r2.start();
  e2.calls.length = 0;
  const times = [];
  const orig = e2.postModValue.bind(e2);
  e2.postModValue = (id, v, sm) => { if (id === 'dat1') times.push(c2.now()); orig(id, v, sm); };
  for (let i = 0; i < 600; i++) { s2.update('swpc.kp:planetary', { kp: (i % 7) + 1 }); c2.advance(5); }
  for (let i = 0; i < times.length; i++) {
    const inWindow = times.filter((t) => t >= times[i] && t < times[i] + 1000).length;
    assert.ok(inWindow <= 30, `${inWindow} posts in one second`);
  }
});

test('an unchanged value is not posted again; null keeps the last value', () => {
  const { engine, sky, clock, rt } = run();
  rt.start();
  engine.calls.length = 0;
  clock.advance(100);
  sky.update('swpc.kp:planetary', { kp: 4.5, timeTag: 'x' });
  sky.update('swpc.kp:planetary', { kp: null });
  clock.advance(100);
  assert.equal(engine.callsOf('postModValue').length, 0);
});

test('orbit data sources are re-evaluated on each orbit post', () => {
  const { engine, clock, rt, setSunlit } = run();
  rt.start();
  engine.calls.length = 0;
  setSunlit(-1);
  clock.advance(500);
  rt.orbitTick();
  setSunlit(1);
  clock.advance(500);
  rt.orbitTick();
  assert.deepEqual(engine.callsOf('postModValue').map((c) => [c[1], c[2]]), [['dat3', -1], ['dat3', 1]]);
  assert.deepEqual(rt.dataSources().find((d) => d.id === 'dat3'), {
    id: 'dat3', class: 'vlfo', raw: 1, posted: 1, timeScale: 10, owner: 'i0.resonance', kind: 'route',
  });
});
