// Page side of the type-check worker (typecheck-worker.ts). `connectTypecheck(worker)` returns an
// object with the @valtown/codemirror-ts WorkerShape methods (each returns a promise), usable as
// the `worker` of `tsFacetWorker`, plus `check(source)` and `onProblems(fn)`.

/**
 * @param {{ postMessage(m: unknown): void, onmessage: ((e: { data: any }) => void) | null }} worker
 */
export function connectTypecheck(worker) {
  let next = 0;
  /** @type {Map<number, { resolve: (v: any) => void, reject: (e: Error) => void }>} */
  const pending = new Map();
  /** @type {Set<(problems: any[]) => void>} */
  const listeners = new Set();

  worker.onmessage = (e) => {
    const d = e.data;
    if (d?.event === 'problems') {
      for (const fn of listeners) fn(d.problems);
      return;
    }
    const p = pending.get(d?.id);
    if (!p) return;
    pending.delete(d.id);
    if ('error' in d) p.reject(new Error(d.error));
    else p.resolve(d.result);
  };

  /** @param {string} method @returns {(arg?: unknown) => Promise<any>} */
  const call = (method) => (arg) => new Promise((resolve, reject) => {
    const id = ++next;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, method, args: [arg] });
  });

  return {
    initialize: call('initialize'),
    updateFile: call('updateFile'),
    getLints: call('getLints'),
    getAutocompletion: call('getAutocompletion'),
    getHover: call('getHover'),
    /** @type {(source: string) => Promise<import('./problem-codes.js').Problem[]>} */
    check: /** @type {any} */ (call('check')),
    /** Registers a listener for the debounced problems after each edit; returns an unsubscribe. */
    onProblems(/** @type {(problems: any[]) => void} */ fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
