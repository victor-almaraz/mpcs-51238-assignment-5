import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFakeSky, skyObj } from './fakes.js';
import { createNullSky, createSkySwitch } from '../src/ui/sky-switch.js';

function fakeStore() {
  const s = createFakeSky();
  const base = s.on;
  // The fake has no '*'; add it the way the real core does.
  const star = new Set();
  s.on = (type, fn) => {
    if (type === '*') { star.add(fn); return () => star.delete(fn); }
    return base(type, fn);
  };
  for (const t of ['enter', 'update', 'exit', 'freshness']) base(t, (e) => { for (const fn of star) fn(e); });
  s.follow = async (g) => { s._followed = [...g]; };
  s.followed = () => s._followed ?? [];
  s.closed = false;
  s.close = () => { s.closed = true; };
  s.sources = () => [];
  s.object = (id) => s.get(id.slice(0, id.indexOf(':'))).find((o) => o.id === id) ?? null;
  return s;
}

test('the switch forwards events by type and to *', () => {
  const a = fakeStore();
  const sw = createSkySwitch(a, { uuid: () => 'u' });
  const seen = [];
  sw.on('enter', (e) => seen.push(['enter', e.obj.id]));
  sw.on('*', (e) => seen.push(['*', e.type]));
  a.enter(skyObj('swpc.kp', 'now', { kp: 3 }));
  assert.deepEqual(seen, [['enter', 'swpc.kp:now'], ['*', 'enter']]);
  assert.equal(sw.get('swpc.kp').length, 1);
});

test('use() exits held objects, then follows the same groups on the new store', async () => {
  const a = fakeStore();
  const b = fakeStore();
  const sw = createSkySwitch(a, { uuid: () => 'u1' });
  await sw.follow(['swpc.kp']);
  a.enter(skyObj('swpc.kp', 'now', { kp: 3 }));
  const seen = [];
  sw.on('*', (e) => seen.push([e.type, e.obj?.id, e.traceId]));
  await sw.use(b);
  assert.deepEqual(seen, [['exit', 'swpc.kp:now', 'switch-u1']]);
  assert.deepEqual(b.followed(), ['swpc.kp']);
  assert.equal(sw.current, b);
  a.enter(skyObj('swpc.kp', 'later', { kp: 5 }));
  assert.equal(seen.length, 1, 'the old store is detached');
  b.enter(skyObj('swpc.kp', 'b', { kp: 1 }));
  assert.equal(seen.length, 2);
});

test('a listener that throws does not stop the others', () => {
  const a = fakeStore();
  const errors = [];
  const sw = createSkySwitch(a, { onError: (err) => errors.push(err.message) });
  let n = 0;
  sw.on('enter', () => { throw new Error('boom'); });
  sw.on('enter', () => { n++; });
  a.enter(skyObj('swpc.kp', 'now', { kp: 3 }));
  assert.equal(n, 1);
  assert.deepEqual(errors, ['boom']);
});

test('close closes the current store and drops listeners', () => {
  const a = fakeStore();
  const sw = createSkySwitch(a);
  let n = 0;
  sw.on('enter', () => n++);
  sw.close();
  assert.equal(a.closed, true);
  a.enter(skyObj('swpc.kp', 'now', { kp: 3 }));
  assert.equal(n, 0);
});

test('the null sky follows without objects', async () => {
  const s = createNullSky();
  await s.follow(['swpc.kp', 'swpc.kp']);
  assert.deepEqual(s.followed(), ['swpc.kp']);
  assert.deepEqual(s.get('swpc.kp'), []);
  assert.deepEqual(s.sources(), []);
  assert.equal(s.freshness('swpc.kp').state, 'loading');
  const off = s.on('*', () => {});
  off();
});
