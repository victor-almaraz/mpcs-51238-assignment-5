# Bindings

## Scope
The binding runtime that turns sky events into instrument calls, the audio host that connects IR instruments to the engine, and the instrument contracts the runtime calls. Synthesis and `Instrument` internals are user-owned and documented in `audio/`.

## Job
Apply each IR binding and data-driven modulation source to sky events as bounded, traced calls on the engine.

## Interface
- **Input:** validated IR (`piece-dsl.md`), `SkyEvent` stream (`sky-contract.md`), engine handle.
- **Output:** `noteOn`, `noteOff`, `setParam`, voice-control, effect and modulation calls; layer property values for the renderer; trace records.
- **Errors:** a call that throws is caught, traced at level `error` with the binding id, and the binding is disabled until the next reload. The rest of the piece keeps running.

## Modules
| Module | Exports |
|---|---|
| `src/expr/` | `evaluate(node, obj, ctx)`, `collectDeps(node)`, `quantize`, `rand01` |
| `src/bind/` | `createBindingRuntime(options)`, `buildModConfig(ir)`, `computeReactionState(...)`, `evaluateLayerProps(...)` |
| `src/audio-host/` | `createAudioHost(options)`, `irToWidgets(ir, ...)` |
| `src/audio-host/engine-imports.js` | The only module that imports the user's engine: `ensureRunning`, `buildMasterBus`, `Engine` |

Every other module receives the engine, the sky store, the clock and the `trace(record)` function by injection, so tests run with the fakes in `tests/fakes.js`.

## Audio host
`src/audio-host/` starts the engine and keeps it in sync with the IR. It follows the lifecycle of assignment 2's `src/state/session.js`:
1. On the Run click, call `ensureRunning()` synchronously inside the gesture handler, then `buildMasterBus(ctx, { realtime: true, masterGain: 0 })`.
2. Create `new Engine(ctx, bus, { seed, realtime: true, lookahead: () => 0.1, ks: bus.worklets.ks, onFault, onError })`.
3. Register `bus.setHandler` for safety events (fault, duck) and show them as specified in `audio/audio-safety.md`.
4. Call `engine.pump(ctx.currentTime + 0.1)` every 25 ms (granular schedules grains ahead).
5. Map IR instruments to engine widgets and call `engine.sync(widgets)` on start and after each hot reload:
   ```js
   const widgets = ir.instruments.map((i) => ({
     id: i.id, type: i.type, muted: false, solo: false, armed: false,
     volumeDb: i.volumeDb, part: 'all', params: i.params, octave: i.octave, cents: i.cents,
   }));
   ```
6. Call `engine.setTempo(ir.tempo)`, then `engine.setFx(id, instrument.fx)` for every instrument and `engine.setFx('master', ir.master.fx)` (`audio/effects.md`).
7. Call `engine.setLfos` and `engine.setMods` with the modulation configuration (Effects and modulation).
8. Freshness reactions `mute` and `only` set `muted` on widgets and call `engine.sync` again; the engine applies the gain change with smoothing.
9. Every `engine.sync` passes the current value of each followed parameter in `params`, so a sync for a reaction or a hot reload does not reset a followed parameter to its IR value.

On a hot reload the host passes the full widget list to `engine.sync`, calls `setTempo` when the tempo changed, `setFx` for each chain whose slot list changed (and `setFx(id, [])` for a removed instrument with a chain, before the sync), and `setLfos` and `setMods` when either list changed. It then rebinds changed bindings and emits one `RELOAD` record with the changed ids. Stop releases every binding and calls `engine.sync([])`. A safety-stage `fault` stops the bindings; nothing restarts until the next Run.

The master level, master fade-in, safety limiter and duck are engine behavior. Effect chains sit before the safety stage, so the safety stage applies to effect output.

## Voice identity
Each sustained voice is identified by a source tag `sky:<bindingId>:<objectId>`, passed as the `source` argument of `noteOn` and `noteOff`. Each trigger note uses `trig:<bindingId>`. `noteOff(pitch, time, source)` releases the oldest matching voice with that pitch and source tag, so the runtime always passes the pitch it started the voice with.

## Sustained voices
For a `voices` binding:
1. On every event in the binding's group, compute the selected set: the live objects, ordered by `select.by` in `select.order`, limited to `select.top` (or the cap when `select` is `null`).
2. For each object that enters the selected set: evaluate `pitch` and `velocity`. If `pitch` is not `null`, call `noteOn(pitch, velocity, ctx.currentTime, tag)`, then `setVoicePan(tag, pan)` and `setVoiceMod(tag, voiceMods)` when the instrument implements them.
3. For each object that leaves the selected set or exits: `noteOff(startedPitch, ctx.currentTime, tag)`.
4. For each selected object that updates: evaluate `pitch`, `pan` and `voiceMods`. If pitch changed by more than 0.01 semitones, call `setVoicePitch(tag, pitch, 150)`. Without `setVoicePitch`, release and restart the voice and trace `fallback`.

