// Audio host (doc/bindings.md, Audio host): starts the engine on Run and keeps it in sync with
// the IR. The engine module is injected (`src/audio-host/engine-imports.js` in the page, fakes in
// tests), so this module never imports src/audio/ itself.

import { createBindingRuntime } from '../bind/runtime.js';
import { createProgramHost } from '../bind/program.js';
import { PROGRAM } from '../dsl/limits.js';
import { buildModConfig } from '../bind/mod-config.js';
import { canonicalJson } from '../bind/canonical.js';
import { createTracer } from '../bind/tracer.js';
import { irToWidgets, chainsOf, slotsOf, changedIds } from './widgets.js';

export const PUMP_MS = 25;
export const LOOKAHEAD_S = 0.1;
/** Delay between fading out a replaced engine and disposing it (audio-engine-core.md, Teardown). */
export const ENGINE_SWAP_MS = 50;

export const NOTICES = Object.freeze({
  fault: 'Audio fault — output muted and reset',
  safetyError: 'Audio stopped — the safety stage failed. Restart audio to continue.',
  duck: 'Level reduced — sustained loud output',
  /** @param {string} type @param {string} owner */
  fxFault: (type, owner) => `Effect ${type} on ${owner} was reset and bypassed.`,
});

/**
 * @typedef {object} EngineModule
 * @property {() => Promise<any>} ensureRunning
 * @property {(ctx: any, opts: { realtime: boolean, masterGain: number }) => Promise<any>} buildMasterBus
 * @property {new (ctx: any, bus: any, opts: any) => any} Engine
 * @property {() => Promise<void>} [closeContext]  closes the context for Restart Audio
 *
 * @typedef {object} Notice
 * @property {'fault' | 'duck' | 'fxFault' | 'engineFault' | 'safetyError' | 'programRestart'} kind
 * @property {'assertive' | 'polite'} live   live region (doc/audio/audio-safety.md, Safety UI)
 * @property {string} message
 *
 * @typedef {object} HostOptions
 * @property {EngineModule} engineModule
 * @property {any} sky
 * @property {(record: any) => void} [trace]
 * @property {(notice: Notice) => void} [notify]
 * @property {{ setInterval: Function, clearInterval: Function, setTimeout?: Function }} [timers]
 * @property {() => number | null} [masterLevel]  linear master gain for `bus.fadeIn`, or null while
 *           muted; the host fades the master in after the engine exists and after every resume
 * @property {() => number} [now]       monotonic ms
 * @property {() => number} [wallNow]   epoch ms
 * @property {(desaturate: number) => void} [onVisualReaction]
 * @property {(ownerId: string, ir: any) => string} [ownerLabel]  name of an instrument in notices
 * @property {any} [orbit]  @property {any} [audio]  @property {any} [local]
 * @property {any} [fxParamDef]  @property {any} [groupSource]
 * @property {{ program(msg: any): Promise<any> } | null} [vm]  the sandbox VM that runs a piece's handlers
 * @property {(p: { code: string, line: number | null, message: string }) => void} [onProgramProblem]
 * @property {() => void} [onLayerValues]  a program set layer values
 */

/**
 * @param {HostOptions} options
 */
