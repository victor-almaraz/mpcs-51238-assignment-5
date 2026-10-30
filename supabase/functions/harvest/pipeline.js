import { fetchSource } from './fetch.js';
import { hashFields } from './hash.js';
import { NormalizeError, normalizers } from './normalizers/index.js';
import { byHost, isDue, onFailure, onSuccess } from './scheduler.js';

/** A tick stops starting requests after this many milliseconds. */
export const TICK_BUDGET_MS = 120_000;

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
      for (const o of objects) rows.push({ id: o.id, fields: o.fields, hash: await hashFields(o.fields) });
      const changed = await store.upsertObjects(entry.id, entry.group, rows, entry.full);
      rowsChanged = changed.length;
    } catch (err) {
      failure = { error: `${err instanceof NormalizeError ? 'normalize' : 'store'}: ${err.message}`, retryAfterSec: null };
    }
  }

  const finished = now();
  await store.insertRun({
    source_id: entry.id, started_at: iso(started), finished_at: iso(finished),
    ok: failure === null, rows_changed: rowsChanged, http_status: res.status || null,
    error: failure?.error ?? null,
  });
  if (failure === null) {
    await store.saveStatus(onSuccess(entry, finished));
    log.info({ source: entry.id, event: 'run', ok: true, rowsChanged, ms: finished - started });
  } else {
    const row = onFailure(entry, st, finished, failure);
    await store.saveStatus(row);
    if (row.halted) log.error({ source: entry.id, event: 'halt', status: res.status, error: failure.error });
    else log.warn({ source: entry.id, event: 'run', ok: false, status: res.status, error: failure.error, nextAttemptAt: row.next_attempt_at });
  }
  return { ok: failure === null, rowsChanged };
}

/**
 * One invocation: claim and run every due entry, one request per host at a time.
 * @param {{ registry: object[], isEnabled: (id: string) => boolean, store, fetch, userAgent: string, log, now?: () => number }} deps
 * @returns {Promise<{ ran: string[], skipped: string[] }>}
 */
export async function tick(deps) {
  const now = deps.now ?? Date.now;
  const deadline = now() + TICK_BUDGET_MS;
  const status = await deps.store.loadStatus();
  const due = deps.registry.filter((e) => isDue(e, status.get(e.id), now(), deps.isEnabled));
  const ran = [];
  const skipped = [];
  await Promise.all(byHost(due).map(async (entries) => {
    for (const entry of entries) {
      if (now() + entry.timeoutMs > deadline) { skipped.push(entry.id); continue; }
      const st = status.get(entry.id);
      try {
        if (!(await deps.store.claim(entry.id, entry.intervalSec, st?.last_attempt_at ?? null))) {
          skipped.push(entry.id);
          continue;
        }
        await runSource(entry, st, { ...deps, now });
        ran.push(entry.id);
      } catch (err) {
        deps.log.error({ source: entry.id, event: 'tick_error', error: String(err?.message ?? err) });
      }
    }
  }));
  return { ran, skipped };
}
