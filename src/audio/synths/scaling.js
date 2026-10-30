// Maps a normalised slider position u ∈ [0, 1] to natural units and back (synthesis-conventions.md).

export const NORM_STEPS = 1000;

export function fromNorm(def, u) {
  const x = u < 0 ? 0 : u > 1 ? 1 : u;
  if (def.scale === 'log') return def.min * Math.pow(def.max / def.min, x);
  if (def.scale === 'pow3') return def.min + (def.max - def.min) * x * x * x;
  return def.min + (def.max - def.min) * x;
}

export function toNorm(def, v) {
  const span = def.max - def.min;
  if (span <= 0) return 0;
  let u;
  if (def.scale === 'log') u = Math.log(v / def.min) / Math.log(def.max / def.min);
  else if (def.scale === 'pow3') u = Math.cbrt((v - def.min) / span);
  else u = (v - def.min) / span;
  return Number.isFinite(u) ? Math.min(1, Math.max(0, u)) : 0;
}

/** True when the slider should work in natural units with the def's own step. */
export function usesNativeSteps(def) {
  return def.scale === 'lin' && typeof def.step === 'number';
}
