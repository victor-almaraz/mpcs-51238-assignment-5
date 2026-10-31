// Entry of the sandbox Web Worker, bundled into public/dsl-sandbox.js by scripts/build-sandbox.mjs
// (doc/piece-dsl.md, Sandbox). Messages:
//   page → worker  { source, defs? }               worker → page  { ir, problems }
//   page → worker  { fn: { id, source, arg } }     worker → page  { fn: { id, value } | { id, error } }
// `defs` is the normalized definition object (src/dsl/defs.js); the worker keeps the last one sent.

import { transform } from 'sucrase';
import { buildPiece } from './run-script.js';
import { problem } from './problem-codes.js';

/** Network and storage globals removed before any script runs. */
export const BLOCKED_GLOBALS = ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts', 'indexedDB'];

/**
 * Deletes each blocked global from the global object and its prototype chain; where a property
 * cannot be deleted, overwrites it with undefined.
 * @param {any} g
 */
export function lockGlobals(g) {
  for (const name of BLOCKED_GLOBALS) {
    for (let o = g; o; o = Object.getPrototypeOf(o)) {
      if (!Object.prototype.hasOwnProperty.call(o, name)) continue;
      try { delete o[name]; } catch { /* non-configurable */ }
      if (Object.prototype.hasOwnProperty.call(o, name)) {
        try { Object.defineProperty(o, name, { value: undefined, writable: false, configurable: false }); } catch { /* frozen */ }
      }
    }
  }
}

/** @param {string} source */
const removeTypes = (source) => transform(source, { transforms: ['typescript'] }).code;

/** @type {Map<string, Function>} */
const fnCache = new Map();

/** @param {string} source @param {unknown} arg */
function evalFn(source, arg) {
  let f = fnCache.get(source);
  if (!f) {
    f = /** @type {Function} */ (new Function(`'use strict'; return (${source});`)());
    if (typeof f !== 'function') throw new TypeError('fn() source must be a function');
    fnCache.set(source, f);
  }
  const v = f(arg);
  return typeof v === 'number' ? (Number.isFinite(v) ? v : null) : typeof v === 'string' || typeof v === 'boolean' ? v : null;
}

/**
 * Handles one message and returns the reply.
 * @param {any} data
 * @param {{ defs: any }} state
 */
export function handleMessage(data, state) {
  if (data && typeof data === 'object' && data.fn) {
    const { id, source, arg } = data.fn;
    try {
      return { fn: { id, value: evalFn(String(source), arg) } };
    } catch (e) {
      return { fn: { id, error: String(/** @type {any} */ (e)?.message ?? e) } };
    }
  }
  if (data?.defs) state.defs = data.defs;
  if (!state.defs) return { ir: null, problems: [problem('runtime_error', '', 'The sandbox received no definition tables')] };
  return buildPiece(data?.source, state.defs, { transform: removeTypes, snapshot: data?.snapshot });
}

const g = /** @type {any} */ (globalThis);
lockGlobals(g);
const state = { defs: null };
g.onmessage = (/** @type {MessageEvent} */ e) => {
  /** @type {any} */
  let reply;
  try {
    reply = handleMessage(e.data, state);
  } catch (err) {
    reply = { ir: null, problems: [problem('runtime_error', '', String(/** @type {any} */ (err)?.message ?? err))] };
  }
  g.postMessage(reply);
};
// Loaded: the page starts its build timeout from here (doc/piece-dsl.md, Sandbox).
g.postMessage({ ready: true });
