// Entry of the sandbox Web Worker, bundled into public/dsl-sandbox.js by scripts/build-sandbox.mjs
// (doc/piece-dsl.md, Sandbox). Messages:
//   page → worker  { source, defs? }               worker → page  { ir, problems }
//   page → worker  { fn: { id, source, arg } }     worker → page  { fn: { id, value } | { id, error } }
//   page → worker  { program: { id, op, ... } }    worker → page  { program: { id, commands, errors, dropped } }
// `defs` is the normalized definition object (src/dsl/defs.js); the worker keeps the last one sent.
// The worker keeps the source of its last build without errors and runs it as the program
// (doc/piece-dsl.md, VM).

import { transform } from 'sucrase';
import { buildPiece } from './run-script.js';
import { createRunner } from './program.js';
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

/** @param {unknown} id */
const emptyRun = (id) => ({ id, commands: [], errors: [], dropped: 0 });

/**
 * Handles one program message (doc/piece-dsl.md, VM).
 * @param {any} msg
 * @param {{ kept: { source: string, defs: any } | null, runner: ReturnType<typeof createRunner> | null }} state
 */
export function handleProgram(msg, state) {
  const id = msg?.id ?? null;
  if (msg?.op === 'start') {
    state.runner?.stop();
    state.runner = null;
    if (!state.kept) return { ...emptyRun(id), errors: [{ handler: 'setup', line: null, message: 'The sandbox has no built piece to run' }] };
    // Setup runs again so the program starts from fresh variables.
    const built = buildPiece(state.kept.source, state.kept.defs, { transform: removeTypes });
    if (!built.ir || !built.program) {
      const p = built.problems[0];
      return { ...emptyRun(id), errors: [{ handler: 'setup', line: p?.line ?? null, message: p?.message ?? 'The piece did not build' }] };
    }
    state.runner = createRunner(built.program);
    return { id, ...state.runner.start({ groups: msg.groups, objects: msg.objects }) };
  }
  if (msg?.op === 'batch') return state.runner ? { id, ...state.runner.batch(msg) } : emptyRun(id);
  if (msg?.op === 'stop') {
    state.runner?.stop();
    state.runner = null;
    return emptyRun(id);
  }
  return { ...emptyRun(id), errors: [{ handler: 'vm', line: null, message: `Unknown program message ${String(msg?.op)}` }] };
}

/**
 * Handles one message and returns the reply.
 * @param {any} data
 * @param {{ defs: any, kept?: { source: string, defs: any } | null, runner?: any }} state
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
  if (data && typeof data === 'object' && data.program) {
    return { program: handleProgram(data.program, /** @type {any} */ (state)) };
  }
  if (data?.defs) state.defs = data.defs;
  if (!state.defs) return { ir: null, problems: [problem('runtime_error', '', 'The sandbox received no definition tables')] };
  const { ir, problems } = buildPiece(data?.source, state.defs, { transform: removeTypes, snapshot: data?.snapshot });
  if (ir && !problems.some((p) => p.severity === 'error')) state.kept = { source: String(data.source), defs: state.defs };
  return { ir, problems };
}

const g = /** @type {any} */ (globalThis);
lockGlobals(g);
const state = { defs: null, kept: null, runner: null };
g.onmessage = (/** @type {MessageEvent} */ e) => {
  /** @type {any} */
  let reply;
  try {
    reply = handleMessage(e.data, state);
  } catch (err) {
    const message = String(/** @type {any} */ (err)?.message ?? err);
    reply = e.data?.program
      ? { program: { ...emptyRun(e.data.program.id ?? null), errors: [{ handler: 'vm', line: null, message }] } }
      : { ir: null, problems: [problem('runtime_error', '', message)] };
  }
  g.postMessage(reply);
};
// Loaded: the page starts its build timeout from here (doc/piece-dsl.md, Sandbox).
g.postMessage({ ready: true });
