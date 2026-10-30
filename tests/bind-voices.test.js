import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBindingRuntime } from '../src/bind/index.js';
import { FakeEngine, FakeInstrument, createFakeClock, createFakeSky, createTraceSink, skyObj, CapExceeded } from './fakes.js';

const f = (name) => ({ op: 'field', args: [name] });
const G = 'jpl.cad';

function setup({ binding = {}, type = 'subtractive', instOpts = {}, objects = [], extraBindings = [] } = {}) {
  const ir = {
    irVersion: 1, seed: 1, tempo: 120, scale: { root: 'C', mode: 'chromatic' },
    instruments: [{ id: 'i0', type, volumeDb: -12, octave: 0, cents: 0, params: {}, fx: [] }],
    master: { fx: [] }, lfos: [], mods: [],
    bindings: [{ id: 'b0', kind: 'voices', inst: 'i0', group: G, select: null, pitch: f('p'), velocity: 64, pan: null, voiceMods: {}, ...binding }, ...extraBindings],
    reactions: [], layers: [], groups: [G], localOnly: false,
  };
  const engine = new FakeEngine({ instrument: (w) => new FakeInstrument(w.type, { params: w.params, ...instOpts }) });
  engine.sync([{ id: 'i0', type, params: {} }]);
  const sky = createFakeSky();
  for (const o of objects) sky.put(o);
  const clock = createFakeClock();
  const trace = createTraceSink();
  const rt = createBindingRuntime({ ir, engine, sky, clock, trace });
  return { ir, engine, inst: engine.get('i0'), sky, clock, trace, rt };
}

const cad = (key, fields) => skyObj(G, key, fields);

test('enter starts a voice tagged sky:<binding>:<object>; exit releases it with the started pitch', () => {
  const { inst, sky, clock, rt } = setup();
  rt.start();
  clock.advance(100);
  sky.enter(cad('a', { p: 60 }));
  assert.deepEqual(inst.callsOf('noteOn'), [['noteOn', 60, 64, 0.1, 'sky:b0:jpl.cad:a']]);
  clock.advance(100);
  sky.update('jpl.cad:a', { p: 62 });
  assert.deepEqual(inst.callsOf('setVoicePitch'), [['setVoicePitch', 'sky:b0:jpl.cad:a', 62, 150]]);
  clock.advance(100);
  sky.exit('jpl.cad:a');
  assert.deepEqual(inst.callsOf('noteOff'), [['noteOff', 60, 0.3, 'sky:b0:jpl.cad:a']], 'noteOff uses the started pitch');
  assert.equal(inst.soundingAt(0.31).length, 0);
});

test('objects present at start are selected; a pitch change below 0.01 semitones is ignored', () => {
  const { inst, sky, rt } = setup({ objects: [cad('a', { p: 60 }), cad('b', { p: 64 })] });
  rt.start();
  assert.deepEqual(inst.callsOf('noteOn').map((c) => c[4]), ['sky:b0:jpl.cad:a', 'sky:b0:jpl.cad:b']);
  sky.update('jpl.cad:a', { p: 60.005 });
  assert.equal(inst.callsOf('setVoicePitch').length, 0);
});

test('top-N selection and reselection when the ordering field changes', () => {
  const objects = ['a', 'b', 'c', 'd'].map((k, i) => cad(k, { p: 60 + i, distLD: [5, 1, 3, 2][i] }));
  const { inst, sky, clock, rt } = setup({ binding: { select: { top: 2, by: 'distLD', order: 'asc' } }, objects });
  rt.start();
  const sounding = () => inst.soundingAt(clock.audioTime() + 1).map((v) => v.source).sort();
  assert.deepEqual(sounding(), ['sky:b0:jpl.cad:b', 'sky:b0:jpl.cad:d']);
  clock.advance(50);
  sky.update('jpl.cad:a', { distLD: 0.5 }); // a enters the top 2, d (2) leaves
  assert.deepEqual(sounding(), ['sky:b0:jpl.cad:a', 'sky:b0:jpl.cad:b']);
  clock.advance(50);
  sky.exit('jpl.cad:b'); // b leaves, d returns
  assert.deepEqual(sounding(), ['sky:b0:jpl.cad:a', 'sky:b0:jpl.cad:d']);
  clock.advance(50);
  sky.update('jpl.cad:c', { distLD: null }); // non-numeric sorts last; still outside
  assert.deepEqual(sounding(), ['sky:b0:jpl.cad:a', 'sky:b0:jpl.cad:d']);
  // Every noteOff pairs with a noteOn of the same pitch and tag.
  const ons = inst.callsOf('noteOn').map((c) => `${c[4]}@${c[1]}`).sort();
  const offs = inst.callsOf('noteOff').map((c) => `${c[3]}@${c[1]}`);
  for (const off of offs) assert.ok(ons.includes(off), off);
});

