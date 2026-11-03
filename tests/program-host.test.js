// Program host (doc/bindings.md, Program host): commands from the VM reach the fake engine with
// clamped values and `prog:` tags, within the note-start budget, traced with the event's id.

import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeEngine, createFakeClock, createFakeSky, createTraceSink, skyObj } from './fakes.js';
import { build } from './fixtures/dsl/load.js';
import { createRunner } from '../src/dsl/program.js';
import { createProgramHost } from '../src/bind/program.js';

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

/** An in-process VM: the same runner the sandbox worker uses. */
function localVm(source) {
  let runner = null;
  const msgs = [];
  return {
    msgs,
    async program(m) {
      msgs.push(m);
      if (m.op === 'start') {
        const r = build(source);
        runner = createRunner(r.program);
        return runner.start(m);
      }
      if (m.op === 'batch') return runner.batch(m);
      return runner.stop();
    },
  };
}

/** A VM that replies with scripted commands. */
function scriptedVm(replies) {
  const msgs = [];
  return {
    msgs,
    async program(m) {
      msgs.push(m);
      const r = replies.shift();
      return r ?? { commands: [], errors: [], dropped: 0 };
    },
  };
}

function setup(vm, source = null, opts = {}) {
  const ir = source ? build(source).ir : opts.ir;
  const engine = new FakeEngine();
  engine.sync(ir.instruments.map((i) => ({ id: i.id, type: i.type, params: { ...i.params } })));
  for (const i of ir.instruments) engine.setFx(i.id, i.fx ?? []);
  const clock = createFakeClock({ start: 1000 });
  const sky = createFakeSky();
  const trace = createTraceSink();
  const problems = [];
  let layerPushes = 0;
  const host = createProgramHost({
    ir, vm, engine, sky, trace, clock, orbit: opts.orbit,
    onProblem: (p) => problems.push(p),
    onLayerValues: () => { layerPushes++; },
    newTraceId: (() => { let n = 0; return () => `timer-${++n}`; })(),
  });
  return { ir, engine, clock, sky, trace, problems, host, inst: (id = 'i0') => engine.get(id), layerPushes: () => layerPushes };
}

const PIECE = `
  const bell = fm({});
  const pad = additive({});
  on('jpl.scout', 'enter', (o) => {
    bell.play(o.neoScore, { velocity: 90, durationMs: 400 });
    pad.hold(o.objectName, 60);
  });
  on('jpl.scout', 'exit', (o) => pad.stop(o.objectName));
`;

test('an event reaches the engine as tagged notes carrying its trace id', async () => {
  const vm = localVm(PIECE);
  const s = setup(vm, PIECE);
  await s.host.start();
  s.sky.enter(skyObj('jpl.scout', 'A', { objectName: 'A', neoScore: 64 }), 'ev-1');
  s.clock.advance(25);
  await flush();
  const t = 1.0 + 0.025 + 0.1; // batch time 25 ms, plus the 100 ms latency
  assert.deepEqual(s.inst('i0').callsOf('noteOn'), [['noteOn', 64, 90, t, 'prog:i0:n1']]);
  assert.deepEqual(s.inst('i0').callsOf('noteOff'), [['noteOff', 64, t + 0.4, 'prog:i0:n1']]);
  assert.deepEqual(s.inst('i1').callsOf('noteOn'), [['noteOn', 60, 100, t, 'prog:i1:k:A']]);
  const chain = s.trace.records.filter((r) => r.traceId === 'ev-1').map((r) => `${r.stage}.${r.event}`);
  assert.deepEqual(chain, ['AUDIO.noteOn', 'AUDIO.noteOn']);
  s.sky.exit('jpl.scout:A', 'ev-2');
  s.clock.advance(25);
  await flush();
  assert.equal(s.inst('i1').callsOf('noteOff').length, 1);
});

test('the start message carries the followed groups and their current objects', async () => {
  const vm = localVm(PIECE);
  const s = setup(vm, PIECE);
  s.sky.put(skyObj('jpl.scout', 'B', { objectName: 'B', neoScore: 10 }));
  await s.host.start();
  assert.deepEqual(vm.msgs[0].groups, ['jpl.scout']);
  assert.deepEqual(vm.msgs[0].objects.map((o) => o.id), ['jpl.scout:B']);
  assert.equal(s.inst('i1').callsOf('noteOn').length, 1);
});

