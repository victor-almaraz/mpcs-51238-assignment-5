import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SampleBuffer, interpolate } from '../src/visual/positions.js';
import { createPropagator } from '../src/visual/propagator.js';
import { STRIDE } from '../src/visual/propagation-core.js';

const rec = (vals) => { const a = new Float32Array(STRIDE); a.set(vals); return a; };

test('interpolate is linear and takes the short way around longitude and azimuth', () => {
  const a = rec([0, 0, 0, 0, 3.1, 0, 6.2, 0]);
  const b = rec([10, 20, 30, 0.2, -3.1, 100, 0.1, 0.4]);
  const out = new Float32Array(STRIDE);
  interpolate(a, b, 0.5, out);
  assert.deepEqual([...out.slice(0, 3)], [5, 10, 15]);
  assert.ok(Math.abs(Math.abs(out[4]) - Math.PI) < 0.01, `longitude ${out[4]} passes the antimeridian`);
  // 6.2 → 0.1 rad passes north: the midpoint is 6.2916 − 2π ≈ 0.0084.
  assert.ok(Math.abs(out[6] - (6.2 + 0.1 + 2 * Math.PI) / 2 + 2 * Math.PI) < 1e-4, `azimuth ${out[6]}`);
  assert.ok(Math.abs(out[7] - 0.2) < 1e-6);
});

test('SampleBuffer interpolates between the last two samples and holds NaN for omitted objects', () => {
  const buf = new SampleBuffer();
  assert.deepEqual(buf.positions(0).ids, []);
  assert.equal(buf.simAt(0), null);
  const p1 = new Float32Array(2 * STRIDE).fill(0); p1.fill(NaN, STRIDE);
  const p2 = new Float32Array(2 * STRIDE).fill(10); p2.fill(NaN, STRIDE);
  buf.push({ type: 'sample', wallMs: 1000, simMs: 5000, idsVersion: 1, ids: ['a', 'b'], positions: p1, orbitVersion: 1, orbitKeys: ['a|latitude|1'], orbitValues: new Float32Array([0.5]) });
  buf.push({ type: 'sample', wallMs: 1500, simMs: 5500, idsVersion: 1, positions: p2, orbitVersion: 1, orbitValues: new Float32Array([0.25]) });
  const pos = buf.positions(1250);
  assert.deepEqual(pos.ids, ['a', 'b']);
  assert.equal(pos.index.get('b'), 1);
  assert.equal(pos.data[0], 5);
  assert.ok(Number.isNaN(pos.data[STRIDE]));
  assert.equal(buf.positions(5000).data[0], 15, 'extrapolation is limited to 1.5 sample spacings');
  assert.equal(buf.simAt(1250), 5250);
  assert.equal(buf.orbitValue('a|latitude|1'), 0.25);
  assert.equal(buf.orbitValue('a|latitude|10'), null);
  // A new id set restarts interpolation from the new sample.
  buf.push({ type: 'sample', wallMs: 2000, simMs: 6000, idsVersion: 2, ids: ['a'], positions: new Float32Array(STRIDE).fill(1), orbitVersion: 1, orbitValues: new Float32Array([0]) });
  assert.equal(buf.positions(2100).data[0], 1);
  // A malformed sample is ignored.
  buf.push({ type: 'sample', wallMs: 2500, simMs: 6500, idsVersion: 2, positions: new Float32Array(3), orbitVersion: 1, orbitValues: new Float32Array([0]) });
  assert.equal(buf.positions(2600).data.length, STRIDE);
});

function fakeSky(objects) {
  const listeners = { enter: new Set(), update: new Set(), exit: new Set() };
  return {
    objects,
    get: (g) => objects.filter((o) => o.group === g),
    on: (type, fn) => { listeners[type].add(fn); return () => listeners[type].delete(fn); },
    emit: (e) => { for (const fn of listeners[e.type]) fn(e); },
    count: () => listeners.enter.size + listeners.update.size + listeners.exit.size,
  };
}

function fakeWorker() {
  const w = { sent: [], terminated: false, onmessage: null, postMessage(m) { w.sent.push(m); }, terminate() { w.terminated = true; } };
  return w;
}

test('the propagator batches sky events into one objects message and starts the worker lazily', () => {
  const timers = [];
  const w = fakeWorker();
  let created = 0;
  const p = createPropagator({ createWorker: () => { created++; return w; }, setTimer: (fn) => timers.push(fn), now: () => 0 });
  const obj = { id: 'celestrak.stations:25544', group: 'celestrak.stations', source: 'celestrak.stations', fields: { a: 1 } };
  const sky = fakeSky([obj, { id: 'jpl.cad:x', group: 'jpl.cad', fields: {} }]);
  p.setObserver({ lat: 1, lon: 2 });
  p.follow(sky);
  p.setGroups(['celestrak.stations', 'jpl.cad']);
  assert.equal(created, 0);
  for (let i = 0; i < 300; i++) sky.emit({ type: 'update', obj, traceId: `tr-${i}` });
  assert.equal(timers.length, 1, 'one flush scheduled for a burst');
  timers.shift()();
  assert.equal(created, 1);
  const types = w.sent.map((m) => m.type);
  assert.deepEqual(types, ['observer', 'objects', 'start']);
  const objs = w.sent[1].objects;
  assert.equal(objs.length, 1, 'only celestrak groups are propagated');
  assert.equal(objs[0].traceId, 'tr-299');
  p.setOrbitSources([{ objectId: obj.id, quantity: 'latitude' }]);
  assert.equal(w.sent.at(-1).type, 'orbitSources');
  p.setGroups([]);
  assert.deepEqual(w.sent.slice(-2).map((m) => m.type), ['objects', 'stop']);
  p.dispose();
  assert.equal(w.terminated, true);
  assert.equal(sky.count(), 0, 'sky listeners removed');
});

