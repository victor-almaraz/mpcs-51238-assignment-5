---
title: Programs
order: 5
---

# Programs

A script is a program. Its top-level code, the **setup**, runs when the piece is built (when the editor opens it and each time you save): it creates instruments, effects and layers. **Handlers** keep running while the piece plays. They are functions that Sphärenmusik calls when sky data changes or a timer fires. Variables that the setup declares keep their values between calls, so a piece can remember what happened and decide what comes next.

Use bindings ([Sound](sound)) when each object maps straight onto a note or a parameter. Use handlers when the music has a state of its own: a chord progression, a counter, a melody that walks.

## A first handler
```ts piece
const bell = fm({ volume: -6, ratio: 3.5, index: 5, indexDecay: 1.5 });
let count = 0;

on('jpl.scout', 'enter', (o, e) => {
  count += 1;
  const pitch = 60 + (count % 12);
  // Candidates listed before Run ring one after another; a new one rings at once.
  after(e.initial ? count * 400 : 0, () => bell.play(pitch, { velocity: 80, durationMs: 1500 }));
});
```

`on(group, kind, fn)` calls `fn` for each `enter`, `update` or `exit` in the group, or for all three with `'*'`. `o` holds the object's current values: `o.neoScore` is a number here, not an expression. A value that the source does not report is `null`.

When the piece starts, every object already in the group arrives once as an `enter`, with `e.initial` set to `true`:

```ts piece
const pad = additive({ volume: -6, attack: 2, release: 4 });

on('celestrak.stations', 'enter', (o, e) => {
  pad.hold(o.id, 48 + (Number(o.meanMotion) % 24), { velocity: e.initial ? 70 : 100 });
});
on('celestrak.stations', 'exit', (o) => pad.stop(o.id));
```

## Timers
`every(interval, fn)` calls `fn` at a steady rate: an interval in milliseconds, or a note value such as `'1/8'` at the piece's `tempo()`. `after(ms, fn)` calls `fn` once.

```ts piece
tempo(96);
scale('D', 'dorian');
const pluckey = pluck({ volume: -6, decay: 3 });
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
| `inst.pan(key, pan)` | Moves a held note left (−1) or right (1), for example following live data |
| `inst.stop(key)`, `inst.stopAll()` | Releases held notes |
| `inst.cutoff.set(value, { smoothMs })` | Sets a parameter |
| `delayFx.bypass.set(true)` | Bypasses an effect |
| `glyphs.set({ color: '#ff8800' })` | Sets a layer's properties; `layer.*(...)` returns the layer |
| `pad.harmonics.set([1, 0.5, 0, 0.25])` | Sets an additive instrument's harmonics |

Commands work only inside handlers. In the setup they stop the build with `io_outside_handler`.

## Reading live values
`read.swpc(path)`, `read.group(key)`, `read.object(id)` and `read.freshness(source)` return the current sky inside a handler. A piece reads only groups it follows: groups named in `on`, bindings, layers and expressions such as `sky.swpc`, plus any listed with `follow(...)`. `read.swpc` or `read.group` on any other group throws an error that names the missing `follow`:

```ts piece
const drone = subtractive({ volume: -6, attack: 2, release: 3, cutoff: 800 });
follow('swpc.wind', 'swpc.kp');

on('swpc.wind', '*', () => {
  const speed = Number(read.swpc('wind.speed') ?? 400);
  const kp = Number(read.swpc('kp.kp') ?? 0);
  drone.hold('drone', kp >= 5 ? 31 : 36);
  drone.cutoff.set(200 + speed * 4, { smoothMs: 4000 });
});
```

## Reading an orbit
`read.orbit(id, quantity)` reads a satellite's orbit as a value from −1 to 1, like `sky.orbit` ([Effects and modulation](effects-and-modulation#orbits-as-very-slow-lfos)), but as a number your code can work with. Declare each orbit in the setup with `follow(sky.orbit(...))`; the value changes every 500 ms and is `null` until the first one arrives.

## Changing harmonics
`harmonics` cannot follow an expression, because it is a list. A handler can compute the list instead. Here the ISS's latitude moves a peak up and down the eight harmonics, like a slow vowel:

```ts piece
const iss = 'celestrak.stations:25544';
const fast = { timeScale: 60 };          // one orbit in about 90 seconds
follow(sky.orbit(iss, 'latitude', fast));

const pad = additive({ volume: -6, attack: 2, release: 4 });
let x = 0;

after(0, () => pad.hold('drone', 45));
every(50, () => {
  x += ((read.orbit(iss, 'latitude', fast) ?? 0) - x) * 0.1;   // smooth the 500 ms steps
  const peak = 1 + (x + 1) * 3.5;                                // harmonic 1 to 8
  pad.harmonics.set([1, 2, 3, 4, 5, 6, 7, 8].map((k) => Math.exp(-((k - peak) ** 2) / 2)));
});
```

Each `set` replaces the wave of the sounding notes at once. Small steps, as here, sound smooth; a piece sends at most 30 a second to each instrument.

## Panning held notes
`inst.pan(key, pan)` moves a note that is already sounding, from −1 (left) to 1 (right). Call it from a timer to make the stereo position follow live data; here a drone sweeps from side to side as the ISS goes around its orbit:

```ts piece
const iss = 'celestrak.stations:25544';
const fast = { timeScale: 60 };          // one orbit in about 90 seconds
follow(sky.orbit(iss, 'phaseCos', fast));

const pad = additive({ volume: -6, attack: 2, release: 4 });
after(0, () => pad.hold('drone', 50));
every(250, () => pad.pan('drone', 0.8 * (read.orbit(iss, 'phaseCos', fast) ?? 0)));
```

A note played with `play` takes its pan when it starts: pass `{ pan }` there instead.

## Painting a grid
`layer.grid(props)` draws a grid of squares or circles. A handler sets every cell at once: `cells` is a list of colours and `sizes` a list of sizes from 0 to 1, row by row from the top left. Here each bell note moves one random circle to its next colour and makes it larger:

```ts piece
const bell = fm({ volume: -6, ratio: 3.5, index: 4, indexDecay: 1 });
const grid = layer.grid({ cols: 8, rows: 8, gap: 4, shape: 'circle' });
const colors: Hex[] = ['#f6e05e', '#63b3ed', '#f56565'];
const place = Array(64).fill(0);         // each circle's colour, 0 to 2

every(500, () => {
  const i = randInt(64);
  place[i] = (place[i] + 1) % colors.length;
  bell.play(60 + place[i] * 4, { durationMs: 300 });
  grid.set({ cells: place.map((c) => colors[c]), sizes: place.map((c) => 0.4 + c * 0.25) });
});
```

Each `set` sends the whole grid, so send it when something changed, a few times a second at most.

## Chance that repeats
`random()`, `randInt(n)` and `choose(list)` make choices seeded by `seed(n)`. The same seed and the same sky make the same choices, so a piece can be replayed exactly.

## When a handler fails
- A handler that throws stops; the rest of the piece keeps playing. **Problems** shows `handler_error` with the line.
- A handler that runs too long (250 ms for one round of calls) stops the whole program and releases its notes. The program starts again from the setup a second later, so the piece keeps playing; after three such stops within a minute it stays stopped and **Problems** shows `handler_timeout`.
- Every save restarts the program from the setup, so variables start over.

A piece plays at most 200 new notes a second from its handlers; more are dropped. See the [Reference](reference) for every limit.
