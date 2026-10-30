/*
 * Effect chain core (effects.md, Chain processor; modulation.md, Evaluation): up to 8 slots,
 * the LFOs and data sources the chain's routes use, and the route evaluation for its effect
 * parameters. Plain JavaScript without Web Audio, wrapped by worklet.js as the `fx-chain`
 * AudioWorkletProcessor and driven directly by Node tests.
 *
 * Real-time rules: process() and the functions it calls allocate nothing, except the rare
 * postMessage of a fault, an error or a report. Message handlers run between quanta; they may
 * allocate and they replace the arrays process() reads. Frames are processed in sub-blocks of
 * SUB_BLOCK (32) frames: routes are evaluated once per sub-block and the modulated values reach
 * the kernels through setParam, whose own smoothing follows. Time comes only from the frame
 * counter passed to process().
 */
import { BLOCK } from './core/constants.js';
import { fromNorm, toNorm, clampParam } from './core/params.js';
import { EffectSlot } from './effects/chain.js';
import { effectFor } from './effects/registry.js';
import { SHAPE_CODE, LFO_RATE_MIN, LFO_RATE_MAX, lfoValue, smoothDecay, dataHz, syncHz, syncBeats } from '../mod/lfo.js';
import { effectModulatable, effectModDown } from '../mod/model.js';

/** Frames per modulation sub-block (modulation.md, Effect targets). */
export const SUB_BLOCK = 32;
/** Slots per chain (effects.md, Limits). */
export const MAX_SLOTS = 8;
/** Interval of `report` messages, s. */
export const REPORT_INTERVAL_S = 0.1;

const MAX_LFOS = 16;
const MAX_ROUTES = 32;
const TEMPO_MIN = 20;
const TEMPO_MAX = 300;

const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isFiniteNum = (v) => typeof v === 'number' && Number.isFinite(v);

export class ChainCore {
  /**
   * @param {number} fs sample rate, Hz
   * @param {{ seed?: number, chainIndex?: number, post?: (msg: any) => void }} [opts]
   */
  constructor(fs, { seed = 1, chainIndex = 0, post = () => {} } = {}) {
    this.fs = fs;
    this.seed = seed | 0;
    this.chainIndex = chainIndex | 0;
    this.post = post;
    this.bpm = 120;
    this.started = false;
    /** @type {{ id: string, type: string, slot: EffectSlot, kernel: any, defs: any[], defById: Map<string, any>, base: Map<string, number> }[]} */
    this.slots = [];
    this.lfoSpecs = [];       // as received
    this.lfos = [];           // compiled, used by process()
    this.lfoVal = new Float64Array(MAX_LFOS);
    /** @type {Map<string, { target: number, y: number, a: number }>} */
    this.data = new Map();
    this.dataList = [];       // data states used by routes or rates, for process()
    this.routes = [];         // as received: { slot, name, source, depth }
    this.targets = [];        // compiled: one per routed (slot, param)
    this.routeTarget = new Int32Array(0);
    this.reportValues = new Float32Array(0);
    this.routedKeys = new Set();
    this.reportFrames = Math.max(1, Math.round(REPORT_INTERVAL_S * fs));
    this.reportCount = 0;
    this.errors = new Set();
    this.scratchR = new Float32Array(BLOCK);
    this.dt = SUB_BLOCK / fs;
  }

  error(code) {
    if (this.errors.has(code)) return;
    this.errors.add(code);
    this.post({ t: 'error', code });
  }

  /** Applies one message from the engine; invalid messages are ignored with an `error` report. */
  handle(m) {
    if (!isObj(m) || typeof m.t !== 'string') { this.error('invalid_message'); return; }
    switch (m.t) {
      case 'slots': this.onSlots(m); break;
      case 'param': this.onParam(m); break;
      case 'bypass': this.onBypass(m); break;
      case 'tempo': this.onTempo(m); break;
      case 'lfos': this.onLfos(m); break;
      case 'mods': this.onMods(m); break;
      case 'modValue': this.onModValue(m); break;
      case 'reset': for (const s of this.slots) s.slot.reset(); break;
      case 'ping': this.post({ t: 'pong', id: m.id }); break;
      default: this.error('unknown_message');
    }
  }

  findSlot(id) {
    for (const s of this.slots) if (s.id === id) return s;
    return null;
  }

