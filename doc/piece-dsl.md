# Piece DSL

## Scope
The TypeScript builder API that users write, its types, the expression language, the IR schema, validation, versioning, the sandbox, type checking and hot reload.

## Model
- A **script** is TypeScript written in the editor (`piece.ts`). It calls builder functions and returns nothing. Plain JavaScript is valid script source, since the type annotations are optional.
- Running a script in the sandbox produces an **IR**: a JSON document that describes instruments, effects, modulation, bindings, reactions, the view and layers.
- The IR is the only thing that is validated, stored, executed, tested and shared. No script code runs during playback, except the local-only `fn` escape hatch.
- Mappings are **expressions**: chained builder calls that compile to JSON expression nodes.
- Builders that accept a function call it once, at build time, with a typed **object proxy** whose properties build expression nodes (Typed objects). The function's result is data; no function appears in the IR.
- Types guide authoring and appear as editor problems. The IR validator alone decides whether a piece runs.

## Example script
```ts
scale('D', 'lydian');
seed(7);
tempo(72);

const stations = additive({ volume: -12, attack: 1.5, release: 4, vibratoDepth: 6 });
const neo      = subtractive({ volume: -14, waveform: 'sawtooth', attack: 1.5, release: 4 });
const debris   = granular({ volume: -18, source: 'noise' });
const scout    = fm({ volume: -16, ratio: 3.5, index: 6, indexDecay: 2 });
const launch   = pluck({ volume: -10, decay: 6, damping: 0.3 });

const verb = reverb({ size: 0.85, decay: 6, mix: 0.3 });
const echo = delay({ time: 500, feedback: 0.4, mix: 0.25 });
const grit = saturation({ drive: 6, mix: 0.5 });
stations.fx(echo, verb);
neo.fx(grit);
master.fx(eq3({ lowGain: -2 }), compressor({ threshold: -20, ratio: 3 }));

const breathe = lfo({ shape: 'sine', rate: 0.03 });
const shimmer = lfo({ shape: 'smooth', rate: sky.swpc('wind.speed').map(300, 800, 0.1, 3) });

verb.decay.mod(breathe, { depth: 0.2 });
echo.time.mod(shimmer, { depth: 0.05 });
echo.feedback.mod(sky.swpc('kp.kp').map(0, 9, -1, 1), { depth: 0.4 });
grit.drive.mod(sky.swpc('mag.bz').map(-20, 20, 1, -1), { depth: 0.3 });
stations.cutoff.mod(breathe, { depth: 0.1 });

sky.group('celestrak.stations').voices(stations, {
  pitch: field('meanMotion').octaveInto(110, 440).quantize(),
  pan:   field('raan').map(0, 360, -0.8, 0.8),
});

sky.group('jpl.cad').top(6, 'distLD', 'asc').voices(neo, {
  pitch:    field('vRel').map(5, 30, 36, 60).quantize(),
  velocity: field('distLD').map(0.5, 10, 100, 20),
});

sky.group('jpl.scout').on('enter').trigger(scout, {
  pitch: rand(72, 84).quantize(), maxPerSecond: 1,
});

sky.group('ll2.upcoming').on('update')
  .when(field('status').eq('In Flight'))
  .trigger(launch, { pitch: 38, durationMs: 4000 });

debris.density.follow(sky.group('celestrak.cosmos-2251-debris').count().map(200, 1000, 2, 30));
stations.vibratoDepth.follow(sky.swpc('kp.kp').map(0, 9, 2, 40), { smoothMs: 2000 });
neo.cutoff.follow(sky.swpc('wind.speed').map(300, 800, 300, 4000, 'log'));

onStale('*', { detuneCents: 25 });
onDown('*', { only: [stations] });

view.projection('orbital');
view.background('#05070c');

layer.points(sky.group('celestrak.cosmos-2251-debris'), { size: 1, color: '#7f8ea3', opacity: 0.4 });
layer.points(sky.group('celestrak.stations'), {
  size: audio.voice(stations).env().map(0, 1, 3, 9), color: '#f6e05e', trail: 600,
});
layer.aurora({ intensity: sky.swpc('kp.kp').map(3, 9, 0, 1) });
```

