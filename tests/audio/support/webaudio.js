// Minimal fake Web Audio graph for engine tests in Node (doc/testing.md: no AudioContext).
// Nodes record connections; AudioParams are FakeAudioParam from tests/fakes.js. An
// `fx-chain` AudioWorkletNode runs the real ChainCore, so messages travel the real protocol.

import { FakeAudioParam } from '../../fakes.js';
import { ChainCore } from '../../../src/audio/fx/chain-core.js';

const NAMES = ['GainNode', 'OscillatorNode', 'ConstantSourceNode', 'BiquadFilterNode', 'StereoPannerNode',
  'AnalyserNode', 'AudioWorkletNode', 'AudioBufferSourceNode', 'AudioBuffer'];

class FakeNode {
  constructor(ctx) {
    this.context = ctx;
    /** @type {Set<any>} */
    this.outputs = new Set();
    ctx.nodes.push(this);
  }

  connect(dest) {
    this.outputs.add(dest);
    return dest;
  }

  disconnect(dest) {
    if (dest === undefined) { this.outputs.clear(); return; }
    if (!this.outputs.has(dest)) {
      const e = new Error('InvalidAccessError: not connected');
      e.name = 'InvalidAccessError';
      throw e;
    }
    this.outputs.delete(dest);
  }
}

class FakeSource extends FakeNode {
  constructor(ctx) {
    super(ctx);
    this.started = null;
    this.stopped = null;
    this.onended = null;
  }
  start(t = 0) {
    if (this.started !== null) throw new Error('InvalidStateError: start called twice');
    this.started = t;
  }
  stop(t = 0) {
    if (this.started === null) throw new Error('InvalidStateError: stop before start');
    this.stopped = t;
  }
}

export class GainNode extends FakeNode {
  constructor(ctx, o = {}) { super(ctx); this.gain = new FakeAudioParam(o.gain ?? 1); }
}

export class OscillatorNode extends FakeSource {
  constructor(ctx, o = {}) {
    super(ctx);
    this.type = o.type ?? 'sine';
    this.periodicWave = o.periodicWave ?? null;
    this.frequency = new FakeAudioParam(o.frequency ?? 440);
    this.detune = new FakeAudioParam(o.detune ?? 0);
  }
  setPeriodicWave(w) { this.periodicWave = w; }
}

export class ConstantSourceNode extends FakeSource {
  constructor(ctx, o = {}) { super(ctx); this.offset = new FakeAudioParam(o.offset ?? 1); }
}

export class BiquadFilterNode extends FakeNode {
  constructor(ctx, o = {}) {
    super(ctx);
    this.type = o.type ?? 'lowpass';
    this.frequency = new FakeAudioParam(o.frequency ?? 350);
    this.Q = new FakeAudioParam(o.Q ?? 1);
    this.detune = new FakeAudioParam(o.detune ?? 0);
    this.gain = new FakeAudioParam(o.gain ?? 0);
  }
}

export class StereoPannerNode extends FakeNode {
  constructor(ctx, o = {}) { super(ctx); this.pan = new FakeAudioParam(o.pan ?? 0); }
}

export class AnalyserNode extends FakeNode {
  constructor(ctx, o = {}) {
    super(ctx);
    this.fftSize = o.fftSize ?? 2048;
    this.frequencyBinCount = this.fftSize / 2;
    this.smoothingTimeConstant = o.smoothingTimeConstant ?? 0.8;
    this.timeData = null;   // tests set these
    this.byteData = null;
    this.reads = 0;
  }
  getFloatTimeDomainData(a) { this.reads++; if (this.timeData) a.set(this.timeData.subarray(0, a.length)); else a.fill(0); }
  getByteFrequencyData(a) { this.reads++; if (this.byteData) a.set(this.byteData.subarray(0, a.length)); else a.fill(0); }
}

