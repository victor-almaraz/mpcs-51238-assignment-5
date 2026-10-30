# Sky contract

## Scope
The browser sky store: its API, events, freshness rules, replay mode, synthetic triggers, the group registry `src/sky/groups.json` and the orbit sources. Bindings, visuals, the console and the UI depend on this interface only, never on Supabase directly.

## Job
Hold the objects of the followed groups and the freshness of each source, and emit an event for every change.

## Types
```ts
type SkyObject = {
  id: string;
  source: string;
  group: string;
  fields: Record<string, number | string | boolean | null>;
};

type FreshState = 'loading' | 'fresh' | 'stale' | 'down';

type Freshness = {
  source: string;               // registry id
  state: FreshState;
  lastRun: string | null;       // ISO 8601
  lastSuccess: string | null;
};

type SkyEvent =
  | { type: 'enter' | 'update' | 'exit'; obj: SkyObject; prev: SkyObject | null;
      traceId: string; initial?: true; replay?: true; synthetic?: true }
  | { type: 'freshness'; freshness: Freshness; replay?: true; synthetic?: true };
```
- `obj` and `prev` are frozen. For `exit`, `obj` holds the last fields and `prev` is the same object.
- `initial: true` marks the `enter` events of a group's first snapshot after `follow` adds the group. Sustained-voice bindings treat them as enters; trigger bindings ignore them, so existing objects do not fire triggers when a piece starts.

## API
```ts
interface Sky {
  on(type: SkyEvent['type'] | '*', fn: (e: SkyEvent) => void): () => void;  // returns unsubscribe
  get(group: string): SkyObject[];                                    // live objects, id order
  object(id: string): SkyObject | null;                               // one live object
  freshness(source: string): Freshness;
  sources(): Freshness[];                                             // every known source, id order
  follow(groups: string[]): Promise<void>;                            // replaces the followed set
  followed(): string[];
  readonly mode: 'live' | 'replay' | 'synthetic';
  close(): void;                                                      // stops channels and timers
}
```
`src/sky/index.js` exports `createSky`, `createReplay`, `createSynthetic`, the orbit functions and the group helpers.

```js
const sky = createSky({ client, now, timers, doc, trace, uuid });
```
| Dependency | Meaning | Default |
|---|---|---|
| `client` | Supabase client (`auth.md`, Clients); required | |
| `now` | Clock, `() => ms since epoch` | `Date.now` |
| `timers` | `{ setTimeout, clearTimeout, setInterval, clearInterval }` | globals |
| `doc` | Object with `visibilityState` and `addEventListener('visibilitychange', fn)` | `globalThis.document`, or always visible |
| `trace` | Trace function (`console.md`, Trace bus) | `trace` from `src/trace/bus.js` |
| `uuid` | `() => string` | `crypto.randomUUID` |

- A listener that throws is traced at level `error` and does not stop other listeners.

## Live mode
- `follow` rejects with an error naming the key when a group is not in `groups.json`, or when more than 100 groups are given.
- `follow` subscribes to `postgres_changes` on `sky_objects` with the filter `group_key=in.(...)`. After the channel reports `SUBSCRIBED`, it selects the live rows of the groups (`removed_at is null`, id order, pages of 1,000). Events received before the select resolves are buffered and applied after it.
- The select is applied as a diff against the held objects: a new row emits `enter`, a row whose `trace_id` differs emits `update`, a held object missing from the result emits `exit`. The trace id of such an exit is the row's current `trace_id` (read by id), or a new UUID when the row has been pruned. Rows of a group that the store did not hold before emit `enter` with `initial: true`.
- Groups removed from the followed set are dropped without events.
- A payload with `removed_at` set emits `exit` for a held object and is ignored otherwise. A payload without `removed_at` emits `update` for a held object and `enter` otherwise, so a payload that clears `removed_at` emits `enter`.
- A payload whose `trace_id` equals the held object's, or whose `updated_at` is older than the held object's, is a duplicate and is ignored. `DELETE` payloads emit `exit` only for a held object.
- The trace id of a live event is the row's `trace_id` column, which arrives in the Realtime payload.
- Every Realtime payload and REST row is validated: `id`, `source` and `group_key` are non-empty strings, `fields` is a flat object of finite numbers, strings, booleans and `null`, `trace_id` is a string, `updated_at` is an ISO 8601 time, and `removed_at` is `null` or an ISO 8601 time. An invalid payload is dropped and traced as `REALTIME` / `invalid_payload` at level `error`.
- Each applied live change produces a `CHANGE` record (`{ objectId, group, source, kind, diff: { before, after }, initial? }`) and, for Realtime payloads, a `REALTIME` record (`{ table: 'sky_objects', latencyMs }`, from `commit_timestamp`), both with the event's trace id.
- On `CHANNEL_ERROR`, `TIMED_OUT` or an unrequested `CLOSED`, the store removes the channel, calls `client.realtime.setAuth()` and calls `follow` again after 1 s, 2 s, 4 s, … up to 30 s. A `SUBSCRIBED` status resets the delay.
- The followed set of a running project is its `project_subscriptions.group_key` values.
- The store closes its channel 60 s after `document.visibilityState` becomes `hidden`, and calls `follow` again when the tab is visible.

## Freshness
The store reads `source_status` by REST every 30 s, starting when it is created, and evaluates each source every 5 s and after each read.

| State | Rule |
|---|---|
| `loading` | No `source_status` row received |
| `down` | `halted` is true, or `last_ok` is false, or the source's group is followed and the Realtime channel is in error |
| `stale` | `last_success_at` is null, or `now - last_success_at > 3 × interval_sec` |
| `fresh` | Otherwise |

