// The program side of the VM (doc/piece-dsl.md, Program and VM). The builder registers handlers
// and output calls through `createIo`; the sandbox worker drives a built program with
// `createRunner`: `start`, `batch` and `stop` return the commands the handlers sent.

import { hash32, mulberry32Once } from '../expr/rand.js';
import { parseSwpcPath } from '../expr/deps.js';
import { PROGRAM } from './limits.js';

/** An error with a problem code; run-script.js reports `code` instead of `runtime_error`. */
export class ProgramError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * @typedef {{ id: string, group: string } & Record<string, unknown>} SkyRecord
 * @typedef {{ id: string, group: string, fields: Record<string, unknown> }} WireObject
 * @typedef {{ kind: 'enter' | 'update' | 'exit', obj: WireObject, prev?: WireObject | null, traceId?: string | null, initial?: boolean }} WireEvent
 * @typedef {{ due: number, fn: Function, src: string, period: number | null, cancelled: boolean, handler: any }} Timer
 * @typedef {{ handler: string, line: number | null, message: string }} HandlerError
 * @typedef {{ commands: any[], errors: HandlerError[], dropped: number }} RunResult
 */

/**
 * Sequential mulberry32 seeded from the piece seed.
 * @param {number} seed
 */
export function createRng(seed) {
  let s = hash32(`seed:${seed}`);
  return () => {
    const v = mulberry32Once(s);
    s = (s + 0x6d2b79f5) | 0;
    return v;
  };
}

/** @param {WireObject} o @returns {SkyRecord} */
const recordOf = (o) => Object.freeze({ ...o.fields, id: o.id, group: o.group });
/** Orders objects by id. @param {{ id: string }} a @param {{ id: string }} b */
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Milliseconds of a sync name (`1/8`, `1/4d`, `1/8t`) at `bpm`.
 * @param {string} name @param {number} bpm
 */
export function syncMs(name, bpm) {
  const m = /^1\/(\d+)([dt]?)$/.exec(name);
  if (!m) return null;
  const whole = (4 * 60_000) / bpm;
  const mult = m[2] === 'd' ? 1.5 : m[2] === 't' ? 2 / 3 : 1;
  return (whole / Number(m[1])) * mult;
}

/** Key of one orbit source: object, quantity and time scale. @param {unknown} objectId @param {unknown} quantity @param {unknown} timeScale */
export const orbitKey = (objectId, quantity, timeScale) => `${objectId}|${quantity}|${timeScale}`;

/**
 * IO state shared by the builder's program calls and the runner.
 * @param {{ groupSource: (key: string) => string | null, seed: () => number, timeScaleOf: (opts: unknown, where: string) => number }} opts
 */
