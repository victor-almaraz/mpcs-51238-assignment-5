// Builder API: IR produced by scripts, ids, defaults, coercion, object proxies and script lines
// (doc/piece-dsl.md, Builder API, Typed objects, IR).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build, codeBlocks, codes, defs } from './fixtures/dsl/load.js';
import { createBuilder } from '../src/dsl/builder.js';

const doc = readFileSync(new URL('../doc/piece-dsl.md', import.meta.url), 'utf8');

test('the example script in piece-dsl.md builds with no problems', () => {
  const r = build(codeBlocks(doc, 'ts')[0]);
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.ir.instruments.map((/** @type {any} */ i) => `${i.id}:${i.type}`),
    ['i0:additive', 'i1:subtractive', 'i2:granular', 'i3:fm', 'i4:pluck']);
  assert.deepEqual(r.ir.instruments[0].fx.map((/** @type {any} */ f) => f.id), ['f1', 'f0']);
  assert.deepEqual(r.ir.master.fx.map((/** @type {any} */ f) => `${f.id}:${f.type}`), ['f3:eq3', 'f4:compressor']);
  assert.deepEqual(r.ir.groups, ['celestrak.cosmos-2251-debris', 'celestrak.stations', 'jpl.cad', 'jpl.scout', 'll2.upcoming', 'swpc.kp', 'swpc.mag', 'swpc.wind']);
  assert.equal(r.ir.lfos[1].rate.min, 0.1);
  assert.equal(r.ir.lfos[1].rate.max, 3);
  assert.equal(r.ir.localOnly, false);
});

test('the orbit example in piece-dsl.md builds with no problems', () => {
  const block = codeBlocks(doc, 'ts').find((b) => b.includes("sky.orbit('celestrak.stations:25544', 'sunlit')"));
  assert.ok(block);
  assert.deepEqual(build(block).problems, []);
});

test('defaults of an empty script', () => {
  const { ir, problems } = build('');
  assert.deepEqual(problems, []);
  assert.deepEqual(ir, {
    irVersion: 1, seed: 1, tempo: 120, scale: { root: 'C', mode: 'chromatic' },
    instruments: [], master: { fx: [] }, lfos: [], mods: [], bindings: [], reactions: [],
    view: { projection: 'orbital', background: '#000000' }, layers: [], groups: [], localOnly: false,
  });
});

test('ids follow creation order and survive unrelated edits', () => {
  const a = build(`const x = additive({}); const y = fm({}); const d = delay({}); x.fx(d); x.attack.follow(1); y.ratio.follow(2);`).ir;
  assert.deepEqual(a.instruments.map((/** @type {any} */ i) => i.id), ['i0', 'i1']);
  assert.deepEqual(a.bindings.map((/** @type {any} */ b) => `${b.id}:${b.inst}.${b.param}`), ['b0:i0.attack', 'b1:i1.ratio']);
  const b = build(`const x = additive({ attack: 0.5 }); const y = fm({}); const d = delay({ mix: 0.2 }); x.fx(d); x.attack.follow(1); y.ratio.follow(2);`).ir;
  assert.deepEqual(b.instruments.map((/** @type {any} */ i) => i.id), ['i0', 'i1']);
  assert.equal(b.instruments[0].fx[0].id, 'f0');
});

test('numeric options clamp to their range; volume, octave and cents are tuning fields', () => {
  const { ir, problems } = build(`subtractive({ volume: -90, octave: 7, cents: 300, cutoff: 1e9, resonance: -4 });`);
  assert.deepEqual(problems, []);
  const i = ir.instruments[0];
  assert.deepEqual([i.volumeDb, i.octave, i.cents], [-60, 3, 100]);
  assert.deepEqual(i.params, { cutoff: 16000, resonance: 0 });
});

test('instrument choices stay names; effect choices become indices', () => {
  const { ir } = build(`const s = subtractive({ waveform: 'square' }); s.fx(filter({ mode: 'highpass' }), delay({ sync: '1/4d' }));`);
  assert.equal(ir.instruments[0].params.waveform, 'square');
  assert.equal(ir.instruments[0].fx[0].params.mode, 1);
  assert.equal(ir.instruments[0].fx[1].params.sync, defs.effects.delay.params.sync.options?.indexOf('1/4d'));
});

test('harmonics coerce to eight values in range', () => {
  const { ir } = build(`additive({ harmonics: [2, 0.5, -1] });`);
  assert.deepEqual(ir.instruments[0].params.harmonics, [1, 0.5, 0, 0, 0, 0, 0, 0]);
});

test('wrong value kinds are runtime errors naming the option and line', () => {
  let r = build(`\nsubtractive({ waveform: 'noise' });`);
  assert.equal(r.ir, null);
  assert.equal(r.problems[0].code, 'runtime_error');
  assert.equal(r.problems[0].line, 2);
  assert.match(r.problems[0].message, /waveform must be one of/);
  r = build(`additive({ attack: 'slow' });`);
  assert.match(r.problems[0].message, /attack must be a finite number/);
  r = build(`scale('H', 'major');`);
  assert.match(r.problems[0].message, /root/);
  r = build(`const a = additive({}); a.attack.mod(lfo(), {});`);
  assert.match(r.problems[0].message, /depth is required/);
});

