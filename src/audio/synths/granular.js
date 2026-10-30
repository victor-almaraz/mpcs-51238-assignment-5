// Granular (synthesis-granular.md):
//   AudioBufferSourceNode(source buffer, offset, playbackRate) → Gain(triangular window)
//   → voice bus Gain(env) → polyNode → output
// Each voice is a bus with an AR envelope (attack, release); grains are scheduled ahead by pump(), driven
// by a 25 ms timer in realtime mode or by the offline scheduler's scheduleRange().
// All randomness comes from the widget's seeded mulberry32 so offline renders are reproducible.
// The source is a generated 2 s buffer or the user's sample (setSample, conditioned by sample.js).

import { Instrument } from '../instrument.js';
import { mulberry32, hashSeed } from '../random.js';
import { mtof } from './param-defs.js';

export const GRANULAR_VOICES = 4;
export const MAX_GRAINS = 64;          // concurrent grains per widget (project limit)
export const BASE_HZ = 261.63;         // C4: pitch of the 'saw' and 'chord' root
const SOURCE_SECONDS = 2;
const CHORD_HZ = [261.63, 329.63, 392.0];   // C4 E4 G4
const JITTER = 0.2;                    // ±20 % of the grain interval
const TIMER_MS = 25;

function fillSaw(data, sampleRate, hz, gain) {
  const inc = hz / sampleRate;
  let ph = 0;
  for (let i = 0; i < data.length; i++) {
    data[i] += gain * (2 * ph - 1);
    ph += inc;
    if (ph >= 1) ph -= 1;
  }
}

export class Granular extends Instrument {
  constructor(ctx, pool, opts = {}) {
    super('granular', ctx, pool, { cap: GRANULAR_VOICES });
    const seed = opts.seed || 1;
    this.seed = seed;
    this.rand = mulberry32(seed);
    this.realtime = opts.realtime !== false;
    this.lookahead = typeof opts.lookahead === 'function' ? opts.lookahead : () => 0.1;
    this.maxTime = typeof opts.maxTime === 'number' ? opts.maxTime : Infinity;
    this.buffers = {};
    this.sample = null;
    this.voiceSet = new Set();
    this.spans = [];                   // { s, e } of scheduled grains, for the concurrency cap
    this.timer = null;
  }

  /**
   * The user's sample (an AudioBuffer already conditioned by sample.js), or null. Grains
   * already scheduled keep the buffer they started with.
   */
  setSample(buffer) {
    this.sample = buffer || null;
  }

