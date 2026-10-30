import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMasterControls, RESET_GUARD_MS } from '../src/audio-host/master.js';

function fakeHost() {
  const calls = [];
  const master = {
    setTarget: (g, t, tau) => calls.push(['setTarget', round(g), t, tau]),
    linearTo: (g, t, d) => calls.push(['linearTo', g, t, d]),
  };
  const analyser = (v) => ({ fftSize: 4, getFloatTimeDomainData: (a) => a.set([v, -v, v / 2, 0]) });
  const bus = { master, maxMaster: 1, fadeIn: (g) => calls.push(['fadeIn', round(g)]), ack: () => calls.push(['ack']), meter: analyser(0.5), preMeter: analyser(1.2), reduced: false };
  const engine = { bus, panic: (t) => calls.push(['panic', t]), pool: { live: () => [1, 2, 3] } };
  return { calls, host: { engine, ctx: { currentTime: 3, state: 'running' }, stop: () => calls.push(['stop']) } };
}
const round = (g) => Math.round(g * 1000) / 1000;

test('level() is the linear master gain at masterDb, null while muted', () => {
  const { host } = fakeHost();
  const m = createMasterControls(host);
  m.setLevel(-12, 0);
  assert.equal(round(m.level()), 0.251);
  m.panic();
  assert.equal(m.level(), null);
});

test('masterDb is clamped to maxMasterDb and to the bus maximum', () => {
  const { calls, host } = fakeHost();
  host.engine.bus.maxMaster = 0.5;
  const m = createMasterControls(host);
  m.setLevel(0, 0);
  assert.equal(m.level(), 0.5);
  m.setLevel(-3, -6);
  assert.equal(m.db, -6);
  assert.deepEqual(calls.at(-1), ['setTarget', 0.5, 3, 0.05]);
});

test('Panic calls engine.panic, stops and ramps to 0 over 10 ms; Reset needs one click after 1 s', () => {
  const { calls, host } = fakeHost();
  let t = 0;
  const m = createMasterControls(host, { now: () => t });
  m.setLevel(-12, 0);
  calls.length = 0;
  m.panic();
  assert.deepEqual(calls, [['panic', 3], ['stop'], ['linearTo', 0, 3, 0.01]]);
  assert.equal(m.muted, true);
  t = 500;
  assert.equal(m.reset(1), false, 'too soon');
  t = RESET_GUARD_MS + 1;
  assert.equal(m.reset(0), false, 'keyboard click');
  assert.equal(m.reset(2), false, 'double click');
  assert.equal(m.reset(1), true);
  assert.equal(m.muted, false);
  assert.deepEqual(calls.at(-1), ['setTarget', 0.251, 3, 0.05]);
});

test('moving the volume ends the mute', () => {
  const { host } = fakeHost();
  const m = createMasterControls(host);
  m.panic();
  m.moveVolume(-20);
  assert.equal(m.muted, false);
  assert.equal(m.db, -20);
});

test('meter reads peak, RMS and the limiting indicator; voices come from the pool', () => {
  const { host, calls } = fakeHost();
  const m = createMasterControls(host);
  const r = m.meter();
  assert.ok(Math.abs(r.peakDb - 20 * Math.log10(0.5)) < 1e-9);
  assert.ok(r.rmsDb < r.peakDb);
  assert.equal(r.limiting, true);
  assert.equal(m.voices(), 3);
  m.ack();
  assert.deepEqual(calls.at(-1), ['ack']);
});

test('without an engine every call is a no-op', () => {
  const m = createMasterControls({ engine: null, ctx: null, stop() {} });
  m.setLevel(-12);
  m.ack();
  assert.equal(m.voices(), 0);
  assert.equal(m.meter().peakDb, -Infinity);
});

test('Panic falls back to releaseAll on an engine without panic', () => {
  const { calls, host } = fakeHost();
  delete host.engine.panic;
  host.engine.releaseAll = (t) => calls.push(['releaseAll', t]);
  createMasterControls(host).panic();
  assert.deepEqual(calls[0], ['releaseAll', 3]);
});
