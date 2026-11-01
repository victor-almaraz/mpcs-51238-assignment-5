// Live sky store: Realtime postgres_changes on sky_objects, REST select, source_status poll
// (doc/sky-contract.md; doc/database.md, Realtime publication; doc/auth.md, Realtime authentication).
import { trace as busTrace } from '../trace/bus.js';
import { createCore, makeObject } from './core.js';
import { EVALUATE_MS, STATUS_POLL_MS, evaluateFreshness } from './freshness.js';
import { GROUPS, groupKeys, groupOf, isGroup, sourceOf } from './groups.js';
import { parseSkyRow, parseStatusRow } from './validate.js';

export const PAGE_SIZE = 1000;
export const MAX_GROUPS = 100;
export const HIDDEN_CLOSE_MS = 60000;
export const BACKOFF_MIN_MS = 1000;
export const BACKOFF_MAX_MS = 30000;

export const SKY_COLUMNS = 'id,source,group_key,fields,trace_id,updated_at,removed_at';
/** Object ids per `.in('id', …)` lookup, which keeps the request URL short. */
const ID_CHUNK = 100;
const STATUS_COLUMNS = 'source_id,interval_sec,last_attempt_at,last_success_at,last_ok,halted';
const FAILURE_STATUSES = ['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'];

/**
 * @typedef {{ setTimeout: typeof setTimeout, clearTimeout: typeof clearTimeout,
 *             setInterval: typeof setInterval, clearInterval: typeof clearInterval }} Timers
 * @typedef {{ visibilityState: string, addEventListener: Function, removeEventListener?: Function }} VisibilityDoc
 * @typedef {import('./core.js').SkyObject} SkyObject
 * @typedef {import('./core.js').SkyEvent} SkyEvent
 */

const globalTimers = () => ({
  setTimeout: globalThis.setTimeout.bind(globalThis),
  clearTimeout: globalThis.clearTimeout.bind(globalThis),
  setInterval: globalThis.setInterval.bind(globalThis),
  clearInterval: globalThis.clearInterval.bind(globalThis),
});

/**
 * Validates a followed-group list.
 * @param {unknown} groups
 * @returns {string[]} sorted unique keys
 */
export function checkGroups(groups) {
  if (!Array.isArray(groups)) throw new TypeError('follow expects an array of group keys');
  const unique = [...new Set(groups)];
  for (const g of unique) {
    if (!isGroup(g)) throw new RangeError(`unknown group ${JSON.stringify(g)}; known groups: ${groupKeys().join(', ')}`);
  }
  if (unique.length > MAX_GROUPS) throw new RangeError(`follow accepts at most ${MAX_GROUPS} groups, got ${unique.length}`);
  return unique.sort();
}

/**
 * Selects every row of a query in pages.
 * @param {() => any} build returns a fresh query builder
 * @param {string} what
 */
export async function selectAll(build, what) {
  const out = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await build().range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`${what} select failed: ${error.message ?? String(error)}`);
    if (!Array.isArray(data)) throw new Error(`${what} select returned no rows array`);
    out.push(...data);
    if (data.length < PAGE_SIZE) return out;
  }
}

/**
 * Creates the live sky store.
 * @param {{ client: any, now?: () => number, timers?: Timers, doc?: VisibilityDoc | null,
 *           trace?: (r: object) => unknown, uuid?: () => string }} deps
 */
