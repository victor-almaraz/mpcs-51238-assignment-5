const SAMPLE_MAX = 65536;

/**
 * Database access for the worker. `client` is a supabase-js client created with the secret key.
 * Every method throws on a database error.
 */
export function createStore(client) {
  const check = (what, { data, error }) => {
    if (error) throw new Error(`${what}: ${error.message}`);
    return data;
  };
  return {
    async loadStatus() {
      const rows = check('select source_status', await client.from('source_status').select('*'));
      return new Map(rows.map((r) => [r.source_id, r]));
    },
    /** @returns {Promise<'claimed' | 'busy' | 'halted'>} */
    async claim(sourceId, intervalSec, prevAttemptAt, haltPolicy) {
      return check('claim_source', await client.rpc('claim_source', {
        p_source_id: sourceId, p_interval_sec: intervalSec, p_prev: prevAttemptAt ?? null, p_halt_policy: haltPolicy,
      }));
    },
    async claimHost(host, holder, ttlSec) {
      return check('claim_host', await client.rpc('claim_host', { p_host: host, p_holder: holder, p_ttl_sec: ttlSec })) === true;
    },
    async releaseHost(host, holder) {
      check('release_host', await client.rpc('release_host', { p_host: host, p_holder: holder }));
    },
    async upsertObjects(source, group, rows, full) {
      const data = check('upsert_sky_objects', await client.rpc('upsert_sky_objects', {
        p_source: source, p_group: group, p_rows: rows, p_full: full,
      }));
      return data.map((r) => ({ objectId: r.out_object_id, kind: r.out_kind, traceId: r.out_trace_id }));
    },
    async saveSample(sourceId, fetchedAt, httpStatus, body) {
      check('upsert source_samples', await client.from('source_samples').upsert({
        source_id: sourceId, fetched_at: fetchedAt, http_status: httpStatus, body: body.slice(0, SAMPLE_MAX),
      }));
    },
    async insertRun(run) {
      check('insert runs', await client.from('runs').insert(run));
    },
    async saveStatus(row) {
      check('upsert source_status', await client.from('source_status').upsert(row));
    },
    async clearHalt(sourceId) {
      const rows = check('clear halt', await client.from('source_status')
        .update({ halted: false, failures: 0, next_attempt_at: null, in_flight_at: null })
        .eq('source_id', sourceId).select('source_id'));
      return rows.length === 1;
    },
  };
}
