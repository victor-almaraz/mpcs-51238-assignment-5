/**
 * Main-thread handle of the SGP4 worker, shared by the renderer and the
 * binding runtime (doc/visuals.md, Propagator interface).
 */
import { SampleBuffer } from './positions.js';
import { orbitKey, STRIDE } from './propagation-core.js';

const FLUSH_MS = 50;

/** @returns {Worker} */
function defaultWorker() {
  return new Worker(new URL('./sgp4-worker.js', import.meta.url), { type: 'module' });
}

/**
 * @param {{
 *   createWorker?: () => { postMessage(msg: any, transfer?: any[]): void, terminate(): void, onmessage: ((e: { data: any }) => void) | null },
 *   trace?: (record: any) => void,
 *   now?: () => number,
 *   setTimer?: (fn: () => void, ms: number) => any,
 * }} [options]
 */
export function createPropagator({ createWorker = defaultWorker, trace = () => {}, now = Date.now, setTimer = (fn, ms) => setTimeout(fn, ms) } = {}) {
  const buffer = new SampleBuffer();
  /** @type {Map<string, any>} */
  const paths = new Map();
  /** @type {Set<(sample: any) => void>} */
  const listeners = new Set();
  /** @type {Map<string, string>} */
  const traceIds = new Map();
  /** @type {string[]} */
  let groups = [];
  /** @type {any} */
  let sky = null;
  /** @type {(() => void)[]} */
  let unsub = [];
  /** @type {ReturnType<typeof createWorker> | null} */
  let worker = null;
  let running = false;
  let flushPending = false;
  /** @type {Map<string, any>} latest configuration message per type, replayed when the worker starts */
  const config = new Map();
  let failCount = 0;

  function ensureWorker() {
    if (worker) return worker;
    worker = createWorker();
    worker.onmessage = (e) => onMessage(e.data);
    for (const msg of config.values()) worker.postMessage(msg);
    return worker;
  }

  /** @param {any} msg */
  function send(msg) {
    if (msg.type !== 'objects') config.set(msg.type, msg);
    if (worker) worker.postMessage(msg);
  }

  /** @param {any} msg */
  function onMessage(msg) {
    if (msg?.type === 'sample') {
      buffer.push(msg);
      for (const fn of listeners) {
        try { fn(msg); } catch (err) { console.error(err); }
      }
    } else if (msg?.type === 'paths') {
      paths.set(msg.key, { ids: msg.ids, steps: msg.steps, stepSec: msg.stepSec, fromSec: msg.fromSec, wallMs: msg.wallMs, simMs: msg.simMs, data: msg.data, stride: STRIDE });
    } else if (msg?.type === 'trace' && msg.record) {
      const r = msg.record;
      try {
        trace({ t: new Date(now()).toISOString(), traceId: r.traceId ?? `sgp4-${++failCount}`, stage: r.stage, component: r.component, event: r.event, level: r.level, data: r.data ?? {} });
      } catch (err) { console.error('trace rejected a propagator record', err); }
    }
  }

  function scheduleFlush() {
    if (flushPending) return;
    flushPending = true;
    setTimer(flush, FLUSH_MS);
  }

  function flush() {
    flushPending = false;
    if (!sky || !groups.length) return;
    const objects = [];
    for (const g of groups) {
      for (const o of sky.get(g) ?? []) objects.push({ id: o.id, group: o.group, fields: o.fields, traceId: traceIds.get(o.id) });
    }
    ensureWorker().postMessage({ type: 'objects', objects });
    if (!running) { worker?.postMessage({ type: 'start' }); running = true; }
  }

  /** @param {any} e */
  function onSkyEvent(e) {
    if (!e?.obj || !groups.includes(e.obj.group)) return;
    if (e.traceId) traceIds.set(e.obj.id, e.traceId);
    if (e.type === 'exit') traceIds.delete(e.obj.id);
    scheduleFlush();
  }

  return {
    /** @param {any} store Sky (doc/sky-contract.md) */
    follow(store) {
      for (const u of unsub) u();
      sky = store;
      unsub = ['enter', 'update', 'exit'].map((type) => store.on(type, onSkyEvent));
      scheduleFlush();
    },
    /** @param {string[]} list */
    setGroups(list) {
      groups = [...new Set((list ?? []).filter((g) => typeof g === 'string' && g.startsWith('celestrak.')))].sort();
      if (!groups.length && running) { worker?.postMessage({ type: 'objects', objects: [] }); worker?.postMessage({ type: 'stop' }); running = false; }
      scheduleFlush();
    },
    /** @param {{ lat: number, lon: number }} observer */
    setObserver(observer) { send({ type: 'observer', observer }); },
    /** @param {import('./propagation-core.js').OrbitSource[]} sources */
    setOrbitSources(sources) { send({ type: 'orbitSources', sources }); },
    /** @param {import('./propagation-core.js').Clock} clock */
    setClock(clock) { send({ type: 'clock', clock }); },
    /** @param {import('./propagation-core.js').PathRequest[]} requests */
    setPaths(requests) { send({ type: 'paths', requests }); },
    /** @param {number} [nowMs] */
    positions(nowMs = now()) { return buffer.positions(nowMs); },
    /** Simulated time at wall time `nowMs`, or `null` before the first sample. @param {number} [nowMs] */
    simTime(nowMs = now()) { return buffer.simAt(nowMs); },
    /** @param {string} key */
    paths(key) { return paths.get(key) ?? null; },
    /** @param {string} objectId @param {string} quantity @param {number} [timeScale] */
    orbitValue(objectId, quantity, timeScale = 1) { return buffer.orbitValue(orbitKey(objectId, quantity, timeScale)); },
    /** @param {(sample: any) => void} fn */
    onSample(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    dispose() {
      for (const u of unsub) u();
      unsub = [];
      listeners.clear();
      worker?.postMessage({ type: 'stop' });
      worker?.terminate();
      worker = null;
      running = false;
    },
  };
}

/** @typedef {ReturnType<typeof createPropagator>} Propagator */
