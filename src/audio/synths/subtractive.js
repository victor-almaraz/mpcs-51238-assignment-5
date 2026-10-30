// Subtractive: OscillatorNode(type) → BiquadFilterNode('lowpass') → env Gain → output
// (synthesis-subtractive.md).
//
// The filter envelope follows the amp envelope's shape (attack, decay to sustain, release)
// on the filter's `detune` param: 0 → envAmount octaves → sustain × envAmount → 0, as cents.
// Per voice it is capped so cutoff × 2^octaves stays at or under 0.45·fs.

import { Instrument } from '../instrument.js';
import { FILTER_TAU } from '../smoothing.js';
import { envValueAt, holdAt } from '../envelope.js';
import { mtof } from './param-defs.js';

export class Subtractive extends Instrument {
  constructor(ctx, pool, opts) {
    super('subtractive', ctx, pool, opts);
  }

  limitHz() {
    return 0.45 * this.ctx.sampleRate;
  }

  cutoffHz() {
    return Math.min(this.params.cutoff, this.limitHz());
  }

  /** Filter envelope depth in cents for a voice starting at `hz`, capped at 0.45·fs. */
  envCents(hz) {
    const room = 1200 * Math.log2(this.limitHz() / hz);
    return Math.max(0, Math.min(this.params.envAmount * 1200, room));
  }

  /** Base cutoff for voice `v`: the knob, lowered if needed so its envelope peak fits. */
  voiceCutoff(v, hz) {
    return Math.min(hz, this.limitHz() / Math.pow(2, v.envCents / 1200));
  }

  startVoice(pitch, velocity, t) {
    const p = this.params;
    const v = this.voiceModel(t, velocity, p.attack, p.release, p.decay, p.sustain);
    const hz = this.cutoffHz();
    v.envCents = this.envCents(hz);
    const osc = new OscillatorNode(this.ctx, { type: p.waveform, frequency: mtof(pitch) });
    const filter = new BiquadFilterNode(this.ctx, { type: 'lowpass', frequency: hz, Q: p.resonance });
    const env = new GainNode(this.ctx, { gain: 0 });
    osc.connect(filter).connect(env).connect(this.polyNode);
    Object.assign(v, { env, filter, sources: [osc], nodes: [osc, filter, env] });
    if (v.envCents > 0) {
      const d = filter.detune;
      d.setValueAtTime(0, t);
      d.linearRampToValueAtTime(v.envCents, t + v.attack);
      if (v.sustain < 1) d.setTargetAtTime(v.envCents * v.sustain, t + v.attack, v.decayTau);
    }
    this.launch(v);
    return v;
  }

  releaseVoice(v, t) {
    // The filter value comes from the amp model before the release rewrites it.
    const cents = v.envCents > 0 ? (v.envCents * envValueAt(v, Math.max(t, v.start))) / v.peak : 0;
    super.releaseVoice(v, t);
    if (v.envCents > 0) {
      holdAt(v.filter.detune, t, cents, t > v.start && t < v.start + v.attack);
      v.filter.detune.setTargetAtTime(0, t, v.release / 3);
    }
  }

  applyParam(name, value, now) {
    if (name === 'cutoff') {
      const hz = this.cutoffHz();
      for (const v of this.activeVoices()) v.filter.frequency.setTargetAtTime(this.voiceCutoff(v, hz), now, FILTER_TAU);
    } else if (name === 'resonance') {
      for (const v of this.activeVoices()) v.filter.Q.setTargetAtTime(value, now, FILTER_TAU);
    }
    // waveform, filter env amount and the envelope times apply to new voices.
  }
}
