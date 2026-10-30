// Engine FX, modulation, voice control and analysis taps through the real Engine on a fake Web
// Audio graph (doc/audio/effects.md, doc/audio/modulation.md, doc/bindings.md, Instrument
// contracts; doc/audio/audio-engine-core.md, Analysis taps). No AudioContext.
import test from 'node:test';
import assert from 'node:assert/strict';

import { installWebAudio, FakeContext, fakeBus, AudioWorkletNode as FakeWorklet, OscillatorNode, ConstantSourceNode, StereoPannerNode, AnalyserNode, GainNode } from './support/webaudio.js';
import { Engine, FxLimitError, ModLimitError, ModTargetError } from '../../src/audio/engine.js';
import { getDef } from '../../src/audio/synths/param-defs.js';
import { toNorm } from '../../src/audio/fx/core/params.js';
import { nativeGain, depthScale } from '../../src/audio/mod/model.js';

const restore = installWebAudio();
test.after(restore);

function widget(id, type = 'subtractive', params = {}) {
  return { id, type, muted: false, solo: false, armed: false, volumeDb: -6, part: 'all', params, octave: 0, cents: 0 };
}

function setup({ widgets = [widget('i0')], realtime = false, fx = true } = {}) {
  const ctx = new FakeContext({ currentTime: 1 });
  const bus = fakeBus(ctx, { fx });
  const errors = [];
  const engine = new Engine(ctx, bus, { seed: 5, realtime, onError: (e) => errors.push(e) });
  engine.sync(widgets);
  return { ctx, bus, engine, errors };
}

const slot = (id, type, params = {}, bypass = false) => ({ id, type, params, bypass });
const chainNode = (engine, owner) => engine.fx.chains.get(owner)?.node ?? null;

test('setFx inserts a chain between the instrument and mixBus, and the master chain before masterGain', () => {
  const { engine, bus } = setup();
  const inst = engine.get('i0');
  assert.ok(inst.output.outputs.has(bus.mixBus));
  engine.setFx('i0', [slot('f0', 'delay', { time: 250, sync: '1/8' })]);
  const node = chainNode(engine, 'i0');
  assert.ok(node instanceof FakeWorklet);
  assert.equal(node.name, 'fx-chain');
  assert.deepEqual(node.options.outputChannelCount, [2]);
  assert.equal(node.options.channelCountMode, 'explicit');
  assert.ok(inst.output.outputs.has(node) && !inst.output.outputs.has(bus.mixBus));
  assert.ok(node.outputs.has(bus.mixBus));
  assert.equal(node.core.slots[0].base.get('sync'), 7, 'enum names become option indices');

  engine.setFx('master', [slot('m0', 'compressor')]);
  const master = chainNode(engine, 'master');
  assert.ok(bus.mixBus.outputs.has(master) && !bus.mixBus.outputs.has(bus.masterGain));
  assert.ok(master.outputs.has(bus.masterGain));
  assert.ok(bus.masterGain.outputs.has(bus.safetyOut), 'the safety stage still follows every chain');

  const sent = node.port.sent.length;
  engine.setFx('i0', [slot('f0', 'delay', { time: 250, sync: '1/8' })]);
  assert.equal(node.port.sent.length, sent, 'an unchanged list posts nothing');

  engine.setFx('i0', []);
  assert.ok(inst.output.outputs.has(bus.mixBus) && !inst.output.outputs.has(node));
  assert.equal(node.outputs.size, 0);
  assert.ok(node.port.closed);
  engine.dispose();
  assert.ok(bus.mixBus.outputs.has(bus.masterGain), 'dispose restores mixBus → masterGain');
  assert.equal(master.port.closed, true);
});

test('a chain set before its instrument exists is wired when sync creates it; removal with the instrument', () => {
  const { engine, bus } = setup({ widgets: [] });
  engine.setFx('i1', [slot('f0', 'eq3')]);
  engine.sync([widget('i1')]);
  const node = chainNode(engine, 'i1');
  assert.ok(engine.get('i1').output.outputs.has(node));
  engine.sync([]);
  assert.equal(engine.fx.chains.has('i1'), false);
  assert.ok(node.port.closed);
  assert.ok(bus.mixBus.outputs.has(bus.masterGain));
});