## Builder API
### Piece
| Call | Effect |
|---|---|
| `scale(root, mode)` | Sets the scale used by `.quantize()`. `root`: note name `C`–`B` with optional `#` or `b`. `mode`: `major`, `minor`, `dorian`, `phrygian`, `lydian`, `mixolydian`, `locrian`, `pentatonic`, `chromatic`. Default `C`, `chromatic`. |
| `seed(n)` | Sets the piece seed (integer). Default 1. |
| `tempo(bpm)` | Sets the tempo for synced delay times and synced LFOs, 20–300. Default 120. |

### Instruments
`additive(opts)`, `subtractive(opts)`, `fm(opts)`, `pluck(opts)`, `granular(opts)` each create one instrument and return a handle.

| Option | Meaning |
|---|---|
| `volume` | Widget volume in dB, −60 to 0. Default −6. |
| `octave` | −3 to 3. Default 0. |
| `cents` | −100 to 100. Default 0. |
| Any `PARAM_DEFS[type]` name | Initial parameter value, clamped by `coerceParam` |

The builders and handle properties are generated from `PARAM_DEFS` (`audio/synthesis-conventions.md`). An unknown option name is a build error. Granular `source: 'sample'` is a build error; pieces cannot load audio files.

Each numeric parameter is a handle property with two methods:

| Call | Effect |
|---|---|
| `inst.<param>.follow(expr, { smoothMs })` | Sets the parameter's base value from an expression. `smoothMs` default 250. |
| `inst.<param>.mod(source, { depth, smoothMs })` | Adds a modulation route (Modulation). |

| Call | Effect |
|---|---|
| `inst.fx(...slots)` | Sets the instrument's insert chain, in order. Calling it again replaces the chain. |

### Effects
`eq3(opts)`, `filter(opts)`, `compressor(opts)`, `saturation(opts)`, `distortion(opts)`, `delay(opts)` and `reverb(opts)` each create one effect slot and return a handle. Options are initial parameter values from the effect's `ParamDef` list (`audio/effects.md`), plus `bypass` (boolean, default `false`). Enum options take option names, for example `filter({ mode: 'highpass' })`.

| Call | Effect |
|---|---|
| `master.fx(...slots)` | Sets the master chain, in order |
| `slot.<param>.follow(expr, { smoothMs })` | Sets the effect parameter's base value from an expression |
| `slot.<param>.mod(source, { depth, smoothMs })` | Adds a modulation route |
| `slot.bypass.follow(expr)` | Bypasses the slot while `expr` is true |

A slot belongs to one chain. Passing one slot handle to two chains is a build error.

### Modulation
| Call | Returns |
|---|---|
| `lfo({ shape, rate, phase, retrigger, smooth })` | LFO handle. `rate` is a number in Hz, a sync name such as `'1/4d'`, or an expression mapped to Hz. |

An expression `rate` must end in `.map(...)` or `.clamp(...)`; that step's output range becomes the rate range (`min`, `max` in the IR), clamped to 0.01–20 Hz. Any other expression is a build error with code `lfo_rate_range`.

`.mod(source, opts)` accepts an LFO handle or an expression. An expression source is a data source: its value must lie in −1 to 1 (values outside are clamped), and `smoothMs` (default 250) sets its smoothing. `depth` is −1 to 1 in normalized units; depth 0.1 on a log parameter spanning 10 octaves moves one octave. `audio/modulation.md` defines the model, `down` parameters and evaluation.

### Sky
| Call | Returns |
|---|---|
| `sky.group(key)` | Group handle |
| `group.top(n, field, order)` | Group handle restricted to the first `n` objects by `field`; `order` is `desc` (default) or `asc` |
| `group.voices(inst, opts)` | Sustained-voice binding; `opts` is `{ pitch, velocity, pan, voiceMods }` or a function of the group's object proxy returning it |
| `group.on(kind)` | Event handle; `kind` is `enter`, `update` or `exit` |
| `event.when(expr)` | Event handle with a condition; `expr` is an expression or a function of the object proxy returning one |
| `event.trigger(inst, opts)` | Trigger binding; `opts` is `{ pitch, velocity, durationMs, maxPerSecond }` or a function of the object proxy returning it |
| `group.count()` | Expression: number of live objects |
| `group.mean(field)` | Expression: mean of a numeric field |
| `group.spread(field)` | Expression: maximum minus minimum of a numeric field |
| `sky.swpc(path)` | Expression: SWPC value; `path` is `kp.<field>`, `wind.<field>` or `mag.<field>` |
| `sky.value(objectId, field)` | Expression: one field of one object |
| `orbit(quantity, opts)` | Expression: a VLFO from the current object's orbital motion (Orbits) |
| `sky.orbit(objectId, quantity, opts)` | Expression: a VLFO from one named object's orbital motion |

