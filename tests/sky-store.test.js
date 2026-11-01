import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSky } from '../src/sky/store.js';
import { createFakeClock, createFakeDoc, flush } from './fakes/fake-clock.js';
import { createFakeSupabase, payload, skyRow } from './fakes/fake-supabase.js';

const T0 = Date.parse('2026-10-29T12:00:00Z');
const tid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function setup({ tables = {}, autoSubscribe = true, visible = true } = {}) {
  const clock = createFakeClock(T0);
  const fake = createFakeSupabase({ tables, autoSubscribe });
  const doc = createFakeDoc();
  if (!visible) doc.visibilityState = 'hidden';
  const records = [];
  let n = 1000;
  const sky = createSky({
    client: fake.client, now: clock.now, timers: clock.timers, doc,
    trace: (r) => records.push(r), uuid: () => tid(++n),
  });
  const events = [];
  sky.on('*', (e) => events.push(e));
  return { clock, fake, doc, sky, records, events };
}

const kp = (v, o) => skyRow('swpc.kp', 'planetary', { kp: v, kpEstimated: v, timeTag: '2026-10-29T12:00:00Z' }, o);
const scout = (k, score, o) => skyRow('jpl.scout', k, { objectName: k, neoScore: score }, o);
const changes = (events) => events.filter((e) => e.type !== 'freshness');

test('follow subscribes with the group filter, selects live rows and emits initial enters in id order', async () => {
  const { fake, sky, events } = setup({
    tables: { sky_objects: [scout('B', 2, { traceId: tid(2) }), scout('A', 1, { traceId: tid(1) }), scout('C', 3, { removedAt: '2026-10-29T11:00:00Z' }), kp(3)] },
  });
  await sky.follow(['jpl.scout', 'swpc.kp']);
  const ch = fake.live();
  assert.deepEqual(ch.filter, { event: '*', schema: 'public', table: 'sky_objects', filter: 'group_key=in.(jpl.scout,swpc.kp)' });
  const ev = changes(events);
  assert.deepEqual(ev.map((e) => [e.type, e.obj.id, e.initial]), [
    ['enter', 'jpl.scout:A', true], ['enter', 'jpl.scout:B', true], ['enter', 'swpc.kp:planetary', true],
  ]);
  assert.equal(ev[0].traceId, tid(1));
  assert.equal(ev[0].prev, null);
  assert.deepEqual(sky.get('jpl.scout').map((o) => o.id), ['jpl.scout:A', 'jpl.scout:B']);
  assert.ok(Object.isFrozen(sky.get('jpl.scout')[0]));
  assert.ok(Object.isFrozen(sky.get('jpl.scout')[0].fields));
  assert.equal(sky.object('jpl.scout:A').fields.neoScore, 1);
  assert.equal(sky.object('jpl.scout:C'), null);
  assert.deepEqual(sky.followed(), ['jpl.scout', 'swpc.kp']);
  assert.equal(sky.mode, 'live');
  sky.close();
});

test('events received before the select resolves are buffered and applied after it', async () => {
  const { fake, sky, events } = setup({ tables: { sky_objects: [scout('A', 1, { traceId: tid(1) })] } });
  const release = fake.hold('sky_objects');
  const done = sky.follow(['jpl.scout']);
  await flush();
  const ch = fake.live();
  // A duplicate of the selected row, a newer update, and a new object arrive during the select.
  ch.deliver(payload(scout('A', 1, { traceId: tid(1) })));
  ch.deliver(payload(scout('A', 5, { traceId: tid(5), updatedAt: '2026-10-29T12:01:00Z' })));
  ch.deliver(payload(scout('D', 9, { traceId: tid(9) }), { eventType: 'INSERT' }));
  assert.equal(changes(events).length, 0, 'nothing applied while the select is pending');
  release();
  await done;
  assert.deepEqual(changes(events).map((e) => [e.type, e.obj.id, e.traceId, e.initial ?? false]), [
    ['enter', 'jpl.scout:A', tid(1), true],
    ['update', 'jpl.scout:A', tid(5), false],
    ['enter', 'jpl.scout:D', tid(9), false],
  ]);
  const upd = changes(events)[1];
  assert.equal(upd.prev.fields.neoScore, 1);
  assert.equal(upd.obj.fields.neoScore, 5);
  sky.close();
});

