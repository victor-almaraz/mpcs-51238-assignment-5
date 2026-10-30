# Bindings

## Scope
The binding runtime that turns sky events into instrument calls, the audio host that connects IR instruments to the engine, and the instrument contracts the runtime calls. Synthesis and `Instrument` internals are user-owned and documented in `audio/`.

## Job
Apply each IR binding and data-driven modulation source to sky events as bounded, traced calls on the engine.

## Interface
- **Input:** validated IR (`piece-dsl.md`), `SkyEvent` stream (`sky-contract.md`), engine handle.
- **Output:** `noteOn`, `noteOff`, `setParam`, voice-control, effect and modulation calls; layer property values for the renderer; trace records.
- **Errors:** a call that throws is caught, traced at level `error` with the binding id, and the binding is disabled until the next reload. The rest of the piece keeps running.

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

The master level, master fade-in, safety limiter and duck are engine behavior. Effect chains sit before the safety stage, so the safety stage applies to effect output.

## Voice identity
Each sustained voice is identified by a source tag `sky:<bindingId>:<objectId>`, passed as the `source` argument of `noteOn` and `noteOff`. Each trigger note uses `trig:<bindingId>`. `noteOff(pitch, time, source)` releases the oldest matching voice with that pitch and source tag, so the runtime always passes the pitch it started the voice with.

## Sustained voices
For a `voices` binding:
1. On every event in the binding's group, compute the selected set: the live objects, ordered by `select.by` in `select.order`, limited to `select.top` (or the cap when `select` is `null`).
2. For each object that enters the selected set: evaluate `pitch` and `velocity`. If `pitch` is not `null`, call `noteOn(pitch, velocity, ctx.currentTime, tag)`, then `setVoicePan(tag, pan)` and `setVoiceMod(tag, voiceMods)` when the instrument implements them.
3. For each object that leaves the selected set or exits: `noteOff(startedPitch, ctx.currentTime, tag)`.
4. For each selected object that updates: evaluate `pitch`, `pan` and `voiceMods`. If pitch changed by more than 0.01 semitones, call `setVoicePitch(tag, pitch, 150)`. Without `setVoicePitch`, release and restart the voice and trace `fallback`.

Caps: 16 voices per instrument, 4 for granular, 64 in total (`audio/audio-engine-core.md`). The validator enforces per-binding caps. When several bindings target one instrument, the engine's voice stealing applies and the trace records `stolen`.

## Triggers
For a `trigger` binding:
1. An event of the binding's `event` kind in its group arrives, and `when` evaluates to `true` (or is `null`).
2. A token bucket with capacity `ceil(maxPerSecond)` and refill rate `maxPerSecond` admits the event. An event that finds the bucket empty is dropped, not queued, and traced as `dropped`.
3. Evaluate `pitch` and `velocity`. Call `noteOn(pitch, velocity, ctx.currentTime, tag)` and schedule `noteOff(pitch, ctx.currentTime + durationMs / 1000, tag)`.

A full-group CelesTrak refresh can emit hundreds of `update` events at once. The bucket keeps the audible result bounded.

## Parameters
For a `param` binding:
1. Re-evaluate `expr` on every event that can affect it: events in groups the expression references, and every SWPC update for `swpc` nodes.
2. Feed the value into a one-pole smoother with time constant `smoothMs / 3`, so the value settles within about `smoothMs`.
3. Every 33 ms (30 Hz), call `setParam(param, smoothedValue)` while the smoother is moving. `setParam` clamps through `coerceParam`, and the engine smooths again over 10 ms.
4. Trace the requested value and `getParams()[param]` after the call.

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
}
```
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

## Fakes
`tests/fakes/fake-instrument.js` implements `Instrument` and `VoiceControl`, records every call as `[method, ...args]`, and throws `CapExceeded` when more than its cap of voices sound at once. `tests/fakes/fake-engine.js` implements `sync`, `get`, `pump`, `EngineFx` and `EngineMod`, records every call, and enforces the effect and modulation limits by throwing the documented errors. Binding tests use these fakes and never construct an `AudioContext`.

## Open items
- Verify with the user that the engine treats `source` as an opaque string. Assignment 2 passes only `'file'` and `'live'`.

## Sources
- User audio engine: `audio/audio-engine-core.md`, `audio/audio-safety.md`, `audio/synthesis-conventions.md`, `audio/effects.md`, `audio/modulation.md`
- Assignment 2 source: `src/audio/instrument.js`, `src/audio/engine.js`, `src/state/session.js`
