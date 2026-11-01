---
title: Live data states
order: 8
---

# Live data states

Each data source is in one of four states. The status bar shows each followed source by its id, for example `swpc.wind`, with an icon and, except when fresh, a word:

| State | Status bar | Meaning |
|---|---|---|
| Loading | Spinner, `connecting` | No status received yet |
| Fresh | Circle with a check mark | The source has a successful update within the last three update intervals |
| Stale | Clock, `stale` | No successful update for three update intervals |
| Down | Circle with a cross, `down` | The last attempt to read the source failed, the source is halted, or the live connection is lost |

Pointing at a stale or down source shows the time of its last successful update.

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
**Replay** (command palette, `Mod-Shift-P` → Replay, or the replay controls in the **Console** tab) plays recorded changes from the last hour, 6 hours, 24 hours or 7 days at 1×, 10×, 100× or 1000× speed. A day of CelesTrak updates plays in about 90 seconds at 1000×. The piece cannot tell replayed changes from live ones. The console and the status bar label them `Replay ×<speed>`.

**Go Live** returns to live data.

### Test events
Opening the editor with `?dev=1` in the address adds a **Synthetic** panel to the **Console** tab. It sends test events to any group (an object entering, updating or exiting, with the fields you type as JSON) and sets any source's state, for example stale or down. Test events are marked `Synthetic` in the console and the status bar. They change only the open tab and never reach the database or other users.

## Seeing what drives the sound
The **Console** tab in the bottom panel (`Mod-J`) holds five panels. **Events** lists each change; selecting one opens the **Trace** tab, which shows the chain from the source update to the notes, parameter values and drawing it caused. **Sources** shows each source's state, last run, rows changed and last error. **Voices** lists every sounding note with the object that plays it. **Modulation** lists every modulated parameter with its base value, its current value and its sources. **Effects** shows each effect chain.
