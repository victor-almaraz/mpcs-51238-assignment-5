// Expression interpreter for IR expression nodes (doc/piece-dsl.md, Expressions and IR).
//
// Rules:
// - `null` propagates: any step with a `null` input returns `null`.
// - A non-finite number becomes `null`.
// - A value of the wrong type for a step (a string into `add`, a number into `and`) is `null`.
// - An unknown op throws; the validator rejects it, so reaching one is a defect. The binding
//   runtime catches the error and disables the binding.
//
// `.map` curves:
// - `lin`: linear.
// - `log`: logarithmic output scale, `outMin · (outMax / outMin)^t`, the `log` scale of
//   `PARAM_DEFS`; needs `outMin` and `outMax` of one sign, otherwise `null`.
// - `exp`: exponential input scale, `t = ln(x / inMin) / ln(inMax / inMin)`, then linear
//   output; needs `inMin` and `inMax` of one sign, otherwise `null`.
// The input is clamped to the input range first, so the output stays in the output range.

import { quantize } from './scales.js';
import { rand01 } from './rand.js';

/**
 * @typedef {null | number | string | boolean | ExprNode} ExprArg
 * @typedef {{ op: string, args: ExprArg[] }} ExprNode
 * @typedef {null | number | string | boolean | number[]} ExprValue
 * @typedef {{ id: string, source?: string, group: string, fields: Record<string, unknown> }} SkyObject
 *
 * @typedef {object} EvalContext
 * @property {number} [seed]                       piece seed, for `rand`
 * @property {{ root: string, mode: string }} [scale] piece scale, for `quantize`
 * @property {string} [bindingId]                  binding or layer id, for `rand`
 * @property {(path: string) => unknown} [swpc]
 * @property {(objectId: string, field: string) => unknown} [value]
 * @property {(group: string) => unknown} [count]
 * @property {(group: string, field: string) => unknown} [mean]
 * @property {(group: string, field: string) => unknown} [spread]
 * @property {(objectId: string, quantity: string, timeScale: number) => unknown} [orbit]
 * @property {(inst: string) => unknown} [level]
 * @property {(inst: string, bands: number) => unknown} [spectrum]
 * @property {(inst: string, objectId: string | null) => unknown} [env]
 * @property {(args: ExprArg[], obj: SkyObject | null) => unknown} [local]
 */

/**
 * @param {unknown} x
 * @returns {x is ExprNode}
 */
export function isNode(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
    && typeof /** @type {any} */ (x).op === 'string' && Array.isArray(/** @type {any} */ (x).args);
}

/** @param {unknown} x @returns {number | null} */
function num(x) {
  return typeof x === 'number' && Number.isFinite(x) ? x : null;
}

/** @param {unknown} x @returns {ExprValue} */
function scalar(x) {
  if (typeof x === 'number') return Number.isFinite(x) ? x : null;
  if (typeof x === 'string' || typeof x === 'boolean') return x;
  return null;
}

/** @param {unknown} x @returns {ExprValue} */
function external(x) {
  if (Array.isArray(x)) return x.every((v) => typeof v === 'number' && Number.isFinite(v)) ? x : null;
  return scalar(x);
}

/**
 * Evaluates an expression node, or a literal, against the current object and context.
 * @param {ExprArg} node
 * @param {SkyObject | null} obj  the current object; `null` where none exists
 * @param {EvalContext} [ctx]
 * @returns {ExprValue}
 */
export function evaluate(node, obj, ctx = {}) {
  if (!isNode(node)) return scalar(node);
  const a = node.args;
  /** @param {number} i */
  const arg = (i) => evaluate(a[i], obj, ctx);
  /** @param {number} i */
  const n = (i) => num(arg(i));

  switch (node.op) {
    // Sources
    case 'field': {
      const v = obj && obj.fields ? obj.fields[String(a[0])] : undefined;
      return scalar(v);
    }
    case 'num': return n(0);
    case 'rand': {
      const lo = n(0), hi = n(1);
      if (lo === null || hi === null) return null;
      const u = rand01(ctx.seed ?? 1, ctx.bindingId ?? '', obj ? obj.id : '');
      return num(lo + u * (hi - lo));
    }
    case 'swpc': return ctx.swpc ? external(ctx.swpc(String(a[0]))) : null;
    case 'value': return ctx.value ? external(ctx.value(String(a[0]), String(a[1]))) : null;
    case 'count': return ctx.count ? num(ctx.count(String(a[0]))) : null;
    case 'mean': return ctx.mean ? num(ctx.mean(String(a[0]), String(a[1]))) : null;
    case 'spread': return ctx.spread ? num(ctx.spread(String(a[0]), String(a[1]))) : null;
    case 'orbit': {
      const objectId = a[1] == null ? (obj ? obj.id : null) : String(a[1]);
      if (objectId === null || !ctx.orbit) return null;
      const ts = num(a[2]) ?? 1;
      return num(ctx.orbit(objectId, String(a[0]), ts));
    }
    case 'level': return ctx.level ? num(ctx.level(String(a[0]))) : null;
    case 'spectrum': return ctx.spectrum ? external(ctx.spectrum(String(a[0]), Number(a[1]))) : null;
    case 'env': return ctx.env ? num(ctx.env(String(a[0]), obj ? obj.id : null)) : null;
    case 'local': return ctx.local ? external(ctx.local(a, obj)) : null;

    // Colours (layer properties, doc/visuals.md): `#rrggbb` strings.
    case 'color': return hexColor(a[0]);
    case 'mix': {
      const x = hexColor(arg(0)), y = hexColor(arg(1)), t = n(2);
      if (x === null || y === null || t === null) return null;
      return mixColor(x, y, Math.min(Math.max(t, 0), 1));
    }

    // Numeric steps
    case 'map': return map(n(0), n(1), n(2), n(3), n(4), a[5] == null ? 'lin' : String(a[5]));
    case 'clamp': {
      const x = n(0), lo = n(1), hi = n(2);
      if (x === null || lo === null || hi === null) return null;
      return Math.min(Math.max(x, Math.min(lo, hi)), Math.max(lo, hi));
    }
    case 'octaveInto': return octaveInto(n(0), n(1), n(2));
    case 'quantize': {
      const x = n(0);
      return x === null ? null : quantize(x, ctx.scale);
    }
    case 'add': return binary(n(0), n(1), (x, y) => x + y);
    case 'sub': return binary(n(0), n(1), (x, y) => x - y);
    case 'mul': return binary(n(0), n(1), (x, y) => x * y);
    case 'div': return binary(n(0), n(1), (x, y) => x / y);
    case 'abs': { const x = n(0); return x === null ? null : Math.abs(x); }
    case 'neg': { const x = n(0); return x === null ? null : -x; }
    case 'round': { const x = n(0); return x === null ? null : Math.round(x); }

    // Comparison and logic
    case 'eq': {
      const x = arg(0), y = arg(1);
      if (x === null || y === null || Array.isArray(x) || Array.isArray(y)) return null;
      return x === y;
    }
    case 'gt': { const x = n(0), y = n(1); return x === null || y === null ? null : x > y; }
    case 'lt': { const x = n(0), y = n(1); return x === null || y === null ? null : x < y; }
    case 'and': {
      const x = arg(0), y = arg(1);
      return typeof x === 'boolean' && typeof y === 'boolean' ? x && y : null;
    }
    case 'or': {
      const x = arg(0), y = arg(1);
      return typeof x === 'boolean' && typeof y === 'boolean' ? x || y : null;
    }
    case 'not': { const x = arg(0); return typeof x === 'boolean' ? !x : null; }

    default:
      throw new Error(`Unknown expression op "${node.op}"`);
  }
}

