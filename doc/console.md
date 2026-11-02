# Console

## Scope
The trace bus, trace record format, console panels, export and access rules.

## Job
Record each step from a source run to audio and visual output, and display those records so any viewer can see which data drives the piece.

## Trace bus
- `src/trace/bus.js` holds the default bus of the tab and exports its methods, `createTraceBus`, `normalizeRecord`, `recordsToJsonl`, `newTraceId`, `safeTrace` and the vocabularies `STAGES` and `LEVELS`.
- Records enter a ring buffer of 2,000 entries by default. When the buffer is full, the oldest record is dropped.
- The bus is read-only for consumers. The console panels add no Realtime subscriptions and do not affect playback; the public `/console` page follows groups through a sky store of its own (Access).

```js
// default bus of the tab
trace(record);                 // validates, stamps `t` when absent, copies, freezes, stores, notifies; returns the stored record
subscribe(fn);                 // fn(record) for every new record; returns unsubscribe
records();                     // buffered records, oldest first
chain(traceId);                // records of one trace id, in stage order, then time order
clear();
capacity();                    // current buffer size
setCapacity(n);                // 500–5000 (settings `data.consoleBuffer`); drops the oldest records beyond n
toJsonl();                     // buffer as JSON Lines
newTraceId(prefix = '');       // prefix + UUID, for example `syn-…`
safeTrace(fn, label);          // wraps a trace function so it never throws; a rejected record goes to console.error with `label`

createTraceBus({ capacity, now });   // separate bus with trace, subscribe, records, chain, clear, capacity, setCapacity (1–5000) and toJsonl; tests use it
```
- `trace` throws `TypeError` for a record without a non-empty `traceId`, `component` or `event`, with an unknown `stage` or `level`, with a `data` value that is not a plain object, with a `t` that is not an ISO 8601 time, with a `replay` that is not a positive number, or with a `synthetic` other than `true`. `level` defaults to `info` and `data` to `{}`. The bus stores a deep copy of `data`.
- Stage order for `chain` is the order of the `stage` list below.
- A subscriber that throws is removed from the bus and does not affect other subscribers.
- Producers that must not stop on a rejected record (the sky store, the renderer, the propagator) call `trace` through `safeTrace`.
- `src/trace/jsonl.js` exports `toJsonl(records)`, `parseJsonl(text)` (skips blank lines, requires `t`, validates each line and names the line number on error) and `eventsFromTrace(records)`, which rebuilds the `SkyEvent` sequence from `CHANGE` records for trace-replay tests.

## Trace record
```json
{
  "t": "2026-10-29T14:02:11.405Z",
  "traceId": "0b6f6c0e-2c4e-4d5e-9a8f-1f9d3c2b7a10",
  "stage": "AUDIO",
  "component": "bind.b1",
  "event": "noteOn",
  "level": "info",
  "data": { "inst": "i3", "pitch": 79, "pitchRequested": 78.6, "velocity": 100, "source": "trig:b1" }
}
```
| Field | Meaning |
|---|---|
| `t` | ISO 8601 UTC timestamp |
| `traceId` | Shared by all records caused by one change |
| `stage` | `SOURCE`, `CHANGE`, `REALTIME`, `BIND`, `AUDIO`, `VISUAL`, `RELOAD`, `SAFETY` |
| `component` | Emitter, for example `sky`, `bind.b1`, `program`, `layer.l0`, `flash-guard` |
| `event` | Stage-specific name, for example `enter`, `dropped`, `setParam`, `fallback` |
| `level` | `info`, `warn`, `error` |
| `data` | Stage-specific payload |
| `replay` | Optional; replay speed (1, 10, 100, 1000) on records caused by replayed events |
| `synthetic` | Optional; `true` on records caused by synthetic events |