test('trigger, voice and follow defaults', () => {
  const { ir } = build(`const a = fm({}); sky.group('jpl.scout').on('enter').trigger(a, { pitch: 300 });
sky.group('celestrak.stations').voices(a, { pitch: 60 }); a.index.follow(3);`);
  assert.deepEqual(ir.bindings[0], {
    id: 'b0', kind: 'trigger', inst: 'i0', group: 'jpl.scout', select: null, event: 'enter', when: null,
    pitch: 127, velocity: 100, durationMs: 250, maxPerSecond: 2,
  });
  assert.deepEqual(ir.bindings[1], {
    id: 'b1', kind: 'voices', inst: 'i0', group: 'celestrak.stations', select: null, pitch: 60, velocity: 100, pan: 0, voiceMods: {},
  });
  assert.deepEqual(ir.bindings[2], { id: 'b2', kind: 'param', inst: 'i0', param: 'index', expr: 3, smoothMs: 250 });
});

test('effect follow and bypass bindings', () => {
  const { ir, problems } = build(`const p = pluck({}); const g = distortion({ bypass: true }); p.fx(g);
g.drive.follow(sky.swpc('kp.kp').map(0, 9, 0, 24), { smoothMs: 1000 }); g.bypass.follow(sky.swpc('kp.kp').lt(5));`);
  assert.deepEqual(problems, []);
  assert.equal(ir.instruments[0].fx[0].bypass, true);
  assert.deepEqual(ir.bindings[0].kind, 'fxParam');
  assert.equal(ir.bindings[0].slot, 'f0');
  assert.deepEqual(ir.bindings[1], { id: 'b1', kind: 'fxBypass', slot: 'f0', expr: { op: 'lt', args: [{ op: 'swpc', args: ['kp.kp'] }, 5] } });
});

test('expression nodes match the IR schema', () => {
  const { ir } = build(`const a = additive({}); sky.group('jpl.cad').top(6, 'distLD', 'asc').voices(a, {
  pitch: field('vRel').map(5, 30, 36, 60).quantize(),
  velocity: field('distLD').map(0.5, 10, 100, 20, 'log').add(num(1)).round(),
});`);
  const b = ir.bindings[0];
  assert.deepEqual(b.select, { top: 6, by: 'distLD', order: 'asc' });
  assert.deepEqual(b.pitch, { op: 'quantize', args: [{ op: 'map', args: [{ op: 'field', args: ['vRel'] }, 5, 30, 36, 60, 'lin'] }] });
  assert.deepEqual(b.velocity.op, 'round');
  assert.deepEqual(b.velocity.args[0].args[1], { op: 'num', args: [1] });
});

test('modulation routes: LFO and data sources, default smoothing for orbits', () => {
  const { ir, problems } = build(`const a = subtractive({}); const l = lfo({ shape: 'smooth', rate: '1/8t' });
a.cutoff.mod(l, { depth: 2 }); a.resonance.mod(sky.orbit('celestrak.stations:25544', 'sunlit'), { depth: -0.2 });`);
  assert.deepEqual(problems, []);
  assert.deepEqual(ir.lfos[0], { id: 'lfo0', shape: 'smooth', rate: { sync: '1/8t' }, phase: 0, retrigger: false, smooth: 0.5 });
  assert.deepEqual(ir.mods[0], { target: 'i0.cutoff', source: { lfo: 'lfo0' }, depth: 1, smoothMs: 250 });
  assert.equal(ir.mods[1].smoothMs, 500);
  assert.deepEqual(ir.mods[1].source.expr, { op: 'orbit', args: ['sunlit', 'celestrak.stations:25544', 1] });
});

test('reactions, view and layers', () => {
  const { ir, problems } = build(`const a = additive({}); onStale('*', { detuneCents: 250, desaturate: 0.5 }); onDown('swpc.wind', { mute: [a] });
view.projection('map'); view.background(color('#05070c').mix('#1a0f2e', sky.swpc('kp.kp').map(0, 9, 0, 1)));
layer.field({ value: 0.5 }); layer.glyph(sky.group('ll2.upcoming'), { char: '^' });`);
  assert.deepEqual(problems, []);
  assert.deepEqual(ir.reactions, [
    { on: 'stale', source: '*', actions: { detuneCents: 100, desaturate: 0.5 } },
    { on: 'down', source: 'swpc.wind', actions: { mute: ['i0'] } },
  ]);
  assert.equal(ir.view.projection, 'map');
  assert.equal(ir.view.background.op, 'mix');
  assert.deepEqual(ir.layers[0], { id: 'l0', type: 'field', group: null, select: null, props: { value: 0.5, opacity: 1, colormap: 'night' } });
  assert.equal(ir.layers[1].props.char, '^');
  assert.equal(ir.layers[1].props.size, 12);
});

