// Master section of the safety UI (doc/audio/audio-safety.md, Safety UI): master volume, meter,
// limiting indicator, Panic and Reset, duck acknowledgement. Reads the master bus that the host's
// engine holds (`engine.bus`, doc/audio/audio-safety.md, Wiring); does not import src/audio/.
// The host fades the master in (`masterLevel` option of createAudioHost, fed by `level()`).

export const PANIC_RAMP_S = 0.01;
export const RISE_TAU_S = 0.05;
export const RESET_GUARD_MS = 1000;
export const PEAK_HOLD_MS = 1000;
const CEILING_DB = -1;

/** @param {number} db */
const gainOf = (db) => (Number.isFinite(db) ? Math.pow(10, db / 20) : 0);
/** @param {number} x */
const dbOf = (x) => (x > 0 ? 20 * Math.log10(x) : -Infinity);

/**
 * @param {{ engine: any, ctx: any, stop(): void }} host the audio host
 * @param {{ now?: () => number }} [opts] `now` in ms (performance.now)
 */
export function createMasterControls(host, { now = () => globalThis.performance.now() } = {}) {
  let targetDb = -12;
  let maxDb = 0;
  let muted = false;
  let panicAt = -Infinity;
  let peakHold = -Infinity;
  let peakHoldAt = -Infinity;
  /** @type {Float32Array | null} */ let buf = null;
  /** @type {Float32Array | null} */ let preBuf = null;

  const bus = () => host.engine?.bus ?? null;
  const gain = () => {
    const b = bus();
    const cap = b && Number.isFinite(b.maxMaster) ? b.maxMaster : 1;
    return Math.min(gainOf(Math.min(targetDb, maxDb)), cap);
  };

  /** @param {any} analyser @param {Float32Array | null} scratch */
  function read(analyser, scratch) {
    if (!analyser || typeof analyser.getFloatTimeDomainData !== 'function') return { peak: 0, rms: 0, scratch };
    const s = scratch && scratch.length === analyser.fftSize ? scratch : new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(s);
    let peak = 0;
    let sum = 0;
    for (let i = 0; i < s.length; i++) {
      const v = Math.abs(s[i]);
      if (v > peak) peak = v;
      sum += v * v;
    }
    return { peak, rms: Math.sqrt(sum / s.length), scratch: s };
  }

  return {
    /** Sets the master level in dB and its maximum (settings `audio.masterDb`, `audio.maxMasterDb`). */
    setLevel(/** @type {number} */ db, /** @type {number} */ max = maxDb) {
      maxDb = Math.min(0, Number.isFinite(max) ? max : 0);
      targetDb = Math.min(Number.isFinite(db) ? db : -12, maxDb);
      const b = bus();
      if (b && !muted && host.ctx?.state === 'running') b.master.setTarget(gain(), host.ctx.currentTime, RISE_TAU_S);
    },
    /** Linear master gain for the host's fade-in, or null while muted after Panic. */
    level() {
      return muted ? null : gain();
    },
    /**
     * Panic: release every voice and reset every effect chain after the voice fade
     * (`engine.panic`, doc/audio/effects.md), stop the piece and ramp the master to 0 over 10 ms.
     */
    panic() {
      const e = host.engine;
      const t = host.ctx?.currentTime ?? 0;
      try {
        if (e && typeof e.panic === 'function') e.panic(t);
        else if (e && typeof e.releaseAll === 'function') e.releaseAll(t);
      } catch { /* engine gone */ }
      host.stop();
      const b = bus();
      if (b) b.master.linearTo(0, t, PANIC_RAMP_S);
      muted = true;
      panicAt = now();
    },
    /**
     * Reset after Panic. Only a single pointer click (`event.detail === 1`) at least 1 s after
     * Panic ends the mute; nothing restarts.
     * @param {number} detail the click event's `detail`
     * @returns {boolean} true when the mute ended
     */
    reset(detail) {
      if (!muted || detail !== 1 || now() - panicAt < RESET_GUARD_MS) return false;
      muted = false;
      const b = bus();
      if (b && host.ctx) {
        b.master.setTarget(gain(), host.ctx.currentTime, RISE_TAU_S);
      }
      return true;
    },
    /** Moving the master volume also ends the mute (the keyboard path). @param {number} db */
    moveVolume(db) {
      muted = false;
      this.setLevel(db, maxDb);
    },
    /** "Restore Level" after a sustained-level duck. */
    ack() { const b = bus(); if (b && typeof b.ack === 'function') b.ack(); },
    /**
     * Post-limiter peak and RMS in dBFS, 1 s peak hold, and the limiting indicator.
     * @returns {{ peakDb: number, rmsDb: number, holdDb: number, limiting: boolean }}
     */
    meter() {
      const b = bus();
      const post = read(b?.meter, buf);
      buf = post.scratch;
      const pre = read(b?.preMeter, preBuf);
      preBuf = pre.scratch;
      const peakDb = dbOf(post.peak);
      const t = now();
      if (peakDb >= peakHold || t - peakHoldAt > PEAK_HOLD_MS) { peakHold = peakDb; peakHoldAt = t; }
      return { peakDb, rmsDb: dbOf(post.rms), holdDb: peakHold, limiting: dbOf(pre.peak) > CEILING_DB };
    },
    /** Voices holding a slot now, from the engine's pool. */
    voices() {
      const e = host.engine;
      const t = host.ctx?.currentTime ?? 0;
      try { return e?.pool?.live ? e.pool.live(t).length : 0; } catch { return 0; }
    },
    /** True when the safety stage runs as the fallback (reduced safety mode). */
    get reduced() { return bus()?.reduced === true; },
    get muted() { return muted; },
    get maxDb() { return maxDb; },
    get db() { return targetDb; },
  };
}
