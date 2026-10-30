/*
 * `fx-chain` AudioWorkletProcessor (effects.md, Chain processor). Entry point of the bundle
 * public/worklets/fx-chain.js, built by scripts/build-worklets.mjs; not imported by the page.
 * One node per chain: numberOfInputs 1, numberOfOutputs 1, outputChannelCount [2].
 * processorOptions: { seed, chainIndex }. `sampleRate`, `currentFrame`, `AudioWorkletProcessor`
 * and `registerProcessor` are globals of AudioWorkletGlobalScope.
 */
import { ChainCore } from './chain-core.js';

class FxChainProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.core = new ChainCore(sampleRate, {
      seed: o.seed,
      chainIndex: o.chainIndex,
      post: (msg) => this.port.postMessage(msg),
    });
    this.port.onmessage = (e) => this.core.handle(e.data);
  }

  process(inputs, outputs) {
    const out = outputs[0];
    const oL = out[0];
    const oR = out.length > 1 ? out[1] : out[0];
    const inp = inputs[0];
    const iL = inp && inp.length > 0 ? inp[0] : null;
    const iR = inp && inp.length > 1 ? inp[1] : iL;
    this.core.process(iL, iR, oL, oR, oL.length, currentFrame);
    return true;
  }
}

registerProcessor('fx-chain', FxChainProcessor);
