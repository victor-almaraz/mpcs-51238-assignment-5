// A JSON Schema (draft 2020-12) checker for the subset used by ir.schema.json: type, const,
// enum, pattern, properties, required, additionalProperties, items, anyOf and local $ref.
// For `anyOf` branches that discriminate on a `const` property (binding `kind`), the branch with
// the matching constant reports its own errors. Returns the first errors found, with JSON Pointers.

import { escapePointer } from './ir-walk.js';

/** @typedef {{ path: string, message: string }} SchemaError */

/**
 * @param {any} schema root schema
 * @param {unknown} data
 * @param {number} [maxErrors]
 * @returns {SchemaError[]}
 */
export function checkSchema(schema, data, maxErrors = 20) {
  /** @type {SchemaError[]} */
  const errors = [];
  check(schema, schema, data, '', errors, maxErrors);
  return errors;
}

/**
 * @param {any} root @param {any} s @param {any} v @param {string} path @param {SchemaError[]} out @param {number} max
 * @returns {boolean} true when valid
 */
function check(root, s, v, path, out, max) {
  if (out.length >= max) return false;
  if (s.$ref) return check(root, resolve(root, s.$ref), v, path, out, max);
  if (s.anyOf) return checkAnyOf(root, s.anyOf, v, path, out, max);
  if ('const' in s && v !== s.const) return fail(out, path, `must be ${JSON.stringify(s.const)}`);
  if (s.enum && !s.enum.includes(v)) return fail(out, path, `must be one of ${s.enum.map((/** @type {unknown} */ e) => JSON.stringify(e)).join(', ')}`);
  if (s.type && !typeMatches(s.type, v)) return fail(out, path, `must be ${[].concat(s.type).join(' or ')}`);
  if (typeof v === 'string' && s.pattern && !new RegExp(s.pattern, 'u').test(v)) return fail(out, path, `does not match ${s.pattern}`);
  let ok = true;
  if (Array.isArray(v) && s.items) {
    for (let i = 0; i < v.length; i++) ok = check(root, s.items, v[i], `${path}/${i}`, out, max) && ok;
  }
  if (isObject(v)) {
    for (const k of s.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(v, k)) ok = fail(out, `${path}/${escapePointer(k)}`, 'is required');
    }
    const props = s.properties ?? {};
    for (const [k, val] of Object.entries(v)) {
      const p = `${path}/${escapePointer(k)}`;
      if (Object.prototype.hasOwnProperty.call(props, k)) ok = check(root, props[k], val, p, out, max) && ok;
      else if (s.additionalProperties === false) ok = fail(out, p, 'is not allowed');
      else if (isObject(s.additionalProperties)) ok = check(root, s.additionalProperties, val, p, out, max) && ok;
    }
  }
  return ok;
}

/** @param {any} root @param {any[]} branches @param {any} v @param {string} path @param {SchemaError[]} out @param {number} max */
function checkAnyOf(root, branches, v, path, out, max) {
  const resolved = branches.map((b) => (b.$ref ? resolve(root, b.$ref) : b));
  for (const b of resolved) if (check(root, b, v, path, [], Infinity)) return true;
  if (isObject(v)) {
    for (const b of resolved) {
      const consts = Object.entries(b.properties ?? {}).filter(([, ps]) => ps && 'const' in ps);
      if (consts.length && consts.every(([k, ps]) => v[k] === ps.const)) return check(root, b, v, path, out, max);
    }
  }
  return fail(out, path, 'does not match any allowed form');
}

/** @param {any} root @param {string} ref */
function resolve(root, ref) {
  if (!ref.startsWith('#/')) throw new Error(`schema-check: only local $ref is supported (${ref})`);
  return ref.slice(2).split('/').reduce((o, k) => o[k.replaceAll('~1', '/').replaceAll('~0', '~')], root);
}

/** @param {string | string[]} type @param {unknown} v */
function typeMatches(type, v) {
  return [].concat(/** @type {any} */ (type)).some((t) => {
    switch (t) {
      case 'null': return v === null;
      case 'boolean': return typeof v === 'boolean';
      case 'string': return typeof v === 'string';
      case 'number': return typeof v === 'number' && Number.isFinite(v);
      case 'integer': return Number.isInteger(v);
      case 'array': return Array.isArray(v);
      case 'object': return isObject(v);
      default: throw new Error(`schema-check: unsupported type ${t}`);
    }
  });
}

/** @param {unknown} v @returns {v is Record<string, any>} */
function isObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** @param {SchemaError[]} out @param {string} path @param {string} message */
function fail(out, path, message) {
  out.push({ path, message });
  return false;
}
