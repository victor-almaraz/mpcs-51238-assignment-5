# Bindings

## Scope
The binding runtime that turns sky events into instrument calls, the program host that turns program commands into instrument calls, the audio host that connects IR instruments to the engine, and the instrument contracts both call. Synthesis and `Instrument` internals are user-owned and documented in `audio/`.

## Job
Apply each IR binding and data-driven modulation source to sky events, and each program command, as bounded, traced calls on the engine.

## Interface
- **Input:** validated IR (`piece-dsl.md`), `SkyEvent` stream (`sky-contract.md`), engine handle, and for a program the VM handle (`piece-dsl.md`, VM).
- **Output:** `noteOn`, `noteOff`, `setParam`, voice-control, effect and modulation calls; layer property values for the renderer; trace records.
- **Errors:** a binding or data source whose call throws is traced `BIND` / `error` at level `error` with its id, its voices are released, and it is disabled until the next hot reload or Run. The rest of the piece keeps running.

## Modules
| Module | Exports |
|---|---|
| `src/expr/` (`index.js`) | `evaluate(node, obj, ctx)`, `map`, `octaveInto`, `hexColor`, `mixColor`, `collectDeps(node)`, `objectGroup`, `parseSwpcPath`, `swpcPath`, `sourceClass`, `quantize`, `rootPitchClass`, `rand01`, `hash32` |
| `src/bind/` (`index.js`) | `createBindingRuntime(options)`, `buildModConfig(ir)`, `postedValue`, `computeReactionState(...)`, `evaluateLayerProps(...)`, `selectObjects`, `createTokenBucket`, `createSmoother`, `canonicalJson`, `LIMITS`, `voiceCap` |
| `src/bind/program.js` | `createProgramHost(options)` |
| `src/audio-host/` (`index.js`) | `createAudioHost(options)`, `NOTICES`, `PUMP_MS`, `LOOKAHEAD_S`, `irToWidgets(ir, reactions, followed)`, `chainsOf`, `slotsOf`, `changedIds`, `createMasterControls(host)` |
| `src/audio-host/engine-imports.js` | The only module that imports the user's engine: `ensureRunning`, `closeContext`, `buildMasterBus`, `Engine` |

Every other module receives the engine, the sky store, the clock and the `trace(record)` function by injection, so tests run with the fakes in `tests/fakes.js`.

## Audio host
`src/audio-host/` starts the engine and keeps it in sync with the IR. Its lifecycle matches assignment 2's `src/state/session.js`:
1. On the Run click, call `ensureRunning()` synchronously inside the gesture handler, then `buildMasterBus(ctx, { realtime: true, masterGain: 0 })`.
2. Create `new Engine(ctx, bus, { seed, realtime: true, lookahead: () => 0.1, ks: bus.worklets.ks, onFault, onError })`.
3. Register `bus.setHandler` for safety events and show them as specified in `audio/audio-safety.md`. The callback receives `{ type }` with `type` `'fault'`, `'duck'` or `'error'` (`src/audio/master-bus.js`). Each is traced at stage `SAFETY`, component `master-bus`.
   - `fault`: the host stops the bindings and the program, calls `engine.releaseAll(t)` and `engine.rebuild()`, and shows "Audio fault — output muted and reset". Nothing restarts until the next Run.
   - `error` (the safety stage failed): the host stops the bindings and the program, releases every voice and shows "Audio stopped — the safety stage failed. Restart audio to continue." `run` then throws until Restart Audio.
   - `duck`: the host shows "Level reduced — sustained loud output".
   - Without `bus.setHandler`, the host traces `SAFETY` / `noHandler` at level `warn`.