test('realtime removal bypasses every slot first and disconnects 30 ms later', async () => {
  const { engine, bus } = setup({ realtime: true });
  engine.setFx('i0', [slot('f0', 'reverb'), slot('f1', 'delay')]);
  const node = chainNode(engine, 'i0');
  engine.setFx('i0', []);
  assert.deepEqual(node.port.sent.slice(-2), [{ t: 'bypass', slot: 'f0', on: true }, { t: 'bypass', slot: 'f1', on: true }]);
  assert.ok(engine.get('i0').output.outputs.has(node), 'still wired during the fade');
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(engine.get('i0').output.outputs.has(bus.mixBus));
  assert.ok(node.port.closed);
  engine.dispose();
});

test('FxLimitError at each limit; a rejected setFx changes nothing', () => {
  const widgets = Array.from({ length: 17 }, (_, i) => widget(`i${i}`));
  const { engine } = setup({ widgets });
  const err = (fn, limit) => assert.throws(fn, (e) => e instanceof FxLimitError && e.limit === limit, limit);
  err(() => engine.setFx('i0', Array.from({ length: 9 }, (_, i) => slot(`f${i}`, 'eq3'))), 'slots');
  engine.setFx('i0', Array.from({ length: 8 }, (_, i) => slot(`f${i}`, 'eq3')));
  for (let i = 1; i < 16; i++) engine.setFx(`i${i}`, [slot(`g${i}`, 'eq3')]);
  err(() => engine.setFx('i16', [slot('g16', 'eq3')]), 'insert chains');
  engine.setFx('master', [slot('m0', 'reverb'), slot('m1', 'reverb'), slot('m2', 'reverb')]);
  err(() => engine.setFx('i1', [slot('r1', 'reverb'), slot('r2', 'reverb')]), 'reverbs');
  assert.deepEqual(engine.fx.chains.get('i1').slots.map((s) => s.id), ['g1'], 'unchanged after the rejection');
  err(() => engine.setFx('i2', [slot('f3', 'eq3')]), 'slot ids');
  err(() => engine.setFx('i2', [slot('x', 'eq3'), slot('x', 'eq3')]), 'slot ids');
  err(() => engine.setTempo(19), 'tempo');
  err(() => engine.setTempo(301), 'tempo');
  err(() => engine.setTempo(Number.NaN), 'tempo');
  assert.throws(() => engine.setFx('i2', [slot('y', 'chorus')]), TypeError);
  assert.throws(() => engine.setFx('i2', [slot('y', 'eq3', { gainz: 1 })]), TypeError);
  assert.throws(() => engine.setFx('i2', [slot('y', 'eq3', { lowGain: Number.NaN })]), TypeError);
  engine.dispose();
});

test('setTempo, setFxParam and setFxBypass post validated messages; faults reach onFxFault', () => {
  const { engine, ctx } = setup();
  const faults = [];
  engine.onFxFault((owner, id) => faults.push([owner, id]));
  engine.setFx('i0', [slot('f0', 'filter'), slot('f1', 'delay')]);
  const node = chainNode(engine, 'i0');
  engine.setTempo(90);
  assert.deepEqual(node.port.sent.at(-1), { t: 'tempo', bpm: 90, at: ctx.currentTime });
  engine.setFxParam('f0', 'cutoff', 99999);
  assert.deepEqual(node.port.sent.at(-1), { t: 'param', slot: 'f0', name: 'cutoff', value: 20000 });
  engine.setFxParam('f0', 'mode', 1.4);
  assert.equal(node.port.sent.at(-1).value, 1, 'enum indices are rounded');
  const n = node.port.sent.length;
  engine.setFxParam('f0', 'cutoff', Number.NaN);
  assert.equal(node.port.sent.length, n, 'non-finite values are ignored');
  assert.throws(() => engine.setFxParam('zz', 'cutoff', 1), /unknown slot/);
  assert.throws(() => engine.setFxBypass('zz', true), /unknown slot/);
  engine.setFxBypass('f1', true);
  assert.deepEqual(node.port.sent.at(-1), { t: 'bypass', slot: 'f1', on: true });

  node.render(new Float32Array(128).fill(0.1));
  node.core.slots[0].kernel.state[0] = Number.NaN;
  node.render(new Float32Array(128).fill(0.1));
  node.render(new Float32Array(128).fill(0.1));
  assert.deepEqual(faults, [['i0', 'f0']]);
  engine.panic();
  assert.deepEqual(node.port.sent.at(-1), { t: 'reset' });
  engine.dispose();
});

