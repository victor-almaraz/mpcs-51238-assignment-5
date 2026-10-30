import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diffSubscriptions, syncSubscriptions } from '../src/ui/subscriptions.js';

test('diffSubscriptions adds missing and removes extra groups', () => {
  assert.deepEqual(diffSubscriptions(['swpc.kp', 'jpl.cad'], ['celestrak.stations', 'swpc.kp']), { add: ['celestrak.stations'], remove: ['jpl.cad'] });
  assert.deepEqual(diffSubscriptions([], []), { add: [], remove: [] });
  assert.deepEqual(diffSubscriptions(['a', 'a'], ['a']), { add: [], remove: [] });
});

function fakeClient(rows, { failOn = null } = {}) {
  const calls = [];
  const q = (table) => {
    const state = { table, op: 'select', filters: [] };
    const b = {
      select() { state.op = 'select'; return b; },
      delete() { state.op = 'delete'; return b; },
      insert(v) { calls.push(['insert', table, v]); return Promise.resolve(failOn === 'insert' ? { error: { message: 'denied' } } : { error: null }); },
      eq(k, v) { state.filters.push(['eq', k, v]); return b; },
      in(k, v) { state.filters.push(['in', k, v]); return b; },
      then(res, rej) {
        calls.push([state.op, table, state.filters]);
        const r = state.op === 'select' ? { data: rows, error: null } : { error: failOn === 'delete' ? { message: 'denied' } : null };
        return Promise.resolve(r).then(res, rej);
      },
    };
    return b;
  };
  return { from: q, calls };
}

test('syncSubscriptions writes only the difference', async () => {
  const c = fakeClient([{ group_key: 'jpl.cad' }, { group_key: 'swpc.kp' }]);
  const d = await syncSubscriptions(c, 'p1', ['swpc.kp', 'celestrak.stations']);
  assert.deepEqual(d, { add: ['celestrak.stations'], remove: ['jpl.cad'] });
  assert.deepEqual(c.calls.map((x) => x[0]), ['select', 'delete', 'insert']);
  assert.deepEqual(c.calls[2][2], [{ project_id: 'p1', group_key: 'celestrak.stations' }]);
});

test('syncSubscriptions with nothing to change only reads', async () => {
  const c = fakeClient([{ group_key: 'swpc.kp' }]);
  await syncSubscriptions(c, 'p1', ['swpc.kp']);
  assert.deepEqual(c.calls.map((x) => x[0]), ['select']);
});

test('syncSubscriptions reports a failed write', async () => {
  const c = fakeClient([], { failOn: 'insert' });
  await assert.rejects(syncSubscriptions(c, 'p1', ['swpc.kp']), /adding subscriptions failed: denied/);
});