export function createSky({ client, now = Date.now, timers = globalTimers(), doc = globalThis.document ?? null, trace = busTrace, uuid = () => globalThis.crypto.randomUUID() }) {
  if (!client || typeof client.channel !== 'function' || typeof client.from !== 'function') {
    throw new TypeError('createSky needs a Supabase client with channel() and from()');
  }
  const core = createCore({ trace });

  /** @type {string[]} */
  let followed = [];
  let followGen = 0;
  /** @type {{ ch: any, token: object } | null} */
  let channel = null;
  /** @type {'idle' | 'subscribing' | 'subscribed' | 'error'} */
  let channelState = 'idle';
  /** Makes each channel topic unique (doc/sky-contract.md, Realtime). */
  let channelSeq = 0;
  /** @type {any[] | null} payloads received while a select is pending */
  let buffer = null;
  let backoffMs = BACKOFF_MIN_MS;
  /** @type {any} */
  let retryTimer = null;
  /** @type {any} */
  let hiddenTimer = null;
  let hiddenClosed = false;
  let closed = false;

  /** @type {Map<string, import('./validate.js').StatusRow>} */
  const status = new Map();
  /** @type {Map<string, import('./freshness.js').FreshState>} */
  const overrides = new Map();
  let synthetic = false;

  /** @param {string} event @param {Record<string, unknown>} data @param {'info' | 'warn' | 'error'} [level] @param {string} [traceId] */
  function note(event, data, level = 'info', traceId = 'sky') {
    core.safeTrace({ traceId, stage: 'REALTIME', component: 'sky', event, level, data });
  }

  // ---- Realtime channel ----

  /**
   * Subscribes to the followed groups. Resolves with the first status:
   * 'SUBSCRIBED' or a failure status.
   * @param {string[]} groups
   * @returns {Promise<string>}
   */
  function subscribe(groups) {
    teardown();
    const token = {};
    channelState = 'subscribing';
    return new Promise((resolve) => {
      let settled = false;
      const ch = client
        .channel(`sky:${groups.join(',')}:${++channelSeq}`)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'sky_objects', filter: `group_key=in.(${groups.join(',')})` },
          (/** @type {any} */ payload) => {
            if (channel?.token !== token) return;
            if (buffer) buffer.push(payload);
            else applyPayload(payload);
          },
        )
        .subscribe((/** @type {string} */ st, /** @type {any} */ err) => {
          if (channel?.token !== token) return;
          if (st === 'SUBSCRIBED') {
            channelState = 'subscribed';
            backoffMs = BACKOFF_MIN_MS;
            note('subscribed', { groups });
            evaluate();
          } else if (FAILURE_STATUSES.includes(st)) {
            channelState = 'error';
            note('channel_error', { status: st, message: err?.message ?? null }, 'warn');
            evaluate();
            if (settled) scheduleRetry();
          } else {
            return;
          }
          if (!settled) {
            settled = true;
            resolve(st);
          }
        });
      channel = { ch, token };
    });
  }

  function teardown() {
    if (!channel) return;
    const { ch } = channel;
    channel = null;
    channelState = 'idle';
    try {
      const p = client.removeChannel(ch);
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {
      // Removing a broken channel is best effort.
    }
  }

  function scheduleRetry() {
    if (closed || hiddenClosed || retryTimer !== null || followed.length === 0) return;
    teardown();
    channelState = 'error';
    try {
      const p = client.realtime?.setAuth?.();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {
      // setAuth failure surfaces as another channel error.
    }
    const delay = backoffMs;
    backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
    note('resubscribe', { delayMs: delay }, 'warn');
    retryTimer = timers.setTimeout(() => {
      retryTimer = null;
      follow(followed).catch(() => {});
    }, delay);
  }

  // ---- Applying rows and payloads ----

  /** @param {import('./core.js').SkyChangeEvent | null} e */
  function commit(e) {
    if (!e) return;
    core.traceChange(e);
    return e;
  }

  /** @param {any} payload */
  function applyPayload(payload) {
    if (closed) return;
    if (payload?.eventType === 'DELETE') {
      const id = payload.old?.id;
      if (typeof id === 'string' && core.entry(id)) emitChange(core.remove(id, uuid()), payload);
      return;
    }
    const parsed = parseSkyRow(payload?.new);
    if (!parsed.ok) {
      note('invalid_payload', { error: parsed.error }, 'error', typeof payload?.new?.trace_id === 'string' && payload.new.trace_id ? payload.new.trace_id : 'sky');
      return;
    }
    const row = parsed.value;
    if (!followed.includes(row.group)) return;
    const h = core.entry(row.id);
    if (h && (h.traceId === row.traceId || row.updatedAt < h.updatedAt)) return;
    if (row.removed) {
      if (h) emitChange(core.remove(row.id, row.traceId), payload);
      return;
    }
    emitChange(core.upsert(makeObject(row.id, row.source, row.group, row.fields), row.traceId, row.updatedAt), payload);
  }

  /** @param {import('./core.js').SkyChangeEvent | null} e @param {any} payload */
  function emitChange(e, payload) {
    if (!commit(e)) return;
    const ts = Date.parse(payload?.commit_timestamp);
    const e2 = /** @type {import('./core.js').SkyChangeEvent} */ (e);
    core.safeTrace({
      traceId: e2.traceId,
      stage: 'REALTIME',
      component: 'sky',
      event: payload?.eventType ?? 'UPDATE',
      level: 'info',
      data: { table: 'sky_objects', latencyMs: Number.isFinite(ts) ? Math.max(0, now() - ts) : null },
    });
    core.emit(e2);
  }

  /**
   * Applies a select result as a diff against the held objects.
   * @param {any[]} rows @param {Set<string>} knownGroups groups held before this follow
   */
  async function applySnapshot(rows, knownGroups) {
    const live = new Set();
    /** @type {import('./core.js').SkyChangeEvent[]} */
    const events = [];
    for (const raw of rows) {
      const p = parseSkyRow(raw);
      if (!p.ok) {
        note('invalid_row', { error: p.error }, 'error');
        continue;
      }
      const row = p.value;
      if (row.removed || !followed.includes(row.group)) continue;
      live.add(row.id);
      const h = core.entry(row.id);
      if (h && h.traceId === row.traceId) continue;
      if (h && row.updatedAt < h.updatedAt && !h.traceId.startsWith('syn-')) continue;
      const flags = !h && !knownGroups.has(row.group) ? { initial: /** @type {true} */ (true) } : {};
      events.push(core.upsert(makeObject(row.id, row.source, row.group, row.fields), row.traceId, row.updatedAt, flags));
    }
    events.sort((a, b) => (a.obj.id < b.obj.id ? -1 : 1));
    for (const e of events) {
      commit(e);
      core.emit(e);
    }

    const missing = [];
    for (const g of followed) for (const id of core.idsOf(g)) if (!live.has(id)) missing.push(id);
    if (missing.length === 0) return;
    /** @type {Map<string, string>} */
    const exitIds = new Map();
    for (let i = 0; i < missing.length; i += ID_CHUNK) {
      const chunk = missing.slice(i, i + ID_CHUNK);
      const { data, error } = await client.from('sky_objects').select('id,trace_id').in('id', chunk);
      if (error) {
        note('exit_lookup_failed', { message: error.message ?? String(error) }, 'warn');
        break;
      }
      for (const r of data ?? []) if (typeof r?.id === 'string' && typeof r?.trace_id === 'string') exitIds.set(r.id, r.trace_id);
    }
    for (const id of missing) {
      const h = core.entry(id);
      if (!h) continue;
      const traceId = exitIds.get(id);
      const e = core.remove(id, traceId && traceId !== h.traceId ? traceId : uuid());
      if (commit(e)) core.emit(/** @type {import('./core.js').SkyChangeEvent} */ (e));
    }
  }

  // ---- follow ----

  /**
   * Replaces the followed set: subscribes, selects live rows, applies buffered payloads.
   * @param {string[]} groups
   */
  async function follow(groups) {
    if (closed) throw new Error('sky store is closed');
    const next = checkGroups(groups);
    const gen = ++followGen;
    if (retryTimer !== null) {
      timers.clearTimeout(retryTimer);
      retryTimer = null;
    }
    const knownGroups = core.heldGroups();
    for (const g of knownGroups) if (!next.includes(g)) core.dropGroup(g);
    followed = next;
    if (next.length === 0) {
      teardown();
      buffer = null;
      evaluate();
      return;
    }
    if (hiddenClosed) return; // follow runs again when the tab is visible

    buffer = [];
    const st = await subscribe(next);
    if (gen !== followGen || closed) return;
    let rows;
    try {
      rows = await selectAll(
        () => client.from('sky_objects').select(SKY_COLUMNS).in('group_key', next).is('removed_at', null).order('id'),
        'sky_objects',
      );
    } catch (err) {
      if (gen === followGen) {
        buffer = null;
        note('select_failed', { message: /** @type {Error} */ (err).message }, 'error');
        scheduleRetry();
      }
      throw err;
    }
    if (gen !== followGen || closed) return;
    await applySnapshot(rows, knownGroups);
    if (gen !== followGen || closed) return;
    const pending = buffer ?? [];
    buffer = null;
    for (const p of pending) applyPayload(p);
    if (st !== 'SUBSCRIBED') scheduleRetry();
  }

  // ---- Freshness ----

  async function poll() {
    if (closed) return;
    let res;
    try {
      res = await client.from('source_status').select(STATUS_COLUMNS);
    } catch (err) {
      res = { data: null, error: err };
    }
    if (closed) return;
    if (res.error || !Array.isArray(res.data)) {
      note('status_poll_failed', { message: res.error?.message ?? 'no rows array' }, 'warn');
      return;
    }
    for (const raw of res.data) {
      const p = parseStatusRow(raw);
      if (p.ok) status.set(p.value.source, p.value);
      else note('invalid_status', { error: p.error }, 'warn');
    }
    evaluate();
  }

  function evaluate() {
    if (closed) return;
    const followedSources = new Set(followed.map((g) => /** @type {string} */ (sourceOf(g))));
    const all = new Set([...status.keys(), ...followedSources, ...overrides.keys()]);
    const t = now();
    for (const src of [...all].sort()) {
      const f = evaluateFreshness(src, status.get(src), t, {
        channelDown: channelState === 'error' && followedSources.has(src),
      });
      const o = overrides.get(src);
      if (o) core.setFreshness({ ...f, state: o }, { synthetic: true });
      else core.setFreshness(f);
    }
  }

  // ---- Visibility ----

  function onVisibility() {
    if (closed || !doc) return;
    if (doc.visibilityState === 'hidden') {
      if (hiddenTimer === null && !hiddenClosed) {
        hiddenTimer = timers.setTimeout(() => {
          hiddenTimer = null;
          hiddenClosed = true;
          followGen++;
          buffer = null;
          if (retryTimer !== null) {
            timers.clearTimeout(retryTimer);
            retryTimer = null;
          }
          teardown();
          note('closed_hidden', { groups: followed });
          evaluate();
        }, HIDDEN_CLOSE_MS);
      }
    } else {
      if (hiddenTimer !== null) {
        timers.clearTimeout(hiddenTimer);
        hiddenTimer = null;
      }
      if (hiddenClosed) {
        hiddenClosed = false;
        follow(followed).catch(() => {});
      }
    }
  }
  doc?.addEventListener?.('visibilitychange', onVisibility);

  // ---- Synthetic hooks (src/sky/synthetic.js) ----

  /**
   * Applies a synthetic operation to this tab's store.
   * @param {{ op: 'enter' | 'update' | 'exit', id: string, fields?: Record<string, any>, traceId: string }
   *       | { op: 'freshness', source: string, state: import('./freshness.js').FreshState | null }} s
   */
  function injectSynthetic(s) {
    synthetic = true;
    if (s.op === 'freshness') {
      if (s.state === null) overrides.delete(s.source);
      else overrides.set(s.source, s.state);
      evaluate();
      return;
    }
    const flags = { synthetic: /** @type {true} */ (true) };
    const h = core.entry(s.id);
    /** @type {import('./core.js').SkyChangeEvent | null} */
    let e;
    if (s.op === 'exit') {
      if (!h) throw new RangeError(`synthetic exit: object ${s.id} is not held`);
      e = core.remove(s.id, s.traceId, flags);
    } else {
      const group = groupOf(s.id);
      if (group === null || !isGroup(group)) throw new RangeError(`synthetic ${s.op}: unknown group in ${s.id}`);
      if (s.op === 'update' && !h) throw new RangeError(`synthetic update: object ${s.id} is not held`);
      if (s.op === 'enter' && h) throw new RangeError(`synthetic enter: object ${s.id} is already held`);
      const fields = s.op === 'update' ? { ...h?.obj.fields, ...s.fields } : { ...s.fields };
      e = core.upsert(makeObject(s.id, GROUPS[group].source, group, fields), s.traceId, now(), flags);
    }
    if (commit(e)) core.emit(/** @type {import('./core.js').SkyChangeEvent} */ (e));
  }

  function clearSynthetic() {
    overrides.clear();
    synthetic = false;
    evaluate();
    return follow(followed);
  }

  // ---- Lifecycle ----

  function close() {
    if (closed) return;
    closed = true;
    followGen++;
    for (const t of [retryTimer, hiddenTimer]) if (t !== null) timers.clearTimeout(t);
    retryTimer = hiddenTimer = null;
    timers.clearInterval(pollTimer);
    timers.clearInterval(evalTimer);
    teardown();
    doc?.removeEventListener?.('visibilitychange', onVisibility);
  }

  const pollTimer = timers.setInterval(() => { poll(); }, STATUS_POLL_MS);
  const evalTimer = timers.setInterval(evaluate, EVALUATE_MS);
  poll();

  return {
    on: core.on,
    get: core.get,
    object: core.object,
    freshness: core.freshness,
    sources: core.sources,
    follow,
    followed: () => [...followed],
    get mode() {
      return synthetic ? 'synthetic' : 'live';
    },
    close,
    /** @internal used by createSynthetic */
    _synthetic: { inject: injectSynthetic, clear: clearSynthetic, now },
    /** @internal state for tests and the console */
    get channelState() {
      return channelState;
    },
  };
}
