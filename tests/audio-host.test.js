import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAudioHost, irToWidgets, NOTICES } from '../src/audio-host/index.js';
import { FakeEngine, createFakeClock, createFakeSky, createTraceSink, skyObj } from './fakes.js';

const kp = { op: 'swpc', args: ['kp.kp'] };

const baseIr = () => ({
  irVersion: 1, seed: 7, tempo: 72, scale: { root: 'D', mode: 'lydian' },
  instruments: [
    { id: 'i0', type: 'additive', volumeDb: -12, octave: 0, cents: 0, params: { attack: 1.5, vibratoDepth: 6 },
      fx: [{ id: 'f0', type: 'delay', params: { time: 500 }, bypass: false }, { id: 'f1', type: 'reverb', params: { decay: 6 }, bypass: false }] },
    { id: 'i1', type: 'fm', volumeDb: -16, octave: -1, cents: 90, params: { ratio: 3.5 }, fx: [] },
  ],
  master: { fx: [{ id: 'f2', type: 'compressor', params: { threshold: -20 }, bypass: false }] },
  lfos: [{ id: 'lfo0', shape: 'sine', rate: 0.03, phase: 0, retrigger: false, smooth: 0 }],
  mods: [
    { target: 'f1.decay', source: { lfo: 'lfo0' }, depth: 0.2, smoothMs: 250 },
    { target: 'f0.feedback', source: { expr: { op: 'map', args: [kp, 0, 9, -1, 1, 'lin'] } }, depth: 0.4, smoothMs: 250 },
  ],
  bindings: [
    { id: 'b0', kind: 'voices', inst: 'i0', group: 'celestrak.stations', select: null, pitch: { op: 'field', args: ['p'] }, velocity: 64, pan: null, voiceMods: {} },
    { id: 'b1', kind: 'param', inst: 'i0', param: 'vibratoDepth', expr: { op: 'map', args: [kp, 0, 9, 2, 40, 'lin'] }, smoothMs: 100 },
  ],
  reactions: [
    { on: 'stale', source: '*', actions: { detuneCents: 25 } },
    { on: 'down', source: 'swpc.kp', actions: { only: ['i0'], desaturate: 0.4 } },
  ],
  view: { projection: 'orbital', background: '#05070c' },
  layers: [{ id: 'l0', type: 'points', group: 'celestrak.stations', props: { size: 3 } }],
  groups: ['celestrak.stations', 'swpc.kp'],
  localOnly: false,
});

function setup() {
  const clock = createFakeClock();
  const events = [];
  const ctx = { get currentTime() { return clock.audioTime(); }, state: 'running' };
  let engine = null;
  class Engine extends FakeEngine {
    constructor(c, bus, opts) {
      super();
      this.args = { ctx: c, bus, opts };
      events.push('new Engine');
      engine = this;
    }
  }
  let safetyHandler = null;
  const engineModule = {
    ensureRunning: () => { events.push('ensureRunning'); return Promise.resolve(ctx); },
    buildMasterBus: async (c, opts) => {
      events.push(['buildMasterBus', opts]);
      return { worklets: { ks: 'ks-node' }, setHandler: (fn) => { safetyHandler = fn; } };
    },
    Engine,
  };
  const sky = createFakeSky();
  sky.put(skyObj('swpc.kp', 'planetary', { kp: 0 }));
  sky.put(skyObj('celestrak.stations', '25544', { p: 60 }));
  const trace = createTraceSink();
  const notices = [];
  const desat = [];
  const host = createAudioHost({
    engineModule, sky, trace, notify: (n) => notices.push(n), timers: clock, now: clock.now, wallNow: clock.wallNow,
    onVisualReaction: (d) => desat.push(d),
  });
  return { host, clock, ctx, sky, trace, notices, desat, events, engine: () => engine, safety: (e) => safetyHandler(e) };
}

test('irToWidgets maps instruments as documented', () => {
  const ir = baseIr();
  assert.deepEqual(irToWidgets(ir)[1], {
    id: 'i1', type: 'fm', muted: false, solo: false, armed: false, volumeDb: -16, part: 'all',
    params: { ratio: 3.5 }, octave: -1, cents: 90,
  });
  const w = irToWidgets(ir, { detuneCents: 25, muted: ['i0'] }, { i0: { vibratoDepth: 30 } });
  assert.equal(w[0].muted, true);
  assert.equal(w[0].cents, 25);
  assert.equal(w[1].cents, 100, 'cents clamp to ±100');
  assert.deepEqual(w[0].params, { attack: 1.5, vibratoDepth: 30 });
});

