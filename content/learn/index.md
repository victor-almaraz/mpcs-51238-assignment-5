---
title: Learn the Piece Script
order: 0
---

# Learn the Piece Script

Sphärenmusik plays music and images from live space data: satellites in orbit, the solar wind, asteroids passing Earth and rocket launches. A **piece** decides how that data sounds and looks. You write a piece as a short TypeScript **script** in the editor.

## How a piece works
1. When the editor opens the piece and each time you save, the script's top-level code runs. It creates instruments and effects, names the data each one follows, and sets up what the screen shows.
2. While the piece plays, every change in the followed data plays notes, moves parameters and redraws the picture.
3. A script can also register **handlers**: functions that run on each change and on timers, remember what happened, and decide what to play next ([Programs](programs)).

The script runs in a sandbox. It reaches sound, pictures and data only through the functions in this guide, and it makes no network calls.

## Pages
| Page | Content |
|---|---|
| [Your first piece](first-piece) | Write and run a piece in five lines |
| [Sky data](sky-data) | The data groups, their fields, and how often they change |
| [Expressions](expressions) | Turning data values into pitches, levels and colours |
| [Sound](sound) | Instruments, sustained voices, triggered notes and following parameters |
| [Programs](programs) | Handlers, timers and state: pieces that remember and decide |
| [Effects and modulation](effects-and-modulation) | Effect chains, LFOs, and data that moves parameters |
| [Visuals](visuals) | The view, layers and audio-reactive images |
| [Live data states](live-data-states) | Stale and down sources, replay and test events |
| [Recipes](recipes) | Complete pieces to copy and change |
| [Reference](reference) | Every function, parameter, group and limit |
| [Troubleshooting](troubleshooting) | Problem codes and silent or empty pieces |

A **Try It** link follows every complete example; it opens the example in the editor as an unsaved copy.