Defaults: `velocity` 64, `durationMs` 250, `maxPerSecond` 2.

### Orbits
Orbital motion is a very-low-frequency oscillator (VLFO): periodic, continuous and computed for every instant from the object's orbital elements. Orbit expressions apply to `celestrak.*` objects only.

| Quantity | Output | Period (ISS) |
|---|---|---|
| `latitude` | Geodetic latitude divided by the orbit's maximum latitude, −1 to 1 | One orbit (~92 min) |
| `phaseSin`, `phaseCos` | Sine and cosine of the argument of latitude (angle from the ascending node), −1 to 1 | One orbit |
| `altitude` | `2 · (alt − perigeeAlt) / (apogeeAlt − perigeeAlt) − 1`; 0 when the difference is below 1 km | One orbit |
| `longitude` | Sub-satellite longitude divided by 180, −1 to 1 | One orbit relative to Earth's rotation |
| `sunlit` | 1 in sunlight, −1 in Earth's cylindrical shadow | One orbit; square wave |
| `elevation` | Elevation above the observer's horizon (settings `data.observer`) divided by 90, −1 to 1 | Varies; passes last minutes |

| Option | Values | Default |
|---|---|---|
| `timeScale` | 1–1000; multiplies elapsed time from the engine start | 1 |

- A VLFO is an expression: it is valid in `.mod()` (as a data source), in `follow`, in voice options (`pan`, `voiceMods`, `velocity`) and in layer properties.
- `orbit(...)` refers to the current object and is valid where a current object exists: voice options, trigger options and layer properties. `sky.orbit(...)` is valid everywhere.
- With `timeScale` above 1, the value does not match the object's real position. The console labels the source `time-scaled ×n`, and layers keep real positions.
- Orbit expressions are re-evaluated at 2 Hz, the propagation rate. Their default `smoothMs` as modulation sources is 500.
- On a group without orbital elements, `orbit` is a build error with code `orbit_no_elements`.

```ts
const pad = additive({ volume: -12, attack: 1.5, release: 4 });
sky.group('celestrak.stations').voices(pad, {
  pitch: field('meanMotion').octaveInto(110, 440),
  pan:   orbit('phaseCos'),                                  // circles the stereo field once per orbit
});
pad.cutoff.mod(sky.orbit('celestrak.stations:25544', 'sunlit'), { depth: 0.15, smoothMs: 4000 });
pad.vibratoDepth.follow(sky.orbit('celestrak.stations:25544', 'latitude').map(-1, 1, 0, 30));
```

### Reactions
| Call | Effect |
|---|---|
| `onStale(source, actions)` | Applies `actions` while `source` is `stale` |
| `onDown(source, actions)` | Applies `actions` while `source` is `down` |

`source` is a registry id, a group key, or `'*'`. Actions: `{ detuneCents: n }`, `{ mute: [inst, ...] }`, `{ only: [inst, ...] }`, `{ desaturate: 0–1 }`.

### Typed objects
A function passed to `voices`, `when`, `trigger` or a layer constructor receives the group's object proxy `o`:

```ts
sky.group('jpl.cad').top(6, 'distLD', 'asc').voices(swell, (o) => ({
  pitch:    o.vRel.map(5, 30, 36, 60).quantize(),
  velocity: o.distLD.map(0.5, 10, 100, 20),
}));

sky.group('ll2.upcoming').on('update')
  .when((o) => o.status.eq('In Flight'))
  .trigger(string, { pitch: 38, durationMs: 4000 });
```

- `o.<name>` is equivalent to `field('<name>')`, typed by the group's field list: `Expr<number>` for numeric fields, `Expr<string>` for text fields.
- `o.orbit(quantity, opts)` is equivalent to `orbit(quantity, opts)` and exists only on `celestrak.*` proxies.
- The function runs once per build. It cannot read data values; reading `o.vRel` returns an expression, not a number.
- A property not in the group's field list is a type error. At build time it produces the same node as `field(name)` and the `unknown_field` warning.