4. Call `engine.pump(ctx.currentTime + 0.1)` every 25 ms (granular schedules grains ahead). A pump that throws is traced `SAFETY` / `error` once until a pump succeeds again.
   - A realtime bus starts with `masterGain` at 0. The host calls `bus.fadeIn(level)` once the engine exists and after every resume of the context (a Run that resumes a suspended context, or a `statechange` back to `running`), with `level` from its `masterLevel` option (`src/audio-host/master.js`); `null` while muted after Panic skips the fade.
   - A seed change replaces the engine: the host calls `releaseAll(t)` and `fadeOutAll(t)` on the old engine, disposes it 50 ms later, then constructs the new one on the same bus.
   - Teardown (`host.dispose()`, when the page leaves or for Restart Audio) does the same: `releaseAll(t)`, `fadeOutAll(t)`, then `dispose()` 50 ms later, so leaving a playing piece never clicks.
5. Map IR instruments to engine widgets with `irToWidgets(ir, reactions, followed)` (`src/audio-host/widgets.js`) and call `engine.sync(widgets)` on start and after each hot reload:
   ```js
   const widgets = ir.instruments.map((i) => ({
     id: i.id, type: i.type, muted: muted.has(i.id), solo: false, armed: false,
     volumeDb: i.volumeDb, part: 'all',
     params: followed[i.id] ? { ...i.params, ...followed[i.id] } : i.params,
     octave: i.octave,
     cents: Math.min(Math.max(i.cents + detuneCents, -100), 100),
   }));
   ```
6. Call `engine.setTempo(ir.tempo)`, then `engine.setFx(id, instrument.fx)` for every instrument and `engine.setFx('master', ir.master.fx)` (`audio/effects.md`).
7. Call `engine.setLfos` and `engine.setMods` with the modulation configuration (Effects and modulation).
8. Freshness reactions `mute` and `only` set `muted` on widgets and call `engine.sync` again; the engine applies the gain change with smoothing.
9. Every `engine.sync` passes the current value of each followed parameter in `params`, so a sync for a reaction or a hot reload does not reset a followed parameter to its IR value.

On a hot reload the host passes the full widget list to `engine.sync`, calls `setTempo` when the tempo changed, `setFx` for each chain whose slot list changed (and `setFx(id, [])` for a removed instrument with a chain, before the sync), and `setLfos` and `setMods` when either list changed. It then rebinds changed bindings, restarts the program when one runs or the reloaded IR has handlers, and emits one `RELOAD` record (component `audio-host`, event `reload`, `data` `{ changed }`) with the changed ids. A Run emits `RELOAD` / `run` with the instrument and binding ids. A binding is unchanged when its IR entry and its instrument's type are; for an effect follow (`fxParam`, `fxBypass`) the slot list of the owning chain must also be unchanged, because `setFx` on a changed chain resets its parameters and bypass to the IR values and a kept follow would not send again until its value changes. Stop releases every binding and calls `engine.sync([])`. Panic (`src/audio-host/master.js`) calls `engine.panic(t)`, which releases every voice and resets every effect chain after the voice fade, then Stop, and ramps the master to 0 over 10 ms; the master stays muted until Reset (a single click at least 1 s after Panic) or a change of the master volume.

The master level, master fade-in, safety limiter and duck are engine behavior. Effect chains sit before the safety stage, so the safety stage applies to effect output.

## Program host
`src/bind/program.js` (`createProgramHost`) runs a piece's program (`piece-dsl.md`, Program) next to the binding runtime. The audio host creates it in `run` when the IR has `program.handlers` and a VM is attached, and creates it again on every reload of such a piece.

