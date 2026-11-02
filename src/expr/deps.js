// Static dependencies of an expression: which sky events and posts can change its value.

import { isNode } from './evaluate.js';

/**
 * Group of an object id `<group>:<key>`, such as `celestrak.stations:25544` → `celestrak.stations`.
 * Group keys contain no `:`.
 * @param {string} objectId
 * @returns {string}
 */
export function objectGroup(objectId) {
  const i = objectId.indexOf(':');
  return i < 0 ? objectId : objectId.slice(0, i);
}

/** An SWPC path `<product>.<field>`: `kp.kp`, `wind.speed`, `mag.bz`. */
const SWPC_PATH = /^([A-Za-z0-9-]+)\.([A-Za-z0-9_]+)$/;

/**
 * Group and field of an SWPC path, or null when `path` is not one.
 * @param {unknown} path
 * @returns {{ group: string, field: string } | null}
 */
export function parseSwpcPath(path) {
  const m = typeof path === 'string' ? SWPC_PATH.exec(path) : null;
  return m ? { group: `swpc.${m[1]}`, field: m[2] } : null;
}

/**
 * Group and field of an SWPC path; throws when `path` is not one.
 * @param {string} path
 * @returns {{ group: string, field: string }}
 */
export function swpcPath(path) {
  const r = parseSwpcPath(path);
  if (!r) throw new Error(`Invalid SWPC path "${path}"; expected <product>.<field>`);
  return r;
}

/**
 * @typedef {object} ExprDeps
 * @property {Set<string>} groups     groups whose events can change the value
 * @property {Set<string>} fields     fields of the current object read by `field`
 * @property {boolean} current        reads the current object (`field`, `rand`, `orbit` without id)
 * @property {boolean} orbit          contains an `orbit` node
 * @property {number} timeScale       largest orbit `timeScale` (1 without orbit nodes)
 * @property {boolean} swpc           contains an `swpc` node
 * @property {boolean} audio          contains an `audio.*` node
 * @property {boolean} local          contains a `local` (fn) node
 */

/**
 * @param {unknown} node expression node or literal
 * @param {ExprDeps} [deps] accumulator
 * @returns {ExprDeps}
 */
export function collectDeps(node, deps = {
  groups: new Set(), fields: new Set(), current: false, orbit: false, timeScale: 1,
  swpc: false, audio: false, local: false,
}) {
  if (!isNode(node)) return deps;
  const a = node.args;
  switch (node.op) {
    case 'field': deps.current = true; deps.fields.add(String(a[0])); break;
    case 'rand': deps.current = true; break;
    case 'swpc': deps.swpc = true; deps.groups.add(swpcPath(String(a[0])).group); break;
    case 'value': deps.groups.add(objectGroup(String(a[0]))); break;
    case 'count': case 'mean': case 'spread': deps.groups.add(String(a[0])); break;
    case 'orbit':
      deps.orbit = true;
      if (a[1] == null) deps.current = true;
      if (typeof a[2] === 'number' && a[2] > deps.timeScale) deps.timeScale = a[2];
      break;
    case 'level': case 'spectrum': case 'env': deps.audio = true; break;
    case 'local': deps.local = true; deps.current = true; break;
    default: break;
  }
  for (const x of a) collectDeps(x, deps);
  return deps;
}

/**
 * Data class of an expression used as a modulation source (doc/audio/modulation.md, Source classes).
 * @param {ExprDeps} deps
 * @returns {'vlfo' | 'random-walk' | 'step'}
 */
export function sourceClass(deps) {
  if (deps.orbit) return 'vlfo';
  if (deps.swpc) return 'random-walk';
  return 'step';
}