  /** 2 s mono source buffer, generated on first use and cached per instrument; 'sample' is the user's. */
  buffer(kind) {
    if (kind === 'sample') return this.sample;
    const cached = this.buffers[kind];
    if (cached) return cached;
    const sr = this.ctx.sampleRate;
    const buf = new AudioBuffer({ length: Math.round(SOURCE_SECONDS * sr), numberOfChannels: 1, sampleRate: sr });
    const d = buf.getChannelData(0);
    if (kind === 'noise') {
      const r = mulberry32(hashSeed(this.seed, 0x6e6f6973));
      for (let i = 0; i < d.length; i++) d[i] = r() * 2 - 1;
    } else if (kind === 'chord') {
      for (const hz of CHORD_HZ) fillSaw(d, sr, hz, 1);
      let peak = 0;
      for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a; }
      const k = 1 / Math.max(1, peak);
      for (let i = 0; i < d.length; i++) d[i] *= k;
    } else {
      fillSaw(d, sr, BASE_HZ, 1);
    }
    this.buffers[kind] = buf;
    return buf;
  }

  noteOn(pitch, velocity, time, source) {
    super.noteOn(pitch, velocity, time, source);
    if (!this.realtime || this.disposed) return;
    if (this.timer === null) this.timer = setInterval(() => this.tick(), TIMER_MS);
    this.pump(this.ctx.currentTime + this.lookahead());
  }

  tick() {
    if (this.disposed) { this.stopTimer(); return; }
    const now = this.ctx.currentTime;
    let alive = false;
    for (const v of this.voiceSet) if (v.end > now) { alive = true; break; }
    if (!alive) {
      this.stopTimer();
      this.sweep(now);
      return;
    }
    this.pump(now + this.lookahead());
  }

  stopTimer() {
    if (this.timer !== null) { clearInterval(this.timer); this.timer = null; }
  }

  startVoice(pitch, velocity, t) {
    const v = this.voiceModel(t, velocity, this.params.attack, this.params.release);
    const env = new GainNode(this.ctx, { gain: 0 });
    env.connect(this.polyNode);
    Object.assign(v, { env, freq: mtof(pitch), next: t, grains: new Set(), nodes: [env] });
    this.launch(v);                    // no sources: schedules the attack only
    this.voiceSet.add(v);
    return v;
  }

  /** Emits grains for every live voice while next < min(until, maxTime, voice.end), in time order. */
  pump(until) {
    if (this.disposed) return;
    const now = this.ctx.currentTime;
    this.sweep(now);
    const limit = Math.min(until, this.maxTime);
    const due = [];
    for (const v of this.voiceSet) {
      if (v.stolen) continue;
      if (v.next < now) v.next = now;  // timer stalled: skip grains in the past, never burst
      const stop = Math.min(limit, v.end);
      if (Number.isFinite(stop) && v.next < stop) due.push(v);
    }
    // Interleave voices by next grain time so emission is (nearly) monotonic in time.
    while (due.length > 0) {
      let bi = 0;
      for (let i = 1; i < due.length; i++) if (due[i].next < due[bi].next) bi = i;
      const v = due[bi];
      this.emitGrain(v, v.next, now);
      const density = this.params.density;
      v.next += (1 / density) * (1 + (this.rand() * 2 - 1) * JITTER);
      if (!(v.next < Math.min(limit, v.end))) {
        due[bi] = due[due.length - 1];
        due.pop();
      }
    }
  }

  emitGrain(v, t, now) {
    const p = this.params;
    const buf = this.buffer(p.source);
    if (!buf) return;                  // 'sample' chosen but no file loaded: silent
    const bufDur = buf.duration;
    const r = this.rand();
    let rate = p.source === 'noise' ? 1 : v.freq / BASE_HZ;
    // Pitch spread: each grain detuned by up to ±spread cents. The extra draw happens only
    // when spread is on, so renders with spread 0 keep their earlier random sequence.
    if (p.pitchSpread > 0 && p.source !== 'noise') rate *= Math.pow(2, ((this.rand() * 2 - 1) * p.pitchSpread) / 1200);
    const content = Math.min(p.grainSize * rate, bufDur);   // buffer-content seconds
    const size = content / rate;                              // wall-clock grain length
    const centre = p.position * (bufDur - content);
    const offset = Math.min(Math.max(0, centre + (r - 0.5) * p.spray * bufDur), Math.max(0, bufDur - content));

    // Cap: count scheduled grains overlapping [t, t + size]; skip past the cap, never steal.
    // Realtime emission can go back in time by up to the lookahead (a new note at
    // currentTime), so only grains ending before currentTime are pruned there. Offline
    // emission is monotonic, so grains ending before t can be pruned.
    const floor = this.realtime ? now : t;
    const end = t + size;
    let w = 0, overlap = 0;
    for (let i = 0; i < this.spans.length; i++) {
      const s = this.spans[i];
      if (s.e <= floor) continue;
      this.spans[w++] = s;
      if (s.s < end && s.e > t) overlap++;
    }
    this.spans.length = w;
    if (overlap >= MAX_GRAINS) return;

    const src = new AudioBufferSourceNode(this.ctx, { buffer: buf, playbackRate: rate });
    const win = new GainNode(this.ctx, { gain: 0 });
    src.connect(win).connect(v.env);
    // ≈ density × size grains overlap per voice; scale by 1/√overlap (uncorrelated grains sum
    // by power) so a voice stays near its 0.3 velocity headroom (audio-safety.md gain staging).
    const peak = 1 / Math.sqrt(Math.max(1, p.density * size));
    win.gain.setValueAtTime(0, t);
    win.gain.linearRampToValueAtTime(peak, t + size / 2);
    win.gain.linearRampToValueAtTime(0, end);
    const span = { s: t, e: end };
    this.spans.push(span);
    const g = { src, win, span };
    v.grains.add(g);
    src.onended = () => {
      src.disconnect();
      win.disconnect();
      v.grains.delete(g);
      if (v.grains.size === 0 && v.end <= this.ctx.currentTime) this.retire(v);
    };
    src.start(t, offset, content);
  }

  /** Ends the voice at `t`: grains still scheduled past `t` are stopped (before start → silent). */
  stopAt(v, t) {
    super.stopAt(v, t);
    if (!v.grains) return;
    for (const g of v.grains) {
      if (g.span.e <= v.end) continue;
      g.span.e = Math.max(g.span.s, v.end);
      try { g.src.stop(v.end); } catch { /* already stopped */ }
    }
  }

  retire(v) {
    if (!this.voiceSet.has(v)) return;
    this.voiceSet.delete(v);
    v.env.disconnect();
  }

  /** Disconnects voice buses whose release has completed and whose grains have all ended. */
  sweep(now) {
    for (const v of this.voiceSet) if (v.end <= now && v.grains.size === 0) this.retire(v);
  }

  applyParam() {
    // Every param is read when a grain is emitted; attack and release apply to new voices.
  }

  dispose() {
    if (this.disposed) return;
    this.stopTimer();
    const t = this.ctx.currentTime;
    for (const v of this.voiceSet) this.stopAt(v, t);
    super.dispose();
    for (const v of this.voiceSet) v.env.disconnect();
    this.voiceSet.clear();
    this.spans.length = 0;
  }
}