## Types
`src/dsl/builder.d.ts` declares the global builder API. Its types are generated from `PARAM_DEFS`, the effect registry, `src/visual/layer-defs.js` and `src/sky/groups.json`.

| Type | Meaning |
|---|---|
| `Expr<T>` | An expression producing `T` (`number`, `string` or `boolean`). Steps are typed: `.map` exists on `Expr<number>`; `.eq` accepts a value of the same `T`; `.gt`, `.lt` return `Expr<boolean>`. |
| `Num` | `number \| Expr<number>`; accepted wherever a numeric value is expected |
| `Pitch` | `Num`, in MIDI note numbers |
| `GroupKey` | Union of the group keys in `groups.json` |
| `ObjectId<G>` | Template literal type `` `${G}:${string}` `` |
| `Fields<G>` | Field names and value types of group `G`, from `groups.json` |
| `ObjectProxy<G>` | `{ [K in keyof Fields<G>]: Expr<Fields<G>[K]> }`, plus `orbit` when `G` is a `celestrak.*` key |
| `ParamsOf<T>` | Option object of instrument or effect type `T`: numeric params as `number`, enum params as their option-name union, `harmonics` as an 8-tuple |
| `Handle<T>` | An instrument or effect handle; each numeric parameter has `follow` and `mod`; `mod` exists only on modulatable parameters |
| `OrbitQuantity` | `'latitude' \| 'phaseSin' \| 'phaseCos' \| 'altitude' \| 'longitude' \| 'sunlit' \| 'elevation'` |
| `SwpcPath` | `'kp.kp' \| 'kp.kpEstimated' \| 'wind.speed' \| ...` |

Each `groups.json` entry lists its fields with a type, `number`, `string` or `boolean`, which the generator reads. Types encode names, kinds and option values. Numeric ranges are not types; the validator and `coerceParam` enforce them.

### Visuals
`view.*`, `layer.*` and `audio.*` are defined in `visuals.md`.

### Escape hatch
| Call | Effect |
|---|---|
| `fn(source)` | An expression computed by a JavaScript function given as a string, for example `fn('o => o.fields.inclination / 2')`. The string is not type-checked. |

A piece that uses `fn` or `layer.shader` sets `localOnly: true`. It runs in the editor but cannot be saved to Supabase with `local_only = false` or shared. `fn` is valid only in binding expressions, not in layer properties. The sandbox worker stays alive in local-only mode and evaluates each `fn` asynchronously; results apply when they return.

## Expressions
An expression is a chain that starts from a source and applies steps.

| Source | Value |
|---|---|
| `field(name)` | Field of the current object; `null` when absent |
| `num(x)` or a numeric literal | Constant |
| `rand(lo, hi)` | Deterministic number in `[lo, hi)` seeded by the piece seed, binding id and object id |
| `sky.swpc`, `sky.value`, `group.count/mean/spread` | See Sky |
| `audio.*` | See `visuals.md`; valid in layer properties only |

| Step | Result |
|---|---|
| `.map(inMin, inMax, outMin, outMax, curve)` | Linear (`lin`, default), `log` or `exp` mapping, clamped to the output range |
| `.clamp(lo, hi)` | Clamped value |
| `.octaveInto(loHz, hiHz)` | Treats the input as a frequency, multiplies or divides by 2 until it lies in `[loHz, hiHz)`, and returns the MIDI pitch (fractional) |
| `.quantize()` | Nearest pitch in the piece scale |
| `.add(x)`, `.sub(x)`, `.mul(x)`, `.div(x)` | Arithmetic; `x` is a number or expression |
| `.abs()`, `.neg()`, `.round()` | Unary arithmetic |
| `.eq(x)`, `.gt(x)`, `.lt(x)` | Boolean |
| `.and(e)`, `.or(e)`, `.not()` | Boolean |

Pitch values are MIDI note numbers and may be fractional. Velocity values are 1–127. Pan values are −1 to 1.

Evaluation rules:
- `null` propagates: any step with a `null` input returns `null`.
- A non-finite number becomes `null`.
- A voice whose pitch evaluates to `null` is not started. A trigger whose pitch is `null` does not fire. A parameter that evaluates to `null` keeps its last value.

