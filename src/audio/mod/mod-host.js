// Main-thread side of modulation (modulation.md): LFO and data-source state, route validation
// and resolution, distribution of effect routes to chains, audio-rate routes to instruments,
// and control-rate evaluation in pump(). The engine methods setLfos, setMods, postModValue and
// modulatedValue forward here.

import { effectFor } from '../fx/effects/registry.js';
import { getDef } from '../synths/param-defs.js';
import { ModLimitError, ModTargetError } from '../errors.js';
import {
  DEFAULT_RATE, DEFAULT_SMOOTH, LFO_RATE_MAX, LFO_RATE_MIN, LFO_SHAPES, LfoClock, SHAPE_CODE,
  dataHz, lfoValue, smoothDecay, syncBeats, syncHz,
} from './lfo.js';
import { MOD_LIMITS, depthScale, effectModDown, effectModulatable, modulatedValue, synthModDown, synthModPath } from './model.js';
import { DataSource, PeriodicSource, SteppedSource } from './sources.js';

const DATA_ID = /^dat\d+$/;
const DEFAULT_SMOOTH_MS = 250;
const MIN_POST_INTERVAL = 1 / MOD_LIMITS.dataPostsPerSecond;
const RATE_TAU = 0.025;                // oscillator frequency glide for data-rate LFOs, s

const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** Validates and normalizes one LfoSpec. */
function normalizeLfo(l, i) {
  const where = `setLfos: lfo ${i}`;
  if (!isObj(l)) throw new TypeError(`${where}: must be an object`);
  if (typeof l.id !== 'string' || l.id === '' || DATA_ID.test(l.id)) throw new TypeError(`${where}: id must be a string such as lfo0`);
  const shape = l.shape ?? 'sine';
  if (!LFO_SHAPES.includes(shape)) throw new TypeError(`${where} (${l.id}): shape must be one of ${LFO_SHAPES.join(', ')}`);
  let rate = l.rate ?? DEFAULT_RATE;
  if (typeof rate === 'number') {
    if (!(rate >= LFO_RATE_MIN && rate <= LFO_RATE_MAX)) throw new ModLimitError('rate', `${l.id}: ${rate} Hz; allowed ${LFO_RATE_MIN}–${LFO_RATE_MAX}`);
  } else if (isObj(rate) && 'sync' in rate) {
    if (!(syncBeats(rate.sync) > 0)) throw new TypeError(`${where} (${l.id}): unknown sync value ${String(rate.sync)}`);
    rate = { sync: rate.sync };
  } else if (isObj(rate) && 'data' in rate) {
    if (typeof rate.data !== 'string' || !DATA_ID.test(rate.data)) throw new TypeError(`${where} (${l.id}): rate.data must be a data source id such as dat0`);
    if (!(isNum(rate.min) && isNum(rate.max) && rate.min >= LFO_RATE_MIN && rate.max <= LFO_RATE_MAX && rate.min < rate.max)) {
      throw new ModLimitError('rate', `${l.id}: data rate range ${rate.min}–${rate.max}; allowed ${LFO_RATE_MIN}–${LFO_RATE_MAX} with min < max`);
    }
    rate = { data: rate.data, min: rate.min, max: rate.max };
  } else {
    throw new TypeError(`${where} (${l.id}): rate must be Hz, { sync } or { data, min, max }`);
  }
  const phase = l.phase ?? 0;
  if (!isNum(phase)) throw new TypeError(`${where} (${l.id}): phase must be a number`);
  if (l.retrigger !== undefined && typeof l.retrigger !== 'boolean') throw new TypeError(`${where} (${l.id}): retrigger must be a boolean`);
  let smooth = l.smooth ?? (shape === 'smooth' ? DEFAULT_SMOOTH : 0);
  if (!isNum(smooth)) throw new TypeError(`${where} (${l.id}): smooth must be a number`);
  smooth = Math.min(1, Math.max(0, smooth));
  return { id: l.id, shape, rate, phase: phase - Math.floor(phase), retrigger: l.retrigger === true, smooth };
}

class DataRt {
  constructor(id) {
    this.id = id;
    this.target = 0;
    this.y0 = 0;
    this.t1 = 0;
    this.tau = 0;
    this.smoothMs = DEFAULT_SMOOTH_MS;
    this.lastPost = -Infinity;
    this.pending = null;
  }

  valueAt(t) {
    if (!(this.tau > 0) || t <= this.t1) return t <= this.t1 ? this.y0 : this.target;
    return this.target + (this.y0 - this.target) * Math.exp(-(t - this.t1) / this.tau);
  }
}