test('without the fx-chain worklet the configuration is kept, audio passes dry and onError fires once', () => {
  const { engine, bus, errors } = setup({ fx: false });
  engine.setFx('i0', [slot('f0', 'eq3')]);
  engine.setFx('master', [slot('m0', 'eq3')]);
  assert.equal(chainNode(engine, 'i0'), null);
  assert.ok(engine.get('i0').output.outputs.has(bus.mixBus));
  assert.equal(errors.length, 1);
  engine.dispose();
});

const lfo = (id, o = {}) => ({ id, shape: 'sine', rate: 0.5, phase: 0, retrigger: false, smooth: 0, ...o });

test('ModLimitError and ModTargetError at each documented limit and rule', () => {
  const { engine } = setup({ widgets: [widget('i0'), widget('a0', 'additive'), widget('p0', 'pluck')] });
  engine.setFx('i0', [slot('f0', 'filter'), slot('f1', 'saturation')]);
  const lim = (fn, limit) => assert.throws(fn, (e) => e instanceof ModLimitError && e.limit === limit, limit);
  const tgt = (target) => assert.throws(() => engine.setMods([{ target, source: 'dat0', depth: 0.1 }]), (e) => e instanceof ModTargetError && e.target === target, target);
  lim(() => engine.setLfos(Array.from({ length: 17 }, (_, i) => lfo(`lfo${i}`))), 'lfos');
  lim(() => engine.setLfos([lfo('lfo0', { rate: 0.001 })]), 'rate');
  lim(() => engine.setLfos([lfo('lfo0', { rate: 25 })]), 'rate');
  lim(() => engine.setLfos([lfo('lfo0', { rate: { data: 'dat0', min: 0.001, max: 2 } })]), 'rate');
  assert.throws(() => engine.setLfos([lfo('lfo0', { shape: 'wobble' })]), TypeError);
  assert.throws(() => engine.setLfos([lfo('lfo0', { rate: { sync: '1/3' } })]), TypeError);
  assert.throws(() => engine.setLfos([lfo('lfo0'), lfo('lfo0')]), TypeError);
  engine.setLfos([lfo('lfo0'), lfo('lfo1', { retrigger: true }), lfo('lfo2', { retrigger: true }), lfo('lfo3', { retrigger: true })]);
  lim(() => engine.setMods(Array.from({ length: 33 }, (_, i) => ({ target: 'i0.cutoff', source: `dat${i}`, depth: 0.01 }))), 'routes');
  lim(() => engine.setMods(Array.from({ length: 5 }, (_, i) => ({ target: 'i0.cutoff', source: `dat${i}`, depth: 0.01 }))), 'routes_per_target');
  lim(() => engine.setMods([{ target: 'i0.cutoff', source: 'lfo0', depth: 1.5 }]), 'depth');
  lim(() => engine.setMods([
    { target: 'i0.cutoff', source: 'lfo1', depth: 0.1 },
    { target: 'i0.resonance', source: 'lfo2', depth: 0.1 },
    { target: 'i0.attack', source: 'lfo3', depth: 0.1 },
  ]), 'retrigger');
  engine.setMods([{ target: 'f0.cutoff', source: 'lfo1', depth: 0.1 }, { target: 'f1.mix', source: 'lfo2', depth: 0.1 }, { target: 'f1.drive', source: 'lfo3', depth: 0.1 }]);
  tgt('i0.waveform');
  tgt('a0.harmonics');
  tgt('f0.mode');
  tgt('i0.nope');
  tgt('x9.cutoff');
  tgt('nodot');
  assert.throws(() => engine.setMods([{ target: 'i0.cutoff', source: 'lfo9', depth: 0.1 }]), TypeError);
  engine.dispose();
});

