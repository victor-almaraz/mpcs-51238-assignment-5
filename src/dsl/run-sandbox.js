// Page side of the sandbox (doc/piece-dsl.md, Sandbox): waits for the worker at /dsl-sandbox.js to
// post `{ ready: true }`, posts `{ source, defs }`, waits up to 1500 ms for `{ ir, problems }`, and terminates the worker with
// problem `timeout` when no reply arrives. One worker serves consecutive builds, the program
// (doc/piece-dsl.md, VM) and, for local-only pieces, `fn` evaluation. Builds and program messages
// share one queue, so each timeout measures only the message being processed.

import { LIMITS, PROGRAM } from './limits.js';
import { problem } from './problem-codes.js';

/** @typedef {import('./problem-codes.js').Problem} Problem */
/**
 * The subset of the Web Worker interface the client uses; tests pass an adapter.
 * @typedef {{ postMessage(m: unknown): void, terminate(): void, onmessage: ((e: { data: any }) => void) | null, onerror?: ((e: any) => void) | null }} WorkerLike
 */

/** @returns {WorkerLike} */
const browserWorker = () => /** @type {any} */ (new Worker('/dsl-sandbox.js'));

/** Longest wait for a new worker's `ready` message, ms. */
export const STARTUP_TIMEOUT_MS = 15_000;

/**
 * @typedef {{ id?: number, commands: any[], errors: { handler: string, line: number | null, message: string }[], dropped: number }} ProgramReply
 */

/**
 * `timeoutMs` bounds one build and one `fn` call; `programTimeoutMs` one program message.
 * @param {{ createWorker?: () => WorkerLike, timeoutMs?: number, startupMs?: number, programTimeoutMs?: number }} [opts]
 */
