// Trace-replay tests (doc/testing.md, Trace-replay tests; doc/bindings.md, Trace replay).
// Each console export tests/fixtures/traces/<name>.jsonl is paired with <name>.ir.json. The
// test rebuilds objects from the CHANGE records, feeds them through the binding runtime with
// fakes, and compares the event-driven AUDIO records with those in the file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createBindingRuntime, canonicalJson } from '../src/bind/index.js';
import { FakeEngine, FakeInstrument, createFakeClock, createFakeSky, createTraceSink } from './fakes.js';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'traces');

/** AUDIO events that follow directly from sky events (not from the 30 Hz glide phase). */
const COMPARED = new Set(['noteOn', 'noteOff', 'setVoicePitch', 'setVoicePan', 'setVoiceMod', 'fallback', 'stolen', 'setFxBypass', 'modValue']);

/**
 * Fields after a CHANGE record's diff. The sky store writes `{ before, after }` with the whole
 * field sets (src/sky/core.js); per-field forms `{ f: { before, after } }`, `{ f: [before, after] }`
 * and `{ f: after }` are also accepted.
 */
function applyDiff(fields, diff) {
  if (diff && typeof diff === 'object' && Object.keys(diff).every((k) => k === 'before' || k === 'after')
      && (diff.after === null || typeof diff.after === 'object')) {
    return diff.after ? { ...diff.after } : { ...fields };
  }
  const out = { ...fields };
  for (const [k, d] of Object.entries(diff ?? {})) {
    if (Array.isArray(d) && d.length === 2) out[k] = d[1];
    else if (d && typeof d === 'object' && 'after' in d) out[k] = d.after;
    else out[k] = d;
  }
  return out;
}

/**
 * Replays the CHANGE records of an export through the runtime.
 * @param {any[]} records parsed trace records
 * @param {any} ir
 * @returns {any[]} produced records
 */
export function replay(records, ir) {
  const engine = new FakeEngine({ instrument: (w) => new FakeInstrument(w.type, { params: w.params, steal: true }) });
  engine.sync(ir.instruments.map((i) => ({ id: i.id, type: i.type, params: i.params })));
  for (const i of ir.instruments) engine.setFx(i.id, i.fx ?? []);
  engine.setFx('master', ir.master?.fx ?? []);
  const sky = createFakeSky();
  const changes = records.filter((r) => r.stage === 'CHANGE' && r.data && typeof r.data.objectId === 'string');
  const t0 = changes.length ? Date.parse(changes[0].t) : 0;
  const clock = createFakeClock({ epoch: t0 });
  const trace = createTraceSink();
  const rt = createBindingRuntime({ ir, engine, sky, clock, trace });
  rt.start();
  const known = new Map();
  for (const r of changes) {
    const dt = Date.parse(r.t) - t0 - clock.now();
    if (dt > 0) clock.advance(dt);
    const { objectId, kind } = r.data;
    const group = r.data.group ?? objectId.slice(0, objectId.indexOf(':'));
    const prev = known.get(objectId);
    const fields = r.data.after && typeof r.data.after === 'object' ? { ...r.data.after } : applyDiff(prev ? prev.fields : {}, r.data.diff);
    const obj = { id: objectId, source: r.data.source ?? group, group, fields };
    if (kind === 'exit') {
      if (prev) { known.delete(objectId); sky.exit(objectId, r.traceId); }
    } else if (kind === 'enter' || !prev) {
      known.set(objectId, obj);
      sky.enter(obj, r.traceId, r.data.initial ? { initial: true } : {});
    } else {
      known.set(objectId, obj);
      sky.update(objectId, fields, r.traceId);
    }
  }
  clock.advance(1000);
  // Stop only if the session stopped before its export: Stop releases voices with traceId null.
  // An export taken while the piece plays has no such noteOffs.
  if (records.some((r) => r.stage === 'AUDIO' && r.event === 'noteOff' && r.traceId == null)) rt.stop();
  return trace.records;
}

const key = (r) => canonicalJson({ event: r.event, component: r.component, traceId: r.traceId, data: r.data });
const audioKeys = (records) => records.filter((r) => r.stage === 'AUDIO' && COMPARED.has(r.event)).map(key).sort();

const exports = existsSync(DIR) ? readdirSync(DIR).filter((f) => f.endsWith('.jsonl')) : [];

if (exports.length === 0) {
  test('trace replay of committed console exports', { skip: 'no console export in tests/fixtures/traces/; export a trace ("Download Trace") from a session that behaved as intended and commit it as <name>.jsonl with the running IR as <name>.ir.json' }, () => {});
}