export function createIo({ groupSource, seed, timeScaleOf }) {
  /** @type {(() => number) | null} */
  let rng = null;
  const io = {
    /** @type {'setup' | 'handler' | 'idle'} */ phase: 'setup',
    /** @type {any[] | null} */ out: null,
    dropped: 0,
    /** @type {string | null} */ trace: null,
    /** @type {string | null} */ src: null,
    now: 0,
    /** @type {Set<string>} */ groups: new Set(),
    /** @type {Map<string, Map<string, SkyRecord>>} */ byGroup: new Map(),
    /** @type {Map<string, SkyRecord>} */ objects: new Map(),
    /** @type {Map<string, string>} */ fresh: new Map(),
    /** Orbits declared with follow(sky.orbit(...)), in IR order. @type {string[]} */ orbitKeys: [],
    /** @type {Map<string, number | null>} */ orbitValues: new Map(),
    /** @type {Timer[]} */ timers: [],
    groupSource,
    random: () => (rng ??= createRng(seed()))(),
  };

  /** @param {string} name */
  const inHandler = (name) => {
    if (io.phase !== 'handler') throw new ProgramError('io_outside_handler', `${name} works only inside a handler such as on(...) or every(...)`);
  };

  /**
   * Queues one command of the current handler.
   * @param {string} name @param {Record<string, unknown>} cmd
   */
  const emit = (name, cmd) => {
    inHandler(name);
    if (!io.out) return;
    if (io.out.length >= PROGRAM.commandsPerBatch) { io.dropped++; return; }
    io.out.push({ ...cmd, at: io.now, trace: io.trace, src: io.src });
  };

  /** @param {string} group @param {string} where */
  const followed = (group, where) => {
    if (!io.groups.has(group)) throw new TypeError(`${where}: the piece does not follow ${group}; add follow('${group}') to the setup code`);
  };

  const read = Object.freeze({
    /** @param {unknown} path */
    swpc(path) {
      inHandler('read.swpc()');
      const sp = parseSwpcPath(path);
      if (!sp) throw new TypeError("read.swpc(): path must be text such as 'kp.kp'");
      const { group, field } = sp;
      followed(group, `read.swpc('${path}')`);
      const objs = io.byGroup.get(group);
      const first = objs ? [...objs.values()].sort(byId)[0] : undefined;
      return first && Object.hasOwn(first, field) ? first[field] ?? null : null;
    },
    /** @param {unknown} key */
    group(key) {
      inHandler('read.group()');
      if (typeof key !== 'string') throw new TypeError('read.group(): key must be text');
      followed(key, `read.group('${key}')`);
      return Object.freeze([...(io.byGroup.get(key)?.values() ?? [])].sort(byId));
    },
    /** @param {unknown} id */
    object(id) {
      inHandler('read.object()');
      if (typeof id !== 'string') throw new TypeError('read.object(): id must be text');
      return io.objects.get(id) ?? null;
    },
    /** @param {unknown} source */
    freshness(source) {
      inHandler('read.freshness()');
      if (typeof source !== 'string') throw new TypeError('read.freshness(): source must be text');
      const s = io.groupSource(source) ?? source;
      return io.fresh.get(s) ?? 'loading';
    },
    /** @param {unknown} objectId @param {unknown} quantity @param {unknown} [opts] */
    orbit(objectId, quantity, opts) {
      inHandler('read.orbit()');
      if (typeof objectId !== 'string' || typeof quantity !== 'string') throw new TypeError("read.orbit(): use read.orbit(objectId, quantity), such as read.orbit('celestrak.stations:25544', 'latitude')");
      const timeScale = timeScaleOf(opts, 'read.orbit()');
      const key = orbitKey(objectId, quantity, timeScale);
      if (!io.orbitKeys.includes(key)) {
        const opt = timeScale === 1 ? '' : `, { timeScale: ${timeScale} }`;
        throw new TypeError(`read.orbit(): add follow(sky.orbit('${objectId}', '${quantity}'${opt})) to the setup code`);
      }
      return io.orbitValues.get(key) ?? null;
    },
  });

  /**
   * Schedules a one-shot call from a handler. The builder registers an `after` made in setup as
   * a handler instead (kind `after`).
   * @param {unknown} ms @param {unknown} fn
   */
  const after = (ms, fn) => {
    if (typeof ms !== 'number' || !Number.isFinite(ms)) throw new TypeError('after(): ms must be a number');
    if (typeof fn !== 'function') throw new TypeError('after(): the second argument must be a function');
    const pending = io.timers.filter((t) => !t.cancelled && t.period === null).length;
    if (pending >= PROGRAM.pendingTimers) throw new TypeError(`after(): at most ${PROGRAM.pendingTimers} calls can wait at once`);
    const delay = Math.min(Math.max(ms, PROGRAM.afterMs[0]), PROGRAM.afterMs[1]);
    /** @type {Timer} */
    const t = { due: io.now + delay, fn, src: io.src ?? 'after', period: null, cancelled: false, handler: null };
    io.timers.push(t);
    return () => { t.cancelled = true; };
  };

  const random = Object.freeze({
    random: () => io.random(),
    /** @param {unknown} n */
    randInt: (n) => {
      if (typeof n !== 'number' || !Number.isFinite(n) || n < 1) throw new TypeError('randInt(): n must be a number of at least 1');
      return Math.floor(io.random() * Math.floor(n));
    },
    /** @param {unknown} list */
    choose: (list) => {
      if (!Array.isArray(list) || list.length === 0) throw new TypeError('choose(): list must be a non-empty array');
      return list[Math.floor(io.random() * list.length)];
    },
  });

  /** A copy of Math whose `random` is the seeded generator. */
  const seededMath = Object.freeze(Object.fromEntries([
    ...Object.getOwnPropertyNames(Math).map((k) => [k, /** @type {any} */ (Math)[k]]),
    ['random', () => io.random()],
  ]));

  return { io, emit, read, after, random, seededMath, inHandler };
}

