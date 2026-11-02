// `voices` bindings (doc/bindings.md, Sustained voices).

import { evaluate } from '../expr/evaluate.js';
import { collectDeps } from '../expr/deps.js';
import { selectObjects } from './select.js';
import { LIMITS, voiceCap } from './limits.js';
import { pitchOf, velocityOf, panOf, voiceModOf } from './values.js';

/**
 * @typedef {object} Voice
 * @property {any} obj              latest version of the object
 * @property {string} tag           `sky:<bindingId>:<objectId>`
 * @property {boolean} sounding
 * @property {number} startedPitch  pitch passed to noteOn; used for noteOff
 * @property {number} pitch         current pitch after glides
 * @property {number} startTime     context time of noteOn
 */

/**
 * @param {any} b IR voices binding
 * @param {import('./runtime.js').BindingEnv} env
 */
export function createVoicesBinding(b, env) {
  const instIr = env.instrument(b.inst);
  if (!instIr) throw new Error(`Binding ${b.id}: instrument ${b.inst} is not in the IR`);
  const cap = voiceCap(instIr.type);
  const ctx = env.ctxFor(b.id);
  const component = `bind.${b.id}`;
  const voiceModExprs = Object.entries(b.voiceMods ?? {});

  const deps = collectDeps(b.pitch);
  collectDeps(b.velocity, deps);
  collectDeps(b.pan, deps);
  for (const [, e] of voiceModExprs) collectDeps(e, deps);
  const external = new Set([...deps.groups].filter((g) => g !== b.group));

  /** @type {Map<string, Voice>} objectId → voice, in order of entry */
  const voices = new Map();

  const inst = () => {
    const i = env.engine.get(b.inst);
    if (!i) throw new Error(`Instrument ${b.inst} not found in the engine`);
    return i;
  };
  const audio = (event, data, traceId, level) =>
    env.emit('AUDIO', component, event, { inst: b.inst, ...data }, { traceId, level });

  function applyPanMods(i, v, traceId, quiet) {
    if (b.pan != null && typeof i.setVoicePan === 'function') {
      const raw = evaluate(b.pan, v.obj, ctx);
      const pan = panOf(raw);
      if (pan !== null) {
        i.setVoicePan(v.tag, pan);
        if (!quiet) audio('setVoicePan', { source: v.tag, pan, panRequested: raw }, traceId);
      }
    }
    if (voiceModExprs.length && typeof i.setVoiceMod === 'function') {
      /** @type {Record<string, number>} */
      const mods = {};
      for (const [name, e] of voiceModExprs) {
        const x = voiceModOf(evaluate(e, v.obj, ctx));
        if (x !== null) mods[name] = x;
      }
      if (Object.keys(mods).length) {
        i.setVoiceMod(v.tag, mods);
        if (!quiet) audio('setVoiceMod', { source: v.tag, mods }, traceId);
      }
    }
  }

  function start(v, traceId, quiet = false) {
    const raw = evaluate(b.pitch, v.obj, ctx);
    const pitch = pitchOf(raw);
    if (pitch === null) return;
    const velocity = velocityOf(evaluate(b.velocity, v.obj, ctx));
    const i = inst();
    const t = env.audioTime();
    env.voiceLedger.beforeNoteOn(b.inst, cap, v.tag, traceId, component);
    i.noteOn(pitch, velocity, t, v.tag);
    v.sounding = true;
    v.startedPitch = pitch;
    v.pitch = pitch;
    v.startTime = t;
    env.voiceLedger.sustained(b.inst, +1);
    audio('noteOn', { pitch, pitchRequested: raw, velocity, source: v.tag, objectId: v.obj.id }, traceId);
    if (!quiet) env.emit('BIND', component, 'voiceOn', { binding: b.id, result: 'voiceOn', objectId: v.obj.id }, { traceId });
    applyPanMods(i, v, traceId, quiet);
  }

  function stop(v, traceId, quiet = false) {
    if (!v.sounding) return;
    v.sounding = false;
    env.voiceLedger.sustained(b.inst, -1);
    const t = Math.max(env.audioTime(), v.startTime + LIMITS.minNoteSeconds);
    inst().noteOff(v.startedPitch, t, v.tag);
    audio('noteOff', { pitch: v.startedPitch, source: v.tag, objectId: v.obj.id }, traceId);
    if (!quiet) env.emit('BIND', component, 'voiceOff', { binding: b.id, result: 'voiceOff', objectId: v.obj.id }, { traceId });
  }

  function refresh(v, traceId, quiet = false) {
    if (!v.sounding) { start(v, traceId, quiet); return; }
    const i = inst();
    const raw = evaluate(b.pitch, v.obj, ctx);
    const pitch = pitchOf(raw);
    if (pitch !== null && Math.abs(pitch - v.pitch) > LIMITS.pitchEpsilon) {
      if (typeof i.setVoicePitch === 'function') {
        i.setVoicePitch(v.tag, pitch, LIMITS.glideMs);
        v.pitch = pitch;
        if (!quiet) audio('setVoicePitch', { source: v.tag, pitch, pitchRequested: raw, glideMs: LIMITS.glideMs }, traceId);
      } else {
        const from = v.pitch;
        stop(v, traceId, true);
        audio('fallback', { source: v.tag, from, to: pitch, reason: 'setVoicePitch absent' }, traceId);
        start(v, traceId, true);
        return;
      }
    }
    applyPanMods(i, v, traceId, quiet);
  }

  /** Recomputes the selected set; `e` is the event that caused it, or null at start. */
  function reselect(e) {
    const traceId = e ? e.traceId : null;
    let live = env.sky.get(b.group);
    if (e) {
      live = live.filter((o) => o.id !== e.obj.id);
      if (e.type !== 'exit') live.push(e.obj);
    }
    const selected = selectObjects(live, b.select ?? null, cap);
    const ids = new Set(selected.map((o) => o.id));
    for (const [id, v] of voices) {
      if (!ids.has(id)) { stop(v, traceId); voices.delete(id); }
    }
    for (const o of selected) {
      const v = voices.get(o.id);
      if (!v) {
        const nv = { obj: o, tag: `sky:${b.id}:${o.id}`, sounding: false, startedPitch: 0, pitch: 0, startTime: 0 };
        voices.set(o.id, nv);
        start(nv, traceId);
      } else {
        v.obj = o;
        if (e && e.type === 'update' && o.id === e.obj.id) refresh(v, traceId);
      }
    }
  }

  return {
    id: b.id,
    kind: 'voices',
    binding: b,
    groups: new Set([b.group, ...external]),
    usesOrbit: deps.orbit,
    init() { reselect(null); },
    onEvent(e) {
      if (e.obj.group === b.group) reselect(e);
      else if (external.has(e.obj.group)) for (const v of voices.values()) refresh(v, e.traceId);
    },
    onOrbit() {
      let n = 0;
      for (const v of voices.values()) {
        if (n++ >= LIMITS.orbitObjectsPerBinding) break;
        refresh(v, null, true);
      }
    },
    release(traceId = null) {
      for (const v of voices.values()) {
        try { stop(v, traceId, true); } catch { /* the instrument may be gone */ }
      }
      voices.clear();
    },
    /** @param {string} objectId */
    voiceTag(objectId) {
      const v = voices.get(objectId);
      return v && v.sounding ? v.tag : null;
    },
    snapshot() {
      return [...voices.values()].filter((v) => v.sounding).map((v) => ({
        binding: b.id, inst: b.inst, objectId: v.obj.id, source: v.tag,
        pitch: v.pitch, startedPitch: v.startedPitch, startTime: v.startTime, fields: { ...v.obj.fields },
      }));
    },
  };
}