test('run: ensureRunning synchronously, then master bus, engine, sync, tempo, fx, lfos, mods in order', async () => {
  const s = setup();
  const p = s.host.run(baseIr());
  assert.deepEqual(s.events, ['ensureRunning'], 'ensureRunning is called before run() returns');
  await p;
  assert.deepEqual(s.events, ['ensureRunning', ['buildMasterBus', { realtime: true, masterGain: 0 }], 'new Engine']);
  const e = s.engine();
  assert.equal(e.args.ctx, s.ctx);
  assert.equal(e.args.opts.seed, 7);
  assert.equal(e.args.opts.realtime, true);
  assert.equal(e.args.opts.lookahead(), 0.1);
  assert.equal(e.args.opts.ks, 'ks-node');
  assert.equal(typeof e.args.opts.onFault, 'function');
  assert.equal(typeof e.args.opts.onError, 'function');
  const order = e.calls.map((c) => (c[0] === 'setFx' ? `setFx:${c[1]}` : c[0])).filter((n) => n !== 'pump' && n !== 'postModValue');
  assert.deepEqual(order.slice(0, 8), ['onFxFault', 'sync', 'setTempo', 'setFx:i0', 'setFx:i1', 'setFx:master', 'setLfos', 'setMods']);
  assert.deepEqual(e.callsOf('setTempo'), [['setTempo', 72]]);
  assert.deepEqual(e.callsOf('setMods')[0][1], [
    { target: 'f1.decay', source: 'lfo0', depth: 0.2 },
    { target: 'f0.feedback', source: 'dat0', depth: 0.4 },
  ]);
  assert.deepEqual(e.callsOf('postModValue')[0], ['postModValue', 'dat0', -1, 250], 'data source posted after setMods');
  assert.equal(e.get('i0').callsOf('noteOn').length, 1, 'bindings started');
});

test('pump: engine.pump(ctx.currentTime + 0.1) every 25 ms', async () => {
  const s = setup();
  await s.host.run(baseIr());
  const e = s.engine();
  e.calls.length = 0;
  s.clock.advance(100);
  const pumps = e.callsOf('pump');
  assert.equal(pumps.length, 4);
  assert.ok(Math.abs(pumps[0][1] - (s.clock.audioTime() - 0.075 + 0.1)) < 1e-9);
});

test('fxFault: SAFETY trace and one notice per fault; the slot is un-bypassed on the next reload', async () => {
  const s = setup();
  await s.host.run(baseIr());
  const e = s.engine();
  e.fault('i0', 'f1');
  e.fault('i0', 'f1');
  const recs = s.trace.of({ stage: 'SAFETY', event: 'fxFault' });
  assert.equal(recs.length, 1);
  assert.deepEqual(recs[0].data, { event: 'fxFault', owner: 'i0', slot: 'f1', type: 'reverb' });
  assert.deepEqual(s.notices, [{ kind: 'fxFault', live: 'polite', message: 'Effect reverb on i0 was reset and bypassed.' }]);
  assert.equal(NOTICES.fxFault('reverb', 'i0'), 'Effect reverb on i0 was reset and bypassed.');
  e.calls.length = 0;
  s.host.reload(baseIr());
  assert.deepEqual(e.callsOf('setFxBypass'), [['setFxBypass', 'f1', false]]);
  e.fault('i0', 'f1');
  assert.equal(s.notices.length, 2, 'a new fault after reload is reported again');
});

test('safety events: duck notice; fault notice stops the bindings', async () => {
  const s = setup();
  await s.host.run(baseIr());
  s.safety({ type: 'duck' });
  assert.deepEqual(s.notices.at(-1), { kind: 'duck', live: 'polite', message: 'Level reduced — sustained loud output' });
  s.safety('fault');
  assert.deepEqual(s.notices.at(-1), { kind: 'fault', live: 'assertive', message: 'Audio fault — output muted and reset' });
  assert.equal(s.host.runtime, null);
  assert.equal(s.trace.of({ stage: 'SAFETY', event: 'fault' })[0].level, 'error');
  s.sky.enter(skyObj('celestrak.stations', '99999', { p: 70 }));
  assert.equal(s.engine().get('i0').callsOf('noteOn').length, 1, 'nothing restarts until Run');
});

