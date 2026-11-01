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

/** Client for createProject: the `projects` insert returns id p1; `project_subscriptions` uses fakeClient. */
function projectClient({ failSubs = false } = {}) {
  const calls = [];
  const subs = fakeClient([], { failOn: failSubs ? 'insert' : null });
  const from = (table) => {
    if (table !== 'projects') return subs.from(table);
    const filters = [];
    const b = {
      insert(v) { calls.push(['insert', v]); return b; },
      select() { return b; },
      single: () => Promise.resolve({ data: { id: 'p1' }, error: null }),
      delete() { calls.push(['delete', filters]); return b; },
      eq(k, v) { filters.push([k, v]); return b; },
      then(res, rej) { return Promise.resolve({ error: null }).then(res, rej); },
    };
    return b;
  };
  return { from, calls, subs: subs.calls };
}

test('createProject inserts the row and its subscriptions', async () => {
  const { createProject } = await import('../src/ui/project-actions.ts');
  const c = projectClient();
  const id = await createProject(c, { name: 'A', source: 's', ir: { groups: ['swpc.kp'] } });
  assert.equal(id, 'p1');
  assert.deepEqual(c.calls.map((x) => x[0]), ['insert']);
  assert.deepEqual(c.subs.map((x) => x[0]), ['select', 'insert']);
});

test('createProject deletes the new row when its subscriptions cannot be written', async () => {
  const { createProject } = await import('../src/ui/project-actions.ts');
  const c = projectClient({ failSubs: true });
  await assert.rejects(createProject(c, { name: 'A', source: 's', ir: { groups: ['swpc.kp'] } }), /could not be created: adding subscriptions failed: denied/);
  assert.deepEqual(c.calls, [['insert', { name: 'A', source: 's', ir: { groups: ['swpc.kp'] }, local_only: false }], ['delete', [['id', 'p1']]]]);
});
