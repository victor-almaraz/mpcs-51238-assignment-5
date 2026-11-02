// Sky sources for expressions (doc/bindings.md, Aggregates): `swpc`, `value`, `count`, `mean`,
// `spread`. Reads the live objects of a group from the sky store and caches each result until
// an event arrives in that group.

import { objectGroup, swpcPath } from '../expr/deps.js';

/**
 * @param {{ get(group: string): { id: string, fields: Record<string, unknown> }[] }} sky
 */
export function createSkyResolvers(sky) {
  /** @type {Map<string, Map<string, unknown>>} group → cache key → value */
  const cache = new Map();

  const cached = (group, key, compute) => {
    let g = cache.get(group);
    if (!g) { g = new Map(); cache.set(group, g); }
    if (!g.has(key)) g.set(key, compute());
    return g.get(key);
  };
  const numbers = (group, field) => sky.get(group)
    .map((o) => o.fields?.[field])
    .filter((v) => typeof v === 'number' && Number.isFinite(v));

  return {
    /** @param {string} path */
    swpc(path) {
      const { group, field } = swpcPath(path);
      return cached(group, `swpc:${field}`, () => {
        const objs = sky.get(group);
        return objs.length ? (objs[0].fields?.[field] ?? null) : null;
      });
    },
    /** @param {string} objectId @param {string} field */
    value(objectId, field) {
      const group = objectGroup(objectId);
      return cached(group, `value:${objectId}\u0000${field}`, () => {
        const o = sky.get(group).find((x) => x.id === objectId);
        return o ? (o.fields?.[field] ?? null) : null;
      });
    },
    /** @param {string} group */
    count(group) {
      return cached(group, 'count', () => sky.get(group).length);
    },
    /** @param {string} group @param {string} field */
    mean(group, field) {
      return cached(group, `mean:${field}`, () => {
        const xs = numbers(group, field);
        return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
      });
    },
    /** @param {string} group @param {string} field */
    spread(group, field) {
      return cached(group, `spread:${field}`, () => {
        const xs = numbers(group, field);
        return xs.length ? Math.max(...xs) - Math.min(...xs) : null;
      });
    },
    /** Drops the cached results of a group. Call on every event in that group. */
    invalidate(group) { cache.delete(group); },
  };
}
