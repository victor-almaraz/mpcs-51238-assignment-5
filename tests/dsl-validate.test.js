// IR validator: the valid example passes; each limit, reference and context rule produces its
// code and JSON Pointer (doc/piece-dsl.md, Validation; doc/testing.md, IR validator,
// IR: effects and modulation).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build, codeBlocks, codes, defs } from './fixtures/dsl/load.js';
import { validateIr } from '../src/dsl/validate.js';
import { LIMITS } from '../src/dsl/limits.js';

const doc = readFileSync(new URL('../doc/piece-dsl.md', import.meta.url), 'utf8');
const example = () => JSON.parse(codeBlocks(doc, 'json')[1]);
/** @param {any} ir */
const v = (ir) => validateIr(ir, defs).map((p) => `${p.code} ${p.path}`);
/** @param {string} s @param {number} n */
const times = (s, n) => Array.from({ length: n }, (_, i) => s.replaceAll('$i', String(i))).join('\n');

test('the IR document in piece-dsl.md is valid', () => {
  assert.deepEqual(v(example()), []);
});

test('schema errors carry pointers', () => {
  const ir = example();
  delete ir.bindings[1].event;
  ir.layers[0].extra = 1;
  assert.deepEqual(v(ir), ['ir_schema /bindings/1/event', 'ir_schema /layers/0/extra']);
  assert.deepEqual(v([]), ['ir_schema ']);
});

test('versions: newer is unsupported, older needs migration', () => {
  assert.deepEqual(v({ ...example(), irVersion: 2 }), ['ir_version_unsupported /irVersion']);
  assert.deepEqual(v({ ...example(), irVersion: 0 }), ['ir_schema /irVersion']);
});

test('range checks on a hand-made IR', () => {
  const ir = example();
  ir.tempo = 400;
  ir.bindings[1].maxPerSecond = 50;
  ir.bindings[1].durationMs = 5;
  ir.mods[0].depth = 2;
  ir.lfos[0].rate = 30;
  assert.deepEqual(v(ir), ['ir_schema /tempo', 'ir_schema /lfos/0/rate', 'ir_schema /mods/0/depth',
    'ir_schema /bindings/1/durationMs', 'ir_schema /bindings/1/maxPerSecond']);
});

test('limit_instruments, limit_bindings, limit_layers', () => {
  assert.deepEqual(codes(build(times('additive({});', LIMITS.instruments + 1))), [`limit_instruments /instruments/${LIMITS.instruments}`]);
  assert.deepEqual(codes(build(`const a = additive({});\n${times('a.attack.follow(1);', LIMITS.bindings + 1)}`)), [`limit_bindings /bindings/${LIMITS.bindings}`]);
  assert.deepEqual(codes(build(times('layer.aurora({});', LIMITS.layers + 1))), [`limit_layers /layers/${LIMITS.layers}`]);
});

test('limit_voices: top above 16, or 4 for granular', () => {
  assert.deepEqual(codes(build(`const a = additive({}); sky.group('celestrak.visual').top(17, 'meanMotion').voices(a, { pitch: 60 });`)),
    ['limit_voices /bindings/0/select/top']);
  assert.deepEqual(codes(build(`const a = granular({}); sky.group('celestrak.visual').top(5, 'meanMotion').voices(a, { pitch: 60 });`)),
    ['limit_voices /bindings/0/select/top']);
  assert.deepEqual(codes(build(`const a = granular({}); sky.group('celestrak.visual').top(4, 'meanMotion').voices(a, { pitch: 60 });`)), []);
});

test('limit_slots and limit_reverbs', () => {
  assert.deepEqual(codes(build(`const a = additive({}); a.fx(${times('eq3({})', LIMITS.slotsPerChain + 1).replaceAll('\n', ', ')});`)),
    [`limit_slots /instruments/0/fx/${LIMITS.slotsPerChain}`]);
  assert.deepEqual(codes(build(`const a = additive({}); a.fx(reverb({}), reverb({}), reverb({})); master.fx(reverb({}), reverb({}));`)),
    ['limit_reverbs /master/fx/1']);
});

test('limit_lfos, limit_routes, limit_routes_per_target, limit_retrigger_lfos', () => {
  assert.deepEqual(codes(build(times('lfo({});', LIMITS.lfos + 1))), [`limit_lfos /lfos/${LIMITS.lfos}`]);
  const params = ['cutoff', 'resonance', 'envAmount', 'attack', 'decay', 'sustain', 'release'];
  const routes = Array.from({ length: LIMITS.routes + 1 }, (_, i) => `s${Math.floor(i / 4)}.${params[i % 4]}.mod(l, { depth: 0.1 });`).join('\n');
  const insts = times('const s$i = subtractive({});', 9);
  assert.deepEqual(codes(build(`const l = lfo({});\n${insts}\n${routes}`)), [`limit_routes /mods/${LIMITS.routes}`]);
  assert.deepEqual(codes(build(`const l = lfo({}); const s = subtractive({});\n${times('s.cutoff.mod(l, { depth: 0.1 });', LIMITS.routesPerTarget + 1)}`)),
    [`limit_routes_per_target /mods/${LIMITS.routesPerTarget}`]);
  assert.deepEqual(codes(build(`const s = subtractive({});
s.cutoff.mod(lfo({ retrigger: true }), { depth: 0.1 });
s.resonance.mod(lfo({ retrigger: true }), { depth: 0.1 });
s.attack.mod(lfo({ retrigger: true }), { depth: 0.1 });`)), ['limit_retrigger_lfos /mods/2']);
});