1. **Start.** Records the audio time `t0`, emits `RELOAD` / `start` (component `program`) with the handler ids, sends `start` with the IR's groups, their current objects from `sky.get` and every source's freshness from `sky.sources`, and applies the reply.
2. **Batches.** Subscribes to `enter`, `update`, `exit` and `freshness` events, keeps the change events of the IR's groups, and queues them as plain objects. Every 25 ms, when no batch is outstanding, it sends one `batch` with `now = (audioTime − t0) × 1000`, the queued events and the value of each declared orbit (`orbit(objectId, quantity, timeScale)`, the propagator's latest sample), then applies the reply. Events that arrive while a batch is outstanding go into the next one. At most 4096 events wait; past that the oldest is dropped and traced `BIND` / `dropped`.
3. **Scheduling.** A command's audio time is `t0 + at / 1000 + 0.1`, or the current audio time when that has passed. It is at most 0.1 s after the current audio time: `at` never exceeds the batch's `now`, and a later `at` is pulled back.
4. **Stop.** Unsubscribes, stops the batches, releases every held note at the current audio time and sends `stop`. Stop, Panic, a safety `fault`, a safety `error` and a hot reload stop the program host. So does a reply with an error from handler `setup` or `vm`, which means the VM does not hold the program; the host reports that error as `handler_error` and sends no further batches.

Every command is checked again at this boundary, whatever the VM sent:

| Command | Engine call | Checks |
|---|---|---|
| `play` `{ inst, pitch, velocity, pan, durationMs }` | `noteOn(pitch, velocity, t, tag)`, `setVoicePan(tag, pan)` when `pan` is not 0 and the instrument implements it, `noteOff(pitch, t + durationMs / 1000, tag)`; `tag` is `prog:<inst>:n<k>` | Pitch 0–127, velocity 1–127, pan −1–1 (`values.js`); `durationMs` 20–10,000. At most 200 note starts per second for the whole program (token bucket, `createTokenBucket`); the rest are dropped and traced `BIND` / `dropped`. |
| `hold` `{ inst, key, pitch, velocity, pan }` | `noteOff` of a note held under `key`, then `noteOn` with tag `prog:<inst>:k:<key>` and `setVoicePan` | As `play`, and the same note-start budget |
| `glide` `{ inst, key, pitch, ms }` | `setVoicePitch(tag, pitch, ms)`; without it, `noteOff` and `noteOn`, traced `fallback` | `ms` 0–10,000; ignored when `key` is not held |
| `stop` `{ inst, key }`, `stopAll` `{ inst }` | `noteOff(pitch, max(t, start + 0.005), tag)` | Ignored when nothing is held |
| `set` `{ target, value, smoothMs }` | `setParam` (instrument) or `setFxParam` (slot), through a one-pole smoother (`createSmoother`) stepped on the 25 ms tick and sent at most 30 times per second; `smoothMs` 0 sends the value at once | `target` names a numeric parameter of an IR instrument or slot (`kind` `number` in the definition tables); `value` is clamped to its range; `smoothMs` 0–60,000 |
| `set` `{ target: '<slot>.bypass', value }` | `setFxBypass(slot, on)` | `value` is a boolean |
| `set` `{ target: '<inst>.harmonics', value }` | `setParam('harmonics', values)`, without smoothing | `target` is a list parameter of an IR instrument (`kind: 'array'` in the definition tables); `value` is a list of finite numbers no longer than the parameter's `length`, each clamped to its range. At most 30 calls per instrument per second; a newer value replaces one waiting to be sent. |
| `layer` `{ layer, props }` | Merged into the values the session pushes to the renderer; traced `VISUAL` / `layerSet` | Properties exist for the layer type (`LAYER_DEFS`) and are coerced with `coerceProp`; others are dropped and traced `invalid`. The flash guard applies in the renderer |

- A command with an unknown `op`, instrument, slot or layer, or with a value of the wrong kind, is dropped and traced `BIND` / `invalid` at level `warn`.
- More than 256 commands in one reply: the rest are dropped and traced.
- Every engine call is traced at stage `AUDIO`, component `program`. A command's trace id is its `trace` (the sky event that caused it), so the console's Trace panel shows event, handler and note in one chain. Timer commands get one new trace id per handler per batch.
- Handler errors are traced `BIND` / `handlerError` at level `error` and reported to the session as `handler_error` problems.
- **Watchdog.** A `start` or `batch` without a reply within 250 ms makes the sandbox terminate the worker. The program host releases its notes, traces `SAFETY` / `programTimeout` at level `error`, reports `handler_timeout`, and stops. The binding runtime keeps running.

