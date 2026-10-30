// Replay of recorded changes through the Sky interface (doc/sky-contract.md, Replay mode).
import { trace as busTrace } from '../trace/bus.js';
import { createCore, makeObject } from './core.js';
import { groupKeys, sourceOf } from './groups.js';
import { checkGroups, selectAll } from './store.js';
import { parseChangeRow, parseSkyRow } from './validate.js';

export const REPLAY_SPEEDS = Object.freeze([1, 10, 100, 1000]);
export const RETENTION_MS = 7 * 86400000;

const CHANGE_COLUMNS = 'id,trace_id,source,group_key,object_id,kind,diff,at';
const SKY_COLUMNS = 'id,source,group_key,fields,trace_id,updated_at,removed_at';

/**
 * @param {{ client: any, from: number, to?: number, speed: number, now?: () => number,
 *           timers?: { setTimeout: typeof setTimeout, clearTimeout: typeof clearTimeout },
 *           trace?: (r: object) => unknown, uuid?: () => string, onEnd?: () => void }} opts
 */
export function createReplay({
  client, from, to, speed, now = Date.now,
  timers = { setTimeout: globalThis.setTimeout.bind(globalThis), clearTimeout: globalThis.clearTimeout.bind(globalThis) },
  trace = busTrace, uuid = () => globalThis.crypto.randomUUID(), onEnd,
}) {
  if (!client || typeof client.from !== 'function') throw new TypeError('createReplay needs a Supabase client');
  if (!REPLAY_SPEEDS.includes(speed)) throw new RangeError(`replay speed must be one of ${REPLAY_SPEEDS.join(', ')}, got ${speed}`);
  if (!Number.isFinite(from)) throw new TypeError('replay from must be ms since epoch');
  if (to !== undefined && !(Number.isFinite(to) && to > from)) throw new RangeError('replay to must be after from');

  const core = createCore({ trace });
  /** @type {string[]} */
  let followed = [];
  let gen = 0;
  /** @type {any} */
  let timer = null;
  let closed = false;
  let ended = false;
  /** @type {number | null} wall-clock start of playback */
  let startWall = null;
  /** @type {import('./validate.js').ChangeRow[]} */
  let queue = [];
  let cursor = 0;

  const flags = { replay: /** @type {true} */ (true) };

  /** Replay clock, ms since epoch. */
  function replayNow() {
    return startWall === null ? from : from + (now() - startWall) * speed;
  }

  function stop() {
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
  }

  /** @param {import('./core.js').SkyChangeEvent | null} e */
  function commit(e) {
    if (!e) return;
    core.traceChange(e, { replay: speed });
    core.emit(e);
  }

  /** @param {import('./validate.js').ChangeRow} c */
  function play(c) {
    if (c.kind === 'exit') {
      commit(core.remove(c.objectId, c.traceId, flags));
    } else {
      commit(core.upsert(makeObject(c.objectId, c.source, c.group, /** @type {any} */ (c.after)), c.traceId, c.at, flags));
    }
  }

  function schedule() {
    if (closed) return;
    if (cursor >= queue.length) {
      if (!ended) {
        ended = true;
        core.safeTrace({ traceId: 'replay', stage: 'REALTIME', component: 'sky', event: 'replay_end', level: 'info', data: { from, to: windowEnd() }, replay: speed });
        onEnd?.();
      }
      return;
    }
    const due = /** @type {number} */ (startWall) + (queue[cursor].at - from) / speed;
    timer = timers.setTimeout(() => {
      timer = null;
      const t = now();
      while (cursor < queue.length && /** @type {number} */ (startWall) + (queue[cursor].at - from) / speed <= t) {
        play(queue[cursor++]);
      }
      schedule();
    }, Math.max(0, due - now()));
  }

  let end = to;
  function windowEnd() {
    return /** @type {number} */ (end);
  }

  /**
   * Loads the window for the groups and starts playback.
   * @param {string[]} groups
   */
  async function follow(groups) {
    if (closed) throw new Error('replay is closed');
    const next = checkGroups(groups);
    const g = ++gen;
    stop();
    ended = false;
    startWall = null;
    core.clearAll();
    followed = next;
    if (end === undefined) end = now();
    if (from < now() - RETENTION_MS) {
      core.safeTrace({ traceId: 'replay', stage: 'REALTIME', component: 'sky', event: 'replay_window_retention', level: 'warn', data: { from }, replay: speed });
    }

    for (const k of groupKeys()) {
      const source = /** @type {string} */ (sourceOf(k));
      core.setFreshness({ source, state: 'fresh', lastRun: null, lastSuccess: null }, flags);
    }
    if (next.length === 0) return;

    const isoFrom = new Date(from).toISOString();
    const [changeRows, skyRows] = await Promise.all([
      selectAll(() => client.from('changes').select(CHANGE_COLUMNS).in('group_key', next).gte('at', isoFrom).order('at').order('id'), 'changes'),
      selectAll(() => client.from('sky_objects').select(SKY_COLUMNS).in('group_key', next).order('id'), 'sky_objects'),
    ]);
    if (g !== gen || closed) return;

    /** @type {import('./validate.js').ChangeRow[]} */
    const changes = [];
    for (const raw of changeRows) {
      const p = parseChangeRow(raw);
      if (p.ok) changes.push(p.value);
      else core.safeTrace({ traceId: 'replay', stage: 'REALTIME', component: 'sky', event: 'invalid_change', level: 'error', data: { error: p.error }, replay: speed });
    }
    changes.sort((a, b) => a.at - b.at || a.id - b.id);

    // Starting snapshot: state at `from`.
    /** @type {Map<string, import('./validate.js').ChangeRow>} */
    const first = new Map();
    for (const c of changes) if (!first.has(c.objectId)) first.set(c.objectId, c);
    /** @type {{ id: string, source: string, group: string, fields: any, traceId: string }[]} */
    const snapshot = [];
    for (const [id, c] of first) {
      if (c.before) snapshot.push({ id, source: c.source, group: c.group, fields: c.before, traceId: uuid() });
    }
    for (const raw of skyRows) {
      const p = parseSkyRow(raw);
      if (!p.ok || first.has(p.value.id) || p.value.removed) continue;
      snapshot.push({ id: p.value.id, source: p.value.source, group: p.value.group, fields: p.value.fields, traceId: p.value.traceId });
    }
    snapshot.sort((a, b) => (a.id < b.id ? -1 : 1));
    for (const s of snapshot) {
      commit(core.upsert(makeObject(s.id, s.source, s.group, s.fields), s.traceId, from, { ...flags, initial: true }));
    }

    queue = changes.filter((c) => c.at < /** @type {number} */ (end));
    cursor = 0;
    startWall = now();
    schedule();
  }

  function close() {
    closed = true;
    gen++;
    stop();
  }

  return {
    on: core.on,
    get: core.get,
    object: core.object,
    freshness: core.freshness,
    sources: core.sources,
    follow,
    followed: () => [...followed],
    get mode() {
      return 'replay';
    },
    close,
    now: replayNow,
    speed,
    from,
    get to() {
      return end ?? null;
    },
    get ended() {
      return ended;
    },
  };
}
