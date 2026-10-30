---
title: Expressions
order: 3
---

# Expressions

An **expression** describes how to compute a value from data. Expressions set pitches, velocities, parameter values, modulation and visual properties. An expression starts from a source and applies steps in a chain:

```ts
field('vRel').map(5, 30, 36, 60).quantize()
```

Read it left to right: take the object's `vRel` field, map 5–30 km/s onto MIDI notes 36–60, then move to the nearest note of the scale.

Sphärenmusik evaluates an expression again whenever its data changes. An expression is not a number: `field('vRel') * 2` is a type error. Use `.mul(2)`.

## Sources
| Source | Value |
|---|---|
| `field(name)` | A field of the current object: the object a voice, trigger or layer is drawing |
| `num(x)`, or a number literal | A constant |
| `rand(lo, hi)` | A number in `[lo, hi)`, fixed per object; set by the piece's `seed()` |
| `sky.swpc(path)` | A space-weather value, for example `sky.swpc('wind.speed')` |
| `sky.value(objectId, field)` | One field of one named object |
| `sky.group(key).count()` | Number of objects in a group |
| `sky.group(key).mean(field)` | Average of a field over a group |
| `sky.group(key).spread(field)` | Largest minus smallest value of a field in a group |
| `orbit(quantity)` | A slow wave from the current satellite's orbit, −1 to 1 ([Orbits as very slow LFOs](effects-and-modulation#orbits-as-very-slow-lfos)) |
| `sky.orbit(objectId, quantity)` | The same wave from one named satellite |

`rand` gives each object its own value and keeps it while the object stays in the group. Two runs of the same piece with the same seed produce the same values.

## Steps
| Step | Result |
|---|---|
| `.map(inMin, inMax, outMin, outMax)` | Rescales linearly; values outside the input range stay at the ends of the output range |
| `.map(inMin, inMax, outMin, outMax, 'log')` | Rescales on a logarithmic curve; use for frequencies and other ranges spanning many octaves |
| `.map(..., 'exp')` | Rescales on an exponential curve |
| `.clamp(lo, hi)` | Limits the value to `[lo, hi]` |
| `.octaveInto(loHz, hiHz)` | Treats the value as a frequency, doubles or halves it until it lies in `[loHz, hiHz)`, and returns that pitch |
| `.quantize()` | Moves a pitch to the nearest note of the piece's scale |
| `.add(x)`, `.sub(x)`, `.mul(x)`, `.div(x)` | Arithmetic; `x` is a number or another expression |
| `.abs()`, `.neg()`, `.round()` | Absolute value, negation, rounding |
| `.eq(x)`, `.gt(x)`, `.lt(x)` | Comparison, giving true or false |
| `.and(e)`, `.or(e)`, `.not()` | Logic on true and false |

## Units
| Value | Unit |
|---|---|
| Pitch | MIDI note number: 60 is middle C, 69 is A 440 Hz, 12 per octave. Fractions are allowed: 60.5 is a quarter tone above middle C. |
| Velocity | 1–127; higher is louder |
| Pan | −1 (left) to 1 (right) |
| Parameters | The parameter's own unit (Hz, seconds, dB); see the [Reference](reference) |
| Modulation sources | −1 to 1 |

## Scales
`scale(root, mode)` sets the scale used by `.quantize()`.

- `root`: a note name `C` to `B`, with `#` or `b`, for example `'F#'`.
- `mode`: `major`, `minor`, `dorian`, `phrygian`, `lydian`, `mixolydian`, `locrian`, `pentatonic` or `chromatic`.

Without `scale()`, the scale is C chromatic, so `.quantize()` rounds to the nearest semitone.

## Missing values
When a field is absent or a computation produces no number (division by zero, for example), the expression gives `null`, and every later step also gives `null`.

| Where | Effect of `null` |
|---|---|
| Voice pitch | The voice does not start |
| Trigger pitch | The trigger does not fire |
| Parameter | The parameter keeps its last value |
| Visual property | The property uses its default |

## Patterns
Map an orbit's tilt to stereo position:
```ts
field('inclination').map(0, 180, -1, 1)
```

Louder for closer asteroids (closer means a smaller `distLD`, so the output range runs high to low):
```ts
field('distLD').map(0.5, 10, 110, 20)
```

A filter cutoff from solar wind speed, on a log curve:
```ts
sky.swpc('wind.speed').map(300, 800, 300, 4000, 'log')
```

A condition for triggers:
```ts
field('status').eq('In Flight')
```

Brighter as a group grows:
```ts
sky.group('jpl.scout').count().map(0, 20, 0.2, 1)
```
