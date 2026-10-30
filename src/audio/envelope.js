// Click-free envelope helpers (audio-engine-core.md). `.value` is never set while audio runs.
//
// A voice carries a model of its envelope so the value at any time can be computed without
// reading AudioParam.value (which lags automation and cannot see the future):
//   start, attack, peak          linear attack to the peak
//   sustain, decayTau            then exponential decay towards sustain × peak (sustain 1 or
//                                absent: the peak is held, the plain AR shape)
//   offTime, relFrom, tau        exponential release from relFrom starting at offTime

export const MIN_ATTACK = 0.002;
export const MIN_RELEASE = 0.01;
export const FAST_TAU = 0.0033;     // allNotesOff: ~10 ms fast release
export const STEAL_TAU = 0.0015;    // stolen voice: 5 ms fade

/**
 * cancelAndHoldAtTime when available (not in Firefox), else cancel + set from the model.
 * The fallback's cancel also removes a linear ramp that ends after `t` (an attack still in
 * progress at `t`); with `inRamp` it re-creates that ramp up to `t` instead of holding the
 * earlier value and jumping at `t`.
 */
export function holdAt(param, t, valueAtT, inRamp = false) {
  if (typeof param.cancelAndHoldAtTime === 'function') param.cancelAndHoldAtTime(t);
  else {
    param.cancelScheduledValues(t);
    if (inRamp) param.linearRampToValueAtTime(valueAtT, t);
    else param.setValueAtTime(valueAtT, t);
  }
}

function heldValue(v, t) {
  if (t <= v.start) return 0;
  const x = (t - v.start) / v.attack;
  if (x < 1) return x * v.peak;
  const s = v.sustain ?? 1;
  if (s >= 1) return v.peak;
  const level = s * v.peak;
  return level + (v.peak - level) * Math.exp(-(t - v.start - v.attack) / v.decayTau);
}

export function envValueAt(v, t) {
  if (!(t > v.offTime)) return heldValue(v, t);
  return v.relFrom * Math.exp(-(t - v.offTime) / v.tau);
}

export function scheduleAttack(param, v) {
  param.setValueAtTime(0, v.start);
  param.linearRampToValueAtTime(v.peak, v.start + v.attack);
  const s = v.sustain ?? 1;
  if (s < 1) param.setTargetAtTime(s * v.peak, v.start + v.attack, v.decayTau);
}

/** Starts an exponential release on `param` at `t` with time constant `tau`; updates the model. */
export function scheduleRelease(param, v, t, tau) {
  const from = envValueAt(v, t);
  holdAt(param, t, from, t > v.start && t < v.start + v.attack);
  param.setTargetAtTime(0, t, tau);
  v.offTime = t;
  v.relFrom = from;
  v.tau = tau;
}
