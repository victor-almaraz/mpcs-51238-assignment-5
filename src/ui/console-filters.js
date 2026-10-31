// Console panel logic (doc/console.md, Panels): event filters, field diffs, the Sources table,
// record badges and throttled announcements. Pure functions over trace records.
import { formatClock } from './status.js';

export const ANNOUNCE_MS = 10000;
const ACTED = new Set(['fired', 'voiceOn', 'voiceOff']);

/**
 * @typedef {{ t: string, traceId: string, stage: string, component: string, event: string,
 *   level: string, data: Record<string, any>, replay?: number, synthetic?: true }} TraceRecord
 */

/** @param {TraceRecord} r */
export const isChange = (r) => r.stage === 'CHANGE' && ['enter', 'update', 'exit'].includes(r.data?.kind ?? r.event);

/**
 * Trace ids whose change made a binding act (a trigger fired or a voice started or stopped).
 * @param {readonly TraceRecord[]} records
 */
export function actedTraceIds(records) {
  const out = new Set();
  for (const r of records) if (r.stage === 'BIND' && ACTED.has(r.data?.result)) out.add(r.traceId);
  return out;
}

/**
 * @typedef {{ source?: string, group?: string, followedOnly?: boolean, followed?: readonly string[], firedOnly?: boolean }} EventFilter
 */

/**
 * The Events panel list: change records matching the filter, oldest first.
 * @param {readonly TraceRecord[]} records
 * @param {EventFilter} f
 */
export function filterEvents(records, f = {}) {
  const followed = new Set(f.followed ?? []);
  const acted = f.firedOnly ? actedTraceIds(records) : null;
  return records.filter((r) => {
    if (!isChange(r)) return false;
    const d = r.data ?? {};
    if (f.source && d.source !== f.source) return false;
    if (f.group && d.group !== f.group) return false;
    if (f.followedOnly && !followed.has(d.group)) return false;
    if (acted && !acted.has(r.traceId)) return false;
    return true;
  });
}

/**
 * Changed fields of a diff, sorted by name.
 * @param {{ before: Record<string, any> | null, after: Record<string, any> | null } | undefined} diff
 * @returns {{ field: string, before: unknown, after: unknown }[]}
 */
export function fieldDiff(diff) {
  const before = diff?.before ?? {};
  const after = diff?.after ?? {};
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const out = [];
  for (const k of keys) {
    const a = Object.hasOwn(before, k) ? before[k] : undefined;
    const b = Object.hasOwn(after, k) ? after[k] : undefined;
    if (!Object.is(a, b)) out.push({ field: k, before: a, after: b });
  }
  return out;
}

/** @param {unknown} v */
export function formatValue(v) {
  if (v === undefined) return '∅';
  if (v === null) return 'null';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(6)));
  if (typeof v === 'string') return JSON.stringify(v);
  return JSON.stringify(v);
}

/**
 * One-line diff summary: `speed 412 → 418, density 3.1 → 2.9`, at most `max` fields.
 * @param {any} diff @param {number} [max]
 */
export function diffSummary(diff, max = 4) {
  const d = fieldDiff(diff);
  const shown = d.slice(0, max).map((x) => `${x.field} ${formatValue(x.before)} → ${formatValue(x.after)}`);
  if (d.length > max) shown.push(`+${d.length - max} more`);
  return shown.join(', ');
}

/** `Replay ×<speed>`, `Synthetic` or null. @param {TraceRecord} r */
export function recordBadge(r) {
  if (r.replay) return `Replay ×${r.replay}`;
  if (r.synthetic) return 'Synthetic';
  return null;
}

/**
 * @typedef {{ source_id: string, started_at: string, finished_at: string, ok: boolean,
 *   rows_changed: number, http_status: number | null, error: string | null }} RunRow
 * @typedef {{ source: string, state: string, lastRun: string | null, lastSuccess: string | null }} Freshness
 */

/**
 * Sources panel rows: one per registry id known from freshness or runs, id order.
 * @param {readonly Freshness[]} freshness
 * @param {readonly RunRow[]} runs any order
 */
