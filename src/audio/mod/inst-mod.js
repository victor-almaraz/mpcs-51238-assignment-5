// Audio-rate modulation inside one instrument (modulation.md, Synth targets): one route gain per
// route, fed by a shared engine source (or a per-voice retrigger source), connected to the target
// AudioParam of every voice. Route gains are limited so toNorm(base) ± Σ|depth| stays within 0–1.
// Also the per-voice offsets of setVoiceMod (modulation.md, Per-voice values).

import { getDef } from '../synths/param-defs.js';
import { depthScale, nativeGain, synthModPath, voiceOffsetRange } from './model.js';

const GAIN_TAU = 0.01;

/** The AudioParam at `path` ('<node>.<param>') of voice `v`, or null. */
export function voiceParam(v, path) {
  const dot = path.indexOf('.');
  const node = v[path.slice(0, dot)];
  const p = node ? node[path.slice(dot + 1)] : null;
  return p && typeof p.setValueAtTime === 'function' ? p : null;
}

function safeDisconnect(node, dest) {
  try {
    if (dest === undefined) node.disconnect();
    else node.disconnect(dest);
  } catch { /* already disconnected */ }
}

export class InstrumentMod {
  /** @param {any} inst Instrument */
  constructor(inst) {
    this.inst = inst;
    this.ctx = inst.ctx;
    /** @type {Map<string, any>} key → route */
    this.routes = new Map();
  }

  /**
   * Replaces the audio-rate routes. Items: { key, name, def, depth, src: AudioNode | null,
   * retrig: { key, make(t) } | null }. Unchanged routes keep their gain node; a new free-running
   * route connects to every sounding voice; a new retrigger route applies from the next note.
   */
  setRoutes(items) {
    const now = this.ctx.currentTime;
    const next = new Map();
    const touched = new Set();
    for (const it of items) {
      const old = this.routes.get(it.key);
      if (old && old.src === it.src && (old.retrig?.key ?? null) === (it.retrig?.key ?? null)) {
        old.depth = it.depth;
        next.set(it.key, old);
        this.routes.delete(it.key);
        touched.add(it.name);
        continue;
      }
      const R = { key: it.key, name: it.name, def: it.def, path: it.def.mod.target, depth: it.depth, src: it.src, retrig: it.retrig, gain: null, value: 0, voiceGains: new Set() };
      if (R.src) {
        R.gain = new GainNode(this.ctx, { gain: 0 });
        R.src.connect(R.gain);
        for (const v of this.inst.activeVoices()) this.connectRoute(R, v);
      }
      next.set(it.key, R);
      touched.add(it.name);
    }
    for (const R of this.routes.values()) { this.disconnectRoute(R); touched.add(R.name); }
    this.routes = next;
    for (const name of touched) this.updateGains(name, now);
  }

  disconnectRoute(R) {
    if (R.gain) {
      safeDisconnect(R.gain);
      if (R.src) safeDisconnect(R.src, R.gain);
    }
    for (const g of R.voiceGains) safeDisconnect(g);
    R.voiceGains.clear();
  }

  connectRoute(R, v) {
    const p = voiceParam(v, R.path);
    if (!p || !R.gain) return;
    R.gain.connect(p);
    v.modConns.push([R.gain, p]);
  }

  /** Recomputes the limited gains of every route on parameter `name`. */
  updateGains(name, now = this.ctx.currentTime) {
    const list = [...this.routes.values()].filter((R) => R.name === name);
    if (!list.length) return;
    const def = list[0].def;
    const k = depthScale(def, this.inst.base[name], list.map((R) => R.depth));
    for (const R of list) {
      const g = nativeGain(def, R.depth * k);
      if (g === R.value) continue;
      R.value = g;
      if (R.gain) R.gain.gain.setTargetAtTime(g, now, GAIN_TAU);
      for (const vg of R.voiceGains) vg.gain.setTargetAtTime(g, now, GAIN_TAU);
    }
  }

  /** Normalized headroom used by the routes on `name`: Σ|depth| after limiting. */
  used(name) {
    const list = [...this.routes.values()].filter((R) => R.name === name);
    if (!list.length) return 0;
    const k = depthScale(list[0].def, this.inst.base[name], list.map((R) => R.depth));
    return list.reduce((s, R) => s + Math.abs(R.depth) * k, 0);
  }

  /** Base value of `name` changed (setParam): recompute its limit. */
  baseChanged(name) {
    this.updateGains(name);
  }

  /** Connects a new voice's target parameters to the route gains; starts retrigger sources. */
  connectVoice(v) {
    for (const R of this.routes.values()) {
      if (R.src) { this.connectRoute(R, v); continue; }
      if (!R.retrig) continue;
      const p = voiceParam(v, R.path);
      if (!p) continue;
      const s = R.retrig.make(v.start);
      const g = new GainNode(this.ctx, { gain: R.value });
      s.node.connect(g).connect(p);
      R.voiceGains.add(g);
      v.sources.push(s.node);
      v.nodes.push(s.node, g);
      v.onEnd.push(() => { R.voiceGains.delete(g); s.release(); });
    }
  }

  /** setVoiceMod for voice `v` (modulation.md, Per-voice values). */
  setVoiceMod(v, mods) {
    const now = this.ctx.currentTime;
    for (const [name, value] of Object.entries(mods)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      const def = getDef(this.inst.type, name);
      if (synthModPath(def) !== 'audio') continue;
      const p = voiceParam(v, def.mod.target);
      if (!p) continue;
      const [lo, hi] = voiceOffsetRange(def, this.inst.base[name], this.used(name));
      const x = value < -1 ? -1 : value > 1 ? 1 : value;
      const g = nativeGain(def, x < lo ? lo : x > hi ? hi : x);
      v.voiceMods ??= new Map();
      const node = v.voiceMods.get(name);
      if (node) { node.offset.setTargetAtTime(g, now, GAIN_TAU); continue; }
      const c = new ConstantSourceNode(this.ctx, { offset: g });
      c.connect(p);
      c.start(Math.max(now, v.start));
      if (Number.isFinite(v.end)) c.stop(Math.max(v.end, now));   // already released
      v.voiceMods.set(name, c);
      v.sources.push(c);
      v.nodes.push(c);
    }
  }

  dispose() {
    for (const R of this.routes.values()) this.disconnectRoute(R);
    this.routes.clear();
  }
}