export class AudioBufferSourceNode extends FakeSource {
  constructor(ctx, o = {}) { super(ctx); this.buffer = o.buffer ?? null; this.playbackRate = new FakeAudioParam(o.playbackRate ?? 1); }
}

export class AudioBuffer {
  constructor({ length, numberOfChannels = 1, sampleRate }) {
    this.length = length;
    this.sampleRate = sampleRate;
    this.duration = length / sampleRate;
    this.data = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }
  getChannelData(i) { return this.data[i]; }
}

class FakePort {
  constructor(node) {
    this.node = node;
    this.sent = [];
    this.onmessage = null;
    this.closed = false;
  }
  postMessage(msg) {
    if (this.closed) throw new Error('port closed');
    this.sent.push(structuredClone(msg));
    if (this.node.core) this.node.core.handle(structuredClone(msg));
  }
  close() { this.closed = true; }
}

export class AudioWorkletNode extends FakeNode {
  constructor(ctx, name, o = {}) {
    super(ctx);
    if (!ctx.processors.has(name)) throw new Error(`InvalidStateError: processor ${name} not registered`);
    this.name = name;
    this.options = o;
    this.port = new FakePort(this);
    this.parameters = new Map([['damping', new FakeAudioParam(0.5)], ['brightness', new FakeAudioParam(0.7)]]);
    this.onprocessorerror = null;
    this.received = [];
    if (name === 'fx-chain') {
      const po = o.processorOptions ?? {};
      this.core = new ChainCore(ctx.sampleRate, {
        seed: po.seed, chainIndex: po.chainIndex,
        post: (m) => { this.received.push(m); this.port.onmessage?.({ data: m }); },
      });
    }
  }

  /** Test helper: renders `n` frames of stereo input through the chain core. */
  render(inL, inR = inL) {
    const n = inL.length;
    const oL = new Float32Array(n);
    const oR = new Float32Array(n);
    this.core.process(inL, inR, oL, oR, n, this.context.frame);
    return [oL, oR];
  }
}

export class FakeContext {
  constructor({ sampleRate = 48000, currentTime = 0 } = {}) {
    this.sampleRate = sampleRate;
    this.currentTime = currentTime;
    this.frame = Math.round(currentTime * sampleRate);
    this.nodes = [];
    this.processors = new Set(['fx-chain', 'ks-processor', 'safety-limiter']);
    this.destination = new GainNode(this);
    this.waves = [];
  }
  createPeriodicWave(real, imag, opts) {
    const w = { real: Float32Array.from(real), imag: Float32Array.from(imag), opts };
    this.waves.push(w);
    return w;
  }
  /** Advances context time by `s` seconds. */
  advance(s) {
    this.currentTime += s;
    this.frame = Math.round(this.currentTime * this.sampleRate);
  }
  of(Type) { return this.nodes.filter((n) => n instanceof Type); }
}

/** A master bus shaped like buildMasterBus's result, without the safety worklet. */
export function fakeBus(ctx, { fx = true } = {}) {
  const mixBus = new GainNode(ctx);
  const masterGain = new GainNode(ctx, { gain: 0 });
  const safetyOut = new GainNode(ctx);
  mixBus.connect(masterGain);
  masterGain.connect(safetyOut);
  return { mixBus, masterGain, safetyOut, worklets: { safety: true, ks: true, fx, recorder: false }, setHandler() {} };
}

/** Installs the fake node classes as globals; returns restore(). */
export function installWebAudio() {
  const classes = { GainNode, OscillatorNode, ConstantSourceNode, BiquadFilterNode, StereoPannerNode, AnalyserNode, AudioWorkletNode, AudioBufferSourceNode, AudioBuffer };
  const saved = {};
  for (const n of NAMES) { saved[n] = globalThis[n]; globalThis[n] = classes[n]; }
  return () => { for (const n of NAMES) { if (saved[n] === undefined) delete globalThis[n]; else globalThis[n] = saved[n]; } };
}
