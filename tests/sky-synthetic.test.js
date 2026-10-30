import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSky } from '../src/sky/store.js';
import { createSynthetic } from '../src/sky/synthetic.js';
import { createFakeClock } from './fakes/fake-clock.js';
import { createFakeSupabase, skyRow } from './fakes/fake-supabase.js';

const T0 = Date.parse('2026-10-29T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

async function setup() {
  const clock = createFakeClock(T0);
  const fake = createFakeSupabase({
    tables: {
      sky_objects: [skyRow('jpl.scout', 'A', { neoScore: 1 }, { traceId: '00000000-0000-4000-8000-000000000001' })],
      source_status: [{ source_id: 'swpc.wind', interval_sec: 60, last_attempt_at: iso(T0), last_success_at: iso(T0), last_ok: true, halted: false }],
    },
  });
  const records = [];
  const sky = createSky({ client: fake.client, now: clock.now, timers: clock.timers, doc: null, trace: (r) => records.push(r) });
  await sky.follow(['jpl.scout', 'swpc.wind']);
  await clock.advance(0);
  const events = [];
  sky.on('*', (e) => events.push(e));
  let n = 0;
  const syn = createSynthetic(sky, { uuid: () => `u${++n}` });
  return { clock, fake, sky, syn, events, records };
}

test('synthetic enter, update and exit carry synthetic: true and syn- trace ids', async () => {
  const { sky, syn, events, records, fake } = await setup();
  const queriesBefore = fake.queries.length;
  const id = syn.enter('jpl.scout', 'SYN1', { neoScore: 99, objectName: 'SYN1' });
  assert.equal(id, 'jpl.scout:SYN1');
  syn.update(id, { neoScore: 42 });
  syn.update('jpl.scout:A', { phaScore: 7 });
  syn.exit(id);
  assert.deepEqual(events.map((e) => [e.type, e.obj.id, e.traceId, e.synthetic]), [
    ['enter', id, 'syn-u1', true], ['update', id, 'syn-u2', true],
    ['update', 'jpl.scout:A', 'syn-u3', true], ['exit', id, 'syn-u4', true],
  ]);
  assert.deepEqual(events[1].obj.fields, { neoScore: 42, objectName: 'SYN1' });
  assert.deepEqual(sky.object('jpl.scout:A').fields, { neoScore: 1, phaScore: 7 });
  assert.equal(sky.object('jpl.scout:A').source, 'jpl.scout');
  assert.equal(sky.mode, 'synthetic');
  assert.ok(records.filter((r) => r.traceId.startsWith('syn-')).every((r) => r.synthetic === true));
  assert.equal(fake.queries.length, queriesBefore, 'synthetic events do not touch the database');
});

test('a synthetic freshness state holds through evaluations until cleared', async () => {
  const { sky, syn, events, clock } = await setup();
  syn.freshness('swpc.wind', 'stale');
  assert.equal(sky.freshness('swpc.wind').state, 'stale');
  assert.deepEqual(events.map((e) => [e.type, e.freshness?.state, e.synthetic]), [['freshness', 'stale', true]]);
  await clock.advance(60000);
  assert.equal(sky.freshness('swpc.wind').state, 'stale');
  await syn.clear();
  assert.equal(sky.freshness('swpc.wind').state, 'fresh');
  assert.equal(sky.mode, 'live');
});

test('clear reloads the database rows and removes synthetic objects', async () => {
  const { sky, syn, events } = await setup();
  syn.enter('jpl.scout', 'SYN1', { neoScore: 99 });
  syn.update('jpl.scout:A', { neoScore: 50 });
  events.length = 0;
  await syn.clear();
  assert.deepEqual(events.map((e) => [e.type, e.obj.id, e.synthetic ?? false]), [
    ['update', 'jpl.scout:A', false], ['exit', 'jpl.scout:SYN1', false],
  ]);
  assert.deepEqual(sky.object('jpl.scout:A').fields, { neoScore: 1 });
});

test('invalid synthetic input fails early', async () => {
  const { syn } = await setup();
  assert.throws(() => syn.enter('nope', 'x', {}), /unknown group/);
  assert.throws(() => syn.enter('jpl.scout', '', {}), /key/);
  assert.throws(() => syn.enter('jpl.scout', 'A', {}), /already held/);
  assert.throws(() => syn.update('jpl.scout:Z', {}), /not held/);
  assert.throws(() => syn.exit('jpl.scout:Z'), /not held/);
  assert.throws(() => syn.enter('jpl.scout', 'X', { v: NaN }), /finite/);
  assert.throws(() => syn.freshness('swpc.wind', 'sleepy'), /state/);
  assert.throws(() => createSynthetic({}), /live sky store/);
});