## IR
### Expression nodes
```json
{ "op": "map", "args": [ { "op": "field", "args": ["vRel"] }, 5, 30, 36, 60, "lin" ] }
```
Every node is `{ "op": string, "args": array }`. Arguments are numbers, strings, booleans, `null` or nodes. The op set is exactly the sources and steps above (`field`, `num`, `rand`, `swpc`, `value`, `count`, `mean`, `spread`, `map`, `clamp`, `octaveInto`, `quantize`, `add`, `sub`, `mul`, `div`, `abs`, `neg`, `round`, `eq`, `gt`, `lt`, `and`, `or`, `not`, `level`, `spectrum`, `env`, `orbit`, `local`). `orbit` takes `[quantity, objectId | null, timeScale]`; `null` means the current object.

### Document
```json
{
  "irVersion": 1,
  "seed": 7,
  "tempo": 72,
  "scale": { "root": "D", "mode": "lydian" },
  "instruments": [
    { "id": "i0", "type": "additive", "volumeDb": -12, "octave": 0, "cents": 0,
      "params": { "attack": 1.5, "release": 4, "vibratoDepth": 6 },
      "fx": [
        { "id": "f0", "type": "delay", "params": { "time": 500, "feedback": 0.4, "mix": 0.25 }, "bypass": false },
        { "id": "f1", "type": "reverb", "params": { "size": 0.85, "decay": 6, "mix": 0.3 }, "bypass": false }
      ] }
  ],
  "master": {
    "fx": [ { "id": "f2", "type": "compressor", "params": { "threshold": -20, "ratio": 3 }, "bypass": false } ]
  },
  "lfos": [
    { "id": "lfo0", "shape": "sine", "rate": 0.03, "phase": 0, "retrigger": false, "smooth": 0 }
  ],
  "mods": [
    { "target": "f1.decay", "source": { "lfo": "lfo0" }, "depth": 0.2, "smoothMs": 250 },
    { "target": "f0.feedback",
      "source": { "expr": { "op": "map", "args": [ { "op": "swpc", "args": ["kp.kp"] }, 0, 9, -1, 1, "lin" ] } },
      "depth": 0.4, "smoothMs": 250 },
    { "target": "i0.cutoff", "source": { "lfo": "lfo0" }, "depth": 0.1, "smoothMs": 250 }
  ],
  "bindings": [
    { "id": "b0", "kind": "voices", "inst": "i0", "group": "celestrak.stations",
      "select": null,
      "pitch": { "op": "quantize", "args": [ { "op": "octaveInto", "args": [ { "op": "field", "args": ["meanMotion"] }, 110, 440 ] } ] },
      "velocity": 64,
      "pan": { "op": "map", "args": [ { "op": "field", "args": ["raan"] }, 0, 360, -0.8, 0.8, "lin" ] },
      "voiceMods": {} },
    { "id": "b1", "kind": "trigger", "inst": "i0", "group": "jpl.scout", "event": "enter",
      "when": null, "pitch": 76, "velocity": 64, "durationMs": 250, "maxPerSecond": 1 },
    { "id": "b2", "kind": "param", "inst": "i0", "param": "vibratoDepth",
      "expr": { "op": "map", "args": [ { "op": "swpc", "args": ["kp.kp"] }, 0, 9, 2, 40, "lin" ] },
      "smoothMs": 2000 }
  ],
  "reactions": [
    { "on": "stale", "source": "*", "actions": { "detuneCents": 25 } },
    { "on": "down",  "source": "*", "actions": { "only": ["i0"] } }
  ],
  "view": { "projection": "orbital", "background": "#05070c" },
  "layers": [
    { "id": "l0", "type": "points", "group": "celestrak.stations",
      "props": { "size": 3, "color": "#f6e05e", "opacity": 1, "trail": 600 } }
  ],
  "groups": ["celestrak.stations", "jpl.scout", "swpc.kp"],
  "localOnly": false
}
```
- Ids are assigned in creation order: `i<n>` (instruments), `f<n>` (effect slots), `lfo<n>` (LFOs), `b<n>` (bindings), `l<n>` (layers). A script edit that keeps creation order keeps ids, which hot reload relies on.
- `mods[].target` is `<instrument id>.<param>` or `<slot id>.<param>`. `source` is `{ "lfo": id }` or `{ "expr": node }`.
- An LFO `rate` is a number, `{ "sync": name }` or `{ "expr": node, "min": hz, "max": hz }`.
- `master` and each instrument's `fx` are always present; an empty chain is `[]`.
- `select` is `null` or `{ "top": n, "by": field, "order": "asc" | "desc" }`.
- `groups` lists every group referenced by a binding, expression or layer, including `swpc.*` groups referenced by `sky.swpc`. On save, the page replaces the project's `project_subscriptions` rows with these values.

