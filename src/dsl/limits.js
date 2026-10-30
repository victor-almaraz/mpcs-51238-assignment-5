// Validator constants, ranges, defaults and vocabularies of the piece DSL (doc/piece-dsl.md).
// content/learn/reference.md restates the limits; the guide tests compare them with these values.

export const CURRENT_IR_VERSION = 1;

export const LIMITS = Object.freeze({
  instruments: 16,
  bindings: 64,
  voicesPerBinding: 16,
  voicesPerBindingGranular: 4,
  slotsPerChain: 8,
  reverbs: 4,
  lfos: 16,
  retriggerLfosPerInstrument: 2,
  routes: 32,
  routesPerTarget: 4,
  layers: 16,
  orbitSources: 64,
  exprDepth: 32,
  irBytes: 256 * 1024,
  sourceChars: 200_000,
  timeoutMs: 1500,
});

/** Inclusive [min, max] ranges. The builder clamps into them; the validator rejects values outside. */
export const RANGES = Object.freeze({
  tempo: [20, 300],
  lfoRate: [0.01, 20],
  lfoPhase: [0, 1],
  lfoSmooth: [0, 1],
  depth: [-1, 1],
  smoothMs: [0, 60_000],
  maxPerSecond: [0.1, 20],
  durationMs: [20, 10_000],
  timeScale: [1, 1000],
  velocity: [1, 127],
  pitch: [0, 127],
  pan: [-1, 1],
  detuneCents: [-100, 100],
  desaturate: [0, 1],
  spectrumBands: [4, 32],
  volumeDb: [-60, 0],
  octave: [-3, 3],
  cents: [-100, 100],
});

export const DEFAULTS = Object.freeze({
  seed: 1,
  tempo: 120,
  root: 'C',
  mode: 'chromatic',
  volumeDb: -6,
  octave: 0,
  cents: 0,
  velocity: 64,
  pan: 0,
  durationMs: 250,
  maxPerSecond: 2,
  smoothMs: 250,
  orbitSmoothMs: 500,
  lfoShape: 'sine',
  lfoRate: 0.1,
  lfoPhase: 0,
  timeScale: 1,
  projection: 'orbital',
  background: '#000000',
  selectOrder: 'desc',
});

export const SCALE_MODES = Object.freeze(['major', 'minor', 'dorian', 'phrygian', 'lydian', 'mixolydian', 'locrian', 'pentatonic', 'chromatic']);
export const NOTE_ROOT = /^[A-G](#|b)?$/;
export const ORBIT_QUANTITIES = Object.freeze(['latitude', 'phaseSin', 'phaseCos', 'altitude', 'longitude', 'sunlit', 'elevation']);
export const LFO_SHAPES = Object.freeze(['sine', 'triangle', 'square', 'saw', 'random', 'smooth']);
export const PROJECTIONS = Object.freeze(['orbital', 'map', 'sky']);
export const EVENT_KINDS = Object.freeze(['enter', 'update', 'exit']);
export const CURVES = Object.freeze(['lin', 'log', 'exp']);
export const REACTION_KINDS = Object.freeze(['stale', 'down']);
export const COLOR_HEX = /^#[0-9a-fA-F]{6}$/;
/** Name the sandbox gives the script, so stack frames identify script lines. */
export const SCRIPT_URL = 'piece.ts';