/**
 * @param {number | null} x @param {number | null} y
 * @param {(x: number, y: number) => number} f
 * @returns {number | null}
 */
function binary(x, y, f) {
  return x === null || y === null ? null : num(f(x, y));
}

/**
 * `.map(inMin, inMax, outMin, outMax, curve)`, clamped to the output range.
 * @returns {number | null}
 */
export function map(x, inMin, inMax, outMin, outMax, curve = 'lin') {
  if (x === null || inMin === null || inMax === null || outMin === null || outMax === null) return null;
  if (inMin === inMax) return null;
  const xc = Math.min(Math.max(x, Math.min(inMin, inMax)), Math.max(inMin, inMax));
  let t;
  if (curve === 'exp') {
    if (!(inMin * inMax > 0)) return null;
    t = Math.log(xc / inMin) / Math.log(inMax / inMin);
  } else {
    t = (xc - inMin) / (inMax - inMin);
  }
  t = Math.min(Math.max(t, 0), 1);
  let out;
  if (curve === 'log') {
    if (!(outMin * outMax > 0)) return null;
    out = outMin * Math.pow(outMax / outMin, t);
  } else if (curve === 'lin' || curve === 'exp') {
    out = outMin + t * (outMax - outMin);
  } else {
    throw new Error(`Unknown map curve "${curve}"`);
  }
  const lo = Math.min(outMin, outMax), hi = Math.max(outMin, outMax);
  return num(Math.min(Math.max(out, lo), hi));
}

/**
 * `.octaveInto(loHz, hiHz)`: moves frequency `x` by octaves into [loHz, hiHz) and returns its
 * MIDI pitch (fractional). `null` for a non-positive frequency or a range no octave fits.
 * @returns {number | null}
 */
export function octaveInto(x, loHz, hiHz) {
  if (x === null || loHz === null || hiHz === null) return null;
  if (!(x > 0) || !(loHz > 0) || !(hiHz > loHz)) return null;
  // Fewest octave moves: divide a value above the range until it is below hiHz, multiply a
  // value below the range until it reaches loHz. The loops correct floating-point error.
  let f = x;
  if (f >= hiHz) {
    f = x * Math.pow(2, -Math.floor(Math.log2(x / hiHz)) - 1);
    while (f >= hiHz) f /= 2;
    while (f * 2 < hiHz) f *= 2;
  } else if (f < loHz) {
    f = x * Math.pow(2, Math.ceil(Math.log2(loHz / x)));
    while (f < loHz) f *= 2;
    while (f / 2 >= loHz) f /= 2;
  }
  if (!(f >= loHz && f < hiHz)) return null;
  return num(69 + 12 * Math.log2(f / 440));
}

/**
 * Normalizes `#rgb` or `#rrggbb` to lowercase `#rrggbb`; anything else is null.
 * @param {unknown} x
 * @returns {string | null}
 */
export function hexColor(x) {
  if (typeof x !== 'string') return null;
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(x);
  if (!m) return null;
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
  return `#${h.toLowerCase()}`;
}

/**
 * Per-channel linear blend of two `#rrggbb` colours in sRGB values, `t` in 0–1.
 * @param {string} a @param {string} b @param {number} t
 * @returns {string}
 */
export function mixColor(a, b, t) {
  let out = '#';
  for (let i = 1; i < 7; i += 2) {
    const x = parseInt(a.slice(i, i + 2), 16), y = parseInt(b.slice(i, i + 2), 16);
    out += Math.round(x + (y - x) * t).toString(16).padStart(2, '0');
  }
  return out;
}