test('the propagator forwards samples, paths and trace records', () => {
  const w = fakeWorker();
  const traced = [];
  const p = createPropagator({ createWorker: () => w, setTimer: (fn) => fn(), trace: (r) => traced.push(r), now: () => Date.parse('2026-10-29T14:00:00Z') });
  const obj = { id: 'celestrak.stations:25544', group: 'celestrak.stations', fields: {} };
  p.setGroups(['celestrak.stations']);
  p.follow(fakeSky([obj]));
  const seen = [];
  p.onSample((s) => seen.push(s.simMs));
  const pos = new Float32Array(STRIDE).fill(2);
  w.onmessage({ data: { type: 'sample', wallMs: 1, simMs: 9, idsVersion: 1, ids: [obj.id], positions: pos, orbitVersion: 1, orbitKeys: [`${obj.id}|sunlit|1`], orbitValues: new Float32Array([-1]) } });
  assert.deepEqual(seen, [9]);
  assert.equal(p.orbitValue(obj.id, 'sunlit'), -1);
  assert.equal(p.positions(1).data[0], 2);
  assert.equal(p.simTime(1), 9);
  w.onmessage({ data: { type: 'paths', key: 'lines:l0', ids: [obj.id], steps: 1, stepSec: 60, fromSec: 0, wallMs: 1, simMs: 9, data: pos } });
  assert.equal(p.paths('lines:l0').simMs, 9);
  assert.equal(p.paths('nope'), null);
  w.onmessage({ data: { type: 'trace', record: { traceId: null, stage: 'VISUAL', component: 'sgp4', event: 'propagationFailed', level: 'warn', data: { objectId: obj.id, code: 6, message: 'orbit decayed' } } } });
  assert.equal(traced.length, 1);
  assert.equal(traced[0].t, '2026-10-29T14:00:00.000Z');
  assert.match(traced[0].traceId, /^sgp4-/);
  const w2 = fakeWorker();
  const throwing = createPropagator({ createWorker: () => w2, setTimer: (fn) => fn(), trace: () => { throw new TypeError('bad'); } });
  throwing.setGroups(['celestrak.stations']);
  throwing.follow(fakeSky([obj]));
  assert.equal(typeof w2.onmessage, 'function');
  const errors = [];
  const original = console.error;
  console.error = (...a) => errors.push(a);
  try {
    assert.doesNotThrow(() => w2.onmessage({ data: { type: 'trace', record: { stage: 'VISUAL', component: 'sgp4', event: 'x', level: 'warn', data: {} } } }));
  } finally { console.error = original; }
  assert.equal(errors.length, 1, 'a rejected record is reported, not thrown');
  throwing.dispose();
});

test('dispose cancels a pending flush, so no worker starts afterwards', () => {
  const timers = new Map();
  let nextId = 0;
  const cleared = [];
  let created = 0;
  const p = createPropagator({
    createWorker: () => { created++; return fakeWorker(); },
    setTimer: (fn) => { timers.set(++nextId, fn); return nextId; },
    clearTimer: (h) => { cleared.push(h); timers.delete(h); },
  });
  const obj = { id: 'celestrak.stations:25544', group: 'celestrak.stations', fields: {} };
  const sky = fakeSky([obj]);
  p.setGroups(['celestrak.stations']);
  p.follow(sky);
  assert.equal(timers.size, 1, 'a flush is pending');
  const [[id, pending]] = [...timers];
  p.dispose();
  assert.deepEqual(cleared, [id], 'the pending timer is cleared');
  pending(); // a timer that fires anyway does nothing
  p.setGroups(['celestrak.stations']);
  p.follow(sky);
  sky.emit({ type: 'update', obj, traceId: 't' });
  for (const fn of timers.values()) fn();
  assert.equal(created, 0, 'no worker is created after dispose');
  assert.equal(sky.count(), 0, 'follow after dispose subscribes nothing');
});

test('a synchronous timer still lets later events flush', () => {
  const w = fakeWorker();
  const p = createPropagator({ createWorker: () => w, setTimer: (fn) => { fn(); return undefined; } });
  const obj = { id: 'celestrak.stations:25544', group: 'celestrak.stations', fields: {} };
  const sky = fakeSky([obj]);
  p.setGroups(['celestrak.stations']);
  p.follow(sky);
  sky.emit({ type: 'update', obj, traceId: 't2' });
  assert.equal(w.sent.filter((m) => m.type === 'objects').at(-1).objects[0].traceId, 't2');
  p.dispose();
});

test('a worker error is traced as VISUAL / workerError', () => {
  const w = fakeWorker();
  const traced = [];
  const p = createPropagator({ createWorker: () => w, setTimer: (fn) => fn(), trace: (r) => traced.push(r), now: () => 0 });
  p.setGroups(['celestrak.stations']);
  p.follow(fakeSky([{ id: 'celestrak.stations:25544', group: 'celestrak.stations', fields: {} }]));
  assert.equal(typeof w.onerror, 'function');
  w.onerror({ message: 'failed to load module' });
  assert.equal(traced.length, 1);
  assert.equal(traced[0].stage, 'VISUAL');
  assert.equal(traced[0].component, 'sgp4');
  assert.equal(traced[0].event, 'workerError');
  assert.equal(traced[0].level, 'error');
  assert.deepEqual(traced[0].data, { message: 'failed to load module' });
  assert.match(traced[0].traceId, /^sgp4-/);
  p.dispose();
});