const IR = { instruments: [{ id: 'i0', type: 'fm', fx: [{ id: 'f0', type: 'delay', params: { mix: 0.3 }, bypass: false }] }], master: { fx: [] }, layers: [{ id: 'l0', type: 'glyph', props: { size: 12, color: '#ffffff' } }], groups: [], program: { handlers: [], follow: [] } };
const cmd = (c) => ({ at: 0, trace: 'x', src: 'h0', ...c });

test('the start message carries every source\'s freshness, which read.freshness returns', async () => {
  const src = `const b = fm({}); on('jpl.scout', 'enter', () => { if (read.freshness('jpl.scout') === 'fresh') b.play(61); });`;
  const vm = localVm(src);
  const s = setup(vm, src);
  s.sky.setFreshness('jpl.scout', 'fresh');
  await s.host.start();
  assert.deepEqual(vm.msgs[0].freshness, [{ source: 'jpl.scout', state: 'fresh' }]);
  s.sky.enter(skyObj('jpl.scout', 'A', { objectName: 'A' }));
  s.clock.advance(25);
  await flush();
  assert.deepEqual(s.inst().callsOf('noteOn').map((c) => c[1]), [61]);
});

test('a layer property the constructor did not set applies; invalid values are dropped', async () => {
  const s = setup(scriptedVm([{ commands: [
    cmd({ op: 'layer', layer: 'l0', props: { opacity: 2, color: 'red', size: 99 } }),
  ], errors: [], dropped: 0 }]), null, { ir: IR });
  await s.host.start();
  assert.deepEqual(s.host.layerValues(), { l0: { opacity: 1, size: 48 } });
  assert.equal(s.trace.of({ stage: 'BIND', event: 'invalid' }).length, 1);
});

test('a VM that lost the program is reported once and stops the host', async () => {
  const lost = { commands: [], errors: [{ handler: 'vm', line: null, message: 'gone' }], dropped: 0 };
  const s = setup(scriptedVm([{ commands: [cmd({ op: 'hold', inst: 'i0', key: 'a', pitch: 60 })], errors: [], dropped: 0 }, lost, lost]), null, { ir: IR });
  await s.host.start();
  for (let i = 0; i < 4; i++) { s.clock.advance(25); await flush(); }
  assert.deepEqual(s.problems.map((p) => p.code), ['handler_error']);
  assert.equal(s.host.running, false);
  assert.equal(s.inst().callsOf('noteOff').length, 1);
  assert.equal(s.clock.pending(), 0);
});

test('start and batch carry the declared orbits\' values in IR order', async () => {
  const src = `const p = additive({}); follow(sky.orbit('celestrak.stations:25544', 'sunlit'), sky.orbit('celestrak.stations:25544', 'latitude', { timeScale: 60 })); every(100, () => {});`;
  const vm = scriptedVm([]);
  const asked = [];
  const s = setup(vm, src, { orbit: (id, q, ts) => { asked.push([id, q, ts]); return q === 'sunlit' ? 9 : null; } });
  await s.host.start();
  s.clock.advance(25);
  await flush();
  assert.deepEqual(vm.msgs.map((m) => m.orbits), [[1, null], [1, null]]);
  assert.deepEqual(asked.slice(0, 2), [['celestrak.stations:25544', 'sunlit', 1], ['celestrak.stations:25544', 'latitude', 60]]);
});

test('harmonics updates reach setParam at most 30 times a second, latest value first', async () => {
  const H = [1, 0.5, 0.33, 0.25, 0.2, 0.17, 0.14, 0.12];
  const src = `const p = additive({ harmonics: [${H}] }); every(100, () => {});`;
  const set = (v) => cmd({ op: 'set', target: 'i0.harmonics', value: v });
  const s = setup(scriptedVm([
    { commands: [set([1]), set([0.5])], errors: [], dropped: 0 },
    { commands: [set([1, 2, 3, 4, 5, 6, 7, 8, 9]), set(['x']), cmd({ op: 'set', target: 'i0.attack', value: [1] })], errors: [], dropped: 0 },
  ]), src);
  await s.host.start();
  const sent = () => s.inst().callsOf('setParam').filter((c) => c[1] === 'harmonics').map((c) => c[2]);
  assert.deepEqual(sent(), [[1]]);
  s.clock.advance(25);
  await flush();
  assert.deepEqual(sent(), [[1]]);
  s.clock.advance(25);
  await flush();
  assert.deepEqual(sent(), [[1], [0.5]]);
  assert.equal(s.trace.of({ stage: 'BIND', event: 'invalid' }).length, 3);
});