## Causal chain
| Stage | Origin | Example `data` |
|---|---|---|
| `SOURCE` | Reserved; no page module emits it. Source runs appear in the Sources panel. | |
| `CHANGE` | Sky store, for each applied live, replayed or synthetic change | `{ "objectId": "jpl.scout:P21kQ3x", "group": "jpl.scout", "source": "jpl.scout", "kind": "enter", "diff": { "before": null, "after": {...} } }`; snapshot enters add `"initial": true` |
| `REALTIME` | Sky store | `{ "table": "sky_objects", "latencyMs": 18 }` |
| `BIND` | Binding runtime, program host | `{ "binding": "b1", "result": "fired", "objectId": "jpl.scout:P21kQ3x" }` |
| `AUDIO` | Binding runtime and program host, after the engine call | `{ "inst": "i3", "param": "cutoff", "requested": 18000, "sent": 18000, "applied": 16000, "phase": "settled" }` |
| `AUDIO` | Binding runtime, data modulation source | `{ "event": "modValue", "source": "dat2", "class": "random-walk", "raw": 1.3, "posted": 1 }` |
| `VISUAL` | Renderer, binding runtime, program host | `{ "layer": "l2", "objectId": "jpl.scout:P21kQ3x" }` |
| `RELOAD` | Audio host, program host | `{ "changed": ["b2", "l0"] }` |
| `SAFETY` | Master bus handler, engine fault handlers, program watchdog, flash guard | `{ "event": "fxFault", "owner": "i0", "slot": "f1", "type": "reverb" }` |

`AUDIO` records show values before and after clamping, so a clamped data value appears clamped in the console.

## Panels
The editor's bottom panel holds every panel: its Console tab has Sources, Events, Voices, Modulation and Effects, and its Trace tab holds the Trace panel. The public `/console` page has Sources, Events and Trace.

| Panel | Content |
|---|---|
| Sources | One row per registry id: freshness, last run, rows changed, duration, last error. Expanding a row fetches the stored raw response from `source_samples`. |
| Events | `enter`, `update` and `exit` records with field diffs (before → after), the newest 500 shown. Filters: source, group, followed groups only, fired bindings only (a trigger fired or a voice started or stopped). |
| Trace | The newest 400 records, and the chain of the selected trace id in stage order. Selecting any record selects its chain. |
| Voices | Each sounding sustained voice with its object, refreshed every 500 ms: instrument, object name (the `name` field, or the object id), bound fields and values, pitch as note name with cents and in Hz. Selecting a voice highlights its object in the preview. |
| Modulation | One row per routed target, refreshed every 100 ms: the IR base value, the modulated value (`engine.modulatedValue`), and each route with its source and depth, for example `f1.decay 6 → 7.4 ← lfo0 sine 0.03 Hz (0.2)`. A table lists the data sources with their class (`vlfo`, `random-walk`, `step`, with `time-scaled ×n` when applicable) and their expression's latest raw and posted values. |
| Effects | Each chain in order with slot id and type, the IR bypass state, and the fault state from `SAFETY` / `fxFault` records |

Controls: Pause and Resume, Clear and Download Trace; each scrolling list has a Follow live toggle. Pause freezes the displayed lists; records keep entering the bus. Follow live scrolls to the newest record; scrolling up turns it off. Clear empties the bus. Replayed records show the label `Replay ×<speed>`; synthetic records show `Synthetic`.

## Export
Download Trace writes the buffer as JSON Lines (`.jsonl`), one record per line. `tests/trace-replay.test.js` accepts an exported file as a fixture (`testing.md`).

## Access
- `/console` is public. It shows sources, runs and events for every group, without signing in.
- On load, `/console` reads the last 200 `changes` rows by REST, so recent events of every group appear without a Realtime subscription; a failed read shows an error with Retry. The Events panel merges these rows with live `CHANGE` records by time, without duplicates. Live events come from a sky store that follows the groups ticked in the console's group list; debris groups (`celestrak.cosmos-2251-debris`) start unticked because of their message cost (`database.md`, Free-tier message budget).
- The Sources panel reads the newest 300 `runs` rows by REST on load and every 30 s while the tab is visible; freshness comes from the sky store's `source_status` poll. Last run, rows changed and duration come from the newest `runs` row of each registry id, and last error from its newest failed run among those rows.
- Binding, audio and visual records exist only in the tab that plays a project, and only for that project.

## Accessibility
- The event list and the Trace panel's record list use `role="log"`.
- Screen-reader announcements are throttled to one summary every 10 s, for example "3 events in the last 10 seconds". Pause stops announcements.
- Every panel is reachable by keyboard; `Mod-J` toggles the bottom panel in the editor.

## Sources
- W3C, WAI-ARIA 1.2, `log` role: https://www.w3.org/TR/wai-aria-1.2/#log
