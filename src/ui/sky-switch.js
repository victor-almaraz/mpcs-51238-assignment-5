// A Sky facade (doc/sky-contract.md, API) whose underlying store can be replaced, so the binding
// runtime, the renderer and the propagator keep one subscription while the page switches between
// live and replay. On a switch the facade emits `exit` for every object it held, then follows the
// same groups on the new store, whose first snapshot arrives as `initial` enters.

import { createCore } from '../sky/core.js';

/**
 * @param {any} initial a store from createSky or createReplay
 * @param {{ uuid?: () => string, onError?: (err: unknown, e: any) => void }} [opts]
 */
export function createSkySwitch(initial, { uuid = () => globalThis.crypto.randomUUID(), onError = () => {} } = {}) {
  let current = initial;
  /** @type {Map<string, Set<(e: any) => void>>} */
  const listeners = new Map();
  let unsub = attach(current);

  /** @param {any} e */
  function dispatch(e) {
    for (const key of [e.type, '*']) {
      for (const fn of [...(listeners.get(key) ?? [])]) {
        try { fn(e); } catch (err) { onError(err, e); }
      }
    }
  }

  /** @param {any} store */
  function attach(store) {
    return store.on('*', dispatch);
  }

  return {
    /** @param {string} type @param {(e: any) => void} fn */
    on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)?.add(fn);
      return () => { listeners.get(type)?.delete(fn); };
    },
    /** @param {string} group */
    get: (group) => current.get(group),
    /** @param {string} id */
    object: (id) => current.object(id),
    /** @param {string} source */
    freshness: (source) => current.freshness(source),
    sources: () => current.sources(),
    /** @param {string[]} groups */
    follow: (groups) => current.follow(groups),
    followed: () => current.followed(),
    get mode() { return current.mode; },
    get current() { return current; },
    /**
     * Replaces the underlying store. The caller closes the previous one.
     * @param {any} next
     * @returns {Promise<void>} resolves when `next` has followed the groups
     */
    use(next) {
      if (next === current) return Promise.resolve();
      const groups = current.followed();
      unsub();
      const traceId = `switch-${uuid()}`;
      for (const g of groups) {
        for (const obj of current.get(g)) dispatch({ type: 'exit', obj, prev: obj, traceId });
      }
      current = next;
      unsub = attach(current);
      return groups.length ? current.follow(groups) : Promise.resolve();
    },
    close() {
      unsub();
      current.close();
      listeners.clear();
    },
  };
}

/**
 * A store with no data source, used when the Supabase client cannot be created: it follows
 * groups without objects and reports no sources, so a piece still runs and synthetic-free
 * previews still render.
 */
export function createNullSky() {
  const core = createCore({ trace: () => {} });
  /** @type {string[]} */
  let followed = [];
  return {
    on: core.on,
    get: core.get,
    object: core.object,
    freshness: core.freshness,
    sources: core.sources,
    /** @param {string[]} groups */
    follow(groups) { followed = [...new Set(groups)].sort(); return Promise.resolve(); },
    followed: () => [...followed],
    mode: 'live',
    close() {},
  };
}