## Voice identity
Each sustained voice is identified by a source tag `sky:<bindingId>:<objectId>`, passed as the `source` argument of `noteOn` and `noteOff`. Each trigger note uses `trig:<bindingId>`. Program notes use `prog:<instrumentId>:n<k>` (`play`) and `prog:<instrumentId>:k:<key>` (`hold`). `noteOff(pitch, time, source)` releases the oldest matching voice with that pitch and source tag, so the runtime always passes the pitch it started the voice with.

## Sustained voices
For a `voices` binding:
1. On every event in the binding's group, compute the selected set: the live objects, ordered by `select.by` in `select.order`, limited to `select.top` (or the cap when `select` is `null`).
2. For each object that enters the selected set: evaluate `pitch` and `velocity`. If `pitch` is not `null`, call `noteOn(pitch, velocity, ctx.currentTime, tag)`, then `setVoicePan(tag, pan)` and `setVoiceMod(tag, voiceMods)` when the instrument implements them.
3. For each object that leaves the selected set or exits: `noteOff(startedPitch, ctx.currentTime, tag)`.
4. For each selected object that updates: evaluate `pitch`, `pan` and `voiceMods`. If pitch changed by more than 0.01 semitones, call `setVoicePitch(tag, pitch, 150)`. Without `setVoicePitch`, release and restart the voice and trace `fallback`.

- A selected object whose `pitch` is `null` stays selected without sounding; an update with a non-null pitch starts it. A sounding voice whose pitch becomes `null` keeps its pitch.
- Objects whose `select.by` value is not a finite number sort last. Ties sort by id.
- Every `noteOff` for a sustained voice uses `max(ctx.currentTime, startTime + 0.005)`, because `noteOff` releases only voices that started before its time and `ctx.currentTime` does not advance within one task.
- Velocity is rounded and clamped to 1–127 (default 100 when `null`), pitch to 0–127, pan and each `voiceMods` value to −1 to 1. `AUDIO` records carry the clamped value and the requested value (`pitchRequested`).
- Voice options that reference other groups or `orbit` nodes are re-evaluated for every sounding voice on those events and on each orbit post.

Caps: 16 voices per instrument, 4 for granular, 64 in total (`audio/audio-engine-core.md`). The validator enforces per-binding caps. The runtime counts its own sustained and trigger voices per instrument; when a `noteOn` would exceed the instrument's cap or the 64-voice total, for example because several bindings target one instrument, the engine's voice stealing applies and the runtime traces `AUDIO` / `stolen` at level `warn`.

## Triggers
For a `trigger` binding:
1. An event of the binding's `event` kind in its group arrives, and `when` evaluates to `true` (or is `null`). `enter` events with `initial: true` (the store's first load of a followed group) never fire a trigger; voices treat them as enters.
2. Evaluate `pitch`. A `null` pitch does not fire and takes no token.
3. A token bucket with capacity `ceil(maxPerSecond)` (at least 1), starting full, and refill rate `maxPerSecond` admits the event. An event that finds the bucket empty is dropped, not queued, and traced `BIND` / `dropped`.
4. Evaluate `velocity`, call `noteOn(pitch, velocity, ctx.currentTime, tag)` and `noteOff(pitch, ctx.currentTime + durationMs / 1000, tag)`; `noteOff` accepts a future time. The runtime traces `BIND` / `fired` and `AUDIO` / `noteOn`.

A full-group CelesTrak refresh can emit hundreds of `update` events at once. The bucket keeps the audible result bounded.

