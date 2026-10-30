// fx-chain processor core (doc/audio/effects.md, Chain processor; doc/audio/modulation.md,
// Effect targets): slot handling, slot safety rules, modulation evaluation, reports, protocol.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';

import { ChainCore, SUB_BLOCK } from '../../src/audio/fx/chain-core.js';
import { EFFECTS } from '../../src/audio/fx/effects/registry.js';
import { toNorm, fromNorm } from '../../src/audio/fx/core/params.js';
import { periodicValue, stepValue } from '../../src/audio/mod/lfo.js';

const FS = 48000;
const Q = 128;

function core() {
  const posted = [];
  const c = new ChainCore(FS, { seed: 7, post: (m) => posted.push(m) });
  return { c, posted };
}

function defaults(type) {
  return Object.fromEntries(EFFECTS[type].params.map((d) => [d.id, d.default]));
}

function slot(id, type, params = {}, bypass = false) {
  return { id, type, params: { ...defaults(type), ...params }, bypass };
}

/** Renders `quanta` quanta of `input(i)` (or silence) starting at `frame`; returns [L, R]. */
function render(c, quanta, input = () => 0, frame0 = 0) {
  const L = new Float32Array(quanta * Q);
  const R = new Float32Array(quanta * Q);
  const iL = new Float32Array(Q);
  const oL = new Float32Array(Q);
  const oR = new Float32Array(Q);
  for (let q = 0; q < quanta; q++) {
    for (let i = 0; i < Q; i++) iL[i] = input(q * Q + i);
    c.process(iL, iL, oL, oR, Q, frame0 + q * Q);
    L.set(oL, q * Q);
    R.set(oR, q * Q);
  }
  return [L, R];
}

test('no slots: the chain passes its input through; an unconnected input gives silence', () => {
  const { c } = core();
  const [L] = render(c, 2, (i) => Math.sin(i / 10));
  for (let i = 0; i < 2 * Q; i++) assert.equal(L[i], Math.fround(Math.sin(i / 10)));
  const oL = new Float32Array(Q).fill(1);
  const oR = new Float32Array(Q).fill(1);
  c.process(null, null, oL, oR, Q, 0);
  assert.ok(oL.every((x) => x === 0) && oR.every((x) => x === 0));
});

test('slots: unchanged id and type keep the kernel; a new slot in a running chain fades in over 10 ms', () => {
  const { c } = core();
  c.handle({ t: 'slots', slots: [slot('f0', 'delay', { mix: 1, time: 10, feedback: 0 })] });
  const k0 = c.slots[0].kernel;
  render(c, 4, (i) => (i === 0 ? 1 : 0));
  c.handle({ t: 'slots', slots: [slot('f0', 'delay', { mix: 1, time: 10, feedback: 0.5 })] });
  assert.equal(c.slots[0].kernel, k0, 'same kernel, state kept');
  // A new saturation slot at −24 dB output added to a running chain: from dry to wet over 10 ms.
  const r = core();
  r.c.handle({ t: 'slots', slots: [slot('f0', 'eq3')] });
  render(r.c, 20, () => 0.5);
  r.c.handle({ t: 'slots', slots: [slot('f0', 'eq3'), slot('f1', 'saturation', { drive: 0, output: -24 })] });
  assert.equal(r.c.slots[1].slot.wet, 0);
  const [L] = render(r.c, 8, () => 0.5);
  let maxStep = 0;
  for (let i = 1; i < L.length; i++) maxStep = Math.max(maxStep, Math.abs(L[i] - L[i - 1]));
  assert.ok(maxStep < 0.01, `step ${maxStep}`);
  assert.ok(L[L.length - 1] < 0.05, 'fully wet after the fade');
  assert.ok(L[0] > 0.45, 'starts from dry');
});