test('desc order is the default; ties sort by id', () => {
  const objects = ['c', 'b', 'a'].map((k) => cad(k, { p: 60, h: 1 }));
  const { inst, rt } = setup({ binding: { select: { top: 2, by: 'h' } }, objects });
  rt.start();
  assert.deepEqual(inst.callsOf('noteOn').map((c) => c[4]), ['sky:b0:jpl.cad:a', 'sky:b0:jpl.cad:b']);
});

test('without select, a group larger than the cap uses the first objects by id (granular cap 4)', () => {
  const objects = Array.from({ length: 10 }, (_, i) => cad(String(i).padStart(2, '0'), { p: 50 + i }));
  const { inst, sky, rt } = setup({ type: 'granular', objects });
  rt.start();
  assert.equal(inst.callsOf('noteOn').length, 4);
  assert.deepEqual(inst.callsOf('noteOn').map((c) => c[4].slice(-2)), ['00', '01', '02', '03']);
  sky.enter(cad('99', { p: 70 }));
  assert.equal(inst.callsOf('noteOn').length, 4, 'a later id does not enter');
  sky.enter(cad('-1', { p: 70 }));
  assert.equal(inst.soundingAt(10).length, 4, 'an earlier id replaces 03 within the cap');
});

test('cap: 16 voices per instrument never exceeded by one binding', () => {
  const objects = Array.from({ length: 40 }, (_, i) => cad(`k${String(i).padStart(2, '0')}`, { p: 40 + i }));
  const { inst, rt } = setup({ objects });
  rt.start(); // the fake throws CapExceeded above 16
  assert.equal(inst.soundingAt(1).length, 16);
  assert.deepEqual(rt.disabled(), []);
});

test('two bindings on one instrument: the engine steals and the trace records stolen', () => {
  const objects = Array.from({ length: 16 }, (_, i) => cad(`k${String(i).padStart(2, '0')}`, { p: 40 + i }));
  const { inst, trace, rt } = setup({
    instOpts: { steal: true },
    objects,
    extraBindings: [{ id: 'b1', kind: 'voices', inst: 'i0', group: G, select: { top: 2, by: 'p', order: 'desc' }, pitch: f('p'), velocity: 64, pan: null, voiceMods: {} }],
  });
  rt.start();
  assert.equal(inst.stolen, 2);
  const stolen = trace.of({ event: 'stolen' });
  assert.equal(stolen.length, 2);
  assert.equal(stolen[0].level, 'warn');
  assert.equal(stolen[0].data.inst, 'i0');
});

test('pitch null: voice not started; starts on an update with a pitch; sounding voice keeps pitch on null', () => {
  const { inst, sky, rt } = setup();
  rt.start();
  sky.enter(cad('a', { p: null }));
  assert.equal(inst.callsOf('noteOn').length, 0);
  sky.update('jpl.cad:a', { p: 67 });
  assert.equal(inst.callsOf('noteOn').length, 1);
  sky.update('jpl.cad:a', { p: null });
  assert.equal(inst.callsOf('setVoicePitch').length, 0);
  assert.equal(inst.callsOf('noteOff').length, 0);
});

test('setVoicePan and setVoiceMod after noteOn when implemented; skipped when absent', () => {
  const binding = { pan: { op: 'map', args: [f('x'), 0, 1, -1, 1, 'lin'] }, voiceMods: { brightness: f('x'), none: f('missing') } };
  const a = setup({ binding });
  a.rt.start();
  a.sky.enter(cad('a', { p: 60, x: 0.75 }));
  const names = a.inst.calls.map((c) => c[0]);
  assert.deepEqual(names, ['noteOn', 'setVoicePan', 'setVoiceMod']);
  assert.deepEqual(a.inst.callsOf('setVoicePan')[0], ['setVoicePan', 'sky:b0:jpl.cad:a', 0.5]);
  assert.deepEqual(a.inst.callsOf('setVoiceMod')[0], ['setVoiceMod', 'sky:b0:jpl.cad:a', { brightness: 0.75 }]);
  a.sky.update('jpl.cad:a', { x: 1 });
  assert.deepEqual(a.inst.callsOf('setVoicePan')[1], ['setVoicePan', 'sky:b0:jpl.cad:a', 1]);

  const b = setup({ binding, instOpts: { voiceControl: false } });
  b.rt.start();
  b.sky.enter(cad('a', { p: 60, x: 0.75 }));
  assert.deepEqual(b.inst.calls.map((c) => c[0]), ['noteOn']);
  assert.deepEqual(b.rt.disabled(), []);
});

