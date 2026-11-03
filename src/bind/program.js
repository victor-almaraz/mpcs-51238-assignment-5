// Program host (doc/bindings.md, Program host): feeds sky events and clock time to the VM in
// batches and turns the commands it sends back into checked, traced engine calls.

import { createTracer } from './tracer.js';
import { createSmoother } from './param.js';
import { createTokenBucket } from './trigger.js';
import { LIMITS } from './limits.js';
import { numberOr, panOf, pitchOf, velocityOf } from './values.js';
import { DEFAULTS, PROGRAM, RANGES } from '../dsl/limits.js';
import { own } from '../dsl/defs.js';
import { DEFS } from '../dsl/load-defs.js';
import { LAYER_DEFS } from '../visual/layer-defs.js';
import { coerceProp } from '../visual/layer-state.js';

/**
 * @typedef {{ program(msg: Record<string, unknown> & { op: string }): Promise<any> }} Vm
 * @typedef {{ code: 'handler_error' | 'handler_timeout', line: number | null, message: string }} RuntimeProblem
 */

const OPS = new Set(['play', 'hold', 'glide', 'stop', 'stopAll', 'set', 'layer']);
/** Error sources that mean the VM no longer holds the program. */
const FATAL = new Set(['setup', 'vm']);

/** @param {any} o */
const wire = (o) => ({ id: o.id, group: o.group, fields: o.fields ?? {} });
/** @param {number} x @param {number} lo @param {number} hi */
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/**
 * @param {{
 *   ir: any, vm: Vm, engine: any, sky: any, trace?: (r: any) => void,
 *   clock: { audioTime: () => number, now: () => number, wallNow?: () => number,
 *            setInterval: (fn: () => void, ms: number) => any, clearInterval: (id: any) => void },
 *   onProblem?: (p: RuntimeProblem) => void,
 *   onLayerValues?: () => void,
 *   newTraceId?: () => string,
 *   defs?: import('../dsl/defs.js').Defs,
 *   orbit?: (objectId: string, quantity: string, timeScale: number) => number | null,
 *   onStopped?: (p: RuntimeProblem) => void,
 * }} opts  `defs`: normalized definition tables (default DEFS), for the parameters `set` accepts;
 *   `orbit`: the current value of an orbit source (the propagator's latest sample);
 *   `onStopped`: called with the reason when the host stops itself (the watchdog, or a VM that
 *   lost the program), after its notes are released; the default reports it with `onProblem`
 */
