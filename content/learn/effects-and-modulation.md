---
title: Effects and modulation
order: 5
---

# Effects and modulation

**Effects** process an instrument's sound, or the whole mix. **Modulation** moves a parameter of an instrument or effect around its base value, driven by an LFO or by data.

## Effects
| Constructor | Effect |
|---|---|
| `eq3(opts)` | Three-band equalizer: low shelf, mid peak, high shelf |
| `filter(opts)` | Lowpass, highpass or bandpass filter |
| `compressor(opts)` | Evens out loudness |
| `saturation(opts)` | Warm, soft overdrive |
| `distortion(opts)` | Hard clipping and wavefolding |
| `delay(opts)` | Echoes, with feedback |
| `reverb(opts)` | Room and hall reverberation |

Options are parameter values (see the [Reference](reference)) and `bypass`.

### Chains
`inst.fx(...)` places effects after an instrument, in order. `master.fx(...)` places effects on the whole mix.

```ts piece
const pad  = additive({ volume: -6, attack: 1.5, release: 4 });
const echo = delay({ time: 500, feedback: 0.4, mix: 0.25 });
const verb = reverb({ size: 0.85, decay: 6, mix: 0.3 });

pad.fx(echo, verb);
master.fx(eq3({ lowGain: -2 }), compressor({ threshold: -20, ratio: 3 }));

sky.group('celestrak.stations').voices(pad, {
  pitch: field('meanMotion').octaveInto(110, 440),
});
```

- A chain holds at most 8 effects. A piece holds at most 4 reverbs.
- Each effect belongs to one chain. To use the same settings twice, create two effects.
- Every effect has a fixed safe range: delay feedback stops at 0.9, so echoes always die away.
- An effect that produces an invalid signal resets and bypasses itself. The editor shows "Effect *type* on *instrument* was reset and bypassed." The effect returns on the next save or Run.

### Tempo
`tempo(bpm)` (20–300, default 120) sets the tempo for synced delays and synced LFOs:

```ts
tempo(72);
const echo = delay({ sync: '1/4d', feedback: 0.5 });   // dotted quarter at 72 BPM
```

### Following effect parameters
Effect parameters accept `follow`, like instrument parameters:

```ts
verb.size.follow(sky.group('celestrak.stations').count().map(5, 40, 0.4, 0.95));
grit.bypass.follow(sky.swpc('kp.kp').lt(5));   // distortion only during geomagnetic storms
```

## Modulation
`.mod(source, { depth })` adds movement around a parameter's base value. Sources are LFOs or data expressions.

### LFOs
An LFO (low-frequency oscillator) is a slow, repeating wave:

```ts
const breathe = lfo({ shape: 'sine', rate: 0.03 });   // one cycle every 33 seconds
pad.cutoff.mod(breathe, { depth: 0.1 });
verb.decay.mod(breathe, { depth: 0.2 });
```

| Option | Values |
|---|---|
| `shape` | `sine`, `triangle`, `square`, `saw`, `random` (a step to a random value each cycle), `smooth` (random, with glides) |
| `rate` | Cycles per second, 0.01–20; a tempo-synced note value such as `'1/4'` or `'1/8t'`; or an expression ending in `.map(...)` |
| `phase` | Starting point in the cycle, 0–1 |
| `retrigger` | `true` restarts the LFO with each note (instrument parameters only) |
| `smooth` | 0–1; how much `random` and `smooth` glide between values |

One LFO can drive several parameters; they move together. A data-driven rate makes the LFO speed follow the sky:

```ts
const shimmer = lfo({ shape: 'smooth', rate: sky.swpc('wind.speed').map(300, 800, 0.1, 3) });
```

### Orbits as very slow LFOs
A satellite's orbit is a wave: its latitude rises and falls once per orbit, it passes in and out of Earth's shadow once per orbit, and its position goes once around the circle. `orbit(quantity)` turns that motion into a source from −1 to 1, computed for every moment from the satellite's real position. Its period is the orbit: about 92 minutes for the ISS, 12 hours for GPS satellites. That is far slower than an `lfo()`, whose slowest rate is one cycle in 100 seconds.

| Quantity | Wave |
|---|---|
| `latitude` | North (1) to south (−1) and back, a smooth curve |
| `phaseSin`, `phaseCos` | Position around the orbit as a sine and a cosine, a quarter cycle apart |
| `altitude` | Highest point (1) to lowest (−1); nearly flat for round orbits |
| `longitude` | East to west across the map, then a jump back |
| `sunlit` | 1 in sunlight, −1 in Earth's shadow: a square wave |
| `elevation` | Height above your horizon, from the observer location in Settings; high only during a pass overhead |

`orbit(...)` reads the satellite a voice or layer is playing. `sky.orbit(objectId, quantity)` reads one named satellite anywhere in the script.

```ts piece
const pad  = additive({ volume: -6, attack: 1.5, release: 4 });
const tone = filter({ cutoff: 3000 });
pad.fx(tone);

sky.group('celestrak.stations').voices(pad, {
  pitch: field('meanMotion').octaveInto(110, 440),
  pan:   orbit('phaseCos'),                         // each station circles the stereo field once per orbit
});

const iss = 'celestrak.stations:25544';
tone.cutoff.mod(sky.orbit(iss, 'sunlit'), { depth: 0.15, smoothMs: 4000 });  // darker in Earth's shadow
pad.vibratoDepth.follow(sky.orbit(iss, 'latitude').map(-1, 1, 0, 30));
```

At real speed, one cycle takes the whole orbit, which suits a piece that plays for hours. To hear the cycle faster while composing, add `{ timeScale: n }` (1–1000): `orbit('latitude', { timeScale: 60 })` completes an ISS orbit in about 90 seconds. A time-scaled orbit does not match where the satellite is; the console marks it `time-scaled`, and the picture keeps showing real positions.

Orbits apply to `celestrak.*` groups only.

### Data as a source
An expression is a modulation source when it gives values from −1 to 1:

```ts
echo.feedback.mod(sky.swpc('kp.kp').map(0, 9, -1, 1), { depth: 0.4 });
grit.drive.mod(sky.swpc('mag.bz').map(-20, 20, 1, -1), { depth: 0.3 });   // southward field adds drive
```

Values outside −1 to 1 are limited to that range. `smoothMs` (default 250) sets how fast the source follows its data.

### Depth
`depth` is −1 to 1, measured as a fraction of the parameter's whole range. Frequency and time parameters use a logarithmic range, so equal depths sound equal anywhere in the range:

| Parameter | Range | Depth 0.1 |
|---|---|---|
| Effect filter `cutoff` | 20–20,000 Hz (10 octaves) | ±1 octave |
| Delay `time` | 1–2,000 ms (11 octaves) | ±1.1 octaves of delay time |
| Reverb `size` | 0–1 | ±0.1 |

A negative depth reverses the source. Modulation never moves a parameter outside its range.

`output` and `makeup` gain parameters accept modulation that lowers them only. Modulation never makes an effect louder than its setting.

### follow and mod together
`follow` sets where a parameter sits. `mod` sets how it moves around that point. Both can act on one parameter:

```ts
pad.cutoff.follow(sky.swpc('wind.speed').map(300, 800, 400, 4000, 'log'));   // where
pad.cutoff.mod(breathe, { depth: 0.08 });                                     // movement
```

### Limits
16 LFOs, 32 modulation routes, and 4 routes on any one parameter. Mode choices such as `filter` `mode` and `delay` `sync` accept `follow` but not `mod`.
