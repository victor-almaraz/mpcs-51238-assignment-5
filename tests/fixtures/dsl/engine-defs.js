// Fixture of the user's engine definition tables, built from the parameter tables in
// content/learn/reference.md, doc/audio/synthesis-*.md and doc/audio/effects.md.
// Stands in for src/audio/param-defs.js and src/audio/fx/effects/registry.js in tests and in
// `--defs` builds until the engine is in the repository.

const ctl = { rate: 'control' };
/** @param {string} target */
const aud = (target) => ({ rate: 'audio', target });

const adsr = (a, d, s, r) => [
  { name: 'attack', label: 'Attack', unit: 's', min: 0.002, max: 2, default: a, scale: 'pow3', mod: ctl },
  { name: 'decay', label: 'Decay', unit: 's', min: 0.01, max: 4, default: d, scale: 'pow3', mod: ctl },
  { name: 'sustain', label: 'Sustain', unit: '', min: 0, max: 1, default: s, scale: 'lin', step: 0.01, mod: ctl },
  { name: 'release', label: 'Release', unit: 's', min: 0.01, max: 4, default: r, scale: 'pow3', mod: ctl },
];

export const PARAM_DEFS = {
  subtractive: [
    { name: 'waveform', label: 'Waveform', unit: '', min: 0, max: 3, default: 'sawtooth', scale: 'lin', options: ['sine', 'sawtooth', 'square', 'triangle'], mod: null },
    { name: 'cutoff', label: 'Cutoff', unit: 'Hz', min: 40, max: 16000, default: 2000, scale: 'log', mod: aud('filter.detune') },
    { name: 'resonance', label: 'Resonance', unit: 'dB', min: 0, max: 20, default: 1, scale: 'lin', mod: aud('filter.Q') },
    { name: 'envAmount', label: 'Filter env', unit: 'oct', min: 0, max: 6, default: 0, scale: 'lin', step: 0.1, mod: ctl },
    ...adsr(0.01, 0.3, 1, 0.3),
  ],
  fm: [
    { name: 'ratio', label: 'Ratio', unit: '', min: 0.5, max: 12, default: 2, scale: 'lin', step: 0.5, mod: ctl },
    { name: 'fine', label: 'Fine', unit: '', min: -0.5, max: 0.5, default: 0, scale: 'lin', step: 0.01, mod: ctl },
    { name: 'index', label: 'Index', unit: '', min: 0, max: 20, default: 3, scale: 'lin', mod: ctl },
    { name: 'indexDecay', label: 'Index decay', unit: 's', min: 0.01, max: 4, default: 0.5, scale: 'pow3', mod: ctl },
    ...adsr(0.005, 0.5, 1, 0.4),
  ],
  additive: [
    { name: 'harmonics', label: 'Harmonics', unit: '', min: 0, max: 1, default: [1, 0.5, 0.33, 0.25, 0.2, 0.17, 0.14, 0.12], scale: 'lin', step: 0.01, mod: null },
    { name: 'attack', label: 'Attack', unit: 's', min: 0.002, max: 2, default: 0.02, scale: 'pow3', mod: ctl },
    { name: 'decay', label: 'Decay', unit: 's', min: 0.01, max: 4, default: 0.5, scale: 'pow3', mod: ctl },
    { name: 'sustain', label: 'Sustain', unit: '', min: 0, max: 1, default: 1, scale: 'lin', step: 0.01, mod: ctl },
    { name: 'release', label: 'Release', unit: 's', min: 0.01, max: 4, default: 0.5, scale: 'pow3', mod: ctl },
    { name: 'vibratoRate', label: 'Vibrato rate', unit: 'Hz', min: 0.5, max: 12, default: 5, scale: 'log', mod: aud('vibrato.frequency') },
    { name: 'vibratoDepth', label: 'Vibrato', unit: 'cents', min: 0, max: 100, default: 0, scale: 'lin', step: 1, mod: aud('vibratoGain.gain') },
  ],
  pluck: [
    { name: 'damping', label: 'Damping', unit: '', min: 0, max: 1, default: 0.5, scale: 'lin', mod: ctl },
    { name: 'brightness', label: 'Brightness', unit: '', min: 0, max: 1, default: 0.7, scale: 'lin', mod: ctl },
    { name: 'pickPosition', label: 'Pick position', unit: '', min: 0, max: 0.5, default: 0, scale: 'lin', step: 0.01, mod: ctl },
    { name: 'decay', label: 'Decay', unit: 's', min: 0.2, max: 10, default: 2, scale: 'pow3', mod: ctl },
    { name: 'release', label: 'Release', unit: 's', min: 0.02, max: 2, default: 0.1, scale: 'pow3', mod: ctl },
  ],
  granular: [
    { name: 'source', label: 'Source', unit: '', min: 0, max: 3, default: 'saw', scale: 'lin', options: ['saw', 'noise', 'chord', 'sample'], mod: null },
    { name: 'position', label: 'Position', unit: '', min: 0, max: 1, default: 0.5, scale: 'lin', step: 0.01, mod: ctl },
    { name: 'grainSize', label: 'Grain size', unit: 's', min: 0.01, max: 0.25, default: 0.06, scale: 'log', mod: ctl },
    { name: 'density', label: 'Density', unit: 'grains/s', min: 2, max: 60, default: 20, scale: 'log', mod: ctl },
    { name: 'spray', label: 'Spray', unit: '', min: 0, max: 1, default: 0.2, scale: 'lin', mod: ctl },
    { name: 'pitchSpread', label: 'Pitch spread', unit: 'cents', min: 0, max: 1200, default: 0, scale: 'lin', step: 1, mod: ctl },
    { name: 'attack', label: 'Attack', unit: 's', min: 0.002, max: 2, default: 0.05, scale: 'pow3', mod: ctl },
    { name: 'release', label: 'Release', unit: 's', min: 0.01, max: 4, default: 0.4, scale: 'pow3', mod: ctl },
  ],
};

export const TUNING_DEFS = {
  octave: { name: 'octave', label: 'Octave', unit: '', min: -3, max: 3, default: 0, step: 1 },
  cents: { name: 'cents', label: 'Cents', unit: 'cents', min: -100, max: 100, default: 0, step: 1 },
};

const SYNC = ['off'];
for (const d of ['1/32', '1/16', '1/8', '1/4', '1/2', '1/1']) SYNC.push(`${d}t`, d, `${d}d`);

const down = { dir: 'down' };

export const EFFECT_REGISTRY = {
  eq3: { params: [
    { id: 'lowFreq', min: 30, max: 500, default: 120, unit: 'Hz', scale: 'log' },
    { id: 'lowGain', min: -18, max: 18, default: 0, unit: 'dB', scale: 'lin' },
    { id: 'midFreq', min: 200, max: 8000, default: 1000, unit: 'Hz', scale: 'log' },
    { id: 'midGain', min: -18, max: 18, default: 0, unit: 'dB', scale: 'lin' },
    { id: 'midQ', min: 0.3, max: 8, default: 0.7, unit: '', scale: 'log' },
    { id: 'highFreq', min: 2000, max: 16000, default: 8000, unit: 'Hz', scale: 'log' },
    { id: 'highGain', min: -18, max: 18, default: 0, unit: 'dB', scale: 'lin' },
  ] },
  filter: { params: [
    { id: 'mode', min: 0, max: 2, default: 0, unit: '', scale: 'enum', options: ['lowpass', 'highpass', 'bandpass'] },
    { id: 'cutoff', min: 20, max: 20000, default: 2000, unit: 'Hz', scale: 'log' },
    { id: 'resonance', min: 0.5, max: 12, default: 0.707, unit: 'Q', scale: 'log' },
  ] },
  compressor: { params: [
    { id: 'threshold', min: -60, max: 0, default: -18, unit: 'dB', scale: 'lin' },
    { id: 'ratio', min: 1, max: 20, default: 4, unit: ':1', scale: 'log' },
    { id: 'attack', min: 0.1, max: 100, default: 10, unit: 'ms', scale: 'log' },
    { id: 'release', min: 10, max: 1000, default: 120, unit: 'ms', scale: 'log' },
    { id: 'makeup', min: 0, max: 24, default: 0, unit: 'dB', scale: 'lin', mod: down },
  ] },
  saturation: { params: [
    { id: 'drive', min: 0, max: 36, default: 6, unit: 'dB', scale: 'lin' },
    { id: 'tone', min: 1000, max: 16000, default: 8000, unit: 'Hz', scale: 'log' },
    { id: 'mix', min: 0, max: 1, default: 1, unit: 'fraction', scale: 'lin' },
    { id: 'output', min: -24, max: 6, default: -3, unit: 'dB', scale: 'lin', mod: down },
  ] },
  distortion: { params: [
    { id: 'mode', min: 0, max: 2, default: 0, unit: '', scale: 'enum', options: ['softclip', 'hardclip', 'foldback'] },
    { id: 'drive', min: 0, max: 48, default: 12, unit: 'dB', scale: 'lin' },
    { id: 'bias', min: -0.5, max: 0.5, default: 0, unit: '', scale: 'lin' },
    { id: 'tone', min: 500, max: 16000, default: 6000, unit: 'Hz', scale: 'log' },
    { id: 'mix', min: 0, max: 1, default: 1, unit: 'fraction', scale: 'lin' },
    { id: 'output', min: -36, max: 0, default: -6, unit: 'dB', scale: 'lin', mod: down },
  ] },
  delay: { params: [
    { id: 'time', min: 1, max: 2000, default: 375, unit: 'ms', scale: 'log', smoothMs: 50 },
    { id: 'sync', min: 0, max: SYNC.length - 1, default: 0, unit: '', scale: 'enum', options: SYNC },
    { id: 'feedback', min: 0, max: 0.9, default: 0.35, unit: 'fraction', scale: 'lin' },
    { id: 'highCut', min: 1000, max: 20000, default: 8000, unit: 'Hz', scale: 'log' },
    { id: 'mix', min: 0, max: 1, default: 0.3, unit: 'fraction', scale: 'lin' },
  ] },
  reverb: { params: [
    { id: 'size', min: 0, max: 1, default: 0.75, unit: 'fraction', scale: 'lin' },
    { id: 'decay', min: 0.2, max: 10, default: 2, unit: 's', scale: 'log' },
    { id: 'damping', min: 0, max: 1, default: 0.5, unit: 'fraction', scale: 'lin' },
    { id: 'preDelay', min: 0, max: 200, default: 10, unit: 'ms', scale: 'lin' },
    { id: 'mix', min: 0, max: 1, default: 0.25, unit: 'fraction', scale: 'lin' },
  ] },
};
