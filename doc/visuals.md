# Visuals

## Scope
The visual builder API, layer vocabulary, projections, the WebGL2 renderer, orbit propagation, audio-visual synchronization and visual safety.

## Job
Draw the IR's layers each frame from sky data and audio signals, within the visual safety limits.

## Builder API
| Call | Effect |
|---|---|
| `view.projection(p)` | `orbital` (3D, Earth-centred), `map` (equirectangular longitude/latitude), `sky` (altitude/azimuth from the observer in settings) |
| `view.background(color)` | Background colour; accepts an expression returning a colour |
| `layer.points(group, props)` | One point per object |
| `layer.rings(group, props)` | One ring per object, centred on its position |
| `layer.lines(group, props)` | Ground track or orbit path per object |
| `layer.glyph(group, props)` | One character per object |
| `layer.field(props)` | Full-screen gradient or noise |
| `layer.aurora(props)` | Full-screen aurora band |
| `layer.shader(glsl, props)` | Fragment shader; local-only |
| `color(hex)` | Colour expression; `.mix(otherHex, t)` blends by expression `t` |
| `audio.level(inst)` | RMS level of the instrument output, 0–1 |
| `audio.spectrum(inst, bands)` | Array of `bands` (4–32) band levels, 0–1 |
| `audio.voice(inst).env()` | Envelope value of the voice bound to the current object, 0–1 |

`audio.voice(inst).env()` is computed from the voice's envelope model (`envValueAt` in the engine) and needs no analyser. `audio.level` and `audio.spectrum` read an `AnalyserNode` tapped on the instrument output.

## Object positions
| Group | Position |
|---|---|
| `celestrak.*` | Propagated from the object's orbital elements (Orbit propagation) |
| `ll2.upcoming` | The launch pad, `padLat` and `padLon`, on Earth's surface |
| `jpl.*`, `swpc.*` | The centre of the view: Earth in `orbital` and `map`, the zenith in `sky` |

Layers on groups without positions therefore draw concentric around the centre, for example `rings` with `radius` mapped from `distLD`.

## Layer properties
Properties and ranges live in `src/visual/layer-defs.js`, which drives validation, clamping and editor completion.

| Layer | Property | Type | Range | Default |
|---|---|---|---|---|
| all | `opacity` | number | 0–1 | 1 |
| `points` | `size` | number (px) | 0.5–24 | 2 |
| `points` | `color` | colour | | `#ffffff` |
| `points` | `trail` | number (s) | 0–3600 | 0 |
| `rings` | `radius` | number (px) | 1–800 | 20 |
| `rings` | `width` | number (px) | 0.5–8 | 1 |
| `rings` | `color` | colour | | `#ffffff` |
| `lines` | `span` | number (min) | 1–200 | 90 |
| `lines` | `color` | colour | | `#ffffff` |
| `glyph` | `char` | string (1 char) | | `+` |
| `glyph` | `size` | number (px) | 6–48 | 12 |
| `glyph` | `color` | colour | | `#ffffff` |
| `glyph` | `fade` | number (s) | 0–60 | 0 |
| `field` | `value` | number | 0–1 | 0 |
| `field` | `colormap` | enum | `night`, `ember`, `ice` | `night` |
| `aurora` | `intensity` | number | 0–1 | 0 |
| `aurora` | `drift` | number | 0–1 | 0.2 |

Every property accepts a constant or an expression. Expressions in layer properties are evaluated per object per frame, so `fn` is not allowed there.

## Renderer
- One `<canvas>` with a WebGL2 context. Each layer is one instanced draw.
- Frame loop: `requestAnimationFrame`. Layer properties that depend only on sky data are re-evaluated on sky events; properties that use `audio.*` are re-evaluated each frame.
- Without WebGL2, the preview shows a static text summary of the followed groups and the status bar shows `Visuals unavailable (WebGL2)`.
- Installation mode renders at device pixel ratio up to 2. The editor preview renders at the resolution set in settings.

## Orbit propagation
The orbit propagator serves both the renderer and the binding runtime. It runs whenever the piece follows a `celestrak.*` group, with or without layers.

