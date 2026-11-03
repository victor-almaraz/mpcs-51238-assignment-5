// Each possible near-Earth asteroid rings one bell: first the candidates already listed, one by
// one, then each new candidate as it is observed. Each candidate is a ring around Earth; the
// likelier it is to be a near-Earth object, the closer its ring.
// Guide: /learn/programs, /learn/visuals

scale('E', 'phrygian');

const bell = fm({ volume: -6, ratio: 3.5, index: 6, indexDecay: 2 });
bell.fx(delay({ time: 700, feedback: 0.4, mix: 0.3 }));

const TONES = [72, 74, 76, 77, 79, 81, 83, 84, 86, 88]; // E phrygian, C5 to E6
const waiting: SkyRecord<'jpl.scout'>[] = [];          // candidates still to ring

on('jpl.scout', 'enter', (o, e) => {
  if (waiting.length >= 64) return;
  if (e.initial) waiting.push(o); // listed before Run: in turn
  else waiting.unshift(o);        // just observed: next
});

every(1500, () => {
  const o = waiting.shift();
  if (!o) return;
  // Likelier near-Earth objects ring louder.
  bell.play(choose(TONES), { velocity: Math.round(40 + 0.7 * (o.neoScore ?? 0)), durationMs: 250 });
});

view.projection('orbital');
layer.rings(sky.group('jpl.scout'), {
  radius:  field('neoScore').map(0, 100, 340, 240).add(rand(-12, 12)),
  color:   '#90cdf4',
  opacity: 0.5,
});