test('effect routes, LFOs and data values reach the chain; a chain created later receives them too', () => {
  const { engine, ctx } = setup();
  engine.setFx('i0', [slot('f0', 'filter', { cutoff: 1000 })]);
  engine.setLfos([lfo('lfo0', { rate: 2 })]);
  engine.setMods([{ target: 'f0.cutoff', source: 'lfo0', depth: 0.1 }, { target: 'f0.resonance', source: 'dat0', depth: 0.2 }]);
  const node = chainNode(engine, 'i0');
  assert.deepEqual(node.port.sent.at(-1), { t: 'mods', routes: [
    { slot: 'f0', name: 'cutoff', source: 'lfo0', depth: 0.1 },
    { slot: 'f0', name: 'resonance', source: 'dat0', depth: 0.2 },
  ] });
  const l = node.port.sent.findLast((m) => m.t === 'lfos');
  assert.equal(l.lfos[0].anchorT, engine.t0, 'the phase anchor is the engine start time');
  engine.postModValue('dat0', 0.5, 600);
  assert.deepEqual(node.port.sent.at(-1), { t: 'modValue', id: 'dat0', value: 0.5, smoothMs: 600 });
  // Coalescing: a second post within 1/30 s is held until pump().
  engine.postModValue('dat0', -0.25, 600);
  assert.equal(node.port.sent.at(-1).value, 0.5);
  ctx.advance(0.04);
  engine.pump(ctx.currentTime + 0.1);
  assert.deepEqual(node.port.sent.at(-1), { t: 'modValue', id: 'dat0', value: -0.25, smoothMs: 600 });

  engine.setFx('master', [slot('m0', 'reverb')]);
  engine.setMods([{ target: 'm0.mix', source: 'dat0', depth: 0.2 }]);
  const m = chainNode(engine, 'master');
  const types = m.port.sent.map((x) => x.t);
  assert.deepEqual(types.slice(0, 5), ['tempo', 'slots', 'lfos', 'modValue', 'modValue']);
  assert.equal(m.port.sent[3].snap, true);
  assert.deepEqual(m.port.sent.at(-1), { t: 'mods', routes: [{ slot: 'm0', name: 'mix', source: 'dat0', depth: 0.2 }] });
  assert.deepEqual(node.port.sent.at(-1), { t: 'mods', routes: [] }, 'the insert chain lost its routes');

  // Reports feed modulatedValue; unrouted targets return the base; unknown ones null.
  for (let i = 0; i < 40; i++) m.render(new Float32Array(128));
  const v = engine.modulatedValue('m0.mix');
  assert.ok(Number.isFinite(v) && v !== 0.25);
  assert.equal(engine.modulatedValue('f0.cutoff'), 1000);
  assert.equal(engine.modulatedValue('zz.mix'), null);
  engine.dispose();
});

test('audio-rate route: one shared oscillator, a route gain in cents, connected to every voice and limited at the edges', () => {
  const { engine, ctx } = setup({ widgets: [widget('i0', 'subtractive', { cutoff: 2000 })] });
  engine.setLfos([lfo('lfo0', { rate: 2, phase: 0.25 })]);
  engine.setMods([{ target: 'i0.cutoff', source: 'lfo0', depth: 0.1 }]);
  const inst = engine.get('i0');
  const R = [...inst.mod.routes.values()][0];
  const osc = engine.mod.audioSources.get('lfo0').node;
  assert.ok(osc instanceof OscillatorNode && osc.periodicWave && osc.started === ctx.currentTime);
  assert.ok(osc.outputs.has(R.gain));
  const def = getDef('subtractive', 'cutoff');
  const expected = 0.1 * Math.log2(16000 / 40) * 1200;
  assert.deepEqual(R.gain.gain.events.at(-1), ['setTargetAtTime', expected, ctx.currentTime, 0.01]);
  inst.noteOn(48, 100, ctx.currentTime, 'sky:b0:o1');
  inst.noteOn(55, 100, ctx.currentTime, 'sky:b0:o2');
  const voices = inst.activeVoices();
  for (const v of voices) assert.ok(R.gain.outputs.has(v.filter.detune), 'each voice detune is a route target');
  // Base near the bottom: the limit keeps toNorm(base) − Σ|depth| ≥ 0.
  inst.setParam('cutoff', 45);
  const k = depthScale(def, 45, [0.1]);
  assert.ok(k < 1);
  assert.equal(R.gain.gain.events.at(-1)[1], nativeGain(def, 0.1 * k));
  assert.ok(toNorm(def, 45) - 0.1 * k >= -1e-12);
  // A voice that ends disconnects its parameters from the route gain.
  const v = voices[0];
  v.sources[0].onended();
  assert.equal(R.gain.outputs.has(v.filter.detune), false);
  // Removing the route disconnects the gain and stops the unused shared source.
  engine.setMods([]);
  assert.equal(R.gain.outputs.size, 0);
  assert.equal(engine.mod.audioSources.size, 0);
  assert.equal(osc.stopped, ctx.currentTime);
  engine.dispose();
});

