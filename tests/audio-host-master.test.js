// Audio host: master fade-in on start and resume, engine swap on a seed change, and the engine's
// analysis taps as the runtime's audio signals (doc/bindings.md, Audio host;
// doc/audio/audio-safety.md, Fades; doc/audio/audio-engine-core.md, Analysis taps and Teardown).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAudioHost, ENGINE_SWAP_MS } from '../src/audio-host/host.js';
import { FakeEngine, createFakeClock, createFakeSky, skyObj } from './fakes.js';

const ir = (seed = 1) => ({
  irVersion: 1, seed, tempo: 120, scale: { root: 'C', mode: 'chromatic' },
  instruments: [{ id: 'i0', type: 'additive', volumeDb: -12, octave: 0, cents: 0, params: {}, fx: [] }],
  master: { fx: [] }, lfos: [], mods: [],
  bindings: [{ id: 'b0', kind: 'voices', inst: 'i0', group: 'celestrak.stations', select: null, pitch: { op: 'field', args: ['p'] }, velocity: 64, pan: null, voiceMods: {} }],
  reactions: [], view: { projection: 'orbital', background: '#000000' }, layers: [], groups: ['celestrak.stations'], localOnly: false,
});

function setup({ level = 0.25 } = {}) {
  const clock = createFakeClock();
  const listeners = [];
  const ctx = {
    get currentTime() { return clock.audioTime(); },
    state: 'running',
    addEventListener: (type, fn) => { if (type === 'statechange') listeners.push(fn); },
    setState(s) { this.state = s; for (const fn of listeners) fn(); },
  };
  const engines = [];
  class Engine extends FakeEngine {
    constructor(c, bus, opts) { super(); this.bus = bus; this.opts2 = opts; engines.push(this); }
  }
  const fades = [];
  const engineModule = {
    ensureRunning: () => Promise.resolve(ctx),
    buildMasterBus: async () => ({ worklets: {}, setHandler() {}, fadeIn: (g) => fades.push(g) }),
    Engine,
  };
  const sky = createFakeSky();
  sky.put(skyObj('celestrak.stations', '25544', { p: 60 }));
  let masterLevel = level;
  const host = createAudioHost({ engineModule, sky, timers: clock, now: clock.now, wallNow: clock.wallNow, masterLevel: () => masterLevel });
  return { host, clock, ctx, engines, fades, sky, setLevel: (v) => { masterLevel = v; } };
}

test('the master fades in after the engine exists, not again while the context keeps running', async () => {
  const s = setup();
  await s.host.run(ir());
  assert.deepEqual(s.fades, [0.25]);
  await s.host.run(ir());
  assert.deepEqual(s.fades, [0.25], 'a second Run on a running context does not restart the ramp');
});

test('the master fades in again after every resume', async () => {
  const s = setup();
  await s.host.run(ir());
  s.ctx.state = 'suspended';
  await s.host.run(ir());
  assert.deepEqual(s.fades, [0.25, 0.25], 'Run resumed a suspended context');
  s.ctx.setState('interrupted');
  s.ctx.setState('running');
  assert.deepEqual(s.fades, [0.25, 0.25, 0.25], 'a resume after an interruption');
});

test('no fade-in while muted (masterLevel null)', async () => {
  const s = setup({ level: null });
  await s.host.run(ir());
  assert.deepEqual(s.fades, []);
});

test('a seed change releases and fades the old engine and disposes it 50 ms later', async () => {
  const s = setup();
  await s.host.run(ir(1));
  const old = s.engines[0];
  const p = s.host.run(ir(2));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(old.calls.filter((c) => ['releaseAll', 'fadeOutAll', 'dispose'].includes(c[0])).map((c) => c[0]), ['releaseAll', 'fadeOutAll']);
  assert.equal(s.engines.length, 1, 'the new engine waits for the fade');
  s.clock.advance(ENGINE_SWAP_MS);
  await p;
  assert.equal(old.disposed, true);
  assert.equal(s.engines.length, 2);
  assert.equal(s.host.engine, s.engines[1]);
  assert.deepEqual(s.fades, [0.25], 'the master stays up across the swap');
});

test('layer audio signals read the engine taps', async () => {
  const s = setup();
  await s.host.run(ir());
  const e = s.engines[0];
  e.levels.set('i0', 0.5);
  e.spectra.set('i0', [0.1, 0.2, 0.3, 0.4]);
  const rt = s.host.runtime;
  const props = rt.layerProps({ id: 'l0', props: { a: { op: 'level', args: ['i0'] }, b: { op: 'level', args: ['nope'] } } }, null);
  assert.deepEqual(props, { a: 0.5, b: null });
  const sp = rt.layerProps({ id: 'l1', props: { s: { op: 'spectrum', args: ['i0', 4] } } }, null);
  assert.deepEqual(sp.s, [0.1, 0.2, 0.3, 0.4]);
  assert.deepEqual(e.callsOf('spectrum').at(-1), ['spectrum', 'i0', 4]);
});

test('FakeEngine mirrors the real engine: modulatedValue, taps, limits', async () => {
  const e = new FakeEngine();
  e.sync([{ id: 'i0', type: 'additive', params: { cutoff: 800 } }]);
  e.setFx('i0', [{ id: 'f0', type: 'reverb', params: { mix: 0.3 }, bypass: false }]);
  assert.equal(e.modulatedValue('i0.cutoff'), 800, 'unrouted target returns its base value');
  assert.equal(e.modulatedValue('f0.mix'), 0.3);
  assert.equal(e.modulatedValue('zz9.cutoff'), null, 'unknown target');
  assert.equal(e.level('i0'), 0);
  assert.equal(e.level('zz'), null);
  assert.equal(e.spectrum('i0', 100).length, 32);
  assert.equal(e.voiceEnv('i0', 'sky:b0:x'), null);
  e.panic(0);
  assert.deepEqual(e.callsOf('panic'), [['panic', 0]]);
  const many = Array.from({ length: 17 }, (_, i) => ({ id: `i${i}`, type: 'fm', params: {} }));
  e.sync(many);
  for (let i = 1; i < 16; i++) e.setFx(`i${i}`, [{ id: `g${i}`, type: 'delay', params: {}, bypass: false }]);
  assert.throws(() => e.setFx('i16', [{ id: 'g16', type: 'delay', params: {}, bypass: false }]), (err) => err.limit === 'insert chains');
  e.setLfos([1, 2, 3].map((n) => ({ id: `lfo${n}`, shape: 'sine', rate: 1, phase: 0, retrigger: true, smooth: 0 })));
  assert.throws(() => e.setMods([1, 2, 3].map((n) => ({ target: 'i1.ratio', source: `lfo${n}`, depth: 0.1 }))), (err) => err.limit === 'retrigger');
  e.setMods([1, 2, 3].map((n) => ({ target: 'g1.time', source: `lfo${n}`, depth: 0.1 })));
});