- A selected object whose `pitch` is `null` stays selected without sounding; an update with a non-null pitch starts it. A sounding voice whose pitch becomes `null` keeps its pitch.
- Objects whose `select.by` value is not a finite number sort last. Ties sort by id.
- Every `noteOff` for a sustained voice uses `max(ctx.currentTime, startTime + 0.005)`, because `noteOff` releases only voices that started before its time and `ctx.currentTime` does not advance within one task.
- Velocity is rounded and clamped to 1–127 (default 64 when `null`), pitch to 0–127, pan to −1 to 1. `AUDIO` records carry the clamped value and the requested value (`pitchRequested`).
- Voice options that reference other groups or `orbit` nodes are re-evaluated for every sounding voice on those events and on each orbit post.

Caps: 16 voices per instrument, 4 for granular, 64 in total (`audio/audio-engine-core.md`). The validator enforces per-binding caps. When several bindings target one instrument, the engine's voice stealing applies and the trace records `stolen`.

## Triggers
For a `trigger` binding:
1. An event of the binding's `event` kind in its group arrives, and `when` evaluates to `true` (or is `null`). `enter` events with `initial: true` (the store's first load of a followed group) never fire a trigger; voices treat them as enters.
2. Evaluate `pitch` and `velocity`. A `null` pitch does not fire and takes no token.
3. A token bucket with capacity `ceil(maxPerSecond)`, starting full, and refill rate `maxPerSecond` admits the event. An event that finds the bucket empty is dropped, not queued, and traced as `dropped`.
4. Call `noteOn(pitch, velocity, ctx.currentTime, tag)` and `noteOff(pitch, ctx.currentTime + durationMs / 1000, tag)`; `noteOff` accepts a future time.

A full-group CelesTrak refresh can emit hundreds of `update` events at once. The bucket keeps the audible result bounded.

## Parameters
For a `param` binding:
1. Re-evaluate `expr` on every event that can affect it: events in groups the expression references, and every SWPC update for `swpc` nodes.
2. Feed the value into a one-pole smoother with time constant `smoothMs / 3`, so the value settles within about `smoothMs`.
3. Every 33 ms (30 Hz), call `setParam(param, smoothedValue)` while the smoother is moving. `setParam` clamps through `coerceParam`, and the engine smooths again over 10 ms.
4. Trace one `AUDIO` `setParam` record when the smoother starts moving toward a new value and one when it settles, each with `requested` (the expression result), `sent` (the smoothed value) and `applied` (`getParams()[param]` after the call).

