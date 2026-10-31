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

## Projections
| Projection | Screen mapping |
|---|---|
| `orbital` | Perspective view of the Earth-centred inertial (TEME) frame. The camera looks at Earth's centre from 20° above the equatorial plane and frames the largest orbital radius of the drawn objects (at least 1.6 Earth radii). The camera turns once around Earth's axis every 600 s. Earth is drawn as a disc; objects behind it draw at a quarter of their opacity. |
| `map` | Equirectangular: longitude −180–180 left to right, latitude 90 to −90 top to bottom, letterboxed at 2:1 in the canvas, with a 30° graticule. Lines that cross the antimeridian break there. |
| `sky` | Azimuthal equidistant around the zenith: the zenith at the centre, the horizon on a circle of 95% of the half-size of the canvas, north up and east left. Objects below the horizon are not drawn. Circles mark elevations 0°, 30° and 60°. |

Projection math lives in `src/visual/projection.js` and runs on the main thread; the GPU receives screen positions in pixels.

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

Every property accepts a constant or an expression. Expressions in layer properties are evaluated per object per frame, so `fn` is not allowed there. `shader` layers have only `opacity`.

Property meanings:
- `size`, `radius`, `width` are CSS pixels; the renderer multiplies them by its pixel ratio.
- `trail`: the object's past path over the last `trail` seconds, fading linearly to transparent at its oldest end. Objects without propagated positions have no trail.
- `span`: the path from `span / 2` minutes before to `span / 2` minutes after the current time, sampled once per minute. `orbital` draws the orbit path; `map` the ground track; `sky` the part above the horizon.
- `fade`: with `fade` above 0, a glyph's opacity falls linearly from 1 to 0 over `fade` seconds after its object's last `enter` or `update` event. With 0 the glyph does not fade.
- `field`: a vertical gradient from the colormap, from `colormap(value / 2)` at the bottom edge to `colormap(value)` at the top edge, with static low-frequency noise of ±0.03.
- `aurora`: a wavy band at 65° geomagnetic-style latitude (both hemispheres in `map`, near the top of the canvas in `orbital`, near the northern horizon in `sky`). `intensity` scales its brightness; `drift` sets its horizontal drift speed, 0 to 0.05 cycles per second.

| Colormap | Stops (0, 0.5, 1) |
|---|---|
| `night` | `#05070c`, `#1b2a4a`, `#6c7fb8` |
| `ember` | `#0b0503`, `#7a1e0a`, `#f2a541` |
| `ice` | `#04080c`, `#1f6f8b`, `#d6f3ff` |

### Shader layers
The IR entry of `layer.shader(glsl, props)` is `{ "id", "type": "shader", "group": null, "glsl": string, "props": { "opacity": ... } }`. `glsl` is GLSL ES 3.00 source that defines `void mainImage(out vec4 color, in vec2 coord)`. The renderer prepends `#version 300 es`, `precision highp float;` and these uniforms:

| Uniform | Value |
|---|---|
| `float uTime` | Seconds since the renderer started |
| `vec2 uResolution` | Canvas size in device pixels |
| `float uOpacity` | The layer's `opacity` |

`coord` is in device pixels from the bottom-left corner. The output is non-premultiplied RGBA and is multiplied by `uOpacity`. A shader that fails to compile disables its layer and emits a `VISUAL` trace record at level `error` with the compiler log.

## Renderer
- One `<canvas>` with a WebGL2 context. Each layer is one instanced draw.
- Frame loop: `requestAnimationFrame`. Layer properties that depend only on sky data are re-evaluated on sky events; properties that use `audio.*` are re-evaluated each frame.
- Without WebGL2, the preview shows a static text summary of the followed groups and the status bar shows `Visuals unavailable (WebGL2)`.
- Installation mode renders at device pixel ratio up to 2. The editor preview renders at the resolution set in settings.
- Each frame draws the scene into an offscreen texture, then a composite pass applies `desaturate` and the flash guard's limit and writes the canvas. `desaturate` changes at most 1.0 per second, with or without reduced motion.

### Interface
`src/visual/renderer.js` exports `createRenderer(canvas, options)`; `src/visual/mount.js` exports `mountVisuals(container, options)`, which creates the canvas, or the text summary when WebGL2 is unavailable.

| Option | Meaning |
|---|---|
| `sky` | The `Sky` store (`sky-contract.md`); the renderer reads `get(group)` and listens to `enter`, `update` and `exit` |
| `propagator` | The orbit propagator (`src/visual/propagator.js`), shared with the binding runtime |
| `trace` | `trace(record)` from the trace bus |
| `pixelRatio` | Device pixels per CSS pixel, 0.25–2 |
| `reducedMotion` | `visual.reducedMotion` from settings, `system` or `on` |
| `maxFlashesPerSecond` | `visual.maxFlashesPerSecond`, 0–3 |
| `observer` | `data.observer`, `{ lat, lon }` in degrees |
| `audioClock` | Function returning `audioNow(ctx)` in seconds, or `null` before Run |
| `frameValues` | Function `(audioTime) => LayerValues` called each frame for properties that use `audio.*` |

