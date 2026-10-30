import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateFreshness } from '../src/sky/freshness.js';
import { createSky } from '../src/sky/store.js';
import { createFakeClock } from './fakes/fake-clock.js';
import { createFakeSupabase } from './fakes/fake-supabase.js';

const T0 = Date.parse('2026-10-29T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

/** A parsed status row. */
const row = (o = {}) => ({
  source: 'swpc.wind', intervalSec: 60, lastAttemptAt: iso(T0), lastSuccessAt: iso(T0), lastOk: true, halted: false, ...o,
});

test('loading without a status row', () => {
  assert.deepEqual(evaluateFreshness('swpc.wind', undefined, T0), { source: 'swpc.wind', state: 'loading', lastRun: null, lastSuccess: null });
});

test('stale begins after 3 × interval_sec without success', () => {
  assert.equal(evaluateFreshness('swpc.wind', row(), T0 + 180000).state, 'fresh');
  assert.equal(evaluateFreshness('swpc.wind', row(), T0 + 180001).state, 'stale');
  // CelesTrak: 7500 s → 6 h 15 min.
  const ct = row({ source: 'celestrak.stations', intervalSec: 7500 });
  assert.equal(evaluateFreshness('celestrak.stations', ct, T0 + (6 * 3600 + 15 * 60) * 1000).state, 'fresh');
  assert.equal(evaluateFreshness('celestrak.stations', ct, T0 + (6 * 3600 + 15 * 60) * 1000 + 1).state, 'stale');
  assert.equal(evaluateFreshness('swpc.wind', row({ lastSuccessAt: null }), T0).state, 'stale');
});

test('down when halted, when last_ok is false, or on channel error', () => {
  assert.equal(evaluateFreshness('swpc.wind', row({ halted: true }), T0).state, 'down');
  assert.equal(evaluateFreshness('swpc.wind', row({ lastOk: false }), T0).state, 'down');
  assert.equal(evaluateFreshness('swpc.wind', row({ lastOk: false }), T0 + 1e9).state, 'down', 'down outranks stale');
  assert.equal(evaluateFreshness('swpc.wind', row(), T0, { channelDown: true }).state, 'down');
  assert.equal(evaluateFreshness('swpc.wind', row({ lastOk: null }), T0).state, 'fresh');
});

test('lastRun and lastSuccess come from the status row', () => {
  const f = evaluateFreshness('swpc.wind', row({ lastAttemptAt: iso(T0 + 5), lastSuccessAt: iso(T0) }), T0);
  assert.equal(f.lastRun, iso(T0 + 5));
  assert.equal(f.lastSuccess, iso(T0));
});

function statusRow(o = {}) {
  return {
    source_id: 'swpc.wind', interval_sec: 60, last_attempt_at: iso(T0), last_success_at: iso(T0),
    last_ok: true, halted: false, failures: 0, next_attempt_at: null, ...o,
  };
}

function setup(statusRows, { autoSubscribe = true } = {}) {
  const clock = createFakeClock(T0);
  const fake = createFakeSupabase({ tables: { source_status: statusRows }, autoSubscribe });
  const records = [];
  const sky = createSky({ client: fake.client, now: clock.now, timers: clock.timers, doc: null, trace: (r) => records.push(r) });
  const events = [];
  sky.on('freshness', (e) => events.push(e.freshness));
  return { clock, fake, sky, events, records };
}

test('the store polls source_status every 30 s and evaluates every 5 s, emitting on state change', async () => {
  const { clock, fake, sky, events } = setup([statusRow(), statusRow({ source_id: 'jpl.scout', interval_sec: 900 })]);
  assert.equal(sky.freshness('swpc.wind').state, 'loading');
  await clock.advance(0);
  assert.equal(sky.freshness('swpc.wind').state, 'fresh');
  assert.deepEqual(events.map((f) => [f.source, f.state]), [['jpl.scout', 'fresh'], ['swpc.wind', 'fresh']]);
  assert.deepEqual(sky.sources().map((f) => f.source), ['jpl.scout', 'swpc.wind']);

  // No new success: stale after 180 s, detected by the 5 s evaluation.
  await clock.advance(180000);
  assert.equal(sky.freshness('swpc.wind').state, 'fresh');
  await clock.advance(5000);
  assert.equal(sky.freshness('swpc.wind').state, 'stale');
  assert.equal(events.at(-1).source, 'swpc.wind');
  assert.equal(events.filter((f) => f.source === 'swpc.wind').length, 2);

  // The worker recovers; the next poll returns a fresh row.
  fake.db.source_status[0] = statusRow({ last_success_at: iso(clock.now()), last_attempt_at: iso(clock.now()) });
  await clock.advance(30000);
  assert.equal(sky.freshness('swpc.wind').state, 'fresh');

  // The worker halts the source.
  fake.db.source_status[0] = statusRow({ last_success_at: iso(clock.now()), halted: true });
  await clock.advance(30000);
  assert.equal(sky.freshness('swpc.wind').state, 'down');
  const polls = fake.queries.filter((q) => q.table === 'source_status').length;
  assert.equal(polls, 1 + Math.floor((clock.now() - T0) / 30000));
  sky.close();
});

test('a channel error shows followed sources as down until the channel recovers', async () => {
  const { clock, fake, sky } = setup([statusRow(), statusRow({ source_id: 'swpc.kp' })], { autoSubscribe: false });
  await clock.advance(0);
  const done = sky.follow(['swpc.wind']);
  await clock.advance(0);
  fake.live().status('CHANNEL_ERROR');
  await done;
  assert.equal(sky.freshness('swpc.wind').state, 'down');
  assert.equal(sky.freshness('swpc.kp').state, 'fresh', 'unfollowed source is unaffected');
  await clock.advance(1000);
  fake.live().status('SUBSCRIBED');
  await clock.advance(0);
  assert.equal(sky.freshness('swpc.wind').state, 'fresh');
  sky.close();
});

test('a failed poll keeps the previous rows; invalid rows are dropped and traced', async () => {
  const { clock, fake, sky, records } = setup([statusRow(), { source_id: 'bad', interval_sec: -1, halted: false }]);
  await clock.advance(0);
  assert.equal(sky.freshness('swpc.wind').state, 'fresh');
  assert.equal(sky.freshness('bad').state, 'loading');
  assert.ok(records.some((r) => r.event === 'invalid_status'));
  fake.failNext('source_status', 'offline');
  await clock.advance(30000);
  assert.equal(sky.freshness('swpc.wind').state, 'fresh');
  assert.ok(records.some((r) => r.event === 'status_poll_failed' && r.level === 'warn'));
  sky.close();
});

test('close stops polling', async () => {
  const { clock, fake, sky } = setup([statusRow()]);
  await clock.advance(0);
  sky.close();
  const n = fake.queries.length;
  await clock.advance(120000);
  assert.equal(fake.queries.length, n);
  await assert.rejects(sky.follow(['swpc.kp']), /closed/);
});
