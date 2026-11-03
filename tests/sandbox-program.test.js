// Sandbox program messages (doc/piece-dsl.md, VM) with a fake worker: a start reaches a new worker
// only after the last good build, and a start has the build's time limit.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSandbox } from '../src/dsl/run-sandbox.js';

/** Fake workers that answer builds and program messages; `delay` per op, or `hang` to never answer. */
function fakeWorkers() {
  const workers = [];
  const create = () => {
    const w = {
      onmessage: null, onerror: null, log: [], delay: {}, terminated: false,
      postMessage(m) {
        const kind = m.program ? m.program.op : 'build';
        w.log.push(kind);
        const ms = w.delay[kind] ?? 0;
        if (ms === Infinity) return;
        setTimeout(() => {
          if (w.terminated) return;
          if (m.program) w.onmessage({ data: { program: { id: m.program.id, commands: [], errors: [], dropped: 0 } } });
          else w.onmessage({ data: { ir: { source: m.source }, problems: [] } });
        }, ms);
      },
      terminate() { w.terminated = true; },
    };
    setTimeout(() => w.onmessage({ data: { ready: true } }), 0);
    workers.push(w);
    return w;
  };
  return { workers, create };
}

test('after a worker is reset, a start rebuilds the last good build in the new worker first', async () => {
  const f = fakeWorkers();
  const sb = createSandbox({ createWorker: f.create, timeoutMs: 200, programTimeoutMs: 20 });
  const b = await sb.build('piece()', { defs: 1 });
  assert.deepEqual(b.ir, { source: 'piece()' });
  assert.equal((await sb.program({ op: 'start' })).errors.length, 0);
  f.workers[0].delay.batch = Infinity;
  assert.deepEqual(await sb.program({ op: 'batch', now: 25 }), { timeout: true });
  assert.equal(f.workers[0].terminated, true);
  const again = await sb.program({ op: 'start' });
  assert.equal(again.errors.length, 0, JSON.stringify(again));
  assert.equal(f.workers.length, 2);
  assert.deepEqual(f.workers[1].log, ['build', 'start'], 'the new worker gets the build, then the start');
  sb.dispose();
});

test('a start waits as long as a build; a batch has the shorter limit', async () => {
  const f = fakeWorkers();
  const sb = createSandbox({ createWorker: f.create, timeoutMs: 200, programTimeoutMs: 20 });
  await sb.build('piece()', {});
  f.workers[0].delay.start = 60;
  assert.equal((await sb.program({ op: 'start' })).errors.length, 0, 'a 60 ms start is within the 200 ms build limit');
  f.workers[0].delay.batch = 60;
  assert.deepEqual(await sb.program({ op: 'batch', now: 25 }), { timeout: true }, 'a 60 ms batch is past the 20 ms limit');
  sb.dispose();
});

test('without a good build, a batch on no worker reports a lost VM', async () => {
  const f = fakeWorkers();
  const sb = createSandbox({ createWorker: f.create, timeoutMs: 200, programTimeoutMs: 20 });
  const r = await sb.program({ op: 'batch', now: 1 });
  assert.equal(r.errors[0].handler, 'vm');
  assert.equal(f.workers.length, 0);
});
