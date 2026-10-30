// JSON Lines export and import of trace records (doc/console.md, Export).
import { normalizeRecord, recordsToJsonl } from './bus.js';

export { recordsToJsonl as toJsonl };

/**
 * Parses a console export. Blank lines are skipped.
 * @param {string} text
 * @returns {import('./bus.js').TraceRecord[]}
 * @throws {SyntaxError | TypeError} naming the line number
 */
export function parseJsonl(text) {
  const out = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '') continue;
    let raw;
    try {
      raw = JSON.parse(line);
    } catch (e) {
      throw new SyntaxError(`trace line ${i + 1}: ${/** @type {Error} */ (e).message}`);
    }
    if (raw === null || typeof raw !== 'object' || raw.t === undefined) {
      throw new TypeError(`trace line ${i + 1}: record lacks t`);
    }
    try {
      out.push(normalizeRecord(raw));
    } catch (e) {
      throw new TypeError(`trace line ${i + 1}: ${/** @type {Error} */ (e).message}`);
    }
  }
  return out;
}

/**
 * Rebuilds the SkyEvent sequence from the CHANGE records of a trace, in record order.
 * @param {import('./bus.js').TraceRecord[]} records
 * @returns {import('../sky/core.js').SkyChangeEvent[]}
 */
export function eventsFromTrace(records) {
  const out = [];
  for (const r of records) {
    if (r.stage !== 'CHANGE') continue;
    const d = /** @type {any} */ (r.data);
    if (!['enter', 'update', 'exit'].includes(d.kind) || typeof d.objectId !== 'string') {
      throw new TypeError(`CHANGE record ${r.traceId} lacks kind or objectId`);
    }
    const before = d.diff?.before ?? null;
    const after = d.diff?.after ?? null;
    const base = { id: d.objectId, source: d.source, group: d.group };
    const prev = before ? Object.freeze({ ...base, fields: Object.freeze({ ...before }) }) : null;
    const obj = d.kind === 'exit'
      ? prev ?? Object.freeze({ ...base, fields: Object.freeze({}) })
      : Object.freeze({ ...base, fields: Object.freeze({ ...after }) });
    /** @type {any} */
    const e = { type: d.kind, obj, prev: d.kind === 'exit' ? obj : prev, traceId: r.traceId };
    if (d.initial === true) e.initial = true;
    if (r.replay !== undefined) e.replay = true;
    if (r.synthetic) e.synthetic = true;
    out.push(Object.freeze(e));
  }
  return out;
}