  onSlots(m) {
    const list = m.slots;
    if (!Array.isArray(list) || list.length > MAX_SLOTS) { this.error('invalid_slots'); return; }
    const ids = new Set();
    for (const s of list) {
      if (!isObj(s) || typeof s.id !== 'string' || ids.has(s.id) || !effectFor(s.type) || !isObj(s.params) || typeof s.bypass !== 'boolean') {
        this.error('invalid_slots');
        return;
      }
      ids.add(s.id);
    }
    const next = [];
    for (const s of list) {
      const entry = effectFor(s.type);
      let e = this.findSlot(s.id);
      if (e && e.type !== s.type) e = null;
      if (e) {
        for (const def of e.defs) {
          const v = s.params[def.id];
          if (!isFiniteNum(v)) continue;
          const c = clampParam(def, v);
          if (e.base.get(def.id) === c) continue;
          e.base.set(def.id, c);
          if (!this.routedKeys.has(`${e.id}\u0000${def.id}`)) e.slot.setParam(def.id, c);
        }
        // A faulted slot stays bypassed until a `bypass` message (effects.md, Slot rules).
        if (!(e.slot.faulted && !s.bypass)) e.slot.setBypass(s.bypass);
      } else {
        const kernel = new entry.Kernel(this.fs);
        if (typeof kernel.setTempo === 'function') kernel.setTempo(this.bpm);
        const base = new Map();
        for (const def of entry.params) {
          const v = isFiniteNum(s.params[def.id]) ? clampParam(def, s.params[def.id]) : def.default;
          base.set(def.id, v);
          kernel.setParam(def.id, v);
        }
        kernel.reset();                       // smoothers snap to the given values
        const slot = new EffectSlot(this.fs, kernel);
        slot.bypassed = s.bypass;
        slot.target = s.bypass ? 0 : 1;
        slot.wet = s.bypass || this.started ? 0 : 1;   // a new slot in a running chain fades in
        e = { id: s.id, type: s.type, slot, kernel, defs: entry.params, defById: new Map(entry.params.map((d) => [d.id, d])), base };
      }
      next.push(e);
    }
    this.slots = next;
    this.compile();
  }

  onParam(m) {
    const e = typeof m.slot === 'string' ? this.findSlot(m.slot) : null;
    const def = e && typeof m.name === 'string' ? e.defById.get(m.name) : null;
    if (!def || !isFiniteNum(m.value)) { this.error('invalid_param'); return; }
    const v = clampParam(def, m.value);
    e.base.set(def.id, v);
    for (const T of this.targets) {
      if (T.entry === e && T.name === def.id) { T.u0 = toNorm(def, v); return; }
    }
    e.slot.setParam(def.id, v);
  }

  onBypass(m) {
    const e = typeof m.slot === 'string' ? this.findSlot(m.slot) : null;
    if (!e || typeof m.on !== 'boolean') { this.error('invalid_bypass'); return; }
    e.slot.setBypass(m.on);
  }

  onTempo(m) {
    if (!isFiniteNum(m.bpm) || m.bpm < TEMPO_MIN || m.bpm > TEMPO_MAX) { this.error('invalid_tempo'); return; }
    const at = isFiniteNum(m.at) ? m.at : 0;
    this.bpm = m.bpm;
    for (const s of this.slots) if (typeof s.kernel.setTempo === 'function') s.kernel.setTempo(m.bpm);
    for (const L of this.lfos) {
      if (L.rateKind !== 1) continue;
      L.anchorPhase += L.hz * (at - L.anchorT);
      L.anchorT = at;
      L.hz = syncHz(L.sync, m.bpm);
    }
  }

  onLfos(m) {
    const list = m.lfos;
    if (!Array.isArray(list) || list.length > MAX_LFOS) { this.error('invalid_lfos'); return; }
    const compiled = [];
    for (const l of list) {
      const L = compileLfo(l, this.bpm);
      if (!L) { this.error('invalid_lfos'); return; }
      compiled.push(L);
    }
    if (isFiniteNum(m.seed)) this.seed = m.seed | 0;
    // Unchanged LFOs keep their phase state (modulation.md, Engine API).
    for (const L of compiled) {
      const old = this.lfos.find((o) => o.id === L.id && o.key === L.key);
      if (old) { L.anchorT = old.anchorT; L.anchorPhase = old.anchorPhase; L.hz = old.hz; }
    }
    this.lfos = compiled;
    this.compile();
  }

