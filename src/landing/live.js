// Live strip on the landing page (doc/ui.md, Landing): a REST snapshot, no Realtime.
import { evaluateFreshness } from '../sky/freshness.js';
import { parseSkyRow, parseStatusRow } from '../sky/validate.js';
import { safeTrace, trace as busTrace } from '../trace/bus.js';

/**
 * @typedef {{ objects: import('../sky/validate.js').SkyRow[], statuses: import('../sky/validate.js').StatusRow[] }} Snapshot
 */

export const POLL_MS = 60_000;
export const STRIP_GROUPS = ['swpc.kp', 'swpc.wind', 'celestrak.stations', 'll2.upcoming'];

const fmt = (n, digits) => (typeof n === 'number' && Number.isFinite(n) ? n.toFixed(digits) : '—');

/**
 * Read the rows the strip needs. `client` is a supabase-js client with the publishable key.
 * Rows failing validation are dropped and traced (doc/sky-contract.md, Live mode).
 * @param {any} client
 * @param {{ trace?: (record: any) => unknown }} [options]
 * @returns {Promise<Snapshot>}
 */
export async function fetchSnapshot(client, { trace = busTrace } = {}) {
  const note = safeTrace(trace, 'landing');
  const [sky, status] = await Promise.all([
    client.from('sky_objects').select('id, source, group_key, fields, trace_id, updated_at, removed_at')
      .in('group_key', STRIP_GROUPS).is('removed_at', null),
    client.from('source_status').select('*').in('source_id', STRIP_GROUPS),
  ]);
  if (sky.error) throw new Error(sky.error.message);
  if (status.error) throw new Error(status.error.message);
  /** @template T @param {string} table @param {unknown[]} rows @param {(row: unknown) => import('../sky/validate.js').Result<T>} parse */
  const valid = (table, rows, parse) => {
    /** @type {T[]} */
    const out = [];
    for (const row of rows) {
      const r = parse(row);
      if (r.ok) out.push(r.value);
      else note({ traceId: 'landing', stage: 'REALTIME', component: 'landing', event: 'invalid_row', level: 'warn', data: { table, error: r.error } });
    }
    return out;
  };
  return { objects: valid('sky_objects', sky.data, parseSkyRow), statuses: valid('source_status', status.data, parseStatusRow) };
}

/**
 * Strip items in display order.
 * @param {{ objects: Pick<import('../sky/validate.js').SkyRow, 'id' | 'group' | 'fields'>[], statuses: import('../sky/validate.js').StatusRow[] }} snapshot
 * @param {number} nowMs
 * @returns {{ source: string, label: string, value: string, freshness: import('../sky/freshness.js').Freshness }[]}
 */
export function summarize({ objects, statuses }, nowMs) {
  const status = new Map(statuses.map((s) => [s.source, s]));
  const inGroup = (g) => objects.filter((o) => o.group === g);
  const fresh = (source) => evaluateFreshness(source, status.get(source), nowMs);
  const kp = inGroup('swpc.kp')[0]?.fields;
  const wind = inGroup('swpc.wind')[0]?.fields;
  const stations = inGroup('celestrak.stations');
  const next = inGroup('ll2.upcoming')
    .map((o) => o.fields)
    .filter((f) => typeof f.net === 'string' && Date.parse(f.net) > nowMs)
    .sort((a, b) => Date.parse(a.net) - Date.parse(b.net))[0];
  return [
    { source: 'swpc.kp', label: 'Kp', value: fmt(kp?.kpEstimated ?? kp?.kp, 2), freshness: fresh('swpc.kp') },
    { source: 'swpc.wind', label: 'Solar wind', value: wind ? `${fmt(wind.speed, 0)} km/s` : '—', freshness: fresh('swpc.wind') },
    { source: 'celestrak.stations', label: 'Stations in orbit', value: stations.length ? String(stations.length) : '—', freshness: fresh('celestrak.stations') },
    { source: 'll2.upcoming', label: 'Next launch', value: next ? `${next.name} · ${next.net.slice(0, 16).replace('T', ' ')} UTC` : '—', freshness: fresh('ll2.upcoming') },
  ];
}

/** Glyph and label per freshness state (doc/ui.md, States). */
export const STATE_GLYPH = { loading: '…', fresh: '●', stale: '◐', down: '○' };
export const STATE_LABEL = { loading: 'connecting', fresh: 'fresh', stale: 'stale', down: 'down' };
