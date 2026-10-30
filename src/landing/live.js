// Live strip on the landing page (doc/ui.md, Landing): a REST snapshot, no Realtime.
import { evaluateFreshness } from '../sky/freshness.js';
import { parseSkyRow, parseStatusRow } from '../sky/validate.js';

/**
 * @typedef {{ objects: import('../sky/validate.js').SkyRow[], statuses: import('../sky/validate.js').StatusRow[] }} Snapshot
 */

export const POLL_MS = 60_000;
export const STRIP_GROUPS = ['swpc.kp', 'swpc.wind', 'celestrak.stations', 'll2.upcoming'];

const fmt = (n, digits) => (typeof n === 'number' && Number.isFinite(n) ? n.toFixed(digits) : '—');

/**
 * Read the rows the strip needs. `client` is a supabase-js client with the publishable key.
 * Rows failing validation are dropped (AGENTS.md: validate input at boundaries).
 * @returns {Promise<Snapshot>}
 */
export async function fetchSnapshot(client) {
  const [sky, status] = await Promise.all([
    client.from('sky_objects').select('id, source, group_key, fields, trace_id, updated_at, removed_at')
      .in('group_key', STRIP_GROUPS).is('removed_at', null),
    client.from('source_status').select('*').in('source_id', STRIP_GROUPS),
  ]);
  if (sky.error) throw new Error(sky.error.message);
  if (status.error) throw new Error(status.error.message);
  const objects = sky.data.map(parseSkyRow).filter((r) => r.ok).map((r) => r.value);
  const statuses = status.data.map(parseStatusRow).filter((r) => r.ok).map((r) => r.value);
  return { objects, statuses };
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