export class ModHost {
  constructor(engine) {
    this.engine = engine;
    this.ctx = engine.ctx;
    this.seed = engine.seed | 0;
    this.t0 = engine.t0;
    this.bpm = 120;
    /** @type {any[]} */ this.lfos = [];
    this.lfoById = new Map();
    /** @type {Map<string, DataRt>} */ this.data = new Map();
    /** @type {{ target: string, source: string, depth: number }[]} */ this.routes = [];
    this.resolved = [];
    /** instId → Map(name → { def, down, routes: [{ source, depth }] }) */
    this.control = new Map();
    /** sourceId → shared audio source (PeriodicSource | SteppedSource | DataSource) with `key` */
    this.audioSources = new Map();
    this.chainKeys = new Map();
    /** owner → Set of source ids the chain's routes read */
    this.chainUses = new Map();
  }

  // ----- sources -----

  data_(id) {
    let d = this.data.get(id);
    if (!d) { d = new DataRt(id); this.data.set(id, d); }
    return d;
  }

  hzOf(L, t) {
    if (L.rateKind === 1) return syncHz(L.spec.rate.sync, this.bpm);
    if (L.rateKind === 2) {
      const r = L.spec.rate;
      return dataHz(this.data.has(r.data) ? this.data.get(r.data).valueAt(t) : 0, r.min, r.max);
    }
    return L.spec.rate;
  }

  /** Output of source `id` at time `t`, in −1..1 (0 for a missing source). */
  valueOf(id, t) {
    const L = this.lfoById.get(id);
    if (L) return lfoValue(L.code, L.clock.phaseAt(t), this.seed, L.index, L.smooth, L.decay);
    const d = this.data.get(id);
    return d ? d.valueAt(t) : 0;
  }

  /** LFO value for an instrument's control route; a retrigger LFO restarts at its latest noteOn. */
  valueForInst(id, inst, t) {
    const L = this.lfoById.get(id);
    if (L && L.spec.retrigger && inst && Number.isFinite(inst.lastNoteOn) && t >= inst.lastNoteOn) {
      return lfoValue(L.code, L.spec.phase + this.hzOf(L, t) * (t - inst.lastNoteOn), this.seed, L.index, L.smooth, L.decay);
    }
    return this.valueOf(id, t);
  }

  setLfos(lfos) {
    if (!Array.isArray(lfos)) throw new TypeError('setLfos: lfos must be an array');
    if (lfos.length > MOD_LIMITS.lfos) throw new ModLimitError('lfos', `${lfos.length}; at most ${MOD_LIMITS.lfos}`);
    const specs = lfos.map(normalizeLfo);
    const ids = new Set();
    for (const s of specs) {
      if (ids.has(s.id)) throw new TypeError(`setLfos: duplicate LFO id ${s.id}`);
      ids.add(s.id);
    }
    const now = this.ctx.currentTime;
    const next = specs.map((spec, index) => {
      const key = JSON.stringify([index, spec]);
      const old = this.lfoById.get(spec.id);
      if (old && old.key === key) return old;
      const L = {
        spec, index, key, code: SHAPE_CODE[spec.shape], smooth: spec.smooth, decay: smoothDecay(spec.smooth),
        rateKind: typeof spec.rate === 'number' ? 0 : 'sync' in spec.rate ? 1 : 2,
        clock: null, instances: new Set(),
      };
      L.clock = new LfoClock(spec.phase, this.hzOf(L, now), this.t0);
      return L;
    });
    this.lfos = next;
    this.lfoById = new Map(next.map((L) => [L.spec.id, L]));
    for (const L of this.lfos) if (L.rateKind === 2) this.data_(L.spec.rate.data);
    for (const c of this.engine.fx.chains.values()) this.postLfos(c);
    this.refresh();
  }

  postLfos(c) {
    this.engine.fx.post(c, {
      t: 'lfos',
      seed: this.seed,
      lfos: this.lfos.map((L) => ({
        id: L.spec.id, index: L.index, shape: L.spec.shape, rate: L.spec.rate, phase: L.spec.phase, smooth: L.spec.smooth,
        anchorT: L.clock.anchorT, anchorPhase: L.clock.anchorPhase, hz: L.clock.hz,
      })),
    });
  }