test('pan moves a held note through setVoicePan at most 30 times a second', async () => {
  const s = setup(scriptedVm([
    { commands: [cmd({ op: 'hold', inst: 'i0', key: 'a', pitch: 60 }), cmd({ op: 'pan', inst: 'i0', key: 'a', pan: 0.5 }), cmd({ op: 'pan', inst: 'i0', key: 'a', pan: -0.25 }), cmd({ op: 'pan', inst: 'i0', key: 'x', pan: 1 })], errors: [], dropped: 0 },
  ]), null, { ir: IR });
  await s.host.start();
  const pans = () => s.inst().callsOf('setVoicePan').map((c) => c[2]);
  assert.deepEqual(pans(), [0.5], 'the first pan at once; a key that is not held is ignored');
  s.clock.advance(25);
  await flush();
  assert.deepEqual(pans(), [0.5]);
  s.clock.advance(25);
  await flush();
  assert.deepEqual(pans(), [0.5, -0.25], 'the latest waiting pan once 33 ms have passed');
});

test('a grid cells list is coerced at the boundary', async () => {
  const ir = { ...IR, layers: [{ id: 'l0', type: 'grid', group: null, props: { cells: [] } }] };
  const s = setup(scriptedVm([{ commands: [cmd({ op: 'layer', layer: 'l0', props: { cells: ['#ABCDEF', 'nope', '#000000'], sizes: [0.25, 'x', 3] } })], errors: [], dropped: 0 }]), null, { ir });
  await s.host.start();
  assert.deepEqual(s.host.layerValues(), { l0: { cells: ['#abcdef', null, '#000000'], sizes: [0.25, null, 1] } });
});

test('values are clamped and invalid commands are dropped and traced', async () => {
  const vm = scriptedVm([{ commands: [
    cmd({ op: 'play', inst: 'i0', pitch: 500, velocity: 0, pan: 9, durationMs: 1 }),
    cmd({ op: 'play', inst: 'i9', pitch: 60 }),
    cmd({ op: 'boom' }),
    cmd({ op: 'play', inst: 'i0', pitch: 'x' }),
  ], errors: [], dropped: 0 }]);
  const s = setup(vm, null, { ir: IR });
  await s.host.start();
  const i = s.inst();
  assert.deepEqual(i.callsOf('noteOn'), [['noteOn', 127, 1, 1.1, 'prog:i0:n1']]);
  assert.deepEqual(i.callsOf('setVoicePan'), [['setVoicePan', 'prog:i0:n1', 1]]);
  assert.deepEqual(i.callsOf('noteOff'), [['noteOff', 127, 1.1 + 0.02, 'prog:i0:n1']]);
  assert.equal(s.trace.of({ stage: 'BIND', event: 'invalid' }).length, 3);
});

test('at most 200 note starts per second for the whole program', async () => {
  const commands = Array.from({ length: 250 }, () => cmd({ op: 'play', inst: 'i0', pitch: 60 }));
  const s = setup(scriptedVm([{ commands, errors: [], dropped: 0 }]), null, { ir: IR });
  await s.host.start();
  assert.equal(s.inst().callsOf('noteOn').length, 200);
  assert.equal(s.trace.of({ stage: 'BIND', event: 'dropped' }).length, 50);
});

test('at most 256 commands per reply; dropped ones are counted', async () => {
  const commands = Array.from({ length: 300 }, () => cmd({ op: 'stopAll', inst: 'i0' }));
  const s = setup(scriptedVm([{ commands, errors: [], dropped: 4 }]), null, { ir: IR });
  await s.host.start();
  assert.deepEqual(s.trace.of({ stage: 'BIND', event: 'dropped' }).map((r) => r.data.count), [48]);
});

