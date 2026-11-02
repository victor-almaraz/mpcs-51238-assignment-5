import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as defaultBus from '../src/trace/bus.js';
import { STAGES, createTraceBus, newTraceId } from '../src/trace/bus.js';
import { eventsFromTrace, parseJsonl, toJsonl } from '../src/trace/jsonl.js';
import { createSky } from '../src/sky/store.js';
import { createFakeClock } from './fakes/fake-clock.js';
import { createFakeSupabase, payload, skyRow } from './fakes/fake-supabase.js';

const T0 = Date.parse('2026-10-29T14:02:11.405Z');
const rec = (o = {}) => ({ traceId: 'tr-1', stage: 'AUDIO', component: 'bind.b1', event: 'noteOn', data: { pitch: 79 }, ...o });

test('trace stamps t, defaults level and data, and freezes the stored record', () => {
  const bus = createTraceBus({ now: () => T0 });
  const r = bus.trace({ traceId: 'x', stage: 'BIND', component: 'bind.b1', event: 'fired' });
  assert.deepEqual(r, { t: '2026-10-29T14:02:11.405Z', traceId: 'x', stage: 'BIND', component: 'bind.b1', event: 'fired', level: 'info', data: {} });
  assert.ok(Object.isFrozen(r) && Object.isFrozen(r.data));
  const data = { nested: { v: 1 } };
  const r2 = bus.trace(rec({ data }));
  data.nested.v = 2;
  assert.equal(r2.data.nested.v, 1, 'the bus stores a copy');
  assert.ok(Object.isFrozen(r2.data.nested));
});

test('invalid records throw TypeError naming the field', () => {
  const bus = createTraceBus();
  assert.throws(() => bus.trace(rec({ traceId: '' })), /traceId/);
  assert.throws(() => bus.trace(rec({ component: undefined })), /component/);
  assert.throws(() => bus.trace(rec({ event: 3 })), /event/);
  assert.throws(() => bus.trace(rec({ stage: 'NORMALIZE' })), /stage "NORMALIZE"/);
  assert.throws(() => bus.trace(rec({ level: 'debug' })), /level/);
  assert.throws(() => bus.trace(rec({ data: [1] })), /data/);
  assert.throws(() => bus.trace(rec({ t: 'noon' })), /ISO 8601/);
  assert.throws(() => bus.trace(rec({ replay: 0 })), /replay/);
  assert.throws(() => bus.trace(rec({ synthetic: false })), /synthetic/);
  assert.throws(() => bus.trace(null), TypeError);
  assert.equal(bus.records().length, 0);
});

test('the ring buffer keeps the newest records and drops the oldest', () => {
  const bus = createTraceBus({ capacity: 3 });
  for (let i = 0; i < 5; i++) bus.trace(rec({ traceId: `t${i}` }));
  assert.deepEqual(bus.records().map((r) => r.traceId), ['t2', 't3', 't4']);
  bus.setCapacity(2);
  assert.deepEqual(bus.records().map((r) => r.traceId), ['t3', 't4']);
  bus.trace(rec({ traceId: 't5' }));
  assert.deepEqual(bus.records().map((r) => r.traceId), ['t4', 't5']);
  bus.clear();
  assert.deepEqual(bus.records(), []);
  assert.equal(createTraceBus().capacity(), 2000);
  assert.throws(() => createTraceBus({ capacity: 0 }), RangeError);
});

test('the default bus holds 2,000 records and accepts 500–5000 from settings', () => {
  defaultBus.clear();
  for (let i = 0; i < 2001; i++) defaultBus.trace(rec({ traceId: `d${i}` }));
  assert.equal(defaultBus.records().length, 2000);
  assert.equal(defaultBus.records()[0].traceId, 'd1');
  assert.throws(() => defaultBus.setCapacity(499), /500–5000/);
  assert.throws(() => defaultBus.setCapacity(5001), /500–5000/);
  defaultBus.setCapacity(500);
  assert.equal(defaultBus.records().length, 500);
  defaultBus.setCapacity(2000);
  defaultBus.clear();
});

test('subscribers receive each record; unsubscribe and throwing subscribers are removed', () => {
  const bus = createTraceBus();
  const a = [];
  const b = [];
  const offA = bus.subscribe((r) => a.push(r.traceId));
  bus.subscribe(() => { throw new Error('bad panel'); });
  bus.subscribe((r) => b.push(r.traceId));
  bus.trace(rec({ traceId: '1' }));
  offA();
  bus.trace(rec({ traceId: '2' }));
  assert.deepEqual(a, ['1']);
  assert.deepEqual(b, ['1', '2']);
  assert.throws(() => bus.subscribe(null), TypeError);
});