test('limit_orbit_sources counts distinct (object, quantity, timeScale)', () => {
  const lines = Array.from({ length: LIMITS.orbitSources + 1 }, (_, i) => `a.attack.follow(sky.orbit('celestrak.stations:${i}', 'latitude').map(-1, 1, 0.1, 1));`);
  const r = build(`const a = additive({});\n${lines.join('\n')}`);
  assert.ok(codes(r).includes(`limit_orbit_sources /bindings/${LIMITS.orbitSources}/expr/args/0`), codes(r).join());
  assert.ok(!codes(build(`const a = additive({});\n${lines.slice(0, 3).join('\n')}\n${lines[0]}`)).some((c) => c.startsWith('limit_orbit')));
});

test('limit_source and ir_too_large', () => {
  assert.deepEqual(codes(build(' '.repeat(LIMITS.sourceChars + 1))), ['limit_source ']);
  const ir = example();
  ir.layers[0].props.char = 'x';
  ir.layers.push({ id: 'l1', type: 'shader', group: null, select: null, glsl: 'x'.repeat(LIMITS.irBytes), props: {} });
  ir.localOnly = true;
  assert.ok(v(ir).includes('ir_too_large '));
});

test('unknown options on instruments, effects, targets and layers', () => {
  const r = build(`const a = additive({ cutof: 1 }); const d = delay({ tim: 1 }); a.fx(d);
a.cutoff.mod(lfo({}), { depth: 0.1 }); d.size.follow(1); layer.points(sky.group('celestrak.stations'), { glow: 1 });`);
  assert.deepEqual(codes(r), ['unknown_option /instruments/0/params/cutof', 'unknown_option /instruments/0/fx/0/params/tim',
    'unknown_option /mods/0/target', 'unknown_option /bindings/0/param', 'unknown_option /layers/0/props/glow']);
});

test('not_numeric and not_modulatable', () => {
  const r = build(`const a = additive({}); const s = subtractive({}); const f = filter({}); s.fx(f);
a.harmonics.follow(1); a.harmonics.mod(lfo({}), { depth: 0.1 });
s.waveform.follow(2); s.waveform.mod(lfo({}), { depth: 0.1 });
f.mode.mod(lfo({}), { depth: 0.1 }); f.mode.follow(1);`);
  assert.deepEqual(codes(r), ['not_modulatable /mods/0/target', 'not_modulatable /mods/1/target', 'not_modulatable /mods/2/target',
    'not_numeric /bindings/0/param']);
});

test('lower-only effect parameters accept modulation', () => {
  assert.deepEqual(codes(build(`const c = compressor({}); master.fx(c); c.makeup.mod(lfo({}), { depth: 0.2 });`)), []);
});

test('granular_sample', () => {
  assert.deepEqual(codes(build(`granular({ source: 'sample' });`)), ['granular_sample /instruments/0/params/source']);
});

test('slot_reused and slot_unplaced', () => {
  assert.deepEqual(codes(build(`const d = delay({}); const a = additive({}); a.fx(d); master.fx(d);`)), ['slot_reused /master/fx/0']);
  assert.deepEqual(codes(build(`const a = additive({}); a.fx(delay({}), delay({}));`)), []);
  assert.deepEqual(codes(build(`const d = delay({}); d.mix.follow(0.5); d.time.mod(lfo({}), { depth: 0.1 }); d.bypass.follow(true);`)),
    ['slot_unplaced /mods/0/target', 'slot_unplaced /bindings/0/param', 'slot_unplaced /bindings/1/slot']);
});

test('lfo_rate_range: an expression rate must end in map or clamp', () => {
  assert.deepEqual(codes(build(`const a = additive({}); a.attack.mod(lfo({ rate: sky.swpc('wind.speed').div(100) }), { depth: 0.1 });`)),
    ['lfo_rate_range /lfos/0/rate/expr']);
  const ok = build(`const a = additive({}); a.attack.mod(lfo({ rate: sky.swpc('wind.speed').clamp(0, 50) }), { depth: 0.1 });`);
  assert.deepEqual(codes(ok), []);
  assert.deepEqual([ok.ir.lfos[0].rate.min, ok.ir.lfos[0].rate.max], [0.01, 20]);
});