export function createProgramHost({ ir, vm, engine, sky, trace = () => {}, clock, onProblem = () => {}, onLayerValues = () => {}, newTraceId, defs = DEFS, orbit = () => null, onStopped = onProblem }) {
  const emit = createTracer(trace, clock.wallNow ?? Date.now);
  let traceSeq = 0;
  const nextTraceId = newTraceId ?? (() => `program-${(clock.wallNow ?? Date.now)()}-${++traceSeq}`);
  const insts = new Map((ir.instruments ?? []).map((/** @type {any} */ i) => [i.id, i]));
  /** @type {Map<string, any>} */
  const slots = new Map();
  for (const owner of [...(ir.instruments ?? []), ir.master ?? { fx: [] }]) for (const s of owner.fx ?? []) slots.set(s.id, s);
  const layers = new Map((ir.layers ?? []).map((/** @type {any} */ l) => [l.id, l]));
  const groups = new Set(ir.groups ?? []);

  let running = false;
  let inflight = false;
  let t0 = 0;
  let timer = null;
  /** @type {(() => void)[]} */
  let unsub = [];
  /** @type {any[]} */ let queue = [];
  /** @type {any[]} */ let fresh = [];
  /** Held notes by tag. @type {Map<string, { inst: string, pitch: number, velocity: number, start: number }>} */
  const held = new Map();
  /** @type {Map<string, { sm: ReturnType<typeof createSmoother>, send: (v: number) => void, lastSent: number }>} */
  const smoothers = new Map();
  /** List parameters (`harmonics`) by target: the value waiting to be sent, rate-limited. @type {Map<string, { pending: number[] | null, lastSent: number }>} */
  const lists = new Map();
  const listIntervalMs = 1000 / PROGRAM.harmonicsPerSecond;
  /** Orbits declared with follow(sky.orbit(...)), in IR order. */
  const orbitSpecs = (ir.program?.orbits ?? []).map((/** @type {any} */ n) => ({ objectId: n.args[1], quantity: n.args[0], timeScale: n.args[2] ?? 1 }));
  /** @type {Record<string, Record<string, unknown>>} */
  let layerValues = {};
  const bucket = createTokenBucket(PROGRAM.noteStartsPerSecond, clock.now);
  let noteSeq = 0;

  /** @param {string} event @param {Record<string, unknown>} data @param {string | null} traceId @param {'info' | 'warn' | 'error'} [level] */
  const audio = (event, data, traceId, level = 'info') => emit('AUDIO', 'program', event, data, { traceId, level });
  /** @param {string} event @param {Record<string, unknown>} data @param {string | null} traceId @param {'info' | 'warn' | 'error'} [level] */
  const bind = (event, data, traceId, level = 'info') => emit('BIND', 'program', event, data, { traceId, level });
  /** @param {any} cmd @param {string} reason @param {string | null} traceId */
  const invalid = (cmd, reason, traceId) => bind('invalid', { op: String(cmd?.op), reason }, traceId, 'warn');

  /** @param {any} e */
  const onSky = (e) => {
    if (!running || !e?.obj || !groups.has(e.obj.group)) return;
    if (queue.length >= PROGRAM.queuedEvents) { queue.shift(); bind('dropped', { reason: 'event queue full' }, e.traceId ?? null, 'warn'); }
    queue.push({ kind: e.type, obj: wire(e.obj), prev: e.prev ? wire(e.prev) : null, traceId: e.traceId ?? null, initial: e.initial === true });
  };
  /** @param {any} e */
  const onFresh = (e) => {
    if (!running || !e?.freshness) return;
    fresh.push({ source: e.freshness.source, state: e.freshness.state });
  };

  /** @param {any} cmd @returns {any} */
  const instOf = (cmd, traceId) => {
    if (typeof cmd.inst !== 'string' || !insts.has(cmd.inst)) { invalid(cmd, 'unknown instrument', traceId); return null; }
    const inst = engine.get(cmd.inst);
    if (!inst) invalid(cmd, 'instrument not running', traceId);
    return inst;
  };

  /** Starts one note when the note-start budget allows. */
  const start = (/** @type {any} */ inst, /** @type {any} */ cmd, /** @type {number} */ pitch, /** @type {number} */ vel, /** @type {number} */ t, /** @type {string} */ tag, /** @type {string | null} */ traceId) => {
    if (!bucket.take()) { bind('dropped', { op: cmd.op, inst: cmd.inst, reason: 'note starts per second' }, traceId, 'warn'); return false; }
    inst.noteOn(pitch, vel, t, tag);
    const pan = panOf(cmd.pan);
    if (pan !== null && pan !== 0 && typeof inst.setVoicePan === 'function') inst.setVoicePan(tag, pan);
    audio('noteOn', { inst: cmd.inst, pitch, pitchRequested: cmd.pitch, velocity: vel, source: tag }, traceId);
    return true;
  };

  /** @param {string} tag @param {number} t @param {string | null} traceId */
  const release = (tag, t, traceId) => {
    const h = held.get(tag);
    if (!h) return;
    held.delete(tag);
    const inst = engine.get(h.inst);
    if (!inst) return;
    inst.noteOff(h.pitch, Math.max(t, h.start + LIMITS.minNoteSeconds), tag);
    audio('noteOff', { inst: h.inst, pitch: h.pitch, source: tag }, traceId);
  };

  /** @param {string} target @param {number} value @param {number} smoothMs @param {string | null} traceId */
  const setParam = (target, value, smoothMs, traceId) => {
    const dot = target.indexOf('.');
    const id = target.slice(0, dot);
    const param = target.slice(dot + 1);
    let entry = smoothers.get(target);
    if (!entry) {
      /** @type {(v: number) => void} */
      let send;
      /** @type {number | null} */
      let initial = null;
      if (insts.has(id)) {
        const inst = engine.get(id);
        if (!inst) return false;
        initial = numberOr(inst.getParams?.()?.[param], NaN);
        send = (v) => { const i = engine.get(id); if (i) i.setParam(param, v); };
      } else {
        initial = numberOr(slots.get(id)?.params?.[param], NaN);
        send = (v) => engine.setFxParam(id, param, v);
      }
      entry = { sm: createSmoother(0), send, lastSent: -Infinity };
      if (Number.isFinite(initial)) entry.sm.value = initial;
      smoothers.set(target, entry);
    }
    // Each set starts a new smoother from the current value, so its time constant is this call's.
    const from = entry.sm.value;
    entry.sm = createSmoother(smoothMs);
    if (smoothMs === 0) {
      entry.sm.value = value;
      entry.send(value);
      entry.lastSent = clock.now();
    } else {
      entry.sm.set(value, clock.now(), from);
    }
    audio(insts.has(id) ? 'setParam' : 'setFxParam', { target, value, smoothMs }, traceId);
    return true;
  };

  /** Current value of each declared orbit, in IR order. @returns {(number | null)[]} */
  const orbitValues = () => orbitSpecs.map((s) => {
    try {
      const v = orbit(s.objectId, s.quantity, s.timeScale);
      return typeof v === 'number' && Number.isFinite(v) ? clamp(v, -1, 1) : null;
    } catch {
      return null;
    }
  });

  /** Sends waiting list values whose interval has passed. */
  function flushLists() {
    const n = clock.now();
    for (const [target, e] of lists) {
      if (e.pending === null || n - e.lastSent < listIntervalMs) continue;
      const dot = target.indexOf('.');
      const value = e.pending;
      e.pending = null;
      e.lastSent = n;
      try {
        engine.get(target.slice(0, dot))?.setParam(target.slice(dot + 1), value);
      } catch (err) {
        bind('error', { target, message: err instanceof Error ? err.message : String(err) }, null, 'error');
      }
    }
  }

  /** Applies one command. @param {any} cmd @param {string | null} traceId */
  function apply(cmd, traceId) {
    if (!cmd || typeof cmd !== 'object' || !OPS.has(cmd.op)) { invalid(cmd, 'unknown op', traceId); return; }
    // A command's program time is at most the batch's `now`, so its audio time is at most the
    // latency ahead; a later `at` from a misbehaving VM is pulled back to that.
    const nowS = clock.audioTime();
    const t = clamp(t0 + numberOr(cmd.at, 0) / 1000 + PROGRAM.latencyS, nowS, nowS + PROGRAM.latencyS);
    switch (cmd.op) {
      case 'play': {
        const inst = instOf(cmd, traceId);
        const pitch = pitchOf(cmd.pitch);
        if (!inst) return;
        if (pitch === null) { invalid(cmd, 'pitch', traceId); return; }
        const tag = `prog:${cmd.inst}:n${++noteSeq}`;
        const dur = clamp(numberOr(cmd.durationMs, DEFAULTS.durationMs), RANGES.durationMs[0], RANGES.durationMs[1]);
        if (start(inst, cmd, pitch, velocityOf(cmd.velocity), t, tag, traceId)) inst.noteOff(pitch, t + dur / 1000, tag);
        return;
      }
      case 'hold': {
        const inst = instOf(cmd, traceId);
        const pitch = pitchOf(cmd.pitch);
        if (!inst) return;
        if (pitch === null || typeof cmd.key !== 'string' || !cmd.key || cmd.key.length > PROGRAM.keyChars) { invalid(cmd, 'pitch or key', traceId); return; }
        const tag = `prog:${cmd.inst}:k:${cmd.key}`;
        release(tag, t, traceId);
        const velocity = velocityOf(cmd.velocity);
        if (start(inst, cmd, pitch, velocity, t, tag, traceId)) held.set(tag, { inst: cmd.inst, pitch, velocity, start: t });
        return;
      }
      case 'glide': {
        const inst = instOf(cmd, traceId);
        const pitch = pitchOf(cmd.pitch);
        if (!inst) return;
        if (pitch === null || typeof cmd.key !== 'string') { invalid(cmd, 'pitch or key', traceId); return; }
        const tag = `prog:${cmd.inst}:k:${cmd.key}`;
        const h = held.get(tag);
        if (!h) return;
        const ms = clamp(numberOr(cmd.ms, PROGRAM.defaultGlideMs), PROGRAM.glideMs[0], PROGRAM.glideMs[1]);
        if (typeof inst.setVoicePitch === 'function') {
          inst.setVoicePitch(tag, pitch, ms);
          audio('setVoicePitch', { inst: cmd.inst, pitch, glideMs: ms, source: tag }, traceId);
          h.pitch = pitch;
        } else {
          release(tag, t, traceId);
          audio('fallback', { inst: cmd.inst, source: tag, reason: 'no setVoicePitch' }, traceId);
          if (start(inst, cmd, pitch, h.velocity, t, tag, traceId)) held.set(tag, { ...h, pitch, start: t });
        }
        return;
      }
      case 'stop':
        if (typeof cmd.inst === 'string' && typeof cmd.key === 'string') release(`prog:${cmd.inst}:k:${cmd.key}`, t, traceId);
        else invalid(cmd, 'key', traceId);
        return;
      case 'stopAll':
        for (const [tag, h] of [...held]) if (h.inst === cmd.inst) release(tag, t, traceId);
        return;
      case 'set': {
        const target = typeof cmd.target === 'string' ? cmd.target : '';
        const dot = target.indexOf('.');
        const id = target.slice(0, dot);
        const param = target.slice(dot + 1);
        if (dot < 1 || !param || (!insts.has(id) && !slots.has(id))) { invalid(cmd, 'target', traceId); return; }
        if (param === 'bypass') {
          if (!slots.has(id) || typeof cmd.value !== 'boolean') { invalid(cmd, 'bypass', traceId); return; }
          engine.setFxBypass(id, cmd.value);
          audio('setFxBypass', { slot: id, on: cmd.value }, traceId);
          return;
        }
        const spec = insts.has(id) ? own(defs.instruments, insts.get(id).type) : own(defs.effects, slots.get(id).type);
        const def = own(spec?.params, param);
        if (def?.kind === 'array' && insts.has(id)) {
          const n = /** @type {number} */ (def.length);
          if (!Array.isArray(cmd.value) || cmd.value.length > n || !cmd.value.every((/** @type {unknown} */ x) => typeof x === 'number' && Number.isFinite(x))) { invalid(cmd, 'value', traceId); return; }
          let e = lists.get(target);
          if (!e) { e = { pending: null, lastSent: -Infinity }; lists.set(target, e); }
          e.pending = cmd.value.map((/** @type {number} */ x) => clamp(x, /** @type {number} */ (def.min), /** @type {number} */ (def.max)));
          audio('setParam', { target, value: e.pending }, traceId);
          flushLists();
          return;
        }
        if (def?.kind !== 'number') { invalid(cmd, 'not a numeric parameter', traceId); return; }
        if (typeof cmd.value !== 'number' || !Number.isFinite(cmd.value)) { invalid(cmd, 'value', traceId); return; }
        if (!setParam(target, clamp(cmd.value, def.min, def.max), clamp(numberOr(cmd.smoothMs, DEFAULTS.smoothMs), RANGES.smoothMs[0], RANGES.smoothMs[1]), traceId)) invalid(cmd, 'instrument not running', traceId);
        return;
      }
      case 'layer': {
        const layer = layers.get(cmd.layer);
        const defs = LAYER_DEFS[layer?.type]?.props;
        if (!layer || !defs || typeof cmd.props !== 'object' || cmd.props === null) { invalid(cmd, 'layer', traceId); return; }
        /** @type {Record<string, number | string>} */
        const props = {};
        for (const [k, v] of Object.entries(cmd.props)) {
          const c = Object.hasOwn(defs, k) ? coerceProp(defs[k], v) : undefined;
          if (c === undefined) invalid(cmd, `property ${k}`, traceId);
          else props[k] = c;
        }
        if (Object.keys(props).length === 0) return;
        layerValues = { ...layerValues, [layer.id]: { ...layerValues[layer.id], ...props } };
        emit('VISUAL', 'program', 'layerSet', { layer: layer.id, props }, { traceId });
        onLayerValues();
        return;
      }
    }
  }

  /** @param {any} reply */
  function handle(reply) {
    if (!running) return;
    if (!reply || reply.timeout) {
      emit('SAFETY', 'program', 'programTimeout', { timeoutMs: PROGRAM.batchTimeoutMs }, { level: 'error' });
      halt(false);
      onStopped({ code: 'handler_timeout', line: null, message: `The program's handlers ran longer than ${PROGRAM.batchTimeoutMs} ms; the program stopped. Save or press Run to start it again.` });
      return;
    }
    /** @type {RuntimeProblem | null} */
    let lost = null;
    for (const e of Array.isArray(reply.errors) ? reply.errors : []) {
      const message = `${String(e?.message ?? 'error')}`;
      const p = /** @type {RuntimeProblem} */ ({ code: 'handler_error', line: Number.isInteger(e?.line) ? e.line : null, message });
      bind('handlerError', { handler: String(e?.handler ?? ''), line: e?.line ?? null, message }, null, 'error');
      if (FATAL.has(e?.handler)) lost ??= p;
      else onProblem(p);
    }
    if (lost) { halt(false); onStopped(lost); return; }
    const commands = Array.isArray(reply.commands) ? reply.commands : [];
    const dropped = numberOr(reply.dropped, 0) + Math.max(0, commands.length - PROGRAM.commandsPerBatch);
    if (dropped > 0) bind('dropped', { count: dropped, reason: 'commands per batch' }, null, 'warn');
    /** @type {Map<string, string>} */
    const timerTraces = new Map();
    for (const cmd of commands.slice(0, PROGRAM.commandsPerBatch)) {
      let traceId = typeof cmd?.trace === 'string' && cmd.trace ? cmd.trace : null;
      if (traceId === null) {
        const src = String(cmd?.src ?? '');
        if (!timerTraces.has(src)) timerTraces.set(src, nextTraceId());
        traceId = /** @type {string} */ (timerTraces.get(src));
      }
      try {
        apply(cmd, traceId);
      } catch (err) {
        bind('error', { op: String(cmd?.op), message: err instanceof Error ? err.message : String(err) }, traceId, 'error');
      }
    }
  }

  /** Advances parameter smoothing; sends each moving parameter at most 30 times per second. */
  function stepSmoothers() {
    const n = clock.now();
    for (const [target, e] of smoothers) {
      if (!e.sm.moving) continue;
      e.sm.step(n);
      if (n - e.lastSent < LIMITS.postIntervalMs && e.sm.moving) continue;
      e.lastSent = n;
      try {
        if (e.sm.value !== null) e.send(e.sm.value);
      } catch (err) {
        smoothers.delete(target);
        bind('error', { target, message: err instanceof Error ? err.message : String(err) }, null, 'error');
      }
    }
  }

  function tick() {
    if (!running) return;
    stepSmoothers();
    flushLists();
    if (inflight) return;
    inflight = true;
    const events = queue;
    const freshness = fresh;
    queue = [];
    fresh = [];
    const now = (clock.audioTime() - t0) * 1000;
    vm.program({ op: 'batch', now, events, freshness, orbits: orbitValues() }).then(handle, (err) => handle({ errors: [{ handler: 'vm', line: null, message: String(err?.message ?? err) }], commands: [], dropped: 0 }))
      .finally(() => { inflight = false; });
  }

  /** Stops batches and releases held notes; `tellVm` sends `stop` to a worker that still runs. */
  function halt(tellVm) {
    if (!running) return;
    running = false;
    if (timer !== null) clock.clearInterval(timer);
    timer = null;
    for (const u of unsub) u();
    unsub = [];
    const t = clock.audioTime();
    for (const tag of [...held.keys()]) release(tag, t, null);
    lists.clear();
    queue = [];
    fresh = [];
    if (tellVm) vm.program({ op: 'stop' }).catch(() => {});
  }

  return {
    /** Starts the program from setup. Resolves once the VM has replied to `start`. */
    async start() {
      if (running) return;
      running = true;
      t0 = clock.audioTime();
      for (const kind of ['enter', 'update', 'exit']) unsub.push(sky.on(kind, onSky));
      unsub.push(sky.on('freshness', onFresh));
      const objects = [];
      for (const g of groups) for (const o of sky.get(g) ?? []) objects.push(wire(o));
      const freshness = (sky.sources?.() ?? []).map((/** @type {any} */ f) => ({ source: f.source, state: f.state }));
      emit('RELOAD', 'program', 'start', { handlers: (ir.program?.handlers ?? []).map((/** @type {any} */ h) => h.id) }, {});
      let reply;
      try {
        reply = await vm.program({ op: 'start', groups: [...groups], objects, freshness, orbits: orbitValues() });
      } catch (err) {
        reply = { errors: [{ handler: 'vm', line: null, message: String(/** @type {any} */ (err)?.message ?? err) }], commands: [], dropped: 0 };
      }
      handle(reply);
      if (running) timer = clock.setInterval(tick, PROGRAM.batchMs);
    },
    /** Stops the program and releases its held notes. */
    stop() { halt(true); },
    /** Constant layer values set by the program, by layer id. */
    layerValues() { return layerValues; },
    /** Held notes, for the console's voices panel. */
    held() { return [...held].map(([tag, h]) => ({ tag, ...h })); },
    get running() { return running; },
  };
}
