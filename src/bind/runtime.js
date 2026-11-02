// Binding runtime (doc/bindings.md): applies the IR's bindings and data modulation sources to
// sky events as bounded, traced calls on the engine. Everything it uses is injected.

import { createTracer } from './tracer.js';
import { createSkyResolvers } from './sky-resolvers.js';
import { buildModConfig } from './mod-config.js';
import { computeReactionState } from './reactions.js';
import { canonicalJson } from './canonical.js';
import { LIMITS } from './limits.js';
import { createVoicesBinding } from './voices.js';
import { createTriggerBinding } from './trigger.js';
import { createParamBinding } from './param.js';
import { createDataSource } from './data-source.js';
import { evaluateLayerProps } from './layers.js';
import { DEFS } from '../dsl/load-defs.js';

/**
 * @typedef {object} Clock
 * @property {() => number} now                 monotonic milliseconds (performance.now)
 * @property {() => number} audioTime           context seconds (ctx.currentTime)
 * @property {() => number} [wallNow]           epoch milliseconds, for trace timestamps
 * @property {(fn: () => void, ms: number) => any} setInterval
 * @property {(id: any) => void} clearInterval
 *
 * @typedef {object} RuntimeOptions
 * @property {any} ir                           validated IR (doc/piece-dsl.md)
 * @property {any} engine                       `get(id)`, EngineFx, EngineMod
 * @property {any} sky                          Sky (doc/sky-contract.md)
 * @property {Clock} clock
 * @property {(record: any) => void} [trace]    trace bus sink
 * @property {(objectId: string, quantity: string, timeScale: number) => number | null} [orbit]
 *           latest orbit quantity from the propagator
 * @property {{ level?: Function, spectrum?: Function, env?: (inst: string, source: string) => number | null }} [audio]
 *           audio signals for layer properties; `env` receives the voice's source tag
 * @property {(args: any[], obj: any) => unknown} [local]   latest `fn` result
 * @property {import('../dsl/defs.js').Defs} [defs]  normalized definition tables (default DEFS); effect
 *           follows read which parameters are enums from them
 * @property {(state: import('./reactions.js').ReactionState) => void} [onReactions]
 * @property {(group: string) => string} [groupSource]     source registry id of a group
 *
 * @typedef {object} BindingEnv
 * @property {any} engine
 * @property {any} sky
 * @property {ReturnType<typeof createTracer>} emit
 * @property {() => number} now
 * @property {() => number} audioTime
 * @property {(id: string) => any} instrument   IR instrument by id
 * @property {(id: string) => { slot: any, owner: string } | null} slot  IR effect slot by id
 * @property {(id: string) => any} ctxFor       expression context for a binding or source id
 * @property {any} voiceLedger
 * @property {import('../dsl/defs.js').Defs} defs
 */

const SKY_EVENTS = ['enter', 'update', 'exit'];

/**
 * @param {RuntimeOptions} options
 */
