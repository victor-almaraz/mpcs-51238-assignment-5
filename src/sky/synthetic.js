// Synthetic triggers for the ?dev=1 panel (doc/sky-contract.md, Synthetic triggers).
import { isGroup } from './groups.js';

const STATES = ['loading', 'fresh', 'stale', 'down'];

/**
 * @param {ReturnType<typeof import('./store.js').createSky>} sky live store
 * @param {{ uuid?: () => string }} [opts]
 */
export function createSynthetic(sky, { uuid = () => globalThis.crypto.randomUUID() } = {}) {
  const hooks = sky?._synthetic;
  if (!hooks) throw new TypeError('createSynthetic needs a live sky store from createSky');
  const traceId = () => `syn-${uuid()}`;

  return {
    /**
     * @param {string} group @param {string} key
     * @param {Record<string, number | string | boolean | null>} fields
     * @returns {string} the object id
     */
    enter(group, key, fields = {}) {
      if (!isGroup(group)) throw new RangeError(`unknown group ${JSON.stringify(group)}`);
      if (typeof key !== 'string' || key === '') throw new TypeError('synthetic key must be a non-empty string');
      const id = `${group}:${key}`;
      hooks.inject({ op: 'enter', id, fields: checkFields(fields), traceId: traceId() });
      return id;
    },
    /** @param {string} objectId @param {Record<string, number | string | boolean | null>} fields */
    update(objectId, fields) {
      hooks.inject({ op: 'update', id: objectId, fields: checkFields(fields), traceId: traceId() });
    },
    /** @param {string} objectId */
    exit(objectId) {
      hooks.inject({ op: 'exit', id: objectId, traceId: traceId() });
    },
    /**
     * Holds a source's freshness state until clear(); null releases one source.
     * @param {string} source @param {'loading' | 'fresh' | 'stale' | 'down' | null} state
     */
    freshness(source, state) {
      if (typeof source !== 'string' || source === '') throw new TypeError('synthetic source must be a non-empty string');
      if (state !== null && !STATES.includes(state)) throw new RangeError(`freshness state must be one of ${STATES.join(', ')}`);
      hooks.inject({ op: 'freshness', source, state });
    },
    /** Removes overrides and reloads the followed groups from the database. */
    clear() {
      return hooks.clear();
    },
  };
}

/** @param {unknown} fields */
function checkFields(fields) {
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) throw new TypeError('synthetic fields must be an object');
  for (const [k, v] of Object.entries(fields)) {
    const ok = v === null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v));
    if (!ok) throw new TypeError(`synthetic field ${k} must be a finite number, string, boolean or null`);
  }
  return /** @type {Record<string, number | string | boolean | null>} */ (fields);
}