test('reactions: only and detune go through engine.sync; followed params are kept; restore on fresh', async () => {
  const s = setup();
  await s.host.run(baseIr());
  const e = s.engine();
  s.sky.update('swpc.kp:planetary', { kp: 9 });
  s.clock.advance(2000);
  assert.equal(e.get('i0').getParams().vibratoDepth, 40);
  e.calls.length = 0;
  s.sky.setFreshness('swpc.kp', 'down');
  let w = e.callsOf('sync').at(-1)[1];
  assert.deepEqual(w.map((x) => [x.id, x.muted, x.cents]), [['i0', false, 0], ['i1', true, 90]]);
  assert.equal(w[0].params.vibratoDepth, 40, 'sync carries the followed value');
  assert.equal(e.get('i0').getParams().vibratoDepth, 40, 'the followed value is not reset');
  assert.deepEqual(s.desat.at(-1), 0.4);
  s.sky.setFreshness('swpc.kp', 'stale');
  w = e.callsOf('sync').at(-1)[1];
  assert.deepEqual(w.map((x) => [x.id, x.muted, x.cents]), [['i0', false, 25], ['i1', false, 100]]);
  s.sky.setFreshness('swpc.kp', 'fresh');
  w = e.callsOf('sync').at(-1)[1];
  assert.deepEqual(w.map((x) => [x.id, x.muted, x.cents]), [['i0', false, 0], ['i1', false, 90]]);
  assert.equal(s.desat.at(-1), 0);
});

test('hot reload: unchanged parts post nothing; changed chain, mods and bindings only; RELOAD lists ids', async () => {
  const s = setup();
  await s.host.run(baseIr());
  const e = s.engine();
  const voice = e.get('i0').callsOf('noteOn').length;
  e.calls.length = 0;
  assert.deepEqual(s.host.reload(baseIr()), { changed: [] });
  assert.deepEqual(e.calls.filter((c) => c[0] !== 'pump').map((c) => c[0]), ['sync']);
  assert.equal(e.get('i0').callsOf('noteOff').length, 0, 'unchanged binding keeps its voice');

  const next = baseIr();
  next.instruments[0].fx[0].params.time = 250;
  next.lfos[0].rate = 0.05;
  next.bindings[1].smoothMs = 500;
  next.layers[0].props.size = 4;
  e.calls.length = 0;
  const { changed } = s.host.reload(next);
  assert.deepEqual(changed.sort(), ['b1', 'f0', 'l0', 'lfo0'].sort());
  const names = e.calls.filter((c) => c[0] !== 'pump' && c[0] !== 'postModValue' && c[0] !== 'setParam').map((c) => (c[0] === 'setFx' ? `setFx:${c[1]}` : c[0]));
  assert.deepEqual(names, ['sync', 'setFx:i0', 'setLfos', 'setMods']);
  assert.equal(e.get('i0').callsOf('noteOn').length, voice, 'voices binding untouched');
  const rel = s.trace.of({ stage: 'RELOAD', event: 'reload' }).at(-1);
  assert.deepEqual(rel.data.changed.sort(), ['b1', 'f0', 'l0', 'lfo0'].sort());

  // Removing an instrument with a chain removes the chain before the sync.
  const fewer = baseIr();
  fewer.instruments = [fewer.instruments[1]];
  fewer.bindings = [];
  fewer.mods = [];
  e.calls.length = 0;
  s.host.reload(fewer);
  const n2 = e.calls.filter((c) => c[0] === 'setFx' || c[0] === 'sync').map((c) => (c[0] === 'setFx' ? `setFx:${c[1]}` : c[0]));
  assert.deepEqual(n2, ['setFx:i0', 'sync']);
});

test('stop releases voices and removes instruments; a second Run reuses the engine', async () => {
  const s = setup();
  await s.host.run(baseIr());
  const e = s.engine();
  const i0 = e.get('i0');
  s.host.stop();
  assert.equal(i0.soundingAt(1e9).length, 0);
  assert.deepEqual(e.callsOf('sync').at(-1), ['sync', []]);
  await s.host.run(baseIr());
  assert.equal(s.engine(), e, 'same engine for the same context and seed');
  assert.equal(s.events.filter((x) => x === 'new Engine').length, 1);
});
