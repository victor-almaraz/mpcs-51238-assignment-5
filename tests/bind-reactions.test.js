import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBindingRuntime, computeReactionState } from '../src/bind/index.js';
import { FakeEngine, createFakeClock, createFakeSky, createTraceSink } from './fakes.js';

const instruments = ['i0', 'i1', 'i2'].map((id) => ({ id, type: 'fm', volumeDb: -12, octave: 0, cents: 0, params: {}, fx: [] }));

function setup(reactions, groups = ['swpc.wind', 'jpl.cad']) {
  const ir = { seed: 1, instruments, master: { fx: [] }, lfos: [], mods: [], bindings: [], layers: [], groups, reactions };
  const engine = new FakeEngine();
  const sky = createFakeSky();
  const clock = createFakeClock();
  const trace = createTraceSink();
  const states = [];
  const rt = createBindingRuntime({ ir, engine, sky, clock, trace, onReactions: (s) => states.push(s) });
  return { sky, rt, states, trace };
}

test('computeReactionState combines: largest detune, union of mutes, only mutes the rest', () => {
  const reactions = [
    { on: 'stale', source: '*', actions: { detuneCents: 25 } },
    { on: 'stale', source: 'jpl.cad', actions: { detuneCents: 40, mute: ['i0'] } },
    { on: 'down', source: 'swpc.wind', actions: { only: ['i2'], desaturate: 0.5 } },
  ];
  const ids = ['i0', 'i1', 'i2'];
  const st = (o) => new Map(Object.entries(o));
  assert.deepEqual(computeReactionState(reactions, st({ 'swpc.wind': 'fresh', 'jpl.cad': 'fresh' }), ids, ['swpc.wind', 'jpl.cad']),
    { detuneCents: 0, muted: [], desaturate: 0, active: [] });
  assert.deepEqual(computeReactionState(reactions, st({ 'swpc.wind': 'stale', 'jpl.cad': 'fresh' }), ids, ['swpc.wind', 'jpl.cad']),
    { detuneCents: 25, muted: [], desaturate: 0, active: [0] });
  assert.deepEqual(computeReactionState(reactions, st({ 'swpc.wind': 'down', 'jpl.cad': 'stale' }), ids, ['swpc.wind', 'jpl.cad']),
    { detuneCents: 40, muted: ['i0', 'i1'], desaturate: 0.5, active: [0, 1, 2] });
  assert.equal(computeReactionState(reactions, st({ 'swpc.kp': 'stale' }), ids, ['swpc.wind']).detuneCents, 0,
    "'*' matches only the piece's sources");
});

test('reactions apply on stale/down and restore on fresh', () => {
  const { sky, rt, states, trace } = setup([
    { on: 'stale', source: '*', actions: { detuneCents: 25 } },
    { on: 'down', source: 'swpc.wind', actions: { mute: ['i1'] } },
  ]);
  rt.start();
  assert.equal(states.length, 0, 'nothing to apply while loading');
  sky.setFreshness('swpc.wind', 'fresh');
  assert.equal(states.length, 0);
  sky.setFreshness('jpl.cad', 'stale');
  assert.deepEqual(states.at(-1), { detuneCents: 25, muted: [], desaturate: 0, active: [0] });
  sky.setFreshness('swpc.wind', 'down');
  assert.deepEqual(states.at(-1).muted, ['i1']);
  assert.equal(states.at(-1).detuneCents, 25);
  sky.setFreshness('swpc.wind', 'fresh');
  sky.setFreshness('jpl.cad', 'fresh');
  assert.deepEqual(states.at(-1), { detuneCents: 0, muted: [], desaturate: 0, active: [] }, 'restored');
  sky.setFreshness('swpc.kp', 'down');
  assert.equal(states.length, 4, 'an unrelated source changes nothing');
  assert.equal(trace.of({ event: 'reaction' }).length, 4);
});

test('initial freshness is read from the store at start', () => {
  const { sky, rt, states } = setup([{ on: 'down', source: 'jpl.cad', actions: { only: ['i0'] } }]);
  sky.setFreshness('jpl.cad', 'down');
  rt.start();
  assert.deepEqual(states.at(-1).muted, ['i1', 'i2']);
});