| Method | Effect |
|---|---|
| `setView(view)` | Applies the IR's `view` |
| `setLayers(layers)` | Applies the IR's `layers`; layers whose entry is unchanged (canonical JSON) keep their buffers and trails |
| `setLayerValues(values)` | Replaces the evaluated sky-driven property values |
| `setBackground(color)` | Sets the evaluated background colour, `#rrggbb` |
| `setDesaturate(amount)` | 0–1; the reaction action `desaturate` (`bindings.md`). 1 draws in grey |
| `setSettings(partial)` | Updates `pixelRatio`, `reducedMotion`, `maxFlashesPerSecond`, `observer` |
| `start()`, `stop()` | Start and stop the frame loop |
| `setGroups(groups)` | The IR's `groups`, listed by the text summary |
| `highlight(objectId)` | Draws a marker around one object (Sounding voices panel); `null` clears it |
| `dispose()` | Releases GPU resources and listeners |

`available` is `false` when no WebGL2 context exists; the methods are then no-ops and `summaryLines()` returns the text summary.

`LayerValues` has the form `{ [layerId]: { [prop]: value | { [objectId]: value } } }`. A plain value applies to every object of the layer; an object maps object ids to values. Numbers are clamped to the property's range, colours are `#rrggbb` strings, and invalid values are ignored so the previous value stays. A property absent from both the values and the IR's constants uses its default. Values from `frameValues` override `setLayerValues` for the same property.

### Trace records
| Event | Level | When | `data` |
|---|---|---|---|
| `enter`, `update`, `exit` | `info` | A sky event in a layer's group, with the event's `traceId` | `{ "layer": "l0", "objectId": "..." }` |
| `fallback` | `warn` | WebGL2 is unavailable | `{ "reason": "webgl2" }` |
| `shaderError` | `error` | A layer shader fails to compile | `{ "layer": "l3", "log": "..." }` |
| `contextLost` | `error` | The WebGL context is lost | `{}` |
| `propagationFailed` | `warn` | Propagation of an object fails, once per object and element set | `{ "objectId": "...", "code": 1, "message": "..." }` |

Stage `VISUAL`; component `layer.<id>`, `renderer` or `sgp4`.

## Orbit propagation
The orbit propagator serves both the renderer and the binding runtime. It runs whenever the piece follows a `celestrak.*` group, with or without layers.

- `src/visual/sgp4-worker.js` runs `satellite.js` 6 in a Web Worker. It builds one orbit per object with `createOrbit(fields)` from `src/sky/orbit.js` (`sky-contract.md`, Orbit sources), which calls `json2satrec(toOmm(fields))`; OMM input supports six-digit catalog numbers. The logic lives in `src/visual/propagation-core.js`.
- The worker propagates every followed CelesTrak object at 2 Hz and posts positions as a transferable `Float32Array`. The main thread interpolates linearly between the last two samples each frame. Each sample is computed for 500 ms after the tick, so the frame time lies between the last two samples.
- When propagation returns no position, or the element set cannot be read, the object is omitted from that frame and the worker traces the satrec error code once per object and element set.
- The ISS is the `celestrak.stations` object with `noradId` `25544`; it is propagated like any other object.
- For every orbit source in the IR (`piece-dsl.md`, Orbits), the worker also computes the quantity at each 2 Hz step with the orbit's `sample` and posts it with the positions. `sky-contract.md` (Orbit sources) defines each quantity.
- Sources with `timeScale` above 1 propagate at `t₀ + (t − t₀) · timeScale`, where `t₀` is the engine start time.
- In replay, the propagator's clock runs at the replay speed from the replay window's start, so orbits stay consistent with the replayed elements.
- For `lines` and `trail`, the worker computes paths every 5 s on request; the renderer joins each trail to the object's current position.

### Propagator interface
`src/visual/propagator.js` exports `createPropagator(options)`, which starts the worker.

| Method | Effect |
|---|---|
| `follow(sky)` | Subscribes to the store's events for `celestrak.*` groups and sends element sets to the worker |
| `setGroups(groups)` | Sets the followed `celestrak.*` groups |
| `setObserver({ lat, lon })` | Observer for `sky` and `elevation` |
| `setOrbitSources(sources)` | `[{ objectId, group, quantity, timeScale }]`; `objectId` `null` computes the quantity for every object of `group` |
| `setClock({ simMs, wallMs, speed, t0SimMs })` | Simulated time is `simMs + (now − wallMs) · speed`; `t0SimMs` is the engine start |
| `setPaths(requests)` | `[{ key, group, fromSec, toSec, stepSec }]`, offsets from the current time |
| `positions(nowMs)` | `{ ids, data, stride, index }`, interpolated; omitted objects hold `NaN`; `index` maps object id to record number |
| `simTime(nowMs)` | Simulated time of the propagator's clock, or `null` before the first sample |
| `paths(key)` | The latest paths of one request |
| `orbitValue(objectId, quantity, timeScale)` | Latest value, or `null` |
| `onSample(fn)` | Calls `fn` after each sample; returns an unsubscribe function |
| `dispose()` | Terminates the worker |

