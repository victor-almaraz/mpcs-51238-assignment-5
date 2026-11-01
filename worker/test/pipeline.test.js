import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { normalizers } from '../../supabase/functions/harvest/normalizers/index.js';
import { runOnce, runSource, tick } from '../../supabase/functions/harvest/pipeline.js';
import { loadRegistry } from '../../supabase/functions/harvest/registry.js';
import { createStore, truncateSample } from '../../supabase/functions/harvest/store.js';
import { clock, fakeFetch, fakeStore, fixture, silentLog } from './fakes.js';

const sources = JSON.parse(readFileSync(new URL('../../supabase/functions/harvest/sources.json', import.meta.url), 'utf8'));
const registry = loadRegistry(sources, { normalizers, vars: { LL2_BASE: 'https://ll.example.test/2.3.0' } });
const entry = (id) => registry.find((e) => e.id === id);
const UA = 'Sphaerenmusik/0.1.0 (test@example.test)';

function setup(routes, start = '2026-10-30T03:00:00Z') {
  const now = clock(start);
  const store = fakeStore({ now });
  const log = silentLog();
  const fetch = fakeFetch(routes);
  const deps = { registry, isEnabled: () => true, store, fetch, userAgent: UA, log, now };
  return { store, log, now, fetch, deps };
}
const ok = (file) => ({ status: 200, body: fixture(file) });

test('a NUL-padded SWPC body is stored and normalized without its NUL bytes', async () => {
  const e = entry('swpc.wind');
  const { store, deps } = setup({ [e.url]: [ok('swpc-wind-nul.json')] });
  assert.deepEqual(await runSource(e, undefined, deps), { ok: true, rowsChanged: 1 });
  assert.equal(store.samples.get(e.id).body.includes('\u0000'), false);
  assert.equal(store.runs.at(-1).ok, true);
});

test('a CelesTrak record with a non-numeric required element halts the group instead of storing null', async () => {
  const e = entry('celestrak.stations');
  const records = JSON.parse(fixture('celestrak-stations-1.json'));
  records[0].MEAN_MOTION = 'abc';
  const { store, deps } = setup({ [e.url]: [{ status: 200, body: JSON.stringify(records) }] });
  assert.deepEqual(await runSource(e, undefined, deps), { ok: false, rowsChanged: 0 });
  assert.match(store.runs.at(-1).error, /^normalize: OMM record 0 MEAN_MOTION/);
  assert.equal(store.status.get(e.id).halted, true);
  assert.equal(store.objects.size, 0);
});

test('first run enters every object; identical second run changes 0 rows', async () => {
  const e = entry('celestrak.stations');
  const { store, deps } = setup({ [e.url]: [ok('celestrak-stations-1.json'), ok('celestrak-stations-2.json')] });
  assert.deepEqual(await runSource(e, undefined, deps), { ok: true, rowsChanged: 20 });
  assert.ok(store.changes.every((c) => c.kind === 'enter'));
  assert.deepEqual(await runSource(e, undefined, deps), { ok: true, rowsChanged: 0 });
  assert.equal(store.runs.length, 2);
  assert.deepEqual(store.runs.map((r) => [r.ok, r.rows_changed, r.http_status]), [[true, 20, 200], [true, 0, 200]]);
});

test('a response differing in one field yields exactly one update with its diff', async () => {
  const e = entry('celestrak.stations');
  const doc = JSON.parse(fixture('celestrak-stations-1.json'));
  doc[0].MEAN_MOTION = 15.5;
  const { store, deps } = setup({ [e.url]: [ok('celestrak-stations-1.json'), { status: 200, body: JSON.stringify(doc) }] });
  await runSource(e, undefined, deps);
  const before = store.changes.length;
  assert.deepEqual(await runSource(e, undefined, deps), { ok: true, rowsChanged: 1 });
  const [c] = store.changes.slice(before);
  assert.equal(c.kind, 'update');
  assert.equal(c.objectId, 'celestrak.stations:25544');
  assert.equal(c.diff.before.meanMotion, 15.49100842);
  assert.equal(c.diff.after.meanMotion, 15.5);
});

test('SWPC wind: two real captures give one update', async () => {
  const e = entry('swpc.wind');
  const { store, deps } = setup({ [e.url]: [ok('swpc-wind-1.json'), ok('swpc-wind-2.json')] });
  await runSource(e, undefined, deps);
  assert.deepEqual(await runSource(e, undefined, deps), { ok: true, rowsChanged: 1 });
  assert.equal(store.changes.at(-1).kind, 'update');
  assert.equal(store.changes.at(-1).diff.after.speed, 314.7);
});

