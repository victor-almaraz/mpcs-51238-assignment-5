---
title: Reference
order: 10
---

# Reference

## Piece
| Call | Effect | Default |
|---|---|---|
| `scale(root, mode)` | Scale for `.quantize()` | `'C'`, `'chromatic'` |
| `seed(n)` | Seed for `rand` and random LFOs | 1 |
| `tempo(bpm)` | Tempo for synced delays and LFOs, 20–300 | 120 |

## Instruments
Every instrument accepts `volume` (dB, −60–0, default −6), `octave` (−3–3), `cents` (−100–100) and the parameters below. Each numeric parameter has `.follow(expr, { smoothMs })` and `.mod(source, { depth, smoothMs })`.

### `additive`
| Parameter | Range | Default | Unit |
|---|---|---|---|
| `harmonics` | 8 values, each 0–1 | `[1, 0.5, 0.33, 0.25, 0.2, 0.17, 0.14, 0.12]` | |
| `attack` | 0.002–2 | 0.02 | s |
| `decay` | 0.01–4 | 0.5 | s |
| `sustain` | 0–1 | 1 | |
| `release` | 0.01–4 | 0.5 | s |
| `vibratoRate` | 0.5–12 | 5 | Hz |
| `vibratoDepth` | 0–100 | 0 | cents |