export function createBindingRuntime(options) {
  const { engine, sky, clock } = options;
  if (!engine || !sky || !clock) throw new Error('createBindingRuntime: engine, sky and clock are required');
  const emit = createTracer(options.trace ?? (() => {}), clock.wallNow ?? Date.now);
  const groupSource = options.groupSource ?? ((g) => g);
  const onReactions = options.onReactions ?? (() => {});
  const resolvers = createSkyResolvers(sky);

  let ir = options.ir;
  /** @type {Map<string, any>} */ let instruments = new Map();
  /** @type {Map<string, { slot: any, owner: string, chain: any[] }>} */ let slots = new Map();
  const indexIr = () => {
    instruments = new Map(ir.instruments.map((i) => [i.id, i]));
    slots = new Map();
    const chains = [...ir.instruments.map((i) => [i.id, i.fx ?? []]), ['master', ir.master?.fx ?? []]];
    for (const [owner, chain] of chains) for (const s of chain) slots.set(s.id, { slot: s, owner, chain });
  };
  indexIr();

  /** Shared context fields; per-binding contexts inherit from it, so a reload updates them. */
  const base = {
    seed: ir.seed ?? 1,
    scale: ir.scale ?? { root: 'C', mode: 'chromatic' },
    ...resolvers,
    orbit: options.orbit,
    level: options.audio?.level,
    spectrum: options.audio?.spectrum,
    env: (inst, objectId) => {
      if (!options.audio?.env || objectId === null) return null;
      for (const h of bindings.values()) {
        if (h.kind === 'voices' && h.binding.inst === inst) {
          const tag = h.voiceTag(objectId);
          if (tag) return options.audio.env(inst, tag);
        }
      }
      return null;
    },
    local: options.local,
  };
  const ctxFor = (id) => Object.assign(Object.create(base), { bindingId: id });

  // Voice ledger: counts the runtime's own voices per instrument, so a noteOn that makes the
  // engine steal a voice is traced as `stolen`.
  const sustainedCount = new Map();
  /** @type {Map<string, number[]>} */ const triggerEnds = new Map();
  const voiceLedger = {
    sustained(inst, d) { sustainedCount.set(inst, Math.max(0, (sustainedCount.get(inst) ?? 0) + d)); },
    trigger(inst, end) {
      if (!triggerEnds.has(inst)) triggerEnds.set(inst, []);
      triggerEnds.get(inst).push(end);
    },
    count(inst, t) {
      const ends = (triggerEnds.get(inst) ?? []).filter((e) => e > t);
      triggerEnds.set(inst, ends);
      return (sustainedCount.get(inst) ?? 0) + ends.length;
    },
    beforeNoteOn(inst, cap, source, traceId, component) {
      const t = clock.audioTime();
      const n = voiceLedger.count(inst, t);
      let total = 0;
      for (const id of instruments.keys()) total += voiceLedger.count(id, t);
      if (n >= cap || total >= LIMITS.voicesTotal) {
        emit('AUDIO', component, 'stolen', { inst, source, voices: n, cap, total, totalCap: LIMITS.voicesTotal }, { traceId, level: 'warn' });
      }
    },
  };

  /** @type {BindingEnv} */
  const env = {
    engine, sky, emit,
    now: () => clock.now(),
    audioTime: () => clock.audioTime(),
    instrument: (id) => instruments.get(id) ?? null,
    slot: (id) => slots.get(id) ?? null,
    ctxFor,
    voiceLedger,
    defs: options.defs ?? DEFS,
  };

  /** @type {Map<string, any>} */ const bindings = new Map();
  /** @type {Map<string, any>} */ const dataSources = new Map();
  /** @type {Map<string, string>} */ const fresh = new Map();
  let reactionState = { detuneCents: 0, muted: [], desaturate: 0, active: [] };
  /** Layer properties already reported as failing; reported once until the next reload. */
  const layerErrors = new Set();
  let unsubscribe = [];
  let timer = null;
  let running = false;

  /** Runs `fn` for handler `h`; a throw is traced at level error and disables the handler. */
  function guard(h, fn, traceId = null) {
    if (h.disabled) return;
    try {
      fn();
    } catch (err) {
      h.disabled = true;
      const message = err instanceof Error ? err.message : String(err);
      const component = h.kind === 'data' ? `mod.${h.id}` : `bind.${h.id}`;
      emit('BIND', component, 'error', { binding: h.id, error: err?.name ?? 'Error', message, disabled: true }, { traceId, level: 'error' });
      try { h.release(traceId); } catch { /* already reported */ }
    }
  }

  function createBinding(b) {
    const make = b.kind === 'voices' ? createVoicesBinding
      : b.kind === 'trigger' ? createTriggerBinding
      : b.kind === 'param' || b.kind === 'fxParam' || b.kind === 'fxBypass' ? createParamBinding
      : null;
    if (!make) throw new Error(`Binding ${b.id}: unknown kind "${b.kind}"`);
    try {
      return make(b, env);
    } catch (err) {
      // A binding that cannot be built is disabled like one that throws later.
      const h = { id: b.id, kind: b.kind, binding: b, groups: new Set(), usesOrbit: false, disabled: false,
        init() { throw err; }, onEvent() {}, onOrbit() {}, release() {}, voiceTag() { return null; }, snapshot() { return []; } };
      return h;
    }
  }

  /**
   * Identity of a binding for hot reload: its IR entry and its instrument's type; for an effect
   * follow, the slot list of its chain, because setFx on a changed chain resets the slot's values.
   */
  const bindingKey = (b) => {
    if (b.kind === 'fxParam' || b.kind === 'fxBypass') return canonicalJson({ b, chain: slots.get(b.slot)?.chain ?? null });
    return canonicalJson({ b, type: instruments.get(b.inst)?.type ?? null });
  };

  function addBinding(b) {
    const h = createBinding(b);
    h.key = bindingKey(b);
    bindings.set(b.id, h);
    guard(h, () => h.init());
  }

  function addDataSource(spec) {
    const h = createDataSource(spec, env);
    h.key = canonicalJson(spec);
    dataSources.set(spec.id, h);
    guard(h, () => h.init());
  }

  const pieceSources = () => [...new Set((ir.groups ?? []).map(groupSource))];

  function updateReactions(traceId = null) {
    const next = computeReactionState(ir.reactions ?? [], fresh, ir.instruments.map((i) => i.id), pieceSources(), groupSource);
    if (canonicalJson(next) === canonicalJson(reactionState)) return;
    reactionState = next;
    emit('BIND', 'reactions', 'reaction', {
      detuneCents: next.detuneCents, muted: next.muted, desaturate: next.desaturate,
      active: next.active, states: Object.fromEntries(fresh),
    }, { traceId });
    try {
      onReactions(next);
    } catch (err) {
      emit('BIND', 'reactions', 'error', { message: err instanceof Error ? err.message : String(err) }, { traceId, level: 'error' });
    }
  }

  function readFreshness() {
    const sources = new Set(pieceSources());
    for (const r of ir.reactions ?? []) if (r.source !== '*') sources.add(groupSource(r.source));
    for (const s of sources) {
      if (!fresh.has(s)) {
        const f = sky.freshness(s);
        fresh.set(s, f ? f.state : 'loading');
      }
    }
  }

  function onSkyEvent(e) {
    const group = e.obj.group;
    resolvers.invalidate(group);
    for (const h of bindings.values()) if (h.groups.has(group)) guard(h, () => h.onEvent(e), e.traceId);
    for (const h of dataSources.values()) if (h.groups.has(group)) guard(h, () => h.onEvent(e), e.traceId);
  }

  function onFreshness(e) {
    fresh.set(e.freshness.source, e.freshness.state);
    updateReactions(e.traceId ?? null);
  }

  function tick() {
    const now = clock.now();
    for (const h of bindings.values()) if (h.tick) guard(h, () => h.tick(now));
    for (const h of dataSources.values()) guard(h, () => h.tick(now));
  }

  const runtime = {
    /** Subscribes to the sky, starts every binding and data source, and starts the 30 Hz loop. */
    start() {
      if (running) throw new Error('Binding runtime already started');
      running = true;
      unsubscribe = [
        ...SKY_EVENTS.map((t) => sky.on(t, onSkyEvent)),
        sky.on('freshness', onFreshness),
      ];
      for (const b of ir.bindings ?? []) addBinding(b);
      for (const spec of buildModConfig(ir).dataSources) addDataSource(spec);
      readFreshness();
      updateReactions();
      timer = clock.setInterval(tick, LIMITS.tickMs);
    },

    /** Releases every voice, unsubscribes and stops the loop. */
    stop(traceId = null) {
      if (!running) return;
      running = false;
      for (const u of unsubscribe) u();
      unsubscribe = [];
      if (timer !== null) clock.clearInterval(timer);
      timer = null;
      for (const h of bindings.values()) { try { h.release(traceId); } catch { /* instrument gone */ } }
      bindings.clear();
      dataSources.clear();
    },

    /**
     * Hot reload: rebinds changed and removed bindings and data sources; unchanged ones keep their
     * voices and state. Disabled bindings start again.
     * @param {any} next validated IR
     * @returns {{ bindings: string[] }} changed binding ids (added, changed or removed)
     */
    reload(next) {
      const prev = new Map(bindings);
      ir = next;
      indexIr();
      base.seed = ir.seed ?? 1;
      base.scale = ir.scale ?? { root: 'C', mode: 'chromatic' };
      const changed = [];
      for (const [id, h] of prev) {
        const nb = (ir.bindings ?? []).find((b) => b.id === id);
        const same = nb && bindingKey(nb) === h.key;
        if (!same || h.disabled) {
          try { h.release(null); } catch { /* instrument gone */ }
          bindings.delete(id);
          if (!same) changed.push(id);
        }
      }
      for (const b of ir.bindings ?? []) {
        if (!bindings.has(b.id)) {
          if (running) addBinding(b);
          if (!prev.has(b.id)) changed.push(b.id);
        }
      }
      layerErrors.clear();
      const specs = buildModConfig(ir).dataSources;
      const specIds = new Set(specs.map((s) => s.id));
      for (const [id, h] of dataSources) if (!specIds.has(id) || h.disabled) dataSources.delete(id);
      for (const spec of specs) {
        const h = dataSources.get(spec.id);
        if (h && h.key === canonicalJson(spec)) continue;
        dataSources.delete(spec.id);
        if (running) addDataSource(spec);
      }
      readFreshness();
      updateReactions();
      return { bindings: changed };
    },

    /** Fires the 30 Hz update once (the loop calls it every `LIMITS.tickMs`). */
    tick,

    /** Re-evaluates every expression with an `orbit` node. Call on each propagator post (2 Hz). */
    orbitTick() {
      for (const h of bindings.values()) if (h.usesOrbit) guard(h, () => h.onOrbit());
      for (const h of dataSources.values()) if (h.usesOrbit) guard(h, () => h.onOrbit());
    },

    /**
     * Property values of a layer for one object (or null for full-screen layers). `null` values
     * mean the renderer uses the property default.
     */
    layerProps(layer, obj = null) {
      return evaluateLayerProps(layer, obj, ctxFor(layer.id), (prop, err) => {
        const key = `${layer.id}.${prop}`;
        if (layerErrors.has(key)) return;
        layerErrors.add(key);
        emit('VISUAL', `layer.${layer.id}`, 'error', { layer: layer.id, prop, message: err.message }, { level: 'error' });
      });
    },

    /** Sounding sustained voices, for the console's Sounding voices panel. */
    voices() { return [...bindings.values()].flatMap((h) => h.snapshot()); },

    /** Raw and posted values of every data source, for the Modulation panel. */
    dataSources() { return [...dataSources.values()].map((h) => h.state()); },

    /**
     * Current smoothed values of followed instrument parameters.
     * @returns {{ binding: string, inst: string, param: string, value: number }[]}
     */
    paramValues() {
      const out = [];
      for (const h of bindings.values()) {
        if (h.kind !== 'param' || h.disabled) continue;
        const value = h.currentValue();
        if (value !== null) out.push({ binding: h.id, inst: h.inst, param: h.param, value });
      }
      return out;
    },

    /** Ids of disabled bindings and data sources. */
    disabled() {
      return [...bindings.values(), ...dataSources.values()].filter((h) => h.disabled).map((h) => h.id);
    },

    reactionState() { return { ...reactionState, muted: [...reactionState.muted] }; },
    get running() { return running; },
  };
  return runtime;
}
