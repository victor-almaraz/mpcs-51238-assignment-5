---
title: Visuals
order: 6
---

# Visuals

A piece draws its picture with a **view** and **layers**. Layer properties accept the same expressions as sound, and also audio signals, so the picture can follow both the data and the music.

## View
| Call | Effect |
|---|---|
| `view.projection('orbital')` | 3D view around Earth |
| `view.projection('map')` | Flat map: longitude across, latitude up |
| `view.projection('sky')` | The sky above the observer location set in Settings |
| `view.background(color)` | Background colour; accepts a colour expression |

## Layers
| Layer | Draws |
|---|---|
| `layer.points(group, props)` | A dot per object; `trail` leaves a fading path |
| `layer.rings(group, props)` | A ring per object |
| `layer.lines(group, props)` | Each object's orbit path or ground track |
| `layer.glyph(group, props)` | A character per object, for example `+` |
| `layer.field(props)` | A full-screen gradient |
| `layer.aurora(props)` | A full-screen aurora band |

```ts piece
const pad = additive({ volume: -12, attack: 1.5, release: 4 });
sky.group('celestrak.stations').voices(pad, {
  pitch: field('meanMotion').octaveInto(110, 440),
});

view.projection('orbital');
view.background(color('#05070c').mix('#1a0f2e', sky.swpc('kp.kp').map(0, 9, 0, 1)));

layer.points(sky.group('celestrak.cosmos-2251-debris'), { size: 1, color: '#7f8ea3', opacity: 0.4 });
layer.points(sky.group('celestrak.stations'), {
  size: audio.voice(pad).env().map(0, 1, 3, 9), color: '#f6e05e', trail: 600,
});
layer.aurora({ intensity: sky.swpc('kp.kp').map(3, 9, 0, 1) });
```

Satellites move continuously: their positions are computed in the browser from their orbits, between data updates.

| Group | Where its objects appear |
|---|---|
| `celestrak.*` | In orbit, at their computed positions |
| `ll2.upcoming` | At the launch pad |
| `jpl.*`, `swpc.*` | At the centre of the view; these objects have no position, so layers on them draw around Earth (or the zenith in `sky`) |

## Colours
`color('#rrggbb')` makes a colour. `.mix(other, t)` blends toward `other` by `t` (0–1), which can be an expression.

## Audio signals
| Signal | Value |
|---|---|
| `audio.level(inst)` | The instrument's loudness, 0–1 |
| `audio.spectrum(inst, bands)` | The instrument's spectrum in 4–32 bands, each 0–1 |
| `audio.voice(inst).env()` | The envelope of the note this object plays, 0–1 |

Audio signals are drawn when you hear the sound, corrected for output latency. They work in layer properties only.

## Safety
- The picture never flashes more than three times per second over an area large enough to affect people with photosensitive epilepsy. When a piece would exceed this, Sphärenmusik slows the change and records a `SAFETY` event in the console.
- With reduced motion enabled in the operating system or in Settings, trails, pulses, fades and camera movement are off, and data changes the picture at most once per second.

## Custom shaders
`layer.shader(glsl, props)` draws a fragment shader. A piece with a shader runs in your editor only: it cannot be saved as shareable or shared. The flash limit applies to shader output.