test('a full-group response missing one object yields one exit', async () => {
  const e = entry('celestrak.stations');
  const doc = JSON.parse(fixture('celestrak-stations-1.json'));
  const { store, deps } = setup({ [e.url]: [ok('celestrak-stations-1.json'), { status: 200, body: JSON.stringify(doc.slice(1)) }] });
  await runSource(e, undefined, deps);
  assert.deepEqual(await runSource(e, undefined, deps), { ok: true, rowsChanged: 1 });
  assert.deepEqual(store.changes.at(-1), { objectId: 'celestrak.stations:25544', kind: 'exit', traceId: store.changes.at(-1).traceId, diff: store.changes.at(-1).diff });
  assert.equal(store.changes.at(-1).diff.after, null);
});

test('the raw body is sampled, truncated to 64 KB', async () => {
  const e = entry('swpc.wind');
  const { store, deps } = setup({ [e.url]: [ok('swpc-wind-1.json')] });
  await runSource(e, undefined, deps);
  assert.equal(store.samples.get('swpc.wind').body.length, 65536);
});

test('requests carry the ASCII User-Agent', async () => {
  const e = entry('swpc.kp');
  const { fetch, deps } = setup({ [e.url]: [ok('swpc-kp-1.json')] });
  await runSource(e, undefined, deps);
  assert.equal(fetch.calls[0].headers['User-Agent'], UA);
});

test('CelesTrak 403 halts the source and no further fetch is made', async () => {
  const e = entry('celestrak.stations');
  const { store, log, fetch, now, deps } = setup({ [e.url]: [{ status: 403, body: fixture('celestrak-403.txt') }] });
  deps.registry = [e];
  await tick(deps);
  assert.equal(store.status.get(e.id).halted, true);
  assert.equal(store.runs.at(-1).ok, false);
  assert.equal(store.runs.at(-1).http_status, 403);
  assert.ok(log.lines.some((l) => l.level === 'error' && l.event === 'halt' && l.status === 403));
  now.advance(86400);
  await tick(deps);
  assert.equal(fetch.calls.length, 1);
});

test('CelesTrak HTTP 200 with a text body halts too', async () => {
  const e = entry('celestrak.visual');
  const { store, deps } = setup({ [e.url]: [{ status: 200, body: fixture('celestrak-no-data.txt') }] });
  deps.registry = [e];
  await tick(deps);
  assert.equal(store.status.get(e.id).halted, true);
  assert.match(store.runs[0].error, /^normalize:/);
});

test('LL2 429 waits Retry-After', async () => {
  const e = entry('ll2.upcoming');
  const { store, now, fetch, deps } = setup({ [e.url]: [{ status: 429, body: fixture('ll2-429.json'), headers: { 'Retry-After': '1200' } }, ok('ll2-upcoming-1.json')] });
  deps.registry = [e];
  await tick(deps);
  assert.equal(Date.parse(store.status.get(e.id).next_attempt_at) - now(), 1200_000);
  now.advance(1199);
  await tick(deps);
  assert.equal(fetch.calls.length, 1);
  now.advance(1);
  await tick(deps);
  assert.equal(fetch.calls.length, 2);
  assert.equal(store.status.get(e.id).failures, 0);
});

test('LL2 429 without Retry-After waits 3600 s', async () => {
  const e = entry('ll2.upcoming');
  const { store, now, deps } = setup({ [e.url]: [{ status: 429, body: '{}' }] });
  deps.registry = [e];
  await tick(deps);
  assert.equal(Date.parse(store.status.get(e.id).next_attempt_at) - now(), 3600_000);
});

test('other failures back off exponentially up to maxBackoffSec', async () => {
  const e = entry('swpc.kp');
  const { store, now, deps } = setup({ [e.url]: [new TypeError('connection reset')] });
  deps.registry = [e];
  const waits = [];
  for (let i = 0; i < 6; i++) {
    await tick(deps);
    const st = store.status.get(e.id);
    const wait = (Date.parse(st.next_attempt_at) - now()) / 1000;
    waits.push(wait);
    now.advance(wait);
  }
  assert.deepEqual(waits, [120, 240, 480, 900, 900, 900]);
  assert.equal(store.runs.length, 6);
  assert.ok(store.runs.every((r) => r.ok === false && r.http_status === null && /^network:/.test(r.error)));
});