test('retrigger LFO on an audio-rate target: one oscillator per voice, started at noteOn with the LFO phase', () => {
  const { engine, ctx } = setup({ widgets: [widget('a0', 'additive', { vibratoDepth: 50 })] });
  engine.setLfos([lfo('lfo0', { rate: 3, retrigger: true, phase: 0.5 })]);
  engine.setMods([{ target: 'a0.vibratoDepth', source: 'lfo0', depth: 0.2 }]);
  const inst = engine.get('a0');
  const before = ctx.of(OscillatorNode).length;
  inst.noteOn(60, 100, ctx.currentTime + 0.05, 'trig:b1');
  const added = ctx.of(OscillatorNode).slice(before);
  const lfoOsc = added.find((o) => o.periodicWave && o.frequency.value === 3);
  assert.ok(lfoOsc, 'a per-voice LFO oscillator');
  assert.equal(lfoOsc.started, ctx.currentTime + 0.05);
  const v = inst.activeVoices()[0];
  const g = [...lfoOsc.outputs][0];
  assert.ok(g instanceof GainNode && g.outputs.has(v.depth.gain));
  assert.equal(g.gain.value, 0.2 * 100);
  engine.dispose();
});

test('control-rate route: pump() applies the model value; getParams keeps the base; removal restores it', () => {
  const { engine, ctx } = setup({ widgets: [widget('g0', 'granular', { density: 20 })] });
  engine.setLfos([lfo('lfo0', { shape: 'square', rate: 1 })]);
  engine.setMods([{ target: 'g0.density', source: 'lfo0', depth: 0.2 }]);
  const inst = engine.get('g0');
  ctx.advance(0.1);   // square is +1 in the first half cycle
  engine.pump(ctx.currentTime + 0.1);
  const def = getDef('granular', 'density');
  const u = toNorm(def, 20) + 0.2;
  assert.ok(Math.abs(inst.params.density - def.min * (def.max / def.min) ** u) < 1e-6);
  assert.equal(inst.getParams().density, 20);
  assert.ok(Math.abs(engine.modulatedValue('g0.density') - inst.params.density) < 1e-12);
  inst.setParam('density', 30);
  assert.equal(inst.getParams().density, 30);
  engine.setMods([]);
  assert.equal(inst.params.density, 30);
  engine.dispose();
});

test('data sources on the audio path: a ConstantSourceNode follows each post with τ = smoothMs / 3', () => {
  const { engine, ctx } = setup();
  engine.setMods([{ target: 'i0.resonance', source: 'dat3', depth: 0.25 }]);
  const src = engine.mod.audioSources.get('dat3').node;
  assert.ok(src instanceof ConstantSourceNode);
  engine.postModValue('dat3', 2, 900);
  assert.deepEqual(src.offset.events.at(-1), ['setTargetAtTime', 1, ctx.currentTime, 0.3]);
  engine.postModValue('dat3', Number.NaN);
  assert.equal(src.offset.events.at(-1)[1], 1, 'non-finite posts are ignored');
  engine.dispose();
});