`lastRun` is `last_attempt_at`; `lastSuccess` is `last_success_at`. A state change emits a `freshness` event. The status bar and freshness reactions consume these events. For CelesTrak (interval 7500 s), `stale` begins after 6 h 15 min without a successful run. A failed read keeps the previous rows and is traced as `REALTIME` / `status_poll_failed` at level `warn`.

## Replay mode
```js
const sky = createReplay({ client, from, to, speed, now, timers, trace, onEnd });
await sky.follow(groups);   // loads the window and starts playback
sky.now();                  // replay clock, ms since epoch
```
- Replay reads `changes` for a time window within the 7-day retention and plays the events at 1×, 10×, 100× or 1000×. `from` and `to` are ms since epoch; `to` defaults to the time of `follow`.
- The starting snapshot is the state of each object at `from`: for an object with a change at or after `from`, the `before` value of its first such change; otherwise its current `sky_objects` row, when that row is live. This covers objects that did not change within the retention window. The snapshot emits `enter` events with `initial: true`.
- Events in the window play at `(at - from) / speed` after `follow` resolves. The replay clock `now()` returns `from + (elapsed × speed)`; the orbit propagator uses it, so orbits stay consistent with the replayed elements.
- Replayed events carry their original `traceId` and `replay: true`. Freshness is reported as `fresh` for every source during replay. Replayed `CHANGE` records carry `replay: <speed>`.
- `onEnd` is called once after the last event; the objects keep their final state. `close()` stops playback.
- Replay uses the same `Sky` interface; bindings cannot tell replayed events from live ones.

## Synthetic triggers
```js
const syn = createSynthetic(sky, { uuid });
syn.enter(group, key, fields);   // object id `${group}:${key}`
syn.update(objectId, fields);    // merges fields into the held object
syn.exit(objectId);
syn.freshness(source, state);    // holds state until syn.clear(); null releases the source
syn.clear();                     // removes overrides and calls follow again
```
- With `?dev=1`, the editor shows a panel that emits fabricated `enter`, `update`, `exit` and `freshness` events for any group.
- Synthetic events carry `synthetic: true` and a trace id prefixed `syn-`. They change only the store in that tab and never write to the database.
- `sky.mode` is `synthetic` from the first synthetic event until `clear()`. A later `follow` replaces synthetic objects with the database rows.

## Groups
`src/sky/groups.json` lists every group with its registry id, class and fields. The DSL type generator, the editor completion, the Sky browser and the guide tests read it.
```json
{
  "swpc.wind": {
    "source": "swpc.wind",
    "class": "random-walk",
    "orbit": false,
    "fields": {
      "speed": { "type": "number", "unit": "km/s" },
      "spacecraft": { "type": "string", "unit": "" }
    }
  }
}
```
| Key | Meaning |
|---|---|
| `source` | Registry id (`sources.md`) |
| `class` | Class of the group's field values: `step` or `random-walk` (`sources.md`, Source classes) |
| `orbit` | `true` when objects carry orbital elements, so `orbit(...)` is valid (VLFO class) |
| `fields` | Every field the normalizer writes, with `type` (`number`, `string`, `boolean`) and `unit` (`""` when unitless) |

## Orbit sources
`src/sky/orbit.js` computes the VLFO quantities of `piece-dsl.md` (Orbits) with `satellite.js` 6. The SGP4 worker and tests call it; it has no other dependencies.
```js
const orb = createOrbit(fields);           // json2satrec(toOmm(fields)); throws OmmError on missing elements
orb.periodMin;                             // 1440 / meanMotion
orb.sample(ms, observer);                  // { ok: true, values, eci, geodetic } or { ok: false, error }
orbitValue(orb, quantity, ms, observer);   // one quantity or null
scaledTime(ms, t0, timeScale);             // t0 + (ms - t0) * timeScale
```
| Quantity | Computation |
|---|---|
| `latitude` | Geodetic latitude from `eciToGeodetic`, divided by the maximum latitude (inclination, or 180° − inclination when retrograde); 0 when the maximum is below 0.1°; clamped to −1..1 |
| `phaseSin`, `phaseCos` | Sine and cosine of the argument of latitude: the angle from the ascending node to the position, in the plane of the propagated position and velocity |
| `altitude` | `2 · (alt − perigeeAlt) / (apogeeAlt − perigeeAlt) − 1`, clamped; `alt` is the geocentric radius minus 6378.135 km, and `perigeeAlt`, `apogeeAlt` are `a(1 ∓ e) − 6378.135 km` from the satrec; 0 when the difference is below 1 km. The geocentric radius is used because geodetic height on a near-circular orbit varies with Earth's flattening twice per orbit by more than the perigee–apogee difference. |
| `longitude` | Geodetic longitude divided by 180° |
| `sunlit` | 1 or −1 from a cylindrical Earth-shadow test (radius 6378.135 km) against the Astronomical Almanac low-precision solar position |
| `elevation` | Elevation from `ecfToLookAngles` for `observer` `{ lat, lon }` in degrees at height 0, divided by 90°; `null` without an observer |

`ms` is the propagation time. Callers pass `scaledTime(...)` for `timeScale` above 1, and the replay clock in replay.

## Sources
- Supabase docs, Postgres Changes (filters): https://supabase.com/docs/guides/realtime/postgres-changes
- Supabase docs, Subscribing to Database Changes: https://supabase.com/docs/guides/realtime/subscribing-to-database-changes
- MDN, Page Visibility API: https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API
- satellite.js: https://github.com/shashwatak/satellite-js
- USNO, Approximate Solar Coordinates: https://aa.usno.navy.mil/faq/sun_approx