test('chain returns one trace id in stage order, then time order', () => {
  let t = T0;
  const bus = createTraceBus({ now: () => t++ });
  bus.trace(rec({ traceId: 'c', stage: 'VISUAL', event: 'draw' }));
  bus.trace(rec({ traceId: 'c', stage: 'AUDIO', event: 'noteOn' }));
  bus.trace(rec({ traceId: 'other', stage: 'CHANGE', event: 'update' }));
  bus.trace(rec({ traceId: 'c', stage: 'CHANGE', event: 'update' }));
  bus.trace(rec({ traceId: 'c', stage: 'AUDIO', event: 'setParam' }));
  bus.trace(rec({ traceId: 'c', stage: 'REALTIME', event: 'UPDATE' }));
  assert.deepEqual(bus.chain('c').map((r) => `${r.stage}.${r.event}`), [
    'CHANGE.update', 'REALTIME.UPDATE', 'AUDIO.noteOn', 'AUDIO.setParam', 'VISUAL.draw',
  ]);
  assert.deepEqual(STAGES, ['SOURCE', 'CHANGE', 'REALTIME', 'BIND', 'AUDIO', 'VISUAL', 'RELOAD', 'SAFETY']);
});

test('JSON Lines export round-trips; parse errors name the line', () => {
  const bus = createTraceBus({ now: () => T0 });
  bus.trace(rec());
  bus.trace(rec({ traceId: 'syn-1', synthetic: true, level: 'warn' }));
  bus.trace(rec({ traceId: 'r', replay: 100 }));
  const text = bus.toJsonl();
  assert.equal(text.split('\n').length, 4);
  assert.equal(text, toJsonl(bus.records()));
  assert.deepEqual(parseJsonl(text), bus.records());
  assert.deepEqual(parseJsonl(''), []);
  assert.throws(() => parseJsonl(`${JSON.stringify(bus.records()[0])}\n{bad`), /trace line 2/);
  assert.throws(() => parseJsonl('{"traceId":"x","stage":"AUDIO","component":"c","event":"e"}'), /line 1: record lacks t/);
  assert.throws(() => parseJsonl('{"t":"2026-10-29T00:00:00Z","traceId":"x","stage":"NOPE","component":"c","event":"e"}'), /line 1: .*stage/);
});

test('newTraceId adds the prefix to a UUID', () => {
  assert.match(newTraceId('syn-'), /^syn-[0-9a-f-]{36}$/);
  assert.match(newTraceId(), /^[0-9a-f-]{36}$/);
});

test('eventsFromTrace rebuilds the sky events from an exported trace', async () => {
  const clock = createFakeClock(T0);
  const bus = createTraceBus({ now: clock.now });
  const fake = createFakeSupabase({ tables: { sky_objects: [skyRow('jpl.scout', 'A', { neoScore: 1 }, { traceId: 'a-1' })] } });
  const sky = createSky({ client: fake.client, now: clock.now, timers: clock.timers, doc: null, trace: bus.trace, uuid: () => 'u' });
  const emitted = [];
  sky.on('*', (e) => { if (e.type !== 'freshness') emitted.push(e); });
  await sky.follow(['jpl.scout']);
  const ch = fake.live();
  ch.deliver(payload(skyRow('jpl.scout', 'A', { neoScore: 2 }, { traceId: 'a-2', updatedAt: '2026-10-29T12:01:00Z' })));
  ch.deliver(payload(skyRow('jpl.scout', 'B', { neoScore: 3 }, { traceId: 'b-1' }), { eventType: 'INSERT' }));
  ch.deliver(payload(skyRow('jpl.scout', 'A', { neoScore: 2 }, { traceId: 'a-3', updatedAt: '2026-10-29T12:02:00Z', removedAt: '2026-10-29T12:02:00Z' })));
  sky.close();
  const rebuilt = eventsFromTrace(parseJsonl(bus.toJsonl()));
  assert.deepEqual(rebuilt, emitted);
});

test('safeTrace never throws: a rejected record goes to console.error with its producer', async () => {
  const { safeTrace } = await import('../src/trace/bus.js');
  const bus = createTraceBus({ now: () => T0 });
  const ok = safeTrace(bus.trace, 'test');
  ok(rec());
  assert.equal(bus.records().length, 1);
  const errors = [];
  const original = console.error;
  console.error = (...a) => errors.push(a);
  try {
    assert.doesNotThrow(() => ok({ stage: 'NOPE' }));
  } finally { console.error = original; }
  assert.equal(errors.length, 1);
  assert.match(String(errors[0][0]), /trace rejected a test record/);
  assert.doesNotThrow(() => safeTrace(undefined, 'x')(rec()));
});

test('the sky store keeps running when its trace sink throws, and reports it', async () => {
  const clock = createFakeClock(T0);
  const fake = createFakeSupabase({ tables: { sky_objects: [skyRow('swpc.kp', 'now', { kp: 3 })], source_status: [] } });
  const errors = [];
  const original = console.error;
  console.error = (...a) => errors.push(a);
  try {
    const sky = createSky({ client: fake.client, now: clock.now, timers: clock.timers, doc: null, trace: () => { throw new TypeError('sink down'); } });
    await sky.follow(['swpc.kp']);
    assert.equal(sky.get('swpc.kp').length, 1);
    sky.close();
  } finally { console.error = original; }
  assert.ok(errors.length > 0);
  assert.match(String(errors[0][0]), /trace rejected a sky record/);
});