The smoother starts from `getParams()[param]` (for an effect parameter, the slot's IR value) and snaps to the target once within 0.1% of the step, about 2.3 × `smoothMs` after it. The loop runs every 34 ms, the first whole millisecond above 1000 / 30, so it stays within 30 calls per second.

## Effect parameters
- A `follow` on an effect parameter (`slot.<param>.follow`) behaves like a `param` binding and calls `engine.setFxParam(slotId, param, value)` at up to 30 Hz.
- `slot.bypass.follow(expr)` calls `engine.setFxBypass(slotId, on)` when the boolean result changes.
- Enum parameters receive option indices. A `follow` result is rounded to the nearest index.

## Effects and modulation
The runtime converts the IR's `lfos` and `mods` to the engine configuration (`audio/modulation.md`):
1. Each LFO becomes an `LfoSpec` with its id. An expression `rate` becomes a data source `dat<n>` with `{ data: 'dat<n>', min, max }`.
2. Each route with an `{ "expr": node }` source becomes a data source `dat<n>`. Data source ids are assigned in IR order: first LFO rate expressions, then route expressions.
3. Each route becomes a `RouteSpec { target, source, depth }`, where `source` is the LFO id or data source id.
4. For each data source, the runtime re-evaluates its expression on every event that can affect it, as for `param` bindings, and calls `engine.postModValue(id, value, smoothMs)` at most 30 times per second while the value changes.
   - Route expressions are clamped to −1 to 1.
   - Rate expressions are clamped to `[min, max]` Hz and posted as `2 · (hz − min) / (max − min) − 1`.
5. The runtime traces each posted value with the expression result before clamping.

`engine.onFxFault` reports a slot that reset and bypassed itself. The runtime traces a `SAFETY` record with event `fxFault`, and the UI shows "Effect <type> on <instrument> was reset and bypassed." once per fault. The slot stays bypassed until the next hot reload or Run.

## Orbit sources
- The orbit propagator (`visuals.md`) posts orbit quantities at 2 Hz. The runtime re-evaluates every expression containing an `orbit` node on each post, in addition to its sky events.
- Voice options with `orbit(...)` evaluate per selected object; at most 16 objects per binding are evaluated.
- An orbit source used in `.mod()` becomes a data source like any expression (Effects and modulation), posted at 2 Hz with `smoothMs` 500 unless the script sets another value.
- Trace records for orbit sources carry `class: 'vlfo'` and, when time-scaled, `timeScale`.

## Aggregates
`count`, `mean` and `spread` read the live objects of a group from the sky store. The runtime caches each aggregate and recomputes it on events in that group.

## Freshness reactions
- When a source matching a reaction enters `stale` or `down`, the runtime applies the reaction's actions. When it returns to `fresh`, the runtime restores the previous state.
- `detuneCents` adds to every instrument's `cents` (clamped to ±100) through `engine.sync`.
- `mute` and `only` change widget `muted` flags.
- `desaturate` is a visual action (`visuals.md`).
- Several active reactions combine: `detuneCents` takes the largest value; mutes take the union.
- `'*'` matches the sources of the piece's `groups`. A group key matches the source of that group.
- The runtime reports the combined state (`detuneCents`, `muted`, `desaturate`) to the host, which syncs widgets, and to the renderer.

## Instrument contracts
The engine's instruments implement:
```ts
interface Instrument {
  readonly type: 'subtractive' | 'fm' | 'additive' | 'pluck' | 'granular';
  noteOn(pitch: number, velocity: number, time: number, source: string): void;
  noteOff(pitch: number, time: number, source: string): void;
  allNotesOff(time: number): void;
  setParam(name: string, value: number | number[] | string): void;
  getParams(): Record<string, unknown>;
  dispose(): void;
  /** Envelope value 0–1 of the newest voice tagged `source` at `time` (default now), or null when none sounds. */
  voiceEnv(source: string, time?: number): number | null;
}
```
`source` is an opaque string compared with `===`; the engine attaches no meaning to it.

The runtime reaches instruments through `engine.get(id)`, and effects and modulation through the engine methods in `audio/effects.md` (`EngineFx`) and `audio/modulation.md` (`EngineMod`).

The user implements these optional extensions. The runtime detects each one with `typeof inst.setVoicePitch === 'function'` and uses the fallback when absent.
```ts
interface VoiceControl {
  /** Glides the voice tagged `source` to `pitch` (MIDI, fractional) over `glideMs`. */
  setVoicePitch(source: string, pitch: number, glideMs: number): void;
  /** Sets the voice's stereo position, −1 to 1, through a per-voice StereoPannerNode. */
  setVoicePan(source: string, pan: number): void;
  /** Sets named per-voice modulation values; unknown names are ignored. */
  setVoiceMod(source: string, mods: Record<string, number>): void;
}
```
| Method absent | Fallback |
|---|---|
| `setVoicePitch` | Release the voice and start it again at the target pitch |
| `setVoicePan` | No pan |
| `setVoiceMod` | No per-voice modulation |

Subtractive, FM, additive and granular implement all three; pluck implements none (`audio/audio-engine-core.md`, Common widget interface). `setVoiceMod` names are audio-rate parameter names with values in −1 to 1 (`audio/modulation.md`, Per-voice values).

### Audio signals
The engine provides the inputs of `audio.level`, `audio.spectrum` and `audio.voice(inst).env()` (`visuals.md`):
```ts
interface EngineAudioSignals {
  level(instId: string): number | null;                     // RMS of the instrument output, 0–1 (−60–0 dBFS)
  spectrum(instId: string, bands: number): number[] | null; // `bands` (4–32) log-spaced band levels, 0–1
  voiceEnv(instId: string, source: string): number | null;  // inst.voiceEnv(source) at the current time
}
```
The host's `audio` resolver maps `level(inst)` to `engine.level(inst)`, `spectrum(inst, bands)` to `engine.spectrum(inst, bands)` and `env(inst, source)` to `engine.voiceEnv(inst, source)`. Each instrument has at most one analyser, created on the first `level` or `spectrum` call; reads are cached for 16 ms (`audio/audio-engine-core.md`, Analysis taps).

## Fakes
`tests/fakes.js` exports:
- `FakeInstrument`: implements `Instrument` and `VoiceControl` (each extension can be left out), records every call as `[method, ...args]`, and throws `CapExceeded` when more than its cap of voices sound at once.
- `FakeEngine`: implements `sync`, `get`, `pump`, `EngineFx` and `EngineMod`, records every call, and enforces the effect and modulation limits by throwing `FxLimitError`, `ModLimitError` and `ModTargetError`.
- `FakeAudioParam`, `createFakeClock()` (manual timers, wall and audio time) and `createFakeSky()` (the `Sky` interface with methods that emit events).

Binding tests use these fakes and never construct an `AudioContext`.

## Trace replay
A console export under `tests/fixtures/traces/<name>.jsonl` is paired with `<name>.ir.json`, the IR that was running. `tests/trace-replay.test.js` rebuilds objects from the `CHANGE` records (`data.diff.after`, with `initial` passed through), feeds them through the runtime with fakes, and compares the `AUDIO` records by `event` and `data`.

## Open items
- `piece-dsl.md` does not list the effect-follow binding kinds. The runtime follows `src/dsl/ir.schema.json`: `fxParam { slot, param, expr, smoothMs }` and `fxBypass { slot, expr }`. A `param` binding whose `inst` is a slot id is treated the same way.
- The `bus.setHandler` callback receives `{ type }` with `type` `'fault'`, `'duck'` or `'error'` (`src/audio/master-bus.js`).

## Sources
- User audio engine: `audio/audio-engine-core.md`, `audio/audio-safety.md`, `audio/synthesis-conventions.md`, `audio/effects.md`, `audio/modulation.md`
- Assignment 2 source: `src/audio/instrument.js`, `src/audio/engine.js`, `src/state/session.js`
