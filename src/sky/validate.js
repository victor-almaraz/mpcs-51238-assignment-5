// Boundary validation of rows and Realtime payloads (doc/sky-contract.md, Live mode).

/**
 * @typedef {Record<string, number | string | boolean | null>} Fields
 * @typedef {{ id: string, source: string, group: string, fields: Fields, traceId: string,
 *             updatedAt: number, removed: boolean }} SkyRow
 * @typedef {{ source: string, intervalSec: number, lastAttemptAt: string | null,
 *             lastSuccessAt: string | null, lastOk: boolean | null, halted: boolean }} StatusRow
 * @typedef {{ id: number, traceId: string, source: string, group: string, objectId: string,
 *             kind: 'enter' | 'update' | 'exit', before: Fields | null, after: Fields | null, at: number }} ChangeRow
 */

/**
 * @template T
 * @typedef {{ ok: true, value: T } | { ok: false, error: string }} Result
 */

/** @param {unknown} v */
const isStr = (v) => typeof v === 'string' && v !== '';
/** @param {unknown} v */
const isIso = (v) => typeof v === 'string' && Number.isFinite(Date.parse(v));
/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Checks a flat field object.
 * @param {unknown} f
 * @returns {string | null} error or null
 */
export function fieldsError(f) {
  if (!isPlain(f)) return 'fields is not an object';
  for (const [k, v] of Object.entries(f)) {
    if (v === null || typeof v === 'string' || typeof v === 'boolean') continue;
    if (typeof v === 'number' && Number.isFinite(v)) continue;
    return `field ${k} has invalid value ${JSON.stringify(v)}`;
  }
  return null;
}

/**
 * A `sky_objects` row from REST or a Realtime payload `new` record.
 * @param {unknown} row
 * @returns {Result<SkyRow>}
 */
export function parseSkyRow(row) {
  if (!isPlain(row)) return { ok: false, error: 'row is not an object' };
  for (const k of ['id', 'source', 'group_key', 'trace_id']) {
    if (!isStr(row[k])) return { ok: false, error: `${k} is not a non-empty string` };
  }
  const fe = fieldsError(row.fields);
  if (fe) return { ok: false, error: fe };
  if (!isIso(row.updated_at)) return { ok: false, error: 'updated_at is not an ISO 8601 time' };
  if (row.removed_at !== null && row.removed_at !== undefined && !isIso(row.removed_at)) {
    return { ok: false, error: 'removed_at is neither null nor an ISO 8601 time' };
  }
  const id = /** @type {string} */ (row.id);
  const group = /** @type {string} */ (row.group_key);
  if (!id.startsWith(`${group}:`)) return { ok: false, error: `id ${id} does not start with its group ${group}` };
  return {
    ok: true,
    value: {
      id,
      source: /** @type {string} */ (row.source),
      group,
      fields: /** @type {Fields} */ (row.fields),
      traceId: /** @type {string} */ (row.trace_id),
      updatedAt: Date.parse(/** @type {string} */ (row.updated_at)),
      removed: row.removed_at !== null && row.removed_at !== undefined,
    },
  };
}

/**
 * A `source_status` row.
 * @param {unknown} row
 * @returns {Result<StatusRow>}
 */
export function parseStatusRow(row) {
  if (!isPlain(row)) return { ok: false, error: 'row is not an object' };
  if (!isStr(row.source_id)) return { ok: false, error: 'source_id is not a non-empty string' };
  if (!Number.isInteger(row.interval_sec) || /** @type {number} */ (row.interval_sec) <= 0) {
    return { ok: false, error: 'interval_sec is not a positive integer' };
  }
  for (const k of ['last_attempt_at', 'last_success_at']) {
    if (row[k] !== null && row[k] !== undefined && !isIso(row[k])) return { ok: false, error: `${k} is not an ISO 8601 time` };
  }
  if (row.last_ok !== null && row.last_ok !== undefined && typeof row.last_ok !== 'boolean') {
    return { ok: false, error: 'last_ok is not a boolean or null' };
  }
  if (typeof row.halted !== 'boolean') return { ok: false, error: 'halted is not a boolean' };
  return {
    ok: true,
    value: {
      source: /** @type {string} */ (row.source_id),
      intervalSec: /** @type {number} */ (row.interval_sec),
      lastAttemptAt: /** @type {string | null} */ (row.last_attempt_at ?? null),
      lastSuccessAt: /** @type {string | null} */ (row.last_success_at ?? null),
      lastOk: /** @type {boolean | null} */ (row.last_ok ?? null),
      halted: /** @type {boolean} */ (row.halted),
    },
  };
}

/**
 * A `changes` row.
 * @param {unknown} row
 * @returns {Result<ChangeRow>}
 */
export function parseChangeRow(row) {
  if (!isPlain(row)) return { ok: false, error: 'row is not an object' };
  const id = typeof row.id === 'string' ? Number(row.id) : row.id;
  if (!Number.isSafeInteger(id)) return { ok: false, error: 'id is not an integer' };
  for (const k of ['trace_id', 'source', 'group_key', 'object_id']) {
    if (!isStr(row[k])) return { ok: false, error: `${k} is not a non-empty string` };
  }
  if (!['enter', 'update', 'exit'].includes(/** @type {string} */ (row.kind))) return { ok: false, error: 'kind is not enter, update or exit' };
  if (!isIso(row.at)) return { ok: false, error: 'at is not an ISO 8601 time' };
  if (!isPlain(row.diff)) return { ok: false, error: 'diff is not an object' };
  const { before = null, after = null } = /** @type {any} */ (row.diff);
  for (const [name, f] of [['before', before], ['after', after]]) {
    if (f === null) continue;
    const fe = fieldsError(f);
    if (fe) return { ok: false, error: `diff.${name}: ${fe}` };
  }
  if (row.kind !== 'exit' && after === null) return { ok: false, error: `${row.kind} change lacks diff.after` };
  return {
    ok: true,
    value: {
      id: /** @type {number} */ (id),
      traceId: /** @type {string} */ (row.trace_id),
      source: /** @type {string} */ (row.source),
      group: /** @type {string} */ (row.group_key),
      objectId: /** @type {string} */ (row.object_id),
      kind: /** @type {'enter' | 'update' | 'exit'} */ (row.kind),
      before,
      after,
      at: Date.parse(/** @type {string} */ (row.at)),
    },
  };
}