export function createSandbox({
  createWorker = browserWorker, timeoutMs = LIMITS.timeoutMs, startupMs = STARTUP_TIMEOUT_MS, programTimeoutMs = PROGRAM.batchTimeoutMs,
} = {}) {
  /** @type {WorkerLike | null} */
  let worker = null;
  /** Resolves true when the current worker has posted `ready`, false when it failed to load. @type {Promise<boolean>} */
  let ready = Promise.resolve(true);
  /** Settles `ready` of the current worker. @type {(ok: boolean) => void} */
  let markReady = () => {};
  /** @type {Promise<unknown>} */
  let queue = Promise.resolve();
  /** @type {Map<number, (v: { value?: unknown, error?: string }) => void>} */
  const fnWaiters = new Map();
  let fnId = 0;
  /** @type {((reply: any) => void) | null} */
  let buildWaiter = null;
  /** @type {{ id: number, resolve: (reply: any) => void } | null} */
  let programWaiter = null;
  let programId = 0;

  const ensure = () => {
    if (worker) return worker;
    const w = createWorker();
    ready = new Promise((resolve) => { markReady = resolve; });
    w.onmessage = (e) => {
      const d = e.data;
      if (d && typeof d === 'object' && d.ready === true) { markReady(true); return; }
      if (d && typeof d === 'object' && d.program) {
        const r = programWaiter;
        if (r && r.id === d.program.id) { programWaiter = null; r.resolve(d.program); }
        return;
      }
      if (d && typeof d === 'object' && d.fn) {
        const r = fnWaiters.get(d.fn.id);
        if (!r) return;
        fnWaiters.delete(d.fn.id);
        r(d.fn);
      } else if (buildWaiter) {
        const r = buildWaiter;
        buildWaiter = null;
        r(d);
      }
    };
    w.onerror = (e) => {
      markReady(false);
      failPending(`The sandbox failed: ${e?.message ?? 'unknown error'}`);
    };
    worker = w;
    return w;
  };

  /** Resolves every pending build, program message and `fn` call with an error; each clears its timer. @param {string} message */
  const failPending = (message) => {
    const pr = programWaiter;
    programWaiter = null;
    pr?.resolve({ commands: [], errors: [{ handler: 'vm', line: null, message }], dropped: 0 });
    const r = buildWaiter;
    buildWaiter = null;
    r?.({ ir: null, problems: [problem('runtime_error', '', message)] });
    const fns = [...fnWaiters.values()];
    fnWaiters.clear();
    for (const f of fns) f({ error: message });
  };

  /** Terminates the worker. Pending replies resolve first, so no stale timer outlives it. */
  const reset = () => {
    worker?.terminate();
    worker = null;
    markReady(false);
    failPending('The script sandbox restarted');
  };

  /**
   * Builds one script. Builds run one at a time in call order.
   * @param {string} source
   * @param {import('./defs.js').Defs} defs normalized definition tables
   * @param {{ snapshot?: Record<string, { fields: Record<string, unknown> }[]> }} [opts]
   * @returns {Promise<{ ir: any | null, problems: Problem[] }>}
   */
  function build(source, defs, { snapshot } = {}) {
    const run = async () => {
      const w = ensure();
      let startTimer;
      const started = await Promise.race([ready, new Promise((r) => { startTimer = setTimeout(() => r(false), startupMs); })]);
      clearTimeout(startTimer);
      if (!started) {
        reset();
        return { ir: null, problems: [problem('runtime_error', '', 'The script sandbox did not start')] };
      }
      return post(w);
    };
    const post = (/** @type {WorkerLike} */ w) => new Promise((resolve) => {
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
   * @returns {Promise<number | string | boolean | null>} the value, or null when the function throws, returns
   *   another kind of value, or gives no reply within `timeoutMs` (which terminates the worker)
   */
  function evalFn(source, arg) {
    const id = ++fnId;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!fnWaiters.delete(id)) return;
        reset();
        resolve(null);
      }, timeoutMs);
      fnWaiters.set(id, (r) => { clearTimeout(timer); resolve(r?.error === undefined ? fnValue(r?.value) : null); });
      ensure().postMessage({ fn: { id, source, arg } });
    });
  }

  /**
   * Sends one program message (`start`, `batch` or `stop`) to the worker that holds the program.
   * Without a reply within `programTimeoutMs` it terminates the worker and resolves `{ timeout: true }`.
   * @param {Record<string, unknown> & { op: string }} msg
   * @returns {Promise<ProgramReply | { timeout: true }>}
   */
  function program(msg) {
    const run = async () => {
      if (!worker) return { commands: [], errors: [{ handler: 'vm', line: null, message: 'The script sandbox is not running; save to build the piece again' }], dropped: 0 };
      const w = worker;
      if (!(await ready)) return { commands: [], errors: [{ handler: 'vm', line: null, message: 'The script sandbox did not start' }], dropped: 0 };
      return new Promise((resolve) => {
        const id = ++programId;
        const timer = setTimeout(() => {
          programWaiter = null;
          reset();
          resolve({ timeout: true });
        }, programTimeoutMs);
        programWaiter = { id, resolve: (/** @type {any} */ r) => { clearTimeout(timer); resolve(isProgramReply(r) ? r : { commands: [], errors: [{ handler: 'vm', line: null, message: 'The sandbox sent an invalid reply' }], dropped: 0 }); } };
        w.postMessage({ program: { ...msg, id } });
      });
    };
    const p = queue.then(run, run);
    queue = p;
    return /** @type {Promise<ProgramReply | { timeout: true }>} */ (p);
  }

  return { build, evalFn, program, dispose: reset };
}

/** A finite number, text or boolean from the worker; anything else is null. @param {unknown} v */
function fnValue(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  return typeof v === 'string' || typeof v === 'boolean' ? v : null;
}

/** @param {any} r */
function isProgramReply(r) {
  return r && typeof r === 'object' && Array.isArray(r.commands) && Array.isArray(r.errors) && typeof r.dropped === 'number';
}

/** @param {any} r */
function isReply(r) {
  return r && typeof r === 'object' && 'ir' in r && Array.isArray(r.problems);
}