### Schema file
`src/dsl/ir.schema.json` is a JSON Schema (draft 2020-12) for the document. Validation runs the schema check, then the semantic checks below.

## Validation
| Check | Rule |
|---|---|
| Instruments | At most 16. `type` is a `PARAM_DEFS` key. Every param name exists for the type. `granular.source` is not `sample`. |
| Bindings | At most 64. `inst` exists. `param` is a numeric param of the instrument's type. |
| Voices | `select.top` at most 16, or 4 for granular. Without `select`, a group larger than the cap uses the first objects by id. |
| Triggers | `maxPerSecond` 0.1–20. `durationMs` 20–10000. |
| Effects | At most 8 slots per chain and 4 `reverb` slots per piece. `type` is an effect registry key. Every param exists for the type. Each slot id appears in one chain. |
| Modulation | At most 16 LFOs, 2 `retrigger` LFOs per instrument, 32 routes, 4 routes per target. `depth` −1 to 1. Targets exist and are modulatable (not `enum`, array or `mod: null`). LFO `rate` 0.01–20 Hz. `tempo` 20–300. |
| Layers | At most 16. Props exist in `src/visual/layer-defs.js`. |
| Groups | Every group key exists in the source registry, copied to `src/sky/groups.json` at build time. |
| Orbits | `orbit` and `sky.orbit` reference `celestrak.*` groups or objects; `quantity` is a listed quantity; `timeScale` 1–1000; at most 64 distinct (object, quantity, timeScale) orbit sources per piece. |
| Expressions | Depth at most 32. Every `op` is known with the right argument count. `audio.*` ops appear only in layer props. |
| Size | Serialized IR at most 256 KB. Script source at most 200,000 characters. |

### Problem codes
| Code | Severity | Condition |
|---|---|---|
| `syntax_error` | error | The script does not parse as TypeScript |
| `runtime_error` | error | The script throws while running |
| `timeout` | error | No result within 1500 ms |
| `unknown_option` | error | An option name is not a parameter of the instrument or effect type |
| `not_numeric` | error | `follow` or `mod` on an array or enum parameter where a number is required |
| `not_modulatable` | error | `mod` on an enum, array or `mod: null` parameter |
| `unknown_group` | error | A group key is not in `groups.json` |
| `unknown_field` | warning | No object of the group's last snapshot has the field |
| `granular_sample` | error | Granular `source: 'sample'` |
| `slot_reused` | error | One effect slot in two chains |
| `lfo_rate_range` | error | An expression LFO rate does not end in `map` or `clamp` |
| `audio_outside_layer` | error | An `audio.*` op outside layer properties |
| `fn_in_layer` | error | `fn` in a layer property |
| `expr_too_deep` | error | Expression depth above 32 |
| `orbit_no_elements` | error | `orbit` or `sky.orbit` on a group or object without orbital elements |
| `orbit_quantity` | error | Unknown orbit quantity |
| `orbit_no_object` | error | `orbit(...)` where no current object exists; use `sky.orbit(...)` |
| `limit_<item>` | error | A count limit in the table above is exceeded; `<item>` is `instruments`, `bindings`, `voices`, `slots`, `reverbs`, `lfos`, `retrigger_lfos`, `routes`, `routes_per_target`, `layers`, `orbit_sources` |
| `ir_too_large` | error | Serialized IR above 256 KB |
| `ir_version_unsupported` | error | `irVersion` above the current version |
| `local_only` | warning | The piece uses `fn` or `layer.shader` |
| `type_error` | warning | The type checker reports an error; the message and position come from TypeScript |

`src/dsl/problem-codes.js` is the single list of codes. The guide's troubleshooting page (`content/learn/troubleshooting.md`) documents every user-facing code; a test checks that both lists match.