test('the select runs after the channel reports SUBSCRIBED', async () => {
  const { fake, sky } = setup({ autoSubscribe: false });
  const done = sky.follow(['swpc.kp']);
  await flush();
  assert.equal(fake.queries.filter((q) => q.table === 'sky_objects').length, 0);
  fake.live().status('SUBSCRIBED');
  await done;
  assert.equal(fake.queries.filter((q) => q.table === 'sky_objects').length, 1);
  sky.close();
});

test('removed_at produces exit; clearing removed_at produces enter', async () => {
  const { fake, sky, events } = setup({ tables: { sky_objects: [scout('A', 1, { traceId: tid(1) })] } });
  await sky.follow(['jpl.scout']);
  const ch = fake.live();
  ch.deliver(payload(scout('A', 1, { traceId: tid(2), updatedAt: '2026-10-29T12:05:00Z', removedAt: '2026-10-29T12:05:00Z' })));
  assert.deepEqual(sky.get('jpl.scout'), []);
  ch.deliver(payload(scout('A', 4, { traceId: tid(3), updatedAt: '2026-10-29T12:10:00Z' })));
  const ev = changes(events).slice(1);
  assert.deepEqual(ev.map((e) => [e.type, e.traceId]), [['exit', tid(2)], ['enter', tid(3)]]);
  assert.equal(ev[0].obj.fields.neoScore, 1);
  assert.equal(ev[0].prev, ev[0].obj);
  assert.equal(ev[1].prev, null);
  assert.equal(ev[1].initial, undefined);
  // An exit for an object the store does not hold is ignored.
  ch.deliver(payload(scout('Z', 1, { traceId: tid(4), removedAt: '2026-10-29T12:10:00Z' })));
  assert.equal(changes(events).length, 3);
  sky.close();
});

test('duplicates, older rows, other groups and invalid payloads are ignored; invalid ones are traced', async () => {
  const { fake, sky, events, records } = setup({ tables: { sky_objects: [scout('A', 1, { traceId: tid(1), updatedAt: '2026-10-29T12:05:00Z' })] } });
  await sky.follow(['jpl.scout']);
  const ch = fake.live();
  ch.deliver(payload(scout('A', 1, { traceId: tid(1), updatedAt: '2026-10-29T12:05:00Z' })));
  ch.deliver(payload(scout('A', 0, { traceId: tid(7), updatedAt: '2026-10-29T12:00:00Z' })));
  ch.handler(payload(kp(2)));
  ch.deliver(payload({ ...scout('B', 1), fields: { neoScore: Infinity } }));
  ch.deliver(payload({ ...scout('B', 1), fields: { nested: { a: 1 } } }));
  ch.deliver(payload({ ...scout('B', 1), trace_id: '' }));
  ch.deliver(payload({ ...scout('B', 1), id: 'swpc.kp:B' }));
  ch.deliver(payload({ ...scout('B', 1), updated_at: 'yesterday' }));
  assert.equal(changes(events).length, 1);
  const invalid = records.filter((r) => r.event === 'invalid_payload');
  assert.equal(invalid.length, 5);
  assert.ok(invalid.every((r) => r.level === 'error' && r.stage === 'REALTIME'));
  sky.close();
});

test('each live change traces CHANGE and REALTIME records with the row trace id', async () => {
  const { fake, sky, records, clock } = setup({ tables: { sky_objects: [kp(1, { traceId: tid(1) })] } });
  await sky.follow(['swpc.kp']);
  await clock.advance(250);
  fake.live().deliver(payload(kp(2, { traceId: tid(2), updatedAt: '2026-10-29T12:00:00.100Z' })));
  const mine = records.filter((r) => r.traceId === tid(2));
  assert.deepEqual(mine.map((r) => [r.stage, r.event]), [['CHANGE', 'update'], ['REALTIME', 'UPDATE']]);
  assert.deepEqual(mine[0].data, {
    objectId: 'swpc.kp:planetary', group: 'swpc.kp', source: 'swpc.kp', kind: 'update',
    diff: { before: kp(1).fields, after: kp(2).fields },
  });
  assert.deepEqual(mine[1].data, { table: 'sky_objects', latencyMs: 150 });
  const initial = records.find((r) => r.traceId === tid(1));
  assert.equal(initial.data.initial, true);
  sky.close();
});

