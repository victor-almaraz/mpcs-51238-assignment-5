// Common widget interface and voice handling (audio-engine-core.md).
//
//   type, output (GainNode, connected to mixBus by the engine)
//   noteOn(pitch, velocity, time, source)    source: 'file' | 'live'
//   noteOff(pitch, time, source)             may be called with a future time
//   allNotesOff(time)                        fast release; cancels future-start voices
//   setParam(name, value), getParams(), dispose()
//
// Subclasses implement startVoice(pitch, velocity, t) and applyParam(name, value, now).
// Voices built from source nodes + an `env` GainNode use the default release/steal methods.

import { MAX_VOICES_PER_WIDGET } from './voices.js';
import { TrackedParam, POLY_TAU } from './smoothing.js';
import { holdAt, scheduleAttack, scheduleRelease, FAST_TAU, STEAL_TAU, MIN_ATTACK, MIN_RELEASE } from './envelope.js';
import { coerceParam, defaultParams, getDef, velocityGain } from './synths/param-defs.js';

export class Instrument {
  constructor(type, ctx, pool, opts = {}) {
    this.type = type;
    this.ctx = ctx;
    this.pool = pool;
    this.cap = opts.cap ?? MAX_VOICES_PER_WIDGET;
    this.output = new GainNode(ctx, { gain: 0 });       // volume × mute/solo, set by the engine
    this.polyNode = new GainNode(ctx, { gain: 1 });
    this.polyNode.connect(this.output);
    this.poly = new TrackedParam(this.polyNode.gain, 1);
    this.params = defaultParams(type);
    this.detune = 0;                   // semitones from the widget's tuning (setDetune)
    this.disposed = false;
  }

  noteOn(pitch, velocity, time, source) {
    if (this.disposed) return;
    const t = Math.max(time, this.ctx.currentTime);
    this.pool.makeRoom(this, this.cap, t);
    // Tuning shifts the sounding pitch; matching (noteOff) keeps the played pitch.
    const sounding = Math.min(127, Math.max(0, pitch + this.detune));
    const v = this.startVoice(sounding, velocity, t);
    if (!v) return;
    v.owner = this;
    v.pitch = pitch;
    v.source = source;
    v.stolen = false;
    v.released = false;
    this.pool.add(v);
    this.updatePoly(t);
  }

  /** Releases the oldest voice with this pitch and source that started by `time` and is not released. */
  noteOff(pitch, time, source) {
    let best = null;
    for (const v of this.pool.voices) {
      if (v.owner !== this || v.stolen || v.released || v.pitch !== pitch || v.source !== source || v.start > time) continue;
      if (!best || v.start < best.start) best = v;
    }
    if (!best) return;
    best.released = true;
    this.releaseVoice(best, Math.max(time, best.start));
  }

  allNotesOff(time) {
    const t = Math.max(time, this.ctx.currentTime);
    for (const v of this.pool.ofOwner(this)) {
      if (v.stolen || v.end <= t) continue;
      if (v.start > t) this.cancelVoice(v, t);
      else this.fastRelease(v, t);
      v.released = true;
    }
  }

  /** Pitch shift in semitones (octave × 12 + cents / 100) for notes that start from now on. */
  setDetune(semitones) {
    this.detune = Number.isFinite(semitones) ? semitones : 0;
  }

  setParam(name, value) {
    const def = getDef(this.type, name);
    if (!def) return;
    const v = coerceParam(def, value);
    this.params[name] = Array.isArray(v) ? v.slice() : v;
    if (!this.disposed) this.applyParam(name, this.params[name], this.ctx.currentTime);
  }

  getParams() {
    const out = {};
    for (const [k, v] of Object.entries(this.params)) out[k] = Array.isArray(v) ? v.slice() : v;
    return out;
  }

  /** Resolves when scheduled work has reached the audio thread (pluck's worklet); see Pluck.flush. */
  flush() {
    return Promise.resolve();
  }

  /** Hook for instruments that schedule work ahead (granular). */
  pump() {}

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const t = this.ctx.currentTime;
    for (const v of this.pool.ofOwner(this)) this.stopAt(v, t);
    this.pool.removeOwner(this);
    this.output.disconnect();
  }

  // ----- shared voice helpers -----

  /**
   * Envelope model for a new voice; see envelope.js. Without `decay` and `sustain` it is the
   * plain AR shape (sustain 1). Sustain never exceeds 1, so the peak stays the velocity gain.
   */
  voiceModel(t, velocity, attack, release, decay = MIN_RELEASE, sustain = 1) {
    return {
      start: t,
      attack: Math.max(MIN_ATTACK, attack),
      peak: velocityGain(velocity),
      sustain: Math.min(1, Math.max(0, sustain)),
      decayTau: Math.max(MIN_RELEASE, decay) / 3,
      release: Math.max(MIN_RELEASE, release),
      offTime: Infinity,
      relFrom: 0,
      tau: 1,
      end: Infinity,
      sources: [],
      nodes: [],
    };
  }

  /** Starts sources at v.start, schedules the attack and disconnects everything when done. */
  launch(v) {
    scheduleAttack(v.env.gain, v);
    for (const s of v.sources) s.start(v.start);
    if (v.sources.length > 0) {
      v.sources[0].onended = () => { for (const n of v.nodes) n.disconnect(); };
    }
  }

  stopAt(v, t) {
    v.end = Math.min(v.end, t);
    for (const s of v.sources) {
      try { s.stop(t); } catch { /* already stopped */ }
    }
  }

  releaseVoice(v, t) {
    scheduleRelease(v.env.gain, v, t, v.release / 3);
    this.stopAt(v, t + v.release * 1.5 + 0.05);
  }

  fastRelease(v, t) {
    scheduleRelease(v.env.gain, v, t, FAST_TAU);
    this.stopAt(v, t + 0.03);
  }

  stealVoice(v, t) {
    const ts = Math.max(t, v.start);
    scheduleRelease(v.env.gain, v, ts, STEAL_TAU);
    this.stopAt(v, ts + 0.02);
  }

  /** A voice whose start is still in the future never sounds. */
  cancelVoice(v, t) {
    holdAt(v.env.gain, t, 0);
    v.offTime = t;
    v.relFrom = 0;
    v.tau = FAST_TAU;
    this.stopAt(v, t);
  }

  /** polyGain = min(1, 2 / sqrt(activeVoices)), smoothed with τ = 50 ms (audio-safety.md). */
  updatePoly(t) {
    const n = this.pool.live(t, this).length;
    const g = Math.min(1, 2 / Math.sqrt(Math.max(1, n)));
    if (Math.abs(g - this.poly.target) > 1e-4) this.poly.setTarget(g, t, POLY_TAU);
  }

  /** Voices that are currently sounding or scheduled (for live parameter changes). */
  activeVoices() {
    const now = this.ctx.currentTime;
    return this.pool.voices.filter((v) => v.owner === this && !v.stolen && v.end > now);
  }
}
