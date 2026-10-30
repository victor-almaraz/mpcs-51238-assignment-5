// `fn` escape hatch for local-only pieces (doc/piece-dsl.md, Escape hatch and Sandbox): the
// binding runtime reads the latest result synchronously; evaluation runs asynchronously in the
// sandbox worker, and results apply when they return.

/**
 * @param {{ evalFn: (source: string, arg: unknown) => Promise<unknown>, onResult?: () => void, maxEntries?: number }} opts
 * @returns {(args: unknown[], obj: any) => unknown}
 */
export function createLocalFn({ evalFn, onResult = () => {}, maxEntries = 2048 }) {
  /** @type {Map<string, { input: string, value: unknown, pending: boolean, started: boolean }>} */
  const cache = new Map();
  return (args, obj) => {
    const source = typeof args?.[0] === 'string' ? args[0] : null;
    if (source === null) return null;
    const key = `${source}\u0000${obj?.id ?? ''}`;
    const input = obj ? JSON.stringify(obj.fields ?? {}) : '';
    let e = cache.get(key);
    if (!e) {
      if (cache.size >= maxEntries) cache.delete(/** @type {string} */ (cache.keys().next().value));
      e = { input: '', value: null, pending: false, started: false };
      cache.set(key, e);
    }
    if (!e.pending && (!e.started || e.input !== input)) {
      const entry = e;
      entry.pending = true;
      entry.started = true;
      entry.input = input;
      const arg = obj ? { id: obj.id, group: obj.group, source: obj.source, fields: { ...obj.fields } } : null;
      evalFn(source, arg).then((v) => {
        entry.pending = false;
        entry.value = typeof v === 'number' ? (Number.isFinite(v) ? v : null) : typeof v === 'string' || typeof v === 'boolean' ? v : null;
        onResult();
      }, () => { entry.pending = false; entry.value = null; });
    }
    return e.value;
  };
}
