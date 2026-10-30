// Two-operator FM (synthesis-fm.md):
//   mod Osc(sine, f·(ratio + fine)) → depth Gain (I·f_mod, Hz) → decay Gain (1 → 0.1) → carrier.frequency
//   carrier Osc(sine, f) → env Gain → output
// The depth and decay stages are separate so live index changes can reach sounding voices
// while the index-decay envelope runs.

import { Instrument } from '../instrument.js';
import { GAIN_TAU } from '../smoothing.js';
import { mtof } from './param-defs.js';

export class FM extends Instrument {
  constructor(ctx, pool, opts) {
    super('fm', ctx, pool, opts);
  }

  /** Effective index clamped so sidebands stay under 0.45·fs (Carson's rule). */
  depthHz(fc, ratio, index) {
    const fm = fc * ratio;
    const iMax = Math.max(0, (0.45 * this.ctx.sampleRate - fc) / fm - 1);
    return Math.min(index, iMax) * fm;
  }

  startVoice(pitch, velocity, t) {
    const p = this.params;
    const v = this.voiceModel(t, velocity, p.attack, p.release, p.decay, p.sustain);
    const fc = mtof(pitch);
    // Fine moves the modulator off the ratio grid (inharmonic, bell-like spectra).
    const ratio = Math.max(0.01, p.ratio + p.fine);
    // Above 0.45·fs the Nyquist clamp already sets the depth to 0, so capping the modulator
    // frequency there changes nothing audible and keeps it inside the nominal range.
    const mod = new OscillatorNode(this.ctx, { type: 'sine', frequency: Math.min(fc * ratio, 0.45 * this.ctx.sampleRate) });
    const depth = new GainNode(this.ctx, { gain: this.depthHz(fc, ratio, p.index) });
    const decay = new GainNode(this.ctx, { gain: 1 });
    const carrier = new OscillatorNode(this.ctx, { type: 'sine', frequency: fc });
    const env = new GainNode(this.ctx, { gain: 0 });
    mod.connect(depth).connect(decay).connect(carrier.frequency);
    carrier.connect(env).connect(this.polyNode);
    decay.gain.setValueAtTime(1, t);
    decay.gain.setTargetAtTime(0.1, t, Math.max(0.01, p.indexDecay) / 3);
    Object.assign(v, { env, depth, fc, ratio, sources: [carrier, mod], nodes: [mod, depth, decay, carrier, env] });
    this.launch(v);
    return v;
  }

  applyParam(name, value, now) {
    if (name === 'index') {
      for (const v of this.activeVoices()) v.depth.gain.setTargetAtTime(this.depthHz(v.fc, v.ratio, value), now, GAIN_TAU);
    }
    // ratio, fine, index decay and the envelope apply to new voices.
  }
}