test('hold, glide, stop and stopAll use one tag per key', async () => {
  const s = setup(scriptedVm([{ commands: [
    cmd({ op: 'hold', inst: 'i0', key: 'a', pitch: 60 }),
    cmd({ op: 'hold', inst: 'i0', key: 'b', pitch: 64 }),
    cmd({ op: 'glide', inst: 'i0', key: 'a', pitch: 62, ms: 300 }),
    cmd({ op: 'hold', inst: 'i0', key: 'a', pitch: 67 }),
    cmd({ op: 'stop', inst: 'i0', key: 'b' }),
  ], errors: [], dropped: 0 }]), null, { ir: IR });
  await s.host.start();
  const i = s.inst();
  assert.deepEqual(i.callsOf('setVoicePitch'), [['setVoicePitch', 'prog:i0:k:a', 62, 300]]);
  assert.deepEqual(i.callsOf('noteOff').map((c) => [c[1], c[3]]), [[62, 'prog:i0:k:a'], [64, 'prog:i0:k:b']]);
  assert.deepEqual(s.host.held().map((h) => [h.tag, h.pitch]), [['prog:i0:k:a', 67]]);
  s.host.stop();
  assert.deepEqual(i.callsOf('noteOff').at(-1).slice(1, 2).concat(i.callsOf('noteOff').at(-1)[3]), [67, 'prog:i0:k:a']);
  assert.equal(s.host.held().length, 0);
});

test('set smooths a parameter at most 30 times a second; bypass and layer values apply', async () => {
  const s = setup(scriptedVm([{ commands: [
    cmd({ op: 'set', target: 'f0.mix', value: 0.9, smoothMs: 300 }),
    cmd({ op: 'set', target: 'f0.bypass', value: true }),
    cmd({ op: 'set', target: 'i0.index', value: 5, smoothMs: 0 }),
    cmd({ op: 'layer', layer: 'l0', props: { size: 20, nope: 1 } }),
  ], errors: [], dropped: 0 }]), null, { ir: IR });
  await s.host.start();
  s.clock.advance(1000);
  await flush();
  const mix = s.engine.calls.filter((c) => c[0] === 'setFxParam');
  assert.ok(mix.length >= 5 && mix.length <= 31, `setFxParam calls: ${mix.length}`);
  assert.ok(Math.abs(mix.at(-1)[3] - 0.9) < 1e-6);
  assert.deepEqual(s.engine.calls.filter((c) => c[0] === 'setFxBypass'), [['setFxBypass', 'f0', true]]);
  assert.deepEqual(s.inst().callsOf('setParam'), [['setParam', 'index', 5]]);
  assert.deepEqual(s.host.layerValues(), { l0: { size: 20 } });
  assert.equal(s.layerPushes(), 1);
});

test('a watchdog timeout releases held notes, reports handler_timeout and stops batches', async () => {
  const s = setup(scriptedVm([
    { commands: [cmd({ op: 'hold', inst: 'i0', key: 'a', pitch: 60 })], errors: [], dropped: 0 },
    { timeout: true },
  ]), null, { ir: IR });
  await s.host.start();
  s.clock.advance(25);
  await flush();
  assert.equal(s.inst().callsOf('noteOff').length, 1);
  assert.deepEqual(s.problems.map((p) => p.code), ['handler_timeout']);
  assert.equal(s.trace.of({ stage: 'SAFETY', event: 'programTimeout' }).length, 1);
  assert.equal(s.host.running, false);
  assert.equal(s.clock.pending(), 0);
});

test('handler errors become handler_error problems with their line', async () => {
  const s = setup(scriptedVm([{ commands: [], errors: [{ handler: 'h0', line: 7, message: 'boom' }], dropped: 0 }]), null, { ir: IR });
  await s.host.start();
  assert.deepEqual(s.problems, [{ code: 'handler_error', line: 7, message: 'boom' }]);
});

test('timer commands share one new trace id per handler per batch', async () => {
  const src = `const b = fm({}); every(10, () => b.play(60));`;
  const s = setup(localVm(src), src);
  await s.host.start();
  s.clock.advance(25);
  await flush();
  const ids = s.trace.of({ stage: 'AUDIO', event: 'noteOn' }).map((r) => r.traceId);
  assert.deepEqual(ids, ['timer-1', 'timer-2', 'timer-2']);
});

