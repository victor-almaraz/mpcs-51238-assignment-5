// Main-thread side of the effect chains (effects.md, Graph, Engine API, Limits): validates slot
// lists, creates one `fx-chain` AudioWorkletNode per chain, wires it into the graph and posts
// the chain messages. Used by Engine; the engine methods setFx, setFxParam, setFxBypass,
// setTempo and onFxFault forward here.
//
//   voice → widget.output → [insert chain] → mixBus → [master chain] → masterGain → safety stage

import { clampParam } from './core/params.js';
import { effectFor } from './effects/registry.js';
import { MAX_REVERBS } from './effects/reverb.js';
import { FxLimitError } from '../errors.js';

export const FX_LIMITS = Object.freeze({
  slotsPerChain: 8,
  insertChains: 16,
  reverbs: MAX_REVERBS,
  tempoMin: 20,
  tempoMax: 300,
  tempoDefault: 120,
});

export const FX_PROCESSOR = 'fx-chain';
/** Delay between bypassing a removed chain's slots and disconnecting it, s (10 ms fade + margin). */
export const CHAIN_REMOVE_DELAY_S = 0.03;
/** Delay between panic and the chains' reset (after the voice fade), s. */
export const PANIC_RESET_DELAY_S = 0.03;

const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/** disconnect(dest) that tolerates a connection already removed (disposed instruments). */
function detach(node, dest) {
  try { node.disconnect(dest); } catch { /* not connected */ }
}

/**
 * Validates one slot and returns it with every parameter filled in (enum values as indices).
 * @returns {{ id: string, type: string, params: Record<string, number>, bypass: boolean }}
 */
export function normalizeSlot(owner, s, i) {
  const where = `setFx(${owner}) slot ${i}`;
  if (!isObj(s)) throw new TypeError(`${where}: must be an object`);
  if (typeof s.id !== 'string' || s.id === '') throw new TypeError(`${where}: id must be a non-empty string`);
  const entry = effectFor(s.type);
  if (!entry) throw new TypeError(`${where} (${s.id}): unknown effect type ${String(s.type)}`);
  if (s.params !== undefined && !isObj(s.params)) throw new TypeError(`${where} (${s.id}): params must be an object`);
  if (s.bypass !== undefined && typeof s.bypass !== 'boolean') throw new TypeError(`${where} (${s.id}): bypass must be a boolean`);
  const given = s.params ?? {};
  for (const k of Object.keys(given)) {
    if (!entry.params.some((d) => d.id === k)) throw new TypeError(`${where} (${s.id}): unknown ${s.type} parameter ${k}`);
  }
  const params = {};
  for (const def of entry.params) {
    let v = given[def.id];
    if (v === undefined) { params[def.id] = def.default; continue; }
    if (typeof v === 'string' && def.options) {
      const idx = def.options.indexOf(v);
      if (idx < 0) throw new TypeError(`${where} (${s.id}): ${def.id} must be one of ${def.options.join(', ')}`);
      v = idx;
    }
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new TypeError(`${where} (${s.id}): ${def.id} must be a finite number`);
    params[def.id] = clampParam(def, v);
  }
  return { id: s.id, type: s.type, params, bypass: s.bypass === true };
}

export class FxHost {
  /**
   * @param {any} engine Engine: ctx, bus, seed, realtime, entries, onError, mod
   */
  constructor(engine) {
    this.engine = engine;
    this.ctx = engine.ctx;
    this.bus = engine.bus;
    this.available = !!(engine.bus && engine.bus.worklets && engine.bus.worklets.fx) && typeof AudioWorkletNode === 'function';
    this.warned = false;
    /** @type {Map<string, any>} owner → chain */
    this.chains = new Map();
    this.tempo = FX_LIMITS.tempoDefault;
    this.faultFns = [];
    this.nextIndex = 0;
    this.timers = new Set();
    this.pings = new Map();
    this.pingId = 0;
  }

  // ----- queries -----

  /** Chains whose slots are live (not being removed). */
  liveChains() {
    return [...this.chains.values()].filter((c) => !c.removing);
  }

  /** { chain, slot, def(name) } for a slot id, or null. */
  findSlot(slotId) {
    for (const c of this.chains.values()) {
      if (c.removing) continue;
      for (const s of c.slots) if (s.id === slotId) return { chain: c, slot: s };
    }
    return null;
  }

  /** The node an instrument's output connects to: its chain, or mixBus. */
  outlet(owner) {
    const c = this.chains.get(owner);
    return c && c.node ? c.node : this.bus.mixBus;
  }

  // ----- EngineFx -----

