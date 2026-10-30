// Engine: one instrument per rack widget, connected to the master bus (audio-engine-core.md).
//   voice → inst.output (volume × mute/solo; polyGain inside) → mixBus → masterGain → safety
// The live app and offline render build the engine the same way; buildEngine() is the
// offline/test entry point.

import { Subtractive } from './synths/subtractive.js';
import { FM } from './synths/fm.js';
import { Additive } from './synths/additive.js';
import { Pluck } from './synths/pluck.js';
import { Granular } from './synths/granular.js';
import { VoicePool, MAX_VOICES_GLOBAL } from './voices.js';
import { TrackedParam, GAIN_TAU, RISE_TAU } from './smoothing.js';
import { dbToGain, tuningSemitones } from './synths/param-defs.js';
import { hashSeed } from './random.js';
import { buildMasterBus } from './master-bus.js';

const REMOVE_DELAY_MS = 50;

// Same rule as playback/routing.js; audio/ may not import playback/ (repo-structure.md).
const anySolo = (widgets) => widgets.some((w) => !!w.solo);
/** Mute wins over solo when both are set on the same widget. */
const isAudible = (w, soloActive) => !w.muted && (!soloActive || !!w.solo);

export function createInstrument(type, ctx, pool, opts = {}) {
  switch (type) {
    case 'subtractive': return new Subtractive(ctx, pool, opts);
    case 'fm': return new FM(ctx, pool, opts);
    case 'additive': return new Additive(ctx, pool, opts);
    case 'pluck': return new Pluck(ctx, pool, opts);
    case 'granular': return new Granular(ctx, pool, opts);
    default: throw new Error(`Unknown synth type: ${type}`);
  }
}

function copyParams(params) {
  const out = {};
  if (!params) return out;
  for (const [k, v] of Object.entries(params)) out[k] = Array.isArray(v) ? v.slice() : v;
  return out;
}

function snapshot(w) {
  return {
    id: w.id,
    type: w.type,
    muted: !!w.muted,
    solo: !!w.solo,
    armed: !!w.armed,
    volumeDb: w.volumeDb,
    part: w.part ?? 'all',
    params: copyParams(w.params),
    sample: w.sample ?? null,          // granular: { name, buffer, seconds } (not copied)
    detune: tuningSemitones(w),        // octave and cents in semitones
  };
}

function sameValue(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  return a === b;
}

function gainTarget(w, soloActive) {
  return isAudible(w, soloActive) ? dbToGain(w.volumeDb) : 0;
}

export class Engine {
  constructor(ctx, bus, {
    seed = 1, realtime = true, lookahead = () => 0.1, maxTime = Infinity, ks = true, onFault, onError,
  } = {}) {
    this.ctx = ctx;
    this.bus = bus;
    this.seed = seed;
    this.realtime = realtime;
    this.lookahead = lookahead;
    this.maxTime = maxTime;
    this.ks = ks;
    this.onFault = onFault;
    this.onError = onError;
    this.pool = new VoicePool(MAX_VOICES_GLOBAL);
    this.entries = new Map();          // id → { widget, inst, gain, serial }
    this.order = [];                   // widget ids in rack order
    this.counter = 0;
    this.timeouts = new Set();
    this.disposed = false;
  }

  get output() {
    return this.bus.safetyOut;
  }

  makeInstrument(type, serial) {
    if (type === 'pluck' && !this.ks) return null;
    try {
      return createInstrument(type, this.ctx, this.pool, {
        seed: hashSeed(this.seed, serial),
        realtime: this.realtime,
        lookahead: this.lookahead,
        maxTime: this.maxTime,
        onFault: this.onFault,
        onError: this.onError,
      });
    } catch (err) {
      if (type === 'pluck') return null;   // AudioWorkletNode construction failed
      throw err;
    }
  }

  /** Builds the instrument for `e`, applies its params and connects it at gain `target`. */
  attach(e, target, now, rampIn) {
    const inst = this.makeInstrument(e.widget.type, e.serial);
    e.inst = inst;
    e.gain = null;
    if (!inst) return;
    for (const [k, v] of Object.entries(e.widget.params)) inst.setParam(k, v);
    if (e.widget.sample && inst.setSample) inst.setSample(e.widget.sample.buffer);
    inst.setDetune(e.widget.detune);
    inst.output.connect(this.bus.mixBus);
    e.gain = new TrackedParam(inst.output.gain, 0);
    if (rampIn > 0) e.gain.linearTo(target, now, rampIn);
    else e.gain.setAt(target, now);   // no voices yet, so a jump is silent
  }

