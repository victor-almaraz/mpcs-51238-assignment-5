# Console

## Scope
The trace bus, trace record format, console panels, export and access rules.

## Job
Record each step from a source run to audio and visual output, and display those records so any viewer can see which data drives the piece.

## Trace bus
- `src/trace/bus.js` exports `trace(record)` and `subscribe(fn)`.
- Records enter a ring buffer of 2,000 entries. When the buffer is full, the oldest record is dropped.
- The bus is read-only for consumers. The console adds no Realtime subscriptions and does not affect playback.

```js
// default bus of the tab
trace(record);                 // validates, stamps `t` when absent, freezes, stores, notifies; returns the stored record
subscribe(fn);                 // fn(record) for every new record; returns unsubscribe
records();                     // buffered records, oldest first
chain(traceId);                // records of one trace id, in stage order, then time order
clear();
setCapacity(n);                // 500–5000 (settings `data.consoleBuffer`); drops the oldest records beyond n
toJsonl();                     // buffer as JSON Lines
newTraceId(prefix = '');       // prefix + UUID, for example `syn-…`

createTraceBus({ capacity, now });   // separate bus with the same methods; tests use it
```
- `trace` throws `TypeError` for a record without a non-empty `traceId`, `component` or `event`, with an unknown `stage` or `level`, or with a `data` value that is not a plain object. `level` defaults to `info` and `data` to `{}`.
- Stage order for `chain` is the order of the `stage` list below.
- A subscriber that throws is removed from the bus and does not affect other subscribers.
- `src/trace/jsonl.js` exports `toJsonl(records)`, `parseJsonl(text)` (validates each line and names the line number on error) and `eventsFromTrace(records)`, which rebuilds the `SkyEvent` sequence from `CHANGE` records for trace-replay tests.

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
| `component` | Emitter, for example `sky`, `bind.b1`, `layer.l0`, `flash-guard` |
| `event` | Stage-specific name, for example `enter`, `dropped`, `setParam`, `fallback` |
| `level` | `info`, `warn`, `error` |
| `data` | Stage-specific payload |
| `replay` | Optional; replay speed (1, 10, 100, 1000) on records caused by replayed events |
| `synthetic` | Optional; `true` on records caused by synthetic events |

## Causal chain
| Stage | Origin | Example `data` |
|---|---|---|
| `SOURCE` | `runs` row matched by `source` and time | `{ "source": "jpl.scout", "ok": true, "rowsChanged": 1, "ms": 412 }` |
| `CHANGE` | `changes` row or Realtime payload | `{ "objectId": "jpl.scout:P21kQ3x", "group": "jpl.scout", "source": "jpl.scout", "kind": "enter", "diff": { "before": null, "after": {...} } }`; snapshot enters add `"initial": true` |
| `REALTIME` | Sky store | `{ "table": "sky_objects", "latencyMs": 18 }` |
| `BIND` | Binding runtime | `{ "binding": "b1", "result": "fired" }` |
| `AUDIO` | Binding runtime, after the engine call | `{ "inst": "i3", "param": "cutoff", "requested": 18000, "applied": 16000 }` |
| `AUDIO` | Binding runtime, data modulation source | `{ "event": "modValue", "source": "dat2", "class": "random-walk", "raw": 1.3, "posted": 1 }` |
| `SAFETY` | Engine fault handlers, flash guard | `{ "event": "fxFault", "owner": "i0", "slot": "f1", "type": "reverb" }` |
| `VISUAL` | Renderer | `{ "layer": "l2", "objectId": "jpl.scout:P21kQ3x" }` |

`AUDIO` records show values before and after clamping, so a clamped data value appears clamped in the console.

## Panels
| Panel | Content |
|---|---|
| Sources | One row per registry id: freshness, last run, rows changed, duration, last error. Expanding a row fetches the last raw response from `source_samples`. |
| Events | `enter`, `update` and `exit` records with field diffs (before → after). Filters: source, group, followed groups only, fired bindings only. |
| Trace | Records of the selected trace id, in stage order. Selecting any record selects its chain. |
| Sounding voices | Each active voice with its object: instrument, object name, bound fields and values, pitch in note name and Hz. Selecting a voice highlights its object in the preview. |
| Modulation | One row per routed target: base value, modulated value (`modulatedValue`, refreshed every 100 ms), and each route with its source and depth, for example `f1.decay 6.0 s → 7.4 s ← lfo0 sine 0.03 Hz (0.2)`. Data sources show their class (`vlfo`, `random-walk`, `step`), their expression's latest raw and posted values, and for VLFOs the orbit period and `time-scaled ×n` when applicable. |
| Effects | Each chain in order with slot type, bypass state and fault state |

Controls: pause, resume, follow-live toggle, clear. Pause freezes the displayed list; records keep entering the bus. Follow live scrolls to the newest record; scrolling up turns it off. Clear empties the bus. Replayed records show the label `Replay ×<speed>`; synthetic records show `Synthetic`.

## Export
"Download Trace" writes the buffer as JSON Lines (`.jsonl`), one record per line. `tests/trace-replay.test.js` accepts an exported file as a fixture (`testing.md`).

## Access
- `/console` is public. It shows sources, runs and events for every group, without signing in.
- On load, `/console` reads the last 200 `changes` rows by REST, so recent events of every group appear without a Realtime subscription. Live events come from a sky store that follows the groups ticked in the console's group list; debris groups (`celestrak.cosmos-2251-debris`) start unticked because of their message cost (`database.md`, Free-tier message budget).
- The Sources panel reads `runs` by REST with `source_status` (every 30 s): last run, rows changed and duration come from the newest `runs` row of each registry id, and last error from its newest failed run.
- Binding, audio and visual records exist only in the tab that plays a project, and only for that project.

## Accessibility
- The event list uses `role="log"`.
- Screen-reader announcements are throttled to one summary every 10 s, for example "3 events in the last 10 seconds". Pause stops announcements.
- Every panel is reachable by keyboard; `Mod-J` toggles the bottom panel in the editor.

## Sources
- W3C, WAI-ARIA 1.2, `log` role: https://www.w3.org/TR/wai-aria-1.2/#log
