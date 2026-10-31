---
title: Learn the Piece Script
order: 0
---

# Learn the Piece Script

Sphärenmusik plays music and images from live space data: satellites in orbit, the solar wind, asteroids passing Earth and rocket launches. A **piece** decides how that data sounds and looks. You write a piece as a short TypeScript **script** in the editor.

## How a piece works
1. The script runs once when you press Run or save. It describes instruments, effects, the data each one follows, and what the screen shows.
2. Sphärenmusik turns that description into a running piece.
3. While the piece runs, every change in the followed data plays notes, moves parameters and redraws the picture. The script itself does not run again until the next save.

Because the script only describes the piece, it contains no loops over time, no timers and no network calls. It names data, chooses instruments and maps one onto the other.

## Pages
| Page | Content |
|---|---|
| [Your first piece](first-piece) | Write and run a piece in five lines |
| [Sky data](sky-data) | The data groups, their fields, and how often they change |
| [Expressions](expressions) | Turning data values into pitches, levels and colours |
| [Sound](sound) | Instruments, sustained voices, triggered notes and following parameters |
| [Effects and modulation](effects-and-modulation) | Effect chains, LFOs, and data that moves parameters |
| [Visuals](visuals) | The view, layers and audio-reactive images |
| [Live data states](live-data-states) | Stale and down sources, replay and test events |
| [Recipes](recipes) | Complete pieces to copy and change |
| [Reference](reference) | Every function, parameter, group and limit |
| [Troubleshooting](troubleshooting) | Problem codes and silent or empty pieces |

Every code block marked **Try It** opens in the editor as an unsaved copy.
