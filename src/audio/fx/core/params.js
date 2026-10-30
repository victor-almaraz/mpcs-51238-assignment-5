/*
 * Parameter definitions (a3-audio-implementation.md, Real-time rules 7).
 * Every parameter value on either thread passes through clampParam. Plain
 * values are numbers; an enum value is the index of its option.
 *
 * ParamDef: {
 *   id: string,
 *   min: number, max: number, default: number,  // plain units
 *   unit: string,                               // 'Hz', 's', 'dB', '' …
 *   scale: 'lin' | 'log' | 'pow3' | 'enum',     // slider mapping
 *   options?: string[],                         // enum option names
 *   step?: number,                              // plain-unit step, snapped from min
 *   smoothMs?: number,                          // smoothing τ override, in ms
 * }
 */

const SCALES = ['lin', 'log', 'pow3', 'enum'];

/**
 * Validates and freezes a ParamDef. Enum defs take min 0 and max options.length − 1.
 * Throws on an inconsistent definition, so mistakes fail at module load.
 */
export function defineParam(def) {
  const d = { ...def };
  if (typeof d.id !== 'string' || d.id === '') throw new Error('ParamDef needs an id');
  if (!SCALES.includes(d.scale)) throw new Error(`ParamDef ${d.id}: unknown scale ${d.scale}`);
  if (d.scale === 'enum') {
    if (!Array.isArray(d.options) || d.options.length < 2) throw new Error(`ParamDef ${d.id}: enum needs options`);
    d.min = 0;
    d.max = d.options.length - 1;
    d.step = 1;
    d.options = Object.freeze([...d.options]);
  }
  d.unit ??= '';
  if (!(Number.isFinite(d.min) && Number.isFinite(d.max) && d.min < d.max)) {
    throw new Error(`ParamDef ${d.id}: needs finite min < max`);
  }
  if (d.scale === 'log' && d.min <= 0) throw new Error(`ParamDef ${d.id}: log scale needs min > 0`);
  if (d.step !== undefined && !(d.step > 0)) throw new Error(`ParamDef ${d.id}: step must be > 0`);
  if (!(d.default >= d.min && d.default <= d.max)) throw new Error(`ParamDef ${d.id}: default outside range`);
  return Object.freeze(d);
}

/**
 * Returns `value` as a valid plain value for `def`: non-finite values give the
 * default, values outside [min, max] are clamped, and stepped params snap to
 * the nearest step from min.
 */
export function clampParam(def, value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return def.default;
  let v = value < def.min ? def.min : value > def.max ? def.max : value;
  if (def.step !== undefined) {
    v = def.min + Math.round((v - def.min) / def.step) * def.step;
    if (v > def.max) v -= def.step;
    v = Math.round(v * 1e9) / 1e9;
  }
  return v;
}

/** Maps a slider position u ∈ [0, 1] to a plain value of `def`. */
export function fromNorm(def, u) {
  const x = u < 0 ? 0 : u > 1 ? 1 : u;
  let v;
  if (def.scale === 'log') v = def.min * (def.max / def.min) ** x;
  else if (def.scale === 'pow3') v = def.min + (def.max - def.min) * x * x * x;
  else v = def.min + (def.max - def.min) * x;
  return clampParam(def, v);
}

/** Maps a plain value of `def` to a slider position in [0, 1]. */
export function toNorm(def, value) {
  const v = clampParam(def, value);
  const span = def.max - def.min;
  if (def.scale === 'log') return Math.log(v / def.min) / Math.log(def.max / def.min);
  if (def.scale === 'pow3') return Math.cbrt((v - def.min) / span);
  return (v - def.min) / span;
}

/** Returns { [id]: default } for a list of defs. */
export function paramDefaults(defs) {
  const out = {};
  for (const def of defs) out[def.id] = def.default;
  return out;
}

/**
 * Returns a complete, valid parameter object for `defs` from stored `values`:
 * every def gets a clamped value or its default; unknown keys are dropped.
 */
export function clampParams(defs, values) {
  const out = {};
  for (const def of defs) out[def.id] = clampParam(def, values?.[def.id]);
  return out;
}