A position record has 8 floats: ECI `x`, `y`, `z` (km), geodetic latitude and longitude (rad), altitude (km), and azimuth and elevation from the observer (rad).

## Audio-visual synchronization
Visuals that use `audio.*` are drawn at the time the listener hears the audio, not the time the engine schedules it. `src/visual/av-sync.js` exports this function:
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
| Flash area | Concurrent flashing area within any 10° visual field: 0.006 sr, about 25% of the field. At 1024×768 the field is 341×256 px; the renderer scales the field to 11.1% of the canvas area. |
| Limit | No flash area flashes more than 3 times in any 1 s period |

Guard algorithm (`src/visual/flash-guard.js`):
1. Every frame, measure two images at 64×48: the output (after the limit) and the scene (before it). Each cell is the mean of linear RGB over its part of the canvas, and every canvas pixel counts: a box pass averages whole pixels into a 512×384 grid (8×8 boxes per cell), and the cell pass averages its 64 boxes weighted by their pixel counts. One `readPixels` returns both grids (64×96).
2. Per cell, count general-flash and red-flash transitions over the last 1 s. A general transition is a change of relative luminance of at least 0.1 from the last extreme in the opposite direction, where the darker of the two values is below 0.8. A red transition is a change of u′v′ chromaticity above 0.2 from the last reference where either state is saturated red; black has the chromaticity of D65 white. Two transitions are one flash.
3. Slide a 21×16-cell window (the 10° field, 11.1% of the grid) over the grid. A cell flashes too often when its transitions in the last 1 s reach twice the flash limit, rounded down (at least 1). If such cells cover 25% or more of any window, for general or for red flashes, in the output or in the scene, the guard intervenes: it limits the change of every pixel's linear RGB values to 0.5 per second, counting at most 1/30 s per frame (under 1% per frame at 60 Hz, so no change faster than 3 flashes per second reaches 10%), and holds the colours and opacities of every layer, and the background, whose colour or opacity is an expression.
4. The intervention lasts until, in both the output and the scene, no window has cells with at least half of that transition count covering more than half of that area. Measuring the scene keeps the guard engaged while the scene underneath still strobes. After the intervention ends, the change limit stays on for 2 s, long enough for any pixel to reach the scene at 0.5 per second, so the held colours and the background return gradually instead of in one frame.
   - The two output targets hold 32-bit floats (`EXT_color_buffer_float`), so storage rounding never adds to a limited step. Without the extension they are 8-bit, and each limited step rounds toward the previous frame; a slow change can then stall while the guard intervenes, which is stricter.
   - A canvas resize copies the last output into the new targets, so the limit continues across a resize.
5. Each intervention emits a `SAFETY` trace record with event `flashLimit` (component `flash-guard`, level `warn`, `data` `{ "measured": "output" | "scene", "kind": "general" | "red", "cells": n, "window": [x, y] }`); its end emits `flashLimitEnd` at level `info` with `data` `{ "measured": … }`. The output and the scene each emit their own records.

The flash limit is `visual.maxFlashesPerSecond` (0–3); 0 intervenes on any single transition over the flash area. A fractional limit rounds down to whole transitions: 2.4 allows 4 transitions (2 flashes).

Photosensitivity warning: the guard averages each of its 64×48 cells and cannot rule out every pattern that affects people with photosensitive epilepsy, such as fine stripes or rapid movement. Before the first Run in a session, the start notice (`audio/audio-safety.md`, Safety UI) and the installation-mode "Begin listening" button read: "Photosensitivity warning: this piece shows moving and changing light. Flashing is limited to three per second, but some patterns can still affect people with photosensitive epilepsy. If you are sensitive to light, watch with care and stop if you feel unwell."

Reduced motion: when `prefers-reduced-motion: reduce` matches, or the setting forces it, trails, ring pulses, glyph fades, aurora drift and camera motion are off, and data-driven changes apply in steps no faster than 1 Hz. Concretely, `trail` and `fade` are 0, `drift` is 0, the camera does not turn, and the renderer applies new property values (from sky events and from `audio.*`) at most once per second, so ring radii driven by audio step instead of pulsing. Orbital motion of objects continues; it is not a data change.

Bursts: trigger rate limits (`bindings.md`) apply to visual event effects as well.

## Open items
- Verify `getOutputTimestamp()` values in Safari before relying on them; the fallback applies when they are non-finite.

## Sources
- W3C, Understanding Success Criterion 2.3.1 Three Flashes or Below Threshold: https://www.w3.org/WAI/WCAG22/Understanding/three-flashes-or-below-threshold.html
- satellite.js: https://github.com/shashwatak/satellite-js
- MDN, AudioContext.getOutputTimestamp(): https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/getOutputTimestamp
- MDN, AudioContext.outputLatency: https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/outputLatency
- MDN, prefers-reduced-motion: https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion
