---
title: Recipes
order: 8
---

# Recipes

Complete pieces to open, play and change. Each one uses groups that change at different speeds, so it sounds different from one hour to the next.

## Orbital chorus
Stations hold a chord; GPS satellites add a slow, even layer underneath; geomagnetic activity widens the vibrato.

```ts piece
scale('D', 'lydian');

const stations = additive({ volume: -6, attack: 1.5, release: 4, vibratoDepth: 6 });
const gps      = fm({ volume: -14, ratio: 2, index: 1.5, attack: 1, release: 3 });

stations.fx(reverb({ size: 0.9, decay: 8, mix: 0.35 }));

sky.group('celestrak.stations').voices(stations, {
  pitch: field('meanMotion').octaveInto(220, 880).quantize(),
  pan:   orbit('phaseCos'),
});

sky.group('celestrak.gps-ops').top(8, 'raan').voices(gps, {
  pitch:    field('raan').map(0, 360, 38, 50).quantize(),
  velocity: 40,
});

stations.vibratoDepth.follow(sky.swpc('kp.kp').map(0, 9, 4, 60), { smoothMs: 4000 });

view.projection('orbital');
layer.points(sky.group('celestrak.gps-ops'), { size: 2, color: '#63b3ed' });
layer.points(sky.group('celestrak.stations'), {
  size: audio.voice(stations).env().map(0, 1, 3, 9), color: '#f6e05e', trail: 600,
});
```

## Solar wind
One drone whose filter and echo follow the solar wind, minute by minute. This piece changes audibly while you listen.

```ts piece
scale('C', 'minor');
tempo(60);

const drone = subtractive({ volume: -6, waveform: 'sawtooth', attack: 2, release: 4, resonance: 6 });
const echo  = delay({ sync: '1/2d', feedback: 0.5, mix: 0.3 });
drone.fx(echo, reverb({ size: 0.7, decay: 5, mix: 0.25 }));

sky.group('swpc.wind').voices(drone, { pitch: 36 });

drone.cutoff.follow(sky.swpc('wind.speed').map(300, 800, 200, 3000, 'log'), { smoothMs: 3000 });
echo.feedback.mod(sky.swpc('mag.bz').map(-20, 20, 1, -1), { depth: 0.4 });

const breathe = lfo({ shape: 'sine', rate: 0.05 });
drone.cutoff.mod(breathe, { depth: 0.06 });

view.projection('map');
layer.aurora({
  intensity: sky.swpc('kp.kp').map(2, 9, 0.1, 1),
  drift:     sky.swpc('wind.speed').map(300, 800, 0.1, 1),
});
```

## Near misses
The closest asteroid approaches of the next 60 days swell in and out; each Scout candidate rings once when it appears.

```ts piece
scale('E', 'phrygian');

const swell = subtractive({ volume: -6, waveform: 'triangle', attack: 2, release: 4, cutoff: 1200 });
const glass = fm({ volume: -8, ratio: 3.5, index: 6, indexDecay: 2 });
glass.fx(delay({ time: 700, feedback: 0.45, mix: 0.35 }));

sky.group('jpl.cad').top(6, 'distLD', 'asc').voices(swell, {
  pitch:    field('vRel').map(5, 30, 40, 64).quantize(),
  velocity: field('distLD').map(0.5, 10, 100, 20),
});

sky.group('jpl.scout').on('enter').trigger(glass, {
  pitch: rand(72, 88).quantize(), maxPerSecond: 1,
});

view.projection('orbital');
layer.rings(sky.group('jpl.cad').top(6, 'distLD', 'asc'), {
  radius: field('distLD').map(0.5, 10, 40, 400),
  color:  '#f56565',
  opacity: audio.level(swell).map(0, 0.3, 0.2, 1),
});
```

## Launch day
Each launch in the next ten sits as a quiet tone; a launch that lifts off plays a long low string.

```ts piece
scale('G', 'mixolydian');

const tones  = additive({ volume: -16, attack: 1, release: 3 });
const string = pluck({ volume: -6, decay: 8, damping: 0.25 });
string.fx(reverb({ size: 0.95, decay: 9, mix: 0.4 }));

sky.group('ll2.upcoming').voices(tones, {
  pitch:    field('padLon').map(-180, 180, 55, 79).quantize(),
  velocity: 30,
});

sky.group('ll2.upcoming').on('update')
  .when(field('status').eq('In Flight'))
  .trigger(string, { pitch: 31, durationMs: 6000 });

onStale('ll2.upcoming', { detuneCents: 30 });

view.projection('map');
layer.glyph(sky.group('ll2.upcoming'), { char: '^', size: 18, color: '#fbd38d' });
```
