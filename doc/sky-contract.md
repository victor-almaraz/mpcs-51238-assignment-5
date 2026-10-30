# Sky contract

## Scope
The browser sky store: its API, events, freshness rules, replay mode and synthetic triggers. Bindings, visuals, the console and the UI depend on this interface only, never on Supabase directly.

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
      traceId: string; replay?: true; synthetic?: true }
  | { type: 'freshness'; freshness: Freshness };
```

## API
```ts
interface Sky {
  on(type: SkyEvent['type'], fn: (e: SkyEvent) => void): () => void;  // returns unsubscribe
  get(group: string): SkyObject[];                                    // live objects, id order
  freshness(source: string): Freshness;
  follow(groups: string[]): Promise<void>;                            // replaces the followed set
  mode: 'live' | 'replay' | 'synthetic';
}
```
- `follow` selects live rows of the groups (`removed_at is null`), then subscribes to `postgres_changes` on `sky_objects` with the filter `group_key=in.(...)`. Events received before the select resolves are buffered and applied after it.
- A payload with `removed_at` set emits `exit`. A payload that clears `removed_at` emits `enter`.
- The trace id of a live event is the row's `trace_id` column, which arrives in the Realtime payload.
- The followed set of a running project is its `project_subscriptions.group_key` values.
- The store closes its channel 60 s after `document.visibilityState` becomes `hidden`, and calls `follow` again when the tab is visible.

## Freshness
The store reads `source_status` by REST every 30 s and evaluates each source every 5 s.

| State | Rule |
|---|---|
| `loading` | No `source_status` row received |
| `down` | `halted` is true, or `last_ok` is false |
| `stale` | `now - last_success_at > 3 × interval_sec` |
| `fresh` | Otherwise |

A state change emits a `freshness` event. The status bar and freshness reactions consume these events. For CelesTrak (interval 7500 s), `stale` begins after 6 h 15 min without a successful run.

## Replay mode
- Replay reads `changes` for a time window within the 7-day retention and plays the events at 1×, 10×, 100× or 1000×.
- The starting snapshot is the `after` value of each object's latest change before the window start.
- Replayed events carry their original `traceId` and `replay: true`. Freshness is reported as `fresh` for every source during replay.
- Replay uses the same `Sky` interface; bindings cannot tell replayed events from live ones.

## Synthetic triggers
- With `?dev=1`, the editor shows a panel that emits fabricated `enter`, `update`, `exit` and `freshness` events for any group.
- Synthetic events carry `synthetic: true` and a trace id prefixed `syn-`. They never write to the database.

## Sources
- Supabase docs, Postgres Changes (filters): https://supabase.com/docs/guides/realtime/postgres-changes
- MDN, Page Visibility API: https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API
