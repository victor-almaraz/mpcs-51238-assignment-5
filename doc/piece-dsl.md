# Piece DSL

## Scope
The TypeScript language that users write: the builder API, programs, their types, the expression language, the IR schema, validation, versioning, the sandbox (the VM), type checking and hot reload.

## Model
- A **script** is a TypeScript program written in the editor (`piece.ts`). Plain JavaScript is valid script source, since the type annotations are optional.
- The script runs in the sandbox worker, which is the program's VM. Sky data is its input; instruments, effect parameters and layers are its output.
- **Setup** is the script's top-level code. It runs when the piece is built and, for a piece with handlers, again each time the program starts (VM). It opens the IO devices (instruments, effects, LFOs, layers, the view), declares bindings, and registers **handlers** (Program).
- While the piece plays, the VM keeps the script's variables and calls its handlers on sky events, timers and freshness changes. Handlers read live values and send commands. The page checks every command at the IO boundary before the engine or renderer receives it (`bindings.md`, Program host).
- Building produces an **IR**: a JSON document that describes instruments, effects, modulation, bindings, reactions, the view, layers and the registered handlers. The IR is what is validated, stored and diffed on hot reload. A piece without handlers plays from its IR alone; a piece with handlers needs its source and the VM.
- **Bindings** are the declarative part of the language: expressions (chained builder calls that compile to JSON expression nodes) that the binding runtime evaluates without script code. Builders that accept a function call it once, at build time, with a typed **object proxy** whose properties build expression nodes (Typed objects).
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
grit.drive.mod(sky.swpc('mag.bz').map(-10, 10, 1, -1), { depth: 0.3 });
neo.cutoff.mod(breathe, { depth: 0.1 });

sky.group('celestrak.stations').voices(stations, {
  pitch: field('meanMotion').octaveInto(110, 440).quantize(),
  pan:   field('raan').map(0, 360, -0.8, 0.8),
});

