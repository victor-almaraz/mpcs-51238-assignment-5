// Trace bus: structured records in a ring buffer (doc/console.md, Trace bus).

export const STAGES = Object.freeze(['SOURCE', 'CHANGE', 'REALTIME', 'BIND', 'AUDIO', 'VISUAL', 'RELOAD', 'SAFETY']);
export const LEVELS = Object.freeze(['info', 'warn', 'error']);
export const DEFAULT_CAPACITY = 2000;
export const MIN_CAPACITY = 500;
export const MAX_CAPACITY = 5000;

/**
 * @typedef {{
 *   t: string, traceId: string, stage: string, component: string, event: string,
 *   level: 'info' | 'warn' | 'error', data: Record<string, unknown>,
 *   replay?: number, synthetic?: true
 * }} TraceRecord
 */

/**
 * Validates a record and returns a normalized, deeply frozen copy.
 * @param {Partial<TraceRecord>} r
 * @param {() => number} now
 * @returns {TraceRecord}
 */
export function normalizeRecord(r, now = Date.now) {
  const rec = /** @type {Record<string, any>} */ (r);
  if (r === null || typeof r !== 'object') throw new TypeError('trace record must be an object');
  for (const k of ['traceId', 'component', 'event']) {
    if (typeof rec[k] !== 'string' || rec[k] === '') throw new TypeError(`trace record ${k} must be a non-empty string`);
  }
  if (!STAGES.includes(/** @type {string} */ (r.stage))) throw new TypeError(`trace record stage ${JSON.stringify(r.stage)} is not one of ${STAGES.join(', ')}`);
  const level = r.level ?? 'info';
  if (!LEVELS.includes(level)) throw new TypeError(`trace record level ${JSON.stringify(level)} is not one of ${LEVELS.join(', ')}`);
  const data = r.data ?? {};
  if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new TypeError('trace record data must be a plain object');
  let t = r.t;
  if (t === undefined) t = new Date(now()).toISOString();
  else if (typeof t !== 'string' || !Number.isFinite(Date.parse(t))) throw new TypeError(`trace record t ${JSON.stringify(t)} is not an ISO 8601 time`);
  /** @type {TraceRecord} */
  const out = { t, traceId: rec.traceId, stage: rec.stage, component: rec.component, event: rec.event, level, data: clone(data) };
  if (r.replay !== undefined) {
    if (typeof r.replay !== 'number' || !(r.replay > 0)) throw new TypeError('trace record replay must be a positive number (speed)');
    out.replay = r.replay;
  }
  if (r.synthetic !== undefined) {
    if (r.synthetic !== true) throw new TypeError('trace record synthetic must be true when present');
    out.synthetic = true;
  }
  return deepFreeze(out);
}

/**
 * Creates a trace bus.
 * @param {{ capacity?: number, now?: () => number }} [opts]
 */
export function createTraceBus({ capacity = DEFAULT_CAPACITY, now = Date.now } = {}) {
  let cap = checkCapacity(capacity);
  /** @type {(TraceRecord | undefined)[]} */
  let ring = new Array(cap);
  let head = 0; // index of the oldest record
  let size = 0;
  /** @type {Set<(r: TraceRecord) => void>} */
  const subs = new Set();

  /** @param {Partial<TraceRecord>} record */
  function trace(record) {
    const r = normalizeRecord(record, now);
    if (size < cap) {
      ring[(head + size) % cap] = r;
      size++;
    } else {
      ring[head] = r;
      head = (head + 1) % cap;
    }
    for (const fn of [...subs]) {
      try {
        fn(r);
      } catch {
        subs.delete(fn);
      }
    }
    return r;
  }

  /** @param {(r: TraceRecord) => void} fn */
  function subscribe(fn) {
    if (typeof fn !== 'function') throw new TypeError('subscribe expects a function');
    subs.add(fn);
    return () => {
      subs.delete(fn);
    };
  }

  /** @returns {TraceRecord[]} oldest first */
  function records() {
    const out = new Array(size);
    for (let i = 0; i < size; i++) out[i] = /** @type {TraceRecord} */ (ring[(head + i) % cap]);
    return out;
  }

  /**
   * Records of one trace id in stage order, then time order.
   * @param {string} traceId
   */
  function chain(traceId) {
    return records()
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => r.traceId === traceId)
      .sort((a, b) => STAGES.indexOf(a.r.stage) - STAGES.indexOf(b.r.stage)
        || Date.parse(a.r.t) - Date.parse(b.r.t) || a.i - b.i)
      .map(({ r }) => r);
  }

  function clear() {
    ring = new Array(cap);
    head = 0;
    size = 0;
  }

  /** @param {number} n */
  function setCapacity(n) {
    const next = checkCapacity(n);
    const kept = records().slice(-next);
    cap = next;
    ring = new Array(cap);
    kept.forEach((r, i) => { ring[i] = r; });
    head = 0;
    size = kept.length;
  }

  function capacityOf() {
    return cap;
  }

  function toJsonl() {
    return recordsToJsonl(records());
  }

  return { trace, subscribe, records, chain, clear, setCapacity, capacity: capacityOf, toJsonl };
}

/**
 * New trace id: prefix + UUID.
 * @param {string} [prefix]
 */
export function newTraceId(prefix = '') {
  return prefix + globalThis.crypto.randomUUID();
}

/**
 * Wraps a trace function so that it never throws into its caller; a rejected
 * record is reported on console.error with `label`. Without `fn` it does nothing.
 * @param {((record: any) => unknown) | undefined | null} fn
 * @param {string} label producer named in the report
 * @returns {(record: any) => void}
 */
export function safeTrace(fn, label) {
  if (!fn) return () => {};
  return (record) => {
    try { fn(record); } catch (err) { console.error(`trace rejected a ${label} record`, err); }
  };
}

/** @param {TraceRecord[]} records */
export function recordsToJsonl(records) {
  return records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : '');
}

/** @param {number} n */
function checkCapacity(n) {
  if (!Number.isInteger(n) || n < 1 || n > MAX_CAPACITY) {
    throw new RangeError(`trace buffer capacity must be an integer 1–${MAX_CAPACITY}, got ${n}`);
  }
  return n;
}

/** @template T @param {T} v @returns {T} */
function clone(v) {
  return v === undefined ? v : structuredClone(v);
}

/** @template T @param {T} o @returns {T} */
function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

// Default bus of the tab.
const bus = createTraceBus();
export const trace = bus.trace;
export const subscribe = bus.subscribe;
export const records = bus.records;
export const chain = bus.chain;
export const clear = bus.clear;
export const capacity = bus.capacity;
export const toJsonl = bus.toJsonl;

/**
 * Sets the default bus capacity (settings `data.consoleBuffer`, 500–5000).
 * @param {number} n
 */
export function setCapacity(n) {
  if (!Number.isInteger(n) || n < MIN_CAPACITY || n > MAX_CAPACITY) {
    throw new RangeError(`consoleBuffer must be an integer ${MIN_CAPACITY}–${MAX_CAPACITY}, got ${n}`);
  }
  bus.setCapacity(n);
}
