// The normalized modulation model (modulation.md, Model) and the conversions of the native
// audio-rate path (modulation.md, Synth targets). Pure functions over ParamDefs; they accept
// effect ParamDefs (src/audio/fx/core/params.js) and synth PARAM_DEFS entries alike.

import { fromNorm, toNorm } from '../fx/core/params.js';

export const MOD_LIMITS = Object.freeze({
  lfos: 16,
  retriggerPerInstrument: 2,
  routes: 32,
  routesPerTarget: 4,
  depth: 1,
  dataPostsPerSecond: 30,
});

const clamp01 = (u) => (u < 0 ? 0 : u > 1 ? 1 : u);

/** Modulated value for base `base` and the sum Σ depthᵢ · sourceᵢ. */
export function modulate(def, base, sum) {
  return fromNorm(def, clamp01(toNorm(def, base) + sum));
}

/** Modulated value of a `down` parameter for Σ |depthᵢ| · (sourceᵢ + 1) / 2 ≥ 0. */
export function modulateDown(def, base, sumDown) {
  const u0 = toNorm(def, base);
  const u = u0 - sumDown;
  return fromNorm(def, u < 0 ? 0 : u > u0 ? u0 : u);
}

/**
 * Applies routes [{ depth, value }] (value = source output in −1..1) to `base`.
 * @param {any} def @param {number} base @param {{ depth: number, value: number }[]} routes @param {boolean} down
 */
export function modulatedValue(def, base, routes, down = false) {
  let sum = 0;
  for (const r of routes) {
    const s = r.value < -1 ? -1 : r.value > 1 ? 1 : r.value;
    sum += down ? Math.abs(r.depth) * ((s + 1) / 2) : r.depth * s;
  }
  return down ? modulateDown(def, base, sum) : modulate(def, base, sum);
}

/** Native-unit gain for normalized depth `depth`: cents for log params, units for lin params. */
export function nativeGain(def, depth) {
  if (def.scale === 'log') return depth * Math.log2(def.max / def.min) * 1200;
  return depth * (def.max - def.min);
}

/**
 * Scale applied to every depth of one target on the native path, so toNorm(base) ± Σ|depthᵢ|
 * stays within 0–1: min(1, h / S) with h = min(u₀, 1 − toNorm(peak)), S = Σ|depthᵢ|. `peak` is the
 * highest value the instrument itself drives the parameter to (an envelope), at least `base`.
 */
export function depthScale(def, base, depths, peak = base) {
  let S = 0;
  for (const d of depths) S += Math.abs(d);
  if (S === 0) return 1;
  const u0 = toNorm(def, base);
  const h = Math.min(u0, 1 - Math.max(u0, toNorm(def, peak)));
  return h >= S ? 1 : Math.max(0, h) / S;
}

/** Limited native gains, one per depth (modulation.md, Synth targets, audio rate). */
export function limitedGains(def, base, depths) {
  const k = depthScale(def, base, depths);
  return depths.map((d) => nativeGain(def, d * k));
}

/**
 * Range of a per-voice offset (normalized units) on a target whose routes already use `used`
 * of the headroom: the voice's value with every route at full depth stays within 0–1, with the
 * upper headroom measured from `peak` (depthScale).
 */
export function voiceOffsetRange(def, base, used, peak = base) {
  const u0 = toNorm(def, base);
  const top = Math.max(u0, toNorm(def, peak));
  return [Math.min(0, used - u0), Math.max(0, 1 - top - used)];
}

/** Modulation path of a synth ParamDef: 'audio', 'control' or null (modulation.md, Synth targets). */
export function synthModPath(def) {
  if (!def || def.kind === 'enum' || def.kind === 'array' || Array.isArray(def.default) || def.options) return null;
  const mod = def.mod;
  if (!mod || typeof mod !== 'object') return null;
  if (mod.rate === 'audio' && typeof mod.target === 'string' && (def.scale === 'lin' || def.scale === 'log') && mod.dir !== 'down') return 'audio';
  return 'control';
}

/** True when a synth def lowers only. */
export function synthModDown(def) {
  return !!(def && def.mod && def.mod.dir === 'down');
}

/** True when an effect ParamDef is a route target: not enum, not `mod: null` (effects.md). */
export function effectModulatable(def) {
  return !!def && def.scale !== 'enum' && def.mod !== null;
}

/** True when an effect ParamDef lowers only. */
export function effectModDown(def) {
  return !!(def && def.mod && def.mod.dir === 'down');
}
