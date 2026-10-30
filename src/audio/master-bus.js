// Output stage (audio-safety.md):
//   mixBus → masterGain → safety-limiter worklet (or fallback) → destination
//   safetyOut → meter (post-limiter), masterGain → preMeter (limiting indicator)
// Meters exist only in realtime contexts, never in offline renders.

import { loadWorklets } from './worklet-loader.js';
import { TrackedParam } from './smoothing.js';

export const SAFETY = Object.freeze({
  ceilingDb: -1,
  lookaheadMs: 1.5,
  releaseMs: 100,
  dcHz: 10,
  defaultMaster: 0.25,     // −12 dB
  maxMaster: 1.0,          // 0 dB
  fallbackMaxMaster: 0.5,  // −6 dB while the fallback stage is active
});

export const MASTER_FADE_IN = 0.05;   // 50 ms linear (project limit)

/** Compressor with cancelled makeup gain → hard clip at the ceiling (no worklet available). */
export function buildFallback(ctx) {
  const T = -6, ratio = 20;                                    // (project limit)
  const comp = new DynamicsCompressorNode(ctx, { threshold: T, knee: 0, ratio, attack: 0.001, release: 0.1 });
  const makeupDb = 0.6 * -(T - T / ratio);                     // ≈ 3.42 dB
  const trim = new GainNode(ctx, { gain: Math.pow(10, -makeupDb / 20) });
  const c = Math.pow(10, SAFETY.ceilingDb / 20);
  const N = 4097, curve = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const x = (i / (N - 1)) * 2 - 1;
    curve[i] = x > c ? c : x < -c ? -c : x;
  }
  const clip = new WaveShaperNode(ctx, { curve, oversample: 'none' });
  comp.connect(trim).connect(clip);
  return { input: comp, output: clip };
}

function finiteOr(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

export async function buildMasterBus(ctx, { realtime = true, masterGain: masterTarget = SAFETY.defaultMaster } = {}) {
  const mixBus = new GainNode(ctx, { gain: 1 });
  const masterGain = new GainNode(ctx, { gain: 0 });          // fades in on start
  const master = new TrackedParam(masterGain.gain, 0);
  const worklets = await loadWorklets(ctx);

  let handler = null;
  const pending = [];
  const emit = (msg) => {
    if (handler) handler(msg);
    else if (pending.length < 8) pending.push(msg);
  };

  let safetyNode = null;
  let safetyIn;
  let safetyOut;
  if (worklets.safety) {
    try {
      safetyNode = new AudioWorkletNode(ctx, 'safety-limiter', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
        channelCount: 2, channelCountMode: 'explicit',
        processorOptions: { ...SAFETY },
      });
    } catch {
      safetyNode = null;
    }
  }
  if (safetyNode) {
    safetyNode.port.onmessage = (e) => {
      const d = e.data;
      if (d && (d.type === 'fault' || d.type === 'duck')) emit({ type: d.type });
    };
    safetyNode.onprocessorerror = () => emit({ type: 'error' });   // node is now permanently silent
    safetyIn = safetyOut = safetyNode;
  } else {
    ({ input: safetyIn, output: safetyOut } = buildFallback(ctx));
  }
  const reduced = safetyNode === null;
  const maxMaster = reduced ? SAFETY.fallbackMaxMaster : SAFETY.maxMaster;

  mixBus.connect(masterGain);
  masterGain.connect(safetyIn);
  safetyOut.connect(ctx.destination);

  let meter = null, preMeter = null;
  if (realtime) {
    meter = new AnalyserNode(ctx, { fftSize: 2048 });
    preMeter = new AnalyserNode(ctx, { fftSize: 2048 });
    safetyOut.connect(meter);
    masterGain.connect(preMeter);
  }

  const bus = {
    mixBus,
    masterGain,
    master,
    safetyOut,
    safetyNode,
    reduced,
    worklets,
    maxMaster,
    meter,
    preMeter,
    setHandler(fn) {
      handler = typeof fn === 'function' ? fn : null;
      if (handler) while (pending.length > 0) handler(pending.shift());
    },
    ack() {
      if (safetyNode) safetyNode.port.postMessage({ type: 'ack' });
    },
    /** masterGain from 0 to min(target, maxMaster) over 50 ms, starting now. */
    fadeIn(target) {
      const now = ctx.currentTime;
      const g = Math.min(Math.max(0, finiteOr(target, 0)), maxMaster);
      master.setAt(0, now);
      master.linearTo(g, now, MASTER_FADE_IN);
    },
  };

  if (!realtime) bus.fadeIn(masterTarget);
  return bus;
}
