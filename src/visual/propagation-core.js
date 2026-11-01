/**
 * Propagation logic of the SGP4 worker (doc/visuals.md, Orbit propagation).
 * The worker shim (sgp4-worker.js) feeds messages and ticks; this module has
 * no Worker or DOM dependencies, so node:test can drive it.
 */
import { createOrbit, lookAngles, propagateAt, scaledTime, ORBIT_QUANTITIES } from '../sky/orbit.js';
import { DEFAULT_OBSERVER } from '../lib/settings.js';

/** Floats per position record: x, y, z (km), lat, lon (rad), alt (km), az, el (rad). */
export const STRIDE = 8;
export const TICK_MS = 500;
export const LEAD_MS = 500;
export const PATH_INTERVAL_MS = 5000;
/** Upper bound of samples per path; `lines.span` is at most 200 min at 1 min steps. */
export const MAX_PATH_STEPS = 240;

const ERROR_MESSAGES = {
  1: 'mean eccentricity out of range',
  2: 'mean motion below zero',
  3: 'perturbed eccentricity out of range',
  4: 'semi-latus rectum below zero',
  6: 'orbit decayed',
};

/** @param {string} objectId @param {string} quantity @param {number} timeScale */
export function orbitKey(objectId, quantity, timeScale) {
  return `${objectId}|${quantity}|${timeScale}`;
}

/**
 * @typedef {{ simMs: number, wallMs: number, speed: number, t0SimMs: number }} Clock
 * @typedef {{ id: string, group: string, fields: Record<string, unknown>, traceId?: string }} ObjectMsg
 * @typedef {{ objectId: string | null, group?: string | null, quantity: string, timeScale?: number }} OrbitSource
 * @typedef {{ key: string, group: string, fromSec: number, toSec: number, stepSec: number }} PathRequest
 */

/**
 * @param {Clock} c @param {number} wallMs
 */
export function simTime(c, wallMs) {
  return c.simMs + (wallMs - c.wallMs) * c.speed;
}

/**
 * Element sets become orbits with `createOrbit` (doc/sky-contract.md, Orbit
 * sources), which builds the satrec with `json2satrec(toOmm(fields))` and
 * computes the orbit quantities.
 * @param {{
 *   post: (msg: any, transfer?: Transferable[]) => void,
 *   now?: () => number,
 * }} deps
 */
