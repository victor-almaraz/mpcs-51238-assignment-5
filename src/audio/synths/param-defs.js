// PARAM_DEFS is the single source for parameter names, ranges and defaults. It drives the
// UI, setParam clamping and patch validation (synthesis-conventions.md, patch-format.md).
//
// kind: 'number' | 'enum' | 'array'
// scale: 'lin' | 'log' | 'pow3' | 'radio'
// unit: 'Hz' | 's' | 'dB' | 'ratio' | 'offset' | 'index' | 'per-s' | 'fraction' | 'oct' | 'cents'
//       | 'oct-shift' | 'cent-shift' (signed tuning) | ''
//
// Modulation and shaping params default to their neutral value, so a patch that omits them
// plays the plain sound of its synth type (synthesis-conventions.md, patch-format.md).

export const SYNTH_TYPES = ['subtractive', 'fm', 'additive', 'pluck', 'granular'];

export const SYNTH_INFO = {
  subtractive: { label: 'Subtractive', description: 'Oscillator through a resonant lowpass' },
  fm: { label: 'FM', description: 'Two-operator frequency modulation' },
  additive: { label: 'Additive', description: 'Eight sine harmonics' },
  pluck: { label: 'Pluck', description: 'Plucked string (Karplus-Strong)' },
  granular: { label: 'Granular', description: 'Clouds of short grains' },
};

const attack = (def) => ({ name: 'attack', label: 'Attack', unit: 's', kind: 'number', min: 0.002, max: 2, default: def, scale: 'pow3' });
const release = (def) => ({ name: 'release', label: 'Release', unit: 's', kind: 'number', min: 0.01, max: 4, default: def, scale: 'pow3' });
// ADSR decay and sustain (audio-engine-core.md "Envelopes"). Sustain 1 is the plain AR shape.
const decay = (def) => ({ name: 'decay', label: 'Decay', unit: 's', kind: 'number', min: 0.01, max: 4, default: def, scale: 'pow3' });
const sustain = () => ({ name: 'sustain', label: 'Sustain', unit: 'fraction', kind: 'number', min: 0, max: 1, default: 1, scale: 'lin', step: 0.01 });

export const PARAM_DEFS = {
  subtractive: [
    { name: 'waveform', label: 'Waveform', unit: '', kind: 'enum', scale: 'radio',
      options: ['sine', 'sawtooth', 'square', 'triangle'], optionLabels: ['Sine', 'Saw', 'Square', 'Tri'], default: 'sawtooth' },
    { name: 'cutoff', label: 'Cutoff', unit: 'Hz', kind: 'number', min: 40, max: 16000, default: 2000, scale: 'log' },
    { name: 'resonance', label: 'Resonance', unit: 'dB', kind: 'number', min: 0, max: 20, default: 1, scale: 'lin' },
    { name: 'envAmount', label: 'Filter env', unit: 'oct', kind: 'number', min: 0, max: 6, default: 0, scale: 'lin', step: 0.1 },
    attack(0.01),
    decay(0.3),
    sustain(),
    release(0.3),
  ],
  fm: [
    { name: 'ratio', label: 'Ratio', unit: 'ratio', kind: 'number', min: 0.5, max: 12, default: 2, scale: 'lin', step: 0.5 },
    { name: 'fine', label: 'Fine', unit: 'offset', kind: 'number', min: -0.5, max: 0.5, default: 0, scale: 'lin', step: 0.01 },
    { name: 'index', label: 'Index', unit: 'index', kind: 'number', min: 0, max: 20, default: 3, scale: 'lin', step: 0.1 },
    { name: 'indexDecay', label: 'Index decay', unit: 's', kind: 'number', min: 0.01, max: 4, default: 0.5, scale: 'pow3' },
    attack(0.005),
    decay(0.5),
    sustain(),
    release(0.4),
  ],
  additive: [
    { name: 'harmonics', label: 'Harmonics', unit: 'fraction', kind: 'array', length: 8, min: 0, max: 1, step: 0.01,
      default: [1, 0.5, 0.33, 0.25, 0.2, 0.17, 0.14, 0.12], scale: 'lin' },
    attack(0.02),
    decay(0.5),
    sustain(),
    release(0.5),
    { name: 'vibratoRate', label: 'Vibrato rate', unit: 'Hz', kind: 'number', min: 0.5, max: 12, default: 5, scale: 'log' },
    { name: 'vibratoDepth', label: 'Vibrato', unit: 'cents', kind: 'number', min: 0, max: 100, default: 0, scale: 'lin', step: 1 },
  ],
  pluck: [
    { name: 'damping', label: 'Damping', unit: 'fraction', kind: 'number', min: 0, max: 1, default: 0.5, scale: 'lin', step: 0.01 },
    { name: 'brightness', label: 'Brightness', unit: 'fraction', kind: 'number', min: 0, max: 1, default: 0.7, scale: 'lin', step: 0.01 },
    // Fraction of the string length from the bridge; 0 plucks at the bridge (no comb).
    { name: 'pickPosition', label: 'Pick position', unit: 'fraction', kind: 'number', min: 0, max: 0.5, default: 0, scale: 'lin', step: 0.01 },
    { name: 'decay', label: 'Decay', unit: 's', kind: 'number', min: 0.2, max: 10, default: 2, scale: 'pow3' },
    // T60 after note-off (string muting); never longer than the decay.
    { name: 'release', label: 'Release', unit: 's', kind: 'number', min: 0.02, max: 2, default: 0.1, scale: 'pow3' },
  ],
  granular: [
    { name: 'source', label: 'Source', unit: '', kind: 'enum', scale: 'radio',
      options: ['saw', 'noise', 'chord', 'sample'], optionLabels: ['Saw', 'Noise', 'Chord', 'File'], default: 'saw' },
    { name: 'position', label: 'Position', unit: 'fraction', kind: 'number', min: 0, max: 1, default: 0.5, scale: 'lin', step: 0.01 },
    { name: 'grainSize', label: 'Grain size', unit: 's', kind: 'number', min: 0.01, max: 0.25, default: 0.06, scale: 'log' },
    { name: 'density', label: 'Density', unit: 'per-s', kind: 'number', min: 2, max: 60, default: 20, scale: 'log' },
    { name: 'spray', label: 'Spray', unit: 'fraction', kind: 'number', min: 0, max: 1, default: 0.2, scale: 'lin', step: 0.01 },
    { name: 'pitchSpread', label: 'Pitch spread', unit: 'cents', kind: 'number', min: 0, max: 1200, default: 0, scale: 'lin', step: 1 },
    attack(0.05),
    release(0.4),
  ],
};

