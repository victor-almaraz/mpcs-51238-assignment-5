# Audio safety

## Scope
Measures that prevent loud bursts, sustained high levels, runaway feedback and DC offset at the output. Covers the output stage (`safety-limiter` AudioWorklet), parameter guards, input flood limits and safety UI. The engine chain is in `audio-engine-core.md`; worklet loading in `audioworklet.md`.

## Hazard model

### Hazards and mitigations
| Hazard | Source in this app | Mitigation |
|---|---|---|
| Transient peak | Voice pile-up, filter resonance, patch load, unsmoothed gain, MIDI floods | Limiter + hard clip; smoothing; flood limits |
| Sustained high level | Dense polyphony at high master volume | Default master −12 dB; sustained-level duck; meter |
| Full-scale output into headphones | Any unbounded stage | Ceiling −1 dBFS; master max 0 dB |
| DC offset | Asymmetric waveforms, Karplus-Strong excitation | DC blocker at output |
| Runaway feedback | Karplus-Strong loop gain ≥ 1, unstable biquads, NaN/Infinity | Loop-gain rule; non-finite guard with node rebuild |
| Denormals | Decaying IIR and delay-line state | Flush to zero in worklets |
| Clicks | Discontinuities in gain or parameters, hard starts/stops | Minimum attack/release; fades |

### Digital level vs. sound pressure
- Sound pressure at the ear depends on device volume and headphone sensitivity, which the page cannot read. Every limit in this doc is a digital level (dBFS), not dB SPL.
- Device standards (IEC/EN 62368-1, EN 50332) set acoustic limits for personal music players, measured with a reference signal. A headset manufacturer's summary of these standards gives the headset limit as ≤ 100 dBA with a −10 dBFS digital test input. That is a compliance ceiling, not a calibration point: the SPL produced at any dBFS level varies by device and volume setting, and software cannot infer it.
- The controls available to the software: low default level, bounded maximum, no step changes in level, runaway protection, a visible level display and an immediate mute.

### Reference limits
| Limit | Value | Source |
|---|---|---|
| Weekly sound allowance, adult | 1.6 Pa²h (≈ 80 dBA for 40 h/week) | ITU-T H.870 (V2, 2022) |
| Weekly sound allowance, sensitive users | 0.51 Pa²h (≈ 75 dBA for 40 h/week) | ITU-T H.870 |
| Personal music player, RS1 | ≤ 85 dBA (legacy) / ≤ 80 dBA | IEC/EN 62368-1 |
| Personal music player, RS2 | ≤ 100 dBA; exceeding RS1 requires user acknowledgement | IEC/EN 62368-1 |
| Occupational daily exposure | 85 dBA / 8 h, 3 dB exchange rate | NIOSH 1998 |
| Impulse peak, adults | 140 dB peak SPL | OSHA 29 CFR 1910.95; EU 2003/10/EC |
| Impulse peak, children | 120 dB peak SPL | WHO (Berglund 1999) |

These are device and occupational limits. No acoustic standard applies directly to browser applications.