## Parameters
For a `param` binding:
1. Re-evaluate `expr` on every event that can affect it: events in groups the expression references, and every SWPC update for `swpc` nodes.
2. Feed the value into a one-pole smoother with time constant `smoothMs / 3`, so the value reaches 95% of a step after `smoothMs`. A result that is not a number keeps the last value.
3. On every tick of the update loop, call `setParam(param, smoothedValue)` while the smoother is moving. `setParam` clamps through `coerceParam`, and the engine smooths again over 10 ms.
4. Trace one `AUDIO` `setParam` record when the smoother starts moving toward a new value and one when it settles, each with `requested` (the expression result), `sent` (the smoothed value), `applied` (`getParams()[param]` after the call) and `phase` (`start` or `settled`).

The smoother starts from `getParams()[param]` (for an effect parameter, the slot's IR value) and snaps to the target once within 0.1% of the step, about 2.3 × `smoothMs` after it. The update loop runs every 34 ms, the first whole millisecond above 1000 / 30, so it stays within 30 calls per second.

## Effect parameters
- A `follow` on an effect parameter (`slot.<param>.follow`) behaves like a `param` binding and calls `engine.setFxParam(slotId, param, value)` at up to 30 Hz; its `AUDIO` records have event `setFxParam`, and `applied` is the value sent.
- `slot.bypass.follow(expr)` calls `engine.setFxBypass(slotId, on)` when the boolean result changes from the slot's IR `bypass` or the last value sent, and traces `AUDIO` / `setFxBypass`. A result that is not a boolean is ignored.
- Enum parameters receive option indices. A `follow` result is rounded to the nearest index and clamped to the options; the index is sent unsmoothed, once per change. The runtime reads which parameters are enums from the definition tables (`DEFS.effects[type].params[name].kind`, `src/dsl/load-defs.js`; the `defs` option replaces them in tests).

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
- A reaction is active while any source it matches is in its state (`stale` or `down`). The runtime recomputes the combined state on every `freshness` event, so a source that leaves the state ends the reaction's actions.
- `detuneCents` adds to every instrument's `cents` (clamped to ±100) through `engine.sync`.
- `mute` mutes the listed instruments; `only` mutes every other instrument. Both change widget `muted` flags.
- `desaturate` is a visual action (`visuals.md`).
- Several active reactions combine: `detuneCents` and `desaturate` take the largest value; mutes take the union.
- `'*'` matches the sources of the piece's `groups`. A group key matches the source of that group.
- When the combined state changes, the runtime traces `BIND` / `reaction` (component `reactions`) and reports the state (`detuneCents`, `muted`, `desaturate`) to the host, which syncs widgets and passes `desaturate` to the renderer.

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
- `createTraceSink()`, which collects trace records, and `skyObj(group, key, fields)`, which builds a `SkyObject`.

Binding tests use these fakes and never construct an `AudioContext`.

## Trace replay
A console export under `tests/fixtures/traces/<name>.jsonl` is paired with `<name>.ir.json`, the IR that was running. `tests/trace-replay.test.js` rebuilds objects from the `CHANGE` records (`data.diff.after`, with `initial` passed through), feeds them through the runtime with fakes, and compares by `event` and `data` the `AUDIO` records that follow directly from sky events: `noteOn`, `noteOff`, `setVoicePitch`, `setVoicePan`, `setVoiceMod`, `fallback`, `stolen`, `setFxBypass` and `modValue`.

## Limitations
- Pluck implements none of the voice-control extensions: its sustained voices ignore `pan` and `voiceMods`, and a pitch change releases and restarts the voice.
- Orbit-driven voice options are re-evaluated for at most 16 voices per binding on each orbit post; further voices keep their values until their object updates or another group the options reference changes.

## Sources
- User audio engine: `audio/audio-engine-core.md`, `audio/audio-safety.md`, `audio/synthesis-conventions.md`, `audio/effects.md`, `audio/modulation.md`
- Assignment 2 source: `src/audio/instrument.js`, `src/audio/engine.js`, `src/state/session.js`
