// Additive: OscillatorNode with PeriodicWave(8 harmonic amplitudes) → env Gain → output
// (synthesis-additive.md). Vibrato: a per-voice sine LFO (rate) → Gain (depth, cents) →
// osc.detune; it changes pitch only, never level.

import { Instrument } from '../instrument.js';
import { FILTER_TAU } from '../smoothing.js';
import { mtof } from './param-defs.js';

export function makeWave(ctx, h) {
  const real = new Float32Array(h.length + 1);       // index 0 = DC term, ignored by the spec
  const imag = new Float32Array(h.length + 1);
  h.forEach((a, i) => (imag[i + 1] = a));             // sine terms
  const sum = h.reduce((s, a) => s + a, 0);
  for (let i = 1; i < imag.length; i++) imag[i] /= Math.max(1, sum);  // manual headroom
  return ctx.createPeriodicWave(real, imag, { disableNormalization: true });
}

export class Additive extends Instrument {
  constructor(ctx, pool, opts) {
    super('additive', ctx, pool, opts);
    this.wave = makeWave(ctx, this.params.harmonics);
  }

  startVoice(pitch, velocity, t) {
    const p = this.params;
    const v = this.voiceModel(t, velocity, p.attack, p.release, p.decay, p.sustain);
    const osc = new OscillatorNode(this.ctx, { frequency: mtof(pitch), periodicWave: this.wave });
    const lfo = new OscillatorNode(this.ctx, { type: 'sine', frequency: p.vibratoRate });
    const depth = new GainNode(this.ctx, { gain: p.vibratoDepth });
    const env = new GainNode(this.ctx, { gain: 0 });
    lfo.connect(depth).connect(osc.detune);
    osc.connect(env).connect(this.polyNode);
    Object.assign(v, { env, osc, lfo, depth, sources: [osc, lfo], nodes: [osc, lfo, depth, env] });
    this.launch(v);
    return v;
  }

  applyParam(name, value, now) {
    if (name === 'harmonics') {
      // The engine coalesces edits to one call per animation frame.
      this.wave = makeWave(this.ctx, value);
      for (const v of this.activeVoices()) v.osc.setPeriodicWave(this.wave);
    } else if (name === 'vibratoRate') {
      for (const v of this.activeVoices()) v.lfo.frequency.setTargetAtTime(value, now, FILTER_TAU);
    } else if (name === 'vibratoDepth') {
      for (const v of this.activeVoices()) v.depth.gain.setTargetAtTime(value, now, FILTER_TAU);
    }
    // The envelope times apply to new voices.
  }
}