test('unknown_group and unknown_field', () => {
  const r = build(`const a = additive({});
sky.group('celestrak.nope').voices(a, { pitch: 60 });
a.attack.follow(sky.swpc('kp.nope').add(sky.swpc('sun.x')).add(sky.group('jpl.cad').mean('speed')));
onStale('nowhere', { detuneCents: 5 });
sky.group('jpl.cad').top(3, 'size').voices(a, { pitch: field('vRell') });`);
  assert.deepEqual(codes(r), [
    'unknown_group /bindings/0/group', 'unknown_field /bindings/2/select/by', 'unknown_group /reactions/0/source',
    'unknown_field /bindings/1/expr/args/0/args/0/args/0', 'unknown_group /bindings/1/expr/args/0/args/1/args/0',
    'unknown_field /bindings/1/expr/args/1/args/1', 'unknown_field /bindings/2/pitch/args/0',
  ]);
  assert.equal(r.problems.find((p) => p.code === 'unknown_field')?.severity, 'warning');
});

test('unknown_field accepts fields present in the last snapshot', () => {
  const ir = build(`const a = additive({}); sky.group('jpl.cad').voices(a, { pitch: field('fullname') });`).ir;
  assert.deepEqual(validateIr(ir, defs, { snapshot: { 'jpl.cad': [{ fields: { fullname: 'x' } }] } }), []);
});

test('reactions accept registry ids, groups and *', () => {
  assert.deepEqual(codes(build(`onStale('swpc.wind', { detuneCents: 5 }); onDown('*', { desaturate: 1 }); onDown('celestrak.stations', {});`)), []);
});

test('audio_outside_layer and fn_in_layer', () => {
  const r = build(`const a = additive({});
a.attack.follow(audio.level(a));
layer.points(sky.group('celestrak.stations'), { size: fn('o => 3'), opacity: audio.level(a) });`);
  assert.deepEqual(codes(r), ['audio_outside_layer /bindings/0/expr', 'fn_in_layer /layers/0/props/size', 'local_only /localOnly']);
});

test('orbit rules: no object, no elements, quantity', () => {
  const r = build(`const a = additive({});
a.attack.follow(orbit('latitude').map(-1, 1, 0.1, 1));
sky.group('jpl.cad').voices(a, { pitch: 60, pan: orbit('latitude') });
a.decay.follow(sky.orbit('swpc.kp:planetary', 'latitude').map(-1, 1, 0.1, 1));
a.release.follow(sky.orbit('celestrak.stations:25544', 'spin').map(-1, 1, 0.1, 1));`);
  assert.deepEqual(codes(r), ['orbit_no_object /bindings/0/expr/args/0', 'orbit_no_elements /bindings/1/pan',
    'orbit_no_elements /bindings/2/expr/args/0', 'orbit_quantity /bindings/3/expr/args/0/args/0']);
});

test('expr_too_deep above 32 levels', () => {
  const deep = (/** @type {number} */ n) => `const a = additive({}); a.attack.follow(num(1)${'.add(1)'.repeat(n - 1)});`;
  assert.deepEqual(codes(build(deep(LIMITS.exprDepth))), []);
  assert.deepEqual(codes(build(deep(LIMITS.exprDepth + 1))), [`expr_too_deep /bindings/0/expr${'/args/0'.repeat(LIMITS.exprDepth)}`]);
  const r = build(`const a = additive({}); let e = num(1); for (let i = 0; i < 20000; i++) e = e.add(1); a.attack.follow(e);`);
  assert.equal(r.problems.length, 1);
  assert.equal(r.problems[0].code, 'expr_too_deep');
});

test('references: dangling ids and a groups list that does not match', () => {
  const ir = example();
  ir.bindings[0].inst = 'i9';
  ir.mods[0].source = { lfo: 'lfo7' };
  ir.reactions[1].actions.only = ['i3'];
  ir.groups = ['celestrak.stations', 'jpl.scout', 'll2.upcoming'];
  assert.deepEqual(v(ir), ['ir_reference /mods/0/source/lfo', 'ir_reference /bindings/0/inst', 'ir_reference /reactions/1/actions/only/0',
    'ir_reference /groups', 'ir_reference /groups/2']);
});

test('ops: unknown op, wrong argument count or kind', () => {
  const ir = example();
  ir.bindings[2].expr = { op: 'pow', args: [1, 2] };
  ir.bindings[0].pan = { op: 'map', args: [{ op: 'field', args: ['raan'] }, 0, 360, -1, 1] };
  ir.bindings[0].pitch = { op: 'clamp', args: [60, 'a', 2] };
  assert.deepEqual(v(ir), ['ir_schema /bindings/0/pitch/args/1', 'ir_schema /bindings/0/pan/args', 'ir_schema /bindings/2/expr/op']);
});

test('a local-only IR must say so', () => {
  const ir = example();
  ir.bindings[2].expr = { op: 'local', args: ['o => 1'] };
  assert.deepEqual(v(ir), ['ir_schema /localOnly', 'local_only /localOnly']);
});

test('prototype keys are not definitions', () => {
  const ir = example();
  ir.instruments[0].params = { constructor: 1, __proto__: 2 };
  ir.layers[0].type = 'toString';
  assert.deepEqual(v(ir), ['unknown_option /instruments/0/params/constructor', 'ir_schema /layers/0/type']);
});