  postModValue(id, value, smoothMs = DEFAULT_SMOOTH_MS) {
    if (typeof id !== 'string' || id === '') throw new TypeError('postModValue: source id must be a string');
    if (!isNum(value)) return;
    const v = value < -1 ? -1 : value > 1 ? 1 : value;
    const ms = isNum(smoothMs) && smoothMs > 0 ? smoothMs : 0;
    const d = this.data_(id);
    const now = this.ctx.currentTime;
    if (now - d.lastPost < MIN_POST_INTERVAL - 1e-9) { d.pending = { value: v, smoothMs: ms }; return; }
    this.forward(d, v, ms, now);
  }

  forward(d, value, smoothMs, now) {
    d.y0 = d.valueAt(now);
    d.t1 = now;
    d.target = value;
    d.smoothMs = smoothMs;
    d.tau = smoothMs / 3000;
    d.lastPost = now;
    d.pending = null;
    for (const c of this.engine.fx.chains.values()) {
      if (this.chainUses.get(c.owner)?.has(d.id)) this.engine.fx.post(c, { t: 'modValue', id: d.id, value, smoothMs });
    }
    const src = this.audioSources.get(d.id);
    if (src instanceof DataSource) src.post(value, now, d.tau);
  }

  onTempo(bpm, at) {
    this.bpm = bpm;
    for (const L of this.lfos) {
      if (L.rateKind !== 1) continue;
      const hz = syncHz(L.spec.rate.sync, bpm);
      L.clock.setHz(hz, at);
      const src = this.audioSources.get(L.spec.id);
      if (src) src.setHz(hz, at);
      for (const inst of L.instances) inst.setHz(hz, at);
    }
  }

  // ----- routes -----

  /** Resolves a target address; throws ModTargetError. */
  resolveTarget(target) {
    if (typeof target !== 'string') throw new ModTargetError(String(target), 'must be a string');
    const dot = target.indexOf('.');
    if (dot <= 0) throw new ModTargetError(target, 'expected <instrument or slot id>.<param>');
    const owner = target.slice(0, dot);
    const name = target.slice(dot + 1);
    const slot = this.engine.fx.findSlot(owner);
    if (slot) {
      const def = effectFor(slot.slot.type).params.find((d) => d.id === name);
      if (!def) throw new ModTargetError(target, `${slot.slot.type} has no parameter ${name}`);
      if (!effectModulatable(def)) throw new ModTargetError(target, `${name} is set only`);
      return { kind: 'fx', target, chainOwner: slot.chain.owner, slotId: owner, name, def, down: effectModDown(def) };
    }
    const e = this.engine.entries.get(owner);
    if (e) {
      const def = getDef(e.widget.type, name);
      if (!def) throw new ModTargetError(target, `${e.widget.type} has no parameter ${name}`);
      const path = synthModPath(def);
      if (!path) throw new ModTargetError(target, `${name} is not modulatable`);
      return { kind: path, target, inst: owner, name, def, down: synthModDown(def) };
    }
    throw new ModTargetError(target, `no instrument or effect slot ${owner}`);
  }

  setMods(routes) {
    if (!Array.isArray(routes)) throw new TypeError('setMods: routes must be an array');
    if (routes.length > MOD_LIMITS.routes) throw new ModLimitError('routes', `${routes.length}; at most ${MOD_LIMITS.routes}`);
    const perTarget = new Map();
    const retrig = new Map();
    const list = routes.map((r, i) => {
      if (!isObj(r)) throw new TypeError(`setMods: route ${i} must be an object`);
      if (!isNum(r.depth)) throw new TypeError(`setMods: route ${i} depth must be a number`);
      if (r.depth < -MOD_LIMITS.depth || r.depth > MOD_LIMITS.depth) throw new ModLimitError('depth', `${r.target}: ${r.depth}; allowed −1 to 1`);
      if (typeof r.source !== 'string' || !(this.lfoById.has(r.source) || DATA_ID.test(r.source))) {
        throw new TypeError(`setMods: route ${i} source ${String(r.source)} is neither an LFO id nor a data source id`);
      }
      const res = this.resolveTarget(r.target);
      const n = (perTarget.get(r.target) ?? 0) + 1;
      perTarget.set(r.target, n);
      if (n > MOD_LIMITS.routesPerTarget) throw new ModLimitError('routes_per_target', `${r.target}; at most ${MOD_LIMITS.routesPerTarget}`);
      const L = this.lfoById.get(r.source);
      if (L && L.spec.retrigger && res.kind !== 'fx') {
        const set = retrig.get(res.inst) ?? new Set();
        set.add(r.source);
        retrig.set(res.inst, set);
        if (set.size > MOD_LIMITS.retriggerPerInstrument) throw new ModLimitError('retrigger', `${res.inst}; at most ${MOD_LIMITS.retriggerPerInstrument}`);
      }
      return { target: r.target, source: r.source, depth: r.depth };
    });
    this.routes = list;
    for (const r of list) if (DATA_ID.test(r.source)) this.data_(r.source);
    this.refresh();
  }