test('fn and layer.shader mark the piece local-only', () => {
  let r = build(`const a = additive({}); a.attack.follow(fn('o => 1'));`);
  assert.equal(r.ir.localOnly, true);
  assert.deepEqual(codes(r), ['local_only /localOnly']);
  assert.equal(r.problems[0].severity, 'warning');
  r = build(`layer.shader('void main() {}', { speed: 2 });`);
  assert.equal(r.ir.localOnly, true);
  assert.deepEqual(r.ir.layers[0], { id: 'l0', type: 'shader', group: null, select: null, glsl: 'void main() {}', props: { speed: 2, opacity: 1 } });
});

test('object proxies build the same IR as field() and orbit()', () => {
  const viaProxy = build(`const a = additive({}); sky.group('celestrak.stations').voices(a, (o) => ({
  pitch: o.meanMotion.octaveInto(110, 440), pan: o.orbit('phaseCos', { timeScale: 60 }) }));`).ir;
  const viaField = build(`const a = additive({}); sky.group('celestrak.stations').voices(a, {
  pitch: field('meanMotion').octaveInto(110, 440), pan: orbit('phaseCos', { timeScale: 60 }) });`).ir;
  assert.deepEqual(viaProxy, viaField);
  const when = build(`const a = pluck({}); sky.group('ll2.upcoming').on('update').when((o) => o.status.eq('In Flight')).trigger(a, { pitch: 38 });`).ir;
  assert.deepEqual(when.bindings[0].when, { op: 'eq', args: [{ op: 'field', args: ['status'] }, 'In Flight'] });
});

test('o.orbit exists only on celestrak proxies', () => {
  const r = build(`const a = fm({}); sky.group('jpl.cad').voices(a, (o) => ({ pitch: 60, pan: o.orbit('latitude') }));`);
  assert.equal(r.problems[0].code, 'runtime_error');
});

test('an unknown proxy property builds field(name) and warns unknown_field', () => {
  const r = build(`const a = fm({}); sky.group('jpl.cad').voices(a, (o) => ({ pitch: o.vRell }));`);
  assert.deepEqual(r.ir.bindings[0].pitch, { op: 'field', args: ['vRell'] });
  assert.deepEqual(codes(r), ['unknown_field /bindings/0/pitch/args/0']);
});

test('a builder function runs exactly once per build', () => {
  const { api, finish } = createBuilder(defs);
  let calls = 0;
  const a = /** @type {any} */ (api).additive({});
  /** @type {any} */ (api).sky.group('celestrak.stations').voices(a, (/** @type {any} */ o) => { calls++; return { pitch: o.meanMotion }; });
  /** @type {any} */ (api).layer.points(/** @type {any} */ (api).sky.group('celestrak.stations'), () => { calls++; return { size: 3 }; });
  /** @type {any} */ (api).sky.group('jpl.scout').on('enter').when(() => { calls++; return true; }).trigger(a, () => { calls++; return { pitch: 70 }; });
  finish();
  assert.equal(calls, 4);
});

test('problems carry script lines, through TypeScript annotations', () => {
  const r = build(`interface Opts { volume: number }
const opts: Opts = { volume: -12 };

const pad = additive(opts);
const neo = subtractive({ cutoff: 200 });
pad.cutoff.follow(500);
neo.waveform.mod(lfo(), { depth: 0.1 } as const);
`);
  assert.deepEqual(r.problems.map((p) => [p.code, p.path, p.line]), [
    ['not_modulatable', '/mods/0/target', 7],
    ['unknown_option', '/bindings/0/param', 6],
  ]);
});

test('a slot problem points at its constructor, a chain problem at the fx() call', () => {
  const r = build(`const a = additive({});
const b = fm({});
const d = delay({ tim: 4 });
a.fx(d);
b.fx(d);`);
  assert.deepEqual(r.problems.map((p) => [p.code, p.path, p.line]), [
    ['unknown_option', '/instruments/0/fx/0/params/tim', 3],
    ['slot_reused', '/instruments/1/fx/0', 5],
  ]);
});

test('a second fx() call replaces the chain', () => {
  const { ir, problems } = build(`const a = additive({}); const d = delay({}); const r = reverb({}); a.fx(d, r); a.fx(r);`);
  assert.deepEqual(problems, []);
  assert.deepEqual(ir.instruments[0].fx.map((/** @type {any} */ f) => f.id), ['f1']);
});

test('the script cannot reach network globals or the worker scope', () => {
  for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'self', 'globalThis', 'postMessage', 'importScripts']) {
    const r = build(`if (typeof ${name} !== 'undefined') throw new Error('${name} is reachable');`);
    assert.deepEqual(r.problems, [], name);
  }
});