/**
 * Drives a built program. `handlers` carry their functions; `lineOf` maps a stack to a script line.
 * @param {{ handlers: any[], io: ReturnType<typeof createIo>['io'], tempo: number, lineOf: (stack: string | undefined) => number | null }} program
 */
export function createRunner({ handlers, io, tempo, lineOf }) {
  /** @type {HandlerError[]} */
  let errors = [];

  /**
   * Calls one handler function inside a handler context.
   * @param {any} h handler record, or null for a dynamic `after`
   * @param {Function} fn @param {unknown[]} args
   * @param {{ trace: string | null, src: string }} ctx
   */
  const call = (h, fn, args, ctx) => {
    if (h?.disabled) return;
    io.phase = 'handler';
    io.trace = ctx.trace;
    io.src = ctx.src;
    try {
      fn(...args);
    } catch (e) {
      const err = /** @type {any} */ (e);
      const message = err instanceof Error ? `${err.name === 'Error' ? '' : `${err.name}: `}${err.message}` : `Uncaught ${String(err)}`;
      errors.push({ handler: ctx.src, line: err instanceof Error ? lineOf(err.stack) : null, message });
      if (h) h.disabled = true;
    } finally {
      io.phase = 'idle';
      io.trace = null;
      io.src = null;
    }
  };

  const begin = () => {
    errors = [];
    io.out = [];
    io.dropped = 0;
  };

  /** @returns {RunResult} */
  const end = () => {
    const r = { commands: io.out ?? [], errors, dropped: io.dropped };
    io.out = null;
    return r;
  };

  /** Runs every timer due at or before `now`, in time order. @param {number} now */
  const runTimers = (now) => {
    const live = (/** @type {Timer} */ t) => !t.cancelled && !t.handler?.disabled;
    io.timers = io.timers.filter(live);
    for (let fired = 0; fired < PROGRAM.timerCallsPerBatch; fired++) {
      let next = null;
      for (const t of io.timers) if (t.due <= now && live(t) && (next === null || t.due < next.due)) next = t;
      if (!next) break;
      const late = now - next.due > PROGRAM.lateMs;
      io.now = late ? now : next.due;
      if (next.period === null) next.cancelled = true;
      else {
        next.due += next.period;
        // A late timer skips its missed calls: the next one is the first after `now`.
        if (late && next.due <= now) next.due += Math.ceil((now - next.due) / next.period + 1e-9) * next.period;
      }
      call(next.handler, next.fn, [io.now], { trace: null, src: next.src });
    }
    io.timers = io.timers.filter(live);
  };

  /** Stores the page's orbit values, given in `io.orbitKeys` order. @param {unknown} values */
  const setOrbits = (values) => {
    if (!Array.isArray(values)) return;
    io.orbitKeys.forEach((key, i) => {
      const v = values[i];
      io.orbitValues.set(key, typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(-1, v)) : null);
    });
  };

  /** @param {WireEvent} ev */
  const apply = (ev) => {
    const o = ev.obj;
    if (!o || typeof o.id !== 'string' || typeof o.group !== 'string') return null;
    const before = io.objects.get(o.id) ?? (ev.prev ? recordOf(ev.prev) : null);
    let map = io.byGroup.get(o.group);
    if (!map) { map = new Map(); io.byGroup.set(o.group, map); }
    if (ev.kind === 'exit') {
      map.delete(o.id);
      io.objects.delete(o.id);
      return { rec: before ?? recordOf(o), prev: before };
    }
    const rec = recordOf(o);
    map.set(o.id, rec);
    io.objects.set(o.id, rec);
    return { rec, prev: ev.kind === 'update' ? before : null };
  };

  /** @param {WireEvent} ev @param {SkyRecord} rec @param {SkyRecord | null} prev */
  const dispatch = (ev, rec, prev) => {
    const e = Object.freeze({ kind: ev.kind, traceId: ev.traceId ?? null, initial: ev.initial === true, prev });
    for (const h of handlers) {
      if (h.kind !== 'on' || h.group !== rec.group) continue;
      if (h.event !== '*' && h.event !== ev.kind) continue;
      call(h, h.fn, [rec, e], { trace: ev.traceId ?? null, src: h.id });
    }
  };

  return {
    /**
     * Starts the program: fills the sky copy and freshness, schedules timers and calls the
     * initial enters.
     * @param {{ groups: string[], objects: WireObject[], freshness?: { source: string, state: string }[], orbits?: (number | null)[] }} msg
     * @returns {RunResult}
     */
    start({ groups, objects, freshness = [], orbits }) {
      begin();
      io.phase = 'idle';
      io.now = 0;
      io.groups = new Set(Array.isArray(groups) ? groups : []);
      io.byGroup.clear();
      io.objects.clear();
      io.fresh.clear();
      io.orbitValues.clear();
      setOrbits(orbits);
      for (const f of Array.isArray(freshness) ? freshness : []) {
        if (f && typeof f.source === 'string' && typeof f.state === 'string') io.fresh.set(f.source, f.state);
      }
      io.timers = [];
      for (const h of handlers) {
        if (h.kind === 'every') {
          const period = h.sync ? syncMs(h.sync, tempo) : h.intervalMs;
          if (period) io.timers.push({ due: 0, fn: h.fn, src: h.id, period, cancelled: false, handler: h });
        } else if (h.kind === 'after') {
          io.timers.push({ due: h.ms, fn: h.fn, src: h.id, period: null, cancelled: false, handler: h });
        }
      }
      const initial = (Array.isArray(objects) ? objects : [])
        .filter((o) => o && io.groups.has(o.group))
        .sort(byId);
      for (const o of initial) {
        /** @type {WireEvent} */
        const ev = { kind: 'enter', obj: o, initial: true, traceId: null };
        const r = apply(ev);
        if (r) dispatch(ev, r.rec, null);
      }
      runTimers(0);
      return end();
    },

    /**
     * @param {{ now: number, events?: WireEvent[], freshness?: { source: string, state: string }[], orbits?: (number | null)[] }} msg
     * @returns {RunResult}
     */
    batch({ now, events = [], freshness = [], orbits }) {
      begin();
      setOrbits(orbits);
      const t = typeof now === 'number' && Number.isFinite(now) ? Math.max(now, io.now) : io.now;
      runTimers(t);
      io.now = t;
      for (const ev of Array.isArray(events) ? events : []) {
        if (!ev || !['enter', 'update', 'exit'].includes(ev.kind)) continue;
        const r = apply(ev);
        if (r) dispatch(ev, r.rec, r.prev);
      }
      for (const f of Array.isArray(freshness) ? freshness : []) {
        if (!f || typeof f.source !== 'string' || typeof f.state !== 'string') continue;
        io.fresh.set(f.source, f.state);
        for (const h of handlers) {
          if (h.kind !== 'freshness') continue;
          if (h.source !== '*' && h.source !== f.source && io.groupSource(h.source) !== f.source) continue;
          call(h, h.fn, [Object.freeze({ source: f.source, state: f.state })], { trace: null, src: h.id });
        }
      }
      return end();
    },

    /** @returns {RunResult} */
    stop() {
      io.timers = [];
      io.byGroup.clear();
      io.objects.clear();
      return { commands: [], errors: [], dropped: 0 };
    },
  };
}