sky.group('jpl.cad').top(6, 'distLD', 'asc').voices(neo, {
  pitch:    field('vRel').map(0, 15, 36, 60).quantize(),
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
layer.aurora({ intensity: sky.swpc('kp.kp').map(0, 9, 0.3, 1) }); // visible when quiet, brighter in storms
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

The builders and handle properties are generated from `PARAM_DEFS` (`audio/synthesis-conventions.md`). An unknown option name is a build error (`unknown_option`). Granular `source: 'sample'` is a build error (`granular_sample`); pieces cannot load audio files. Numeric options outside their range move to the nearest end; a value of the wrong kind (text for a number, an unknown choice name) is a `runtime_error` naming the option.

Each numeric parameter is a handle property with two methods:

| Call | Effect |
|---|---|
| `inst.<param>.follow(expr, { smoothMs })` | Sets the parameter's base value from an expression. `smoothMs` default 250. A choice parameter receives the option index. |
| `inst.<param>.mod(source, { depth, smoothMs })` | Adds a modulation route (Modulation). `depth` is required. |

Array parameters (additive `harmonics`) accept neither `follow` nor `mod`. They are set in the constructor and, from a handler, with `inst.harmonics.set(values)` (Program, Output).

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

A slot belongs to one chain. Passing one slot handle to two chains is a build error (`slot_reused`). A slot with `follow` or `mod` that is in no chain is a build error (`slot_unplaced`).

### Modulation
| Call | Returns |
|---|---|
| `lfo({ shape, rate, phase, retrigger, smooth })` | LFO handle. `rate` is a number in Hz, a sync name such as `'1/4d'`, or an expression mapped to Hz. |

| Option | Values | Default |
|---|---|---|
| `shape` | `sine`, `triangle`, `square`, `saw`, `random`, `smooth` | `sine` |
| `rate` | 0.01–20 Hz, a sync name, or an expression | 0.1 Hz |
| `phase` | 0–1 | 0 |
| `retrigger` | `true` or `false` | `false` |
| `smooth` | 0–1 | 0.5 for `smooth`, otherwise 0 |

An expression `rate` must end in `.map(...)` or `.clamp(...)`; that step's output range becomes the rate range (`min`, `max` in the IR), clamped to 0.01–20 Hz. Any other expression, and a range that is empty after clamping (`min` not below `max`, for example `.map(0, 9, 5, 5)` or `.map(0, 9, 25, 30)`), is a build error with code `lfo_rate_range`.

`.mod(source, opts)` accepts an LFO handle or an expression. An expression source is a data source: its value must lie in −1 to 1 (values outside are clamped), and `smoothMs` (default 250) sets its smoothing. `depth` is −1 to 1 in normalized units; depth 0.1 on a log parameter spanning 10 octaves moves one octave. `audio/modulation.md` defines the model, `down` parameters and evaluation.

### Sky
| Call | Returns |
|---|---|
| `sky.group(key)` | Group handle |
| `group.top(n, field, order)` | Group handle restricted to the first `n` objects by `field` (`n` rounded down, at least 1); `order` is `desc` (default) or `asc` |
| `group.voices(inst, opts)` | Sustained-voice binding; `opts` is `{ pitch, velocity, pan, voiceMods }` or a function of the group's object proxy returning it |
| `group.on(kind)` | Event handle; `kind` is `enter`, `update` or `exit` |
| `event.when(expr)` | Event handle with a condition; `expr` is an expression or a function of the object proxy returning one. A second `when` combines with the first by `and`. |
| `event.trigger(inst, opts)` | Trigger binding; `opts` is `{ pitch, velocity, durationMs, maxPerSecond }` or a function of the object proxy returning it |
| `group.count()` | Expression: number of live objects |
| `group.mean(field)` | Expression: mean of a numeric field |
| `group.spread(field)` | Expression: maximum minus minimum of a numeric field |
| `sky.swpc(path)` | Expression: SWPC value; `path` is `kp.<field>`, `wind.<field>` or `mag.<field>` |
| `sky.value(objectId, field)` | Expression: one field of one object |
| `orbit(quantity, opts)` | Expression: a VLFO from the current object's orbital motion (Orbits) |
| `sky.orbit(objectId, quantity, opts)` | Expression: a VLFO from one named object's orbital motion |

Defaults: `velocity` 100, `pan` 0, `durationMs` 250, `maxPerSecond` 2. `pitch` is required. Constant pitches clamp to 0–127, velocities to 1–127 and pans to −1–1. A `top(...)` selection applies to voices, triggers (events of objects outside the selected set are ignored) and layers; `count`, `mean` and `spread` read the whole group.

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
| `timeScale` | 1–1000; multiplies elapsed time since the time origin of the orbit propagator's clock (`visuals.md`, Orbit propagation) | 1 |

- A VLFO is an expression: it is valid in `.mod()` (as a data source), in `follow`, in voice options (`pan`, `voiceMods`, `velocity`) and in layer properties.
- `orbit(...)` refers to the current object and is valid where a current object exists: voice options, trigger options and layer properties. `sky.orbit(...)` is valid everywhere.
- With `timeScale` above 1, the value does not match the object's real position. The console labels the source `time-scaled ×n`, and layers keep real positions.
- Orbit expressions are re-evaluated at 2 Hz, the propagation rate. Their default `smoothMs` as modulation sources is 500.
- On a group without orbital elements, `orbit` is a build error with code `orbit_no_elements`.

```ts
const pad  = additive({ volume: -12, attack: 1.5, release: 4 });
const tone = filter({ cutoff: 3000 });
pad.fx(tone);
sky.group('celestrak.stations').voices(pad, {
  pitch: field('meanMotion').octaveInto(110, 440),
  pan:   orbit('phaseCos'),                                  // circles the stereo field once per orbit
});
tone.cutoff.mod(sky.orbit('celestrak.stations:25544', 'sunlit'), { depth: 0.15, smoothMs: 4000 });
pad.vibratoDepth.follow(sky.orbit('celestrak.stations:25544', 'latitude').map(-1, 1, 0, 30));
```

### Reactions
| Call | Effect |
|---|---|
| `onStale(source, actions)` | Applies `actions` while `source` is `stale` |
| `onDown(source, actions)` | Applies `actions` while `source` is `down` |

`source` is a registry id, a group key, or `'*'`. Actions: `{ detuneCents: n }` (−100 to 100), `{ mute: [inst, ...] }`, `{ only: [inst, ...] }`, `{ desaturate: 0–1 }`; one reaction may combine several.

### Typed objects
A function passed to `voices`, `when`, `trigger` or a layer constructor receives the group's object proxy `o`:

```ts
sky.group('jpl.cad').top(6, 'distLD', 'asc').voices(swell, (o) => ({
  pitch:    o.vRel.map(0, 15, 36, 60).quantize(),
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

## Program
Handlers make a script a running program. Setup registers them; the VM calls them while the piece plays. Ordinary variables declared in setup keep their values between calls.

```ts
seed(7);
const pad = additive({ volume: -12, attack: 1, release: 3 });
const bell = fm({ ratio: 3.5, index: 4 });
follow('swpc.kp');

const triad = [0, 4, 7];
let root = 48;
let step = 0;

const chord = () => {
  pad.stopAll();
  triad.forEach((n, i) => pad.hold(`t${i}`, root + n, { velocity: 70 }));
};
after(0, chord);
on('jpl.scout', 'enter', (o, e) => {
  if (e.initial) return; // candidates listed before Run leave the chord alone
  root = 48 + choose([0, 3, 5, 7, 8]);
  chord();
});

every('1/8', () => {
  const kp = Number(read.swpc('kp.kp') ?? 0);
  bell.play(root + 24 + triad[step++ % 3], { durationMs: 200, velocity: 40 + kp * 8 });
});
```

### Handlers
Handlers are registered during setup only. Registering one inside a handler throws.

| Call | Calls `fn` |
|---|---|
| `on(group, kind, fn)` | For each event of `kind` (`enter`, `update`, `exit` or `'*'`) in `group`, with `(o, e)` |
| `every(interval, fn)` | Every `interval`, with `(t)`: milliseconds (10–3,600,000) or a sync name (`1/32`–`1/1`, with `d` or `t`) at the piece tempo. The first call is at the start of the program. |
| `after(ms, fn)` | Once, `ms` (0–3,600,000) after the call; called in setup, `ms` after the start of the program. Valid in setup and in handlers. Returns a function that cancels the call. |
| `onFreshness(source, fn)` | When the freshness of `source` (a registry id, a group key or `'*'`) changes, with `({ source, state })` |
| `follow(...groups)` | Follows groups the script reads with `read.*` but names nowhere else. An argument may also be `sky.orbit(objectId, quantity, { timeScale })`: it declares that orbit for `read.orbit` and follows the object's group. |

- `o` is a frozen plain record `{ id, group, ...fields }` with the object's current field values; a field the source does not report is `null`. `e` is `{ kind, traceId, initial, prev }`, where `prev` is the record before an `update` or `exit`, otherwise `null`.
- At every start the VM calls each `on(group, 'enter' | '*')` handler once per object already in its group, with `e.initial` true, in id order. Trigger bindings skip these events; handlers receive them so a program can build its state from the current sky.
- Handlers are synchronous. Commands sent after a handler returns, for example from a promise callback, throw `io_outside_handler`.

### Output
Output methods are valid inside handlers only. In setup they throw, and the build reports `io_outside_handler`.

| Call | Effect |
|---|---|
| `inst.play(pitch, { velocity, pan, durationMs })` | One note. Defaults: velocity 100, pan 0, `durationMs` 250 (20–10,000). |
| `inst.hold(key, pitch, { velocity, pan })` | Starts a sustained note named `key` (text, at most 64 characters). Holding a key that already sounds restarts it. |
| `inst.glide(key, pitch, ms)` | Moves a held note to `pitch` over `ms` (0–10,000, default 150) |
| `inst.pan(key, pan)` | Moves a held note to `pan` (−1 left to 1 right), for example from live data in a timer handler; ignored when `key` is not held |
| `inst.stop(key)`, `inst.stopAll()` | Releases one held note, or all of the instrument's held notes |
| `inst.<param>.set(value, { smoothMs })`, `slot.<param>.set(value, { smoothMs })` | Sets a numeric parameter's base value; `smoothMs` default 250. Values outside the range move to the nearest end. |
| `inst.harmonics.set(values)` | Sets additive `harmonics`: a list of up to 8 numbers, each moved into 0–1; missing entries are 0. Sounding voices change their wave at once, without smoothing, so a handler that wants a smooth change sends small steps. |
| `slot.bypass.set(on)` | Bypasses an effect slot |
| `layerHandle.set(props)` | Sets constant layer properties; every `layer.*(...)` constructor except `layer.shader` returns the handle. An unknown property or an expression value throws. |

A `null` pitch plays nothing, as in expressions. Any other value of the wrong kind throws a `TypeError`. `inst.<param>.set` accepts numeric parameters only. Commands take effect 100 ms after the handler's time, so timer handlers keep steady timing.

### Input
| Call | Returns |
|---|---|
| `read.swpc(path)` | Current SWPC value, or `null` |
| `read.group(key)` | Current records of a group, in id order |
| `read.object(id)` | One record, or `null` |
| `read.freshness(source)` | `loading`, `fresh`, `stale` or `down`; `source` is a registry id or a group key. A source without a known state is `loading`. |
| `read.orbit(objectId, quantity, { timeScale })` | The current value, −1 to 1, of an orbit declared with `follow(sky.orbit(...))` (Orbits), or `null` before the first sample. The value changes every 500 ms. Reading an undeclared orbit throws. |
| `time()` | Milliseconds since the program started; in a timer handler, the timer's scheduled time |

`read.*` is valid inside handlers only. `read.swpc` and `read.group` read groups the piece follows: the groups of its bindings, layers, `on` handlers, `sky.swpc` expressions and `follow` calls. Reading another group throws. `read.object` returns `null` for an object outside the followed groups.

### Determinism
- `random()` returns a number in `[0, 1)`, `randInt(n)` an integer in `[0, n)`, and `choose(list)` one element. All three are seeded by `seed()`, so two runs with the same seed and the same events make the same choices. `Math.random` is the same generator.
- `setTimeout`, `setInterval`, `queueMicrotask`, `Date` and `performance` are not available; use `after` and `time()`.
- Program time is audio time. Replay speeds up sky events, not timers.

### Errors and limits
| Rule | Effect |
|---|---|
| A handler throws | That handler is disabled until the next Run. Problems shows `handler_error` with the line. |
| One batch of handler calls runs longer than 250 ms | The VM is stopped and the program's notes are released; the program starts again from setup 1 s later. After 3 such stops within 60 s it stays stopped and Problems shows `handler_timeout`. The bindings keep playing. |
| More than 64 handlers | Build error `limit_handlers` |
| More than 256 pending `after` calls | The `after` call throws |
| More than 1024 timer calls due in one batch | The remaining calls run in the next batch |
| More than 256 commands in one batch | The rest are dropped and traced |
| More than 200 note starts per second | The rest are dropped and traced |
| More than 4096 sky events waiting for the next batch | The oldest are dropped and traced |
| More than 30 `harmonics.set` updates per second for one instrument | Only the latest update of each 33 ms is sent |
| Orbits declared with `follow` | Count toward the 64 orbit sources of a piece (Validation) |

## Types
`src/dsl/builder.d.ts` declares the global builder API. Its types are generated from `PARAM_DEFS`, the effect registry, `src/visual/layer-defs.js` and `src/sky/groups.json` by `scripts/gen-builder-dts.mjs` (`src/dsl/gen-dts.js`), which also writes `src/dsl/builder-dts.js` (the same text as a module) and `src/dsl/ts-lib-files.js` (the ES2022 library declarations) for the type-check worker. Generation depends only on the tables and the installed TypeScript library files, so it is deterministic; `--check` fails when a generated file is out of date.

| Type | Meaning |
|---|---|
| `Expr<T, C>` | An expression producing `T` (`number`, `string` or `boolean`). Steps are typed: `.map` exists on `Expr<number>`; `.eq` accepts a value of the same `T`; `.gt`, `.lt` return `Expr<boolean>`. `C` lists the contexts the expression needs (Expression contexts). |
| `Num` | `number \| Expr<number>`; accepted wherever a numeric value is expected |
| `Pitch` | `Num`, in MIDI note numbers |
| `GroupKey` | Union of the group keys in `groups.json` |
| `ObjectId<G>` | Template literal type `` `${G}:${string}` `` |
| `Fields<G>` | Field names and value types of group `G`, from `groups.json` |
| `ObjectProxy<G>` | `{ [K in keyof Fields<G>]: Expr<Fields<G>[K]> }`, plus `orbit` when `G` is a `celestrak.*` key |
| `ParamsOf<T>` | Option object of instrument or effect type `T`: numeric params as `number`, enum params as their option-name union, `harmonics` as an 8-tuple |
| `Handle<T>` | An instrument or effect handle; each numeric parameter has `follow`, `set` and `mod`; `mod` exists only on modulatable parameters |
| `OrbitQuantity` | `'latitude' \| 'phaseSin' \| 'phaseCos' \| 'altitude' \| 'longitude' \| 'sunlit' \| 'elevation'` |
| `SwpcPath` | `'kp.kp' \| 'kp.kpEstimated' \| 'wind.speed' \| ...` |

Each `groups.json` entry lists its fields with a type, `number`, `string` or `boolean`, which the generator reads. Types encode names, kinds and option values. Numeric ranges are not types; the validator and `coerceParam` enforce them.

### Expression contexts
Every expression type carries a context parameter `C`, the union of the contexts its nodes need: `'obj'` (a current object: `field`, `orbit`, `audio.voice(...).env()`), `'audio'` (a layer property: `audio.*`) and `'fn'` (a binding: `fn`). Each position accepts the contexts it provides:

| Position | Accepts |
|---|---|
| `follow`, `mod` sources, LFO `rate` | `'fn'` |
| Voice, trigger and `when` options | `'obj' \| 'fn'` |
| Properties of group layers | `'obj' \| 'audio'` |
| Properties of `field`, `aurora` and `shader` layers, `view.background` | `'audio'` |

`orbit(...)` or `field(...)` in a `follow` is therefore a type error, as is `fn` in a layer property. The validator enforces the same rules with `orbit_no_object`, `audio_outside_layer` and `fn_in_layer`.

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
| `color(hex)`, `.mix(other, t)` | Colour (`#rrggbb`) and blend; see `visuals.md` |
| `fn(source)` | Escape hatch; IR op `local` |

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
- A value of the wrong type for a step, for example text into `.add` or a number into `.and`, gives `null`.
- `.map` with `inMin` equal to `inMax` gives `null`. The `log` curve needs `outMin` and `outMax` of one sign and the `exp` curve `inMin` and `inMax` of one sign; otherwise the result is `null`.
- A voice whose pitch evaluates to `null` is not started. A trigger whose pitch is `null` does not fire. A parameter that evaluates to `null` keeps its last value.

## IR
### Expression nodes
```json
{ "op": "map", "args": [ { "op": "field", "args": ["vRel"] }, 5, 30, 36, 60, "lin" ] }
```
Every node is `{ "op": string, "args": array }`. Arguments are numbers, strings, booleans, `null` or nodes. A constant in an expression position is a plain number, string or boolean, not a node. The op set is exactly the sources and steps above (`field`, `num`, `rand`, `swpc`, `value`, `count`, `mean`, `spread`, `map`, `clamp`, `octaveInto`, `quantize`, `add`, `sub`, `mul`, `div`, `abs`, `neg`, `round`, `eq`, `gt`, `lt`, `and`, `or`, `not`, `level`, `spectrum`, `env`, `orbit`, `local`, `color`, `mix`). `src/dsl/validate.js` (`OPS`) lists each op's arguments:

| Op | Arguments |
|---|---|
| `field` | `[name]` |
| `num` | `[x]` |
| `rand` | `[lo, hi]` |
| `swpc` | `[path]`, for example `"kp.kp"` |
| `value` | `[objectId, field]` |
| `count` | `[group]` |
| `mean`, `spread` | `[group, field]` |
| `map` | `[x, inMin, inMax, outMin, outMax, curve]`; bounds are numbers |
| `clamp`, `octaveInto` | `[x, lo, hi]`; bounds are numbers |
| `quantize`, `abs`, `neg`, `round`, `not` | `[x]` |
| `add`, `sub`, `mul`, `div`, `eq`, `gt`, `lt`, `and`, `or` | `[x, y]` |
| `level`, `env` | `[instrumentId]` |
| `spectrum` | `[instrumentId, bands]` |
| `orbit` | `[quantity, objectId \| null, timeScale]`; `null` means the current object |
| `local` | `[source]`, the `fn` source text |
| `color` | `[hex]` |
| `mix` | `[colour, colour, t]`; each colour is a hex string or a `color`/`mix` node |

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
    { "target": "i0.vibratoDepth", "source": { "lfo": "lfo0" }, "depth": 0.1, "smoothMs": 250 }
  ],
  "bindings": [
    { "id": "b0", "kind": "voices", "inst": "i0", "group": "celestrak.stations",
      "select": null,
      "pitch": { "op": "quantize", "args": [ { "op": "octaveInto", "args": [ { "op": "field", "args": ["meanMotion"] }, 110, 440 ] } ] },
      "velocity": 100,
      "pan": { "op": "map", "args": [ { "op": "field", "args": ["raan"] }, 0, 360, -0.8, 0.8, "lin" ] },
      "voiceMods": {} },
    { "id": "b1", "kind": "trigger", "inst": "i0", "group": "jpl.scout", "select": null, "event": "enter",
      "when": null, "pitch": 76, "velocity": 100, "durationMs": 250, "maxPerSecond": 1 },
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
    { "id": "l0", "type": "points", "group": "celestrak.stations", "select": null,
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
- `select` is `null` or `{ "top": n, "by": field, "order": "asc" | "desc" }`. Voices, triggers and layers carry it.
- Binding kinds: `voices` and `trigger` as above; `param` `{ id, kind, inst, param, expr, smoothMs }` for `inst.<param>.follow`; `fxParam` `{ id, kind, slot, param, expr, smoothMs }` for `slot.<param>.follow`; `fxBypass` `{ id, kind, slot, expr }` for `slot.bypass.follow`.
- Instrument `params` hold only the options the script sets: numbers, choice option names (`"sawtooth"`) and arrays (`harmonics`). Effect slot `params` hold numbers only, and a choice is its option index (`filter({ mode: 'highpass' })` stores `"mode": 1`), matching `FxSlotSpec` (`audio/effects.md`).
- Layers: `{ id, type, group, select, props }`; `group` and `select` are `null` for `field` and `aurora`. `props` holds every property of the layer type, with defaults filled in. A shader layer is `{ id, type: "shader", group: null, select: null, glsl, props }`; its `props` hold `opacity`, with its default filled in, and any other value the script passes. The validator does not check shader `props`, and the renderer reads only `opacity` (`visuals.md`, Shader layers).
- `view` defaults to `{ "projection": "orbital", "background": "#000000" }`.
- `groups` lists every group referenced by a binding, expression, layer or program handler, including `swpc.*` groups referenced by `sky.swpc` and groups named by `follow`, in sorted order. On save, the page inserts and deletes `project_subscriptions` rows so that the project's rows equal these values.
- `program` is present only when the script registers handlers or calls `follow`: `{ "handlers": [...], "follow": [group, ...], "orbits": [node, ...] }`. `orbits` is present only when `follow` declares orbits; each entry is an `orbit` expression node with an object id, validated like any `sky.orbit` expression. Each handler is `{ "id": "h<n>", "kind": "on", "group", "event" }`, `{ "id", "kind": "every", "intervalMs" }` or `{ "id", "kind": "every", "sync" }`, `{ "id", "kind": "after", "ms" }` (registered in setup) or `{ "id", "kind": "freshness", "source" }`. The functions stay in the VM; the IR records what was registered, so hot reload can diff it and the page knows the piece needs the VM.

### Schema file
`src/dsl/ir.schema.json` is a JSON Schema (draft 2020-12) for the document. `validateIr` (`src/dsl/validate.js`) checks `irVersion`, the nesting depth of the document and its serialized size, then runs the schema check, then the semantic checks below. A version, nesting or schema error ends validation before the semantic checks.

## Validation
| Check | Rule |
|---|---|
| Instruments | At most 16. `type` is a `PARAM_DEFS` key. Every param name exists for the type. `granular.source` is not `sample`. |
| Bindings | At most 64. `inst` exists. `param` is a parameter of the instrument's or slot's type and not an array parameter (`not_numeric`). |
| Voices | `select.top` at most 16, or 4 for granular. Without `select`, a group larger than the cap uses the first objects by id. Each `voiceMods` name is a modulatable parameter of the instrument's type (`unknown_option`); constant values lie in −1 to 1. |
| Triggers | `maxPerSecond` 0.1–20. `durationMs` 20–10000. |
| Effects | At most 8 slots per chain and 4 `reverb` slots per piece. `type` is an effect registry key. Every param exists for the type. Each slot id appears in one chain. |
| Modulation | At most 16 LFOs, 2 `retrigger` LFOs per instrument, 32 routes, 4 routes per target. `depth` −1 to 1. Targets exist and are modulatable (not `enum`, array or `mod: null`). LFO `rate` 0.01–20 Hz. `tempo` 20–300. |
| Layers | At most 16. Props exist in `src/visual/layer-defs.js` (`unknown_option`). Constant values lie in range and match the property type. |
| Groups | Every group key exists in `src/sky/groups.json`; `tests/sky-groups.test.js` checks that file against the source table in `sources.md`. A reaction or `onFreshness` source is `'*'`, a group key or a registry id. |
| Orbits | `orbit` and `sky.orbit` reference `celestrak.*` groups or objects; `quantity` is a listed quantity; `timeScale` 1–1000; at most 64 distinct (object, quantity, timeScale) orbit sources per piece. |
| Expressions | Depth at most 32. Every `op` is known with the right argument count. `audio.*` ops appear only in layer props. |
| Program | At most 64 handlers. Handler `n` has id `h<n>`. `kind` is `on`, `every`, `after` or `freshness`, with only the fields of its kind. `event` is `enter`, `update`, `exit` or `*`. `intervalMs` 10–3,600,000; `sync` is a sync name; `ms` 0–3,600,000. Groups exist. |
| Size | Serialized IR at most 256 KB. Script source at most 200,000 characters (`limit_source`). |
| References | Every instrument, slot and LFO id a binding, route, reaction or expression names exists. `groups` lists exactly the referenced groups. |
| Ranges | Every constant lies in its range: `tempo`, LFO `rate`, `phase` and `smooth`, `depth`, `smoothMs` 0–60,000, `maxPerSecond`, `durationMs`, `timeScale`, constant pitch, velocity, pan and `voiceMods` values, `detuneCents` −100–100, `desaturate` 0–1, `spectrum` bands 4–32, instrument `volumeDb`, `octave` and `cents`, parameter values and layer properties. The builder clamps constants, so only a hand-made IR fails these. |

### Problem codes
| Code | Severity | Condition |
|---|---|---|
| `syntax_error` | error | The script does not parse as TypeScript |
| `runtime_error` | error | The script throws while running |
| `timeout` | error | No result within 1500 ms |
| `unknown_option` | error | An option name is not a parameter of the instrument or effect type, or a property of the layer type; a `voiceMods` name is not a modulatable parameter of the instrument |
| `not_numeric` | error | `follow` on an array parameter (additive `harmonics`); `follow` on a choice parameter is valid and sends the option index |
| `not_modulatable` | error | `mod` on an enum, array or `mod: null` parameter |
| `unknown_group` | error | A group key is not in `groups.json` |
| `unknown_field` | warning | No object of the group's last snapshot has the field |
| `granular_sample` | error | Granular `source: 'sample'` |
| `slot_reused` | error | One effect slot in two chains |
| `slot_unplaced` | error | `follow` or `mod` on an effect slot that is in no chain |
| `lfo_rate_range` | error | An expression LFO rate does not end in `map` or `clamp`, or its range is empty |
| `audio_outside_layer` | error | An `audio.*` op outside layer properties |
| `fn_in_layer` | error | `fn` in a layer property |
| `expr_too_deep` | error | Expression depth above 32 |
| `orbit_no_elements` | error | `orbit` or `sky.orbit` on a group or object without orbital elements |
| `orbit_quantity` | error | Unknown orbit quantity |
| `orbit_no_object` | error | `orbit(...)` where no current object exists; use `sky.orbit(...)` |
| `io_outside_handler` | error | Setup calls an output method or `read.*`; these work only inside handlers |
| `handler_error` | error | A handler threw while the piece played; the handler is disabled until the next Run |
| `handler_timeout` | error | Handler calls ran longer than 250 ms in one batch three times within 60 s; the program stopped |
| `limit_<item>` | error | A count limit in the table above is exceeded; `<item>` is `instruments`, `bindings`, `voices`, `slots`, `reverbs`, `lfos`, `retrigger_lfos`, `routes`, `routes_per_target`, `layers`, `orbit_sources`, `handlers`, `source` |
| `ir_too_large` | error | Serialized IR above 256 KB |
| `ir_version_unsupported` | error | `irVersion` above the current version |
| `local_only` | warning | The piece uses `fn` or `layer.shader` |
| `type_error` | warning | The type checker reports an error; the message and position come from TypeScript |
| `ir_schema` | error | Internal: the IR does not match `ir.schema.json`, a vocabulary or a range |
| `ir_reference` | error | Internal: the IR names an id that does not exist, or `groups` does not match the references |

The internal codes arise only from a hand-made or corrupted IR; the builder never produces them, and the guide does not list them.

`src/dsl/problem-codes.js` is the single list of codes. The guide's troubleshooting page (`content/learn/troubleshooting.md`) documents every user-facing code; a test checks that both lists match.

A problem is `{ "severity": "error" | "warning", "code": string, "path": string, "line": number | null, "message": string }`. `path` is a JSON Pointer into the IR. The builder records the script line of each builder call against the pointer of the entry it creates (`/instruments/0`, `/bindings/3`, `/instruments/0/fx` for the `.fx()` call, `/instruments/0/fx/1/params` for the slot's constructor); a problem takes the line of the longest recorded pointer that prefixes its path. Any error blocks Run and Save; warnings do not. `handler_error` and `handler_timeout` arise during playback; they appear in Problems and in the trace, and block nothing.

`unknown_field` checks a field name against the group's field list in `groups.json`; when the page passes the last snapshot of the group, a field present in any of its objects is also known.

## Versioning
- `irVersion` is a positive integer; the current version is 1 (`CURRENT_IR_VERSION`, `src/dsl/limits.js`). `src/dsl/migrations.js` exports `migrations`, which maps each version `n` below the current one to a pure function from version `n` to `n + 1`. Version 1 is the first version, so the map is empty. `tests/dsl-migrations.test.js` requires one step, tested on a fixture, for every version below the current one.
- Loading (`loadIr`) applies migrations in order, then validates. A version greater than the current one is rejected with code `ir_version_unsupported`; an `irVersion` that is not a positive integer is `ir_schema`.
- Renaming, removing or changing the unit of any IR field requires a version bump.

## Sandbox
- The script runs in a dedicated Web Worker loaded from `/dsl-sandbox.js`. The page posts `{ source, defs, snapshot? }` and receives `{ ir, problems }`. `defs` is the normalized definition object (`src/dsl/load-defs.js`, Definition tables); `snapshot` optionally maps groups to their last objects for `unknown_field`. `ir` is `null` after `syntax_error`, `runtime_error`, `timeout`, `io_outside_handler` or `limit_source`. The worker keeps the `defs` of the last message that carried them. The worker's own validation runs in the same realm as the script, which can patch built-ins there, so the page validates the received IR again (`validateIr`) before loading or saving it; the worker's problems are kept for their script lines.
- `public/dsl-sandbox.js` is generated by `scripts/build-sandbox.mjs` from `src/dsl/sandbox-entry.js`: a small CommonJS linker bundles the DSL modules and Sucrase into one script without `import` or `export`, which loads as a classic or a module worker. The bundle contains no definition tables, so it does not depend on the engine. `--check` fails when the file is out of date.
- `src/dsl/run-sandbox.js` (`createSandbox`) is the page side: it keeps one worker, runs builds one at a time, and applies the timeout below.
- The worker removes TypeScript syntax with Sucrase (`transforms: ['typescript']`), which performs no type checking, then evaluates the result with `new Function`, passing the builder API and the seeded `Math` as parameters and shadowing `self`, `globalThis`, `postMessage`, `close`, `onmessage`, `addEventListener`, `removeEventListener`, `caches`, `Worker`, the network globals and the timer and clock globals. Sucrase preserves line numbers, so problem positions refer to the TypeScript source; the script carries `//# sourceURL=piece.ts`, and the builder reads script lines from stack frames of that name. A Sucrase parse error is the problem `syntax_error`.
- The response for `/dsl-sandbox.js` carries its own policy, set in `next.config.ts` headers: `Content-Security-Policy: default-src 'none'; script-src 'self' 'unsafe-eval'`. The worker can evaluate the script but has no network access.
- When it loads, before any script runs, the worker also deletes `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `importScripts` and `indexedDB` from its global object and that object's prototype chain (`lockGlobals`); a property that cannot be deleted is overwritten with `undefined`.
- The worker posts `{ ready: true }` once it has loaded. The page waits for it before posting a build (up to 15 s; past that it reports `runtime_error` "The script sandbox did not start"), so the 1500 ms limit measures only the script's run, never the download and start of the worker.
- The page calls `worker.terminate()` if no response arrives within 1500 ms of posting the build and reports problem `timeout`.
- The script receives only the builder API. It cannot reach the page, the audio context, the database or the DOM. `setTimeout`, `setInterval`, `clearTimeout`, `clearInterval`, `queueMicrotask`, `requestAnimationFrame`, `Date` and `performance` are shadowed by values whose use throws a `TypeError` naming the replacement (`after`, `every` or `time()`), and `Math` is a copy whose `random` is the seeded generator (Program, Determinism).
- Programs run only for their author: projects are owner-only (`database.md`), and a piece with handlers plays only from its source in the author's own session.
- In local-only mode the page posts `{ fn: { id, source, arg } }` for each `fn` evaluation and receives `{ fn: { id, value } }` or `{ fn: { id, error } }` (`createSandbox().evalFn`). Values other than finite numbers, text and booleans become `null`. A call without a reply within 1500 ms terminates the worker like a build timeout; that call and every other pending `fn` call resolve `null`, as they do when the worker fails (`onerror`) or is disposed.

### VM
The worker keeps the source and handlers of its last build without errors. Builds and program messages share one queue in `createSandbox`, so a timeout measures only the message being processed.

| Page → worker | Worker → page |
|---|---|
| `{ program: { id, op: 'start', groups, objects, freshness, orbits } }` | `{ program: { id, commands, errors, dropped } }` |
| `{ program: { id, op: 'batch', now, events, freshness, orbits } }` | `{ program: { id, commands, errors, dropped } }` |
| `{ program: { id, op: 'stop' } }` | `{ program: { id, commands: [], errors: [], dropped: 0 } }` |

- `start` builds the kept source again, so setup starts from fresh variables, then calls the initial `enter` handlers (Program, Handlers). `groups` are the IR's groups; `objects` are their current objects as `{ id, group, fields }`; `freshness` is the current state of every source as `{ source, state }`.
- `batch` advances the program clock to `now` (ms since start). The VM first runs due timers in time order, each at its scheduled time. A timer more than 1000 ms late fires once and skips the missed calls. It then applies `events` (`{ kind, obj, prev, traceId, initial }`) to its copy of the followed groups and calls the matching `on` handlers, then `freshness` changes (`{ source, state }`) and the matching `onFreshness` handlers.
- `orbits` in `start` and `batch` holds the current value of each entry of `program.orbits`, in order: a number from −1 to 1 or `null`. `read.orbit` returns the latest one.
- A command is `{ op, at, trace, src, ...args }`. `op` is `play`, `hold`, `glide`, `pan`, `stop`, `stopAll`, `set` or `layer`; `at` is the handler's program time, `trace` the event's trace id (`null` for timers), `src` the handler id. At most 256 per batch; `dropped` counts the rest.
- An error is `{ handler, line, message }`. The VM disables that handler. An error from `setup` or `vm` (the kept build failed, or the worker holds no running program) means the program is gone; the page reports it once and stops the program.
- The page waits up to 250 ms for each `batch` reply and up to 1500 ms for a `start` reply, which reruns setup like a build. Past that it terminates the worker (`bindings.md`, Program host, Watchdog and Restart).
- `createSandbox` remembers the source and definitions of the last build without errors. When a `start` reaches a worker that does not hold them (a new worker after a timeout or a crash), it sends that build first, under the 1500 ms build limit, so a program can restart without a new save.
- A build or `fn` call that times out also terminates the worker, which stops a running program.

## Hot reload
On save in the editor:
1. Run the script in the sandbox and validate the IR. On any error, show the problems and keep the running piece unchanged.
2. Diff the IR against the running IR by id, using canonical-JSON equality per entry.
3. Instruments: pass the full widget list to `Engine.sync` (`bindings.md`). The engine applies changed params with smoothing and fades out removed instruments.
4. Effects: call `setFx` for each chain whose slot list changed. Slots with unchanged id and type keep their state, including reverb and delay tails.
5. Modulation: call `setLfos` and `setMods` when either list changed. Unchanged LFOs keep their phase.
6. Bindings: unbind and rebind each changed or removed binding. Unchanged bindings keep their sounding voices.
7. Layers: rebuild changed layers. Unchanged layers keep their GPU buffers and trails.
8. Program: when the IR has handlers, stop the running program, release its notes and start it again from setup with the new source. The program's variables start over.
9. Emit a `RELOAD` trace record listing changed ids.

## Type checking
- A type-check worker (`src/dsl/typecheck-worker.ts`) runs the TypeScript compiler over `piece.ts` with `@typescript/vfs`. The page loads it the first time the editor opens. `/listen`, `/try` run mode and `/projects/[id]/run` never load it.
- The virtual file system contains `piece.ts`, `builder.d.ts` and the ES2022 library declarations, bundled with the app. The worker fetches no files at runtime.
- Compiler options: `strict: true`, `target: 'ES2022'`, `lib: ['ES2022']`, `noEmit: true`, `types: []`. No DOM types are present; scripts have no DOM.
- The worker re-checks 300 ms after the last edit and returns diagnostics, completions and hover text. Each diagnostic becomes a `type_error` warning in Problems.
- `src/dsl/typecheck.js` (`createChecker`) holds the checker; the compiler, `@typescript/vfs` and the library files are injected, so the starter build and the tests run it in Node. The worker exposes the `@valtown/codemirror-ts` worker methods (`initialize`, `updateFile`, `getLints`, `getAutocompletion`, `getHover`) and `check(source)` over a request–reply protocol `{ id, method, args }` → `{ id, result | error }`, and posts `{ event: 'problems', problems }` 300 ms after the last `updateFile` of `/piece.ts`. `src/dsl/typecheck-client.js` (`connectTypecheck`) wraps the worker in an object usable as the `worker` of `tsFacetWorker`.
- Type errors do not block Run or Save. Build and validator errors do.

## Definition tables
The builder, the validator, the sandbox and the type generator receive the definition tables as an argument, never by import:

| Module | Content |
|---|---|
| `src/dsl/engine-defs.js` | The only import of the user's engine tables: `PARAM_DEFS` and `TUNING_DEFS` from `src/audio/synths/param-defs.js`, the effect registry (`EFFECTS`, exported as `EFFECT_REGISTRY`) from `src/audio/fx/effects/registry.js` |
| `src/dsl/layer-schema.js` | `LAYER_DEFS` from `src/visual/layer-defs.js` |
| `src/dsl/sky-schema.js` | `src/sky/groups.json` |
| `src/dsl/defs.js` | `normalizeDefs` merges the tables into one plain, structured-cloneable object |
| `src/dsl/load-defs.js` | `DEFS`, the normalized tables of the running app |

Reading of the engine tables: a synth `ParamDef` without `mod` is not modulatable; an effect `ParamDef` is modulatable unless `mod` is `null`; only numeric parameters are modulatable; `mod.dir: 'down'` marks a lower-only parameter; a `ParamDef` with `options` or `scale: 'enum'` is a choice; an array `default` marks an array parameter. A `ParamDef` may name the parameter with `id` or `name`. Instrument `volume` is always −60 to 0 dB with default −6; `octave` and `cents` ranges come from `TUNING_DEFS`. The sync names are the `sync` options of the `delay` effect other than `off`.

The build scripts (`scripts/gen-builder-dts.mjs`, `scripts/build-starters.mjs`) accept `--defs <module>` to replace any table; `--defs tests/fixtures/dsl/engine-defs.js` supplies fixture engine tables built from `content/learn/reference.md`.

## Editor support
The editor's completion, hover and inline problems come from the type-check worker (`ui.md`). Until the worker has loaded, completion reads `PARAM_DEFS`, the effect registry, `layer-defs.js` and `groups.json` directly. The user guide (`guide.md`) teaches the API to people.

## Limitations
- Hot reload restarts a program from setup, so the program's variables do not survive a reload.
- A browser that does not apply the `/dsl-sandbox.js` response CSP to the worker leaves the global deletions in the worker as the only network barrier.

## Sources
- MDN, Web Workers API: https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API
- W3C, Content Security Policy Level 3, workers: https://www.w3.org/TR/CSP3/
- Sucrase: https://github.com/alangpierce/sucrase
- TypeScript, `@typescript/vfs`: https://www.npmjs.com/package/@typescript/vfs
- JSON Schema 2020-12: https://json-schema.org/draft/2020-12
- User audio engine: `doc/audio/synthesis-conventions.md` (`PARAM_DEFS`), `doc/audio/effects.md`, `doc/audio/modulation.md`
