// One drone. The solar wind opens its filter, minute by minute.
// Guide: /learn/sound, /learn/effects-and-modulation

scale('C', 'minor');

const drone = subtractive({ volume: -6, waveform: 'sawtooth', attack: 2, release: 4, resonance: 6 });
drone.fx(delay({ time: 750, feedback: 0.45, mix: 0.25 }));

sky.group('swpc.wind').voices(drone, { pitch: 36 });

drone.cutoff.follow(sky.swpc('wind.speed').map(300, 800, 200, 3000, 'log'), { smoothMs: 3000 });
drone.cutoff.mod(lfo({ shape: 'sine', rate: 0.05 }), { depth: 0.06 });

view.projection('map');
layer.aurora({ intensity: sky.swpc('kp.kp').map(0, 9, 0.3, 1) }); // visible when quiet, brighter in storms
