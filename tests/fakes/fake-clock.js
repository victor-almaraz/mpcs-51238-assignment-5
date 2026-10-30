// Manual clock and timers for sky store tests.

/** Lets pending promise callbacks run. */
export async function flush() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

/** @param {number} startMs */
export function createFakeClock(startMs) {
  let t = startMs;
  let nextId = 1;
  /** @type {Map<number, { at: number, fn: () => void, every: number | null }>} */
  const pending = new Map();

  const timers = {
    /** @param {() => void} fn @param {number} ms */
    setTimeout(fn, ms = 0) {
      const id = nextId++;
      pending.set(id, { at: t + Math.max(0, ms), fn, every: null });
      return id;
    },
    /** @param {number} id */
    clearTimeout(id) {
      pending.delete(id);
    },
    /** @param {() => void} fn @param {number} ms */
    setInterval(fn, ms) {
      const id = nextId++;
      pending.set(id, { at: t + ms, fn, every: ms });
      return id;
    },
    /** @param {number} id */
    clearInterval(id) {
      pending.delete(id);
    },
  };

  /** Advances time, running due timers in time order and flushing promises after each. */
  async function advance(/** @type {number} */ ms) {
    const target = t + ms;
    await flush();
    for (;;) {
      let best = null;
      for (const [id, e] of pending) if (e.at <= target && (!best || e.at < best[1].at || (e.at === best[1].at && id < best[0]))) best = [id, e];
      if (!best) break;
      const [id, e] = best;
      t = e.at;
      if (e.every !== null) e.at += e.every;
      else pending.delete(id);
      e.fn();
      await flush();
    }
    t = target;
    await flush();
  }

  return {
    now: () => t,
    timers,
    advance,
    /** Number of pending one-shot timers. */
    timeouts: () => [...pending.values()].filter((e) => e.every === null).length,
    /** Delays of pending one-shot timers from now, ms. */
    timeoutDelays: () => [...pending.values()].filter((e) => e.every === null).map((e) => e.at - t),
  };
}

/** Minimal document with visibilityState. */
export function createFakeDoc() {
  /** @type {Set<() => void>} */
  const fns = new Set();
  const doc = {
    visibilityState: 'visible',
    /** @param {string} type @param {() => void} fn */
    addEventListener(type, fn) {
      if (type === 'visibilitychange') fns.add(fn);
    },
    /** @param {string} type @param {() => void} fn */
    removeEventListener(type, fn) {
      if (type === 'visibilitychange') fns.delete(fn);
    },
    /** @param {'visible' | 'hidden'} state */
    setVisibility(state) {
      doc.visibilityState = state;
      for (const fn of [...fns]) fn();
    },
  };
  return doc;
}
