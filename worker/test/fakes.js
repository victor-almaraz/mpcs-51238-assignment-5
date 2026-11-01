import { readFileSync } from 'node:fs';

export const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

/**
 * In-memory store with the semantics of upsert_sky_objects, claim_source and claim_host (doc/database.md).
 * `now` stands in for the database clock, so claims agree with the test clock.
 */
export function fakeStore({ now = Date.now } = {}) {
  const objects = new Map(); // id → { group, fields, hash, removedAt }
  const status = new Map();
  const runs = [];
  const samples = new Map();
  const changes = [];
  const leases = new Map(); // host → { holder, expiresAt }
  let traces = 0;
  return {
    objects, status, runs, samples, changes, leases,
    async loadStatus() {
      return new Map([...status].map(([k, v]) => [k, { ...v }]));
    },
    async claim(sourceId, intervalSec, prev, haltPolicy) {
      const st = status.get(sourceId);
      const t = now();
      const at = new Date(t).toISOString();
      const inFlight = haltPolicy ? at : null;
      if (haltPolicy && st && !st.halted && st.in_flight_at && Date.parse(st.in_flight_at) < t - 600_000) {
        Object.assign(st, { halted: true, last_ok: false, in_flight_at: null });
        runs.push({ source_id: sourceId, ok: false, error: 'previous run did not record its result; halted' });
        return 'halted';
      }
      if (!st) {
        status.set(sourceId, { source_id: sourceId, interval_sec: intervalSec, last_attempt_at: at, halted: false, failures: 0, in_flight_at: inFlight });
        return 'claimed';
      }
      if ((st.last_attempt_at ?? null) !== (prev ?? null) || st.halted) return 'busy';
      if (haltPolicy && (st.in_flight_at || (st.last_success_at && Date.parse(st.last_success_at) > t - intervalSec * 1000))) return 'busy';
      Object.assign(st, { last_attempt_at: at, interval_sec: intervalSec, in_flight_at: inFlight });
      return 'claimed';
    },
    async claimHost(host, holder, ttlSec) {
      const l = leases.get(host);
      if (l && l.expiresAt > now() && l.holder !== holder) return false;
      leases.set(host, { holder, expiresAt: now() + ttlSec * 1000 });
      return true;
    },
    async releaseHost(host, holder) {
      if (leases.get(host)?.holder === holder) leases.delete(host);
    },
    async upsertObjects(source, group, rows, full) {
      const out = [];
      const incoming = new Set(rows.map((r) => r.id));
      for (const r of rows) {
        const prev = objects.get(r.id);
        if (prev && prev.hash === r.hash && prev.removedAt === null) continue;
        const kind = !prev || prev.removedAt !== null ? 'enter' : 'update';
        const traceId = `t${++traces}`;
        changes.push({ objectId: r.id, kind, traceId, diff: { before: prev?.fields ?? null, after: r.fields } });
        objects.set(r.id, { group, fields: r.fields, hash: r.hash, removedAt: null });
        out.push({ objectId: r.id, kind, traceId });
      }
      if (full) {
        for (const [id, o] of objects) {
          if (o.group !== group || o.removedAt !== null || incoming.has(id)) continue;
          o.removedAt = new Date().toISOString();
          const traceId = `t${++traces}`;
          changes.push({ objectId: id, kind: 'exit', traceId, diff: { before: o.fields, after: null } });
          out.push({ objectId: id, kind: 'exit', traceId });
        }
      }
      return out;
    },
    async saveSample(sourceId, fetchedAt, httpStatus, body) {
      // Like Postgres text: a NUL byte is rejected.
      if (body.includes('\u0000')) throw new Error('upsert source_samples: unsupported Unicode escape sequence');
      samples.set(sourceId, { fetchedAt, httpStatus, body: body.slice(0, 65536) });
    },
    async insertRun(run) {
      runs.push(run);
    },
    async saveStatus(row) {
      status.set(row.source_id, { ...(status.get(row.source_id) ?? { halted: false, failures: 0 }), ...row });
    },
  };
}

/** fetch that serves queued responses per URL and records every request. */
export function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, headers: init?.headers ?? {} });
    const queue = routes[url];
    if (!queue || queue.length === 0) throw new TypeError(`fake fetch: no response queued for ${url}`);
    const r = queue.length > 1 ? queue.shift() : queue[0];
    if (r instanceof Error) throw r;
    return new Response(r.body, { status: r.status ?? 200, headers: r.headers ?? {} });
  };
  fn.calls = calls;
  return fn;
}

export function silentLog() {
  const lines = [];
  const rec = (level) => (fields) => lines.push({ level, ...fields });
  return { lines, debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') };
}

export function clock(startIso) {
  let t = Date.parse(startIso);
  const now = () => t;
  now.advance = (sec) => { t += sec * 1000; };
  return now;
}