for (const file of exports) {
  test(`trace replay: ${file}`, () => {
    const irFile = path.join(DIR, file.replace(/\.jsonl$/, '.ir.json'));
    assert.ok(existsSync(irFile), `${file} needs its IR in ${path.basename(irFile)}`);
    const ir = JSON.parse(readFileSync(irFile, 'utf8'));
    const records = readFileSync(path.join(DIR, file), 'utf8').split('\n').filter((l) => l.trim()).map((l, i) => {
      try { return JSON.parse(l); } catch { throw new Error(`${file}:${i + 1}: not JSON`); }
    });
    assert.ok(records.some((r) => r.stage === 'CHANGE'), `${file} has no CHANGE records`);
    assert.deepEqual(audioKeys(replay(records, ir)), audioKeys(records));
  });
}

test('replay harness round trip: an export produced with fakes replays to the same AUDIO records', () => {
  const ir = {
    seed: 7, scale: { root: 'D', mode: 'lydian' },
    instruments: [
      { id: 'i0', type: 'subtractive', volumeDb: -14, octave: 0, cents: 0, params: {}, fx: [] },
      { id: 'i1', type: 'fm', volumeDb: -16, octave: 0, cents: 0, params: {}, fx: [] },
    ],
    master: { fx: [] }, lfos: [], reactions: [], layers: [], groups: ['jpl.cad', 'jpl.scout', 'swpc.kp'],
    mods: [{ target: 'i0.cutoff', source: { expr: { op: 'map', args: [{ op: 'count', args: ['jpl.scout'] }, 0, 4, -1, 1, 'lin'] } }, depth: 0.2, smoothMs: 250 }],
    bindings: [
      { id: 'b0', kind: 'voices', inst: 'i0', group: 'jpl.cad', select: { top: 2, by: 'distLD', order: 'asc' },
        pitch: { op: 'quantize', args: [{ op: 'map', args: [{ op: 'field', args: ['vRel'] }, 5, 30, 36, 60, 'lin'] }] }, velocity: 64, pan: null, voiceMods: {} },
      { id: 'b1', kind: 'trigger', inst: 'i1', group: 'jpl.scout', event: 'enter', when: null,
        pitch: { op: 'quantize', args: [{ op: 'rand', args: [72, 84] }] }, velocity: 64, durationMs: 250, maxPerSecond: 1 },
    ],
  };
  // Session: a store that emits a CHANGE record per event, as the console export holds.
  const engine = new FakeEngine({ instrument: (w) => new FakeInstrument(w.type, { params: w.params, steal: true }) });
  engine.sync(ir.instruments.map((i) => ({ id: i.id, type: i.type, params: {} })));
  const sky = createFakeSky();
  const clock = createFakeClock();
  const sink = createTraceSink();
  const rt = createBindingRuntime({ ir, engine, sky, clock, trace: sink });
  rt.start();
  const current = new Map();
  const change = (kind, objectId, fields, traceId) => {
    const before = kind === 'enter' ? null : current.get(objectId);
    const after = kind === 'exit' ? null : { ...(before ?? {}), ...fields };
    if (after) current.set(objectId, after); else current.delete(objectId);
    const group = objectId.split(':')[0];
    sink({
      t: new Date(clock.wallNow()).toISOString(), traceId, stage: 'CHANGE', component: 'sky', event: kind, level: 'info',
      data: { objectId, group, source: group, kind, diff: { before, after } },
    });
  };
  const steps = [
    ['enter', 'jpl.cad:a', { vRel: 10, distLD: 3 }],
    ['enter', 'jpl.cad:b', { vRel: 20, distLD: 1 }],
    ['enter', 'jpl.scout:X', {}],
    ['enter', 'jpl.scout:Y', {}],
    ['enter', 'jpl.cad:c', { vRel: 28, distLD: 0.5 }],
    ['update', 'jpl.cad:b', { vRel: 22 }],
    ['enter', 'jpl.scout:Z', {}],
    ['exit', 'jpl.cad:c', {}],
  ];
  let n = 0;
  for (const [kind, id, fields] of steps) {
    clock.advance(400);
    const traceId = `tr-${++n}`;
    change(kind, id, fields, traceId);
    if (kind === 'enter') sky.enter({ id, source: id.split(':')[0], group: id.split(':')[0], fields }, traceId);
    else if (kind === 'update') sky.update(id, fields, traceId);
    else sky.exit(id, traceId);
  }
  clock.advance(1000);
  rt.stop();
  const exported = sink.records.map((r) => JSON.parse(JSON.stringify(r)));
  const original = audioKeys(exported);
  assert.ok(original.length >= 8, `${original.length} AUDIO records`);
  assert.ok(exported.some((r) => r.event === 'dropped'), 'the trigger bucket dropped one event');
  assert.deepEqual(audioKeys(replay(exported, ir)), original);
});