test('every run inserts exactly one runs row', async () => {
  const routes = {};
  for (const e of registry) routes[e.url] = [{ status: 200, body: '[]' }];
  routes[entry('swpc.kp').url] = [ok('swpc-kp-1.json')];
  const { store, deps } = setup(routes);
  const { ran } = await tick(deps);
  assert.equal(ran.length, registry.length);
  assert.equal(store.runs.length, registry.length);
  assert.equal(store.runs.find((r) => r.source_id === 'swpc.kp').rows_changed, 1);
});

test('a claim taken by an overlapping invocation skips the entry', async () => {
  const e = entry('swpc.kp');
  const { store, fetch, deps } = setup({ [e.url]: [ok('swpc-kp-1.json')] });
  deps.registry = [e];
  const realClaim = store.claim;
  store.claim = async (...args) => { await realClaim(...args); return realClaim(...args); };
  const { ran, skipped } = await tick(deps);
  assert.deepEqual([ran, skipped], [[], ['swpc.kp']]);
  assert.equal(fetch.calls.length, 0);
});

test('requests to one host run one at a time', async () => {
  let open = 0;
  let maxOpen = 0;
  const swpc = registry.filter((e) => e.id.startsWith('swpc.'));
  const fetch = async (url) => {
    open++; maxOpen = Math.max(maxOpen, open);
    await new Promise((r) => setTimeout(r, 5));
    open--;
    return new Response(fixture(url.includes('kp') ? 'swpc-kp-1.json' : url.includes('wind') ? 'swpc-wind-1.json' : 'swpc-mag-1.json'));
  };
  const { store, deps } = setup({});
  await tick({ ...deps, fetch, registry: swpc });
  assert.equal(maxOpen, 1);
  assert.equal(store.runs.length, 3);
});

test('overlapping ticks never have two requests open to one host', async () => {
  const cel = registry.filter((e) => e.host === 'celestrak.org');
  assert.ok(cel.length > 1);
  let open = 0;
  let maxOpen = 0;
  const fetch = async () => {
    open++; maxOpen = Math.max(maxOpen, open);
    await new Promise((r) => setTimeout(r, 20));
    open--;
    return new Response(fixture('celestrak-stations-1.json'));
  };
  const { store, deps } = setup({});
  const a = tick({ ...deps, fetch, registry: cel, holder: 'a' });
  await new Promise((r) => setTimeout(r, 25));
  const b = tick({ ...deps, fetch, registry: cel, holder: 'b' });
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(maxOpen, 1);
  assert.deepEqual(rb.ran, []);
  assert.equal(ra.ran.length, cel.length);
  assert.equal(store.leases.size, 0, 'leases are released');
});

test('a CelesTrak 403 halts even when the runs insert fails', async () => {
  const e = entry('celestrak.stations');
  const { store, fetch, now, deps } = setup({ [e.url]: [{ status: 403, body: fixture('celestrak-403.txt') }] });
  deps.registry = [e];
  store.insertRun = async () => { throw new Error('insert runs: boom'); };
  await tick(deps);
  assert.equal(store.status.get(e.id).halted, true);
  now.advance(86400);
  await tick(deps);
  assert.equal(fetch.calls.length, 1);
});

test('a CelesTrak run that never records its result halts at the next claim', async () => {
  const e = entry('celestrak.stations');
  const { store, log, fetch, now, deps } = setup({ [e.url]: [ok('celestrak-stations-1.json')] });
  deps.registry = [e];
  store.saveStatus = async () => { throw new Error('upsert source_status: boom'); };
  await tick(deps);
  assert.equal(fetch.calls.length, 1);
  assert.ok(store.status.get(e.id).in_flight_at);
  now.advance(86400);
  await tick(deps);
  assert.equal(fetch.calls.length, 1, 'no second fetch');
  assert.equal(store.status.get(e.id).halted, true);
  assert.ok(log.lines.some((l) => l.level === 'error' && l.event === 'halt'));
});

test('a CelesTrak claim within the interval is refused, even without the due check', async () => {
  const e = entry('celestrak.stations');
  const { store, now, deps } = setup({ [e.url]: [ok('celestrak-stations-1.json')] });
  assert.equal(await store.claim(e.id, e.intervalSec, null, true), 'claimed');
  await runSource(e, undefined, deps);
  now.advance(60);
  assert.equal(await store.claim(e.id, e.intervalSec, store.status.get(e.id).last_attempt_at, true), 'busy');
});