export function sourceRows(freshness, runs) {
  /** @type {Map<string, RunRow[]>} */
  const bySource = new Map();
  for (const r of runs) {
    if (!r || typeof r.source_id !== 'string') continue;
    if (!bySource.has(r.source_id)) bySource.set(r.source_id, []);
    bySource.get(r.source_id)?.push(r);
  }
  for (const list of bySource.values()) list.sort((a, b) => (a.started_at < b.started_at ? 1 : a.started_at > b.started_at ? -1 : 0));
  const fresh = new Map(freshness.map((f) => [f.source, f]));
  const ids = [...new Set([...fresh.keys(), ...bySource.keys()])].sort();
  return ids.map((source) => {
    const list = bySource.get(source) ?? [];
    const last = list[0] ?? null;
    const failed = list.find((r) => !r.ok) ?? null;
    const f = fresh.get(source);
    const ms = last ? Date.parse(last.finished_at) - Date.parse(last.started_at) : NaN;
    return {
      source,
      state: f?.state ?? 'loading',
      lastRun: last?.started_at ?? f?.lastRun ?? null,
      lastSuccess: f?.lastSuccess ?? null,
      ok: last ? last.ok : null,
      rowsChanged: last ? last.rows_changed : null,
      ms: Number.isFinite(ms) ? ms : null,
      httpStatus: last?.http_status ?? null,
      lastError: failed ? (failed.error ?? `HTTP ${failed.http_status ?? '?'}`) : null,
      lastErrorAt: failed?.started_at ?? null,
    };
  });
}

/**
 * A `changes` row read by REST, shaped like a CHANGE record for display. Invalid rows give null.
 * @param {any} row
 * @returns {TraceRecord | null}
 */
export function changeRowToRecord(row) {
  if (!row || typeof row.object_id !== 'string' || typeof row.group_key !== 'string' || typeof row.at !== 'string') return null;
  if (!['enter', 'update', 'exit'].includes(row.kind)) return null;
  const diff = row.diff && typeof row.diff === 'object' ? row.diff : { before: null, after: null };
  return {
    t: new Date(row.at).toISOString(),
    traceId: String(row.trace_id ?? ''),
    stage: 'CHANGE',
    component: 'sky',
    event: row.kind,
    level: 'info',
    data: { objectId: row.object_id, group: row.group_key, source: row.source, kind: row.kind, diff, history: true },
  };
}

/**
 * Merges history and live records by time without duplicates (same trace id and object).
 * @param {readonly TraceRecord[]} history @param {readonly TraceRecord[]} live
 */
export function mergeEvents(history, live) {
  const seen = new Set(live.map((r) => `${r.traceId}|${r.data?.objectId}`));
  const out = [...history.filter((r) => !seen.has(`${r.traceId}|${r.data?.objectId}`)), ...live];
  return out.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
}

/** @param {number} n */
export function announcement(n) {
  return `${n} ${n === 1 ? 'event' : 'events'} in the last ${ANNOUNCE_MS / 1000} seconds`;
}

/**
 * Throttled screen-reader summary: `add()` per event; `flush()` every 10 s returns the message
 * or null when nothing happened or the console is paused.
 */
export function createAnnouncer() {
  let n = 0;
  let paused = false;
  return {
    add(k = 1) { if (!paused) n += k; },
    pause(p = true) { paused = p; if (p) n = 0; },
    flush() {
      const k = n;
      n = 0;
      return paused || k === 0 ? null : announcement(k);
    },
  };
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/**
 * Note name of a MIDI pitch with cents when fractional: 69 → `A4`, 60.25 → `C4 +25¢`.
 * @param {number} midi
 */
export function noteName(midi) {
  if (!Number.isFinite(midi)) return '—';
  const n = Math.round(midi);
  const cents = Math.round((midi - n) * 100);
  const name = `${NOTE_NAMES[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1}`;
  return cents ? `${name} ${cents > 0 ? '+' : '−'}${Math.abs(cents)}¢` : name;
}

/** @param {number} midi */
export function midiHz(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** HH:MM:SS of a record time in a zone. @param {string} iso @param {string} [timeZone] */
export function clockTime(iso, timeZone = 'UTC') {
  return formatClock(iso, timeZone, { seconds: true }) ?? '--:--:--';
}
