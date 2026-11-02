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
  handlers: 64,
});

/** Program limits (doc/piece-dsl.md, Program, Errors and limits). */
export const PROGRAM = Object.freeze({
  /** Longest wait for a reply to a program message, ms. */
  batchTimeoutMs: 250,
  commandsPerBatch: 256,
  pendingTimers: 256,
  /** Timer calls the VM makes in one batch before it yields. */
  timerCallsPerBatch: 1024,
  /** A timer later than this fires once and skips its missed calls, ms. */
  lateMs: 1000,
  intervalMs: [10, 3_600_000],
  afterMs: [0, 3_600_000],
  glideMs: [0, 10_000],
  keyChars: 64,
  defaultGlideMs: 150,
  /** Delay between a command's program time and its audio time, s. */
  latencyS: 0.1,
  /** Period of the page's batch loop, ms. */
  batchMs: 25,
  noteStartsPerSecond: 200,
  /** Most sky events the page queues between two batches; older ones are dropped. */
  queuedEvents: 4096,
  /** Array parameter updates (`harmonics.set`) the page sends per instrument per second. */
  harmonicsPerSecond: 30,
});

/** Event kinds of `on(group, kind, fn)`. */
export const HANDLER_EVENTS = Object.freeze(['enter', 'update', 'exit', '*']);
/** Kinds of IR program handlers. */
export const HANDLER_KINDS = Object.freeze(['on', 'every', 'after', 'freshness']);

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
  voiceMod: [-1, 1],
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
  velocity: 100,
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

/** Semitone offsets from the root of each scale mode, for `.quantize()` (src/expr/scales.js). */
export const SCALE_STEPS = Object.freeze({
  major:      Object.freeze([0, 2, 4, 5, 7, 9, 11]),
  minor:      Object.freeze([0, 2, 3, 5, 7, 8, 10]),
  dorian:     Object.freeze([0, 2, 3, 5, 7, 9, 10]),
  phrygian:   Object.freeze([0, 1, 3, 5, 7, 8, 10]),
  lydian:     Object.freeze([0, 2, 4, 6, 7, 9, 11]),
  mixolydian: Object.freeze([0, 2, 4, 5, 7, 9, 10]),
  locrian:    Object.freeze([0, 1, 3, 5, 6, 8, 10]),
  pentatonic: Object.freeze([0, 2, 4, 7, 9]),
  chromatic:  Object.freeze([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]),
});
export const SCALE_MODES = Object.freeze(Object.keys(SCALE_STEPS));
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