  setTempo(bpm) {
    if (typeof bpm !== 'number' || !Number.isFinite(bpm) || bpm < FX_LIMITS.tempoMin || bpm > FX_LIMITS.tempoMax) {
      throw new FxLimitError('tempo', `${bpm}; allowed ${FX_LIMITS.tempoMin}–${FX_LIMITS.tempoMax} BPM`);
    }
    if (bpm === this.tempo) return;
    this.tempo = bpm;
    const at = this.ctx.currentTime;
    this.engine.mod.onTempo(bpm, at);
    for (const c of this.chains.values()) this.post(c, { t: 'tempo', bpm, at });
  }

  setFx(owner, slots) {
    if (typeof owner !== 'string' || owner === '') throw new TypeError('setFx: owner must be "master" or an instrument id');
    if (!Array.isArray(slots)) throw new TypeError(`setFx(${owner}): slots must be an array`);
    if (slots.length > FX_LIMITS.slotsPerChain) throw new FxLimitError('slots', `${owner} has ${slots.length}; at most ${FX_LIMITS.slotsPerChain}`);
    const list = slots.map((s, i) => normalizeSlot(owner, s, i));

    // Limits over the whole configuration after the change.
    const others = this.liveChains().filter((c) => c.owner !== owner);
    const ids = new Set();
    for (const s of list) {
      if (ids.has(s.id)) throw new FxLimitError('slot ids', `${s.id} appears twice`);
      ids.add(s.id);
    }
    for (const c of others) for (const s of c.slots) if (ids.has(s.id)) throw new FxLimitError('slot ids', `${s.id} is already in chain ${c.owner}`);
    const inserts = others.filter((c) => c.owner !== 'master').length + (owner !== 'master' && list.length ? 1 : 0);
    if (inserts > FX_LIMITS.insertChains) throw new FxLimitError('insert chains', `at most ${FX_LIMITS.insertChains}`);
    const reverbs = [...others.flatMap((c) => c.slots), ...list].filter((s) => s.type === 'reverb').length;
    if (reverbs > FX_LIMITS.reverbs) throw new FxLimitError('reverbs', `${reverbs}; at most ${FX_LIMITS.reverbs}`);

    const key = JSON.stringify(list);
    const cur = this.chains.get(owner);
    if (cur && !cur.removing && cur.key === key) return;
    if (!list.length) {
      if (cur && !cur.removing) this.removeChain(cur);
      return;
    }
    if (!this.available && !this.warned) {
      this.warned = true;
      this.engine.onError?.(new Error('Effects are unavailable: the fx-chain worklet did not load; audio passes dry'));
    }
    let c = cur;
    if (c && c.removing) {
      this.clearTimer(c.removing);
      c.removing = null;
    }
    if (!c) {
      c = { owner, index: this.nextIndex++, node: null, slots: [], key: '', removing: null, report: new Map(), reportTargets: [] };
      this.chains.set(owner, c);
      c.slots = list;
      c.key = key;
      this.createNode(c);
      this.engine.mod.chainCreated(c);
    } else {
      c.slots = list;
      c.key = key;
      this.post(c, { t: 'slots', slots: list });
    }
    this.engine.mod.refresh();
  }

  setFxParam(slotId, name, value) {
    const f = this.findSlot(slotId);
    if (!f) throw new Error(`setFxParam: unknown slot ${slotId}`);
    const def = effectFor(f.slot.type).params.find((d) => d.id === name);
    if (!def) throw new TypeError(`setFxParam: ${f.slot.type} has no parameter ${name}`);
    if (typeof value !== 'number' || !Number.isFinite(value)) return;
    const v = clampParam(def, value);
    f.slot.params[name] = v;
    this.post(f.chain, { t: 'param', slot: slotId, name, value: v });
  }

  setFxBypass(slotId, on) {
    const f = this.findSlot(slotId);
    if (!f) throw new Error(`setFxBypass: unknown slot ${slotId}`);
    if (typeof on !== 'boolean') throw new TypeError('setFxBypass: on must be a boolean');
    f.slot.bypass = on;
    this.post(f.chain, { t: 'bypass', slot: slotId, on });
  }

  onFxFault(fn) {
    if (typeof fn === 'function') this.faultFns.push(fn);
  }

  // ----- chain nodes and wiring -----

  post(c, msg) {
    if (c.node) c.node.port.postMessage(msg);
  }