test('the audio host starts the program on run, restarts it on reload and stops it on stop and fault', async () => {
  const src = `const bell = fm({}); on('jpl.scout', 'enter', () => bell.play(60));`;
  const ir = build(src).ir;
  const clock = createFakeClock();
  const ctx = { get currentTime() { return clock.audioTime(); }, state: 'running' };
  let safety = null;
  const engineModule = {
    ensureRunning: async () => ctx,
    buildMasterBus: async () => ({ setHandler: (fn) => { safety = fn; } }),
    Engine: class extends FakeEngine {},
  };
  const vm = localVm(src);
  const { createAudioHost } = await import('../src/audio-host/index.js');
  const host = createAudioHost({ engineModule, sky: createFakeSky(), trace: createTraceSink(), timers: clock, now: clock.now, wallNow: clock.wallNow, vm });
  await host.run(ir);
  await flush();
  assert.deepEqual(vm.msgs.map((m) => m.op), ['start']);
  assert.ok(host.program?.running);
  assert.ok(host.reload(ir).changed.includes('program'));
  await flush();
  assert.deepEqual(vm.msgs.map((m) => m.op), ['start', 'stop', 'start']);
  host.stop();
  assert.equal(host.program, null);
  await host.run(ir);
  await flush();
  safety('fault');
  assert.equal(host.program, null);
  assert.deepEqual(vm.msgs.map((m) => m.op), ['start', 'stop', 'start', 'stop', 'start', 'stop']);
});

test('the audio host restarts a program the watchdog stopped, and gives up after 3 restarts within a minute', async () => {
  const src = `const bell = fm({}); every(100, () => bell.play(60));`;
  const ir = build(src).ir;
  const clock = createFakeClock();
  const ctx = { get currentTime() { return clock.audioTime(); }, state: 'running' };
  const engineModule = { ensureRunning: async () => ctx, buildMasterBus: async () => ({ setHandler() {} }), Engine: class extends FakeEngine {} };
  const local = localVm(src);
  const vm = { msgs: local.msgs, program: (m) => (m.op === 'batch' ? (local.msgs.push(m), Promise.resolve({ timeout: true })) : local.program(m)) };
  const problems = [];
  const notices = [];
  const trace = createTraceSink();
  const { createAudioHost } = await import('../src/audio-host/index.js');
  const host = createAudioHost({ engineModule, sky: createFakeSky(), trace, timers: clock, now: clock.now, wallNow: clock.wallNow, vm, onProgramProblem: (p) => problems.push(p), notify: (n) => notices.push(n) });
  await host.run(ir);
  for (let i = 0; i < 240; i++) { clock.advance(25); await flush(); }
  assert.equal(vm.msgs.filter((m) => m.op === 'start').length, 4, 'the first start and 3 restarts');
  assert.deepEqual(notices.filter((n) => n.kind === 'programRestart').length, 3);
  assert.equal(trace.of({ stage: 'RELOAD', event: 'programRestart' }).length, 3);
  assert.deepEqual(problems.map((p) => p.code), ['handler_timeout'], 'reported once, when it gives up');
  assert.equal(host.program, null);
  await host.run(ir);
  await flush();
  assert.equal(vm.msgs.filter((m) => m.op === 'start').length, 5, 'Run starts it again');
  host.stop();
});

test('a command time past the batch is pulled back to at most the latency ahead', async () => {
  const s = setup(scriptedVm([{ commands: [cmd({ op: 'play', inst: 'i0', pitch: 60, at: 1e9 })], errors: [], dropped: 0 }]), null, { ir: IR });
  await s.host.start();
  const [, , , t] = s.inst().callsOf('noteOn')[0];
  assert.ok(Math.abs(t - (s.clock.audioTime() + 0.1)) < 1e-9, String(t));
});

test('set accepts only numeric parameters of the instrument or slot type', async () => {
  const s = setup(scriptedVm([{ commands: [
    cmd({ op: 'set', target: 'f0.sync', value: 2 }),
    cmd({ op: 'set', target: 'i0.nope', value: 1, smoothMs: 0 }),
    cmd({ op: 'set', target: 'i0.index', value: 3, smoothMs: 0 }),
    cmd({ op: 'set', target: 'f0.mix', value: 50, smoothMs: 0 }),
  ], errors: [], dropped: 0 }]), null, { ir: IR });
  await s.host.start();
  assert.deepEqual(s.trace.of({ stage: 'BIND', event: 'invalid' }).map((r) => r.data.reason), ['not a numeric parameter', 'not a numeric parameter']);
  assert.deepEqual(s.engine.calls.filter((c) => c[0] === 'setFxParam'), [['setFxParam', 'f0', 'mix', 1]], 'clamped to the range');
  assert.deepEqual(s.inst().callsOf('setParam'), [['setParam', 'index', 3]]);
});
