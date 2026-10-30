/*
 * Constants shared by the main thread, the worklet and Node tests
 * (a3-audio-implementation.md). Environment-independent: no browser or Node
 * globals. The literal 128 appears only in this file.
 */

/** Name of the AudioWorkletProcessor that renders every sound (sequencer, instruments, mixer). */
export const ENGINE_PROCESSOR = 'wrack-engine';

/** Name of the AudioWorkletProcessor that applies the safety stage; always the last node. */
export const SAFETY_PROCESSOR = 'wrack-safety';

/** Output channel count of both processors (stereo). */
export const CHANNELS = 2;

/** Ticks per quarter note. Every musical time in Wrack is an integer tick count. */
export const PPQ = 960;

/**
 * Largest internal processing block, in frames (project limit). A quantum of any
 * length is processed in chunks of at most BLOCK frames; code never assumes the
 * quantum itself is this long.
 */
export const BLOCK = 128;

/** Number of MIDI note numbers (0–127). */
export const NOTE_COUNT = 128;

/** One-pole parameter smoothing time constant, in seconds (12 ms; project limit within 10–15 ms). */
export const SMOOTH_TAU_S = 0.012;

/** Recursive state below this magnitude is flushed to 0 at block end (denormal guard). */
export const DENORMAL_THRESHOLD = 1e-15;

/** Voice caps: per instrument and across the engine. */
export const VOICES_PER_INSTRUMENT = 16;
export const GLOBAL_VOICES = 64;

/** A stolen voice fades out over this many frames (project limit). */
export const STEAL_FADE_FRAMES = 64;

/** Entries in each clip fade table (project limit). */
export const FADE_TABLE_SIZE = 1025;
