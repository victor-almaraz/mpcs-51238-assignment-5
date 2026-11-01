// Runtime limits from doc/bindings.md and doc/audio/audio-engine-core.md.

export const LIMITS = Object.freeze({
  voicesPerInstrument: 16,
  voicesPerGranular: 4,
  voicesTotal: 64,
  /** Minimum interval between posts of one parameter or data source (30 Hz). */
  postIntervalMs: 1000 / 30,
  /** Tick period of the update loop: the first whole millisecond above 1000 / 30, so a post on
   *  every tick stays within 30 per second. */
  tickMs: 34,
  /** Glide time of setVoicePitch. */
  glideMs: 150,
  /** Pitch change, in semitones, below which a voice is not re-pitched. */
  pitchEpsilon: 0.01,
  /** Minimum time between a sustained voice's noteOn and its noteOff, in seconds. */
  minNoteSeconds: 0.005,
  /** Orbit-driven voice options are evaluated for at most this many objects per binding. */
  orbitObjectsPerBinding: 16,
  defaultVelocity: 100,
  defaultDurationMs: 250,
  defaultMaxPerSecond: 2,
  defaultSmoothMs: 250,
  defaultOrbitSmoothMs: 500,
  maxCents: 100,
});

/**
 * Voice cap of an instrument type.
 * @param {string} type
 * @returns {number}
 */
export function voiceCap(type) {
  return type === 'granular' ? LIMITS.voicesPerGranular : LIMITS.voicesPerInstrument;
}