## Web Audio behaviour relevant to safety
| Topic | Behaviour |
|---|---|
| Samples outside [−1, 1] at `destination` | Nominal range only; handling beyond it (clip, OS limiter) is implementation-dependent. |
| AudioWorklet output | Not clamped. An exception in `process()` fires `processorerror`, and the node outputs silence for the rest of its lifetime. |
| BiquadFilterNode instability | An unstable filter produces ±Infinity, then NaN. NaN persists in the filter state after parameters return to stable values (WebAudio issue #1841). |
| AudioParam curves | `setValueCurveAtTime` throws `TypeError` on non-finite curve values and `NotSupportedError` on overlap with other events. NaN can still reach an AudioParam through audio-rate connections (WebAudio issue #2077). |
| DynamicsCompressorNode | Fixed makeup gain `(1 / curve(1.0))^0.6`, normative in the spec ("computing the makeup gain"). Look-ahead is an implementation constant (6 ms in Chromium and Gecko), not specified. Transients shorter than the attack overshoot. Not a brick-wall limiter. |
| WaveShaperNode | Input beyond ±1 maps to the first/last curve value. |
| AudioParam `.value` getter | Returns the param's current value as updated once per render quantum, so it lags scheduled automation and does not return the value at a future time. |
| Denormals | JS has no flush-to-zero control (Mozilla bug 1027624). |

With threshold −3 dB, ratio 20, knee 0, the DynamicsCompressorNode's makeup gain is ≈ +1.7 dB: signals below threshold are raised. It is used only in the fallback stage, with the makeup gain cancelled.

## Output stage

### Signal chain
```
voice → widget.output (volume × mute/solo × polyGain)
      → mixBus (GainNode, 1.0)
      → masterGain (default 0.25 = −12 dB, max 1.0)
      → safetyNode (AudioWorkletNode 'safety-limiter')
           non-finite guard → DC blocker → duck → look-ahead limiter → hard clip
      → destination
      ├→ meter (AnalyserNode, fftSize 2048), post-limiter
      └→ recorder (recording.md)
masterGain → preMeter (AnalyserNode), drives the limiting indicator
```

### Parameters
| Parameter | Value |
|---|---|
| Ceiling (limiter and hard clip) | −1.0 dBFS = 0.8913 sample peak (project limit) |
| Look-ahead | 1.5 ms: 66 samples at 44.1 kHz, 72 at 48 kHz (project limit) |
| Attack | Equal to look-ahead (boxcar of length L) |
| Release | 100 ms exponential (project limit) |
| DC blocker −3 dB point | 10 Hz (project limit) |
| Fade-in on start and after a fault | 50 ms linear (project limit) |
| Fault mute hold | 250 ms (project limit) |
| Fault threshold | `!(Math.abs(x) <= 1e4)` (project limit) |
| Sustained-level duck | −6 dB when 3 s RMS > −12 dBFS (project limit) |
| Default master | 0.25 = −12 dB (project limit) |
| Master maximum | 1.0 = 0 dB, no boost (project limit) |

- The ceiling bounds sample peaks. Inter-sample peaks after D/A reconstruction can exceed it; the 1 dB margin follows the broadcast convention of −1 dBTP (EBU R 128). True-peak detection (ITU-R BS.1770) is not implemented.
- Added latency: 1.5 ms.

### Non-finite guard and recovery
- On the first non-finite or out-of-threshold input sample, the worklet zeroes the rest of the render quantum, resets its state (DC blocker, delay line, gain), holds silence for 250 ms, fades in over 50 ms and posts `{type:'fault'}` once.
- On `fault`, `master-bus.js`:
  1. Stops the transport and calls `releaseAll()` (`midi-playback-scheduling.md`).
  2. Disconnects and recreates every BiquadFilterNode and every worklet node that may hold NaN state (`ks-processor`).
  3. Announces "Audio fault — output muted and reset" in the assertive live region.
- Worklets flush state variables with `if (Math.abs(s) < 1e-20) s = 0` (project limit). Applies to `ks-processor.js` and `safety-limiter.js`.

### DC blocker
One-pole/one-zero high-pass after J. O. Smith: `y[n] = x[n] − x[n−1] + R·y[n−1]`, with `R = 1 − 2π·10 / fs` (≈ 0.99857 at 44.1 kHz, −3 dB near 10 Hz).

### Limiter algorithm
For input frame n, stereo-linked:
1. `r[n] = min(1, ceiling / max(|xL|, |xR|))` — required gain.
2. `m[n] = min(r[n−L … n])` — sliding minimum over L+1 samples.
3. `h[n] = min(m[n], h[n−1] + (1 − h[n−1])·a_rel)`, with `a_rel = 1 − exp(−1 / (0.1·fs))`.
4. `g[n]` = mean of `h[n−L+1 … n]` (boxcar).
5. `out[n] = clip(x[n−L]·g[n], ±ceiling)`.

Every `h[k]` with k ∈ [n−L, n] is ≤ `r[n−L]`, so `g[n] ≤ r[n−L]` and the delayed sample does not exceed the ceiling before the clip. The clip absorbs floating-point rounding. The gain curve has no steps.

### Fades on start, resume and suspend
- On context start or resume, `masterGain` starts at 0 and ramps to its target over 50 ms with `linearRampToValueAtTime`.
- Before suspend, `masterGain` ramps to 0 over 20 ms; `suspend()` runs after `currentTime + 0.03`.
- Context creation and `resume()` run only inside user-gesture handlers (`audio-engine-core.md`). Nothing plays on page load.

### Sustained-level duck
- The worklet tracks a one-pole mean-square estimate (τ = 3 s) of its input. Above −12 dBFS RMS it ramps a duck gain to −6 dB over 1 s and posts `{type:'duck'}`.
- The UI shows "Level reduced — sustained loud output" with a "Restore Level" button. The duck lifts only when the button sends `{type:'ack'}`.
- The guard runs in the worklet so background-tab timer throttling does not affect it.

### Processor (`public/worklets/safety-limiter.js`)
```js
// Plain JS AudioWorklet. All buffers are allocated in the constructor; process() does not allocate.
const MAX_ABS = 1e4;

class SafetyLimiter extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    const fs = sampleRate;
    this.ceil = Math.pow(10, (o.ceilingDb ?? -1) / 20);
    this.L = Math.max(1, Math.round((o.lookaheadMs ?? 1.5) * 1e-3 * fs));
    this.aRel = 1 - Math.exp(-1 / ((o.releaseMs ?? 100) * 1e-3 * fs));
    this.R = 1 - (2 * Math.PI * (o.dcHz ?? 10)) / fs;
    this.fadeLen = Math.round(0.05 * fs);
    this.holdLen = Math.round(0.25 * fs);
    this.msCoef = 1 - Math.exp(-1 / (3 * fs));
    this.duckThresh = Math.pow(10, -12 / 10);   // mean-square at −12 dBFS
    this.duckTarget = Math.pow(10, -6 / 20);
    this.duckStep = (1 - this.duckTarget) / fs; // ≈ 1 s ramp

    const n = this.L + 1;
    this.dL = new Float32Array(n);
    this.dR = new Float32Array(n);
    this.req = new Float32Array(n);
    this.box = new Float32Array(this.L);
    this.reset();
    this.ducking = false; this.duck = 1; this.ms = 0;
    this.port.onmessage = (e) => { if (e.data && e.data.type === 'ack') this.ducking = false; };
  }

  reset() {
    this.dL.fill(0); this.dR.fill(0); this.req.fill(1); this.box.fill(1);
    this.w = 0; this.bw = 0; this.boxSum = this.L; this.h = 1;
    this.xl1 = 0; this.yl1 = 0; this.xr1 = 0; this.yr1 = 0;
    this.fade = 0; this.hold = 0; this.faultSent = false;
  }

  fault() {
    this.reset();
    this.hold = this.holdLen;
    if (!this.faultSent) { this.port.postMessage({ type: 'fault' }); this.faultSent = true; }
  }

  process(inputs, outputs) {
    const out = outputs[0];
    const oL = out[0], oR = out.length > 1 ? out[1] : out[0];
    const inp = inputs[0];
    const n = oL.length;
    if (!inp || inp.length === 0) { oL.fill(0); if (oR !== oL) oR.fill(0); return true; }
    const iL = inp[0], iR = inp.length > 1 ? inp[1] : inp[0];
    const c = this.ceil, L = this.L, N = L + 1;

    for (let i = 0; i < n; i++) {
      const xl = iL[i], xr = iR[i];
      if (!(Math.abs(xl) <= MAX_ABS) || !(Math.abs(xr) <= MAX_ABS)) {
        this.fault();
        for (let k = i; k < n; k++) { oL[k] = 0; oR[k] = 0; }
        return true;
      }
      if (this.hold > 0) { this.hold--; oL[i] = 0; oR[i] = 0; continue; }

      // DC blocker
      let yl = xl - this.xl1 + this.R * this.yl1; this.xl1 = xl;
      let yr = xr - this.xr1 + this.R * this.yr1; this.xr1 = xr;
      if (Math.abs(yl) < 1e-20) yl = 0;
      if (Math.abs(yr) < 1e-20) yr = 0;
      this.yl1 = yl; this.yr1 = yr;

      // Sustained-level duck
      this.ms += this.msCoef * (0.5 * (yl * yl + yr * yr) - this.ms);
      if (this.ms > this.duckThresh && !this.ducking) {
        this.ducking = true;
        this.port.postMessage({ type: 'duck' });
      }
      const dt = this.ducking ? this.duckTarget : 1;
      this.duck += Math.max(-this.duckStep, Math.min(this.duckStep, dt - this.duck));
      yl *= this.duck; yr *= this.duck;

      // Look-ahead limiter
      const pk = Math.max(Math.abs(yl), Math.abs(yr));
      const w = this.w;
      this.req[w] = pk > c ? c / pk : 1;
      const outL = this.dL[(w + 1) % N], outR = this.dR[(w + 1) % N]; // x[n−L]
      this.dL[w] = yl; this.dR[w] = yr;
      let m = 1;
      for (let k = 0; k < N; k++) if (this.req[k] < m) m = this.req[k];
      this.h = Math.min(m, this.h + (1 - this.h) * this.aRel);
      this.boxSum += this.h - this.box[this.bw];
      this.box[this.bw] = this.h;
      this.bw = (this.bw + 1) % L;
      this.w = (w + 1) % N;
      const g = this.boxSum / L;

      // Fade-in and hard clip
      let f = 1;
      if (this.fade < this.fadeLen) { f = this.fade / this.fadeLen; this.fade++; }
      const sl = outL * g * f, sr = outR * g * f;
      oL[i] = sl > c ? c : sl < -c ? -c : sl;
      if (oR !== oL) oR[i] = sr > c ? c : sr < -c ? -c : sr;
    }
    return true;
  }
}
registerProcessor('safety-limiter', SafetyLimiter);
```
- `postMessage` allocates; it runs only on fault and duck state changes.
- `boxSum` accumulates in double precision; a fault reset re-anchors it.

### Wiring (`src/audio/master-bus.js`)
```ts
export const SAFETY = {
  ceilingDb: -1,
  lookaheadMs: 1.5,
  releaseMs: 100,
  dcHz: 10,
  defaultMaster: 0.25,   // −12 dB
  maxMaster: 1.0,        // 0 dB
} as const;

export async function buildMasterBus(ctx: BaseAudioContext) {
  const mixBus = new GainNode(ctx, { gain: 1 });
  const masterGain = new GainNode(ctx, { gain: 0 });   // fades in on start
  let safety: AudioNode;
  let safetyOut: AudioNode;
  try {
    await loadWorklets(ctx);                           // safety-limiter.js first (audioworklet.md)
    const node = new AudioWorkletNode(ctx, 'safety-limiter', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
      channelCount: 2, channelCountMode: 'explicit',
      processorOptions: SAFETY,
    });
    node.onprocessorerror = () => onSafetyError();     // node is now permanently silent
    safety = safetyOut = node;
  } catch {
    ({ input: safety, output: safetyOut } = buildFallback(ctx));
  }
  mixBus.connect(masterGain).connect(safety);
  safetyOut.connect(ctx.destination);
  return { mixBus, masterGain, safetyOut };
}
```
- No widget output connects to `mixBus` until `buildMasterBus` resolves.
- `onSafetyError` stops the transport, calls `releaseAll()` and shows "Restart Audio", which closes the context and creates a new one on the next gesture.
- Meters and the recorder attach to `safetyOut` (and `preMeter` to `masterGain`) only in an `AudioContext`, not in offline renders.

### Fallback without AudioWorklet
```ts
function buildFallback(ctx: BaseAudioContext): { input: AudioNode; output: AudioNode } {
  const T = -6, ratio = 20;                                    // (project limit)
  const comp = new DynamicsCompressorNode(ctx, { threshold: T, knee: 0, ratio, attack: 0.001, release: 0.1 });
  const makeupDb = 0.6 * -(T - T / ratio);                     // ≈ 3.42 dB
  const trim = new GainNode(ctx, { gain: Math.pow(10, -makeupDb / 20) });
  const c = Math.pow(10, -1 / 20);
  const N = 4097, curve = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const x = (i / (N - 1)) * 2 - 1;
    curve[i] = x > c ? c : x < -c ? -c : x;
  }
  const clip = new WaveShaperNode(ctx, { curve, oversample: 'none' });
  comp.connect(trim).connect(clip);
  return { input: comp, output: clip };
}
```
- Every curve value is ≤ c, and linear interpolation between them cannot exceed c, so non-NaN output is bounded by c.
- `oversample` is `'none'`; the resampling filters used with `'2x'`/`'4x'` can overshoot the curve values.
- The fallback has no non-finite guard and no DC blocker. While it is active, the master maximum is 0.5 (−6 dB) (project limit) and the master section shows "Reduced safety mode".

## Parameter guards

### Clamping
- Every value from a patch, the UI or MIDI passes through `PARAM_DEFS` (`synthesis-conventions.md`, `patch-format.md`). Non-numbers, NaN and ±Infinity become the default; other values are clamped to `[min, max]`.
- Values passed to `setValueCurveAtTime` are checked with `every(Number.isFinite)` before scheduling, which avoids the `TypeError`.

| Parameter | Limit |
|---|---|
| Widget volume | −60 … 0 dB, plus off; `g = 10^(dB/20)`; 0.5 dB steps (project limit) |
| Master volume | Same taper; max 0 dB; default −12 dB (project limit) |
| Per-voice velocity gain | ≤ 0.3·(vel/127)² |
| Velocity | Integer 1–127; 0 is note-off |
| Filter cutoff | 20 Hz – min(20 kHz, 0.45·fs) |
| Lowpass resonance | ≤ 20 dB (`synthesis-subtractive.md`) |
| Attack minimum | 2 ms |
| Release minimum | 10 ms |
| FM index | Nyquist-bounded clamp (`synthesis-fm.md`) |
| Karplus-Strong loop gain ρ | ≤ 0.9999, loop-filter peak gain ≤ 1 (`synthesis-pluck.md`) |
| Additive partials | Divided by `max(1, sum)` (`synthesis-additive.md`) |
| Granular | ≤ 4 voices, ≤ 64 concurrent grains per widget; grain window ≥ 2 ms per side (project limit) |
| Filter envelope | ≤ 6 octaves, and per voice so cutoff × 2^octaves ≤ 0.45·fs (`synthesis-subtractive.md`) |
| Sustain | 0 – 1 of the velocity peak; decay only lowers the level |
| Vibrato | ≤ 100 cents on `detune`; pitch only |
| Pluck pick position, release | Excitation re-scaled to the velocity peak after the comb; release loop gain ≤ the decay's ρ |
| Granular user sample | Peak ≤ 1 and RMS ≤ 1/√3 after conditioning ("User samples" below) |

### Smoothing
- Gain changes (volume, mute/solo, master) use `setTargetAtTime(target, t, 0.01)`; `.value` is never set while audio runs.
- Filter frequency and resonance changes use τ = 15 ms (project limit).
- Ramps start from the value tracked in JS, not from `AudioParam.value`. Cancel-and-restart follows `audio-engine-core.md` (Firefox has no `cancelAndHoldAtTime`).

### Feedback stability
- Karplus-Strong: loop gain below 1 at all frequencies keeps the loop stable. With the two-point average (peak gain 1), ρ ≤ 0.9999 satisfies this. Any added loop filter has peak gain ≤ 1.
- `ks-processor.js` applies the same non-finite check as the safety limiter: on a fault it zeroes its delay lines and posts `{type:'fault'}`.

### Gain staging
- Worst-case coherent sum: 16 voices × 0.3 = 4.8 per widget (+13.6 dB); 64 × 0.3 = 19.2 globally (+25.7 dB).
- Each widget applies `polyGain = min(1, 2 / sqrt(activeVoices))` (project limit), smoothed with τ = 50 ms. Uncorrelated voices sum by power, so widget level stays roughly constant above 4 voices.

### Untrusted input
- Patch load (`patch-format.md`): validate and clamp; ramp widget outputs to 0 (τ = 10 ms); apply parameters at `t + 30 ms`; ramp back over 100 ms (project limit). Loading never starts notes.
- Solo changes are applied to all widgets in one scheduling pass with the same `t`.
- Live input (`live-input.md`): note-ons above 200 per second (all sources combined) are dropped (project limit). Voice caps and stealing apply (`audio-engine-core.md`).
- File playback: events already behind `currentTime` are skipped, not played in a burst (`midi-playback-scheduling.md`).

### User samples
A granular widget can play a user's audio file (`synthesis-granular.md` "User sample"). The file is arbitrary: it may be full scale, clipped, DC-offset, very long or multi-channel. `conditionSample` (`src/audio/sample.js`) makes it no louder than the generated sources before it reaches the engine:
- **Size:** files over 4 MB are refused before decoding (decoded audio can be tens of times larger); audio past 20 s is dropped.
- **Mono and finite:** channels are averaged; NaN and ±Infinity count as 0.
- **DC:** the mean is subtracted, then a 10 Hz one-pole high-pass removes drift.
- **Edges:** 5 ms fades at both ends, so grains taken at the edges and the truncation point do not click.
- **Level:** gain = `min(1 / peak, (1/√3) / rms)`, so the peak is at most 1 (the generated saw and noise) and the RMS at most that of a full-scale saw or noise. A full-scale square therefore plays 4.8 dB below full scale. Files with a peak under −80 dBFS are refused as silent.
- The grain windows, polyGain, voice cap, grain cap and the output stage then apply as for the generated sources.

## Safety UI
Controls are specified in `controls-and-accessibility.md`; placement in `layout-and-responsive.md`.
- **No sound on load.** The AudioContext is created on the first gesture that needs audio.
- **Start notice.** Before the first audio start in a session, a dialog reads: "Lower your device volume before starting. Headphones can reach harmful levels." Dismissal is held in memory for the session; nothing is stored.
- **Master volume and meter.** Always visible. The meter reads peak and RMS from the post-limiter analyser once per animation frame, with 1 s peak hold, scale −60…0 dBFS.
- **Limiting indicator.** A "Limit" text badge shows while the pre-limiter peak exceeds the ceiling.
- **Panic.** A visible "Panic" button and the `Escape` key (when no menu or dialog is open). Panic stops the transport, calls `releaseAll()` (file and live voices), clears scheduled events and ramps `masterGain` to 0 over 10 ms. While muted, the same button reads "Reset" and the master section shows "Muted".
- **Reset.** Only a pointer click on Reset, or moving the master volume, ends the mute. The click must be a single click (`event.detail === 1`), and Reset is ignored for 1 s after a Panic, so a double-click or repeated fast clicks on Panic never unmute. The master returns to its level with the slow rise (τ = 50 ms) and nothing restarts. No key unmutes: Escape only mutes, and a click synthesised from Enter or Space on the focused button (`event.detail === 0`) is ignored, so a Space meant for Play cannot bring sound back. Moving the master volume (keyboard-operable) is the keyboard path.
- **Announcements.** Duck and reduced safety mode use the polite live region; panic and fault use the assertive live region.
- No safety indicator uses the accent colour.

## Acceptance criteria
Offline renders (`OfflineAudioContext`, 44.1 and 48 kHz, stereo) through the real `buildMasterBus` chain, 4 s each. The suite runs on the test page `/dev/safety/` (`src/components/dev/safety-cases.js`), which `next dev` serves and the deployment build leaves out (`repo-structure.md`, "Routes").

### Levels
Each case runs at two levels:

| Level | Widget volume | Master volume | Checks |
|---|---|---|---|
| Worst case | 0 dB (unless the case sets it) | 0 dB | All except the sample-to-sample step |
| Default | −6 dB | −12 dB | All |

The step check runs at default levels only. At worst-case levels, bright full-scale content exceeds 0.25 without any click: a 12.5 kHz sine at 0.3 peak has a step of 2 · 0.3 · sin(π · 12543 / 44100) ≈ 0.47.

### Cases
| Case | Content |
|---|---|
| 1 | 64 voices (4 widgets × 16), sawtooth, velocity 100, lowpass at max resonance swept from 40 Hz to min(16 kHz, 0.45·fs) |
| 2 | FM at max index and ratio, highest note |
| 3 | Pluck at max decay (ρ up to 0.9999), lowest and highest notes, retriggered every 10 ms |
| 4 | Granular, 4 voices, max grain size and density, full spray (the 64-grain cap is reached) |
| 5 | Additive, all partials at max, 16 voices |
| 6 | Patch load and solo toggle mid-render |
| 7 | NaN injected at 1.0 s |
| 8 | Constant DC input of 0.5 |
| 9 | Subtractive, 16 voices, 6-octave filter envelope at max resonance, retriggered every 250 ms |
| 10 | FM at max index, ratio 12 + fine 0.5, decay to sustain 0, low and highest notes |
| 11 | Additive, all partials at max, 16 voices, vibrato 100 cents at 12 Hz |
| 12 | Pluck, pick position 0.5, release 2 s, retriggered every 10 ms with note-offs |
| 13 | Granular user sample (conditioned full-scale square with DC), 4 high voices, max density, size, spray and pitch spread |

- Case 1 uses velocity 100. At velocity 127 the low saws make the 1 s DC windows exceed 1e-3 at worst-case levels, and the bright end of the sweep exceeds the step limit at default levels, neither of which is a defect. At velocity 100 the limiter still holds the output at the ceiling under worst-case levels.
- Every offline render awaits `Engine.flush()` before `startRendering()` (`audioworklet.md` "Message protocol"), so the pluck cases (3 and 12) play every note.

### Assertions
| Assertion | Threshold |
|---|---|
| Maximum \|sample\| | ≤ 0.8913 + 1e-6 |
| Non-finite samples | 0 |
| DC (mean per 1 s window after 0.1 s) | \|mean\| ≤ 1e-3 |
| Onset peak (first 128 frames) | ≤ 0.02 |
| Fade-in complete | Within 1 % of steady state by 60 ms |
| Sample-to-sample step (cases 1–6, 9–13; default levels) | ≤ 0.25 (project limit) |
| Case 7 | Zero output for ≥ 250 ms from the fault frame; `fault` posted; recovery fade ≤ 50 ms |
| Below-ceiling transparency | −4 dBFS input with `dcHz: 0`: output equals input delayed by L frames within 1e-4 |

Every check passes at both sample rates: 114 checks at worst-case levels and 136 at default levels.

### Functional tests
The safety cases bound levels; they do not check that sound is produced. The audio-core tests on `/dev/core/` (`src/components/dev/core-cases.js`) check behaviour through the same chain: every synth is silent before a note, sounds during it and is silent after its release; A4 measures 440 Hz (±0.5 %) at 44.1 and 48 kHz; volume, velocity and sustain levels; each param's effect; determinism; voice caps; mute and solo; and Render to WAV per synth type. Every check passes (45 tests, 99 checks).

## Unconfirmed behaviour
- Handling of out-of-range samples at `destination` and the spec's NaN rule for AudioParam computed values were not checked against the current spec text.
- WaveShaperNode handling of NaN input is unspecified.
- The acoustic figures from IEC/EN 62368-1 and EN 50332 come from excerpts and a manufacturer's summary; the standards are paywalled.

## Sources
- W3C, Web Audio API 1.1 (https://www.w3.org/TR/webaudio-1.1/)
- WebAudio issues #1841 (unstable biquads), #2077 (NaN AudioParam inputs), #2639 (compressor makeup gain) (https://github.com/WebAudio/web-audio-api/issues)
- MDN, AudioWorkletProcessor.process(), WaveShaperNode.curve, WaveShaperNode.oversample, Autoplay guide (https://developer.mozilla.org/)
- Mozilla Bugzilla 1027624 (https://bugzilla.mozilla.org/show_bug.cgi?id=1027624)
- ITU-T H.870 (V2, 03/2022), Guidelines for safe listening devices/systems (https://www.itu.int/rec/T-REC-H.870)
- IEC 62368-1 / EN 50332-1, acoustic output requirements for personal music players
- NIOSH, Criteria for a Recommended Standard: Occupational Noise Exposure (1998)
- OSHA, 29 CFR 1910.95 (https://www.osha.gov/laws-regs/regulations/standardnumber/1910/1910.95)
- WHO, Guidelines for Community Noise (Berglund et al., 1999)
- EBU R 128, Loudness normalisation and permitted maximum level of audio signals
- J. O. Smith, Introduction to Digital Filters, DC blocker (https://ccrma.stanford.edu/~jos/filters/DC_Blocker.html)
- Karplus & Strong (1983); Jaffe & Smith (1983), Computer Music Journal 7(2)
