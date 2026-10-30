// The piece session wired with a fake engine and no database: load, Run, hot reload, Panic,
// Reset and dispose (src/ui/piece-session.js). No AudioContext, no Web Worker, no WebGL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FakeEngine } from './fakes.js';
import { createPieceSession } from '../src/ui/piece-session.js';
import { createTraceBus } from '../src/trace/bus.js';

const stationChord = () => JSON.parse(readFileSync(new URL('../content/starters/station-chord.ir.json', import.meta.url), 'utf8'));

const fakeWorker = () => ({ postMessage() {}, terminate() {}, onmessage: null });

function fakeEngineModule() {
  const fades = [];
  let engine = null;
  const ctx = { currentTime: 0, state: 'running', addEventListener() {} };
  class Engine extends FakeEngine {
    constructor(c, bus) { super(); this.bus = bus; engine = this; }
  }
  const master = { calls: [], setTarget(...a) { this.calls.push(['setTarget', ...a]); }, linearTo(...a) { this.calls.push(['linearTo', ...a]); } };
  return {
    fades, master, engine: () => engine,
    module: {
      ensureRunning: () => Promise.resolve(ctx),
      buildMasterBus: async () => ({ worklets: {}, setHandler() {}, fadeIn: (g) => fades.push(Math.round(g * 1000) / 1000), master, maxMaster: 1 }),
      Engine,
    },
  };
}

test('load, Run, reload, Panic and Reset with a fake engine', async (t) => {
  const fake = fakeEngineModule();
  const bus = createTraceBus();
  const s = createPieceSession({ client: null, engineModule: fake.module, createWorker: fakeWorker, trace: bus.trace });
  t.after(() => s.dispose());
  await s.ready;
  assert.equal(s.getState().ready, true);
  assert.equal(s.getState().error, null);
  s.load(stationChord());
  assert.deepEqual(s.getState().followed, ['celestrak.stations']);
  await s.run();
  assert.equal(s.getState().audio, 'playing');
  assert.deepEqual(fake.fades, [0.251], 'master fades in to −12 dB');
  const e = fake.engine();
  assert.deepEqual(e.callsOf('sync').at(-1)[1].map((w) => w.id), ['i0']);

  const next = stationChord();
  next.instruments[0].volumeDb = -18;
  const r = s.load(next);
  assert.ok(r.changed.includes('i0'), 'hot reload reports the changed instrument');

  s.panic();
  assert.equal(s.getState().audio, 'muted');
  assert.equal(e.callsOf('panic').length, 1);
  assert.deepEqual(fake.master.calls.at(-1)[0], 'linearTo');
  s.reset(1);
  assert.equal(s.getState().audio, 'muted', 'Reset within 1 s of Panic is ignored');
  s.moveVolume(-20);
  assert.equal(s.getState().audio, 'stopped', 'moving the volume ends the mute');
  const reload = bus.records().filter((r) => r.stage === 'RELOAD');
  assert.deepEqual(reload.map((r) => r.event), ['run', 'reload'], 'records without a cause get their own trace id');
  assert.ok(reload.every((r) => r.traceId.startsWith('reload-')));
});

test('replay needs the database', async () => {
  const fake = fakeEngineModule();
  const s = createPieceSession({ client: null, engineModule: fake.module, createWorker: fakeWorker, trace: createTraceBus().trace });
  await s.ready;
  await assert.rejects(s.replay({ windowMs: 3600e3, speed: 100 }), /database/);
  assert.equal(s.synthetic(), null);
  s.dispose();
});

test('Run before a piece is loaded rejects with a clear message', async () => {
  const fake = fakeEngineModule();
  const s = createPieceSession({ client: null, engineModule: fake.module, createWorker: fakeWorker, trace: createTraceBus().trace });
  await s.ready;
  await assert.rejects(s.run(), /No piece is loaded/);
  s.dispose();
});
