---
title: Live data states
order: 7
---

# Live data states

Each data source is in one of four states, shown in the status bar:

| State | Symbol | Meaning |
|---|---|---|
| Loading | `…` | No status received yet |
| Fresh | `●` | The source has a successful update within its schedule |
| Stale | `◐` | No successful update for three update intervals |
| Down | `○` | The last attempt to read the source failed |

A stale or down source keeps its last values. Notes keep sounding and points keep their places.

## Reacting to state
`onStale(source, actions)` and `onDown(source, actions)` change the piece while a source is stale or down. The change reverses when the source is fresh again. `source` is a source name such as `'swpc.wind'`, a group, or `'*'` for any.

| Action | Effect |
|---|---|
| `{ detuneCents: n }` | Detunes every instrument by `n` cents (at most 100) |
| `{ mute: [inst, ...] }` | Mutes the listed instruments |
| `{ only: [inst, ...] }` | Mutes every instrument except the listed ones |
| `{ desaturate: 0–1 }` | Removes colour from the picture |

```ts
onStale('*', { detuneCents: 25, desaturate: 0.5 });
onDown('swpc.wind', { mute: [windVoice] });
```

The status bar and console always show the real state and time. Reactions make the state audible and visible as part of the piece.

## Composing without waiting
Most data changes slowly. Two editor tools play changes on demand.

### Replay
**Replay** (command palette, `Mod-Shift-P` → Replay) plays recorded changes from the last seven days at 1×, 10×, 100× or 1000× speed. A day of CelesTrak updates plays in about 90 seconds at 1000×. The piece cannot tell replayed changes from live ones. The console labels them `REPLAY`.

**Go live** returns to live data.

### Test events
Opening the editor with `?dev=1` in the address shows a panel that sends test events to any group: an object entering, a field changing, a source becoming stale. Test events are marked `SYNTHETIC` in the console and never reach other users.

## Seeing what drives the sound
The **Console** tab in the bottom panel (`Mod-J`) shows each change as one chain, from the source update to the notes, parameter values and drawing it caused. **Sounding voices** lists every note with the object that plays it. **Modulation** lists every modulated parameter with its base value, its current value and its sources.
