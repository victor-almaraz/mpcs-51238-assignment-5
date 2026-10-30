// IR migrations (doc/piece-dsl.md, Versioning). `migrations[n]` is a pure function from an IR of
// version n to version n + 1. Loading applies them in order, then validates.

import { CURRENT_IR_VERSION } from './limits.js';
import { problem } from './problem-codes.js';
import { validateIr } from './validate.js';

/** @typedef {import('./problem-codes.js').Problem} Problem */

/**
 * Version steps. Version 1 is the first IR version, so no step exists yet. A step receives a
 * deep copy and returns the next version's document with `irVersion` incremented.
 * @type {Readonly<Record<number, (ir: any) => any>>}
 */
export const migrations = Object.freeze({});

/**
 * Applies migrations from the document's version up to `current`.
 * @param {unknown} ir
 * @param {{ steps?: Readonly<Record<number, (ir: any) => any>>, current?: number }} [opts]
 * @returns {{ ir: any, problems: Problem[] }}
 */
export function migrate(ir, { steps = migrations, current = CURRENT_IR_VERSION } = {}) {
  if (typeof ir !== 'object' || ir === null || Array.isArray(ir)) {
    return { ir: null, problems: [problem('ir_schema', '', 'The IR must be an object')] };
  }
  let doc = /** @type {any} */ (ir);
  const v = doc.irVersion;
  if (!Number.isInteger(v) || v < 1) {
    return { ir: null, problems: [problem('ir_schema', '/irVersion', 'irVersion must be a positive integer')] };
  }
  if (v > current) {
    return { ir: null, problems: [problem('ir_version_unsupported', '/irVersion', `IR version ${v} is newer than this app supports (${current})`)] };
  }
  doc = JSON.parse(JSON.stringify(doc));
  for (let n = v; n < current; n++) {
    const step = steps[n];
    if (typeof step !== 'function') throw new Error(`migrations: no step from IR version ${n}`);
    doc = step(doc);
    if (doc?.irVersion !== n + 1) throw new Error(`migrations: step ${n} must return irVersion ${n + 1}`);
  }
  return { ir: doc, problems: [] };
}

/**
 * Loads a stored IR: migrate, then validate (doc/piece-dsl.md, Versioning).
 * @param {unknown} ir
 * @param {import('./defs.js').Defs} defs
 * @returns {{ ir: any, problems: Problem[] }}
 */
export function loadIr(ir, defs) {
  const m = migrate(ir);
  if (!m.ir) return m;
  return { ir: m.ir, problems: validateIr(m.ir, defs) };
}
