// Freshness rules (doc/sky-contract.md, Freshness).

export const STATUS_POLL_MS = 30000;
export const EVALUATE_MS = 5000;
export const STALE_INTERVALS = 3;

/**
 * @typedef {'loading' | 'fresh' | 'stale' | 'down'} FreshState
 * @typedef {{ source: string, state: FreshState, lastRun: string | null, lastSuccess: string | null }} Freshness
 */

/**
 * @param {string} source
 * @param {import('./validate.js').StatusRow | undefined} row
 * @param {number} nowMs
 * @param {{ channelDown?: boolean }} [opts]
 * @returns {Freshness}
 */
export function evaluateFreshness(source, row, nowMs, { channelDown = false } = {}) {
  if (!row) return loadingFreshness(source);
  const base = { source, lastRun: row.lastAttemptAt, lastSuccess: row.lastSuccessAt };
  if (row.halted || row.lastOk === false || channelDown) return { ...base, state: 'down' };
  if (row.lastSuccessAt === null) return { ...base, state: 'stale' };
  const age = nowMs - Date.parse(row.lastSuccessAt);
  if (age > STALE_INTERVALS * row.intervalSec * 1000) return { ...base, state: 'stale' };
  return { ...base, state: 'fresh' };
}

/** @param {string} source @returns {Freshness} */
export function loadingFreshness(source) {
  return { source, state: 'loading', lastRun: null, lastSuccess: null };
}
