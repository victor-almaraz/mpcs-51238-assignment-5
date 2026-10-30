// Page side of the sandbox (doc/piece-dsl.md, Sandbox): posts `{ source, defs }` to the worker at
// /dsl-sandbox.js, waits up to 1500 ms for `{ ir, problems }`, and terminates the worker with
// problem `timeout` when no reply arrives. One worker serves consecutive builds and, for
// local-only pieces, `fn` evaluation.

import { LIMITS } from './limits.js';
import { problem } from './problem-codes.js';

/** @typedef {import('./problem-codes.js').Problem} Problem */
/**
 * The subset of the Web Worker interface the client uses; tests pass an adapter.
 * @typedef {{ postMessage(m: unknown): void, terminate(): void, onmessage: ((e: { data: any }) => void) | null, onerror?: ((e: any) => void) | null }} WorkerLike
 */

/** @returns {WorkerLike} */
const browserWorker = () => /** @type {any} */ (new Worker('/dsl-sandbox.js'));

/**
 * @param {{ createWorker?: () => WorkerLike, timeoutMs?: number }} [opts]
 */
export function createSandbox({ createWorker = browserWorker, timeoutMs = LIMITS.timeoutMs } = {}) {
  /** @type {WorkerLike | null} */
  let worker = null;
  /** @type {Promise<unknown>} */
  let queue = Promise.resolve();
  /** @type {Map<number, (v: { value?: unknown, error?: string }) => void>} */
  const fnWaiters = new Map();
  let fnId = 0;
  /** @type {((reply: any) => void) | null} */
  let buildWaiter = null;

  const ensure = () => {
    if (worker) return worker;
    const w = createWorker();
    w.onmessage = (e) => {
      const d = e.data;
      if (d && typeof d === 'object' && d.fn) {
        const r = fnWaiters.get(d.fn.id);
        fnWaiters.delete(d.fn.id);
        r?.(d.fn);
      } else if (buildWaiter) {
        const r = buildWaiter;
        buildWaiter = null;
        r(d);
      }
    };
    w.onerror = (e) => {
      const r = buildWaiter;
      buildWaiter = null;
      r?.({ ir: null, problems: [problem('runtime_error', '', `The sandbox failed: ${e?.message ?? 'unknown error'}`)] });
    };
    worker = w;
    return w;
  };

  const reset = () => {
    worker?.terminate();
    worker = null;
    for (const r of fnWaiters.values()) r({ error: 'sandbox restarted' });
    fnWaiters.clear();
  };

  /**
   * Builds one script. Builds run one at a time in call order.
   * @param {string} source
   * @param {import('./defs.js').Defs} defs normalized definition tables
   * @param {{ snapshot?: Record<string, { fields: Record<string, unknown> }[]> }} [opts]
   * @returns {Promise<{ ir: any | null, problems: Problem[] }>}
   */
  function build(source, defs, { snapshot } = {}) {
    const run = () => new Promise((resolve) => {
      const w = ensure();
      const timer = setTimeout(() => {
        buildWaiter = null;
        reset();
        resolve({ ir: null, problems: [problem('timeout', '', `The script ran longer than ${timeoutMs / 1000} s`)] });
      }, timeoutMs);
      buildWaiter = (reply) => {
        clearTimeout(timer);
        resolve(isReply(reply) ? reply : { ir: null, problems: [problem('runtime_error', '', 'The sandbox sent an invalid reply')] });
      };
      w.postMessage({ source, defs, snapshot });
    });
    const p = queue.then(run, run);
    queue = p;
    return /** @type {Promise<{ ir: any | null, problems: Problem[] }>} */ (p);
  }

  /**
   * Evaluates an `fn` expression of a local-only piece in the sandbox.
   * @param {string} source @param {unknown} arg
   * @returns {Promise<unknown>} the value, or null when the function throws
   */
  function evalFn(source, arg) {
    const id = ++fnId;
    return new Promise((resolve) => {
      fnWaiters.set(id, (r) => resolve(r.error === undefined ? r.value : null));
      ensure().postMessage({ fn: { id, source, arg } });
    });
  }

  return { build, evalFn, dispose: reset };
}

/** @param {any} r */
function isReply(r) {
  return r && typeof r === 'object' && 'ir' in r && Array.isArray(r.problems);
}
