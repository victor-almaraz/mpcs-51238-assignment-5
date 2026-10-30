// Each newly observed possible near-Earth asteroid rings one bell.
// Use Replay (command palette) to hear a day of candidates in under two minutes.
// Guide: /learn/sound, /learn/live-data-states

scale('E', 'phrygian');

const bell = fm({ volume: -16, ratio: 3.5, index: 6, indexDecay: 2 });
bell.fx(delay({ time: 700, feedback: 0.4, mix: 0.3 }));

sky.group('jpl.scout').on('enter').trigger(bell, (o) => ({
  pitch:    rand(72, 88).quantize(),
  velocity: o.neoScore.map(0, 100, 40, 110),   // likelier near-Earth objects ring louder
  maxPerSecond: 1,
}));

view.projection('orbital');
layer.glyph(sky.group('jpl.scout'), { char: '+', size: 16, color: '#90cdf4', fade: 20 });