  /** Shared audio source for `id`, created on first use; null when the id has no source yet. */
  sharedSource(id, now) {
    const L = this.lfoById.get(id);
    const key = L ? L.key : 'data';
    let src = this.audioSources.get(id);
    if (src && src.key === key) return src;
    if (src) src.stop(now);
    if (L) {
      src = L.code >= 4 ? new SteppedSource(this.ctx, L, this.seed, L.clock, now) : new PeriodicSource(this.ctx, L.spec, L.clock, now);
    } else {
      src = new DataSource(this.ctx, this.data_(id), now);
    }
    src.key = key;
    this.audioSources.set(id, src);
    return src;
  }

  /** Per-voice source factory for a retrigger LFO (modulation.md, Voices). */
  retriggerFactory(L) {
    return {
      key: L.key,
      make: (t) => {
        const clock = new LfoClock(L.spec.phase, this.hzOf(L, t), t);
        const src = L.code >= 4 ? new SteppedSource(this.ctx, L, this.seed, clock, t) : new PeriodicSource(this.ctx, L.spec, clock, t);
        const inst = {
          node: src.node,
          src,
          setHz: (hz, at) => { if (L.code < 4) clock.setHz(hz, at); src.setHz(hz, at, RATE_TAU); },
          schedule: (until) => src.schedule(until),
          release: () => { L.instances.delete(inst); },
        };
        L.instances.add(inst);
        return inst;
      },
    };
  }

  /**
   * Re-resolves every route against the current instruments and slots and distributes them:
   * effect routes to chains, audio-rate routes to instruments, control routes to pump().
   * Called after setLfos, setMods, sync and setFx.
   */
  refresh() {
    const now = this.ctx.currentTime;
    const resolved = [];
    for (const r of this.routes) {
      try { resolved.push({ ...this.resolveTarget(r.target), route: r }); } catch { /* target gone: inactive */ }
    }
    this.resolved = resolved;

    // Effect routes, per chain, in route order.
    const byChain = new Map();
    for (const x of resolved) if (x.kind === 'fx') (byChain.get(x.chainOwner) ?? byChain.set(x.chainOwner, []).get(x.chainOwner)).push(x);
    const fx = this.engine.fx;
    for (const c of fx.chains.values()) {
      const list = byChain.get(c.owner) ?? [];
      const routes = list.map((x) => ({ slot: x.slotId, name: x.name, source: x.route.source, depth: x.route.depth }));
      const key = JSON.stringify(routes);
      const uses = new Set();
      for (const x of list) {
        uses.add(x.route.source);
        const L = this.lfoById.get(x.route.source);
        if (L && L.rateKind === 2) uses.add(L.spec.rate.data);
      }
      this.chainUses.set(c.owner, uses);
      if (this.chainKeys.get(c.owner) === key) continue;
      this.chainKeys.set(c.owner, key);
      c.reportTargets = list.map((x) => x.target);
      for (const t of [...c.report.keys()]) if (!c.reportTargets.includes(t)) c.report.delete(t);
      fx.post(c, { t: 'mods', routes });
    }
    for (const owner of [...this.chainKeys.keys()]) if (!fx.chains.has(owner)) { this.chainKeys.delete(owner); this.chainUses.delete(owner); }

    // Audio-rate routes, per instrument.
    const usedSources = new Set();
    const byInst = new Map();
    const counts = new Map();
    for (const x of resolved) {
      if (x.kind !== 'audio') continue;
      const e = this.engine.entries.get(x.inst);
      if (!e || !e.inst || !e.inst.mod) continue;
      const L = this.lfoById.get(x.route.source);
      let src = null;
      let retrig = null;
      if (L && L.spec.retrigger) retrig = this.retriggerFactory(L);
      else if (L || DATA_ID.test(x.route.source)) { src = this.sharedSource(x.route.source, now); usedSources.add(x.route.source); }
      const base = `${x.name}|${x.route.source}`;
      const n = counts.get(`${x.inst}|${base}`) ?? 0;
      counts.set(`${x.inst}|${base}`, n + 1);
      const items = byInst.get(x.inst) ?? byInst.set(x.inst, []).get(x.inst);
      items.push({ key: `${base}|${n}`, name: x.name, def: x.def, depth: x.route.depth, src: src ? src.node : null, retrig });
    }
    for (const [id, e] of this.engine.entries) if (e.inst && e.inst.mod) e.inst.mod.setRoutes(byInst.get(id) ?? []);
    for (const [id, src] of [...this.audioSources]) {
      if (!usedSources.has(id)) { src.stop(now); this.audioSources.delete(id); }
    }

    // Control-rate routes, per instrument; parameters that lost their routes return to base.
    const control = new Map();
    for (const x of resolved) {
      if (x.kind !== 'control') continue;
      const m = control.get(x.inst) ?? control.set(x.inst, new Map()).get(x.inst);
      const T = m.get(x.name) ?? m.set(x.name, { def: x.def, down: x.down, routes: [] }).get(x.name);
      T.routes.push({ source: x.route.source, depth: x.route.depth });
    }
    for (const [id, names] of this.control) {
      const inst = this.engine.get(id);
      if (!inst || !inst.setModulated) continue;
      for (const name of names.keys()) if (!control.get(id)?.has(name)) inst.setModulated(name, null);
    }
    this.control = control;
    this.pumpControl(now);
  }

