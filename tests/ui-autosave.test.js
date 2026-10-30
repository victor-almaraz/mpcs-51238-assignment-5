import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAutosave } from '../src/ui/autosave.js';

function fakeTimers() {
  let t = 0;
  let id = 0;
  const pending = new Map();
  return {
    setTimeout(fn, ms) { pending.set(++id, { at: t + ms, fn }); return id; },
    clearTimeout(i) { pending.delete(i); },
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        const next = [...pending.entries()].filter(([, p]) => p.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        pending.delete(next[0]);
        t = next[1].at;
        next[1].fn();
        await new Promise((r) => setImmediate(r));
      }
      t = end;
      await new Promise((r) => setImmediate(r));
    },
  };
}

test('saves 2 s after the last edit', async () => {
  const timers = fakeTimers();
  const saved = [];
  const states = [];
  const a = createAutosave({ save: async (v) => { saved.push(v); }, timers, onChange: (s) => states.push(s.state) });
  a.edit('a');
  await timers.advance(1500);
  a.edit('ab');
  await timers.advance(1999);
  assert.deepEqual(saved, []);
  assert.equal(a.status().state, 'unsaved');
  await timers.advance(1);
  assert.deepEqual(saved, ['ab']);
  assert.deepEqual(states, ['unsaved', 'saving', 'saved']);
});

test('flush saves immediately; nothing to save is a no-op', async () => {
  const timers = fakeTimers();
  const saved = [];
  const a = createAutosave({ save: async (v) => { saved.push(v); }, timers });
  await a.flush();
  assert.deepEqual(saved, []);
  a.edit('x');
  await a.flush();
  assert.deepEqual(saved, ['x']);
  assert.equal(a.status().state, 'saved');
  await timers.advance(5000);
  assert.deepEqual(saved, ['x'], 'the cancelled timer does not save again');
});

test('an edit during a save schedules another save', async () => {
  const timers = fakeTimers();
  const saved = [];
  let release;
  const a = createAutosave({ save: (v) => { saved.push(v); return new Promise((r) => { release = r; }); }, timers });
  a.edit('1');
  await timers.advance(2000);
  assert.equal(a.status().state, 'saving');
  a.edit('2');
  release();
  await timers.advance(0);
  assert.equal(a.status().state, 'unsaved');
  await timers.advance(2000);
  assert.deepEqual(saved, ['1', '2']);
  release();
  await timers.advance(0);
  assert.equal(a.status().state, 'saved');
});

test('offline holds the value and saves when back online', async () => {
  const timers = fakeTimers();
  let online = false;
  const saved = [];
  const a = createAutosave({ save: async (v) => { saved.push(v); }, timers, isOnline: () => online });
  a.edit('v');
  assert.equal(a.status().state, 'offline');
  await timers.advance(3000);
  assert.deepEqual(saved, []);
  online = true;
  a.connectivity();
  await timers.advance(0);
  assert.deepEqual(saved, ['v']);
  assert.equal(a.status().state, 'saved');
});

test('a failed save keeps the value, reports the error and retries with backoff', async () => {
  const timers = fakeTimers();
  let fail = 2;
  const saved = [];
  const a = createAutosave({ save: async (v) => { if (fail-- > 0) throw new Error('503'); saved.push(v); }, timers });
  a.edit('v');
  await timers.advance(2000);
  assert.deepEqual(a.status(), { state: 'unsaved', error: '503' });
  await timers.advance(2000);
  assert.equal(a.status().state, 'unsaved', 'second failure');
  await timers.advance(3999);
  assert.deepEqual(saved, []);
  await timers.advance(1);
  assert.deepEqual(saved, ['v']);
  assert.deepEqual(a.status(), { state: 'saved', error: null });
});

test('a failure while offline reports Offline', async () => {
  const timers = fakeTimers();
  let online = true;
  const a = createAutosave({ save: async () => { online = false; throw new Error('Failed to fetch'); }, timers, isOnline: () => online });
  a.edit('v');
  await timers.advance(2000);
  assert.equal(a.status().state, 'offline');
  assert.equal(a.hasPending(), true);
});

test('dispose stops pending saves', async () => {
  const timers = fakeTimers();
  const saved = [];
  const a = createAutosave({ save: async (v) => { saved.push(v); }, timers });
  a.edit('v');
  a.dispose();
  await timers.advance(5000);
  assert.deepEqual(saved, []);
});