  onMods(m) {
    const list = m.routes;
    if (!Array.isArray(list) || list.length > MAX_ROUTES) { this.error('invalid_mods'); return; }
    for (const r of list) {
      if (!isObj(r) || typeof r.slot !== 'string' || typeof r.name !== 'string' || typeof r.source !== 'string'
        || !isFiniteNum(r.depth) || r.depth < -1 || r.depth > 1) { this.error('invalid_mods'); return; }
    }
    this.routes = list.map((r) => ({ slot: r.slot, name: r.name, source: r.source, depth: r.depth }));
    this.compile();
  }

  onModValue(m) {
    if (typeof m.id !== 'string' || !isFiniteNum(m.value)) { this.error('invalid_mod_value'); return; }
    const d = this.dataState(m.id);
    d.target = m.value < -1 ? -1 : m.value > 1 ? 1 : m.value;
    if (m.snap === true) d.y = d.target;
    const smoothMs = isFiniteNum(m.smoothMs) && m.smoothMs > 0 ? m.smoothMs : 0;
    d.a = smoothMs > 0 ? 1 - Math.exp(-this.dt / (smoothMs / 3000)) : 1;
  }

  dataState(id) {
    let d = this.data.get(id);
    if (!d) { d = { target: 0, y: 0, a: 1 }; this.data.set(id, d); }
    return d;
  }

  /** Resolves routes against slots and sources; builds the arrays process() reads. */
  compile() {
    const lfoIndex = new Map(this.lfos.map((L, i) => [L.id, i]));
    const used = new Set();
    for (const L of this.lfos) if (L.rateKind === 2) { L.data = this.dataState(L.dataId); used.add(L.data); }
    const targets = [];
    const byKey = new Map();
    const routeTarget = new Int32Array(this.routes.length).fill(-1);
    this.routes.forEach((r, i) => {
      const e = this.findSlot(r.slot);
      const def = e ? e.defById.get(r.name) : null;
      if (!def || !effectModulatable(def)) { this.error('invalid_route'); return; }
      const key = `${e.id}\u0000${def.id}`;
      let T = byKey.get(key);
      if (!T) {
        T = { key, entry: e, name: def.id, def, down: effectModDown(def), u0: toNorm(def, e.base.get(def.id)), value: NaN, routes: [] };
        byKey.set(key, T);
        targets.push(T);
      }
      let src;
      if (lfoIndex.has(r.source)) src = { kind: 0, idx: lfoIndex.get(r.source), data: null, depth: r.depth };
      else if (/^dat\d+$/.test(r.source)) { const d = this.dataState(r.source); used.add(d); src = { kind: 1, idx: 0, data: d, depth: r.depth }; }
      else src = { kind: 2, idx: 0, data: null, depth: r.depth };     // missing LFO: reads 0
      T.routes.push(src);
      routeTarget[i] = targets.indexOf(T);
    });
    // Parameters that lost their last route return to their base values.
    for (const key of this.routedKeys) {
      if (byKey.has(key)) continue;
      const [id, name] = key.split('\u0000');
      const e = this.findSlot(id);
      if (e && e.base.has(name)) e.slot.setParam(name, e.base.get(name));
    }
    this.routedKeys = new Set(byKey.keys());
    this.targets = targets;
    this.dataList = [...used];
    this.routeTarget = routeTarget;
    this.reportValues = new Float32Array(this.routes.length);
  }

  /** Advances sources to time `t` (s) and applies every route. Allocation-free. */
  evaluate(t) {
    const dl = this.dataList;
    for (let i = 0; i < dl.length; i++) { const d = dl[i]; d.y += d.a * (d.target - d.y); }
    const lfos = this.lfos;
    const val = this.lfoVal;
    for (let i = 0; i < lfos.length; i++) {
      const L = lfos[i];
      let phase;
      if (L.rateKind === 2) {
        const hz = dataHz(L.data.y, L.min, L.max);
        if (t > L.anchorT) { L.anchorPhase += hz * (t - L.anchorT); L.anchorT = t; }
        phase = L.anchorPhase;
      } else {
        phase = L.anchorPhase + L.hz * (t - L.anchorT);
      }
      val[i] = lfoValue(L.code, phase, this.seed, L.index, L.smooth, L.decay);
    }
    const targets = this.targets;
    for (let i = 0; i < targets.length; i++) {
      const T = targets[i];
      const rs = T.routes;
      let sum = 0;
      for (let j = 0; j < rs.length; j++) {
        const r = rs[j];
        const s = r.kind === 0 ? val[r.idx] : r.kind === 1 ? r.data.y : 0;
        if (T.down) sum += (r.depth < 0 ? -r.depth : r.depth) * ((s + 1) / 2);
        else sum += r.depth * s;
      }
      let u;
      if (T.down) { u = T.u0 - sum; if (u < 0) u = 0; else if (u > T.u0) u = T.u0; }
      else { u = T.u0 + sum; if (u < 0) u = 0; else if (u > 1) u = 1; }
      const v = fromNorm(T.def, u);
      if (v !== T.value) { T.value = v; T.entry.slot.setParam(T.name, v); }
    }
  }