test('EffectSlot rules in the chain: a fault is reported once; non-finite input is silenced without a fault', () => {
  const { c, posted } = core();
  c.handle({ t: 'slots', slots: [slot('f0', 'filter', { cutoff: 500 })] });
  render(c, 2, (i) => Math.sin(i));
  c.slots[0].kernel.state[0] = Number.NaN;
  render(c, 4, (i) => Math.sin(i));
  assert.deepEqual(posted.filter((m) => m.t === 'fault'), [{ t: 'fault', slot: 'f0' }]);
  assert.equal(c.slots[0].slot.bypassed, true);
  // A slots message with bypass false keeps a faulted slot bypassed; a bypass message clears it.
  c.handle({ t: 'slots', slots: [slot('f0', 'filter', { cutoff: 500 })] });
  assert.equal(c.slots[0].slot.faulted, true);
  c.handle({ t: 'bypass', slot: 'f0', on: false });
  assert.equal(c.slots[0].slot.faulted, false);

  const b = core();
  b.c.handle({ t: 'slots', slots: [slot('f0', 'filter'), slot('f1', 'reverb')] });
  const [L, R] = render(b.c, 2, (i) => (i === 5 ? Number.NaN : 0.1));
  assert.ok(L.every(Number.isFinite) && R.every(Number.isFinite));
  assert.equal(b.posted.filter((m) => m.t === 'fault').length, 0);
});

test('invalid messages are ignored and reported once per code; ping replies pong', () => {
  const { c, posted } = core();
  c.handle({ t: 'slots', slots: [{ id: 'x', type: 'nope', params: {}, bypass: false }] });
  c.handle({ t: 'slots', slots: 'bad' });
  c.handle({ t: 'param', slot: 'missing', name: 'mix', value: 1 });
  c.handle({ t: 'tempo', bpm: 500 });
  c.handle({ t: 'whatever' });
  c.handle({ t: 'ping', id: 3 });
  assert.deepEqual(posted, [
    { t: 'error', code: 'invalid_slots' },
    { t: 'error', code: 'invalid_param' },
    { t: 'error', code: 'invalid_tempo' },
    { t: 'error', code: 'unknown_message' },
    { t: 'pong', id: 3 },
  ]);
  assert.equal(c.slots.length, 0);
});

/** Collects the values a route sends to kernel.setParam, one per sub-block. */
function spy(c, slotId) {
  const e = c.slots.find((s) => s.id === slotId);
  const calls = [];
  const orig = e.slot.setParam.bind(e.slot);
  e.slot.setParam = (id, v) => { calls.push([id, v]); orig(id, v); };
  return calls;
}

test('effect route: once per 32-frame sub-block, u = toNorm(base) + depth · lfo, phase from frames', () => {
  const { c } = core();
  c.handle({ t: 'slots', slots: [slot('f0', 'filter', { cutoff: 1000 })] });
  c.handle({ t: 'lfos', seed: 7, lfos: [{ id: 'lfo0', index: 0, shape: 'sine', rate: 2, phase: 0.25, smooth: 0, anchorT: 0, anchorPhase: 0.25, hz: 2 }] });
  c.handle({ t: 'mods', routes: [{ slot: 'f0', name: 'cutoff', source: 'lfo0', depth: 0.1 }] });
  const calls = spy(c, 'f0');
  const frame0 = 48000 * 3;   // t = 3 s
  render(c, 2, () => 0, frame0);
  assert.equal(calls.length, (2 * Q) / SUB_BLOCK);
  const def = EFFECTS.filter.params.find((d) => d.id === 'cutoff');
  calls.forEach(([id, v], i) => {
    const t = (frame0 + i * SUB_BLOCK) / FS;
    const expected = fromNorm(def, toNorm(def, 1000) + 0.1 * periodicValue(0, 0.25 + 2 * t));
    assert.equal(id, 'cutoff');
    assert.ok(Math.abs(v - expected) < 1e-9 * expected, `${v} vs ${expected}`);
  });
  // A log parameter spanning 10 octaves moves one octave for depth 0.1 at source 1.
  const top = fromNorm(def, toNorm(def, 1000) + 0.1);
  assert.ok(Math.abs(Math.log2(top / 1000) - 0.1 * Math.log2(20000 / 20)) < 1e-9, 'about one octave');
});