  createNode(c) {
    if (!this.available) return;
    const node = new AudioWorkletNode(this.ctx, FX_PROCESSOR, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
      processorOptions: { seed: this.engine.seed, chainIndex: c.index },
    });
    c.node = node;
    node.port.onmessage = (e) => this.onMessage(c, e.data);
    node.onprocessorerror = () => {
      this.engine.onError?.(new Error(`Effect chain ${c.owner} stopped (processorerror); audio passes dry`));
      this.unwire(c);
      c.node = null;
    };
    node.port.postMessage({ t: 'tempo', bpm: this.tempo, at: this.ctx.currentTime });
    node.port.postMessage({ t: 'slots', slots: c.slots });
    this.wire(c);
  }

  onMessage(c, d) {
    if (!d || typeof d.t !== 'string') return;
    if (d.t === 'fault') {
      for (const fn of this.faultFns) {
        try { fn(c.owner, d.slot); } catch (err) { this.engine.onError?.(err); }
      }
    } else if (d.t === 'report') {
      const vals = d.values;
      for (let i = 0; i < c.reportTargets.length && vals && i < vals.length; i++) {
        if (Number.isFinite(vals[i])) c.report.set(c.reportTargets[i], vals[i]);
      }
    } else if (d.t === 'error') {
      this.engine.onError?.(new Error(`Effect chain ${c.owner} ignored a message: ${d.code}`));
    } else if (d.t === 'pong') {
      this.pings.get(d.id)?.();
    }
  }

  /** Inserts the chain node between its owner and the next stage. */
  wire(c) {
    if (!c.node) return;
    const { mixBus, masterGain } = this.bus;
    if (c.owner === 'master') {
      detach(mixBus, masterGain);
      mixBus.connect(c.node);
      c.node.connect(masterGain);
      return;
    }
    c.node.connect(mixBus);
    const e = this.engine.entries.get(c.owner);
    if (e && e.inst && !e.inst.disposed) {
      detach(e.inst.output, e.outlet);
      e.inst.output.connect(c.node);
      e.outlet = c.node;
    }
  }

  /** Connects the owner directly to the next stage and disconnects the chain node. */
  unwire(c) {
    if (!c.node) return;
    const { mixBus, masterGain } = this.bus;
    if (c.owner === 'master') {
      detach(mixBus, c.node);
      mixBus.connect(masterGain);
    } else {
      const e = this.engine.entries.get(c.owner);
      if (e && e.inst && e.outlet === c.node && !e.inst.disposed) {
        detach(e.inst.output, c.node);
        e.inst.output.connect(mixBus);
        e.outlet = mixBus;
      }
    }
    c.node.disconnect();
  }

  /** Bypasses every slot, then rewires and closes the node (effects.md, Slot rules, Removal). */
  removeChain(c, delay = CHAIN_REMOVE_DELAY_S) {
    for (const s of c.slots) this.post(c, { t: 'bypass', slot: s.id, on: true });
    c.slots = [];
    c.key = '[]';
    const done = () => {
      c.removing = null;
      if (this.chains.get(c.owner) !== c) return;
      this.chains.delete(c.owner);
      this.unwire(c);
      if (c.node) c.node.port.close();
      c.node = null;
    };
    if (!this.engine.realtime || !c.node) { done(); this.engine.mod.refresh(); return; }
    c.removing = this.later(done, delay * 1000);
    this.engine.mod.refresh();
  }

  /** Called by Engine.sync for owners that are no longer instruments. */
  ownersRemoved(ids, delay) {
    for (const id of ids) {
      const c = this.chains.get(id);
      if (c && !c.removing) this.removeChain(c, delay);
    }
  }

  later(fn, ms) {
    const h = setTimeout(() => { this.timers.delete(h); fn(); }, ms);
    this.timers.add(h);
    return h;
  }

  clearTimer(h) {
    clearTimeout(h);
    this.timers.delete(h);
  }

  /** Posts `reset` to every chain, after `delay` s in realtime (panic, fault rebuild). */
  resetAll(delay = 0) {
    const go = () => { for (const c of this.chains.values()) this.post(c, { t: 'reset' }); };
    if (delay > 0 && this.engine.realtime) this.later(go, delay * 1000);
    else go();
  }

  /** Resolves when every chain has received every earlier message (or after timeoutMs). */
  flush(timeoutMs = 1000) {
    return Promise.all([...this.chains.values()].filter((c) => c.node).map((c) => new Promise((resolve) => {
      const id = ++this.pingId;
      const done = () => { clearTimeout(timer); this.pings.delete(id); resolve(undefined); };
      const timer = setTimeout(done, timeoutMs);
      this.pings.set(id, done);
      c.node.port.postMessage({ t: 'ping', id });
    })));
  }

  dispose() {
    for (const h of this.timers) clearTimeout(h);
    this.timers.clear();
    for (const c of this.chains.values()) {
      this.unwire(c);
      if (c.node) c.node.port.close();
      c.node = null;
    }
    this.chains.clear();
  }
}
