import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { normalizers } from '../../supabase/functions/harvest/normalizers/index.js';
import { runSource, tick } from '../../supabase/functions/harvest/pipeline.js';
import { loadRegistry } from '../../supabase/functions/harvest/registry.js';
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
