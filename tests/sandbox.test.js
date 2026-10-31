// Sandbox worker (doc/piece-dsl.md, Sandbox): public/dsl-sandbox.js runs in a Node worker thread
// behind the Web Worker interface. Requires a current bundle (node scripts/build-sandbox.mjs).

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defs } from './fixtures/dsl/load.js';
import { nodeSandboxWorker } from './fixtures/dsl/node-worker.js';
import { createSandbox } from '../src/dsl/run-sandbox.js';

const sandbox = createSandbox({ createWorker: nodeSandboxWorker });
after(() => sandbox.dispose());

test('public/dsl-sandbox.js matches a fresh bundle', () => {
  const script = fileURLToPath(new URL('../scripts/build-sandbox.mjs', import.meta.url));
  execFileSync(process.execPath, [script, '--check'], { stdio: 'pipe' });
});

test('a script builds to { ir, problems }', async () => {
  const r = await sandbox.build(`const pad = additive({ volume: -12 });
sky.group('celestrak.stations').voices(pad, { pitch: field('meanMotion').octaveInto(110, 440) });`, defs);
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.ir.groups, ['celestrak.stations']);
});

test('type annotations are removed and problem lines match the TypeScript source', async () => {
  const r = await sandbox.build(`type Hz = number;
interface Opts { volume: number }
const cutoff: Hz = 800;
const opts: Opts = { volume: -12 };
const pad = additive(opts as Opts);
pad.cutoff.follow(cutoff);`, defs);
  assert.deepEqual(r.problems.map((p) => [p.code, p.line]), [['unknown_option', 6]]);
  const err = await sandbox.build(`const a: number = 1;\n\nconst b: string = missing();`, defs);
  assert.deepEqual(err.problems.map((p) => [p.code, p.line]), [['runtime_error', 3]]);
});

test('a parse error is syntax_error with its line', async () => {
  const r = await sandbox.build(`const a = 1;\nconst b = (;`, defs);
  assert.deepEqual(r.problems.map((p) => [p.code, p.line]), [['syntax_error', 2]]);
  assert.equal(r.ir, null);
});

test('a script that calls fetch fails', async () => {
  const r = await sandbox.build(`fetch('https://example.com/');`, defs);
  assert.equal(r.problems[0].code, 'runtime_error');
  const g = await sandbox.build(`(0, eval)('this').fetch('https://example.com/');`, defs);
  assert.equal(g.problems[0].code, 'runtime_error');
});

test('the worker removes network globals before running scripts', async () => {
  const w = nodeSandboxWorker();
  try {
    await new Promise((r) => setTimeout(r, 300));
    const types = await w.probe(['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts', 'indexedDB']);
    assert.deepEqual(types, ['undefined', 'undefined', 'undefined', 'undefined', 'undefined', 'undefined']);
  } finally {
    w.terminate();
  }
});

test('a script with while (true) {} returns timeout, and the next build works', async () => {
  const fast = createSandbox({ createWorker: nodeSandboxWorker, timeoutMs: 1500 });
  try {
    const t0 = Date.now();
    const r = await fast.build('while (true) {}', defs);
    assert.deepEqual(r.problems.map((p) => p.code), ['timeout']);
    assert.ok(Date.now() - t0 < 3000);
    const next = await fast.build('tempo(90);', defs);
    assert.equal(next.ir.tempo, 90);
  } finally {
    fast.dispose();
  }
});

test('fn evaluation for local-only pieces', async () => {
  assert.equal(await sandbox.evalFn('o => o.fields.inclination / 2', { fields: { inclination: 51.6 } }), 25.8);
  assert.equal(await sandbox.evalFn('o => { throw new Error("x") }', {}), null);
  assert.equal(await sandbox.evalFn('o => ({})', {}), null);
});

test('the build timeout starts when the worker is ready, not when it is created', async () => {
  let handler = null;
  const posted = [];
  const slowStart = () => ({
    postMessage: (m) => { posted.push(m); setTimeout(() => handler?.({ data: { ir: { ok: true }, problems: [] } }), 5); },
    terminate() {}, onerror: null,
    get onmessage() { return handler; }, set onmessage(fn) { handler = fn; setTimeout(() => fn({ data: { ready: true } }), 60); },
  });
  const sb = createSandbox({ createWorker: slowStart, timeoutMs: 30 });
  const r = await sb.build('x', {});
  assert.deepEqual(r.problems, [], 'a 60 ms start does not count against a 30 ms run limit');
  assert.equal(posted.length, 1);
  const never = () => ({ postMessage() {}, terminate() {}, onerror: null, onmessage: null });
  const r2 = await createSandbox({ createWorker: never, timeoutMs: 30, startupMs: 50 }).build('x', {});
  assert.deepEqual(r2.problems.map((p) => p.code), ['runtime_error']);
  assert.match(r2.problems[0].message, /did not start/);
});
