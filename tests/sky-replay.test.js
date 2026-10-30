import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReplay } from '../src/sky/replay.js';
import { groupKeys } from '../src/sky/groups.js';
import { createFakeClock } from './fakes/fake-clock.js';
import { createFakeSupabase, skyRow } from './fakes/fake-supabase.js';

const FROM = Date.parse('2026-10-29T00:00:00Z');
const NOW = Date.parse('2026-10-29T12:00:00Z');
const tid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const iso = (ms) => new Date(ms).toISOString();

let nextId = 1;
const change = (objectId, kind, before, after, atMs, n) => ({
  id: nextId++, trace_id: tid(n), source: objectId.split(':')[0], group_key: objectId.split(':')[0],
  object_id: objectId, kind, diff: { before, after }, at: iso(atMs),
});

function fixture() {
  const s = (k) => `jpl.scout:${k}`;
  return {
    changes: [
      change(s('OLD'), 'enter', null, { neoScore: 1 }, FROM - 3600000, 1),         // before the window
      change(s('A'), 'update', { neoScore: 10 }, { neoScore: 20 }, FROM + 60000, 2),
      change(s('B'), 'enter', null, { neoScore: 50 }, FROM + 120000, 3),
      change(s('A'), 'update', { neoScore: 20 }, { neoScore: 30 }, FROM + 180000, 4),
      change(s('C'), 'exit', { neoScore: 70 }, null, FROM + 240000, 5),
      change(s('A'), 'update', { neoScore: 30 }, { neoScore: 40 }, FROM + 2 * 3600000, 6), // after the window
      change('swpc.kp:planetary', 'update', { kp: 1 }, { kp: 2 }, FROM + 30000, 7),
    ],
    sky_objects: [
      skyRow('jpl.scout', 'A', { neoScore: 40 }, { traceId: tid(6) }),
      skyRow('jpl.scout', 'B', { neoScore: 50 }, { traceId: tid(3) }),
      skyRow('jpl.scout', 'C', { neoScore: 70 }, { traceId: tid(5), removedAt: iso(FROM + 240000) }),
      skyRow('jpl.scout', 'D', { neoScore: 90 }, { traceId: tid(8) }),               // unchanged for days
      skyRow('jpl.scout', 'GONE', { neoScore: 5 }, { traceId: tid(9), removedAt: iso(FROM - 7200000) }),
      skyRow('swpc.kp', 'planetary', { kp: 2 }, { traceId: tid(7) }),
    ],
  };
}

function setup(speed = 100, opts = {}) {
  const clock = createFakeClock(NOW);
  const fake = createFakeSupabase({ tables: fixture() });
  const records = [];
  let ended = 0;
  let u = 100;
  const sky = createReplay({
    client: fake.client, from: FROM, to: FROM + 3600000, speed, now: clock.now, timers: clock.timers,
    trace: (r) => records.push(r), uuid: () => tid(++u), onEnd: () => { ended++; }, ...opts,
  });
  const events = [];
  sky.on('*', (e) => events.push(e));
  return { clock, fake, sky, events, records, ended: () => ended };
}

test('the starting snapshot is the state at the window start', async () => {
  const { sky, events } = setup();
  await sky.follow(['jpl.scout']);
  const enters = events.filter((e) => e.type === 'enter');
  assert.deepEqual(enters.map((e) => [e.obj.id, e.obj.fields.neoScore]), [
    ['jpl.scout:A', 10], ['jpl.scout:C', 70], ['jpl.scout:D', 90],
  ]);
  assert.ok(enters.every((e) => e.initial === true && e.replay === true));
  assert.equal(enters.find((e) => e.obj.id === 'jpl.scout:D').traceId, tid(8));
  assert.equal(sky.mode, 'replay');
  sky.close();
});

test('window events play at the replay speed with original trace ids, then onEnd', async () => {
  const { sky, events, clock, ended } = setup(100);
  await sky.follow(['jpl.scout']);
  const live = () => events.filter((e) => e.type !== 'freshness' && !e.initial);
  await clock.advance(599);
  assert.equal(live().length, 0);
  await clock.advance(1);                                  // 60 s of replay time at 100×
  assert.deepEqual(live().map((e) => [e.type, e.obj.id, e.traceId]), [['update', 'jpl.scout:A', tid(2)]]);
  assert.equal(sky.now(), FROM + 60000);
  await clock.advance(1800);
  assert.deepEqual(live().map((e) => [e.type, e.obj.id, e.traceId]), [
    ['update', 'jpl.scout:A', tid(2)], ['enter', 'jpl.scout:B', tid(3)],
    ['update', 'jpl.scout:A', tid(4)], ['exit', 'jpl.scout:C', tid(5)],
  ]);
  assert.ok(live().every((e) => e.replay === true));
  assert.equal(ended(), 1, 'the change after the window end does not play');
  assert.deepEqual(sky.get('jpl.scout').map((o) => [o.id, o.fields.neoScore]), [
    ['jpl.scout:A', 30], ['jpl.scout:B', 50], ['jpl.scout:D', 90],
  ]);
  await clock.advance(10 * 3600000);
  assert.equal(ended(), 1);
  sky.close();
});

test('freshness is fresh for every source during replay', async () => {
  const { sky, events } = setup();
  await sky.follow(['jpl.scout']);
  const fresh = events.filter((e) => e.type === 'freshness');
  assert.equal(fresh.length, new Set(groupKeys()).size);
  assert.ok(fresh.every((e) => e.freshness.state === 'fresh' && e.replay === true));
  assert.equal(sky.freshness('celestrak.stations').state, 'fresh');
  sky.close();
});

test('replayed CHANGE records carry the replay speed', async () => {
  const { sky, records, clock } = setup(1000);
  await sky.follow(['jpl.scout']);
  await clock.advance(300);
  const rec = records.filter((r) => r.stage === 'CHANGE');
  assert.ok(rec.length >= 7);
  assert.ok(rec.every((r) => r.replay === 1000));
  assert.deepEqual(rec.find((r) => r.traceId === tid(5)).data.diff, { before: { neoScore: 70 }, after: null });
  sky.close();
});

test('the window query reads changes from the window start for the followed groups', async () => {
  const { sky, fake } = setup();
  await sky.follow(['jpl.scout', 'swpc.kp']);
  const q = fake.queries.find((x) => x.table === 'changes');
  assert.deepEqual(q.ops, [['in', 'group_key', ['jpl.scout', 'swpc.kp']], ['gte', 'at', iso(FROM)], ['order', 'at', true], ['order', 'id', true]]);
  assert.equal(sky.object('swpc.kp:planetary').fields.kp, 1);
  sky.close();
});

test('close stops playback; invalid options fail early', async () => {
  const { sky, events, clock } = setup();
  await sky.follow(['jpl.scout']);
  sky.close();
  const n = events.length;
  await clock.advance(3600000);
  assert.equal(events.length, n);
  const client = createFakeSupabase().client;
  assert.throws(() => createReplay({ client, from: FROM, speed: 50 }), /speed must be one of 1, 10, 100, 1000/);
  assert.throws(() => createReplay({ client, from: FROM, to: FROM - 1, speed: 10 }), /to must be after from/);
});
