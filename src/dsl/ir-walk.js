// Enumerates the expression positions of an IR document with their JSON Pointers and evaluation
// contexts, and collects the groups a document references. Shared by the builder and the validator.

import { isNode } from '../expr/evaluate.js';
import { objectGroup, parseSwpcPath } from '../expr/deps.js';

export { isNode, objectGroup };

/**
 * @typedef {{ object: string | null, layer: boolean }} ExprContext
 * `object` is the group of the current object, or null where no current object exists.
 * `layer` is true in layer properties and the view background.
 * @typedef {(value: unknown, path: string, ctx: ExprContext) => void} PositionVisitor
 */

/**
 * Calls `visit` for every expression position. Assumes the document passed the schema check.
 * @param {any} ir
 * @param {PositionVisitor} visit
 */
export function forEachExprPosition(ir, visit) {
  const global = { object: null, layer: false };
  ir.lfos.forEach((l, i) => {
    if (l.rate && typeof l.rate === 'object' && 'expr' in l.rate) visit(l.rate.expr, `/lfos/${i}/rate/expr`, global);
  });
  ir.mods.forEach((m, i) => {
    if ('expr' in m.source) visit(m.source.expr, `/mods/${i}/source/expr`, global);
  });
  ir.bindings.forEach((b, i) => {
    const p = `/bindings/${i}`;
    if (b.kind === 'voices') {
      const ctx = { object: b.group, layer: false };
      visit(b.pitch, `${p}/pitch`, ctx);
      visit(b.velocity, `${p}/velocity`, ctx);
      visit(b.pan, `${p}/pan`, ctx);
      for (const [k, v] of Object.entries(b.voiceMods)) visit(v, `${p}/voiceMods/${escapePointer(k)}`, ctx);
    } else if (b.kind === 'trigger') {
      const ctx = { object: b.group, layer: false };
      if (b.when !== null) visit(b.when, `${p}/when`, ctx);
      visit(b.pitch, `${p}/pitch`, ctx);
      visit(b.velocity, `${p}/velocity`, ctx);
    } else {
      visit(b.expr, `${p}/expr`, global);
    }
  });
  visit(ir.view.background, '/view/background', { object: null, layer: true });
  ir.layers.forEach((l, i) => {
    const ctx = { object: l.group, layer: true };
    for (const [k, v] of Object.entries(l.props)) visit(v, `/layers/${i}/props/${escapePointer(k)}`, ctx);
  });
  (ir.program?.orbits ?? []).forEach((/** @type {unknown} */ n, /** @type {number} */ i) => visit(n, `/program/orbits/${i}`, global));
}

/**
 * Calls `visit(node, path, depth)` for every node of one expression value, depth-first.
 * Stops descending below `maxDepth`.
 * @param {unknown} value
 * @param {string} path
 * @param {(node: { op: string, args: unknown[] }, path: string, depth: number) => void} visit
 * @param {number} [maxDepth]
 */
export function forEachNode(value, path, visit, maxDepth = Infinity) {
  /** @type {[unknown, string, number][]} */
  const stack = [[value, path, 1]];
  while (stack.length) {
    const [v, p, d] = /** @type {[any, string, number]} */ (stack.pop());
    if (!isNode(v)) continue;
    visit(v, p, d);
    if (d >= maxDepth) continue;
    for (let i = v.args.length - 1; i >= 0; i--) stack.push([v.args[i], `${p}/args/${i}`, d + 1]);
  }
}

/**
 * The group an expression node refers to by name, or null.
 * @param {{ op: string, args: unknown[] }} node
 * @returns {string | null}
 */
export function nodeGroup(node) {
  const a = node.args;
  switch (node.op) {
    case 'swpc': return parseSwpcPath(a[0])?.group ?? null;
    case 'value': return typeof a[0] === 'string' ? objectGroup(a[0]) : null;
    case 'count': case 'mean': case 'spread': return typeof a[0] === 'string' ? a[0] : null;
    case 'orbit': return typeof a[1] === 'string' ? objectGroup(a[1]) : null;
    default: return null;
  }
}

/**
 * Every group referenced by a binding, expression or layer, sorted.
 * @param {any} ir
 * @returns {string[]}
 */
export function collectGroups(ir) {
  const out = new Set();
  for (const b of ir.bindings) if (typeof b.group === 'string') out.add(b.group);
  for (const l of ir.layers) if (typeof l.group === 'string') out.add(l.group);
  for (const h of ir.program?.handlers ?? []) if (h.kind === 'on' && typeof h.group === 'string') out.add(h.group);
  for (const g of ir.program?.follow ?? []) if (typeof g === 'string') out.add(g);
  forEachExprPosition(ir, (value, path) => forEachNode(value, path, (node) => {
    const g = nodeGroup(node);
    if (g) out.add(g);
  }));
  return [...out].sort();
}

/** RFC 6901 escaping of one reference token. @param {string} token */
export function escapePointer(token) {
  return token.replaceAll('~', '~0').replaceAll('/', '~1');
}
