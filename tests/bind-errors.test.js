import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBindingRuntime } from '../src/bind/index.js';
import { FakeEngine, FakeInstrument, createFakeClock, createFakeSky, createTraceSink, skyObj } from './fakes.js';

const f = (name) => ({ op: 'field', args: [name] });

test('a throwing binding is traced at level error and disabled; the rest keeps running', () => {
  const ir = {
    seed: 1,
    instruments: [
      { id: 'i0', type: 'fm', volumeDb: -12, octave: 0, cents: 0, params: {}, fx: [] },
      { id: 'i1', type: 'fm', volumeDb: -12, octave: 0, cents: 0, params: {}, fx: [] },
    ],
    master: { fx: [] }, lfos: [], mods: [], reactions: [], layers: [], groups: ['jpl.scout'],
    bindings: [
      { id: 'b0', kind: 'trigger', inst: 'i0', group: 'jpl.scout', event: 'enter', when: null, pitch: f('p'), velocity: 64, durationMs: 250, maxPerSecond: 20 },
      { id: 'b1', kind: 'trigger', inst: 'i1', group: 'jpl.scout', event: 'enter', when: null, pitch: f('p'), velocity: 64, durationMs: 250, maxPerSecond: 20 },
      { id: 'b2', kind: 'voices', inst: 'i1', group: 'jpl.scout', select: null, pitch: { op: 'bogus', args: [] }, velocity: 64, pan: null, voiceMods: {} },
    ],
  };
  const engine = new FakeEngine();
  engine.sync(ir.instruments.map((i) => ({ id: i.id, type: i.type, params: {} })));
  const bad = engine.get('i0');
  bad.noteOn = () => { throw new Error('boom'); };
  const sky = createFakeSky();
  const trace = createTraceSink();
  const rt = createBindingRuntime({ ir, engine, sky, clock: createFakeClock(), trace });
  rt.start();
  sky.enter(skyObj('jpl.scout', 'A', { p: 70 }), 'tr-A');
  sky.enter(skyObj('jpl.scout', 'B', { p: 72 }), 'tr-B');
  const errors = trace.of({ event: 'error' });
  assert.deepEqual(errors.map((r) => [r.component, r.level, r.traceId]), [['bind.b0', 'error', 'tr-A'], ['bind.b2', 'error', 'tr-A']]);
  assert.equal(errors[0].data.message, 'boom');
  assert.match(errors[1].data.message, /Unknown expression op "bogus"/);
  assert.deepEqual(rt.disabled().sort(), ['b0', 'b2']);
  assert.deepEqual(engine.get('i1').callsOf('noteOn').map((c) => c[1]), [70, 72], 'b1 keeps running');

  // Disabled until the next reload.
  bad.noteOn = FakeInstrument.prototype.noteOn;
  rt.reload(ir);
  assert.deepEqual(rt.disabled(), ['b2'], 'b0 rebinds; b2 fails again on its first evaluation');
  sky.enter(skyObj('jpl.scout', 'C', { p: 74 }));
  assert.equal(bad.callsOf('noteOn').length, 1);
});

test('a binding to an instrument missing from the IR is disabled with an error, not a crash', () => {
  const ir = {
    seed: 1, instruments: [], master: { fx: [] }, lfos: [], mods: [], reactions: [], layers: [], groups: [],
    bindings: [{ id: 'b0', kind: 'voices', inst: 'i9', group: 'jpl.cad', select: null, pitch: 60, velocity: 64, pan: null, voiceMods: {} }],
  };
  const trace = createTraceSink();
  const rt = createBindingRuntime({ ir, engine: new FakeEngine(), sky: createFakeSky(), clock: createFakeClock(), trace });
  rt.start();
  assert.deepEqual(rt.disabled(), ['b0']);
  assert.match(trace.of({ event: 'error' })[0].data.message, /instrument i9/);
});

test('layer properties: constants, expressions per object, null for failures (reported once)', () => {
  const ir = { seed: 1, instruments: [], master: { fx: [] }, lfos: [], mods: [], reactions: [], bindings: [], groups: ['jpl.cad'],
    layers: [{ id: 'l0', type: 'rings', group: 'jpl.cad', props: {
      radius: { op: 'map', args: [f('distLD'), 0, 10, 10, 400, 'lin'] }, width: 2, color: { op: 'mix', args: [{ op: 'color', args: ['#ff0000'] }, '#0000ff', { op: 'div', args: [f('distLD'), 10] }] },
      opacity: { op: 'nosuchop', args: [] },
    } }] };
  const trace = createTraceSink();
  const rt = createBindingRuntime({ ir, engine: new FakeEngine(), sky: createFakeSky(), clock: createFakeClock(), trace });
  rt.start();
  const a = rt.layerProps(ir.layers[0], skyObj('jpl.cad', 'a', { distLD: 5 }));
  assert.deepEqual(a, { radius: 205, width: 2, color: '#800080', opacity: null });
  assert.deepEqual(rt.layerProps(ir.layers[0], skyObj('jpl.cad', 'b', {})), { radius: null, width: 2, color: null, opacity: null });
  assert.equal(trace.of({ stage: 'VISUAL', event: 'error' }).length, 1);
});