test('CelesTrak 200 with [] halts instead of removing the group', async () => {
  const e = entry('celestrak.stations');
  const { store, now, deps } = setup({ [e.url]: [ok('celestrak-stations-1.json'), { status: 200, body: '[]' }] });
  deps.registry = [e];
  await tick(deps);
  now.advance(e.intervalSec);
  await tick(deps);
  assert.equal(store.status.get(e.id).halted, true);
  assert.ok(store.changes.every((c) => c.kind === 'enter'));
  assert.match(store.runs.at(-1).error, /^normalize:/);
});

test('rows that are not objects and duplicate ids are normalize errors', async () => {
  const e = entry('celestrak.stations');
  const one = JSON.parse(fixture('celestrak-stations-1.json'))[0];
  for (const body of ['[null]', '[1]', JSON.stringify([one, one])]) {
    const { store, deps } = setup({ [e.url]: [{ status: 200, body }] });
    await runSource(e, undefined, deps);
    assert.match(store.runs[0].error, /^normalize:/, body.slice(0, 20));
    assert.equal(store.status.get(e.id).halted, true);
  }
});

test('an unexpected exception in a normalizer is labelled normalize:, not store:', async () => {
  const e = { ...entry('swpc.kp'), normalizer: 'testBoom' };
  normalizers.testBoom = () => { throw new TypeError("Cannot read properties of undefined (reading 'kp')"); };
  try {
    const { store, deps } = setup({ [e.url]: [ok('swpc-kp-1.json')] });
    assert.deepEqual(await runSource(e, undefined, deps), { ok: false, rowsChanged: 0 });
    assert.equal(store.runs.at(-1).error, "normalize: Cannot read properties of undefined (reading 'kp')");
    assert.ok(store.samples.has(e.id), 'the sample is saved before normalizing');
  } finally {
    delete normalizers.testBoom;
  }
});

test('database errors while saving the sample or the objects are labelled store:', async () => {
  const e = entry('swpc.kp');
  const a = setup({ [e.url]: [ok('swpc-kp-1.json')] });
  a.store.saveSample = async () => { throw new Error('upsert source_samples: boom'); };
  a.store.upsertObjects = async () => { throw new Error('must not be called'); };
  assert.deepEqual(await runSource(e, undefined, a.deps), { ok: false, rowsChanged: 0 });
  assert.equal(a.store.runs.at(-1).error, 'store: upsert source_samples: boom');

  const b = setup({ [e.url]: [ok('swpc-kp-1.json')] });
  b.store.upsertObjects = async () => { throw new Error('upsert_sky_objects: boom'); };
  assert.deepEqual(await runSource(e, undefined, b.deps), { ok: false, rowsChanged: 0 });
  assert.equal(b.store.runs.at(-1).error, 'store: upsert_sky_objects: boom');
});

test('a host lease that cannot be claimed because of a database error counts as failed, not skipped', async () => {
  const swpc = registry.filter((e) => e.host === 'services.swpc.noaa.gov');
  const { store, log, fetch, deps } = setup({});
  store.claimHost = async () => { throw new Error('claim_host: connection refused'); };
  const { ran, skipped, failed } = await tick({ ...deps, registry: swpc });
  assert.deepEqual([ran, skipped], [[], []]);
  assert.deepEqual(failed.sort(), swpc.map((e) => e.id).sort());
  assert.equal(fetch.calls.length, 0);
  assert.ok(log.lines.some((l) => l.level === 'error' && l.event === 'tick_error' && /connection refused/.test(l.error)));
});

test('runOnce takes and releases the host lease, and reports a held lease as host_busy', async () => {
  const e = entry('swpc.kp');
  const { store, fetch, now, deps } = setup({ [e.url]: [ok('swpc-kp-1.json')] });
  store.leases.set(e.host, { holder: 'other', expiresAt: now() + 60_000 });
  assert.deepEqual(await runOnce(e, { ...deps, holder: 'cli' }), { result: 'host_busy', ok: false });
  assert.equal(fetch.calls.length, 0);
  assert.equal(store.leases.get(e.host).holder, 'other', 'the other lease is untouched');

  store.leases.clear();
  let leaseDuringFetch = null;
  const spy = async (...args) => { leaseDuringFetch = store.leases.get(e.host)?.holder; return fetch(...args); };
  assert.deepEqual(await runOnce(e, { ...deps, fetch: spy, holder: 'cli' }), { result: 'ran', ok: true });
  assert.equal(leaseDuringFetch, 'cli');
  assert.equal(store.leases.size, 0, 'the lease is released');
  assert.equal(store.runs.length, 1);
});