test('effect route: modulated value is clamped to the range; a down parameter never exceeds its base', () => {
  const { c, posted } = core();
  c.handle({ t: 'slots', slots: [slot('f0', 'saturation', { output: -6, mix: 0.9 })] });
  c.handle({ t: 'lfos', seed: 7, lfos: [{ id: 'lfo0', index: 0, shape: 'square', rate: 5, phase: 0, smooth: 0, anchorT: 0, anchorPhase: 0, hz: 5 }] });
  c.handle({ t: 'mods', routes: [
    { slot: 'f0', name: 'output', source: 'lfo0', depth: -1 },
    { slot: 'f0', name: 'mix', source: 'lfo0', depth: 1 },
  ] });
  const calls = spy(c, 'f0');
  render(c, 375 * 2);   // 2 s: many square cycles
  const outs = calls.filter(([id]) => id === 'output').map(([, v]) => v);
  const mixes = calls.filter(([id]) => id === 'mix').map(([, v]) => v);
  assert.ok(outs.length > 0 && outs.every((v) => v <= -6 + 1e-9), `max ${Math.max(...outs)}`);
  assert.ok(Math.min(...outs) === -24, 'reaches the bottom of the range');
  assert.ok(mixes.every((v) => v >= 0 && v <= 1));
  assert.equal(Math.max(...mixes), 1);
  // Reports: at most every 100 ms, the current values in route order.
  const reports = posted.filter((m) => m.t === 'report');
  assert.ok(reports.length >= 19 && reports.length <= 20, `${reports.length} reports in 2 s`);
  assert.equal(reports[0].values.length, 2);
  assert.ok(reports.every((r) => r.values[0] <= -6 + 1e-6));
});

test('enum targets are not evaluated; removing the last route restores the base value', () => {
  const { c, posted } = core();
  c.handle({ t: 'slots', slots: [slot('f0', 'filter', { cutoff: 800 })] });
  c.handle({ t: 'lfos', seed: 7, lfos: [{ id: 'lfo0', index: 0, shape: 'sine', rate: 1, phase: 0, smooth: 0, anchorT: 0, anchorPhase: 0, hz: 1 }] });
  c.handle({ t: 'mods', routes: [{ slot: 'f0', name: 'mode', source: 'lfo0', depth: 0.5 }] });
  assert.equal(c.targets.length, 0);
  assert.ok(posted.some((m) => m.code === 'invalid_route'));
  c.handle({ t: 'mods', routes: [{ slot: 'f0', name: 'cutoff', source: 'lfo0', depth: 0.5 }] });
  render(c, 40);
  const calls = spy(c, 'f0');
  c.handle({ t: 'mods', routes: [] });
  assert.deepEqual(calls, [['cutoff', 800]]);
});

test('data sources: clamped, smoothed with τ = smoothMs / 3, snapped on request', () => {
  const { c } = core();
  c.handle({ t: 'slots', slots: [slot('f0', 'reverb', { mix: 0.5 })] });
  c.handle({ t: 'mods', routes: [{ slot: 'f0', name: 'mix', source: 'dat0', depth: 0.5 }] });
  c.handle({ t: 'modValue', id: 'dat0', value: 7, smoothMs: 300 });
  assert.equal(c.data.get('dat0').target, 1);
  const calls = spy(c, 'f0');
  render(c, Math.round((0.1 * FS) / Q));   // one time constant
  const last = calls[calls.length - 1][1];
  // After τ the smoothed value is ≈ 1 − e⁻¹ of the way: mix ≈ 0.5 + 0.5 · 0.632.
  assert.ok(Math.abs(last - (0.5 + 0.5 * (1 - Math.exp(-1)))) < 0.02, `${last}`);
  c.handle({ t: 'modValue', id: 'dat0', value: -1, smoothMs: 0, snap: true });
  assert.equal(c.data.get('dat0').y, -1);
  c.handle({ t: 'modValue', id: 'dat0', value: Number.NaN });
  assert.equal(c.data.get('dat0').target, -1, 'non-finite values are ignored');
});

test('LFO phase: synced rate follows tempo; a tempo change re-anchors without a phase jump', () => {
  const { c } = core();
  c.handle({ t: 'lfos', seed: 7, lfos: [{ id: 'lfo0', index: 0, shape: 'saw', rate: { sync: '1/4' }, phase: 0, smooth: 0, anchorT: 0, anchorPhase: 0, hz: 2 }] });
  const L = c.lfos[0];
  assert.equal(L.hz, 2, '120 BPM quarter notes = 2 Hz');
  const before = L.anchorPhase + L.hz * (1.5 - L.anchorT);
  c.handle({ t: 'tempo', bpm: 60, at: 1.5 });
  assert.equal(L.hz, 1);
  assert.ok(Math.abs(L.anchorPhase + L.hz * (1.5 - L.anchorT) - before) < 1e-12);
});