test('follow replaces the followed set; dropped groups lose their objects without events', async () => {
  const { fake, sky, events } = setup({ tables: { sky_objects: [scout('A', 1), kp(3)] } });
  await sky.follow(['jpl.scout', 'swpc.kp']);
  const first = fake.live();
  const before = changes(events).length;
  await sky.follow(['swpc.kp']);
  assert.ok(first.removed);
  assert.equal(fake.live().filter.filter, 'group_key=in.(swpc.kp)');
  assert.equal(changes(events).length, before, 'no events for the dropped group or unchanged rows');
  assert.deepEqual(sky.get('jpl.scout'), []);
  assert.equal(sky.get('swpc.kp').length, 1);
  // A late payload for the dropped group on the old channel is ignored.
  first.handler(payload(scout('A', 2, { traceId: tid(77) })));
  assert.deepEqual(sky.get('jpl.scout'), []);
  await sky.follow([]);
  assert.equal(fake.live(), null);
  assert.deepEqual(sky.get('swpc.kp'), []);
  sky.close();
});

test('following the same groups again keeps live updates arriving', async () => {
  const { fake, sky, events } = setup({ tables: { sky_objects: [scout('A', 1, { traceId: tid(1) })] } });
  await sky.follow(['jpl.scout']);
  await sky.follow(['jpl.scout']);
  const ch = fake.live();
  assert.ok(ch && !ch.removed, 'a fresh channel is subscribed');
  assert.ok(ch.deliver(payload(scout('A', 7, { traceId: tid(7), updatedAt: '2026-10-29T12:01:00Z' }))));
  assert.equal(sky.object('jpl.scout:A').fields.neoScore, 7);
  assert.equal(changes(events).at(-1).type, 'update');
  sky.close();
});

test('follow rejects unknown groups and non-arrays', async () => {
  const { sky } = setup();
  await assert.rejects(sky.follow(['celestrak.active']), /unknown group "celestrak.active"/);
  await assert.rejects(sky.follow('swpc.kp'), /array/);
  sky.close();
});

test('the select pages through more than 1,000 rows', async () => {
  const rows = Array.from({ length: 1500 }, (_, i) => skyRow('celestrak.cosmos-2251-debris', String(30000 + i), { noradId: String(30000 + i) }));
  const { fake, sky, events } = setup({ tables: { sky_objects: rows } });
  await sky.follow(['celestrak.cosmos-2251-debris']);
  assert.equal(sky.get('celestrak.cosmos-2251-debris').length, 1500);
  assert.equal(changes(events).length, 1500);
  assert.deepEqual(fake.queries.filter((q) => q.table === 'sky_objects').map((q) => q.range), [[0, 999], [1000, 1999]]);
  sky.close();
});

test('a listener that throws is traced and does not stop other listeners', async () => {
  const { sky, records } = setup({ tables: { sky_objects: [kp(1)] } });
  const seen = [];
  sky.on('enter', () => { throw new Error('boom'); });
  sky.on('enter', (e) => seen.push(e.obj.id));
  await sky.follow(['swpc.kp']);
  assert.deepEqual(seen, ['swpc.kp:planetary']);
  assert.ok(records.some((r) => r.event === 'listener_error' && r.level === 'error' && r.data.message === 'boom'));
  assert.throws(() => sky.on('nope', () => {}), /unknown sky event type/);
  sky.close();
});