test('runOnce refuses a halted entry without taking the lease or fetching', async () => {
  const e = entry('celestrak.stations');
  const { store, fetch, deps } = setup({ [e.url]: [ok('celestrak-stations-1.json')] });
  store.status.set(e.id, { source_id: e.id, halted: true, failures: 1 });
  let leased = false;
  store.claimHost = async () => { leased = true; return true; };
  assert.deepEqual(await runOnce(e, deps), { result: 'halted', ok: false });
  assert.equal(leased, false);
  assert.equal(fetch.calls.length, 0);
});

test('Retry-After is capped at maxBackoffSec and accepts an HTTP date', async () => {
  const e = entry('ll2.upcoming');
  assert.equal(e.maxBackoffSec, 3600);
  const a = setup({ [e.url]: [{ status: 429, body: '{}', headers: { 'Retry-After': '86400' } }] });
  a.deps.registry = [e];
  await tick(a.deps);
  assert.equal(Date.parse(a.store.status.get(e.id).next_attempt_at) - a.now(), 3600_000);

  // The fake clock starts at real time here, because fetchSource compares an HTTP date with Date.now().
  const start = new Date(Math.ceil(Date.now() / 1000) * 1000).toISOString();
  const date = new Date(Date.parse(start) + 600_000).toUTCString();
  const b = setup({ [e.url]: [{ status: 429, body: '{}', headers: { 'Retry-After': date } }] }, start);
  b.deps.registry = [e];
  await tick(b.deps);
  const wait = (Date.parse(b.store.status.get(e.id).next_attempt_at) - b.now()) / 1000;
  assert.ok(wait >= 600 && wait <= 601, `wait ${wait}`);
});

test('a sample cut at 64 KB never ends in half a surrogate pair', async () => {
  const e = entry('swpc.kp');
  const body = `${'x'.repeat(65535)}\u{1F680}${fixture('swpc-kp-1.json')}`;
  assert.equal(body.slice(0, 65536).isWellFormed(), false, 'a plain slice would split the pair');
  const { store, deps } = setup({ [e.url]: [{ status: 200, body }] });
  await runSource(e, undefined, deps);
  const saved = store.samples.get(e.id).body;
  assert.equal(saved.length, 65535);
  assert.ok(saved.isWellFormed());
});

test('createStore saves the sample truncated at a code-point boundary', async () => {
  let row;
  const client = { from: () => ({ upsert: async (r) => { row = r; return { data: null, error: null }; } }) };
  await createStore(client).saveSample('swpc.kp', '2026-10-30T03:00:00.000Z', 200, `${'x'.repeat(65535)}\u{1F680}`);
  assert.equal(row.body.length, 65535);
  assert.ok(row.body.isWellFormed());
  assert.equal(truncateSample('ab\u{1F680}', 4), 'ab\u{1F680}');
  assert.equal(truncateSample('ab\u{1F680}', 3), 'ab');
  assert.equal(truncateSample('abc', 2), 'ab');
});

test('clearing a halt lets the next tick fetch again; an unknown id reports no row', async () => {
  const e = entry('celestrak.stations');
  const { store, fetch, now, deps } = setup({ [e.url]: [{ status: 403, body: fixture('celestrak-403.txt') }, ok('celestrak-stations-1.json')] });
  deps.registry = [e];
  await tick(deps);
  assert.equal(store.status.get(e.id).halted, true);
  now.advance(e.intervalSec);
  await tick(deps);
  assert.equal(fetch.calls.length, 1, 'halted: no fetch');
  assert.equal(await store.clearHalt(e.id), true);
  const st = store.status.get(e.id);
  assert.deepEqual([st.halted, st.failures, st.next_attempt_at, st.in_flight_at], [false, 0, null, null]);
  const { ran } = await tick(deps);
  assert.deepEqual(ran, [e.id]);
  assert.equal(fetch.calls.length, 2);
  assert.equal(store.runs.at(-1).ok, true);
  assert.equal(await store.clearHalt('celestrak.nope'), false);
});
