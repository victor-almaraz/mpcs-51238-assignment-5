import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  actedTraceIds, announcement, changeRowToRecord, createAnnouncer, diffSummary, fieldDiff, filterEvents, mergeEvents, recordBadge, sourceRows,
} from '../src/ui/console-filters.js';

const change = (traceId, group, kind, before, after, t = '2026-10-29T14:00:00.000Z', extra = {}) => ({
  t, traceId, stage: 'CHANGE', component: 'sky', event: kind, level: 'info',
  data: { objectId: `${group}:x`, group, source: group, kind, diff: { before, after } }, ...extra,
});
const bind = (traceId, result) => ({ t: '2026-10-29T14:00:00.000Z', traceId, stage: 'BIND', component: 'bind.b0', event: result, level: 'info', data: { binding: 'b0', result } });

const records = [
  change('t1', 'swpc.wind', 'update', { speed: 400 }, { speed: 420 }),
  bind('t1', 'fired'),
  change('t2', 'jpl.cad', 'enter', null, { dist: 0.01 }),
  change('t3', 'swpc.kp', 'update', { kp: 3 }, { kp: 4 }),
  bind('t3', 'dropped'),
  { t: '2026-10-29T14:00:00.000Z', traceId: 't3', stage: 'REALTIME', component: 'sky', event: 'x', level: 'info', data: {} },
];

test('filterEvents keeps change records and applies each filter', () => {
  assert.deepEqual(filterEvents(records).map((r) => r.traceId), ['t1', 't2', 't3']);
  assert.deepEqual(filterEvents(records, { source: 'jpl.cad' }).map((r) => r.traceId), ['t2']);
  assert.deepEqual(filterEvents(records, { group: 'swpc.kp' }).map((r) => r.traceId), ['t3']);
  assert.deepEqual(filterEvents(records, { followedOnly: true, followed: ['swpc.wind', 'jpl.cad'] }).map((r) => r.traceId), ['t1', 't2']);
  assert.deepEqual(filterEvents(records, { firedOnly: true }).map((r) => r.traceId), ['t1'], 'dropped does not count as fired');
});

test('actedTraceIds counts fired triggers and voice changes', () => {
  assert.deepEqual([...actedTraceIds([bind('a', 'fired'), bind('b', 'voiceOn'), bind('c', 'voiceOff'), bind('d', 'dropped')])].sort(), ['a', 'b', 'c']);
});

test('fieldDiff lists changed fields only', () => {
  assert.deepEqual(fieldDiff({ before: { a: 1, b: 2 }, after: { a: 1, b: 3, c: 'x' } }), [
    { field: 'b', before: 2, after: 3 }, { field: 'c', before: undefined, after: 'x' },
  ]);
  assert.deepEqual(fieldDiff({ before: null, after: { a: 1 } }), [{ field: 'a', before: undefined, after: 1 }]);
  assert.deepEqual(fieldDiff(undefined), []);
});

test('diffSummary formats before → after', () => {
  assert.equal(diffSummary({ before: { speed: 400.123456789 }, after: { speed: 420 } }), 'speed 400.123 → 420');
  assert.equal(diffSummary({ before: {}, after: { a: 1, b: 2, c: 3 } }, 2), 'a ∅ → 1, b ∅ → 2, +1 more');
});

test('recordBadge labels replayed and synthetic records', () => {
  assert.equal(recordBadge({ ...records[0], replay: 100 }), 'REPLAY ×100');
  assert.equal(recordBadge({ ...records[0], synthetic: true }), 'SYNTHETIC');
  assert.equal(recordBadge(records[0]), null);
});

test('sourceRows joins freshness with the newest run and the newest failure', () => {
  const rows = sourceRows(
    [{ source: 'swpc.kp', state: 'fresh', lastRun: '2026-10-29T14:00:00Z', lastSuccess: '2026-10-29T14:00:00Z' }],
    [
      { source_id: 'swpc.kp', started_at: '2026-10-29T13:59:00Z', finished_at: '2026-10-29T13:59:00.400Z', ok: false, rows_changed: 0, http_status: 503, error: 'HTTP 503' },
      { source_id: 'swpc.kp', started_at: '2026-10-29T14:00:00Z', finished_at: '2026-10-29T14:00:00.412Z', ok: true, rows_changed: 1, http_status: 200, error: null },
      { source_id: 'celestrak.stations', started_at: '2026-10-29T12:00:00Z', finished_at: '2026-10-29T12:00:01Z', ok: false, rows_changed: 0, http_status: 403, error: null },
    ],
  );
  assert.deepEqual(rows.map((r) => r.source), ['celestrak.stations', 'swpc.kp']);
  const kp = rows[1];
  assert.deepEqual([kp.state, kp.rowsChanged, kp.ms, kp.ok, kp.lastError], ['fresh', 1, 412, true, 'HTTP 503']);
  assert.deepEqual([rows[0].state, rows[0].lastError], ['loading', 'HTTP 403']);
});

test('changeRowToRecord validates and shapes REST rows', () => {
  const r = changeRowToRecord({ id: 1, trace_id: 'abc', source: 'jpl.cad', group_key: 'jpl.cad', object_id: 'jpl.cad:x', kind: 'enter', diff: { before: null, after: { a: 1 } }, at: '2026-10-29T14:00:00+00:00' });
  assert.equal(r?.stage, 'CHANGE');
  assert.equal(r?.t, '2026-10-29T14:00:00.000Z');
  assert.equal(r?.data.kind, 'enter');
  assert.equal(changeRowToRecord({ kind: 'delete' }), null);
  assert.equal(changeRowToRecord(null), null);
});

test('mergeEvents drops history duplicates of live records and sorts by time', () => {
  const h = [change('t1', 'swpc.wind', 'update', {}, {}, '2026-10-29T13:00:00.000Z'), change('t0', 'swpc.wind', 'update', {}, {}, '2026-10-29T12:00:00.000Z')];
  const live = [change('t1', 'swpc.wind', 'update', {}, {}, '2026-10-29T13:00:00.100Z'), change('t5', 'swpc.wind', 'update', {}, {}, '2026-10-29T14:00:00.000Z')];
  assert.deepEqual(mergeEvents(h, live).map((r) => r.traceId), ['t0', 't1', 't5']);
});

test('the announcer summarizes at most once per flush and stays silent when paused', () => {
  const a = createAnnouncer();
  assert.equal(a.flush(), null);
  a.add(); a.add(2);
  assert.equal(a.flush(), '3 events in the last 10 seconds');
  assert.equal(a.flush(), null);
  a.add();
  a.pause();
  a.add();
  assert.equal(a.flush(), null);
  a.pause(false);
  a.add();
  assert.equal(a.flush(), announcement(1));
  assert.equal(announcement(1), '1 event in the last 10 seconds');
});

import { clockTime, midiHz, noteName } from '../src/ui/console-filters.js';

test('note names, frequencies and clock times', () => {
  assert.equal(noteName(69), 'A4');
  assert.equal(noteName(60), 'C4');
  assert.equal(noteName(61.25), 'C#4 +25¢');
  assert.equal(noteName(59.8), 'C4 −20¢');
  assert.equal(noteName(NaN), '—');
  assert.equal(Math.round(midiHz(69)), 440);
  assert.equal(Math.round(midiHz(81)), 880);
  assert.equal(clockTime('2026-10-29T14:02:11.405Z'), '14:02:11');
  assert.equal(clockTime('nope'), '--:--:--');
});