export function createAudioHost(options) {
  const { engineModule, sky } = options;
  if (!engineModule || !sky) throw new Error('createAudioHost: engineModule and sky are required');
  const trace = options.trace ?? (() => {});
  const notify = options.notify ?? (() => {});
  const timers = options.timers ?? { setInterval: globalThis.setInterval.bind(globalThis), clearInterval: globalThis.clearInterval.bind(globalThis) };
  const now = options.now ?? (() => globalThis.performance.now());
  const wallNow = options.wallNow ?? Date.now;
  const onVisualReaction = options.onVisualReaction ?? (() => {});
  const ownerLabel = options.ownerLabel ?? ((id) => id);
  const masterLevel = options.masterLevel ?? (() => null);
  const sleep = (/** @type {number} */ ms) => new Promise((resolve) => (timers.setTimeout ?? globalThis.setTimeout)(resolve, ms));
  const emit = createTracer(trace, wallNow);
  /** Engine-backed audio signals for layer properties (doc/audio/audio-engine-core.md, Analysis taps). */
  const audio = options.audio ?? {
    level: (/** @type {string} */ id) => (engine && typeof engine.level === 'function' ? engine.level(id) : null),
    spectrum: (/** @type {string} */ id, /** @type {number} */ bands) => (engine && typeof engine.spectrum === 'function' ? engine.spectrum(id, bands) : null),
    env: (/** @type {string} */ id, /** @type {string} */ tag) => (engine && typeof engine.voiceEnv === 'function' ? engine.voiceEnv(id, tag) : null),
  };

  let ctx = null;
  let bus = null;
  let engine = null;
  let engineSeed = null;
  let pumpTimer = null;
  let pumpFailing = false;
  /** True while run() resumes the context, so its statechange does not fade in twice. */
  let starting = false;
  let lastState = null;
  /** @type {any} */ let ir = null;
  /** @type {ReturnType<typeof createBindingRuntime> | null} */ let runtime = null;
  /** @type {ReturnType<typeof createProgramHost> | null} */ let program = null;
  let reactions = { detuneCents: 0, muted: [], desaturate: 0 };
  /** Faulted slot ids; each is reported once and un-bypassed on the next reload or Run. */
  const faulted = new Set();
  /** The safety stage threw (processorerror) and is silent for good: only Restart Audio recovers. */
  let safetyFailed = false;

  const followed = (keep = null) => {
    /** @type {Record<string, Record<string, number>>} */
    const out = {};
    for (const p of runtime ? runtime.paramValues() : []) {
      if (keep && !keep.has(p.binding)) continue;
      (out[p.inst] ??= {})[p.param] = p.value;
    }
    return out;
  };

  function onSafety(e) {
    const type = typeof e === 'string' ? e : e && typeof e.type === 'string' ? e.type : 'unknown';
    if (type === 'fault') {
      // The limiter holds silence for 250 ms, so the rebuild's unfaded disposal is inaudible (audio-safety.md).
      emit('SAFETY', 'master-bus', 'fault', { event: 'fault' }, { level: 'error' });
      notify({ kind: 'fault', live: 'assertive', message: NOTICES.fault });
      stopBindings();
      releaseAndRebuild(true);
    } else if (type === 'error') {
      safetyFailed = true;
      emit('SAFETY', 'master-bus', 'error', { event: 'processorerror' }, { level: 'error' });
      notify({ kind: 'safetyError', live: 'assertive', message: NOTICES.safetyError });
      stopBindings();
      releaseAndRebuild(false);
    } else if (type === 'duck') {
      emit('SAFETY', 'master-bus', 'duck', { event: 'duck' }, { level: 'warn' });
      notify({ kind: 'duck', live: 'polite', message: NOTICES.duck });
    } else {
      emit('SAFETY', 'master-bus', type, { event: type }, { level: 'info' });
    }
  }

  /** Releases every voice and, when `rebuild`, recreates nodes that may hold NaN state. */
  function releaseAndRebuild(rebuild) {
    if (!engine) return;
    try {
      if (typeof engine.releaseAll === 'function') engine.releaseAll(ctx ? ctx.currentTime : undefined);
      if (rebuild && typeof engine.rebuild === 'function') engine.rebuild();
    } catch (err) {
      emit('SAFETY', 'engine', 'error', { event: 'rebuild', message: err instanceof Error ? err.message : String(err) }, { level: 'error' });
    }
  }

  function onFxFault(owner, slotId) {
    if (faulted.has(slotId)) return;
    faulted.add(slotId);
    const type = (ir && slotsOf(ir).get(slotId)?.slot.type) ?? 'unknown';
    emit('SAFETY', 'engine', 'fxFault', { event: 'fxFault', owner, slot: slotId, type }, { level: 'warn' });
    notify({ kind: 'fxFault', live: 'polite', message: NOTICES.fxFault(type, ownerLabel(owner, ir)) });
  }

  /** A realtime bus starts with masterGain at 0: ramp it to the master level (audio-safety.md). */
  function fadeIn() {
    const level = masterLevel();
    if (bus && typeof bus.fadeIn === 'function' && level !== null && Number.isFinite(level)) bus.fadeIn(level);
  }

  /** Fades the master in after a resume the host did not start (an OS interruption ends). */
  function watchContext(c) {
    lastState = c.state ?? null;
    if (typeof c.addEventListener !== 'function') return;
    c.addEventListener('statechange', () => {
      if (c !== ctx) return;
      const prev = lastState;
      lastState = c.state;
      if (c.state === 'running' && prev !== 'running' && !starting && engine) fadeIn();
    });
  }

  async function build(seed) {
    if (!bus) bus = await engineModule.buildMasterBus(ctx, { realtime: true, masterGain: 0 });
    if (engine) {
      // A seed change replaces the engine: release and fade the old one, then dispose it.
      const old = engine;
      engine = null;
      const t = ctx.currentTime;
      try {
        if (typeof old.releaseAll === 'function') old.releaseAll(t);
        if (typeof old.fadeOutAll === 'function') old.fadeOutAll(t);
      } catch { /* already torn down */ }
      await sleep(ENGINE_SWAP_MS);
      if (typeof old.dispose === 'function') old.dispose();
    }
    engine = new engineModule.Engine(ctx, bus, {
      seed,
      realtime: true,
      lookahead: () => LOOKAHEAD_S,
      ks: bus && bus.worklets ? bus.worklets.ks : undefined,
      onFault: (detail) => {
        emit('SAFETY', 'engine', 'fault', { event: 'fault', detail: detail ?? null }, { level: 'error' });
        notify({ kind: 'engineFault', live: 'assertive', message: NOTICES.fault });
      },
      onError: (err) => {
        emit('SAFETY', 'engine', 'error', { event: 'error', message: err instanceof Error ? err.message : String(err) }, { level: 'error' });
      },
    });
    engineSeed = seed;
    if (bus && typeof bus.setHandler === 'function') bus.setHandler(onSafety);
    else emit('SAFETY', 'master-bus', 'noHandler', { message: 'master bus has no setHandler; fault and duck notices are unavailable' }, { level: 'warn' });
    engine.onFxFault(onFxFault);
    if (pumpTimer === null) {
      pumpTimer = timers.setInterval(() => {
        if (!engine) return;
        try {
          engine.pump(ctx.currentTime + LOOKAHEAD_S);
          pumpFailing = false;
        } catch (err) {
          if (!pumpFailing) emit('SAFETY', 'engine', 'error', { event: 'pump', message: err instanceof Error ? err.message : String(err) }, { level: 'error' });
          pumpFailing = true;
        }
      }, PUMP_MS);
    }
  }

  function applyReactions(state) {
    reactions = { detuneCents: state.detuneCents, muted: [...state.muted], desaturate: state.desaturate };
    if (engine && ir) engine.sync(irToWidgets(ir, reactions, followed()));
    onVisualReaction(state.desaturate);
  }

  function makeRuntime(pieceIr) {
    return createBindingRuntime({
      ir: pieceIr, engine, sky, trace,
      clock: {
        now, wallNow,
        audioTime: () => ctx.currentTime,
        setInterval: (fn, ms) => timers.setInterval(fn, ms),
        clearInterval: (id) => timers.clearInterval(id),
      },
      orbit: options.orbit, audio, local: options.local,
      fxParamDef: options.fxParamDef, groupSource: options.groupSource,
      onReactions: applyReactions,
    });
  }

  /** Clears faulted slots: a `bypass` message with the IR's state ends a fault. */
  function clearFaults(pieceIr) {
    const slots = slotsOf(pieceIr);
    for (const id of faulted) {
      const s = slots.get(id);
      if (s && !s.slot.bypass) engine.setFxBypass(id, false);
    }
    faulted.clear();
  }

  function stopBindings() {
    stopProgram();
    if (runtime) runtime.stop();
    runtime = null;
  }

  function stopProgram() {
    cancelRestart();
    if (program) program.stop();
    program = null;
  }

  // Restart (doc/bindings.md, Program host): a program that stopped itself starts again, so a
  // piece keeps playing until the user stops it; a program that keeps stopping gives up.
  /** @type {number[]} */ let restarts = [];
  let restartTimer = null;
  function cancelRestart() {
    if (restartTimer !== null) (timers.clearTimeout ?? globalThis.clearTimeout)(restartTimer);
    restartTimer = null;
  }
  /** @param {any} pieceIr @param {{ code: string, line: number | null, message: string }} p */
  function programStopped(pieceIr, p) {
    program = null;
    const t = now();
    restarts = restarts.filter((x) => t - x < PROGRAM.restartWindowMs);
    if (restarts.length >= PROGRAM.restarts) {
      emit('RELOAD', 'program', 'programGaveUp', { reason: p.code, restarts: restarts.length }, { level: 'error' });
      options.onProgramProblem?.(p);
      return;
    }
    restarts.push(t);
    emit('RELOAD', 'program', 'programRestart', { reason: p.code, message: p.message, restarts: restarts.length }, { level: 'warn' });
    notify({ kind: 'programRestart', live: 'polite', message: `The program stopped and restarts in ${PROGRAM.restartDelayMs / 1000} s: ${p.message}` });
    cancelRestart();
    restartTimer = (timers.setTimeout ?? globalThis.setTimeout)(() => {
      restartTimer = null;
      if (runtime && engine && ir === pieceIr && !program) startProgram(pieceIr, { restart: true });
    }, PROGRAM.restartDelayMs);
  }

  /**
   * Starts the piece's program when it registers handlers (doc/bindings.md, Program host). A start
   * that is not a restart (Run, a save) resets the restart count.
   * @param {any} pieceIr @param {{ restart?: boolean }} [o]
   */
  function startProgram(pieceIr, { restart = false } = {}) {
    if (!restart) restarts = [];
    if (!options.vm || !(pieceIr.program?.handlers?.length) || !engine) return;
    program = createProgramHost({
      ir: pieceIr, vm: options.vm, engine, sky, trace,
      clock: {
        now, wallNow,
        audioTime: () => ctx.currentTime,
        setInterval: (fn, ms) => timers.setInterval(fn, ms),
        clearInterval: (id) => timers.clearInterval(id),
      },
      onProblem: options.onProgramProblem,
      onStopped: (p) => programStopped(pieceIr, p),
      onLayerValues: options.onLayerValues,
      orbit: options.orbit,
    });
    program.start().catch((err) => {
      emit('BIND', 'program', 'error', { message: err instanceof Error ? err.message : String(err) }, { level: 'error' });
    });
  }

  const host = {
    /**
     * Starts the piece. Call synchronously inside the Run click handler: `ensureRunning()` runs
     * before the first await, which keeps user activation.
     * @param {any} pieceIr validated IR
     */
    async run(pieceIr) {
      if (safetyFailed) throw new Error('The safety stage failed; restart audio before running');
      const wasRunning = !!ctx && ctx.state === 'running';
      starting = true;
      let c;
      try {
        c = await engineModule.ensureRunning();
      } finally {
        starting = false;
      }
      const fresh = c !== ctx;
      if (fresh) { ctx = c; bus = null; engine = null; watchContext(c); }
      lastState = c.state ?? lastState;
      const seed = pieceIr.seed ?? 1;
      const hadEngine = !!engine;
      if (!engine || engineSeed !== seed) await build(seed);
      // After the engine exists, and after every resume (doc/audio/audio-safety.md, Fades).
      if (!hadEngine || !wasRunning) fadeIn();
      stopBindings();
      const prev = ir;
      ir = pieceIr;
      reactions = { detuneCents: 0, muted: [], desaturate: 0 };
      onVisualReaction(0);
      if (prev) {
        const chains = chainsOf(ir);
        for (const [owner, slots] of chainsOf(prev)) if (!chains.has(owner) && slots.length) engine.setFx(owner, []);
      }
      engine.sync(irToWidgets(ir, reactions));
      engine.setTempo(ir.tempo ?? 120);
      for (const i of ir.instruments) engine.setFx(i.id, i.fx ?? []);
      engine.setFx('master', ir.master?.fx ?? []);
      const mc = buildModConfig(ir);
      engine.setLfos(mc.lfos);
      engine.setMods(mc.routes);
      clearFaults(ir);
      runtime = makeRuntime(ir);
      runtime.start();
      startProgram(ir);
      emit('RELOAD', 'audio-host', 'run', { instruments: ir.instruments.map((i) => i.id), bindings: (ir.bindings ?? []).map((b) => b.id) });
    },

    /**
     * Hot reload (doc/piece-dsl.md, Hot reload, steps 2–8). Returns the changed ids.
     * @param {any} next validated IR
     * @returns {{ changed: string[] }}
     */
    reload(next) {
      if (!engine || !runtime || !ir) { ir = next; return { changed: [] }; }
      const prev = ir;
      const changed = [];

      // Followed values survive for bindings that do not change.
      const prevBindings = new Map((prev.bindings ?? []).map((b) => [b.id, canonicalJson(b)]));
      const keep = new Set((next.bindings ?? []).filter((b) => prevBindings.get(b.id) === canonicalJson(b)).map((b) => b.id));
      const values = followed(keep);

      // Instruments (without their chains, which setFx handles).
      changed.push(...changedIds(prev.instruments, next.instruments, ({ fx, ...rest }) => rest));
      const nextChains = chainsOf(next);
      const prevChains = chainsOf(prev);
      for (const [owner, slots] of prevChains) if (!nextChains.has(owner) && slots.length) engine.setFx(owner, []);
      ir = next;
      engine.sync(irToWidgets(next, reactions, values));
      if ((prev.tempo ?? 120) !== (next.tempo ?? 120)) engine.setTempo(next.tempo ?? 120);

      // Effect chains whose slot list changed.
      for (const [owner, slots] of nextChains) {
        const before = prevChains.get(owner) ?? [];
        if (canonicalJson(before) !== canonicalJson(slots)) {
          engine.setFx(owner, slots);
          changed.push(...changedIds(before, slots));
        }
      }

      // Modulation.
      const a = buildModConfig(prev);
      const b = buildModConfig(next);
      if (canonicalJson(a.lfos) !== canonicalJson(b.lfos) || canonicalJson(a.routes) !== canonicalJson(b.routes)) {
        engine.setLfos(b.lfos);
        engine.setMods(b.routes);
        changed.push(...changedIds(prev.lfos ?? [], next.lfos ?? []));
        if (canonicalJson(a.routes) !== canonicalJson(b.routes)) changed.push('mods');
      }
      clearFaults(next);

      // Bindings, then layers (the renderer rebuilds them), then the program, which restarts from setup.
      changed.push(...runtime.reload(next).bindings);
      changed.push(...changedIds(prev.layers ?? [], next.layers ?? []));
      if (program || next.program?.handlers?.length) {
        stopProgram();
        startProgram(next);
        changed.push('program');
      }
      const unique = [...new Set(changed)];
      emit('RELOAD', 'audio-host', 'reload', { changed: unique });
      return { changed: unique };
    },

    /** Stops the piece: releases every binding and removes the instruments with a fade. */
    stop() {
      stopBindings();
      if (engine) engine.sync([]);
    },

    /**
     * Stops the bindings and the pump, fades the engine out and disposes it ENGINE_SWAP_MS later.
     * @returns {Promise<void>} resolves once the engine is disposed
     */
    dispose() {
      stopBindings();
      if (pumpTimer !== null) timers.clearInterval(pumpTimer);
      pumpTimer = null;
      const old = engine;
      engine = null;
      if (!old) return Promise.resolve();
      try {
        const t = ctx ? ctx.currentTime : 0;
        if (typeof old.releaseAll === 'function') old.releaseAll(t);
        if (typeof old.fadeOutAll === 'function') old.fadeOutAll(t);
      } catch { /* already torn down */ }
      return sleep(ENGINE_SWAP_MS).then(() => { if (typeof old.dispose === 'function') old.dispose(); });
    },

    /** Restart Audio after a safety-stage error: disposes the engine and closes the context. */
    async restartAudio() {
      await host.dispose();
      bus = null;
      ctx = null;
      engineSeed = null;
      if (typeof engineModule.closeContext === 'function') await engineModule.closeContext();
      safetyFailed = false;
    },

    get safetyFailed() { return safetyFailed; },

    /** Forwards a propagator post (2 Hz) to the runtime. */
    orbitTick() { if (runtime) runtime.orbitTick(); },

    get runtime() { return runtime; },
    get program() { return program; },
    get engine() { return engine; },
    get ctx() { return ctx; },
    get ir() { return ir; },
    get reactions() { return { ...reactions, muted: [...reactions.muted] }; },
  };
  return host;
}