test('LFO phase: a data-driven rate integrates continuously per sub-block', () => {
  const { c } = core();
  c.handle({ t: 'lfos', seed: 7, lfos: [{ id: 'lfo0', index: 0, shape: 'sine', rate: { data: 'dat0', min: 1, max: 3 }, phase: 0, smooth: 0, anchorT: 0, anchorPhase: 0, hz: 2 }] });
  c.handle({ t: 'modValue', id: 'dat0', value: 0, smoothMs: 0, snap: true });   // 2 Hz
  render(c, 375);   // 1 s
  const L = c.lfos[0];
  assert.ok(Math.abs(L.anchorPhase - 2 * (1 - SUB_BLOCK / FS)) < 1e-9, `${L.anchorPhase}`);
  c.handle({ t: 'modValue', id: 'dat0', value: 1, smoothMs: 0, snap: true });   // 3 Hz
  const p0 = L.anchorPhase;
  render(c, 375, () => 0, 48000);
  assert.ok(Math.abs(L.anchorPhase - p0 - 3) < 0.01, 'one second at 3 Hz adds 3 cycles');
});

test('random LFO values come from hash32(seed, index, cycle) and agree across chains', () => {
  const a = core();
  const b = core();
  for (const { c } of [a, b]) {
    c.handle({ t: 'slots', slots: [slot('f0', 'filter', { cutoff: 1000 })] });
    c.handle({ t: 'lfos', seed: 7, lfos: [{ id: 'lfo0', index: 3, shape: 'random', rate: 4, phase: 0, smooth: 0, anchorT: 0, anchorPhase: 0, hz: 4 }] });
    c.handle({ t: 'mods', routes: [{ slot: 'f0', name: 'cutoff', source: 'lfo0', depth: 0.2 }] });
  }
  render(a.c, 400);                 // a runs from t = 0
  render(b.c, 4, () => 0, 300 * Q); // b starts later: same value at the same frame
  assert.equal(a.c.lfoVal[0], stepValue(7, 3, Math.floor(4 * ((399 * Q + 96) / FS))));
  assert.equal(b.c.lfoVal[0], stepValue(7, 3, Math.floor(4 * ((303 * Q + 96) / FS))));
});

test('public/worklets/fx-chain.js is up to date and registers a working fx-chain processor', () => {
  execFileSync(process.execPath, ['scripts/build-worklets.mjs', '--check'], { cwd: new URL('../..', import.meta.url) });
  const code = readFileSync(new URL('../../public/worklets/fx-chain.js', import.meta.url), 'utf8');
  assert.ok(!/^\s*(import|export)\s/m.test(code), 'no module statements');
  const registered = {};
  class AudioWorkletProcessor {
    constructor() { this.port = { posted: [], postMessage(m) { this.posted.push(m); }, onmessage: null }; }
  }
  const sandbox = { sampleRate: FS, currentFrame: 0, AudioWorkletProcessor, registerProcessor: (n, C) => { registered[n] = C; }, Float32Array, Float64Array, Int32Array, Math, Map, Set, JSON, Object, Array, Number, String, Error, TypeError };
  vm.runInNewContext(code, sandbox);
  assert.ok(registered['fx-chain']);
  const p = new registered['fx-chain']({ processorOptions: { seed: 1, chainIndex: 0 } });
  p.port.onmessage({ data: { t: 'slots', slots: [slot('f0', 'compressor')] } });
  const inp = new Float32Array(Q).fill(0.25);
  const out = [new Float32Array(Q), new Float32Array(Q)];
  assert.equal(p.process([[inp, inp]], [out], {}), true);
  assert.ok(out[0].every(Number.isFinite) && out[0].some((x) => x !== 0));
  p.port.onmessage({ data: { t: 'ping', id: 9 } });
  assert.equal(JSON.stringify(p.port.posted.at(-1)), JSON.stringify({ t: 'pong', id: 9 }));
});
