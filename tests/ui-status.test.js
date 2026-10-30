import assert from 'node:assert/strict';
import { test } from 'node:test';
import { audioLabel, formatHHMM, freshnessItem, levelLabel, relativeTime, saveLabel, statusSources, voicesLabel } from '../src/ui/status.js';

test('freshness items carry a glyph, a label and a since time', () => {
  const fresh = freshnessItem({ source: 'swpc.kp', state: 'fresh', lastRun: null, lastSuccess: '2026-10-29T14:02:00Z' });
  assert.equal(fresh.glyph, '●');
  assert.equal(fresh.label, 'fresh');
  const stale = freshnessItem({ source: 'll2.upcoming', state: 'stale', lastRun: null, lastSuccess: '2026-10-29T09:15:00Z' });
  assert.equal(stale.glyph, '◐');
  assert.equal(stale.title, 'll2.upcoming: stale since 09:15 UTC');
  const down = freshnessItem({ source: 'celestrak.stations', state: 'down', lastRun: '2026-10-29T10:00:00Z', lastSuccess: null }, 'America/Chicago');
  assert.equal(down.glyph, '○');
  assert.equal(down.title, 'celestrak.stations: down since 05:00');
  const loading = freshnessItem({ source: 'jpl.cad', state: 'loading', lastRun: null, lastSuccess: null });
  assert.deepEqual([loading.glyph, loading.label], ['…', 'connecting']);
});

test('an unknown state reads as loading', () => {
  assert.equal(freshnessItem({ source: 'x', state: /** @type {any} */ ('weird'), lastRun: null, lastSuccess: null }).glyph, '…');
});

test('formatHHMM falls back to UTC for an invalid zone and is empty for bad input', () => {
  assert.equal(formatHHMM('2026-10-29T14:02:11Z', 'Not/AZone'), '14:02');
  assert.equal(formatHHMM(null), '');
  assert.equal(formatHHMM('garbage'), '');
});

test('status sources are those of the followed groups, or all', () => {
  const all = [{ source: 'a', state: 'fresh' }, { source: 'b', state: 'down' }];
  assert.deepEqual(statusSources(all, []), all);
  const s = statusSources(all, ['b', 'c', 'b']);
  assert.deepEqual(s.map((x) => [x.source, x.state]), [['b', 'down'], ['c', 'loading']]);
});

test('audio, voices, level and save labels', () => {
  assert.equal(audioLabel('playing'), '▶ playing');
  assert.equal(audioLabel('stopped'), '■ stopped');
  assert.equal(audioLabel('muted'), 'Muted');
  assert.equal(voicesLabel(12), '12/64');
  assert.equal(voicesLabel(NaN), '0/64');
  assert.equal(levelLabel(-18.2), '−18 dBFS');
  assert.equal(levelLabel(-Infinity), '−∞ dBFS');
  assert.equal(levelLabel(null), '−∞ dBFS');
  assert.equal(saveLabel('saving'), 'Saving…');
  assert.equal(saveLabel('unsaved'), 'Unsaved changes');
  assert.equal(saveLabel('offline'), 'Offline');
  assert.equal(saveLabel('saved'), 'Saved');
});

test('relative times', () => {
  const now = Date.parse('2026-10-29T14:00:00Z');
  assert.equal(relativeTime(null, now), '—');
  assert.equal(relativeTime('2026-10-29T13:59:50Z', now), 'just now');
  assert.equal(relativeTime('2026-10-29T13:50:00Z', now), '10 min ago');
  assert.equal(relativeTime(now - 3 * 3600e3, now), '3 h ago');
  assert.equal(relativeTime('2026-10-27T14:00:00Z', now), '2 d ago');
  assert.equal(relativeTime('2026-01-01T00:00:00Z', now), '2026-01-01');
});
