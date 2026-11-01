// `trigger` bindings (doc/bindings.md, Triggers).

import { evaluate } from '../expr/evaluate.js';
import { voiceCap } from './limits.js';
import { pitchOf, velocityOf } from './values.js';

/**
 * Token bucket: capacity `ceil(rate)`, starts full, refills `rate` tokens per second.
 * @param {number} rate tokens per second
 * @param {() => number} now milliseconds
 */
export function createTokenBucket(rate, now) {
  const capacity = Math.max(1, Math.ceil(rate));
  let tokens = capacity;
  let last = now();
  return {
    /** Takes one token if available. */
    take() {
      const t = now();
      tokens = Math.min(capacity, tokens + ((t - last) / 1000) * rate);
      last = t;
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    },
    get tokens() { return tokens; },
  };
}

/**
 * @param {any} b IR trigger binding
 * @param {import('./runtime.js').BindingEnv} env
 */
export function createTriggerBinding(b, env) {
  const instIr = env.instrument(b.inst);
  if (!instIr) throw new Error(`Binding ${b.id}: instrument ${b.inst} is not in the IR`);
  const cap = voiceCap(instIr.type);
  const ctx = env.ctxFor(b.id);
  const component = `bind.${b.id}`;
  const tag = `trig:${b.id}`;
  // Validated IR: maxPerSecond 0.1–20 and durationMs 20–10,000 are always present.
  const rate = b.maxPerSecond;
  const durationMs = b.durationMs;
  const bucket = createTokenBucket(rate, env.now);

  return {
    id: b.id,
    kind: 'trigger',
    binding: b,
    groups: new Set([b.group]),
    usesOrbit: false,
    init() {},
    onEvent(e) {
      if (e.type !== b.event || e.obj.group !== b.group) return;
      if (e.initial) return; // the store's initial snapshot of a followed group is not a sky event
      if (b.when != null && evaluate(b.when, e.obj, ctx) !== true) return;
      const raw = evaluate(b.pitch, e.obj, ctx);
      const pitch = pitchOf(raw);
      if (pitch === null) return;
      const objectId = e.obj.id;
      if (!bucket.take()) {
        env.emit('BIND', component, 'dropped', { binding: b.id, result: 'dropped', objectId, maxPerSecond: rate }, { traceId: e.traceId });
        return;
      }
      const velocity = velocityOf(evaluate(b.velocity, e.obj, ctx));
      const i = env.engine.get(b.inst);
      if (!i) throw new Error(`Instrument ${b.inst} not found in the engine`);
      const t = env.audioTime();
      const end = t + durationMs / 1000;
      env.voiceLedger.beforeNoteOn(b.inst, cap, tag, e.traceId, component);
      i.noteOn(pitch, velocity, t, tag);
      i.noteOff(pitch, end, tag);
      env.voiceLedger.trigger(b.inst, end);
      env.emit('BIND', component, 'fired', { binding: b.id, result: 'fired', objectId }, { traceId: e.traceId });
      env.emit('AUDIO', component, 'noteOn', { inst: b.inst, pitch, pitchRequested: raw, velocity, source: tag, objectId, durationMs }, { traceId: e.traceId });
    },
    onOrbit() {},
    release() {},
    voiceTag() { return null; },
    snapshot() { return []; },
  };
}
