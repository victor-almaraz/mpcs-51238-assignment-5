import { fetchSource } from './fetch.js';
import { hashFields } from './hash.js';
import { NormalizeError, normalizers } from './normalizers/index.js';
import { byHost, isDue, onFailure, onSuccess } from './scheduler.js';

/** A tick stops starting requests after this many milliseconds. */
export const TICK_BUDGET_MS = 120_000;
/** Host lease lifetime: the tick budget plus time for the last writes (doc/worker.md, Invocation model). */
export const HOST_LEASE_SEC = 150;

/**
 * Fetch, normalize and store one registry entry. Records exactly one `runs` row.
 * @param {object} entry validated registry entry
 * @param {object | undefined} st source_status row read before the claim
 * @param {{ store, fetch, userAgent: string, log, now: () => number }} deps
 * @returns {Promise<{ ok: boolean, rowsChanged: number }>}
 */
export async function runSource(entry, st, { store, fetch, userAgent, log, now }) {
  const started = now();
  const iso = (t) => new Date(t).toISOString();
  const res = await fetchSource(entry.url, { fetch, userAgent, timeoutMs: entry.timeoutMs });
  const fetchedAt = now();
  let failure = null;
  let rowsChanged = 0;

  if (res.status !== 200) {
    failure = { error: res.error ?? `HTTP ${res.status}: ${res.body.slice(0, 200)}`, retryAfterSec: res.retryAfterSec };
  } else {
    try {
      await store.saveSample(entry.id, iso(fetchedAt), res.status, res.body);
      const ctx = {
        source: entry.id, group: entry.group,
        warn: (fields) => log.warn({ source: entry.id, ...fields }),
      };
      const objects = normalizers[entry.normalizer](res.body, entry.normalizerArgs, ctx);
      const rows = [];
      const seen = new Set();
      for (const o of objects) {
        if (seen.has(o.id)) throw new NormalizeError(`duplicate object id ${o.id}`);
        seen.add(o.id);
      }
      for (const o of objects) rows.push({ id: o.id, fields: o.fields, hash: await hashFields(o.fields) });
      const changed = await store.upsertObjects(entry.id, entry.group, rows, entry.full);
      rowsChanged = changed.length;
    } catch (err) {
      failure = { error: `${err instanceof NormalizeError ? 'normalize' : 'store'}: ${err.message}`, retryAfterSec: null };
    }
  }

  // Status before the run row, so a halt is saved even if the runs insert fails.
  const finished = now();
  const row = failure === null ? onSuccess(entry, finished) : onFailure(entry, st, finished, failure);
  await store.saveStatus(row);
  await store.insertRun({
    source_id: entry.id, started_at: iso(started), finished_at: iso(finished),
    ok: failure === null, rows_changed: rowsChanged, http_status: res.status || null,
    error: failure?.error ?? null,
  });
  if (failure === null) {
    log.info({ source: entry.id, event: 'run', ok: true, rowsChanged, ms: finished - started });
  } else {
    if (row.halted) log.error({ source: entry.id, event: 'halt', status: res.status, error: failure.error });
    else log.warn({ source: entry.id, event: 'run', ok: false, status: res.status, error: failure.error, nextAttemptAt: row.next_attempt_at });
  }
  return { ok: failure === null, rowsChanged };
}

/**
 * Claim one entry (doc/database.md, Claim RPC). Returns whether it may run.
 * @param {object} entry @param {object | undefined} st @param {{ store, log }} deps
 */
export async function claimEntry(entry, st, { store, log }) {
  const result = await store.claim(entry.id, entry.intervalSec, st?.last_attempt_at ?? null, entry.onNon200 === 'halt');
  if (result === 'halted') log.error({ source: entry.id, event: 'halt', error: 'previous run did not record its result' });
  return result === 'claimed';
}

/**
 * One invocation: claim and run every due entry, one request per host at a time across
 * overlapping invocations (each host's queue runs under a lease).
 * @param {{ registry: object[], isEnabled: (id: string) => boolean, store, fetch, userAgent: string, log, now?: () => number, holder?: string }} deps
 * @returns {Promise<{ ran: string[], skipped: string[], failed: string[] }>} `failed`: runs that did not succeed
 */
export async function tick(deps) {
  const now = deps.now ?? Date.now;
  const deadline = now() + TICK_BUDGET_MS;
  const status = await deps.store.loadStatus();
  const due = deps.registry.filter((e) => isDue(e, status.get(e.id), now(), deps.isEnabled));
  const ran = [];
  const skipped = [];
  const failed = [];
  const holder = deps.holder ?? crypto.randomUUID();
  const errorText = (err) => String(err?.message ?? err);
  await Promise.all(byHost(due).map(async (entries) => {
    const host = entries[0].host;
    let leased = false;
    try {
      leased = await deps.store.claimHost(host, holder, HOST_LEASE_SEC);
    } catch (err) {
      deps.log.error({ host, event: 'tick_error', error: errorText(err) });
    }
    if (!leased) { skipped.push(...entries.map((e) => e.id)); return; }
    try {
      for (const entry of entries) {
        if (now() + entry.timeoutMs > deadline) { skipped.push(entry.id); continue; }
        const st = status.get(entry.id);
        try {
          if (!(await claimEntry(entry, st, deps))) {
            skipped.push(entry.id);
            continue;
          }
          const { ok } = await runSource(entry, st, { ...deps, now });
          ran.push(entry.id);
          if (!ok) failed.push(entry.id);
        } catch (err) {
          deps.log.error({ source: entry.id, event: 'tick_error', error: errorText(err) });
          failed.push(entry.id);
        }
      }
    } finally {
      await deps.store.releaseHost(host, holder).catch((err) => deps.log.error({ host, event: 'tick_error', error: errorText(err) }));
    }
  }));
  return { ran, skipped, failed };
}
