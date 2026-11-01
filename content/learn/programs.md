---
title: Programs
order: 5
---

# Programs

A script is a program. Its top-level code, the **setup**, runs when you press Run or save: it creates instruments, effects and layers. **Handlers** keep running while the piece plays. They are functions that Sphärenmusik calls when sky data changes or a timer fires. Variables that the setup declares keep their values between calls, so a piece can remember what happened and decide what comes next.

Use bindings ([Sound](sound)) when each object maps straight onto a note or a parameter. Use handlers when the music has a state of its own: a chord progression, a counter, a melody that walks.

## A first handler
```ts piece
const bell = fm({ volume: -9, ratio: 3.5, index: 5, indexDecay: 1.5 });
let count = 0;

on('jpl.scout', 'enter', (o) => {
  count += 1;
  bell.play(60 + (count % 12), { velocity: 80, durationMs: 1500 });
});
```

`on(group, kind, fn)` calls `fn` for each `enter`, `update` or `exit` in the group, or for all three with `'*'`. `o` holds the object's current values: `o.neoScore` is a number here, not an expression. A value that the source does not report is `null`.

When the piece starts, every object already in the group arrives once as an `enter`, with `e.initial` set to `true`:

```ts piece
const pad = additive({ volume: -12, attack: 2, release: 4 });

on('celestrak.stations', 'enter', (o, e) => {
  pad.hold(o.id, 48 + (Number(o.meanMotion) % 24), { velocity: e.initial ? 50 : 80 });
});
on('celestrak.stations', 'exit', (o) => pad.stop(o.id));
```

## Timers
`every(interval, fn)` calls `fn` at a steady rate: an interval in milliseconds, or a note value such as `'1/8'` at the piece's `tempo()`. `after(ms, fn)` calls `fn` once.

```ts piece
tempo(96);
scale('D', 'dorian');
const pluckey = pluck({ volume: -9, decay: 3 });
const chord = [0, 3, 7, 10];
let root = 50;
let step = 0;

on('jpl.scout', 'enter', () => {
  root = 50 + choose([0, 2, 5, 7]);
});

every('1/8', () => {
  pluckey.play(root + chord[step % chord.length], { velocity: step % 4 === 0 ? 100 : 60 });
  step += 1;
});
```

Timers follow the audio clock, so they keep time even while replay speeds up the sky.

## Sending sound and light
Inside a handler, instruments, parameters and layers take commands:

| Call | Effect |
|---|---|
| `inst.play(pitch, { velocity, pan, durationMs })` | One note |
| `inst.hold(key, pitch, { velocity, pan })` | A note that sounds until `inst.stop(key)` |
| `inst.glide(key, pitch, ms)` | Slides a held note to a new pitch |
| `inst.stop(key)`, `inst.stopAll()` | Releases held notes |
| `inst.cutoff.set(value, { smoothMs })` | Sets a parameter |
| `delayFx.bypass.set(true)` | Bypasses an effect |
| `glyphs.set({ color: '#ff8800' })` | Sets a layer's properties; `layer.*(...)` returns the layer |

Commands work only inside handlers. In the setup they stop the build with `io_outside_handler`.

## Reading live values
`read.swpc(path)`, `read.group(key)`, `read.object(id)` and `read.freshness(source)` return the current sky inside a handler. A piece reads only groups it follows: groups named in `on`, bindings, layers and `sky.swpc`, plus any listed with `follow(...)`:

```ts piece
const drone = subtractive({ volume: -12, attack: 2, release: 3, cutoff: 800 });
follow('swpc.wind', 'swpc.kp');

on('swpc.wind', 'update', () => {
  const speed = Number(read.swpc('wind.speed') ?? 400);
  const kp = Number(read.swpc('kp.kp') ?? 0);
  drone.hold('drone', kp >= 5 ? 31 : 36);
  drone.cutoff.set(200 + speed * 4, { smoothMs: 4000 });
});
```

## Chance that repeats
`random()`, `randInt(n)` and `choose(list)` make choices seeded by `seed(n)`. The same seed and the same sky make the same choices, so a piece can be replayed exactly.

## When a handler fails
- A handler that throws stops; the rest of the piece keeps playing. **Problems** shows `handler_error` with the line.
- A handler that runs too long (250 ms for one round of calls) stops the whole program and releases its notes. **Problems** shows `handler_timeout`.
- Every save restarts the program from the setup, so variables start over.

A piece plays at most 200 new notes a second from its handlers; more are dropped. See the [Reference](reference) for every limit.
