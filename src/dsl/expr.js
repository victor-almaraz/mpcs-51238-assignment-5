// Expression builders (doc/piece-dsl.md, Expressions). An expression is an immutable wrapper
// around one IR node `{ op, args }`; each step returns a new expression. The expression
// interpreter in src/expr/ evaluates the nodes; this module only builds them.

import { CURVES } from './limits.js';

/** @typedef {{ op: string, args: Value[] }} ExprNode */
/** @typedef {number | string | boolean | null | ExprNode} Value */

export class Expr {
  /** @param {ExprNode} node */
  constructor(node) {
    this.node = node;
    Object.freeze(this);
  }

  /** @param {number} inMin @param {number} inMax @param {number} outMin @param {number} outMax @param {string} [curve] */
  map(inMin, inMax, outMin, outMax, curve = 'lin') {
    if (!CURVES.includes(curve)) throw new TypeError(`map(): curve must be one of ${CURVES.join(', ')}`);
    return step('map', this, [
      finite(inMin, 'map', 'inMin'), finite(inMax, 'map', 'inMax'),
      finite(outMin, 'map', 'outMin'), finite(outMax, 'map', 'outMax'), curve,
    ]);
  }

  /** @param {number} lo @param {number} hi */
  clamp(lo, hi) {
    return step('clamp', this, [finite(lo, 'clamp', 'lo'), finite(hi, 'clamp', 'hi')]);
  }

  /** @param {number} loHz @param {number} hiHz */
  octaveInto(loHz, hiHz) {
    return step('octaveInto', this, [finite(loHz, 'octaveInto', 'loHz'), finite(hiHz, 'octaveInto', 'hiHz')]);
  }

  quantize() { return step('quantize', this, []); }
  /** @param {unknown} x */ add(x) { return step('add', this, [operand(x, 'add')]); }
  /** @param {unknown} x */ sub(x) { return step('sub', this, [operand(x, 'sub')]); }
  /** @param {unknown} x */ mul(x) { return step('mul', this, [operand(x, 'mul')]); }
  /** @param {unknown} x */ div(x) { return step('div', this, [operand(x, 'div')]); }
  abs() { return step('abs', this, []); }
  neg() { return step('neg', this, []); }
  round() { return step('round', this, []); }
  /** @param {unknown} x */ eq(x) { return step('eq', this, [operand(x, 'eq', true)]); }
  /** @param {unknown} x */ gt(x) { return step('gt', this, [operand(x, 'gt')]); }
  /** @param {unknown} x */ lt(x) { return step('lt', this, [operand(x, 'lt')]); }
  /** @param {unknown} e */ and(e) { return step('and', this, [operand(e, 'and', true)]); }
  /** @param {unknown} e */ or(e) { return step('or', this, [operand(e, 'or', true)]); }
  not() { return step('not', this, []); }
}

/** A colour expression: `color(hex)` and `.mix(other, t)` (doc/visuals.md). */
export class ColorExpr {
  /** @param {ExprNode} node */
  constructor(node) {
    this.node = node;
    Object.freeze(this);
  }

  /** @param {unknown} other @param {unknown} t */
  mix(other, t) {
    return new ColorExpr({ op: 'mix', args: [this.node, colorValue(other, 'mix'), operand(t, 'mix')] });
  }
}

/** @param {unknown} x @returns {x is Expr | ColorExpr} */
export function isExpr(x) {
  return x instanceof Expr || x instanceof ColorExpr;
}

/** @param {string} op @param {Value[]} args */
export function expr(op, args) {
  return new Expr({ op, args });
}

/** @param {string} op @param {Expr} self @param {Value[]} rest */
function step(op, self, rest) {
  return new Expr({ op, args: [self.node, ...rest] });
}

/**
 * Converts a step operand: a finite number, an expression or, when `loose`, a string or boolean.
 * @param {unknown} x @param {string} where @param {boolean} [loose]
 * @returns {Value}
 */
export function operand(x, where, loose = false) {
  if (isExpr(x)) return x.node;
  if (typeof x === 'number') return finite(x, where, 'argument');
  if (loose && (typeof x === 'string' || typeof x === 'boolean')) return x;
  throw new TypeError(`${where}(): expected a number${loose ? ', text, true/false' : ''} or an expression`);
}

/**
 * Converts an expression position (pitch, velocity, a follow value, a layer property) to an IR value.
 * @param {unknown} x @param {string} where
 * @returns {Value}
 */
export function toValue(x, where) {
  if (isExpr(x)) return x.node;
  if (typeof x === 'number') return finite(x, where, 'value');
  if (typeof x === 'string' || typeof x === 'boolean') return x;
  throw new TypeError(`${where}: expected a number or an expression`);
}

/** @param {unknown} x @param {string} where @returns {Value} */
export function colorValue(x, where) {
  if (x instanceof ColorExpr) return x.node;
  if (typeof x === 'string') return x;
  throw new TypeError(`${where}(): expected a colour such as '#ffffff' or color(...)`);
}

/** @param {unknown} x @param {string} where @param {string} name @returns {number} */
export function finite(x, where, name) {
  if (typeof x !== 'number' || !Number.isFinite(x)) throw new TypeError(`${where}(): ${name} must be a finite number`);
  return x;
}
