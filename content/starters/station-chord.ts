// Every space station holds one note. Its pitch comes from how many times a day it orbits.
// Guide: /learn/first-piece

scale('D', 'lydian');

const pad = additive({ volume: -6, attack: 1.5, release: 4 });
pad.fx(reverb({ size: 0.85, decay: 6, mix: 0.3 }));

sky.group('celestrak.stations').voices(pad, {
  pitch: field('meanMotion').octaveInto(110, 440).quantize(),
  pan:   orbit('phaseCos'),   // each station circles the stereo field once per orbit
});

view.projection('orbital');
layer.points(sky.group('celestrak.stations'), {
  size:  audio.voice(pad).env().map(0, 1, 3, 9),
  color: '#f6e05e',
  trail: 600,
});