export function createPropagationCore({ post, now = Date.now }) {
  /** @type {Map<string, { id: string, group: string, traceId: string | null, key: string, satrec: any, orbit: any, reported: boolean, setupError: string | null }>} */
  const entries = new Map();
  /** @type {string[]} */
  let ids = [];
  let idsVersion = 0;
  let sentIdsVersion = -1;
  /** @type {OrbitSource[]} */
  let sources = [];
  /** @type {string[]} */
  let orbitKeys = [];
  /** @type {{ id: string, quantity: string, timeScale: number }[]} */
  let orbitSpecs = [];
  let orbitVersion = 0;
  let sentOrbitVersion = -1;
  let observerDeg = { lat: DEFAULT_OBSERVER.lat, lon: DEFAULT_OBSERVER.lon };
  const t = now();
  /** @type {Clock} */
  let clock = { simMs: t, wallMs: t, speed: 1, t0SimMs: t };
  /** @type {PathRequest[]} */
  let pathRequests = [];
  let lastPathsAt = -Infinity;

  function setObjects(/** @type {ObjectMsg[]} */ objects) {
    const next = new Map();
    for (const o of objects ?? []) {
      if (!o || typeof o.id !== 'string') continue;
      const key = JSON.stringify(o.fields ?? null);
      const prev = entries.get(o.id);
      if (prev && prev.key === key) {
        prev.traceId = o.traceId ?? prev.traceId;
        next.set(o.id, prev);
        continue;
      }
      next.set(o.id, build(o, key));
    }
    entries.clear();
    for (const [k, v] of next) entries.set(k, v);
    const nextIds = [...entries.keys()].sort();
    if (nextIds.join('\n') !== ids.join('\n')) { ids = nextIds; idsVersion++; }
    rebuildOrbitKeys();
    lastPathsAt = -Infinity;
  }

  /** @param {ObjectMsg} o @param {string} key */
  function build(o, key) {
    const e = { id: o.id, group: o.group, traceId: o.traceId ?? null, key, satrec: null, orbit: null, reported: false, setupError: /** @type {string | null} */ (null) };
    try {
      e.orbit = createOrbit(/** @type {any} */ (o.fields));
      e.satrec = e.orbit.satrec;
    } catch (err) {
      e.setupError = err instanceof Error ? err.message : String(err);
    }
    return e;
  }

  function rebuildOrbitKeys() {
    const keys = [];
    const specs = [];
    const seen = new Set();
    for (const s of sources) {
      if (!s || !ORBIT_QUANTITIES.includes(s.quantity)) continue;
      const ts = Number.isFinite(s.timeScale) ? Math.min(1000, Math.max(1, /** @type {number} */ (s.timeScale))) : 1;
      const targets = s.objectId ? [s.objectId] : ids.filter((id) => entries.get(id)?.group === s.group);
      for (const id of targets) {
        const k = orbitKey(id, s.quantity, ts);
        if (seen.has(k)) continue;
        seen.add(k);
        keys.push(k);
        specs.push({ id, quantity: s.quantity, timeScale: ts });
      }
    }
    if (keys.join('\n') !== orbitKeys.join('\n')) { orbitKeys = keys; orbitVersion++; }
    orbitSpecs = specs;
  }

  /**
   * Propagates one entry and writes a position record into `out` at `offset`.
   * @returns {boolean} false when propagation failed
   */
  function stateAt(entry, ms, out, offset) {
    if (!entry.satrec) { fail(entry, null); fillNaN(out, offset); return false; }
    const st = propagateAt(entry.satrec, ms);
    if (!st.ok) {
      fail(entry, entry.satrec.error ?? null);
      fillNaN(out, offset);
      return false;
    }
    const { eci: p, geodetic: geo } = st;
    const look = lookAngles(observerDeg, p, st.gmst);
    out[offset] = p.x; out[offset + 1] = p.y; out[offset + 2] = p.z;
    out[offset + 3] = geo.latitude; out[offset + 4] = geo.longitude; out[offset + 5] = geo.height;
    out[offset + 6] = look.azimuth; out[offset + 7] = look.elevation;
    return true;
  }

  function fail(entry, code) {
    if (entry.reported) return;
    entry.reported = true;
    const message = entry.setupError ?? (code != null ? ERROR_MESSAGES[code] ?? `satrec error ${code}` : 'no position');
    post({
      type: 'trace',
      record: {
        traceId: entry.traceId,
        stage: 'VISUAL', component: 'sgp4', event: 'propagationFailed', level: 'warn',
        data: { objectId: entry.id, code, message },
      },
    });
  }

  /** One 2 Hz step: positions and orbit values for wall time now + LEAD_MS. */
  function tick() {
    const wallMs = now() + LEAD_MS;
    const simMs = simTime(clock, wallMs);
    const positions = new Float32Array(ids.length * STRIDE);
    ids.forEach((id, i) => {
      stateAt(/** @type {any} */ (entries.get(id)), simMs, positions, i * STRIDE);
    });
    const orbitValues = new Float32Array(orbitSpecs.length);
    /** @type {Map<string, any>} one orbit sample per object and time scale */
    const samples = new Map();
    orbitSpecs.forEach((s, i) => {
      const entry = entries.get(s.id);
      if (!entry?.orbit) { orbitValues[i] = NaN; return; }
      const sk = `${s.id}|${s.timeScale}`;
      if (!samples.has(sk)) {
        const ms = s.timeScale === 1 ? simMs : scaledTime(simMs, clock.t0SimMs, s.timeScale);
        let sample = null;
        try { sample = entry.orbit.sample(ms, observerDeg); } catch { sample = null; }
        samples.set(sk, sample);
      }
      const sample = samples.get(sk);
      const v = sample?.ok ? sample.values[s.quantity] : null;
      orbitValues[i] = typeof v === 'number' && Number.isFinite(v) ? v : NaN;
    });
    /** @type {any} */
    const msg = { type: 'sample', wallMs, simMs, idsVersion, positions, orbitVersion, orbitValues };
    if (sentIdsVersion !== idsVersion) { msg.ids = ids.slice(); sentIdsVersion = idsVersion; }
    if (sentOrbitVersion !== orbitVersion) { msg.orbitKeys = orbitKeys.slice(); sentOrbitVersion = orbitVersion; }
    post(msg, [positions.buffer, orbitValues.buffer]);
    if (pathRequests.length && wallMs - lastPathsAt >= PATH_INTERVAL_MS) {
      lastPathsAt = wallMs;
      computePaths(wallMs, simMs);
    }
  }

  function computePaths(wallMs, simMs) {
    for (const r of pathRequests) {
      const step = Math.max(0.5, r.stepSec);
      const steps = Math.min(MAX_PATH_STEPS, Math.max(1, Math.floor((r.toSec - r.fromSec) / step) + 1));
      const pids = ids.filter((id) => entries.get(id)?.group === r.group);
      const data = new Float32Array(pids.length * steps * STRIDE);
      pids.forEach((id, i) => {
        const entry = /** @type {any} */ (entries.get(id));
        for (let k = 0; k < steps; k++) {
          stateAt(entry, simMs + (r.fromSec + k * step) * 1000, data, (i * steps + k) * STRIDE);
        }
      });
      post({ type: 'paths', key: r.key, wallMs, simMs, ids: pids, steps, stepSec: step, fromSec: r.fromSec, data }, [data.buffer]);
    }
  }

  /** @param {any} msg */
  function handle(msg) {
    switch (msg?.type) {
      case 'objects': setObjects(msg.objects); break;
      case 'observer': {
        const lat = Number(msg.observer?.lat), lon = Number(msg.observer?.lon);
        if (Number.isFinite(lat) && Number.isFinite(lon)) {
          observerDeg = { lat, lon };
        } else {
          post({ type: 'trace', record: { stage: 'VISUAL', component: 'sgp4', event: 'invalidObserver', level: 'warn', data: { observer: describe(msg.observer) } } });
        }
        lastPathsAt = -Infinity;
        break;
      }
      case 'orbitSources': sources = Array.isArray(msg.sources) ? msg.sources : []; rebuildOrbitKeys(); break;
      case 'clock': {
        const c = msg.clock ?? {};
        if ([c.simMs, c.wallMs, c.speed, c.t0SimMs].every(Number.isFinite)) clock = { simMs: c.simMs, wallMs: c.wallMs, speed: c.speed, t0SimMs: c.t0SimMs };
        lastPathsAt = -Infinity;
        break;
      }
      case 'paths': pathRequests = Array.isArray(msg.requests) ? msg.requests.filter(validPath) : []; lastPathsAt = -Infinity; break;
      case 'tick': tick(); break;
      default: break;
    }
  }

  return { handle, tick, get ids() { return ids; }, get orbitKeys() { return orbitKeys; } };
}

/** @param {any} r */
function validPath(r) {
  return r && typeof r.key === 'string' && typeof r.group === 'string'
    && [r.fromSec, r.toSec, r.stepSec].every(Number.isFinite) && r.toSec >= r.fromSec && r.stepSec > 0;
}

/** A JSON-safe copy of an invalid value, for its trace record. @param {unknown} v */
function describe(v) {
  try { return JSON.parse(JSON.stringify(v ?? null)); } catch { return String(v); }
}

/** @param {Float32Array} out @param {number} offset */
function fillNaN(out, offset) {
  out.fill(NaN, offset, offset + STRIDE);
}