test('without setVoicePitch: release and restart at the new pitch, traced as fallback', () => {
  const { inst, sky, clock, trace, rt } = setup({ instOpts: { voiceControl: ['setVoicePan'] } });
  rt.start();
  sky.enter(cad('a', { p: 60 }));
  // Same task, same context time: noteOff must still release the voice that started at t.
  sky.update('jpl.cad:a', { p: 65 });
  const offs = inst.callsOf('noteOff');
  assert.equal(offs.length, 1);
  assert.equal(offs[0][1], 60);
  assert.ok(offs[0][2] > 0, 'noteOff time is after the voice start');
  assert.deepEqual(inst.callsOf('noteOn').map((c) => c[1]), [60, 65]);
  const fb = trace.of({ event: 'fallback' });
  assert.equal(fb.length, 1);
  assert.deepEqual([fb[0].data.from, fb[0].data.to], [60, 65]);
  clock.advance(500);
  sky.exit('jpl.cad:a');
  assert.equal(inst.callsOf('noteOff').at(-1)[1], 65, 'the restarted voice is released with its own pitch');
  assert.equal(inst.soundingAt(1).length, 0);
});

test('velocity is rounded and clamped; pitch clamped to 0–127 with the requested value traced', () => {
  const { inst, sky, trace, rt } = setup({ binding: { velocity: f('v') } });
  rt.start();
  sky.enter(cad('a', { p: 140, v: 300.4 }));
  sky.enter(cad('b', { p: 60, v: null }));
  sky.enter(cad('c', { p: 61, v: 12.6 }));
  assert.deepEqual(inst.callsOf('noteOn').map((c) => [c[1], c[2]]), [[127, 127], [60, 64], [61, 13]]);
  const rec = trace.of({ event: 'noteOn' })[0];
  assert.equal(rec.stage, 'AUDIO');
  assert.equal(rec.component, 'bind.b0');
  assert.deepEqual(rec.data, { inst: 'i0', pitch: 127, pitchRequested: 140, velocity: 127, source: 'sky:b0:jpl.cad:a', objectId: 'jpl.cad:a' });
  assert.match(rec.t, /^2026-10-29T14:00:00\.000Z$/);
  assert.ok(rec.traceId);
});

test('events in other groups do not touch the binding unless its expressions reference them', () => {
  const kp = { op: 'swpc', args: ['kp.kp'] };
  const { inst, sky, rt } = setup({ binding: { pitch: { op: 'add', args: [f('p'), kp] } } });
  sky.put(skyObj('swpc.kp', 'planetary', { kp: 2 }));
  rt.start();
  sky.enter(cad('a', { p: 60 }));
  assert.equal(inst.callsOf('noteOn')[0][1], 62);
  sky.update('swpc.kp:planetary', { kp: 5 });
  assert.deepEqual(inst.callsOf('setVoicePitch').at(-1), ['setVoicePitch', 'sky:b0:jpl.cad:a', 65, 150]);
  sky.enter(skyObj('jpl.scout', 'x', { p: 1 }));
  assert.equal(inst.calls.length, 2);
});

test('orbit voice options are re-evaluated on each orbit post for sounding voices', () => {
  let phase = 0;
  const ir = {
    seed: 1, scale: { root: 'C', mode: 'chromatic' },
    instruments: [{ id: 'i0', type: 'additive', volumeDb: -12, octave: 0, cents: 0, params: {}, fx: [] }],
    master: { fx: [] }, lfos: [], mods: [], reactions: [], layers: [], groups: ['celestrak.stations'],
    bindings: [{ id: 'b0', kind: 'voices', inst: 'i0', group: 'celestrak.stations', select: null,
      pitch: f('p'), velocity: 64, pan: { op: 'orbit', args: ['phaseCos', null, 1] }, voiceMods: {} }],
  };
  const engine = new FakeEngine();
  engine.sync([{ id: 'i0', type: 'additive', params: {} }]);
  const sky = createFakeSky();
  sky.put(skyObj('celestrak.stations', '25544', { p: 60 }));
  const rt = createBindingRuntime({ ir, engine, sky, clock: createFakeClock(), orbit: (id, q) => (q === 'phaseCos' ? phase : null) });
  rt.start();
  phase = 0.5;
  rt.orbitTick();
  phase = -0.25;
  rt.orbitTick();
  assert.deepEqual(engine.get('i0').callsOf('setVoicePan').map((c) => c[2]), [0, 0.5, -0.25]);
});

test('stop releases every sustained voice', () => {
  const objects = ['a', 'b', 'c'].map((k, i) => cad(k, { p: 60 + i }));
  const { inst, sky, rt } = setup({ objects });
  rt.start();
  rt.stop();
  assert.equal(inst.soundingAt(1).length, 0);
  sky.enter(cad('d', { p: 70 }));
  assert.equal(inst.callsOf('noteOn').length, 3, 'no events after stop');
  assert.ok(CapExceeded);
});
