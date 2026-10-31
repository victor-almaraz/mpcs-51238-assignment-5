---
title: Sphärenmusik
description: Music and images played by live space data.
---

# Sphärenmusik

*Sphärenmusik* is German for "music of the spheres". From antiquity to the seventeenth century, astronomers and musicians held that the motions of the heavens and the intervals of music obey the same numbers. Sphärenmusik takes that idea literally: it plays the sky as it is right now, from satellites in orbit, the solar wind, asteroids passing Earth and rocket launches.

## The music of the spheres
Greek tradition credits Pythagoras with a discovery about strings. Two strings whose lengths stand in the ratio 2:1 sound an octave; 3:2 sounds a fifth; 4:3 a fourth. Consonance turned out to be a matter of small whole numbers. The Pythagoreans extended the thought to the sky: if the planets move at speeds in fixed proportions, their motions form a harmony too.

The idea passed through the whole of ancient and medieval thought:

- **Plato, *Republic*, Book X** In the Myth of Er, a siren stands on each heavenly sphere and sings one note; together the notes make a single harmony.
- **Plato, *Timaeus*** The soul of the world is built from the ratios of the musical scale.
- **Boethius, *De institutione musica*, about 510 CE** Music has three kinds: *musica mundana*, the harmony of the cosmos; *musica humana*, the harmony of body and soul; *musica instrumentalis*, the music people play and hear.
- **Johannes Kepler, *Harmonices Mundi*, 1619** Each planet sings a melody. The ratio of its fastest to its slowest motion, seen from the Sun, sets the melody's range; Earth's spans a semitone, mi to fa. The same book states Kepler's third law of planetary motion.

The planets make no sound: space carries none. The old theory was wrong as physics. It was right about something else: the sky is full of periodic motion, and periodic motion is what music is made of.

## Four sister sciences: the quadrivium
> “As the eyes are framed for astronomy so the ears are framed for the movements of harmony, and these are in some sort kindred sciences.”
>
> Plato, *Republic*, Book VII

Plato gives the words to Socrates, who credits the idea to the Pythagoreans. The four mathematical arts of antiquity were studied together because each is number seen from a different side. Nicomachus of Gerasa (2nd century CE) arranged them as follows:

| | At rest | In motion |
|---|---|---|
| **Number** (discrete quantity) | Arithmetic: number in itself | Music: number in relation, as ratio and interval |
| **Magnitude** (continuous quantity) | Geometry: magnitude at rest | Astronomy: magnitude in motion |

Boethius named these four arts the *quadrivium*, "the four ways". Joined to the *trivium* of grammar, logic and rhetoric, they formed the seven liberal arts taught in medieval schools and universities. Music sat next to astronomy in the curriculum: both study proportion in motion.

## What Sphärenmusik does
Sphärenmusik is a working quadrivium. Live measurements arrive as numbers (arithmetic). Orbits are propagated and drawn as positions on a map or on the sky (geometry). Their motions are read as rhythms and cycles (astronomy). A short script turns those numbers into pitches, intervals and timbres (music).

The sky offers four kinds of motion, and each becomes a different musical gesture:

- **Satellites and space stations** Periodic orbits, the modern spheres, become slow cycles that sweep pitch, timbre and space.
- **Solar wind and geomagnetic activity** Continuous, unpredictable weather becomes gradual shifts of colour and tension.
- **Asteroids passing Earth** Discrete events become struck notes and bells.
- **Rocket launches** Human events with a countdown become phrases that arrive on schedule.

An orbit is a very slow oscillation. The International Space Station circles Earth once every 93 minutes, a frequency of about 0.00018 Hz. Raised twenty octaves, the same rhythm sounds at about 188 Hz, a little above the F sharp below middle C. Raising by octaves keeps every ratio intact, so two orbits in the ratio 2:1 still sound an octave apart. This is the Pythagorean idea, applied to the sky that exists today.

## How it works
1. A worker collects orbital elements, space weather, close approaches and launch schedules from public sources, and saves only what changed.
2. The page receives each change as it happens.
3. Your script, a few lines of TypeScript, decides which data each instrument and image follows.
4. Sphärenmusik plays and draws the result. The console shows every raw change behind every note.

```ts
const pad = additive({ volume: -12, attack: 1.5, release: 4 });

sky.group('celestrak.stations').voices(pad, {
  pitch: field('meanMotion').octaveInto(110, 440),
});
```
These five lines give every object in CelesTrak's space-stations group one sustained note, tuned by how fast it orbits.

## What is real
The data is real and live: when the solar wind speeds up, the piece changes within minutes. The sound is a composition: every mapping from data to music is a choice made in a script, and anyone can read, change or write it. Sphärenmusik claims no hidden sound in the sky. Like Kepler's planetary melodies, it is a way of listening to the numbers.

## Further reading
- Plato, *Republic* 530d and 616b–617d, translated by Paul Shorey; *Timaeus* 35b–36b.
- Boethius, *De institutione musica*, Book I, chapter 2.
- Nicomachus of Gerasa, *Introduction to Arithmetic*, Book I, chapter 3.
- Johannes Kepler, *Harmonices Mundi*, Book V.
- Joscelyn Godwin, *Harmony of the Spheres: A Sourcebook of the Pythagorean Tradition in Music* (1993).