/**
 * Per-widget tuning, shown in the widget footer beside the volume (every synth type). The
 * shift applies to notes that start after a change; the shifted pitch is clamped to MIDI
 * 0–127 (instrument.js).
 */
export const TUNING_DEFS = [
  { name: 'octave', label: 'Octave', unit: 'oct-shift', kind: 'number', min: -3, max: 3, default: 0, scale: 'lin', step: 1 },
  { name: 'cents', label: 'Cents', unit: 'cent-shift', kind: 'number', min: -100, max: 100, default: 0, scale: 'lin', step: 1 },
];

/** Semitones of pitch shift for a widget's tuning fields. */
export function tuningSemitones(w) {
  return 12 * (w.octave || 0) + (w.cents || 0) / 100;
}

/** Widget and master volume: −60 … 0 dB in 0.5 dB steps, plus Off (audio-safety.md). */
export const VOLUME = { min: -60, max: 0, step: 0.5, widgetDefault: -6, masterDefault: -12 };
export const VOLUME_OFF = -Infinity;

export function dbToGain(db) {
  return db === VOLUME_OFF || !Number.isFinite(db) ? 0 : Math.pow(10, db / 20);
}

/** Clamps a volume to the taper; non-numbers become `fallback`. "off" and −Infinity mean Off. */
export function coerceVolume(v, fallback, maxDb = VOLUME.max) {
  if (v === 'off' || v === VOLUME_OFF) return VOLUME_OFF;
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  const c = Math.min(maxDb, Math.max(VOLUME.min, v));
  return Math.round(c / VOLUME.step) * VOLUME.step + 0;   // + 0 turns −0 into 0
}

export function getDef(type, name) {
  const defs = PARAM_DEFS[type];
  return defs ? defs.find((d) => d.name === name) || null : null;
}

export function defaultParams(type) {
  const out = {};
  for (const d of PARAM_DEFS[type]) out[d.name] = Array.isArray(d.default) ? d.default.slice() : d.default;
  return out;
}

function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

/**
 * Validates one value against its definition. Non-numbers, NaN and ±Infinity become the
 * default; numbers are clamped (and snapped to `step` when one is given); enums fall back to
 * the default; arrays are padded or truncated to `length` finite values in [min, max].
 */
export function coerceParam(def, v) {
  if (def.kind === 'enum') return def.options.includes(v) ? v : def.default;
  if (def.kind === 'array') {
    const src = Array.isArray(v) ? v : [];
    const out = [];
    for (let i = 0; i < def.length; i++) {
      const x = src[i];
      out.push(typeof x === 'number' && Number.isFinite(x) ? clamp(x, def.min, def.max) : (src.length ? 0 : def.default[i]));
    }
    return out;
  }
  if (typeof v !== 'number' || !Number.isFinite(v)) return def.default;
  let x = clamp(v, def.min, def.max);
  if (def.step) x = clamp(Number((def.min + Math.round((x - def.min) / def.step) * def.step).toFixed(6)), def.min, def.max);
  return x;
}

export function mtof(pitch) {
  return 440 * Math.pow(2, (pitch - 69) / 12);
}

export function velocityGain(vel) {
  const v = clamp(vel, 1, 127);
  return 0.3 * (v / 127) * (v / 127);
}
