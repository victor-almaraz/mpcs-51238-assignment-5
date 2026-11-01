---
title: Your first piece
order: 1
---

# Your first piece

This page builds a piece in which every object in the space-stations group (the ISS, its modules and other stations) holds one note, with its pitch set by how fast it orbits.

## Create a project
1. Open **Projects** and select **New Project** → **Blank**.
2. The editor opens `piece.ts` with a blank script: two comment lines and no code.

## Write the script
Type the following script:

```ts piece
const pad = additive({ volume: -6, attack: 1.5, release: 4 });

sky.group('celestrak.stations').voices(pad, {
  pitch: field('meanMotion').octaveInto(110, 440),
});
```

| Line | Meaning |
|---|---|
| `additive({...})` | Creates an additive synthesizer, a soft pad made of eight sine harmonics. `volume` is in dB; `attack` and `release` are fade times in seconds. |
| `sky.group('celestrak.stations')` | Selects the group of space stations from CelesTrak's orbital data. |
| `.voices(pad, {...})` | Gives every station in the group one sustained note on `pad`. |
| `field('meanMotion')` | Reads each station's orbits per day (about 15.5 for the ISS). |
| `.octaveInto(110, 440)` | Doubles or halves that number until it lies between 110 and 440, and uses the result as a frequency in Hz. |

## Types while you type
Scripts are TypeScript. You do not need to write any type annotations: the editor knows the type of every function, option, group and field, and uses that knowledge in three ways.

- **Completion.** Typing `additive({ ` lists the additive synthesizer's parameters. Typing `sky.group('` lists the groups.
- **Hover.** Pointing at a name shows its type and, for parameters, its range.
- **Problems.** A misspelled option, an unknown group or a field that the group does not have is underlined in yellow as you type, and listed in the **Problems** tab.

Type problems (yellow) do not stop a piece from running, so you can try an idea before it is finished. Each build checks the script again: red problems, such as a syntax error, an unknown option or group, or a limit exceeded, stop the piece until you fix them. A field that no object in the group has stays a yellow warning.

## Run it
1. Press **Run** (`Mod-Enter`; `Mod` is `Cmd` on macOS, `Ctrl` elsewhere). The first time, a notice shows the volume and photosensitivity warnings; select **Start Sound**. The browser allows sound only after a click.
2. A chord sounds: one note per station.
3. The status bar shows `celestrak.stations` with a check-mark icon when the orbital data is fresh.

The chord changes each time CelesTrak publishes orbital elements, about every two hours. The [Live data states](live-data-states) page shows how to hear changes faster while composing.

## Put the notes in a scale
Add `scale()` at the top and `.quantize()` after `octaveInto`:

```ts piece
scale('D', 'lydian');

const pad = additive({ volume: -6, attack: 1.5, release: 4 });

sky.group('celestrak.stations').voices(pad, {
  pitch: field('meanMotion').octaveInto(110, 440).quantize(),
});
```

`quantize()` moves each pitch to the nearest note of D Lydian. Save (`Mod-S`) while the piece runs: the change applies without stopping the sound.

## Add a picture
```ts piece
scale('D', 'lydian');

const pad = additive({ volume: -6, attack: 1.5, release: 4 });

sky.group('celestrak.stations').voices(pad, {
  pitch: field('meanMotion').octaveInto(110, 440).quantize(),
});

view.projection('orbital');
layer.points(sky.group('celestrak.stations'), {
  size: audio.voice(pad).env().map(0, 1, 3, 9),
  color: '#f6e05e',
});
```

Each station appears as a dot around Earth. Its size follows the loudness of its own note.

## Next
- [Sky data](sky-data) lists the other groups and fields.
- [Expressions](expressions) explains `map`, `octaveInto` and `quantize` in full.