test('the channel closes 60 s after the tab is hidden and resyncs when visible', async () => {
  const { fake, sky, events, doc, clock } = setup({
    tables: { sky_objects: [scout('A', 1, { traceId: tid(1) }), scout('B', 2, { traceId: tid(2) }), scout('C', 3, { traceId: tid(3) })] },
  });
  await sky.follow(['jpl.scout']);
  const ch = fake.live();
  doc.setVisibility('hidden');
  await clock.advance(59000);
  assert.equal(ch.removed, false);
  await clock.advance(1000);
  assert.equal(ch.removed, true);
  assert.equal(fake.live(), null);

  // While hidden: A updated, B removed, E entered.
  fake.db.sky_objects = [
    scout('A', 7, { traceId: tid(11), updatedAt: '2026-10-29T13:00:00Z' }),
    scout('B', 2, { traceId: tid(12), updatedAt: '2026-10-29T13:00:00Z', removedAt: '2026-10-29T13:00:00Z' }),
    scout('C', 3, { traceId: tid(3) }),
    scout('E', 5, { traceId: tid(13) }),
  ];
  const n = changes(events).length;
  doc.setVisibility('visible');
  await clock.advance(10);
  assert.ok(fake.live() && fake.live() !== ch);
  assert.deepEqual(changes(events).slice(n).map((e) => [e.type, e.obj.id, e.traceId, e.initial ?? false]), [
    ['update', 'jpl.scout:A', tid(11), false],
    ['enter', 'jpl.scout:E', tid(13), false],
    ['exit', 'jpl.scout:B', tid(12), false],
  ]);
  sky.close();
});

test('a short hide does not close the channel', async () => {
  const { fake, sky, doc, clock } = setup({ tables: { sky_objects: [kp(1)] } });
  await sky.follow(['swpc.kp']);
  const ch = fake.live();
  doc.setVisibility('hidden');
  await clock.advance(30000);
  doc.setVisibility('visible');
  await clock.advance(60000);
  assert.equal(fake.live(), ch);
  sky.close();
});

test('CHANNEL_ERROR and TIMED_OUT call setAuth and resubscribe with backoff from 1 s to 30 s', async () => {
  const { fake, sky, clock } = setup({ tables: { sky_objects: [kp(1)] }, autoSubscribe: false });
  const done = sky.follow(['swpc.kp']);
  await flush();
  fake.live().status('CHANNEL_ERROR', new Error('jwt expired'));
  await done;
  assert.equal(fake.setAuthCalls(), 1);
  assert.equal(sky.channelState, 'error');
  const delays = [];
  for (let i = 0; i < 7; i++) {
    const [d] = clock.timeoutDelays();
    delays.push(d);
    await clock.advance(d);
    fake.live().status(i % 2 ? 'TIMED_OUT' : 'CHANNEL_ERROR');
    await flush();
  }
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  assert.equal(fake.setAuthCalls(), 8);
  // Success resets the delay.
  await clock.advance(clock.timeoutDelays()[0]);
  fake.live().status('SUBSCRIBED');
  await flush();
  assert.equal(sky.channelState, 'subscribed');
  fake.live().status('CHANNEL_ERROR');
  await flush();
  assert.deepEqual(clock.timeoutDelays(), [1000]);
  sky.close();
  assert.equal(clock.timeouts(), 0);
});

test('a failing select rejects follow and retries', async () => {
  const { fake, sky, clock, events } = setup({ tables: { sky_objects: [kp(1)] } });
  fake.failNext('sky_objects', 'connection reset');
  await assert.rejects(sky.follow(['swpc.kp']), /sky_objects select failed: connection reset/);
  assert.deepEqual(clock.timeoutDelays(), [1000]);
  await clock.advance(1000);
  assert.equal(changes(events).length, 1);
  sky.close();
});

test('DELETE of a held object emits exit', async () => {
  const { fake, sky, events } = setup({ tables: { sky_objects: [kp(1)] } });
  await sky.follow(['swpc.kp']);
  fake.live().handler(payload(kp(1), { eventType: 'DELETE' }));
  assert.equal(changes(events).at(-1).type, 'exit');
  assert.deepEqual(sky.get('swpc.kp'), []);
  sky.close();
});

test('createSky needs a client', () => {
  assert.throws(() => createSky({}), /Supabase client/);
});
