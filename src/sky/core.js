// Shared state of the live, replay and synthetic sky (doc/sky-contract.md).
import { loadingFreshness } from './freshness.js';
import { safeTrace as wrapTrace } from '../trace/bus.js';

/**
 * @typedef {{ id: string, source: string, group: string,
 *             fields: Readonly<Record<string, number | string | boolean | null>> }} SkyObject
 * @typedef {import('./freshness.js').Freshness} Freshness
 * @typedef {{ initial?: true, replay?: true, synthetic?: true }} EventFlags
 * @typedef {{ type: 'enter' | 'update' | 'exit', obj: SkyObject, prev: SkyObject | null,
 *             traceId: string } & EventFlags} SkyChangeEvent
 * @typedef {{ type: 'freshness', freshness: Freshness, replay?: true, synthetic?: true }} SkyFreshnessEvent
 * @typedef {SkyChangeEvent | SkyFreshnessEvent} SkyEvent
 * @typedef {SkyEvent['type'] | '*'} SkyEventType
 */

export const EVENT_TYPES = Object.freeze(['enter', 'update', 'exit', 'freshness', '*']);

/**
 * @param {string} id @param {string} source @param {string} group
 * @param {Record<string, number | string | boolean | null>} fields
 * @returns {SkyObject}
 */
export function makeObject(id, source, group, fields) {
  return Object.freeze({ id, source, group, fields: Object.freeze({ ...fields }) });
}

/**
 * @param {{ trace: (r: object) => unknown }} deps
 */
export function createCore({ trace }) {
  /** @type {Map<string, { obj: SkyObject, traceId: string, updatedAt: number }>} */
  const held = new Map();
  /** @type {Map<string, SkyObject[]>} */
  const groupCache = new Map();
  /** @type {Map<string, Set<(e: SkyEvent) => void>>} */
  const listeners = new Map(EVENT_TYPES.map((t) => [t, new Set()]));
  /** @type {Map<string, Freshness>} */
  const fresh = new Map();

  /** @param {SkyEventType} type @param {(e: SkyEvent) => void} fn */
  function on(type, fn) {
    const set = listeners.get(type);
    if (!set) throw new TypeError(`unknown sky event type ${JSON.stringify(type)}`);
    if (typeof fn !== 'function') throw new TypeError('sky.on expects a function');
    set.add(fn);
    return () => {
      set.delete(fn);
    };
  }

  /** @param {SkyEvent} e */
  function emit(e) {
    const targets = [...(listeners.get(e.type) ?? []), ...(listeners.get('*') ?? [])];
    for (const fn of targets) {
      try {
        fn(e);
      } catch (err) {
        safeTrace({
          traceId: 'traceId' in e ? e.traceId : 'sky',
          stage: 'REALTIME',
          component: 'sky',
          event: 'listener_error',
          level: 'error',
          data: { type: e.type, message: String(/** @type {Error} */ (err)?.message ?? err) },
        });
      }
    }
  }

  /** A broken trace sink must not stop the store. */
  const safeTrace = wrapTrace(trace, 'sky');

  /** @param {string} group */
  function get(group) {
    let list = groupCache.get(group);
    if (!list) {
      list = [];
      for (const h of held.values()) if (h.obj.group === group) list.push(h.obj);
      list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      Object.freeze(list);
      groupCache.set(group, list);
    }
    return list;
  }

  /** @param {string} id */
  function object(id) {
    return held.get(id)?.obj ?? null;
  }

  /** @param {string} id */
  function entry(id) {
    return held.get(id);
  }

  /**
   * Sets an object and returns its `enter` or `update` event; the caller emits it.
   * @param {SkyObject} obj @param {string} traceId @param {number} updatedAt @param {EventFlags} flags
   */
  function upsert(obj, traceId, updatedAt, flags = {}) {
    const prev = held.get(obj.id)?.obj ?? null;
    held.set(obj.id, { obj, traceId, updatedAt });
    groupCache.delete(obj.group);
    return /** @type {SkyChangeEvent} */ (Object.freeze({ type: prev ? 'update' : 'enter', obj, prev, traceId, ...flags }));
  }

  /**
   * Removes an object and returns its `exit` event (null when not held); the caller emits it.
   * @param {string} id @param {string} traceId @param {EventFlags} flags
   */
  function remove(id, traceId, flags = {}) {
    const h = held.get(id);
    if (!h) return null;
    held.delete(id);
    groupCache.delete(h.obj.group);
    return /** @type {SkyChangeEvent} */ (Object.freeze({ type: 'exit', obj: h.obj, prev: h.obj, traceId, ...flags }));
  }

  /** Drops a group's objects without events. @param {string} group */
  function dropGroup(group) {
    for (const [id, h] of held) if (h.obj.group === group) held.delete(id);
    groupCache.delete(group);
  }

  /** @returns {string[]} ids of held objects in a group */
  function idsOf(/** @type {string} */ group) {
    return get(group).map((o) => o.id);
  }

  /** @returns {Set<string>} groups with at least one held object */
  function heldGroups() {
    const s = new Set();
    for (const h of held.values()) s.add(h.obj.group);
    return s;
  }

  /**
   * Traces the CHANGE record of a change event.
   * @param {SkyChangeEvent} e @param {{ replay?: number }} [opts] replay speed
   */
  function traceChange(e, { replay } = {}) {
    const before = e.type === 'enter' ? null : e.prev?.fields ?? null;
    const after = e.type === 'exit' ? null : e.obj.fields;
    /** @type {Record<string, unknown>} */
    const data = { objectId: e.obj.id, group: e.obj.group, source: e.obj.source, kind: e.type, diff: { before, after } };
    if (e.initial) data.initial = true;
    /** @type {Record<string, unknown>} */
    const r = { traceId: e.traceId, stage: 'CHANGE', component: 'sky', event: e.type, level: 'info', data };
    if (replay !== undefined) r.replay = replay;
    if (e.synthetic) r.synthetic = true;
    safeTrace(r);
  }

  /** @param {string} source */
  function freshness(source) {
    return fresh.get(source) ?? Object.freeze(loadingFreshness(source));
  }

  function sources() {
    return [...fresh.values()].sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0));
  }

  /**
   * Stores freshness; emits when the state changed.
   * @param {Freshness} f @param {{ replay?: true, synthetic?: true }} [flags]
   */
  function setFreshness(f, flags = {}) {
    const before = fresh.get(f.source);
    const next = Object.freeze({ ...f });
    fresh.set(f.source, next);
    if (!before || before.state !== next.state) {
      if (!before && next.state === 'loading') return;
      emit(Object.freeze({ type: 'freshness', freshness: next, ...flags }));
    }
  }

  function clearAll() {
    held.clear();
    groupCache.clear();
  }

  return {
    on, emit, get, object, entry, upsert, remove, dropGroup, idsOf, heldGroups,
    freshness, sources, setFreshness, clearAll, safeTrace, traceChange,
  };
}
