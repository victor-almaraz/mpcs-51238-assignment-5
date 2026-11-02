/** Seconds of cron jitter tolerated so that 60 s sources run on every one-minute tick. */
const TICK_SLACK_SEC = 15;

const ms = (t) => (t ? Date.parse(t) : null);

/**
 * Whether a registry entry should be attempted now.
 * @param {object} entry validated registry entry
 * @param {object | undefined} st source_status row
 * @param {number} now epoch ms
 */
export function isDue(entry, st, now, isEnabled = () => true) {
  if (!entry.enabled || !isEnabled(entry.id)) return false;
  if (!st) return true;
  if (st.halted) return false;
  const next = ms(st.next_attempt_at);
  if (next !== null && now < next) return false;
  const last = ms(st.last_attempt_at);
  if (last !== null && now - last < (entry.intervalSec - TICK_SLACK_SEC) * 1000) return false;
  const success = ms(st.last_success_at);
  if (entry.onNon200 === 'halt' && success !== null && now - success < entry.intervalSec * 1000) return false;
  return true;
}

/** Group entries by host, keeping registry order inside each group. */
export function byHost(entries) {
  const groups = new Map();
  for (const e of entries) {
    if (!groups.has(e.host)) groups.set(e.host, []);
    groups.get(e.host).push(e);
  }
  return [...groups.values()];
}

/** source_status fields after a successful run. */
export function onSuccess(entry, now) {
  return {
    source_id: entry.id, interval_sec: entry.intervalSec,
    last_success_at: new Date(now).toISOString(), last_ok: true,
    failures: 0, next_attempt_at: null, in_flight_at: null,
  };
}

/**
 * source_status fields after a failed run, by the entry's failure policy.
 * @param {{ retryAfterSec?: number | null }} failure
 */
export function onFailure(entry, st, now, { retryAfterSec = null } = {}) {
  const failures = (st?.failures ?? 0) + 1;
  const row = { source_id: entry.id, interval_sec: entry.intervalSec, last_ok: false, failures, next_attempt_at: null, in_flight_at: null };
  let waitSec = 0;
  if (entry.onNon200 === 'halt') {
    row.halted = true;
  } else if (entry.onNon200 === 'retryAfter') {
    waitSec = retryAfterSec ?? 3600;
    if (entry.maxBackoffSec > 0) waitSec = Math.min(waitSec, entry.maxBackoffSec);
  } else {
    waitSec = Math.min(entry.intervalSec * 2 ** failures, entry.maxBackoffSec);
  }
  if (waitSec > 0) row.next_attempt_at = new Date(now + waitSec * 1000).toISOString();
  return row;
}
