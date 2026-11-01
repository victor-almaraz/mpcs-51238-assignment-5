// Builds a piece from script source: remove types, run the script's setup against the builder API,
// validate the IR, and attach script lines to problems (doc/piece-dsl.md, Sandbox). The result
// also carries the program (handlers with their functions) for the VM (doc/piece-dsl.md, VM). The sandbox
// worker, the starter build and the tests call `buildPiece`; the type-removal function is
// injected so this module has no dependency on Sucrase's packaging.

import { createBuilder } from './builder.js';
import { ProgramError } from './program.js';
import { LIMITS, SCRIPT_URL } from './limits.js';
import { problem } from './problem-codes.js';
import { validateIr } from './validate.js';

/** @typedef {import('./problem-codes.js').Problem} Problem */
/** @typedef {import('./defs.js').Defs} Defs */
/** @typedef {(source: string) => string} Transform */

/** Globals the script must not reach, shadowed by parameters of the script function. */
const SHADOWED = [
  'self', 'globalThis', 'postMessage', 'close', 'onmessage', 'addEventListener', 'removeEventListener',
  'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts', 'indexedDB', 'caches', 'Worker',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'queueMicrotask', 'requestAnimationFrame',
  'Date', 'performance',
];
/** Shadowed globals that explain themselves when a script uses them (doc/piece-dsl.md, Program, Determinism). */
const REPLACED = /** @type {Record<string, string>} */ ({
  setTimeout: 'after(ms, fn)', setInterval: 'every(interval, fn)', clearTimeout: 'the function after() returns',
  clearInterval: 'the function after() returns', queueMicrotask: 'after(0, fn)', requestAnimationFrame: 'every(interval, fn)',
  Date: 'time()', performance: 'time()',
});
/** @param {string} name */
const unavailable = (name) => {
  const fail = () => { throw new TypeError(`${name} is not available in piece scripts; use ${REPLACED[name]}`); };
  return new Proxy(function () {}, { get: fail, apply: fail, construct: fail });
};
const MARK = '__sphaerenmusikLine0__';
const FRAME = new RegExp(`${SCRIPT_URL.replace('.', '\\.')}:(\\d+):\\d+`);

/**
 * @param {unknown} source script source
 * @param {Defs} defs normalized definition tables (defs.js)
 * @param {{ transform: Transform, snapshot?: Record<string, { fields: Record<string, unknown> }[]> }} opts
 * @returns {{ ir: any | null, problems: Problem[], program?: any }}
 */
export function buildPiece(source, defs, { transform, snapshot }) {
  if (typeof source !== 'string') return { ir: null, problems: [problem('runtime_error', '', 'The script source must be text')] };
  if (source.length > LIMITS.sourceChars) {
    return { ir: null, problems: [problem('limit_source', '', `The script is ${source.length} characters; the limit is ${LIMITS.sourceChars}`)] };
  }

  let code;
  try {
    code = transform(source);
  } catch (e) {
    const err = /** @type {any} */ (e);
    return { ir: null, problems: [problem('syntax_error', '', String(err?.message ?? err), Number.isInteger(err?.loc?.line) ? err.loc.line : null)] };
  }

  let base = 0;
  const line = () => lineOf(new Error().stack, base);
  const { api, finish, seededMath } = createBuilder(defs, { line });
  const names = Object.keys(api);
  let run;
  try {
    // Line 1 of the body records its own stack line, so script line n is that line + n.
    run = new Function(MARK, ...names, 'Math', ...SHADOWED, `'use strict';${MARK}();\n${code}\n//# sourceURL=${SCRIPT_URL}`);
  } catch (e) {
    return { ir: null, problems: [problem('syntax_error', '', String(/** @type {any} */ (e)?.message ?? e))] };
  }

  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 64;
  try {
    run(() => { base = lineOf(new Error().stack, 0) ?? 0; }, ...names.map((n) => api[n]), seededMath,
      ...SHADOWED.map((n) => (n in REPLACED ? unavailable(n) : undefined)));
  } catch (e) {
    const err = /** @type {any} */ (e);
    const msg = err instanceof Error ? `${err.name === 'Error' ? '' : `${err.name}: `}${err.message}` : `Uncaught ${String(err)}`;
    const code = err instanceof ProgramError ? err.code : 'runtime_error';
    return { ir: null, problems: [problem(code, '', msg, err instanceof Error ? lineOf(err.stack, base) : null)] };
  } finally {
    Error.stackTraceLimit = limit;
  }

  let built;
  try {
    built = finish();
  } catch (e) {
    return { ir: null, problems: [problem('expr_too_deep', '', `The piece could not be serialized: ${/** @type {any} */ (e)?.message ?? e}`)] };
  }
  const problems = validateIr(built.ir, defs, { snapshot }).map((p) => ({ ...p, line: lineFor(p.path, built.lines) }));
  const program = { ...built.program, lineOf: (/** @type {string | undefined} */ stack) => lineOf(stack, base) };
  return { ir: built.ir, problems, program };
}

/**
 * Script line of the first stack frame inside the script, relative to `base`.
 * @param {string | undefined} stack @param {number} base
 * @returns {number | null}
 */
function lineOf(stack, base) {
  if (typeof stack !== 'string') return null;
  for (const frame of stack.split('\n')) {
    const m = FRAME.exec(frame);
    if (m) {
      const n = Number(m[1]) - base;
      return base === 0 || n >= 1 ? n : null;
    }
  }
  return null;
}

/**
 * Line of the longest recorded pointer that prefixes `path`.
 * @param {string} path @param {Record<string, number | null>} lines
 * @returns {number | null}
 */
export function lineFor(path, lines) {
  let p = path;
  for (;;) {
    if (Object.prototype.hasOwnProperty.call(lines, p) && lines[p] !== null) return lines[p];
    if (p === '') return null;
    p = p.slice(0, p.lastIndexOf('/'));
  }
}