test('voice control: opaque source tags, pitch glide, pan, per-voice mods and envelope values', () => {
  const { engine, ctx } = setup({ widgets: [widget('i0'), widget('f0', 'fm'), widget('p0', 'pluck')] });
  const inst = engine.get('i0');
  const t = ctx.currentTime;
  inst.noteOn(60, 127, t, 'sky:b0:celestrak.stations:25544');
  inst.noteOn(60, 127, t, 'trig:b1');
  const [a, b] = inst.activeVoices();
  inst.setVoicePitch('sky:b0:celestrak.stations:25544', 62.5, 150);
  assert.deepEqual(a.osc.detune.events.at(-1), ['setTargetAtTime', 250, t, 0.05]);
  assert.equal(b.osc.detune.events.length, 0, 'only the tagged voice glides');
  inst.setVoicePan('trig:b1', -2);
  assert.ok(b.panner instanceof StereoPannerNode && b.panner.pan.value === -1);
  assert.ok(b.env.outputs.has(b.panner) && !b.env.outputs.has(inst.polyNode));
  inst.setVoicePan('trig:b1', 0.5);
  assert.deepEqual(b.panner.pan.events.at(-1), ['setTargetAtTime', 0.5, t, 0.01]);
  inst.setVoiceMod('trig:b1', { cutoff: 0.1, waveform: 1, nope: 3 });
  const c = b.voiceMods.get('cutoff');
  assert.ok(c instanceof ConstantSourceNode && c.outputs.has(b.filter.detune));
  assert.equal(b.voiceMods.size, 1, 'non audio-rate names are ignored');
  // noteOff matches pitch and tag; the other voice keeps sounding.
  inst.noteOff(60, t + 0.5, 'trig:b1');
  assert.equal(b.released, true);
  assert.equal(a.released, false);
  // voiceEnv: 0 before the voice, rising through the attack, null for unknown tags.
  assert.equal(inst.voiceEnv('nobody', t + 0.1), null);
  const env = inst.voiceEnv('sky:b0:celestrak.stations:25544', t + 0.005);
  assert.ok(env > 0 && env < 1);
  assert.equal(inst.voiceEnv('sky:b0:celestrak.stations:25544', t + 1), 1);
  assert.equal(engine.voiceEnv('i0', 'sky:b0:celestrak.stations:25544'), 0);
  // FM glides carrier and modulator together; pluck implements none of the extensions.
  const fm = engine.get('f0');
  fm.noteOn(50, 100, t, 'x');
  const fv = fm.activeVoices()[0];
  fm.setVoicePitch('x', 52, 0);
  assert.deepEqual(fv.carrier.detune.events.at(-1), ['setValueAtTime', 200, t]);
  assert.deepEqual(fv.mod.detune.events.at(-1), ['setValueAtTime', 200, t]);
  const p = engine.get('p0');
  assert.equal(typeof p.setVoicePitch, 'undefined');
  assert.equal(typeof p.setVoicePan, 'undefined');
  assert.equal(typeof p.setVoiceMod, 'undefined');
  p.noteOn(60, 100, t, 'sky:b2:o');
  assert.equal(p.voiceEnv('sky:b2:o', t), 1);
  assert.ok(Math.abs(p.voiceEnv('sky:b2:o', t + 2) - 0.001) < 1e-9, 'T60 decay: −60 dB after `decay` s');
  engine.dispose();
});

test('analysis taps: one sink analyser per instrument, cached reads, 0–1 values', () => {
  const { engine, ctx } = setup({ widgets: [widget('i0'), widget('i1')] });
  assert.equal(engine.level('zz'), null);
  assert.equal(ctx.of(AnalyserNode).length, 0, 'no analyser before the first read');
  const lvl = engine.level('i0');
  const [an] = ctx.of(AnalyserNode);
  assert.equal(lvl, 0);
  assert.equal(an.outputs.size, 0, 'the analyser is a sink');
  assert.ok(engine.get('i0').output.outputs.has(an));
  an.timeData = new Float32Array(1024).fill(0.1);   // −20 dBFS
  assert.equal(engine.level('i0'), 0, 'cached within 16 ms');
  ctx.advance(0.02);
  assert.ok(Math.abs(engine.level('i0') - 40 / 60) < 1e-6);
  const reads = an.reads;
  engine.level('i0');
  engine.spectrum('i0', 8);
  engine.spectrum('i0', 8);
  assert.equal(an.reads, reads + 1, 'one spectrum read per frame');
  an.byteData = new Uint8Array(512).fill(255);
  ctx.advance(0.02);
  const s = engine.spectrum('i0', 100);
  assert.equal(s.length, 32);
  assert.ok(s.every((x) => x === 1));
  assert.equal(engine.spectrum('i0', 1).length, 4);
  engine.level('i1');
  engine.level('i0');
  assert.equal(ctx.of(AnalyserNode).length, 2, 'at most one analyser per instrument');
  engine.sync([widget('i1')]);
  assert.equal(engine.level('i0'), null);
  engine.dispose();
});
