---
title: Sphärenmusik
description: Music and images from live space data.
---

# Sphärenmusik

*Sphärenmusik* is German for "music of the spheres", the old idea that the motions of the heavens and the intervals of music follow the same numbers. The piece is inspired by that idea and by the place music and astronomy shared in the medieval quadrivium. It makes music and images from live space data: satellite orbits, the solar wind, asteroids passing Earth and rocket launches.

## The music of the spheres
Greek tradition credits Pythagoras with a discovery about strings. Two strings whose lengths stand in the ratio 2:1 sound an octave; 3:2 sounds a fifth; 4:3 a fourth. The Pythagoreans applied the same thinking to the sky: planets moving at speeds in fixed proportions would form a harmony.

The idea recurs from antiquity to the seventeenth century:

- **Plato, *Republic*, Book X** In the Myth of Er, a siren stands on each heavenly sphere and sings one note; together the notes make a single harmony.
- **Plato, *Timaeus*** The soul of the world is built from the ratios of the musical scale.
- **Boethius, *De institutione musica*, about 510 CE** Music has three kinds: *musica mundana*, the harmony of the cosmos; *musica humana*, the harmony of body and soul; *musica instrumentalis*, the music people play and hear.
- **Johannes Kepler, *Harmonices Mundi*, 1619** Each planet sings a melody. The ratio of its fastest to its slowest motion, seen from the Sun, sets the melody's range; Earth's spans a semitone, mi to fa. The same book states Kepler's third law of planetary motion.

As physics the theory was wrong: the planets make no sound, and space does not carry it.

## Four sister sciences: the quadrivium
> “As the eyes are framed for astronomy so the ears are framed for the movements of harmony, and these are in some sort kindred sciences.”
>
> Plato, *Republic*, Book VII

Plato gives the words to Socrates, who credits the idea to the Pythagoreans. Nicomachus of Gerasa (2nd century CE) divided the four mathematical arts of antiquity as follows:

| | In itself or at rest | In relation or in motion |
|---|---|---|
| **Number** (discrete quantity) | Arithmetic: number in itself | Music: number in relation, as ratio and interval |
| **Magnitude** (continuous quantity) | Geometry: magnitude at rest | Astronomy: magnitude in motion |

Boethius named these four arts the *quadrivium*, "the four ways". With the *trivium* of grammar, logic and rhetoric, they formed the seven liberal arts taught in medieval schools and universities.

## What Sphärenmusik does
Sphärenmusik collects four kinds of live data. A short script decides how each one sounds and looks.

- **Satellites and space stations** Orbital elements from CelesTrak, updated every few hours. The page computes each object's position from them.
- **Solar wind and geomagnetic activity** Measurements from NOAA's Space Weather Prediction Center, updated every minute.
- **Asteroids passing Earth** Close approaches and newly observed candidates from NASA's Jet Propulsion Laboratory.
- **Rocket launches** Upcoming launches and their scheduled times from Launch Library 2.

An orbit can be heard as a very slow oscillation. The International Space Station circles Earth once every 93 minutes, a frequency of about 0.00018 Hz. Raised twenty octaves, that frequency is about 188 Hz, a little above the F sharp below middle C. Raising every orbit by the same number of octaves keeps the ratios between them, so two orbits in the ratio 2:1 sound an octave apart.

## How it works
1. A worker collects orbital elements, space weather, close approaches and launch schedules from public sources, and saves only what changed.
2. The page receives each change as it is saved.
3. Your script, a few lines of TypeScript, decides which data each instrument and image follows.
4. Sphärenmusik plays and draws the result. The console shows the raw changes behind it.

```ts
const pad = additive({ volume: -6, attack: 1.5, release: 4 });

sky.group('celestrak.stations').voices(pad, {
  pitch: field('meanMotion').octaveInto(110, 440),
});
```
These five lines give every object in CelesTrak's space-stations group one sustained note, tuned by how fast it orbits.

## What is real
The data is live. The music and images are composed: each mapping from data to sound or image is written in a script that anyone can read and change. Sphärenmusik does not claim that the sky makes sound.

## Further reading
- Plato, *Republic* 530d and 616b–617d, translated by Paul Shorey; *Timaeus* 35b–36b.
- Boethius, *De institutione musica*, Book I, chapter 2.
- Nicomachus of Gerasa, *Introduction to Arithmetic*, Book I, chapter 3.
- Johannes Kepler, *Harmonices Mundi*, Book V.
- Joscelyn Godwin, *Harmony of the Spheres: A Sourcebook of the Pythagorean Tradition in Music* (1993).