  /**
   * Processes one quantum: input (iL, iR; null when unconnected) → slots → output (oL, oR).
   * `frame` is the context frame of the quantum's first sample (currentFrame).
   */
  process(iL, iR, oL, oR, n, frame) {
    if (oR === oL) {
      if (this.scratchR.length < n) this.scratchR = new Float32Array(n);   // mono output: never in practice
      oR = this.scratchR;
    }
    if (iL && iL.length >= n) {
      oL.set(iL.length === n ? iL : iL.subarray(0, n));
      const r = iR && iR.length >= n ? iR : iL;
      oR.set(r.length === n ? r : r.subarray(0, n));
    } else {
      oL.fill(0, 0, n);
      oR.fill(0, 0, n);
    }
    this.started = true;
    const slots = this.slots;
    const fs = this.fs;
    const routed = this.targets.length > 0;
    for (let s = 0; s < n; s += SUB_BLOCK) {
      const e = s + SUB_BLOCK < n ? s + SUB_BLOCK : n;
      if (routed || this.lfos.length > 0) this.evaluate((frame + s) / fs);
      for (let k = 0; k < slots.length; k++) slots[k].slot.process(oL, oR, s, e);
    }
    for (let k = 0; k < slots.length; k++) {
      if (slots[k].slot.takeFault()) this.post({ t: 'fault', slot: slots[k].id });
    }
    this.reportCount += n;
    if (this.reportCount >= this.reportFrames) {
      this.reportCount = 0;
      if (routed) {
        const rv = this.reportValues;
        for (let i = 0; i < rv.length; i++) {
          const ti = this.routeTarget[i];
          rv[i] = ti >= 0 ? this.targets[ti].value : NaN;
        }
        this.post({ t: 'report', values: rv });
      }
    }
  }
}

/** Compiles one LFO message entry, or returns null when it is invalid. */
export function compileLfo(l, bpm) {
  if (!isObj(l) || typeof l.id !== 'string' || !(l.shape in SHAPE_CODE) || !Number.isInteger(l.index)) return null;
  const phase = isFiniteNum(l.phase) ? l.phase : 0;
  const smooth = isFiniteNum(l.smooth) ? Math.min(1, Math.max(0, l.smooth)) : 0;
  const L = {
    id: l.id, index: l.index, code: SHAPE_CODE[l.shape], rateKind: 0, hz: 0, sync: '', dataId: '', data: null,
    min: 0, max: 0, smooth, decay: smoothDecay(smooth),
    anchorT: isFiniteNum(l.anchorT) ? l.anchorT : 0,
    anchorPhase: isFiniteNum(l.anchorPhase) ? l.anchorPhase : phase,
    key: '',
  };
  const r = l.rate;
  if (isFiniteNum(r)) {
    if (r < LFO_RATE_MIN || r > LFO_RATE_MAX) return null;
    L.hz = r;
  } else if (isObj(r) && typeof r.sync === 'string') {
    if (!(syncBeats(r.sync) > 0)) return null;
    L.rateKind = 1;
    L.sync = r.sync;
    L.hz = syncHz(r.sync, bpm);
  } else if (isObj(r) && typeof r.data === 'string' && isFiniteNum(r.min) && isFiniteNum(r.max)) {
    if (!(r.min >= LFO_RATE_MIN && r.max <= LFO_RATE_MAX && r.min < r.max)) return null;
    L.rateKind = 2;
    L.dataId = r.data;
    L.min = r.min;
    L.max = r.max;
  } else return null;
  L.key = JSON.stringify([l.index, l.shape, r, phase, smooth]);
  return L;
}
