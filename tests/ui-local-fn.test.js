import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLocalFn } from '../src/ui/local-fn.js';

const tick = () => new Promise((r) => setImmediate(r));

test('the first read returns null; the result applies when it returns', async () => {
  const calls = [];
  let results = 0;
  const local = createLocalFn({ evalFn: async (src, arg) => { calls.push([src, arg?.fields.x]); return arg.fields.x * 2; }, onResult: () => results++ });
  const obj = { id: 'g:a', group: 'g', source: 'g', fields: { x: 2 } };
  assert.equal(local(['o => o.fields.x * 2'], obj), null);
  assert.equal(local(['o => o.fields.x * 2'], obj), null, 'no second evaluation while pending');
  await tick();
  assert.equal(local(['o => o.fields.x * 2'], obj), 4);
  assert.equal(calls.length, 1);
  assert.equal(results, 1);
  local(['o => o.fields.x * 2'], { ...obj, fields: { x: 5 } });
  await tick();
  assert.equal(local(['o => o.fields.x * 2'], { ...obj, fields: { x: 5 } }), 10);
  assert.equal(calls.length, 2, 're-evaluated after the fields changed');
});

test('non-finite numbers and objects become null; errors give null', async () => {
  const values = [Infinity, { a: 1 }, 'text', true];
  const local = createLocalFn({ evalFn: async () => values.shift() });
  const out = [];
  for (let i = 0; i < 4; i++) {
    const obj = { id: `g:${i}`, group: 'g', source: 'g', fields: {} };
    local(['f'], obj);
    await tick();
    out.push(local(['f'], obj));
  }
  assert.deepEqual(out, [null, null, 'text', true]);
  const failing = createLocalFn({ evalFn: async () => { throw new Error('x'); } });
  failing(['f'], null);
  await tick();
  assert.equal(failing(['f'], null), null);
  assert.equal(failing([42], null), null, 'a non-string source is ignored');
});

test('a null object is evaluated once', async () => {
  let n = 0;
  const local = createLocalFn({ evalFn: async () => { n++; return 1; } });
  local(['f'], null);
  await tick();
  local(['f'], null);
  local(['f'], null);
  assert.equal(n, 1);
});