  sync(widgets, { rampIn = 0 } = {}) {
    if (this.disposed) return;
    const now = this.ctx.currentTime;
    const soloActive = anySolo(widgets);
    const seen = new Set();
    for (const w of widgets) {
      seen.add(w.id);
      const target = gainTarget(w, soloActive);
      let e = this.entries.get(w.id);
      if (e && e.widget.type !== w.type) {
        this.remove(e, now);
        e = null;
      }
      if (!e) {
        e = { widget: snapshot(w), inst: null, gain: null, serial: this.counter++ };
        this.entries.set(w.id, e);
        this.attach(e, target, now, rampIn);
        continue;
      }
      const prev = e.widget;
      e.widget = snapshot(w);
      if (!e.inst) continue;
      for (const [k, v] of Object.entries(e.widget.params)) {
        if (!sameValue(prev.params[k], v)) e.inst.setParam(k, v);
      }
      if (prev.sample !== e.widget.sample && e.inst.setSample) e.inst.setSample(e.widget.sample?.buffer ?? null);
      if (prev.detune !== e.widget.detune) e.inst.setDetune(e.widget.detune);
      if (prev.part !== e.widget.part) e.inst.allNotesOff(now);
      if (Math.abs(target - e.gain.target) > 1e-9) e.gain.setTarget(target, now, target > e.gain.target ? RISE_TAU : GAIN_TAU);
    }
    for (const [id, e] of this.entries) if (!seen.has(id)) this.remove(e, now);
    this.order = widgets.map((w) => w.id);
  }

  remove(e, now) {
    if (this.entries.get(e.widget.id) === e) this.entries.delete(e.widget.id);
    const inst = e.inst;
    if (!inst) return;
    inst.allNotesOff(now);
    e.gain.setTarget(0, now, GAIN_TAU);
    if (!this.realtime) { inst.dispose(); return; }
    const h = setTimeout(() => { this.timeouts.delete(h); inst.dispose(); }, REMOVE_DELAY_MS);
    this.timeouts.add(h);
  }

  /** Rack order: { id, part, armed, muted, solo, audible, inst }. inst may be null. */
  targets() {
    const list = [];
    for (const id of this.order) {
      const e = this.entries.get(id);
      if (e) list.push(e);
    }
    const soloActive = list.some((e) => e.widget.solo);
    return list.map((e) => {
      const w = e.widget;
      return { id: w.id, part: w.part, armed: w.armed, muted: w.muted, solo: w.solo, audible: isAudible(w, soloActive), inst: e.inst };
    });
  }

  get(id) {
    const e = this.entries.get(id);
    return e ? e.inst : null;
  }

  releaseAll(t = this.ctx.currentTime) {
    for (const e of this.entries.values()) if (e.inst) e.inst.allNotesOff(t);
  }

  /** Ramps every widget output to 0 (τ 10 ms) from its tracked value; used before a patch swap. */
  fadeOutAll(t = this.ctx.currentTime) {
    for (const e of this.entries.values()) if (e.gain) e.gain.setTarget(0, t, GAIN_TAU);
  }

  /** Resolves when every instrument's scheduled notes have reached the audio thread. Offline only. */
  flush() {
    return Promise.all([...this.entries.values()].map((e) => (e.inst ? e.inst.flush() : null)));
  }

  pump(until) {
    for (const e of this.entries.values()) if (e.inst) e.inst.pump(until);
  }

  /**
   * Disposes and recreates every instrument, or only those of `type` (clears NaN state after
   * a fault). Disposal stops sources without a fade: call it only while the output is silent.
   */
  rebuild(type = null) {
    if (this.disposed) return;
    const now = this.ctx.currentTime;
    const soloActive = [...this.entries.values()].some((e) => e.widget.solo);
    for (const e of this.entries.values()) {
      if (type !== null && e.widget.type !== type) continue;
      if (e.inst) e.inst.dispose();
      this.attach(e, gainTarget(e.widget, soloActive), now, 0);
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const h of this.timeouts) clearTimeout(h);
    this.timeouts.clear();
    for (const e of this.entries.values()) if (e.inst) e.inst.dispose();
    this.entries.clear();
    this.order = [];
  }
}

/** Builds the master bus and the engine for `widgets`; used by offline render and tests. */
export async function buildEngine(ctx, seed, widgets = [], opts = {}) {
  const bus = await buildMasterBus(ctx, { realtime: opts.realtime ?? false, masterGain: opts.masterGain });
  const maxTime = typeof ctx.length === 'number' && ctx.sampleRate > 0 ? ctx.length / ctx.sampleRate : Infinity;
  const engine = new Engine(ctx, bus, { seed, realtime: false, maxTime, ks: bus.worklets.ks, ...opts });
  engine.sync(widgets);
  return engine;
}