`harmonics` accepts neither `follow` nor `mod`. Set it in the constructor, or from a handler with `inst.harmonics.set([...])` ([Programs](programs#changing-harmonics)).

### `subtractive`
| Parameter | Range | Default | Unit |
|---|---|---|---|
| `waveform` | `sine`, `sawtooth`, `square`, `triangle` | `sawtooth` | |
| `cutoff` | 40–16000 | 2000 | Hz |
| `resonance` | 0–20 | 1 | dB |
| `envAmount` | 0–6 | 0 | octaves |
| `attack` | 0.002–2 | 0.01 | s |
| `decay` | 0.01–4 | 0.3 | s |
| `sustain` | 0–1 | 1 | |
| `release` | 0.01–4 | 0.3 | s |

### `fm`
| Parameter | Range | Default | Unit |
|---|---|---|---|
| `ratio` | 0.5–12 | 2 | |
| `fine` | −0.5–0.5 | 0 | |
| `index` | 0–20 | 3 | |
| `indexDecay` | 0.01–4 | 0.5 | s |
| `attack` | 0.002–2 | 0.005 | s |
| `decay` | 0.01–4 | 0.5 | s |
| `sustain` | 0–1 | 1 | |
| `release` | 0.01–4 | 0.4 | s |

### `pluck`
| Parameter | Range | Default | Unit |
|---|---|---|---|
| `damping` | 0–1 | 0.5 | |
| `brightness` | 0–1 | 0.7 | |
| `pickPosition` | 0–0.5 | 0 | |
| `decay` | 0.2–10 | 2 | s |
| `release` | 0.02–2 | 0.1 | s |

### `granular`
| Parameter | Range | Default | Unit |
|---|---|---|---|
| `source` | `saw`, `noise`, `chord` | `saw` | |
| `position` | 0–1 | 0.5 | |
| `grainSize` | 0.01–0.25 | 0.06 | s |
| `density` | 2–60 | 20 | grains/s |
| `spray` | 0–1 | 0.2 | |
| `pitchSpread` | 0–1200 | 0 | cents |
| `attack` | 0.002–2 | 0.05 | s |
| `release` | 0.01–4 | 0.4 | s |

Choice parameters (`waveform`, `source`) accept `follow` with an option index but not `mod`.

## Effects
`inst.fx(...slots)` and `master.fx(...slots)` set chains. Every effect accepts `bypass` (`false` by default; `slot.bypass.follow(expr)` toggles it). "Lower only" parameters accept modulation that lowers them.

| Effect | Parameter | Range | Default | Unit |
|---|---|---|---|---|
| `eq3` | `lowFreq` | 30–500 | 120 | Hz |
| | `lowGain` | −18–18 | 0 | dB |
| | `midFreq` | 200–8000 | 1000 | Hz |
| | `midGain` | −18–18 | 0 | dB |
| | `midQ` | 0.3–8 | 0.7 | |
| | `highFreq` | 2000–16000 | 8000 | Hz |
| | `highGain` | −18–18 | 0 | dB |
| `filter` | `mode` | `lowpass`, `highpass`, `bandpass` | `lowpass` | |
| | `cutoff` | 20–20000 | 2000 | Hz |
| | `resonance` | 0.5–12 | 0.707 | Q |
| `compressor` | `threshold` | −60–0 | −18 | dB |
| | `ratio` | 1–20 | 4 | :1 |
| | `attack` | 0.1–100 | 10 | ms |
| | `release` | 10–1000 | 120 | ms |
| | `makeup` (lower only) | 0–24 | 0 | dB |
| `saturation` | `drive` | 0–36 | 6 | dB |
| | `tone` | 1000–16000 | 8000 | Hz |
| | `mix` | 0–1 | 1 | |
| | `output` (lower only) | −24–6 | −3 | dB |
| `distortion` | `mode` | `softclip`, `hardclip`, `foldback` | `softclip` | |
| | `drive` | 0–48 | 12 | dB |
| | `bias` | −0.5–0.5 | 0 | |
| | `tone` | 500–16000 | 6000 | Hz |
| | `mix` | 0–1 | 1 | |
| | `output` (lower only) | −36–0 | −6 | dB |
| `delay` | `time` | 1–2000 | 375 | ms |
| | `sync` | `off`, `1/32`–`1/1`, with `d` (dotted) or `t` (triplet) | `off` | |
| | `feedback` | 0–0.9 | 0.35 | |
| | `highCut` | 1000–20000 | 8000 | Hz |
| | `mix` | 0–1 | 0.3 | |
| `reverb` | `size` | 0–1 | 0.75 | |
| | `decay` | 0.2–10 | 2 | s |
| | `damping` | 0–1 | 0.5 | |
| | `preDelay` | 0–200 | 10 | ms |
| | `mix` | 0–1 | 0.25 | |

## Modulation
| Call | Effect |
|---|---|
| `lfo({ shape, rate, phase, retrigger, smooth })` | Creates an LFO |
| `target.mod(source, { depth, smoothMs })` | Adds a route from an LFO or a −1–1 expression; `depth` −1–1 of the parameter's range |

## Sky
| Call | Returns |
|---|---|
| `sky.group(key)` | A group |
| `.top(n, field, order)` | The first `n` objects by `field`; `order` `'desc'` or `'asc'` |
| `.voices(inst, { pitch, velocity, pan, voiceMods })` | One held note per object; `voiceMods` maps parameters that `.mod()` accepts to per-note offsets, −1–1 |
| `.on(kind)` | Events: `'enter'`, `'update'`, `'exit'` |
| `.when(expr)` | Events where `expr` is true |
| `.trigger(inst, { pitch, velocity, durationMs, maxPerSecond })` | One note per event; defaults velocity 100, 250 ms, 2 per second |
| `.count()`, `.mean(field)`, `.spread(field)` | Group statistics, as expressions |
| `sky.swpc(path)` | A space-weather value |
| `sky.value(objectId, field)` | One field of one object |

Groups and fields: [Sky data](sky-data).

## Expressions
[Expressions](expressions) lists every source and step.

## Orbits
| Call | Returns |
|---|---|
| `orbit(quantity, { timeScale })` | A VLFO, −1 to 1, from the current object's orbit |
| `sky.orbit(objectId, quantity, { timeScale })` | A VLFO from one named object |

Quantities: `latitude`, `phaseSin`, `phaseCos`, `altitude`, `longitude`, `sunlit`, `elevation`. `timeScale` 1–1000, default 1. Orbit values update twice per second; as modulation sources their default `smoothMs` is 500.

## Typed objects
`voices`, `when`, `trigger` and layer constructors accept a function `(o) => ...` in place of their options or expression. `o.<field>` equals `field('<field>')` for that group's fields; `o.orbit(quantity, opts)` equals `orbit(quantity, opts)` on `celestrak.*` groups.

## Types
| Type | Meaning |
|---|---|
| `Expr<number>`, `Expr<string>`, `Expr<boolean>` | An expression producing a number, text or true/false |
| `Num` | A number or an `Expr<number>` |
| `Pitch` | A `Num` in MIDI note numbers |
| `GroupKey` | Any group name, such as `'jpl.cad'` |
| `OrbitQuantity` | `'latitude'`, `'phaseSin'`, `'phaseCos'`, `'altitude'`, `'longitude'`, `'sunlit'`, `'elevation'` |

Types check names and kinds of values. Ranges are checked when the piece is built, and values outside a range move to the nearest end.

## Reactions
| Call | Effect |
|---|---|
| `onStale(source, actions)` | Applies `actions` while `source` is stale |
| `onDown(source, actions)` | Applies `actions` while `source` is down |

Actions: `detuneCents`, `mute`, `only`, `desaturate`. See [Live data states](live-data-states).

## Visuals
| Call | Effect |
|---|---|
| `view.projection(p)` | `'orbital'`, `'map'` or `'sky'` |
| `view.background(color)` | Background colour |
| `color(hex)`, `.mix(hex, t)` | Colour and blend |
| `audio.level(inst)`, `audio.spectrum(inst, bands)`, `audio.voice(inst).env()` | Audio signals, 0–1 |

| Layer | Property | Range | Default |
|---|---|---|---|
| every layer | `opacity` | 0–1 | 1 |
| `points` | `size` | 0.5–24 px | 2 |
| | `color` | colour | `#ffffff` |
| | `trail` | 0–3600 s | 0 |
| `rings` | `radius` | 1–800 px | 20 |
| | `width` | 0.5–8 px | 1 |
| | `color` | colour | `#ffffff` |
| `lines` | `span` | 1–200 min | 90 |
| | `color` | colour | `#ffffff` |
| `glyph` | `char` | one character | `+` |
| | `size` | 6–48 px | 12 |
| | `color` | colour | `#ffffff` |
| | `fade` | 0–60 s | 0 |
| `field` | `value` | 0–1 | 0 |
| | `colormap` | `night`, `ember`, `ice` | `night` |
| `aurora` | `intensity` | 0–1 | 0 |
| | `drift` | 0–1 | 0.2 |

## Program
Handlers are registered in the setup; commands and `read.*` work inside handlers only ([Programs](programs)).

| Call | Effect |
|---|---|
| `on(group, kind, fn)` | Calls `fn(o, e)` for each `'enter'`, `'update'`, `'exit'` or `'*'` event; `e` is `{ kind, traceId, initial, prev }` |
| `every(interval, fn)` | Calls `fn(t)` every 10–3,600,000 ms, or every sync value such as `'1/8'` |
| `after(ms, fn)` | Calls `fn(t)` once, 0–3,600,000 ms later; returns a function that cancels it |
| `onFreshness(source, fn)` | Calls `fn({ source, state })` when a source's freshness changes |
| `follow(...groups)` | Follows groups read only with `read.*`; `follow(sky.orbit(id, quantity, { timeScale }))` declares an orbit for `read.orbit` |
| `inst.play(pitch, { velocity, pan, durationMs })` | One note; defaults velocity 100, pan 0, 250 ms (20–10,000) |
| `inst.hold(key, pitch, { velocity, pan })` | A held note named `key` (1–64 characters) |
| `inst.glide(key, pitch, ms)` | Slides a held note; `ms` 0–10,000, default 150 |
| `inst.stop(key)`, `inst.stopAll()` | Releases held notes |
| `inst.<param>.set(value, { smoothMs })`, `slot.<param>.set(...)` | Sets a numeric parameter; `smoothMs` default 250 |
| `inst.harmonics.set(values)` | Sets an additive instrument's 8 harmonics, each 0–1, at once |
| `slot.bypass.set(on)` | Bypasses an effect |
| `layerHandle.set(props)` | Sets constant layer properties |
| `read.swpc(path)`, `read.group(key)`, `read.object(id)`, `read.freshness(source)` | Current sky values |
| `read.orbit(id, quantity, { timeScale })` | A declared orbit's current value, −1 to 1, or `null`; it changes every 500 ms |
| `time()` | Milliseconds since the program started |
| `random()`, `randInt(n)`, `choose(list)` | Choices seeded by `seed()`; `Math.random` is the same generator |

`setTimeout`, `setInterval`, `Date` and `performance` are not available in scripts.

## Escape hatches
| Call | Effect |
|---|---|
| `fn('o => ...')` | An expression computed by a JavaScript function, given as a string; the string is not type-checked. A call that throws or runs longer than 1.5 s gives `null` |
| `layer.shader(glsl, props)` | A fragment-shader layer |

A piece using either runs in your editor only and cannot be shared. `fn` is not allowed in layer properties.

## Limits
| Item | Limit |
|---|---|
| Instruments | 16 |
| Notes per instrument | 16 (granular: 4) |
| Notes per piece | 64 |
| Bindings (voices, triggers, follows) | 64 |
| Effects per chain | 8 |
| Reverbs | 4 |
| LFOs | 16 |
| Modulation routes | 32, at most 4 per parameter |
| Layers | 16 |
| Orbit sources (object, quantity, time scale) | 64 |
| Expression nesting | 32 levels |
| Script length | 200,000 characters |
| Script run time | 1.5 s |
| Handlers | 64 |
| Handler run time per round | 250 ms |
| New notes per second from handlers | 200 |
| Commands per round | 256 |
| Waiting after() calls | 256 |
| Harmonics updates per second, per instrument | 30 |
