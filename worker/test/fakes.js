import { readFileSync } from 'node:fs';

export const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

/** In-memory store with the semantics of upsert_sky_objects and claim_source (doc/database.md). */
export function fakeStore() {
  const objects = new Map(); // id → { group, fields, hash, removedAt }
  const status = new Map();
  const runs = [];
  const samples = new Map();
  const changes = [];
  let traces = 0;
  return {
    objects, status, runs, samples, changes,
    async loadStatus() {
      return new Map([...status].map(([k, v]) => [k, { ...v }]));
    },
    async claim(sourceId, intervalSec, prev) {
      const st = status.get(sourceId);
      const at = new Date().toISOString();
      if (!st) {
        status.set(sourceId, { source_id: sourceId, interval_sec: intervalSec, last_attempt_at: at, halted: false, failures: 0 });
        return true;
      }
      if ((st.last_attempt_at ?? null) !== (prev ?? null) || st.halted) return false;
      st.last_attempt_at = at;
      return true;
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
