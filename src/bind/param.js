// `param` bindings (doc/bindings.md, Parameters and Effect parameters).
//
// IR kinds (src/dsl/ir.schema.json):
// - `param` { inst, param, expr, smoothMs }: calls `engine.get(inst).setParam`.
// - `fxParam` { slot, param, expr, smoothMs }: calls `engine.setFxParam(slot, param, value)`.
//   Enum parameters (by the injected `fxParamDef`) receive the rounded option index, unsmoothed.
// - `fxBypass` { slot, expr }: calls `engine.setFxBypass(slot, on)` when the boolean changes.
// A `param` binding whose `inst` is a slot id is treated as `fxParam` (or `fxBypass` when
// `param` is `bypass`).

import { evaluate } from '../expr/evaluate.js';
import { collectDeps } from '../expr/deps.js';
import { LIMITS } from './limits.js';
import { numberOr } from './values.js';

/**
 * One-pole smoother with time constant `smoothMs / 3`: 95% of a step after `smoothMs`. It snaps
 * to the target once within 0.1% of the step, about 2.3 × `smoothMs` after the step.
 * @param {number} smoothMs
 */
export function createSmoother(smoothMs) {
  const tau = smoothMs / 3;
  return {
    /** @type {number | null} */ value: null,
    /** @type {number | null} */ target: null,
    moving: false,
    lastMs: 0,
    tol: 0,
    /** @param {number} target @param {number} nowMs @param {number | null} initial */
    set(target, nowMs, initial) {
      if (this.value === null) this.value = initial ?? target;
      if (!this.moving) this.lastMs = nowMs;
      this.target = target;
      this.tol = Math.max(1e-3 * Math.abs(target - this.value), 1e-9 * Math.max(1, Math.abs(target)));
      this.moving = true;
    },
    /** Advances to `nowMs`; returns true when settled at the target. */
    step(nowMs) {
      if (!this.moving || this.target === null || this.value === null) return false;
      const dt = Math.max(0, nowMs - this.lastMs);
      this.lastMs = nowMs;
      const a = tau > 0 ? 1 - Math.exp(-dt / tau) : 1;
      this.value += (this.target - this.value) * a;
      if (Math.abs(this.target - this.value) <= this.tol) {
        this.value = this.target;
        this.moving = false;
        return true;
      }
      return false;
    },
  };
}

/**
 * @param {any} b IR param binding
 * @param {import('./runtime.js').BindingEnv} env
 */
export function createParamBinding(b, env) {
  const ctx = env.ctxFor(b.id);
  const component = `bind.${b.id}`;
  const deps = collectDeps(b.expr);
  const targetId = b.slot ?? b.inst;
  const param = b.kind === 'fxBypass' ? 'bypass' : b.param;
  const slotInfo = env.slot(targetId);
  const instIr = slotInfo ? null : env.instrument(targetId);
  if (!slotInfo && !instIr) throw new Error(`Binding ${b.id}: ${targetId} is neither an instrument nor an effect slot`);
  if (b.kind !== 'param' && !slotInfo) throw new Error(`Binding ${b.id}: effect slot ${targetId} is not in the IR`);
  const kind = slotInfo ? (param === 'bypass' ? 'bypass' : 'fx') : 'inst';
  const def = kind === 'fx' && env.fxParamDef ? env.fxParamDef(slotInfo.slot.type, param) : null;
  const enumOptions = def && (def.scale === 'enum' || Array.isArray(def.options)) ? (def.options ?? []) : null;
  const smoother = createSmoother(numberOr(b.smoothMs, LIMITS.defaultSmoothMs));

  let requested = /** @type {number | null} */ (null);
  let traceId = /** @type {string | null} */ (null);
  let startPending = false;
  /** Last bypass state (from the slot's IR value) or enum index sent. @type {boolean | number | null} */
  let lastDiscrete = kind === 'bypass' ? !!slotInfo.slot.bypass : null;

  const initial = () => {
    if (kind === 'inst') {
      const i = env.engine.get(targetId);
      const v = i ? i.getParams()[param] : undefined;
      return typeof v === 'number' && Number.isFinite(v) ? v : null;
    }
    const v = slotInfo.slot.params ? slotInfo.slot.params[param] : undefined;
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  };

  /** Sends one value; returns the applied value. */
  const send = (value) => {
    if (kind === 'inst') {
      const i = env.engine.get(targetId);
      if (!i) throw new Error(`Instrument ${targetId} not found in the engine`);
      i.setParam(param, value);
      const applied = i.getParams()[param];
      return typeof applied === 'number' ? applied : null;
    }
    env.engine.setFxParam(slotInfo.slot.id, param, value);
    return value;
  };
  const record = (phase, sent, applied) => {
    const data = kind === 'inst'
      ? { inst: targetId, param: param, requested, sent, applied, phase }
      : { slot: slotInfo.slot.id, owner: slotInfo.owner, param: param, requested, sent, applied, phase };
    env.emit('AUDIO', component, kind === 'inst' ? 'setParam' : 'setFxParam', data, { traceId });
  };

  function evaluateNow(tid) {
    const v = evaluate(b.expr, null, ctx);
    if (kind === 'bypass') {
      if (typeof v !== 'boolean' || v === lastDiscrete) return;
      lastDiscrete = v;
      env.engine.setFxBypass(slotInfo.slot.id, v);
      env.emit('AUDIO', component, 'setFxBypass', { slot: slotInfo.slot.id, owner: slotInfo.owner, on: v }, { traceId: tid });
      return;
    }
    if (typeof v !== 'number') return; // null keeps the last value
    if (enumOptions) {
      const idx = Math.min(Math.max(Math.round(v), 0), Math.max(0, enumOptions.length - 1));
      if (idx === lastDiscrete) return;
      lastDiscrete = idx;
      requested = v; traceId = tid;
      record('set', idx, send(idx));
      return;
    }
    if (v === smoother.target && (smoother.moving || smoother.value === v)) return;
    requested = v;
    traceId = tid;
    startPending = true;
    smoother.set(v, env.now(), initial());
  }

  return {
    id: b.id,
    kind: 'param',
    binding: b,
    inst: targetId,
    param,
    target: kind,
    groups: deps.groups,
    usesOrbit: deps.orbit,
    init() { evaluateNow(null); },
    onEvent(e) { evaluateNow(e.traceId); },
    onOrbit() { evaluateNow(null); },
    /** 30 Hz update: sends the smoothed value while the smoother moves. */
    tick(nowMs) {
      if (!smoother.moving) return;
      const settled = smoother.step(nowMs);
      const sent = /** @type {number} */ (smoother.value);
      const applied = send(sent);
      if (startPending) { record('start', sent, applied); startPending = false; }
      if (settled) record('settled', sent, applied);
    },
    release() {},
    voiceTag() { return null; },
    snapshot() { return []; },
    /** Current smoothed value of an instrument parameter, or null. */
    currentValue() { return kind === 'inst' ? smoother.value : null; },
  };
}