- `src/visual/sgp4-worker.js` runs `satellite.js` 6 in a Web Worker. It builds a satrec per object with `json2satrec(toOmm(fields))`; OMM input supports six-digit catalog numbers.
- The worker propagates every followed CelesTrak object at 2 Hz and posts positions as a transferable `Float32Array`. The main thread interpolates linearly between the last two samples each frame.
- When propagation returns no position, the object is omitted from that frame and the worker traces the satrec error code once per object.
- The ISS is the `celestrak.stations` object with `noradId` `25544`; it is propagated like any other object.
- For every orbit source in the IR (`piece-dsl.md`, Orbits), the worker also computes the quantity at each 2 Hz step and posts it with the positions:
  - `latitude`, `longitude` and `altitude` from `eciToGeodetic`; perigee and apogee altitudes from the elements.
  - `phaseSin` and `phaseCos` from the argument of latitude of the propagated state.
  - `sunlit` from a cylindrical Earth-shadow test against a low-precision solar position (Astronomical Almanac formula, accuracy about 0.01°).
  - `elevation` from `ecfToLookAngles` for the observer in settings.
- Sources with `timeScale` above 1 propagate at `t₀ + (t − t₀) · timeScale`, where `t₀` is the engine start time.
- In replay, the propagator's clock runs at the replay speed from the replay window's start, so orbits stay consistent with the replayed elements.

## Audio-visual synchronization
Visuals that use `audio.*` are drawn at the time the listener hears the audio, not the time the engine schedules it.
```js
function audioNow(ctx) {
  const ts = ctx.getOutputTimestamp?.();
  if (ts && Number.isFinite(ts.contextTime) && ts.contextTime <= ctx.currentTime) {
    return ts.contextTime + (performance.now() - ts.performanceTime) / 1000;
  }
  return ctx.currentTime - (ctx.outputLatency || ctx.baseLatency || 0);
}
```

## Visual safety
The renderer enforces these limits on its final output, for every layer including shaders. Scripts and settings can make them stricter, never looser.

| Term | Definition |
|---|---|
| General flash | A pair of opposing changes in relative luminance of 10% or more of the maximum, where the darker state's relative luminance is below 0.80 |
| Red flash | A pair of opposing transitions involving a saturated red (R/(R+G+B) ≥ 0.8) where the change in CIE 1976 UCS chromaticity exceeds 0.2 |
| Flash area | Concurrent flashing area within any 10° visual field: 0.006 sr, about 25% of the field. At 1024×768 this is 341×256 px; the renderer scales it to 11.1% of the canvas area. |
| Limit | No flash area flashes more than 3 times in any 1 s period |

Guard algorithm (`src/visual/flash-guard.js`):
1. Every frame, read back the canvas at 64×48 into a luminance grid and a red-saturation grid.
2. Per cell, count general-flash and red-flash transitions over the last 1 s.
3. Slide a window of 11.1% of the grid area over the counts. If any window exceeds 3 flashes in 1 s, the guard limits per-frame luminance change of the full frame to 2% and holds colours of layers bound to the triggering expressions until the window falls below the limit.
4. Each intervention emits a `SAFETY` trace record.

Reduced motion: when `prefers-reduced-motion: reduce` matches, or the setting forces it, trails, ring pulses, glyph fades and camera motion are off, and data-driven changes apply in steps no faster than 1 Hz.

Bursts: trigger rate limits (`bindings.md`) apply to visual event effects as well.

## Open items
- Verify `getOutputTimestamp()` values in Safari before relying on them; the fallback applies when they are non-finite.

## Sources
- W3C, Understanding Success Criterion 2.3.1 Three Flashes or Below Threshold: https://www.w3.org/WAI/WCAG22/Understanding/three-flashes-or-below-threshold.html
- satellite.js: https://github.com/shashwatak/satellite-js
- MDN, AudioContext.getOutputTimestamp(): https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/getOutputTimestamp
- MDN, AudioContext.outputLatency: https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/outputLatency
- MDN, prefers-reduced-motion: https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion
