---
title: Sound
order: 4
---

# Sound

A piece makes sound with **instruments**. Data reaches an instrument in three ways: as **sustained voices**, one held note per object; as **triggers**, one short note per event; and as **follow** bindings, which move an instrument parameter.

## Instruments
| Constructor | Sound | Typical use |
|---|---|---|
| `additive(opts)` | Eight sine harmonics; smooth and organ-like | Pads, drones |
| `subtractive(opts)` | Oscillator through a resonant lowpass filter | Bass, swells, filtered tones |
| `fm(opts)` | Two-operator frequency modulation | Bells, glassy and metallic tones |
| `pluck(opts)` | Plucked string | Plucks, harp-like events |
| `granular(opts)` | Clouds of short grains from a saw, noise or chord source | Textures, noise fields |

Every constructor accepts `volume` (dB, −60 to 0, default −6), `octave` (−3 to 3), `cents` (−100 to 100) and the parameters of its type. Values outside a parameter's range move to the nearest end of the range. The [Reference](reference) lists every parameter.

```ts
const bell = fm({ volume: -6, ratio: 3.5, index: 6, indexDecay: 2 });
```

A piece holds at most 16 instruments. An instrument plays at most 16 notes at once (granular: 4), and a piece at most 64.

## Sustained voices
`group.voices(inst, { pitch, velocity, pan })` gives each object in a group one held note.
- An object entering the group starts its note.
- An object updating changes its note's pitch (and pan) smoothly.
- An object exiting releases its note.

```ts piece
scale('A', 'minor');
const pad = additive({ volume: -6, attack: 1.5, release: 4 });

sky.group('celestrak.gps-ops').voices(pad, {
  pitch:    field('raan').map(0, 360, 45, 69).quantize(),
  velocity: 50,
  pan:      field('raan').map(0, 360, -0.8, 0.8),
});
```

### Typed objects
Instead of an options object, `voices` accepts a function that receives the group's objects as `o`. Each field is a property of `o`, so the editor completes the group's field names and flags ones it does not have:

```ts piece
scale('A', 'minor');
const pad = additive({ volume: -6, attack: 1.5, release: 4 });

sky.group('celestrak.gps-ops').voices(pad, (o) => ({
  pitch: o.raan.map(0, 360, 45, 69).quantize(),
  pan:   o.orbit('phaseCos'),
}));
```

`o.raan` means the same as `field('raan')`. The function runs once, when the piece is built: `o.raan` is an expression, not the current number. `.when()` and `.trigger()` accept the same kind of function:

```ts
sky.group('ll2.upcoming').on('update')
  .when((o) => o.status.eq('In Flight'))
  .trigger(string, { pitch: 38, durationMs: 4000 });
```

### Choosing objects
A group larger than the voice limit needs a choice of which objects sound. `top(n, field, order)` selects the first `n` objects by a field: `'desc'` (largest first, the default) or `'asc'` (smallest first).

```ts
sky.group('jpl.cad').top(6, 'distLD', 'asc').voices(swell, {
  pitch: field('vRel').map(5, 30, 36, 60).quantize(),
});
```

The six closest approaches sound. When a closer object appears, the farthest of the six stops and the closer object starts.

## Triggers
`group.on(kind).trigger(inst, { pitch, velocity, durationMs, maxPerSecond })` plays one note when an object enters, updates or exits.

```ts piece
scale('E', 'phrygian');
const glass = fm({ volume: -6, ratio: 3.5, index: 6, indexDecay: 2 });

sky.group('jpl.scout').on('enter').trigger(glass, {
  pitch: rand(72, 84).quantize(),
  maxPerSecond: 1,
});
```

`.when(expr)` adds a condition:
```ts
sky.group('ll2.upcoming').on('update')
  .when(field('status').eq('In Flight'))
  .trigger(string, { pitch: 38, durationMs: 4000 });
```

`maxPerSecond` (default 2, at most 20) limits how often a trigger fires. Events above the limit are skipped, not delayed. A whole group can update at once, for example when CelesTrak publishes its two-hourly elements, and the limit keeps that from becoming a burst of notes.

## Following parameters
`inst.<param>.follow(expr, { smoothMs })` sets a parameter from data. The value glides over about `smoothMs` milliseconds (default 250).

```ts
neo.cutoff.follow(sky.swpc('wind.speed').map(300, 800, 300, 4000, 'log'));
pad.vibratoDepth.follow(sky.swpc('kp.kp').map(0, 9, 2, 40), { smoothMs: 2000 });
debris.density.follow(sky.group('celestrak.cosmos-2251-debris').count().map(200, 1000, 2, 30));
```

`follow` sets a parameter's **base value**. To move a parameter around its base value, use `.mod()` ([Effects and modulation](effects-and-modulation)).

## Levels and safety
- Velocity sets each note's loudness; the engine keeps every voice below a fixed headroom.
- A safety stage after the master output limits peaks, removes DC offset and lowers sustained loud output. No script setting bypasses it.
- `Escape` twice stops all sound at once.
