// Group registry helpers over src/sky/groups.json (doc/sky-contract.md, Groups).
import groupsJson from './groups.json' with { type: 'json' };

/**
 * @typedef {{ type: 'number' | 'string' | 'boolean', unit: string }} FieldDef
 * @typedef {{ source: string, class: 'step' | 'random-walk', orbit: boolean, fields: Record<string, FieldDef> }} GroupDef
 */

/** @type {Readonly<Record<string, GroupDef>>} */
export const GROUPS = /** @type {any} */ (groupsJson);

/** @returns {string[]} every group key, registry order */
export function groupKeys() {
  return Object.keys(GROUPS);
}

/** @param {string} group */
export function isGroup(group) {
  return typeof group === 'string' && Object.hasOwn(GROUPS, group);
}

/**
 * Registry id of a group.
 * @param {string} group
 * @returns {string | null}
 */
export function sourceOf(group) {
  return isGroup(group) ? GROUPS[group].source : null;
}

/** @param {string} group */
export function hasOrbit(group) {
  return isGroup(group) && GROUPS[group].orbit === true;
}

/**
 * Group key of an object id `${group}:${key}`.
 * @param {string} objectId
 * @returns {string | null}
 */
export function groupOf(objectId) {
  if (typeof objectId !== 'string') return null;
  const i = objectId.indexOf(':');
  return i > 0 ? objectId.slice(0, i) : null;
}