A problem is `{ "severity": "error" | "warning", "code": string, "path": string, "line": number | null, "message": string }`. `path` is a JSON Pointer into the IR. The builder records the script line of each builder call so problems point at source lines. Any error blocks Run and Save; warnings do not.

## Versioning
- `irVersion` is an integer. `src/dsl/migrations.js` exports `migrations[n]`, a pure function from version `n` to `n + 1`, each with its own test.
- Loading applies migrations in order, then validates. A version greater than the current one is rejected with code `ir_version_unsupported`.
- Renaming, removing or changing the unit of any IR field requires a version bump.

## Sandbox
- The script runs in a dedicated Web Worker loaded from `/dsl-sandbox.js`. The page posts `{ source }` and receives `{ ir, problems }`.
- The worker removes TypeScript syntax with Sucrase (`transforms: ['typescript']`), which performs no type checking, then evaluates the result. Sucrase preserves line numbers, so problem positions refer to the TypeScript source. A Sucrase parse error is the problem `syntax_error`.
- The response for `/dsl-sandbox.js` carries its own policy, set in `next.config.ts` headers: `Content-Security-Policy: default-src 'none'; script-src 'self' 'unsafe-eval'`. The worker can evaluate the script but has no network access.
- Before evaluating the script, the worker also deletes `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `importScripts` and `indexedDB` from its global scope.
- The page calls `worker.terminate()` if no response arrives within 1500 ms and reports problem `timeout`.
- The script receives only the builder API. It cannot reach the page, the audio context, the database or the DOM.
- Loading another user's piece runs only its IR. Its source runs only if opened in the editor and run.

## Hot reload
On save in the editor:
1. Run the script in the sandbox and validate the IR. On any error, show the problems and keep the running piece unchanged.
2. Diff the IR against the running IR by id, using canonical-JSON equality per entry.
3. Instruments: pass the full widget list to `Engine.sync` (`bindings.md`). The engine applies changed params with smoothing and fades out removed instruments.
4. Effects: call `setFx` for each chain whose slot list changed. Slots with unchanged id and type keep their state, including reverb and delay tails.
5. Modulation: call `setLfos` and `setMods` when either list changed. Unchanged LFOs keep their phase.
6. Bindings: unbind and rebind each changed or removed binding. Unchanged bindings keep their sounding voices.
7. Layers: rebuild changed layers. Unchanged layers keep their GPU buffers and trails.
8. Emit a `RELOAD` trace record listing changed ids.

## Type checking
- A type-check worker (`src/dsl/typecheck-worker.ts`) runs the TypeScript compiler over `piece.ts` with `@typescript/vfs`. The page loads it the first time the editor opens. `/listen`, `/try` run mode and `/projects/[id]/run` never load it.
- The virtual file system contains `piece.ts`, `builder.d.ts` and the ES2022 library declarations, bundled with the app. The worker fetches no files at runtime.
- Compiler options: `strict: true`, `target: 'ES2022'`, `lib: ['ES2022']`, `noEmit: true`, `types: []`. No DOM types are present; scripts have no DOM.
- The worker re-checks 300 ms after the last edit and returns diagnostics, completions and hover text. Each diagnostic becomes a `type_error` warning in Problems.
- Type errors do not block Run or Save. Build and validator errors do.

## Editor support
The editor's completion, hover and inline problems come from the type-check worker (`ui.md`). Until the worker has loaded, completion reads `PARAM_DEFS`, the effect registry, `layer-defs.js` and `groups.json` directly. The user guide (`guide.md`) teaches the API to people.

## Open items
- Verify that Safari applies the `/dsl-sandbox.js` response CSP to the worker. Where it does not, the global deletions in the worker are the only network barrier.
- Measure the gzipped size of the type-check worker bundle (TypeScript compiler, `@typescript/vfs`, ES2022 library declarations) before release.

## Sources
- MDN, Web Workers API: https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API
- W3C, Content Security Policy Level 3, workers: https://www.w3.org/TR/CSP3/
- Sucrase: https://github.com/alangpierce/sucrase
- TypeScript, `@typescript/vfs`: https://www.npmjs.com/package/@typescript/vfs
- JSON Schema 2020-12: https://json-schema.org/draft/2020-12
- User audio engine: `doc/audio/synthesis-conventions.md` (`PARAM_DEFS`), `doc/audio/effects.md`, `doc/audio/modulation.md`