  /** Called when the fx host creates a chain node: sends the LFOs and current data values. */
  chainCreated(c) {
    this.postLfos(c);
    this.chainKeys.delete(c.owner);
    for (const d of this.data.values()) {
      const now = this.ctx.currentTime;
      this.engine.fx.post(c, { t: 'modValue', id: d.id, value: d.valueAt(now), smoothMs: 0, snap: true });
      this.engine.fx.post(c, { t: 'modValue', id: d.id, value: d.target, smoothMs: d.smoothMs });
    }
  }

  // ----- evaluation -----

  pumpControl(now) {
    for (const [id, names] of this.control) {
      const inst = this.engine.get(id);
      if (!inst || !inst.setModulated) continue;
      for (const [name, T] of names) {
        const routes = T.routes.map((r) => ({ depth: r.depth, value: this.valueForInst(r.source, inst, now) }));
        inst.setModulated(name, modulatedValue(T.def, inst.base[name], routes, T.down));
      }
    }
  }

  /** Every 25 ms: held data posts, data-rate LFO rates, scheduled sources, control routes. */
  pump(until) {
    const now = this.ctx.currentTime;
    for (const d of this.data.values()) {
      if (d.pending && now - d.lastPost >= MIN_POST_INTERVAL - 1e-9) this.forward(d, d.pending.value, d.pending.smoothMs, now);
    }
    for (const L of this.lfos) {
      if (L.rateKind !== 2) continue;
      const hz = this.hzOf(L, now);
      if (Math.abs(hz - L.clock.hz) <= 1e-9 * hz) continue;
      const src = this.audioSources.get(L.spec.id);
      if (src instanceof SteppedSource) src.setHz(hz, now);
      else { L.clock.setHz(hz, now); if (src) src.setHz(hz, now, RATE_TAU); }
      for (const inst of L.instances) inst.setHz(hz, now);
    }
    for (const src of this.audioSources.values()) src.schedule(until);
    for (const L of this.lfos) for (const inst of L.instances) inst.schedule(until);
    this.pumpControl(now);
  }

  /** modulation.md, Reports: the latest modulated value of `target`, its base value, or null. */
  modulatedValue(target) {
    let res;
    try { res = this.resolveTarget(target); } catch { return null; }
    const routes = this.resolved.filter((x) => x.target === target);
    if (res.kind === 'fx') {
      const c = this.engine.fx.chains.get(res.chainOwner);
      if (routes.length && c && c.report.has(target)) return c.report.get(target);
      return this.engine.fx.findSlot(res.slotId).slot.params[res.name];
    }
    const inst = this.engine.get(res.inst);
    if (!inst) return null;
    const base = inst.base[res.name];
    if (!routes.length) return base;
    if (res.kind === 'control') return inst.params[res.name];
    const now = this.ctx.currentTime;
    const k = depthScale(res.def, base, routes.map((x) => x.route.depth));
    return modulatedValue(res.def, base, routes.map((x) => ({ depth: x.route.depth * k, value: this.valueForInst(x.route.source, inst, now) })));
  }

  dispose() {
    const now = this.ctx.currentTime;
    for (const src of this.audioSources.values()) { src.stop(now); src.node.disconnect(); }
    this.audioSources.clear();
  }
}
